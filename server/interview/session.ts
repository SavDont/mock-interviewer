// A session is one call: its setup, the conversation so far, and the debrief. Sessions are saved as
// JSON in .sessions/ (git-ignored) so a server restart doesn't lose a call in progress, and so past
// calls can be reviewed later. Nothing here leaves the machine.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ChatTurn } from "../llm";
import type { DrillPlan } from "../memory/drills";
import type { Mode, RecruiterContext } from "./types";

export interface Session {
  id: string;
  mode?: Mode; // missing on sessions saved before recruiter screens existed: system design
  persona: string;
  background?: string; // the candidate's resume or summary (recruiter screens)
  recruiter?: RecruiterContext;
  system: string;
  history: ChatTurn[]; // committed turns: observations, and what the interviewer actually said
  pending: string[]; // observations since the interviewer last spoke
  notes: string[];
  log: string[]; // full timestamped record, for the debrief
  lastScene: string;
  costUsd: number;
  startedAt?: string; // ISO time
  feedback?: string; // the debrief, once written
  verdict?: string; // the debrief's outcome line, for the past-calls list
  drill?: DrillPlan & { from: string }; // set when this session is a drill on another call's weak spot
  drillPlans?: DrillPlan[]; // drills proposed from this call's debrief (cached)
  boardSent?: string; // the whiteboard as last added to the conversation
  fast?: boolean; // the provider's low-latency mode for this call
  lastNote?: string; // the note from the reply being spoken, recorded when it's committed
}

export const SESSION_DIR = process.env.SESSIONS_DIR || ".sessions";
const ID = /^[0-9a-f-]{36}$/;

const cache = new Map<string, Session>();

export const sessionPath = (id: string) => `${SESSION_DIR}/${id}.json`;
/** The latest whiteboard image, kept next to the session so past calls can show it. */
export const boardPath = (id: string) => `${SESSION_DIR}/${id}.board.png`;

export function isSessionId(id: string): boolean {
  return ID.test(id);
}

export function saveSession(s: Session) {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(sessionPath(s.id), JSON.stringify(s));
    cache.set(s.id, s);
  } catch (e) {
    console.warn(`couldn't save session: ${(e as Error).message}`);
  }
}

export function saveBoard(id: string, base64png: string) {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(boardPath(id), Buffer.from(base64png, "base64"));
  } catch (e) {
    console.warn(`couldn't save the whiteboard: ${(e as Error).message}`);
  }
}

export function getSession(id: string): Session | undefined {
  const hit = cache.get(id);
  if (hit) return hit;
  if (!isSessionId(id) || !existsSync(sessionPath(id))) return undefined;
  try {
    const s = JSON.parse(readFileSync(sessionPath(id), "utf8")) as Session;
    cache.set(id, s);
    return s;
  } catch {
    return undefined;
  }
}

export function forgetSession(id: string) {
  cache.delete(id);
}

export function cachedSession(id: string): Session | undefined {
  return cache.get(id);
}
