// Before a recruiter screen: research the company (and the job posting, if there is one) on the web
// and write a short brief for the recruiter to work from, so it can talk like it works there.

import { getProvider } from "./llm";

export interface BriefRequest {
  source: "outreach" | "applied"; // a recruiter reached out, or the candidate applied to a posting
  company: string; // name or website
  role: string; // outreach: the kind of role the candidate said they want. applied: posting URL or pasted text
}

const SYSTEM = `You prepare briefs for a mock interview tool. Someone will role-play a recruiter at the company below in a practice phone screen, and needs to sound like they actually work there.

Research with web search and web fetch, then write the brief. Keep it under about 450 words, in plain text with short headings:
- Company: what it does, products, size and stage, business model, anything notable recently (funding, launches, layoffs, reorgs), engineering culture or values they publicize.
- The role: title, level, team or org, what the person would do, must-have and nice-to-have qualifications, location and remote policy, and the compensation range if it is published. For a recruiter reaching out, describe the kind of role that fits what the candidate asked for at this company, and say which real openings look closest, if you find any.
- Interview process: the stages that usually follow a recruiter screen here, if known.
- What this recruiter will screen for: the three to five things that would make them advance or reject someone for this role.

Only state what your sources support. If something isn't findable, say "unknown" rather than guessing. Don't include citations or URLs in the brief.

Your final message is pasted straight into the recruiter's notes, so it must be only the brief: start with the company name as a heading, with no preamble and no remarks about your research process.`;

function userMessage(r: BriefRequest): string {
  const company = `Company: ${r.company.trim()}`;
  if (r.source === "outreach") {
    return `${company}\n\nSituation: a recruiter from this company reached out to the candidate in their direct messages, asking to chat. The candidate told them the kind of role they have in mind:\n${r.role.trim() || "(not specified; assume a role matching the candidate's background)"}`;
  }
  const role = r.role.trim();
  const isUrl = /^https?:\/\/\S+$/.test(role);
  return `${company}\n\nSituation: the candidate applied to a specific job posting, and this is the recruiter screen for it.\n${
    isUrl ? `Job posting link: ${role}` : `Job posting text:\n<posting>\n${role}\n</posting>`
  }`;
}

/** Returns the brief as plain text. Takes a while (it searches and reads pages): 15 to 60 seconds. */
export async function writeBrief(r: BriefRequest): Promise<string> {
  const provider = getProvider();
  if (!provider.research) throw new Error("Company research needs a provider with web search. Paste the job description instead.");
  const text = await provider.research(SYSTEM, userMessage(r));
  if (!text) throw new Error("The research came back empty.");
  return text;
}
