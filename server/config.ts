// Settings read from the environment (.env). API keys are handled in llm/index.ts.

import type { Effort } from "./llm";

function effort(name: string, fallback: Effort): Effort {
  const v = process.env[name];
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

export const config = {
  port: Number(process.env.API_PORT || 8787),
  whisperUrl: `http://127.0.0.1:${process.env.WHISPER_PORT || "8178"}`,
  /** Thinking depth for the frequent "should I speak?" checks. Low keeps replies quick. */
  tickEffort: effort("INTERVIEWER_EFFORT", "low"),
  /** Thinking depth for the debrief after a call. */
  feedbackEffort: effort("FEEDBACK_EFFORT", "high"),
  /** Fast mode, where the provider has one. On unless INTERVIEWER_FAST=0. */
  fastDefault: process.env.INTERVIEWER_FAST !== "0",
  /** Log each check's timing, tokens and reply. Off by default: replies are interview content. */
  debug: process.env.DEBUG === "1",
};
