// Kokoro voice for the interviewer: natural-sounding, runs locally in the browser
// (src/tts.worker.ts). Same contract as the browser Speaker: speak() resolves with how much
// was actually said, and cancel() cuts it off mid-sentence for barge-in.

import { pickDefaultVoice, Speaker, type SpokenResult } from "./speech";

export type TtsRequest =
  | { type: "load" }
  | { type: "speak"; id: number; text: string; voice: string; speed: number }
  | { type: "open"; id: number; voice: string; speed: number } // text follows in "append"s
  | { type: "append"; id: number; text: string }
  | { type: "end"; id: number }
  | { type: "cancel"; id: number };

export type TtsResponse =
  | { type: "progress"; pct: number }
  | { type: "ready"; device: "webgpu" | "wasm" }
  | { type: "error"; message: string }
  | { type: "chunk"; id: number; index: number; text: string; pcm: Float32Array; rate: number }
  | { type: "done"; id: number }
  | { type: "failed"; id: number; message: string };

export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (US, female)" },
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "af_nicole", label: "Nicole (US, female, soft)" },
  { id: "am_michael", label: "Michael (US, male)" },
  { id: "am_fenrir", label: "Fenrir (US, male)" },
  { id: "am_puck", label: "Puck (US, male)" },
  { id: "bf_emma", label: "Emma (UK, female)" },
  { id: "bm_george", label: "George (UK, male)" },
] as const;
export const DEFAULT_KOKORO_VOICE = "af_heart";
export const isKokoroVoice = (v: string | null): v is string => KOKORO_VOICES.some((x) => x.id === v);

export interface KokoroStatus {
  state: "idle" | "loading" | "ready" | "error";
  pct?: number;
  device?: "webgpu" | "wasm";
  message?: string;
}

/** One worker and one loaded model per page, shared by every interview. */
class KokoroEngine {
  status: KokoroStatus = { state: "idle" };
  private worker: Worker | null = null;
  private listeners = new Set<(s: KokoroStatus) => void>();
  private handlers = new Map<number, (m: TtsResponse) => void>();

  load() {
    if (this.status.state === "loading" || this.status.state === "ready") return;
    this.worker ??= this.spawn();
    this.setStatus({ state: "loading", pct: 0 });
    this.post({ type: "load" });
  }

  subscribe(fn: (s: KokoroStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  on(id: number, fn: (m: TtsResponse) => void) {
    this.handlers.set(id, fn);
  }
  off(id: number) {
    this.handlers.delete(id);
  }
  post(m: TtsRequest) {
    this.worker?.postMessage(m);
  }

  private spawn() {
    const w = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<TtsResponse>) => {
      const m = e.data;
      if (m.type === "progress") this.setStatus({ state: "loading", pct: m.pct });
      else if (m.type === "ready") this.setStatus({ state: "ready", device: m.device });
      else if (m.type === "error") this.setStatus({ state: "error", message: m.message });
      else this.handlers.get(m.id)?.(m);
    };
    w.onerror = (e) => this.setStatus({ state: "error", message: e.message || "voice worker crashed" });
    return w;
  }

  private setStatus(s: KokoroStatus) {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }
}

export const kokoro = new KokoroEngine();

interface Playing {
  id: number;
  text: string;
  resolve: (r: SpokenResult) => void;
  sources: AudioBufferSourceNode[];
  pieces: { text: string; start: number; dur: number }[];
  nextAt: number;
  playing: number; // sources not yet ended
  generated: boolean; // the worker has sent every piece
}

let nextId = 1;

/** A reply being spoken while its text is still streaming in. */
export interface Utterance {
  push(text: string): void;
  end(): void;
  /** Resolves with what was actually said once playback finishes or is cut off. */
  done: Promise<SpokenResult>;
}

export class KokoroSpeaker {
  rate = 1.05;
  private ctx: AudioContext;
  private current: Playing | null = null;
  private fallback = new Speaker(); // built-in browser voice, only while the model loads or if it fails

