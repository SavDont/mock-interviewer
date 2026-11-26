// Speech to text: proxies audio to a local whisper.cpp server, and cleans up what it hears.
// Audio never leaves the machine on this path.

import { config } from "./config";

// Biases Whisper toward system design vocabulary ("Kafka", not "Cafe car"; "p99", not "page 99").
export const VOCAB =
  "System design interview. Kafka, Redis, Memcached, Postgres, MySQL, Cassandra, DynamoDB, MongoDB, S3, CDN, " +
  "load balancer, API gateway, QPS, TPS, p99 latency, sharding, partitioning, replication, consistent hashing, " +
  "idempotency, rate limiter, pub/sub, message queue, write-ahead log, write path, read path, LRU cache, base62, " +
  "snowflake ID, gRPC, WebSocket, bit.ly, URL shortener.";

// Homophones Whisper can't tell apart from audio alone; in a system design interview the
// technical reading is almost always the one meant.
const FIXUPS: [RegExp, string][] = [
  [
    /\bright(?=[- ](path|paths|heavy|throughput|traffic|requests?|load|volume|amplification|ahead|through|back|QPS|replicas?|lock|quorum|concern|latency|operations?|side)\b)/gi,
    "write",
  ],
  [/\bright[- ]ahead log\b/gi, "write-ahead log"],
  [/\breads? and rights\b/gi, "reads and writes"],
  [/\b(?:page|pea|pee|p) ?(50|90|95|99|999)\b/gi, "p$1"],
  [/\bbase ?62\b/gi, "base62"],
  [/\bcafe car\b/gi, "Kafka"],
  [/\bstag(?:less|eless)\b/gi, "stateless"],
];
export function fixTranscript(text: string): string {
  return FIXUPS.reduce((t, [re, to]) => t.replace(re, to), text);
}

// Whisper's stock outputs for silence or noise, and its classic hallucinations on near-empty audio.
// The voice detector only sends audio that contains speech, so real short answers like "Thank you."
// are left alone; only phrases nobody says in an interview are dropped.
const NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;
const HALLUCINATIONS = new Set(["you", "thanks for watching!", "thank you for watching.", "please subscribe.", "."]);

export function cleanTranscript(raw: string): string {
  const text = raw.replace(NOISE, " ").replace(/\s+/g, " ").trim();
  return HALLUCINATIONS.has(text.toLowerCase()) ? "" : fixTranscript(text);
}

export async function whisperUp(): Promise<boolean> {
  try {
    const r = await fetch(config.whisperUrl, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Transcribes a 16kHz mono WAV. `context` is the tail of what the candidate just said, so each short
 * utterance is transcribed in context (names, topics and spelling stay consistent).
 */
export async function transcribe(wav: ArrayBuffer, context: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([wav], "audio.wav", { type: "audio/wav" }));
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("beam_size", "5");
  form.append("prompt", context ? `${VOCAB} ${context.slice(-400)}` : VOCAB);
  const r = await fetch(`${config.whisperUrl}/inference`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`whisper ${r.status}`);
  return cleanTranscript(((await r.json()) as { text?: string }).text ?? "");
}
