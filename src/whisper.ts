// Local speech-to-text: capture the mic, find utterances with Silero, a neural voice activity
// detector (src/vad.ts), and send each one (16kHz WAV) to whisper.cpp via /api/transcribe.
// Works in any browser (no cloud speech service), and is better at technical vocabulary.
//
// This layer only cuts audio into segments at short pauses so transcription keeps up.
// Deciding when the candidate has finished their turn is turn-taking.ts's job (see turnPauseMs).

import type { ListenerCallbacks, SpeechInput } from "./speech";
import { SileroVad, VAD_FRAME } from "./vad";

export const SPEAKING_MARK = "…"; // interim placeholder: "the candidate is talking right now"

const FRAME_MS = 20; // level-meter frames for calibration (openMicProbe)
const VAD_FRAME_MS = 32; // one Silero frame
const SPEECH_PROB = 0.5; // frame counts as speech at or above this…
const SILENCE_PROB = 0.35; // …and as silence below this (in between keeps the current state)
const ONSET_WINDOW = 3; // speech starts when 2 of the last 3 frames (~100ms) are speech
const ONSET_FRAMES = 2;
const SEGMENT_SILENCE_MS = 600; // a pause this long closes a segment and sends it to Whisper
const PREROLL_MS = 500; // audio kept from just before speech was detected
const TAIL_MS = 250; // trailing silence kept so the last word isn't clipped
// Less speech than this in a segment is a blip, not a word. Kept low: a quick one-syllable
// check-in ("cool?", "yeah") can have only ~100-150ms of frames Silero is sure about, and Whisper
// plus the server's noise filter already discard coughs and clicks that get through.
const MIN_SPEECH_MS = 90;
const SOFT_MAX_MS = 15000; // long monologues: after this, cut at the next brief pause…
const HARD_MAX_MS = 28000; // …or here at the latest (Whisper's window is 30s)
const ECHO_GUARD_MS = 300; // after the interviewer stops (on speakers), let the echo die out
const TARGET_RATE = 16000;

// Noise gate: 0..100 maps (log scale) to the minimum mic level that counts as speech.
const GATE_MIN = 0.005,
  GATE_MAX = 0.15;
