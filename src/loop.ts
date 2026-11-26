// The interview loop: watches speech + whiteboard, decides WHEN to ask the model
// "should you speak?", and voices the answer like a human would (no talking over people).

import { KokoroSpeaker } from "./kokoro";
import { describeScene, diffScenes, type SceneSnapshot, sceneVersion } from "./scene";
import { Listener, type SpeechInput } from "./speech";
import { turnPauseMs } from "./turn-taking";
import { SPEAKING_MARK, WhisperListener } from "./whisper";

export type Status = "idle" | "listening" | "thinking" | "speaking" | "ended";

export interface TranscriptEntry {
  id: number;
  at: string;
  who: "candidate" | "interviewer" | "board" | "system";
  text: string;
  interrupted?: boolean;
}

export type Pushback = "gentle" | "realistic" | "tough";
export type Mode = "system_design" | "recruiter";

export interface RecruiterSetup {
  source: "outreach" | "applied"; // a recruiter messaged you, or you applied to a posting
  company: string;
  role: string; // the role you told them you want, or the posting link/text
  brief: string; // researched company and role brief (may be empty)
}

export interface LoopOptions {
  mode: Mode; // a recruiter screen is a voice call: no whiteboard
  persona: string;
  background: string; // the candidate's resume or summary, for the recruiter to work from
  recruiter?: RecruiterSetup; // recruiter screens: how the call came about and the company/role
  pushback: Pushback; // how hard the interviewer challenges, and whether it cuts in mid-thought
  durationMin: number;
  voiceName: string;
  headphones: boolean; // allows barge-in: talking over the interviewer cuts it off
  snapshots: boolean; // attach a PNG of the board when it has changed
  stt: "whisper" | "browser"; // local whisper.cpp, or the browser's built-in recognizer
  noiseGate: number; // 0..100, Whisper only: minimum mic level that counts as speech
  getScene: () => { elements: readonly unknown[]; image: () => Promise<string | undefined> };
  drill?: { from: string; index: number }; // a drill on a past call's weak spot (reuses that call's setup)
  fast: boolean; // fast mode: replies start about half a second sooner, at twice the cost
}

export interface LoopEvents {
  onTranscript: (e: TranscriptEntry) => void; // new entry, or an update to an existing id
  onInterim: (text: string) => void;
  onStatus: (s: Status) => void;
  onNote: (note: string) => void;
  onCost: (usd: number) => void;
  onError: (msg: string | null) => void;
  onMicLevel?: (rms: number) => void; // Whisper only
  onCallEnded?: () => void; // the interviewer said goodbye and hung up
}

// Timing knobs (ms)
const CANVAS_SETTLE = 2500; // whiteboard stopped changing -> report the diff
const DRAWING_HEARTBEAT = 25000; // check in occasionally during long drawing stretches
const LONG_SILENCE = 35000; // nothing at all happening
const MIN_TICK_GAP = 2500;
const SNAPSHOT_GAP = 20000;
const BARGE_IN_MS = 800; // talk over the interviewer this long to cut it off
// While the candidate talks without a real break, ask the interviewer this often whether to cut in.
const MID_SPEECH_CHECK: Record<Pushback, number> = { gentle: 0, realistic: 30000, tough: 18000 };
const MONOLOGUE_BREAK = 3000; // a pause this long ends a stretch of continuous talking
const INTERRUPT_GRACE_MS = 1500; // after cutting in, the candidate's trailing words don't cancel it

export class InterviewLoop {
  private sessionId = "";
  private startedAt = 0;
  private listener: SpeechInput;
  private speaker: KokoroSpeaker;
  private events: string[] = [];
  private prevScene: SceneSnapshot | null = null;
  private lastReportedVersion = -1;
  private lastSeenVersion = -1;
  private lastSnapshotVersion = -1;
  private lastSnapshotAt = 0;
  private lastCandidateSpeech = 0;
  private lastCanvasChange = 0;
  private lastInterviewerSpoke = 0;
  private lastTick = 0;
  private interimActive = false;
  private bargeStart = 0; // when the candidate started talking over the interviewer
  private bargeGraceUntil = 0; // the interviewer just cut in: don't let barge-in cancel it yet
  private monologueStart = 0; // start of the candidate's current stretch of continuous talking
  private inFlight = false;
  private queued: string | null = null;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private canvasTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private muted = false;
  private ended = false;
  private backoffUntil = 0;