  /** Construct from a click handler: browsers only allow audio to start from a user gesture. */
  constructor(public voiceName: string) {
    this.ctx = new AudioContext();
    void this.ctx.resume();
    this.fallback.voiceName = pickDefaultVoice(speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")));
    kokoro.load();
  }

  get speaking() {
    return this.current !== null || this.fallback.speaking;
  }

  speak(text: string): Promise<SpokenResult> {
    const u = this.stream();
    u.push(text);
    u.end();
    return u.done;
  }

  /**
   * Start an utterance whose text is still arriving (streamed from the model). Whole sentences
   * are voiced as soon as they're complete, so speech starts before the reply is finished.
   */
  stream(): Utterance {
    this.cancel();
    let buffered = "";
    let all = "";
    let ended = false;
    const kokoroReady = kokoro.status.state === "ready";

    if (!kokoroReady) {
      // Stand-in voice can't start mid-reply; speak it all once the text is complete.
      let resolve!: (r: SpokenResult) => void;
      const done = new Promise<SpokenResult>((r) => (resolve = r));
      return {
        done,
        push: (t) => {
          all += t;
        },
        end: () => {
          if (ended) return;
          ended = true;
          if (all.trim()) void this.fallback.speak(all).then(resolve);
          else resolve({ spoken: "", interrupted: false });
        },
      };
    }

    const id = nextId++;
    let resolve!: (r: SpokenResult) => void;
    const done = new Promise<SpokenResult>((r) => (resolve = r));
    const p: Playing = { id, text: "", resolve, sources: [], pieces: [], nextAt: 0, playing: 0, generated: false };
    this.current = p;
    kokoro.on(id, (m) => {
      if (this.current !== p) return;
      if (m.type === "chunk") this.play(p, m.text, m.pcm, m.rate);
      else if (m.type === "done") {
        p.generated = true;
        this.maybeFinish(p);
      } else if (m.type === "failed") {
        console.warn("kokoro failed, using the browser voice:", m.message);
        p.generated = true;
        if (!p.pieces.length) {
          this.finish(p);
          void this.fallback.speak(p.text).then(resolve);
        } else this.maybeFinish(p);
      }
    });
    kokoro.post({ type: "open", id, voice: this.voiceName, speed: this.rate });

    // Send complete sentences (at least a few words, so tiny fragments don't sound choppy).
    const flush = (final: boolean) => {
      if (this.current !== p) return;
      let cut = buffered.length;
      if (!final) {
        const ends = [...buffered.matchAll(/[.!?;:]+["')\]]*\s+/g)];
        const last = ends.filter((e) => e.index! + e[0].length >= 12).pop();
        if (!last) return;
        cut = last.index! + last[0].length;
      }
      const piece = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut);
      if (!piece) return;
      p.text = `${p.text} ${piece}`.trim();
      kokoro.post({ type: "append", id, text: piece });
    };

    return {
      done,
      push: (t) => {
        if (ended) return;
        buffered += t;
        flush(false);
      },
      end: () => {
        if (ended) return;
        ended = true;
        flush(true);
        if (this.current === p) kokoro.post({ type: "end", id });
      },
    };
  }

  private play(p: Playing, text: string, pcm: Float32Array, rate: number) {
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.02, p.nextAt);
    src.start(at);
    p.nextAt = at + buf.duration;
    p.pieces.push({ text, start: at, dur: buf.duration });
    p.sources.push(src);
    p.playing++;
    src.onended = () => {
      p.playing--;
      this.maybeFinish(p);
    };
  }

  private maybeFinish(p: Playing) {
    if (this.current !== p || !p.generated || p.playing > 0) return;
    this.finish(p);
    p.resolve({ spoken: p.text, interrupted: false });
  }

  private finish(p: Playing) {
    kokoro.off(p.id);
    if (this.current === p) this.current = null;
  }

  /** Stop talking now (barge-in). Resolves the pending speak() with what was heard so far. */
  cancel() {
    if (this.fallback.speaking) this.fallback.cancel();
    const p = this.current;
    if (!p) return;
    kokoro.post({ type: "cancel", id: p.id });
    for (const s of p.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.finish(p);
    // Estimate how far it got: whole pieces already played, plus part of the current one.
    const t = this.ctx.currentTime;
    let said = "";
    for (const piece of p.pieces) {
      if (t >= piece.start + piece.dur) {
        said += `${piece.text} `;
        continue;
      }
      if (t > piece.start) {
        const part = piece.text.slice(0, Math.round((piece.text.length * (t - piece.start)) / piece.dur));
        said += part.slice(0, Math.max(0, part.lastIndexOf(" ")));
      }
      break;
    }
    said = said.trim();
    p.resolve({ spoken: said ? `${said}…` : "", interrupted: true });
  }
}
