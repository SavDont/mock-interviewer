// Chooses the model provider and holds API keys.
//
// Keys come from environment variables (.env) or from the "API key" form in the app. Keys entered in
// the app live only in this process's memory: they are never written to disk or logged, and they
// are only ever sent to the provider they belong to.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from "./openai";
import { MissingKeyError, type ModelProvider, type ProviderId } from "./types";

export * from "./types";

export const PROVIDERS: Record<ProviderId, { label: string; env: string; defaultModel: string; modelEnv: string }> = {
  anthropic: { label: "Anthropic (Claude)", env: "ANTHROPIC_API_KEY", defaultModel: DEFAULT_ANTHROPIC_MODEL, modelEnv: "ANTHROPIC_MODEL" },
  openai: { label: "OpenAI", env: "OPENAI_API_KEY", defaultModel: DEFAULT_OPENAI_MODEL, modelEnv: "OPENAI_MODEL" },
};

export type KeySource = "app" | "env" | "cli-login" | "none";

const appKeys: Partial<Record<ProviderId, string>> = {};
let chosen: ProviderId | null = null;
let cached: { key: string; provider: ModelProvider } | null = null;
let override: ModelProvider | null = null;

/** Use this provider instead of the configured one (tests and the eval harness). Pass null to undo. */
export function overrideProvider(p: ModelProvider | null) {
  override = p;
}

function isProviderId(v: unknown): v is ProviderId {
  return v === "anthropic" || v === "openai";
}

/** An env var holding a real-looking key (not empty, not the "sk-ant-..." placeholder from .env.example). */
function envKey(p: ProviderId): string | undefined {
  const v = process.env[PROVIDERS[p].env]?.trim();
  return v && !v.endsWith("...") ? v : undefined;
}

// An empty or placeholder key in .env would stop the Anthropic SDK from falling back to an
// `ant auth login` profile, so drop it.
for (const p of Object.keys(PROVIDERS) as ProviderId[]) if (!envKey(p)) delete process.env[PROVIDERS[p].env];

/** The Anthropic SDK can also use the profile from `ant auth login`. */
function hasAnthropicLogin(): boolean {
  return existsSync(join(process.env.HOME || homedir(), ".config", "anthropic", "credentials"));
}

export function keySource(p: ProviderId): KeySource {
  if (appKeys[p]) return "app";
  if (envKey(p)) return "env";
  if (p === "anthropic" && hasAnthropicLogin()) return "cli-login";
  return "none";
}

export function modelFor(p: ProviderId): string {
  // INTERVIEWER_MODEL is the older name for the Anthropic model setting.
  const fromEnv = process.env[PROVIDERS[p].modelEnv] || (p === "anthropic" ? process.env.INTERVIEWER_MODEL : undefined);
  return fromEnv || PROVIDERS[p].defaultModel;
}

/** The provider in use: the one picked in the app, else LLM_PROVIDER, else whichever has a key. */
export function activeProviderId(): ProviderId {
  if (chosen) return chosen;
  const env = process.env.LLM_PROVIDER?.toLowerCase();
  if (isProviderId(env)) return env;
  if (keySource("anthropic") === "none" && keySource("openai") !== "none") return "openai";
  return "anthropic";
}

export function chooseProvider(p: unknown): ProviderId {
  if (!isProviderId(p)) throw new Error("Unknown provider.");
  chosen = p;
  return p;
}

/** Stores a key entered in the app (memory only). Returns an error message if it doesn't look like a key. */
export function setAppKey(p: unknown, key: unknown): string | null {
  if (!isProviderId(p)) return "Unknown provider.";
  const k = typeof key === "string" ? key.trim() : "";
  if (k.length < 20 || k.length > 400 || /\s/.test(k)) return "That doesn't look like an API key.";
  appKeys[p] = k;
  chosen = p;
  cached = null;
  return null;
}

export function clearAppKey(p: unknown) {
  if (isProviderId(p)) delete appKeys[p];
  cached = null;
}

/** The active provider, ready to call. Throws MissingKeyError if it has no credentials. */
export function getProvider(): ModelProvider {
  if (override) return override;
  const id = activeProviderId();
  const source = keySource(id);
  if (source === "none") throw new MissingKeyError(id);
  const model = modelFor(id);
  const key = appKeys[id] ?? envKey(id);
  const cacheKey = `${id}|${model}|${source}|${key ?? ""}`;
  if (cached?.key === cacheKey) return cached.provider;
  const provider = id === "openai" ? new OpenAIProvider(model, key) : new AnthropicProvider(model, key);
  cached = { key: cacheKey, provider };
  return provider;
}

/** What the app shows about providers and keys. Never includes a key. */
export function providerStatus() {
  const active = activeProviderId();
  return {
    active,
    model: modelFor(active),
    providers: (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
      id,
      label: PROVIDERS[id].label,
      env: PROVIDERS[id].env,
      model: modelFor(id),
      keySource: keySource(id),
    })),
  };
}