export const DEFAULT_GATE = 50;
export function gateToLevel(gate: number): number {
  return GATE_MIN * (GATE_MAX / GATE_MIN) ** (Math.max(0, Math.min(100, gate)) / 100);
}
/** Mic level (RMS) on the same 0..1 scale as the gate slider, for a level meter. */
export function levelToFraction(rms: number): number {
  if (rms <= GATE_MIN) return 0;
  return Math.min(1, Math.log(rms / GATE_MIN) / Math.log(GATE_MAX / GATE_MIN));
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** Inverse of gateToLevel: the slider value (0..100) for a given mic level. */
export function levelToGate(level: number): number {
  return Math.round(levelToFraction(level) * 100);
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export interface Calibration {
  gate: number;
  noise: number; // ambient level (95th percentile while quiet)
  speech: number; // typical level while talking, 0 if no speech was heard
  ok: boolean; // false if speech wasn't clearly louder than the room
  message: string;
}

/**
 * Picks a noise gate from two measurements made with the same mic pipeline the interview uses:
 * the room while you're quiet, then you reading a sentence. The gate sits between the two,
 * well above the noise but low enough that softer syllables still start an utterance.
 */
export function chooseGate(quiet: number[], talking: number[]): Calibration {
  const noise = Math.max(percentile(quiet, 0.95), 0.002);
  const voiced = talking.filter((r) => r > noise * 2);
  if (voiced.length < 15) {
    // < ~0.3s of speech above the noise: couldn't hear them
    return {
      gate: levelToGate(noise * 2.5),
      noise,
      speech: 0,
      ok: false,
      message: "Couldn't hear you clearly over the room noise. Set the gate just above the noise; speak up or move the mic closer.",
    };
  }
  const speech = percentile(voiced, 0.5);
  const lo = noise * 2.5,
    hi = speech * 0.5;
  if (lo >= hi) {
    return {
      gate: levelToGate(lo),
      noise,
      speech,
      ok: false,
      message: "Your voice is only a little louder than the room. Gate set just above the noise; a closer mic or headset will help.",
    };
  }
  return { gate: levelToGate(Math.sqrt(lo * hi)), noise, speech, ok: true, message: "Calibrated." };
}

/** Opens the mic just to measure levels (no transcription). */
export async function openMicProbe(onLevel?: (rms: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE });
  } catch {
    ctx = new AudioContext();
  }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(ctx, "tap", { processorOptions: { size: Math.round((ctx.sampleRate * FRAME_MS) / 1000) } });
  let sink: number[] | null = null;
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const rms = rmsOf(e.data);
    onLevel?.(rms);
    sink?.push(rms);
  };
  ctx.createMediaStreamSource(stream).connect(tap);
  return {
    /** Collects per-frame levels for `ms` milliseconds. */
    async record(ms: number): Promise<number[]> {
      const out: number[] = [];
      sink = out;
      await new Promise((r) => setTimeout(r, ms));
      sink = null;
      return out;
    },
    close() {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

export interface WhisperOptions {
  gate?: number; // 0..100: how loud the start of an utterance must be (rejects distant voices, TV)
  onLevel?: (rms: number) => void; // ~15 times a second, for a meter
}

// Runs on the audio thread; batches 128-sample render quanta into fixed-size frames.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor(opts) { super(); this.size = opts.processorOptions.size; this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

interface Frame {
  pcm: Float32Array;
  prob: number;
  rms: number;
}

export class WhisperListener implements SpeechInput {
  readonly finalPauseMs = 900; // base wait after a segment before the interviewer may respond
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private vad: SileroVad | null = null;
  private active = false;
  private paused = false;
  private guardUntil = 0;
  private pending = new Float32Array(0); // 16kHz samples not yet a full VAD frame
  private chain: Promise<void> = Promise.resolve(); // VAD frames are processed strictly in order
  private recentFrames: Frame[] = []; // preroll while idle
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private utterance: Frame[] = [];
  private lastInterimAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private recent: string[] = []; // last few transcripts, sent as context for the next one
  private minLevel: number;
  private floor = 0.004; // energy fallback only, if the VAD model fails to load
  private peak = 0;
  private lastLevelAt = 0;

  constructor(
    private cb: ListenerCallbacks,
    private wopts: WhisperOptions = {},
  ) {
    this.minLevel = gateToLevel(wopts.gate ?? DEFAULT_GATE);
  }

  /** Change the noise gate live (0..100). */
  setGate(gate: number) {
    this.minLevel = gateToLevel(gate);
  }

  get running() {
    return this.active;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    try {
      const [stream, vad] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS }),
        SileroVad.load().catch((e) => {
          console.warn("Silero VAD failed to load; falling back to a volume threshold", e);
          return null;
        }),
      ]);
      this.stream = stream;
      this.vad = vad;
      this.vad?.reset();
      if (!this.active) return this.release();
      // Let the browser resample to 16kHz with a proper filter (cleaner than our own decimation).
      try {
        this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
      } catch {
        this.ctx = new AudioContext();
      }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const src = this.ctx.createMediaStreamSource(this.stream);
      const tap = new AudioWorkletNode(this.ctx, "tap", {
        processorOptions: { size: Math.round((this.ctx.sampleRate * VAD_FRAME_MS) / 1000) },
      });
      const rate = this.ctx.sampleRate;
      tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAudio(downsample(e.data, rate, TARGET_RATE));
      src.connect(tap); // not connected to destination: we only listen, never play back
    } catch (e) {
      this.active = false;
      this.release();
      const name = (e as DOMException).name;
      this.cb.onError(
        name === "NotAllowedError" ? "Microphone permission was denied." : `Couldn't start the microphone: ${(e as Error).message}`,
      );
    }
  }

  setPaused(paused: boolean) {
    if (paused) {
      // Throw away anything in progress; it's likely the interviewer's own voice.
      this.paused = true;
      this.resetSegment();
      this.recentFrames = [];
    } else if (this.paused) {
      // Keep collecting preroll during the guard, so words spoken right as the interviewer
      // stops aren't lost; just don't let the echo tail start an utterance.
      this.paused = false;
      this.guardUntil = performance.now() + ECHO_GUARD_MS;
    }
  }

  stop() {
    this.active = false;
    this.release();
    this.resetSegment();
    this.recentFrames = [];
    this.pending = new Float32Array(0);
  }

  private release() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private resetSegment() {
    this.speaking = false;
    this.utterance = [];
    this.silenceMs = 0;
    this.speechMs = 0;
  }

  /** Re-chunks 16kHz audio into 512-sample frames for the VAD. */
  private onAudio(samples: Float32Array) {
    if (!this.active) return;
    const buf = new Float32Array(this.pending.length + samples.length);
    buf.set(this.pending, 0);
    buf.set(samples, this.pending.length);
    let o = 0;
    for (; o + VAD_FRAME <= buf.length; o += VAD_FRAME) {
      const pcm = buf.slice(o, o + VAD_FRAME);
      this.chain = this.chain.then(() => this.onFrame(pcm)).catch((e) => console.warn("vad frame", e));
    }
    this.pending = buf.slice(o);
  }

  private async onFrame(pcm: Float32Array) {
    if (!this.active) return;
    if (this.paused) return this.wopts.onLevel?.(0);
    const rms = rmsOf(pcm);
    this.reportLevel(rms);
    const prob = this.vad ? await this.vad.process(pcm) : this.energyProb(rms);
    if (!this.active || this.paused) return;
    const frame: Frame = { pcm, prob, rms };

    if (!this.speaking) {
      this.recentFrames.push(frame);
      if (this.recentFrames.length > PREROLL_MS / VAD_FRAME_MS) this.recentFrames.shift();
      if (performance.now() < this.guardUntil) return;
      // Onset: most of the last ~100ms is speech, and at least one frame clears the gate.
      // (The gate is checked on the loudest frame, not every frame, so soft starts count.)
      const win = this.recentFrames.slice(-ONSET_WINDOW);
      const voiced = win.filter((f) => f.prob >= SPEECH_PROB).length;
      const loudest = Math.max(...win.map((f) => f.rms));
      if (voiced >= ONSET_FRAMES && loudest >= this.minLevel) {
        this.speaking = true;
        this.utterance = this.recentFrames;
        this.recentFrames = [];
        this.silenceMs = 0;
        this.speechMs = voiced * VAD_FRAME_MS;
        this.signalSpeaking(true);
      }
      return;
    }

    this.utterance.push(frame);
    if (prob >= SPEECH_PROB) {
      this.speechMs += VAD_FRAME_MS;
      this.silenceMs = 0;
      this.signalSpeaking(false);
    } else if (prob < SILENCE_PROB) {
      this.silenceMs += VAD_FRAME_MS;
    } else {
      this.silenceMs = 0; // uncertain: a trailing-off syllable, not a pause
    }

    const durationMs = this.utterance.length * VAD_FRAME_MS;
    if (this.silenceMs >= SEGMENT_SILENCE_MS) this.finish(false);
    // Long monologue: cut at a brief dip between words rather than mid-word.
    else if (durationMs >= SOFT_MAX_MS && prob < SILENCE_PROB) this.finish(true);
    else if (durationMs >= HARD_MAX_MS) this.finish(true);
  }

  /** Used only if Silero couldn't load: the old volume test, expressed as a probability. */
  private energyProb(rms: number): number {
    if (!this.speaking) this.floor = Math.min(0.05, Math.max(0.002, this.floor * 0.97 + rms * 0.03));
    return rms > Math.max(this.floor * 3.5, this.minLevel) ? 0.9 : rms > this.floor * 2 ? 0.4 : 0.1;
  }

  private reportLevel(rms: number) {
    if (!this.wopts.onLevel) return;
    this.peak = Math.max(this.peak, rms);
    const now = performance.now();
    if (now - this.lastLevelAt > 66) {
      this.lastLevelAt = now;
      this.wopts.onLevel(this.peak);
      this.peak = 0;
    }
  }

  private signalSpeaking(force: boolean) {
    const now = performance.now();
    if (force || now - this.lastInterimAt > 300) {
      this.lastInterimAt = now;
      this.cb.onInterim(SPEAKING_MARK);
    }
  }

  private finish(stillTalking: boolean) {
    const frames = this.utterance;
    const speechMs = this.speechMs;
    const silenceMs = this.silenceMs;
    this.resetSegment();
    this.speaking = stillTalking; // a chunked monologue keeps going
    if (speechMs < MIN_SPEECH_MS) {
      if (!stillTalking) this.cb.onInterim("");
      return;
    }
    // Drop most of the trailing silence; keep a little so the last word isn't clipped.
    const trim = Math.max(0, Math.floor((silenceMs - TAIL_MS) / VAD_FRAME_MS));
    const wav = encodeWav(concat(frames.slice(0, frames.length - trim).map((f) => f.pcm)), TARGET_RATE);
    // Transcribe in order, even if the next segment finishes before this one returns.
    this.queue = this.queue.then(() => this.transcribe(wav));
  }

  private async transcribe(wav: Blob) {
    try {
      const r = await fetch("/api/transcribe", {
        method: "POST",
        body: wav,
        headers: { "Content-Type": "audio/wav", "X-Context": encodeURIComponent(this.recent.join(" ")) },
      });
      const data = (await r.json()) as { text?: string; error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (data.text) {
        this.recent.push(data.text);
        if (this.recent.length > 4) this.recent.shift();
        this.cb.onFinal(data.text);
      } else if (!this.speaking) this.cb.onInterim("");
    } catch (e) {
      this.cb.onError(`Transcription failed: ${(e as Error).message}`);
    }
  }
}

function rmsOf(f: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
  return Math.sqrt(sum / f.length);
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

/** Box-filter decimation; only used if the browser won't open a 16kHz AudioContext. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j++) s += input[j]!;
    out[i] = s / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
