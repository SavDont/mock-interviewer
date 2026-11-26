// The interviewer's decision on each check: speak now or stay silent. It is streamed as JSON, and
// PartialDecision reads it while it's still being written so the voice can start early.

import { z } from "zod";

// Field order matters: the reply is streamed, so speak and urgency arrive before the words.
export const Decision = z.object({
  speak: z.boolean().describe("true only if you should say something out loud right now"),
  urgency: z.enum(["low", "normal", "high"]).describe("high = worth interrupting the candidate mid-thought for"),
  say: z.string().describe("What to say aloud if speak is true, otherwise empty"),
  note: z.string().describe("New private note to remember, or empty"),
  end_call: z.boolean().describe("true only on your final goodbye: the call hangs up after you finish saying it"),
});
export type Decision = z.infer<typeof Decision>;

export const SILENT: Decision = { speak: false, urgency: "low", say: "", note: "", end_call: false };

/** Streamed pieces of a decision, sent to the browser as they're generated. */
export type DecisionEvent = { t: "head"; speak: boolean; urgency: Decision["urgency"] } | { t: "say"; text: string };

const ESCAPES: Record<string, string> = { n: "\n", t: " ", r: "", b: "", f: "" };

/**
 * Pulls speak, urgency and the text of "say" out of a JSON object that is still being written.
 * Emits one "head" event once speak and urgency are known, then "say" events with new text.
 */
export class PartialDecision {
  private buf = "";
  private head = false;
  private sent = 0; // characters of "say" already emitted

  push(delta: string, emit: (e: DecisionEvent) => void) {
    this.buf += delta;
    if (!this.head) {
      const speak = /"speak"\s*:\s*(true|false)/.exec(this.buf);
      const urgency = /"urgency"\s*:\s*"(low|normal|high)"/.exec(this.buf);
      if (speak && urgency) {
        this.head = true;
        emit({ t: "head", speak: speak[1] === "true", urgency: urgency[1] as Decision["urgency"] });
      }
    }
    const say = this.sayText();
    if (say.length > this.sent) {
      emit({ t: "say", text: say.slice(this.sent) });
      this.sent = say.length;
    }
  }

  /** The decoded "say" string so far, stopping before an escape sequence that isn't complete yet. */
  private sayText(): string {
    const m = /"say"\s*:\s*"/.exec(this.buf);
    if (!m) return "";
    let out = "";
    for (let i = m.index + m[0].length; i < this.buf.length; i++) {
      const c = this.buf[i] as string;
      if (c === '"') break;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const n = this.buf[i + 1];
      if (n === undefined) break;
      if (n === "u") {
        const hex = this.buf.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 5;
        continue;
      }
      out += ESCAPES[n] ?? n;
      i++;
    }
    return out;
  }
}

/** Parses the finished reply, or returns null if it isn't a valid decision. */
export function parseDecision(text: string): Decision | null {
  try {
    return Decision.parse(JSON.parse(text));
  } catch {
    return null;
  }
}
