// Anthropic (Claude) provider: streaming, structured outputs, explicit prompt caching, fast mode,
// and server-side web search for company research.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
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

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

// List prices per million tokens. Unknown models fall back to the Opus 5.5 rates.
const PRICES: Record<string, Prices> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

function toMessages(turns: ChatTurn[], cacheThrough = -1): Msg[] {
  return turns.map((t, i) => {
    const blocks: Block[] = [];
    if (t.image) blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: t.image } });
    blocks.push({ type: "text", text: t.content, ...(i === cacheThrough ? { cache_control: { type: "ephemeral" as const } } : {}) });
    return { role: t.role, content: blocks };
  });
}

/** Turns SDK errors into messages that are safe to show (they never include the key). */
function wrap(e: unknown): never {
  if (e instanceof Anthropic.AuthenticationError) throw new ProviderError("Anthropic rejected the API key. Check it and try again.", 401);
  if (e instanceof Anthropic.RateLimitError) throw new ProviderError("Rate limited by Anthropic. Retrying shortly.", 429);
  if (e instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${e.status}: ${e.message}`, 502);
  throw e;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly capabilities: Capabilities;
  private client: Anthropic;
  private prices: Prices;

  /** With no apiKey, the SDK reads ANTHROPIC_API_KEY or an `ant auth login` profile. */
  constructor(
    readonly model: string,
    apiKey?: string,
  ) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.prices = PRICES[model] ?? (PRICES[DEFAULT_ANTHROPIC_MODEL] as Prices);
    this.capabilities = { fast: model === "claude-opus-5-5", webResearch: true };
  }

  async check(): Promise<string | null> {
    try {
      await this.client.models.retrieve(this.model);
      return null;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it and try again.";
      if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
      return `Couldn't reach Anthropic: ${(e as Error).message}`;
    }
  }

  private async stream(
    req: ModelRequest,
    format: ReturnType<typeof betaZodOutputFormat> | undefined,
    onText?: (d: string) => void,
  ): Promise<ModelResult> {
    const fast = req.fast && this.capabilities.fast;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...(fast ? { speed: "fast" as const } : {}),
          output_config: { effort: req.effort, ...(format ? { format } : {}) },
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: toMessages(req.messages, req.cacheThrough),
        },
        { signal: req.signal },
      );
      let text = "";
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          onText?.(ev.delta.text);
        }
      }
      const res = await stream.finalMessage();
      const u = res.usage;
      const usage = {
        input: u.input_tokens ?? 0,
        cachedInput: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
      // Fast mode bills at twice the normal rate.
      const multiplier = (u as { speed?: string }).speed === "fast" ? 2 : 1;
      return { text, usage: { ...usage, costUsd: costOf(this.prices, usage, multiplier) }, refused: res.stop_reason === "refusal" };
    } catch (e) {
      if (req.signal?.aborted) throw e;
      wrap(e);
    }
  }

  streamText(req: ModelRequest, onText?: (d: string) => void) {
    return this.stream(req, undefined, onText);
  }

  streamJSON(req: ModelRequest, schema: z.ZodType, _name: string, onText?: (d: string) => void) {
    return this.stream(req, betaZodOutputFormat(schema), onText);
  }

  async research(system: string, prompt: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    try {
      for (let turn = 0; turn < 4; turn++) {
        const res = await this.client.messages
          .stream({
            model: this.model,
            max_tokens: 16000,
            output_config: { effort: "medium" },
            system,
            tools: [
              { type: "web_search_20260209", name: "web_search", max_uses: 8 },
              { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
            ],
            messages,
          })
          .finalMessage();
        if (res.stop_reason === "pause_turn") {
          // The server-side search loop paused; send the turn back so it picks up where it left off.
          messages.push({ role: "assistant", content: res.content });
          continue;
        }
        if (res.stop_reason === "refusal") throw new Error("The model declined to research this company.");
        // Only the text after the last tool result is the answer; earlier text is narration between searches.
        let lastTool = -1;
        res.content.forEach((b, i) => {
          if (b.type !== "text") lastTool = i;
        });
        return res.content
          .slice(lastTool + 1)
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
      }
      throw new Error("The research took too long. Try again, or paste the job description instead.");
    } catch (e) {
      wrap(e);
    }
  }
}