  constructor(
    private opts: LoopOptions,
    private ev: LoopEvents,
  ) {
    this.speaker = new KokoroSpeaker(opts.voiceName);
    const cb = {
      onInterim: (t: string) => this.handleInterim(t),
      onFinal: (t: string) => this.handleFinal(t),
      onError: (m: string) => ev.onError(m),
    };
    this.listener = opts.stt === "whisper" ? new WhisperListener(cb, { gate: opts.noiseGate, onLevel: ev.onMicLevel }) : new Listener(cb);
  }

  // ---------- lifecycle ----------

  /** The server session id, once started. */
  get id() {
    return this.sessionId;
  }

  async start() {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: this.opts.mode,
        persona: this.opts.persona,
        pushback: this.opts.pushback,
        background: this.opts.background,
        ...this.opts.recruiter,
        drill: this.opts.drill,
        fast: this.opts.fast,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || "Could not start a session. Is the server running?");
    }
    this.sessionId = ((await res.json()) as { sessionId: string }).sessionId;
    this.startedAt = Date.now();
    this.listener.start();
    this.heartbeat = setInterval(() => this.onHeartbeat(), 1000);
    this.events.push(`[${this.clock()}] The candidate has joined the call. Start the interview.`);
    this.setStatus();
    void this.tick("interview_start");
  }

  async end(): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
    this.ended = true;
    this.listener.stop();
    this.speaker.cancel();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.speechTimer) clearTimeout(this.speechTimer);
    if (this.canvasTimer) clearTimeout(this.canvasTimer);
    this.ev.onStatus("ended");
    if (!this.sessionId) return null;
    const { elements, image } = this.opts.getScene();
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, scene: describeScene(elements).text, image: await image() }),
    });
    return res.body?.getReader() ?? null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) this.listener.stop();
    else this.listener.start();
    this.setStatus();
  }

  setNoiseGate(gate: number) {
    if (this.listener instanceof WhisperListener) this.listener.setGate(gate);
  }

  /** Typed message from the candidate (fallback for when voice isn't handy). */
  sendText(text: string) {
    this.handleFinal(text);
    this.scheduleSpeechTick(200);
  }

  // ---------- inputs ----------

  private handleInterim(text: string) {
    if (this.ended) return;
    if (!text) {
      // Recognizer gave up on an utterance (noise, cough): not speaking anymore.
      this.bargeStart = 0;
      this.interimActive = false;
      this.ev.onInterim("");
      return;
    }
    if (this.speaker.speaking) {
      // Without headphones the mic hears the TTS voice; ignore it.
      if (!this.opts.headphones) return;
      // The interviewer just cut in: the candidate's last few words shouldn't cancel the question.
      if (Date.now() < this.bargeGraceUntil) return;
      // Barge-in only on sustained talking, so a cough, a click, or the interviewer's own echo
      // doesn't cut it off after one word.
      const now = Date.now();
      if (!this.bargeStart) this.bargeStart = now;
      const words = text === SPEAKING_MARK ? 0 : text.split(/\s+/).length;
      if (words >= 3 || now - this.bargeStart >= BARGE_IN_MS) {
        this.bargeStart = 0;
        this.speaker.cancel();
      } else {
        return;
      }
    } else {
      this.bargeStart = 0;
    }
    this.interimActive = true;
    this.noteCandidateSpeech();
    this.ev.onInterim(text);
    if (this.speechTimer) clearTimeout(this.speechTimer);
  }

  private handleFinal(text: string) {
    if (this.ended) return;
    if (this.speaker.speaking && !this.opts.headphones) return;
    this.bargeStart = 0;
    this.interimActive = false;
    this.noteCandidateSpeech();
    this.ev.onInterim("");
    this.flushCanvas(); // keep the timeline ordered: drawing that happened before this sentence
    this.events.push(`[${this.clock()}] Candidate: "${text}"`);
    this.push("candidate", text);
    this.scheduleSpeechTick(turnPauseMs(text, this.listener.finalPauseMs));
  }

  /** Called from Excalidraw's onChange; cheap, debounced. */
  canvasChanged(elements: readonly unknown[]) {
    if (this.ended || !this.sessionId) return;
    // onChange fires on every render (selection, hover, scroll); only react to real element edits.
    const version = sceneVersion(elements as Parameters<typeof sceneVersion>[0]);
    if (version === this.lastSeenVersion) return;
    this.lastSeenVersion = version;
    this.lastCanvasChange = Date.now();
    if (this.canvasTimer) clearTimeout(this.canvasTimer);
    this.canvasTimer = setTimeout(() => {
      const changed = this.flushCanvas();
      // If they're talking, the end-of-speech tick will pick this up.
      if (changed && !this.isCandidateSpeaking()) void this.tick("whiteboard_settled");
    }, CANVAS_SETTLE);
  }

  // ---------- timing ----------

  private onHeartbeat() {
    if (this.ended || this.inFlight || this.speaker.speaking) return;
    const now = Date.now();
    if (this.queued && now >= this.backoffUntil) return this.drainQueue();
    const drawing = now - this.lastCanvasChange < 6000;
    const lastActivity = Math.max(this.lastCandidateSpeech, this.lastCanvasChange, this.lastInterviewerSpoke, this.startedAt);
    const midGap = MID_SPEECH_CHECK[this.opts.pushback];
    const talking = this.monologueStart > 0 && now - this.lastCandidateSpeech < 1500;
    if (midGap && talking && now - this.monologueStart >= midGap && now - this.lastTick >= midGap) {
      this.flushCanvas();
      void this.tick(`candidate_still_talking_${Math.round((now - this.monologueStart) / 1000)}s`);
    } else if (drawing && now - this.lastTick > DRAWING_HEARTBEAT) {
      this.flushCanvas();
      void this.tick("periodic_check_while_drawing");
    } else if (!drawing && !this.isCandidateSpeaking() && now - lastActivity > LONG_SILENCE && now - this.lastTick > LONG_SILENCE) {
      void this.tick(`long_silence_${Math.round((now - lastActivity) / 1000)}s`);
    }
  }

  private scheduleSpeechTick(delay: number) {
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = setTimeout(() => {
      if (!this.isCandidateSpeaking()) void this.tick("candidate_paused_speaking");
    }, delay);
  }

  private noteCandidateSpeech() {
    const now = Date.now();
    if (!this.monologueStart || now - this.lastCandidateSpeech > MONOLOGUE_BREAK) this.monologueStart = now;
    this.lastCandidateSpeech = now;
  }

  private isCandidateSpeaking() {
    return this.interimActive && Date.now() - this.lastCandidateSpeech < 2500;
  }

  // ---------- the decision call ----------

  private async tick(trigger: string) {
    if (this.ended) return;
    const now = Date.now();
    if (this.inFlight || this.speaker.speaking || now < this.backoffUntil) {
      this.queued = trigger;
      return;
    }
    if (now - this.lastTick < MIN_TICK_GAP && trigger !== "interview_start") {
      this.queued = trigger;
      setTimeout(() => this.drainQueue(), MIN_TICK_GAP);
      return;
    }
    this.inFlight = true;
    this.lastTick = now;
    this.queued = null;
    this.setStatus();

    const { elements, image } = this.opts.getScene();
    const scene = describeScene(elements);
    let png: string | undefined;
    if (
      this.opts.snapshots &&
      scene.items.size > 0 &&
      scene.version !== this.lastSnapshotVersion &&
      now - this.lastSnapshotAt > SNAPSHOT_GAP
    ) {
      png = await image();
      this.lastSnapshotVersion = scene.version;
      this.lastSnapshotAt = now;
    }
    const events = this.events;
    this.events = [];
    const requestedAt = Date.now();

    try {
      const res = await fetch("/api/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, trigger, events, scene: scene.text, image: png, timing: this.timing() }),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // The reply streams in: start speaking at the first sentence instead of waiting for all of it.
      let utterance: ReturnType<InterviewLoop["speakStream"]> | null = null;
      let skip = false;
      let hangUp = false;
      for await (const m of ndjson<TickMessage>(res.body)) {
        if (m.t === "head") {
          // The candidate started talking while we were thinking: a polite human would hold off,
          // unless it's worth cutting in for.
          const talkedSince = this.lastCandidateSpeech > requestedAt;
          skip = !m.speak || this.ended || (talkedSince && m.urgency !== "high");
          if (!skip) utterance = this.speakStream();
        } else if (m.t === "say") {
          utterance?.push(m.text);
        } else if (m.t === "error") {
          throw new Error(m.error || `HTTP ${m.status}`);
        } else if (m.t === "done") {
          this.ev.onError(null);
          this.ev.onCost(m.costUsd);
          if (m.note) this.ev.onNote(m.note);
          hangUp = !!m.end_call && !skip;
        }
      }
      if (utterance) {
        utterance.end();
        await utterance.finished;
      }
      if (hangUp && !this.ended) {
        // The interviewer said goodbye: hang up after a beat, like a real call.
        setTimeout(() => {
          if (!this.ended) this.ev.onCallEnded?.();
        }, 1200);
      }
    } catch (e) {
      this.events = [...events, ...this.events]; // don't lose observations
      this.backoffUntil = Date.now() + 5000;
      this.ev.onError(`Interviewer error: ${(e as Error).message}`);
    } finally {
      this.inFlight = false;
      this.setStatus();
      setTimeout(() => this.drainQueue(), 300);
    }
  }

  private drainQueue() {
    if (this.queued && !this.inFlight && !this.speaker.speaking) {
      const t = this.queued;
      this.queued = null;
      void this.tick(t);
    }
  }

  /** Voice a reply whose text is still arriving; records what was actually said once it ends. */
  private speakStream() {
    const at = this.clock();
    // Cutting in on someone mid-sentence: give them a moment to stop before barge-in applies.
    if (this.isCandidateSpeaking() || Date.now() - this.lastCandidateSpeech < 1000) {
      this.bargeGraceUntil = Date.now() + INTERRUPT_GRACE_MS;
    }
    this.monologueStart = 0;
    // On speakers the mic would hear (and transcribe) the interviewer's own voice.
    if (!this.opts.headphones) this.listener.setPaused?.(true);
    this.ev.onStatus("speaking");
    const u = this.speaker.stream();
    let text = "";
    let entryId = 0;
    const finished = u.done.then(async ({ spoken, interrupted }) => {
      if (!this.opts.headphones) this.listener.setPaused?.(false); // the listener holds off for the echo tail itself
      this.lastInterviewerSpoke = Date.now();
      const said = spoken || text;
      if (!said.trim()) return;
      if (interrupted && entryId) this.ev.onTranscript({ id: entryId, at, who: "interviewer", text: said, interrupted });
      await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, said, interrupted, at }),
      });
    });
    return {
      push: (t: string) => {
        text += t;
        // Show it as it's spoken.
        if (!entryId) entryId = this.push("interviewer", text);
        else this.ev.onTranscript({ id: entryId, at, who: "interviewer", text });
        u.push(t);
      },
      end: () => u.end(),
      finished,
    };
  }

  // ---------- helpers ----------

  /** Report whiteboard changes since the last report as an event. Returns true if anything changed. */
  private flushCanvas(): boolean {
    if (this.canvasTimer) {
      clearTimeout(this.canvasTimer);
      this.canvasTimer = null;
    }
    const scene = describeScene(this.opts.getScene().elements);
    if (scene.version === this.lastReportedVersion) return false;
    const changes = diffScenes(this.prevScene, scene);
    this.prevScene = scene;
    this.lastReportedVersion = scene.version;
    if (!changes.length) return false;
    const text = changes.slice(0, 15).join("; ") + (changes.length > 15 ? `; …and ${changes.length - 15} more` : "");
    this.events.push(`[${this.clock()}] Whiteboard: ${text}`);
    this.push("board", text);
    return true;
  }

  private clock(t = Date.now()) {
    const s = Math.max(0, Math.floor((t - this.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  private timing() {
    const now = Date.now();
    const ago = (t: number) => (t ? `${Math.round((now - t) / 1000)}s ago` : "never");
    const board =
      this.opts.mode === "recruiter"
        ? []
        : [
            `whiteboard last changed ${ago(this.lastCanvasChange)}`,
            `candidate actively drawing: ${now - this.lastCanvasChange < 6000 ? "yes" : "no"}`,
          ];
    return [
      `elapsed ${this.clock()} of ${this.opts.durationMin}:00`,
      `candidate ${this.isCandidateSpeaking() ? "is speaking right now" : `last spoke ${ago(this.lastCandidateSpeech)}`}`,
      ...board,
      `you last spoke ${ago(this.lastInterviewerSpoke)}`,
    ].join("; ");
  }

  private push(who: TranscriptEntry["who"], text: string, interrupted?: boolean): number {
    const id = this.nextId++;
    this.ev.onTranscript({ id, at: this.clock(), who, text, interrupted });
    return id;
  }

  private setStatus() {
    if (this.ended) return this.ev.onStatus("ended");
    if (this.speaker.speaking) return this.ev.onStatus("speaking");
    if (this.inFlight) return this.ev.onStatus("thinking");
    this.ev.onStatus(this.muted ? "idle" : "listening");
  }
}

type TickMessage =
  | { t: "head"; speak: boolean; urgency: "low" | "normal" | "high" }
  | { t: "say"; text: string }
  | { t: "done"; speak: boolean; say: string; urgency: string; note: string; end_call?: boolean; costUsd: number }
  | { t: "error"; status: number; error?: string };

/** Parse a newline-delimited JSON response body as it arrives. */
async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
    if (done) break;
  }
  if (buf.trim()) yield JSON.parse(buf) as T;
}
