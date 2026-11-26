// Kokoro text-to-speech in a Web Worker, so synthesis never stalls the whiteboard or the mic.
// The model downloads from Hugging Face on first use (then the browser caches it) and runs
// on the GPU via WebGPU when available, else on the CPU via WebAssembly.

import { env, KokoroTTS } from "kokoro-web";
import type { TtsRequest, TtsResponse } from "./kokoro";

env.wasmPaths = "/kokoro/"; // copied there by vite.config.ts, so no CDN is involved

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
type Voice = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;
const post = (m: TtsResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let tts: Promise<KokoroTTS> | null = null;
let cancelled = new Set<number>();

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function load(): Promise<KokoroTTS> {
  tts ??= (async () => {
    const webgpu = await hasWebGpu();
    // fp32 is what Kokoro recommends on WebGPU; the 8-bit model is faster on the CPU.
    const model = await KokoroTTS.from_pretrained(MODEL, {
      device: webgpu ? "webgpu" : "wasm",
      dtype: webgpu ? "fp32" : "q8",
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx")) post({ type: "progress", pct: Math.round(p.progress ?? 0) });
      },
    });
    // Warm up (compiles GPU shaders) so the first real sentence isn't slow.
    await model.generate("Hi.", { voice: "af_heart" });
    post({ type: "ready", device: webgpu ? "webgpu" : "wasm" });
    return model;
  })();
  tts.catch((e) => {
    tts = null;
    post({ type: "error", message: String((e as Error)?.message ?? e) });
  });
  return tts;
}

/** Sentence-sized pieces: the first one plays while the rest are still being synthesized. */
function split(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?;:]+(?:[.!?;:]+|$)/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    // Glue tiny fragments ("Okay.") to the next piece so the prosody isn't choppy.
    if (out.length && out[out.length - 1]!.length < 12) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/** One utterance. Text can keep arriving (streamed from the model) until it's ended. */
interface Job {
  id: number;
  voice: Voice;
  speed: number;
  pieces: string[];
  ended: boolean;
  wake: (() => void) | null;
}
const jobs = new Map<number, Job>();

async function run(job: Job) {
  try {
    const model = await load();
    for (let i = 0; ; i++) {
      while (i >= job.pieces.length && !job.ended && !cancelled.has(job.id)) {
        await new Promise<void>((r) => (job.wake = r));
      }
      if (cancelled.has(job.id) || i >= job.pieces.length) break;
      const audio = await model.generate(job.pieces[i]!, { voice: job.voice, speed: job.speed });
      if (cancelled.has(job.id)) break;
      const pcm = audio.audio as Float32Array;
      post({ type: "chunk", id: job.id, index: i, text: job.pieces[i]!, pcm, rate: audio.sampling_rate }, [pcm.buffer]);
    }
    post({ type: "done", id: job.id });
  } catch (err) {
    post({ type: "failed", id: job.id, message: String((err as Error)?.message ?? err) });
  } finally {
    jobs.delete(job.id);
    cancelled.delete(job.id);
    if (cancelled.size > 50) cancelled = new Set();
  }
}

function wake(job: Job | undefined) {
  const w = job?.wake;
  if (job) job.wake = null;
  w?.();
}

self.onmessage = (e: MessageEvent<TtsRequest>) => {
  const m = e.data;
  if (m.type === "load") return void load().catch(() => {});
  if (m.type === "cancel") {
    cancelled.add(m.id);
    return wake(jobs.get(m.id));
  }
  if (m.type === "open" || m.type === "speak") {
    const job: Job = { id: m.id, voice: m.voice as Voice, speed: m.speed, pieces: [], ended: m.type === "speak", wake: null };
    if (m.type === "speak") job.pieces = split(m.text);
    jobs.set(m.id, job);
    return void run(job);
  }
  const job = jobs.get(m.id);
  if (!job) return;
  if (m.type === "append") job.pieces.push(...split(m.text));
  else if (m.type === "end") job.ended = true;
  wake(job);
};
