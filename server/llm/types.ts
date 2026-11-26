// The small interface every model provider implements. The interview, grading and drill code only
// talk to this, so adding a provider means writing one file (see anthropic.ts and openai.ts).

import type { z } from "zod";

export type ProviderId = "anthropic" | "openai";

/** How hard the model thinks. Providers map this onto their own reasoning settings. */
export type Effort = "low" | "medium" | "high";

/** One turn of a conversation. Content is plain text; `image` is an optional base64 PNG. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  image?: string;
}

export interface ModelRequest {
  system: string;
  messages: ChatTurn[];
  effort: Effort;
  maxTokens: number;
  /**
   * Everything up to and including this message index is the same on the next call, so providers
   * with explicit prompt caching (Anthropic) mark a cache breakpoint there. -1 caches only the system prompt.
   */
  cacheThrough?: number;
  /** Ask for the provider's low-latency mode, where it has one (Anthropic fast mode). */
  fast?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  /** Input tokens billed at the full rate. */
  input: number;
  /** Input tokens read from the prompt cache. */
  cachedInput: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  output: number;
  /** Estimated cost of this call in US dollars, from the provider's list prices. */
  costUsd: number;
}

export interface ModelResult {
  text: string;
  usage: Usage;
  /** The model declined to answer. */
  refused: boolean;
}

export interface Capabilities {
  /** A low-latency mode that costs more (Anthropic fast mode). */
  fast: boolean;
  /** Server-side web search, used to research a company before a recruiter screen. */
  webResearch: boolean;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly capabilities: Capabilities;
  /** Returns null when the credentials work, otherwise a message to show the user. */
  check(): Promise<string | null>;
  /** Streams free text, calling onText with each new piece. */
  streamText(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResult>;
  /** Streams a JSON object matching the schema, calling onText with each new piece of raw JSON. */
  streamJSON(req: ModelRequest, schema: z.ZodType, schemaName: string, onText?: (delta: string) => void): Promise<ModelResult>;
  /** Researches a topic on the web and returns the model's final answer. Only when capabilities.webResearch. */
  research?(system: string, prompt: string): Promise<string>;
}

/** Thrown when no API key is configured for the chosen provider. */
export class MissingKeyError extends Error {
  constructor(provider: ProviderId) {
    const env = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    super(
      `No ${provider === "openai" ? "OpenAI" : "Anthropic"} API key is set. Add ${env} to .env, or paste a key under "API key" in the app.`,
    );
    this.name = "MissingKeyError";
  }
}

/** Thrown when the provider rejects a request; carries a message that is safe to show and log. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Per-million-token list prices, for the running cost estimate. */
export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costOf(p: Prices, u: Omit<Usage, "costUsd">, multiplier = 1): number {
  return (multiplier * (u.input * p.input + u.output * p.output + u.cachedInput * p.cacheRead + u.cacheWrite * p.cacheWrite)) / 1e6;
}
