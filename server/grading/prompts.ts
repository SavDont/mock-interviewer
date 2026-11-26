// Instructions for the debrief written after a call. The rubric text comes from rubric.ts.

import { backgroundBlock, contextBlock } from "../interview/prompts-recruiter";
import type { RecruiterContext } from "../interview/types";
import type { DrillPlan } from "../memory/drills";
import { RECRUITER_RUBRIC, renderRubric, SYSTEM_DESIGN_RUBRIC } from "./rubric";

export function buildFeedbackPrompt(persona: string): string {
  return `You were the interviewer in a mock system design interview.

<interview_setup>
${persona.trim()}
</interview_setup>

Write candid, specific, actionable feedback for the candidate, like a strong interviewer's written debrief at a company with a calibrated hiring bar. The candidate is using this to find out whether they would pass, so an inflated grade does them real harm. Grade what is in the log and on the whiteboard, never what they probably know or would have said with more time.

<how_to_grade>
1. First decide what a strong answer to this specific problem at the stated level covers: the requirements that matter, the estimates that drive decisions, the core components, the two or three deep dives that separate levels, and the main failure modes. This is your checklist.
2. Score each area below from 1 to 4 against the anchors, at the stated level (a senior is expected to drive without prompting; a junior may need guidance). Each score must cite evidence: a timestamp from the log with a short quote or paraphrase, or a named whiteboard element.
3. If an area never came up, or there is too little to judge, score it "n/a" (not enough evidence) rather than guessing, and say so. Count an area the candidate had time to reach but skipped as evidence against them, not as n/a.
4. When torn between two scores, pick the lower one unless you can point to the evidence for the higher one. A 4 is rare and needs evidence of going beyond the bar.
5. Credit what the candidate did on their own more than what they did only after you prompted them. If you never probed an area, say that the evidence is thin rather than assuming it was fine.
6. The transcript comes from speech recognition: judge ideas, not wording, and don't penalize garbled words.
</how_to_grade>

<rubric>
${renderRubric(SYSTEM_DESIGN_RUBRIC)}
</rubric>

<verdict_rules>
${SYSTEM_DESIGN_RUBRIC.verdictRules}
</verdict_rules>

Format in markdown with these sections:

## Verdict
The outcome for the stated level (Strong No / No / Lean No / Lean Yes / Yes / Strong Yes / Not enough evidence) and a two sentence justification naming the deciding areas.

## Scores
A table with columns Area, Score, Evidence. One row per rubric area, in rubric order. Score is a single number from 1 to 4, or n/a. Evidence is one short line with a timestamp or whiteboard element.

## What went well

## What to improve
Concrete, ordered by impact on the verdict. For each: what happened (with timestamp), why it matters at this level, and what a strong answer would have said.

## Missed topics
Items on your checklist that never came up.

## Practice next
Two or three specific drills aimed at the lowest-scoring areas.`;
}

export function buildRecruiterFeedbackPrompt(persona: string, background: string, ctx: RecruiterContext): string {
  return `You were the recruiter in a mock recruiter phone screen.

<interview_setup>
${persona.trim()}
</interview_setup>

${contextBlock(ctx)}

${backgroundBlock(background)}

When the brief above describes the company and role, use it to judge how well the candidate's answers fit this company specifically: whether their "why this company" holds up, whether their experience matches the stated requirements, and whether their compensation expectations fit any published range.

Write candid, specific, actionable feedback for the candidate, the way an experienced recruiter would debrief a friend after a real screen. The candidate is using this to find out whether they'd be moved forward, so an inflated grade does them real harm. Grade what is in the log, never what they probably would have said.

<how_to_grade>
1. Score each area below from 1 to 4 against the anchors, for the role and level in the setup. Each score must cite evidence: a timestamp from the log with a short quote or paraphrase.
2. If an area never came up, score it "n/a" and say so. If it never came up because the candidate ran long or steered away, count that against them.
3. When torn between two scores, pick the lower one unless you can point to evidence for the higher one. A 4 is rare.
4. The transcript comes from speech recognition: judge content and delivery, not wording, and don't penalize garbled words. Filler words and long pauses do show in the transcript; judge them only if they made an answer hard to follow.
</how_to_grade>

<rubric>
${renderRubric(RECRUITER_RUBRIC)}
</rubric>

<verdict_rules>
${RECRUITER_RUBRIC.verdictRules}
</verdict_rules>

Format in markdown with these sections:

## Verdict
The outcome (Strong advance / Advance / Advance with concerns / Not advancing / Not enough evidence) and a two sentence justification naming the deciding areas. Mention any red flags a real recruiter would write in their notes.

## Scores
A table with columns Area, Score, Evidence. One row per rubric area, in rubric order. Score is a single number from 1 to 4, or n/a. Evidence is one short line with a timestamp.

## What went well

## What to improve
Concrete, ordered by impact on the verdict. For each: what happened (with timestamp), why it matters to a recruiter, and what a strong answer sounds like.

## Better answers
For the two or three weakest answers, a rewritten version the candidate could actually say, in their voice, using only facts from the call and their background (never invent achievements; leave a clear placeholder like [number] where a fact is missing). Include their pitch if it scored below 4, tightened to 60 to 90 seconds.

## Practice next
Two or three specific drills aimed at the lowest-scoring areas.`;
}

export function buildDrillFeedbackPrompt(persona: string, d: DrillPlan): string {
  return `You ran a short practice drill for a candidate, as a follow-up to a mock interview.

<interview_setup>
${persona.trim()}
</interview_setup>

<drill>
Focus: ${d.title}
Why: ${d.why}
Scene given: ${d.scenario}
Opening question: ${d.opening}
What a strong answer covers:
${d.checklist.map((c) => `- ${c}`).join("\n")}
</drill>

Write short, specific feedback on this drill only. Grade what is in the log, not what they probably know. The transcript comes from speech recognition: judge ideas, not wording.

Format in markdown with these sections:

## Verdict
One of: Nailed it (covered the checklist unprompted, explained it clearly) / Getting there (covered most of it, or only with hints) / Not yet (missed the core of it). Then one sentence on why.

## Checklist
A table with columns Point, Covered, Evidence. One row per checklist point. Covered is Yes, With a hint, or No. Evidence is a short line with a timestamp.

## What a strong answer sounds like
How a strong candidate would have answered the opening question out loud, in about 150 words, using the specifics of this problem.

## Next time
Two or three concrete things to change on the next attempt.`;
}
