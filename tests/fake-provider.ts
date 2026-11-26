// A scripted model provider for tests: replies with canned text, streamed in small pieces.
import type { ModelProvider, ModelRequest, ModelResult } from "../server/llm";

export class FakeProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  readonly model = "fake";
  readonly capabilities = { fast: false, webResearch: false };
  requests: ModelRequest[] = [];
  constructor(private replies: string[]) {}

  async check() {
    return null;
  }
  async streamText(req: ModelRequest, onText?: (d: string) => void): Promise<ModelResult> {
    this.requests.push(req);
    const text = this.replies.shift() ?? "";
    for (let i = 0; i < text.length; i += 7) onText?.(text.slice(i, i + 7));
    return { text, refused: false, usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 5, costUsd: 0.01 } };
  }
  streamJSON(req: ModelRequest, _schema: unknown, _name: string, onText?: (d: string) => void) {
    return this.streamText(req, onText);
  }
}
