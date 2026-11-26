// OpenAI provider, on the Responses API: streaming, structured outputs and web search.
// OpenAI caches repeated prompt prefixes automatically, so the append-only conversation the
// interview keeps is cached here too, with no breakpoints to mark.

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputItem, ResponseUsage } from "openai/resources/responses/responses";
import type { z } from "zod";
import {
  type Capabilities,
  type ChatTurn,
  costOf,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type Prices,
  ProviderError,
} from "./types";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

// Per-million-token prices used for the running estimate. These are placeholders for models whose
// price isn't listed here; check https://openai.com/api/pricing and add your model.
const PRICES: Record<string, Prices> = {
  default: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

function toInput(turns: ChatTurn[]): ResponseInputItem[] {
  return turns.map((t) => {
    if (t.role === "assistant" || !t.image) return { role: t.role, content: t.content };
    return {
      role: "user",
      content: [
        { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${t.image}` },
        { type: "input_text", text: t.content },
      ],
    };
  });
}

function wrap(e: unknown): never {
  if (e instanceof OpenAI.AuthenticationError) throw new ProviderError("OpenAI rejected the API key. Check it and try again.", 401);
  if (e instanceof OpenAI.RateLimitError) throw new ProviderError("Rate limited by OpenAI. Retrying shortly.", 429);
  if (e instanceof OpenAI.APIError) throw new ProviderError(`OpenAI API error ${e.status}: ${e.message}`, 502);
  throw e;
}

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai" as const;
  readonly capabilities: Capabilities = { fast: false, webResearch: true };
  private client: OpenAI;
  private prices: Prices;

  /** With no apiKey, the SDK reads OPENAI_API_KEY. */
  constructor(
    readonly model: string,
    apiKey?: string,
  ) {
    this.client = new OpenAI(apiKey ? { apiKey } : {});
    this.prices = PRICES[model] ?? (PRICES.default as Prices);
  }

  async check(): Promise<string | null> {
    try {
      await this.client.models.retrieve(this.model);
      return null;
    } catch (e) {
      if (e instanceof OpenAI.AuthenticationError) return "OpenAI rejected the API key. Check it and try again.";
      if (e instanceof OpenAI.APIError) return `OpenAI API error ${e.status}: ${e.message}`;
      return `Couldn't reach OpenAI: ${(e as Error).message}`;
    }
  }

  private usage(u: ResponseUsage | undefined) {
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    // OpenAI's input_tokens includes the cached ones; report them separately like Anthropic does.
    const usage = { input: (u?.input_tokens ?? 0) - cached, cachedInput: cached, cacheWrite: 0, output: u?.output_tokens ?? 0 };
    return { ...usage, costUsd: costOf(this.prices, usage) };
  }

  private async stream(
    req: ModelRequest,
    format: ReturnType<typeof zodTextFormat> | undefined,
    onText?: (d: string) => void,
  ): Promise<ModelResult> {
    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          instructions: req.system,
          input: toInput(req.messages),
          max_output_tokens: req.maxTokens,
          reasoning: { effort: req.effort },
          ...(format ? { text: { format } } : {}),
          store: false,
          stream: true,
        },
        { signal: req.signal },
      );
      let text = "";
      let refused = false;
      let usage: ResponseUsage | undefined;
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") {
          text += ev.delta;
          onText?.(ev.delta);
        } else if (ev.type === "response.refusal.delta") {
          refused = true;
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          usage = ev.response.usage ?? undefined;
        } else if (ev.type === "response.failed") {
          throw new ProviderError(`OpenAI request failed: ${ev.response.error?.message ?? "unknown error"}`, 502);
        }
      }
      return { text, usage: this.usage(usage), refused };
    } catch (e) {
      if (req.signal?.aborted || e instanceof ProviderError) throw e;
      wrap(e);
    }
  }

  streamText(req: ModelRequest, onText?: (d: string) => void) {
    return this.stream(req, undefined, onText);
  }

  streamJSON(req: ModelRequest, schema: z.ZodType, name: string, onText?: (d: string) => void) {
    return this.stream(req, zodTextFormat(schema, name), onText);
  }

  async research(system: string, prompt: string): Promise<string> {
    try {
      const res = await this.client.responses.create({
        model: this.model,
        instructions: system,
        input: prompt,
        tools: [{ type: "web_search" }],
        reasoning: { effort: "medium" },
        store: false,
      });
      return res.output_text.trim();
    } catch (e) {
      wrap(e);
    }
  }
}
