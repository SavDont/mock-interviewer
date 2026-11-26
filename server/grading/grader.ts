// Writes the debrief for a finished call, grading it against the rubric for its interview type.

import { config } from "../config";
import { type Session, saveBoard, saveSession } from "../interview/session";
import { EMPTY_RECRUITER } from "../interview/types";
import { getProvider, type ModelProvider } from "../llm";
import { buildDrillFeedbackPrompt, buildFeedbackPrompt, buildRecruiterFeedbackPrompt } from "./prompts";
import { RUBRICS, type Rubric } from "./rubric";
import { parseScores, parseVerdict } from "./scores";

/** Everything the grader reads about one call. */
export interface GradingInput {
  mode: "system_design" | "recruiter";
  persona: string;
  log: string[];
  notes: string[];
  scene?: string; // the final whiteboard as text (system design)
  image?: string; // base64 PNG of the final whiteboard
  background?: string;
  recruiter?: Session["recruiter"];
  drill?: Session["drill"];
}

export function graderSystemPrompt(g: GradingInput): string {
  if (g.drill) return buildDrillFeedbackPrompt(g.persona, g.drill);
  if (g.mode === "recruiter") return buildRecruiterFeedbackPrompt(g.persona, g.background ?? "", g.recruiter ?? EMPTY_RECRUITER);
  return buildFeedbackPrompt(g.persona);
}

export function graderUserMessage(g: GradingInput): string {
  const board = g.mode === "recruiter" ? "" : `<final_whiteboard>\n${g.scene || "(empty)"}\n</final_whiteboard>\n\n`;
  return `<interview_log>\n${g.log.join("\n")}\n</interview_log>\n\n${board}<interviewer_private_notes>\n${g.notes.map((n) => `- ${n}`).join("\n")}\n</interviewer_private_notes>\n\nWrite the debrief now.`;
}

export interface Graded {
  text: string;
  verdict: string;
  /** Scores parsed from the debrief's table (not for drills, which use a checklist). */
  scores?: ReturnType<typeof parseScores>;
  rubric?: Rubric;
  costUsd: number;
  refused: boolean;
}

/** Grades one call. Used by the app after a call, and by the eval harness on canned transcripts. */
export async function grade(
  g: GradingInput,
  opts: { provider?: ModelProvider; onText?: (t: string) => void; signal?: AbortSignal } = {},
): Promise<Graded> {
  const provider = opts.provider ?? getProvider();
  const res = await provider.streamText(
    {
      system: graderSystemPrompt(g),
      messages: [{ role: "user", content: graderUserMessage(g), image: g.image }],
      effort: config.feedbackEffort,
      maxTokens: 16000,
      signal: opts.signal,
    },
    opts.onText,
  );
  const rubric = g.drill ? undefined : RUBRICS[g.mode];
  return {
    text: res.text,
    verdict: parseVerdict(res.text),
    scores: rubric ? parseScores(res.text, rubric) : undefined,
    rubric,
    costUsd: res.usage.costUsd,
    refused: res.refused,
  };
}

/** Writes and saves the debrief for a session, streaming it through onText. */
export async function writeDebrief(
  s: Session,
  scene: string,
  image: string | undefined,
  onText: (t: string) => void,
  signal?: AbortSignal,
) {
  if (image) saveBoard(s.id, image);
  const g = await grade(
    {
      mode: s.mode ?? "system_design",
      persona: s.persona,
      log: s.log,
      notes: s.notes,
      scene: scene || s.lastScene,
      image,
      background: s.background,
      recruiter: s.recruiter,
      drill: s.drill,
    },
    { onText, signal },
  );
  s.costUsd += g.costUsd;
  if (g.text.trim() && !g.refused) {
    s.feedback = g.text;
    s.verdict = g.verdict;
  }
  saveSession(s);
  if (g.refused) onText("\n\n_(The model declined to write feedback for this session.)_");
}
