// Memory of weak spots, part 1: targeted drills. After a call, the debrief's weak spots become up to
// three short drills (cached with the call). A drill session reuses the original call's setup
// (problem, resume, company) plus a <drill_mode> block that keeps the interviewer on one topic.

import { z } from "zod";
import { type Session, saveSession } from "../interview/session";
import { getProvider } from "../llm";

export const DrillPlan = z.object({
  title: z.string().describe("Short name for the drill, 2 to 6 words, e.g. 'Leases and idempotent results'"),
  why: z.string().describe("One sentence, addressed to the candidate, on what went wrong in the call, with a timestamp"),
  minutes: z.number().int().describe("Length of the drill, 8 to 12 minutes"),
  scenario: z
    .string()
    .describe(
      "What the interviewer says to set the scene: the problem and the parts of the design to take as already decided, so the drill starts right at the weak spot. Two to four spoken sentences.",
    ),
  opening: z.string().describe("The first question the interviewer asks, spoken"),
  checklist: z.array(z.string()).describe("Three to six points a strong answer covers, used to grade the drill"),
  probes: z.array(z.string()).describe("Three to six follow-ups that escalate, from basic to hard"),
});
export type DrillPlan = z.infer<typeof DrillPlan>;

const Plans = z.object({ drills: z.array(DrillPlan) });

const SYSTEM = `You design short practice drills for a candidate who just finished a mock interview. You get the interview setup and the written debrief.

Propose up to three drills, most important first. Each targets one specific weakness the debrief identified (prefer the areas that decided the verdict), and is a focused 8 to 12 minute spoken exercise: the interviewer sets the scene so the candidate starts right at the weak spot, asks an opening question, then escalates with follow-ups.

- Base everything on the original problem and what actually happened in the call; don't invent a new problem.
- The scenario gives the candidate the parts of the design that aren't being drilled, so no time goes on re-doing requirements or the overall design.
- Choose drills that can be practiced by talking (and drawing, in a system design interview). A pacing or time-management weakness becomes a timed drill on the part that took too long, such as "requirements and a first diagram in eight minutes".
- For a recruiter screen, drills are answers to practice out loud: the pitch, a hard question they fumbled, the compensation conversation, a gap or exit to explain.
- Write the scenario, opening and probes as the interviewer would say them aloud: plain sentences, no lists or symbols.`;

export async function planDrills(persona: string, mode: string, feedback: string): Promise<DrillPlan[]> {
  const res = await getProvider().streamJSON(
    {
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Interview type: ${mode === "recruiter" ? "recruiter phone screen" : "system design interview"}\n\n<interview_setup>\n${persona.trim()}\n</interview_setup>\n\n<debrief>\n${feedback.trim()}\n</debrief>`,
        },
      ],
      effort: "medium",
      maxTokens: 8000,
    },
    Plans,
    "drill_plans",
  );
  let parsed: z.infer<typeof Plans> | null = null;
  try {
    parsed = res.refused ? null : Plans.parse(JSON.parse(res.text));
  } catch {
    // reported below
  }
  if (!parsed) throw new Error("Couldn't plan drills from this debrief.");
  return parsed.drills.slice(0, 3).map((d) => ({ ...d, minutes: Math.min(15, Math.max(5, d.minutes)) }));
}

/** Up to three drills on the weak spots in a call's debrief (planned once, then cached). */
export async function drillsFor(s: Session): Promise<DrillPlan[]> {
  if (!s.feedback) throw new Error("This call has no debrief yet. Write the debrief first.");
  if (!s.drillPlans?.length) {
    s.drillPlans = await planDrills(s.persona, s.mode ?? "system_design", s.feedback);
    saveSession(s);
  }
  return s.drillPlans;
}

/** The setup for a drill session: the original call's setup plus the drill's focus. */
export function drillSetup(from: Session, index: number) {
  const plan = from.drillPlans?.[index];
  if (!plan) throw new Error("unknown drill");
  return {
    persona: from.persona,
    mode: from.mode ?? "system_design",
    background: from.background ?? "",
    recruiter: from.recruiter,
    drill: { ...plan, from: from.id },
  };
}

/** Appended to the interviewer's system prompt for a drill session. */
export function drillBlock(d: DrillPlan): string {
  return `<drill_mode>
This session is a focused ${d.minutes}-minute drill, not a full interview. Where the instructions above conflict with this, follow this.

Focus: ${d.title}

Open by setting the scene and asking the opening question, nearly word for word, with no introduction of yourself and no agenda:
Scene: ${d.scenario}
Opening question: ${d.opening}

Then stay on the focus. Don't gather requirements, don't cover other areas, and pull the candidate back if they drift. When an answer is good, raise the stakes with the next follow-up instead of moving on. When they're stuck, give one narrowing hint the way a real interviewer would, then ask again; if still stuck, move to an easier follow-up.
Follow-ups, roughly in order:
${d.probes.map((p) => `- ${p}`).join("\n")}

What a strong answer covers (for you; don't read it out):
${d.checklist.map((c) => `- ${c}`).join("\n")}

When they've covered the checklist or the time is up, close in a sentence and say goodbye with end_call set.
</drill_mode>`;
}
