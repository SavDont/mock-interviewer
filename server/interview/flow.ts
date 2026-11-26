// The interview flow on the server. The browser decides *when* to check in (see src/loop.ts); each
// check sends what happened since the last one, and the model decides whether to speak.
//
// The conversation is append-only so it stays prompt-cached: each check is committed as a user turn
// (the observations) plus an assistant turn (what was said, or "(stayed silent)"), and only the
// small block at the end of each request is new.

import { config } from "../config";
import { getProvider } from "../llm";
import type { DrillPlan } from "../memory/drills";
import { drillBlock } from "../memory/drills";
import { Decision, type DecisionEvent, PartialDecision, parseDecision, SILENT } from "./decision";
import { buildRecruiterSystemPrompt } from "./prompts-recruiter";
import { buildSystemPrompt } from "./prompts-system-design";
import { type Session, saveBoard, saveSession } from "./session";
import { EMPTY_RECRUITER, type Mode, type Pushback, type RecruiterContext } from "./types";

export interface TickInput {
  trigger: string; // why the browser is checking in, e.g. "candidate_paused_speaking"
  events: string[]; // new observations since the previous check, already timestamped
  scene: string; // the whole whiteboard as text
  image?: string; // optional base64 PNG of the whiteboard
  timing: string; // a human-readable timing line
}

export interface TickResult extends Decision {
  costUsd: number;
}

export interface NewSession {
  persona: string;
  pushback: Pushback;
  mode: Mode;
  background?: string;
  recruiter?: RecruiterContext;
  drill?: DrillPlan & { from: string };
  fast?: boolean;
}

export function createSession(o: NewSession): Session {
  const recruiter = o.recruiter ?? EMPTY_RECRUITER;
  const background = o.background ?? "";
  const base =
    o.mode === "recruiter"
      ? buildRecruiterSystemPrompt(o.persona, o.pushback, background, recruiter)
      : buildSystemPrompt(o.persona, o.pushback);
  const s: Session = {
    id: crypto.randomUUID(),
    mode: o.mode,
    persona: o.persona,
    background,
    recruiter,
    system: o.drill ? `${base}\n\n${drillBlock(o.drill)}` : base,
    drill: o.drill,
    fast: o.fast ?? config.fastDefault,
    history: [],
    pending: [],
    notes: [],
    log: [],
    lastScene: "",
    costUsd: 0,
    startedAt: new Date().toISOString(),
  };
  saveSession(s);
  return s;
}

const observations = (pending: string[]) =>
  `<observations_since_last_check>\n${pending.length ? pending.join("\n") : "(nothing new)"}\n</observations_since_last_check>`;

/** Private notes live in the interviewer's own turns, so they're cached with the conversation. */
function withNote(said: string, note: string): string {
  return note.trim() ? `${said}\n[private note: ${note.trim()}]` : said;
}

/** One check: should the interviewer speak now? Streams the reply's pieces through onEvent. */
export async function tick(s: Session, input: TickInput, onEvent: (e: DecisionEvent) => void = () => {}): Promise<TickResult> {
  s.pending.push(...input.events);
  s.log.push(...input.events);
  s.lastScene = input.scene;
  // The whiteboard goes into the conversation only when it changes.
  const board = input.scene || "(empty)";
  const boardChanged = s.mode !== "recruiter" && board !== s.boardSent;
  if (boardChanged) {
    s.pending.push(`<whiteboard_now>\n${board}\n</whiteboard_now>`);
    s.boardSent = board;
  }
  if (input.image) saveBoard(s.id, input.image);

  // Only this last turn is new on each check, so it stays small.
  const latest = [
    observations(s.pending),
    ...(s.mode === "recruiter" || boardChanged ? [] : ["The whiteboard is unchanged since the last <whiteboard_now> above."]),
    `<timing>${input.timing}</timing>`,
    `<trigger>${input.trigger}</trigger>`,
    "Decide: speak now, or stay silent?",
  ].join("\n\n");

  const t0 = Date.now();
  const partial = new PartialDecision();
  const provider = getProvider();
  const res = await provider.streamJSON(
    {
      system: s.system,
      messages: [...s.history, { role: "user", content: latest, image: input.image }],
      cacheThrough: s.history.length - 1,
      effort: config.tickEffort,
      maxTokens: 4000,
      fast: s.fast,
    },
    // Field order in the schema puts speak and urgency first, so the browser knows early whether to speak.
    Decision,
    "decision",
    (delta) => partial.push(delta, onEvent),
  );
  s.costUsd += res.usage.costUsd;

  const d = res.refused ? null : parseDecision(res.text);
  if (!d) {
    console.warn(`[tick] no usable decision${res.refused ? " (refused)" : ""}`);
    saveSession(s);
    return { ...SILENT, costUsd: s.costUsd };
  }
  if (!d.speak) {
    // Commit the silent check now, so the next one reuses it from the cache.
    s.history.push({ role: "user", content: observations(s.pending) }, { role: "assistant", content: withNote("(stayed silent)", d.note) });
    s.pending = [];
  }
  s.lastNote = d.speak ? d.note.trim() : "";
  if (d.note.trim()) {
    s.notes.push(d.note.trim());
    if (s.notes.length > 40) s.notes.splice(0, s.notes.length - 40);
  }
  if (config.debug) {
    const u = res.usage;
    console.log(
      `[tick ${input.trigger}] ${((Date.now() - t0) / 1000).toFixed(1)}s speak=${d.speak} in=${u.input} cached=${u.cachedInput} out=${u.output} $${s.costUsd.toFixed(3)}${d.speak ? ` -> "${d.say}"` : ""}`,
    );
  }
  saveSession(s);
  return { ...d, costUsd: s.costUsd };
}

/** Called once the browser has actually voiced a reply (possibly cut off by the candidate). */
export function commit(s: Session, said: string, interrupted: boolean, at: string) {
  s.history.push(
    { role: "user", content: observations(s.pending) },
    { role: "assistant", content: withNote(interrupted ? `${said} [candidate interrupted me here]` : said, s.lastNote ?? "") },
  );
  s.pending = [];
  s.lastNote = "";
  s.log.push(`[${at}] Interviewer: "${said}"${interrupted ? " (interrupted)" : ""}`);
  saveSession(s);
}
