// Shared types for an interview session.

/** Which kind of interview this is. */
export type Mode = "system_design" | "recruiter";

/** How hard the interviewer challenges, and whether it cuts in mid-thought. */
export type Pushback = "gentle" | "realistic" | "tough";

/** How a recruiter screen came about, and what's known about the company and role. */
export interface RecruiterContext {
  source: "outreach" | "applied" | "";
  company: string; // as the candidate typed it: a name or website
  role: string; // outreach: the role they said they want. applied: the posting link or text
  brief: string; // researched company and role brief (server/research.ts), or empty
}

export const EMPTY_RECRUITER: RecruiterContext = { source: "", company: "", role: "", brief: "" };
