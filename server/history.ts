// Past calls: the list, one call's transcript and debrief, and removing a call.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { parseVerdict } from "./grading/scores";
import {
  boardPath,
  cachedSession,
  forgetSession,
  getSession,
  isSessionId,
  SESSION_DIR,
  type Session,
  sessionPath,
} from "./interview/session";
import type { Mode } from "./interview/types";
import { type WeakSpots, weakSpots } from "./memory/weak-spots";

export interface CallSummary {
  id: string;
  mode: Mode;
  startedAt: string;
  title: string; // the company (recruiter) or the design problem
  durationSec: number;
  answers: number; // how many times the candidate spoke
  verdict: string;
  hasFeedback: boolean;
  costUsd: number;
}

/** "[12:34] ..." -> seconds */
function stampSec(line: string): number {
  const m = /^\[(\d+):(\d+)\]/.exec(line);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** A short name for the call: the drill, the company, or the design problem from the opening line. */
export function titleOf(s: Pick<Session, "drill" | "mode" | "recruiter" | "log">): string {
  if (s.drill) return `Drill: ${s.drill.title}`;
  if (s.mode === "recruiter") {
    const c = (s.recruiter?.company ?? "").trim();
    if (!c) return "Recruiter screen";
    if (!c.includes(".")) return c;
    try {
      return new URL(/^https?:/.test(c) ? c : `https://${c}`).hostname.replace(/^www\./, "");
    } catch {
      return c;
    }
  }
  const opener = s.log.find((l) => l.includes("Interviewer:")) ?? "";
  const m = /\bdesign (?:an? |the )([^.,?!;]+?)(?:\s+(?:that|which|like|for|with|handling|where|to|so)\b|[.,?!;]|$)/i.exec(opener);
  return m ? `Design ${(m[1] as string).trim()}` : "System design";
}

function summarize(s: Session, fileTime: Date): CallSummary {
  const last = [...s.log].reverse().find((l) => /^\[\d+:\d+\]/.test(l)) ?? "";
  return {
    id: s.id,
    mode: s.mode ?? "system_design",
    startedAt: s.startedAt ?? fileTime.toISOString(),
    title: titleOf(s),
    durationSec: stampSec(last),
    answers: s.log.filter((l) => /\] Candidate: /.test(l)).length,
    verdict: s.verdict ?? (s.feedback ? parseVerdict(s.feedback) : ""),
    hasFeedback: !!s.feedback,
    costUsd: s.costUsd,
  };
}

function allSessions(): { s: Session; time: Date }[] {
  if (!existsSync(SESSION_DIR)) return [];
  const out: { s: Session; time: Date }[] = [];
  for (const f of readdirSync(SESSION_DIR)) {
    if (!f.endsWith(".json")) continue;
    const path = `${SESSION_DIR}/${f}`;
    try {
      const s = cachedSession(f.slice(0, -5)) ?? (JSON.parse(readFileSync(path, "utf8")) as Session);
      out.push({ s, time: statSync(path).birthtime });
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

/** Every saved call where the candidate said something, newest first. */
export function listCalls(): CallSummary[] {
  return allSessions()
    .map(({ s, time }) => summarize(s, time))
    .filter((c) => c.answers > 0)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Rubric areas that keep scoring low, per interview type, from the saved debriefs. */
export function recurringWeakSpots(): WeakSpots[] {
  const calls = allSessions()
    .filter(({ s }) => s.feedback && !s.drill)
    .sort((a, b) => (a.s.startedAt ?? "").localeCompare(b.s.startedAt ?? ""));
  return (["system_design", "recruiter"] as const)
    .map((mode) =>
      weakSpots(
        mode,
        calls.filter(({ s }) => (s.mode ?? "system_design") === mode).map(({ s }) => s.feedback as string),
      ),
    )
    .filter((w) => w.calls > 0);
}

/** One saved call with its transcript and debrief. */
export function getCall(id: string) {
  const s = getSession(id);
  if (!s) return undefined;
  return {
    ...summarize(s, statSync(sessionPath(s.id)).birthtime),
    log: s.log,
    notes: s.notes,
    feedback: s.feedback ?? "",
    hasBoard: existsSync(boardPath(s.id)),
    drill: s.drill ? { from: s.drill.from, title: s.drill.title, why: s.drill.why } : undefined,
  };
}

/** Moves a call into .sessions/deleted/ (kept on disk, just out of the list). */
export function removeCall(id: string): boolean {
  if (!isSessionId(id) || !existsSync(sessionPath(id))) return false;
  mkdirSync(`${SESSION_DIR}/deleted`, { recursive: true });
  renameSync(sessionPath(id), `${SESSION_DIR}/deleted/${id}.json`);
  if (existsSync(boardPath(id))) renameSync(boardPath(id), `${SESSION_DIR}/deleted/${id}.board.png`);
  forgetSession(id);
  return true;
}
