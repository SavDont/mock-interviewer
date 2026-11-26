// The grading rubrics, as data. The same definitions render the rubric text the grader reads and
// compute the verdict from scores in code, so the eval harness can check that the grader applies
// its own rules.

export type Score = 1 | 2 | 3 | 4;
/** A score per area: null means "n/a" (not enough evidence), undefined means the row is missing. */
export type Scores = Record<string, Score | null | undefined>;

export interface RubricArea {
  /** The row label in the debrief's Scores table. */
  name: string;
  /** The heading in the rubric text, when it differs from the name. */
  title?: string;
  anchors: readonly [string, string, string, string];
}

export interface Rubric {
  id: "system_design" | "recruiter";
  areas: readonly RubricArea[];
  /** Verdicts from worst to best, not counting "Not enough evidence". */
  scale: readonly string[];
  verdictRules: string;
  /** The verdict the rules give for these scores, before the grader's one-step judgment call. */
  decide(scores: Scores): string;
}

export const NOT_ENOUGH = "Not enough evidence";

function tally(rubric: Pick<Rubric, "areas">, scores: Scores) {
  const given = rubric.areas.map((a) => scores[a.name]).filter((s): s is Score => typeof s === "number");
  return {
    na: rubric.areas.filter((a) => scores[a.name] == null).map((a) => a.name),
    ones: given.filter((s) => s === 1).length,
    twos: given.filter((s) => s === 2).length,
    fours: given.filter((s) => s === 4).length,
    allThreePlus: given.every((s) => s >= 3),
  };
}

export const SYSTEM_DESIGN_RUBRIC: Rubric = {
  id: "system_design",
  areas: [
    {
      name: "Requirements and scoping",
      anchors: [
        "Starts designing with no or wrong requirements; scope never pinned down.",
        "Lists features but misses key non-functional requirements (scale, latency, availability, consistency), or only after prompting.",
        "Clarifies functional and non-functional requirements, states what is out of scope, and commits to targets that later shape the design.",
        "Also spots the requirement that makes this problem hard and frames the whole design around it.",
      ],
    },
    {
      name: "Estimation",
      anchors: [
        "No numbers, or numbers off by orders of magnitude without noticing.",
        "Some numbers, but they are wrong, incomplete, or never used.",
        "Reasonable traffic, storage, and read/write estimates done quickly, and used to justify decisions (caching, sharding, choice of store).",
        "Estimates exactly what matters, catches the non-obvious number (peak vs average, hot keys, growth), and sanity-checks it.",
      ],
    },
    {
      name: "High-level design",
      anchors: [
        "No coherent end-to-end design, or one that can't meet the core requirements.",
        "The main boxes are there, but a path is missing or broken (writes or reads don't work end to end), or there are components with no stated purpose.",
        "Clean end-to-end design that meets the requirements, with a sensible API and data model, in reasonable time.",
        "Also simple and well-justified: nothing extra, and it anticipates where it will need to evolve.",
      ],
    },
    {
      name: "Deep dives",
      anchors: [
        "Can't go below the surface on any component.",
        "Goes deep only when pushed, or the depth has real errors.",
        "Goes deep on the two or three components that matter most for this problem, correctly, covering bottlenecks and failure handling.",
        "Picks the right deep dives unprompted and shows expert-level detail (concrete algorithms, failure scenarios, operational concerns).",
      ],
    },
    {
      name: "Trade-offs",
      anchors: [
        "Presents choices as the only option, or uses technologies as buzzwords.",
        "Names alternatives but can't say why one wins here.",
        "Compares real alternatives against the requirements and estimates, and makes and defends a decision.",
        "Quantifies trade-offs, says when they'd revisit a decision, and changes course well when a flaw is shown.",
      ],
    },
    {
      name: "Communication",
      anchors: [
        "Hard to follow; doesn't respond to questions or hints.",
        "Understandable but disorganized, rambles, or loses track of time; needs to be steered.",
        "Structured and clear, thinks out loud, checks in, uses the whiteboard well, and manages time so the important parts get covered.",
        "Runs the interview like a design review they lead; the interviewer barely needs to steer.",
      ],
    },
  ],
  scale: ["Strong No", "No", "Lean No", "Lean Yes", "Yes", "Strong Yes"],
  verdictRules: `Base the verdict on the scores, then adjust by at most one step for anything the scores miss, and say why.
- Strong Yes: at least four areas scored 4, none below 3.
- Yes: every area scored 3 or higher.
- Lean Yes: at most one 2, and it is not High-level design or Deep dives; everything else 3 or higher.
- Lean No: two areas at 2, or a 2 in High-level design or Deep dives.
- No: three or more areas at 2, or any 1.
- Strong No: more than one area at 1, or no workable design.
- n/a areas don't count for the candidate. If High-level design or Deep dives is n/a, or two or more areas are n/a, give the verdict as "Not enough evidence", with the verdict the existing evidence points to in brackets.`,
  decide(scores) {
    const t = tally(this, scores);
    const core = ["High-level design", "Deep dives"];
    if (core.some((a) => scores[a] == null) || t.na.length >= 2) return NOT_ENOUGH;
    if (t.ones > 1 || scores["High-level design"] === 1) return "Strong No";
    if (t.twos >= 3 || t.ones >= 1) return "No";
    if (t.twos === 2 || core.some((a) => scores[a] === 2)) return "Lean No";
    if (t.twos === 1) return "Lean Yes";
    if (t.fours >= 4 && t.allThreePlus) return "Strong Yes";
    return "Yes";
  },
};

export const RECRUITER_RUBRIC: Rubric = {
  id: "recruiter",
  areas: [
    {
      name: "Pitch",
      title: 'Pitch ("tell me about yourself")',
      anchors: [
        "Rambling or a resume recital with no thread; over three minutes, or so short it says nothing.",
        "Covers the facts but has no clear thread, doesn't land on why this role, or runs long.",
        "A clear 60 to 120 second story: who they are, what they've done that matters for this role, and what they want next.",
        "Also memorable and tailored: one or two specific achievements with impact, and a natural bridge to this company.",
      ],
    },
    {
      name: "Experience and impact",
      anchors: [
        "Can't explain what they personally did, or the experience doesn't fit the role at all.",
        "Describes the team's work more than their own, or has no concrete scope, results or numbers.",
        "Concrete about their own scope and impact (team size, systems owned, measurable results), at the level of the role.",
        "Also makes the level obvious without being asked: ownership, influence beyond their team, and results that hold up to follow-ups.",
      ],
    },
    {
      name: "Motivation and fit",
      anchors: [
        'Negative about their employer, or no reason for wanting this role beyond "a job".',
        'Generic reasons ("growth", "challenging work") that could apply to any company; knows little about the company.',
        "Positive, forward-looking reasons for leaving, and specific reasons for this company and role.",
        "Also connects their goals to what the role offers in a way that is convincing and hard to fake.",
      ],
    },
    {
      name: "Logistics and compensation",
      anchors: [
        "Evasive or contradictory on basics (location, authorization, timeline), or a compensation answer that would likely end the process.",
        "Gets the basics out but handles compensation poorly: anchors low, refuses rudely, names a number far off market without reasoning, or volunteers current pay when it hurts them.",
        "Clear on location, authorization and timeline. Handles compensation professionally: either a researched range for the level, or a polite deferral that stays cooperative and asks for the band. Mentions other processes truthfully when relevant.",
        "Also uses timeline and other processes to their advantage without overplaying it, and leaves room to negotiate.",
      ],
    },
    {
      name: "Communication",
      anchors: [
        "Hard to follow, doesn't answer the question asked, or very hard to have a conversation with.",
        "Understandable but long-winded, too technical for a recruiter, or needs repeated redirection.",
        "Concise, conversational and confident; answers the question asked, then stops.",
        "Also easy rapport and good reading of the recruiter's cues; the call flows.",
      ],
    },
    {
      name: "Questions and close",
      anchors: [
        "No questions, or questions that show no interest in the role.",
        'Only generic questions (benefits, "what\'s the culture like") or questions they could have looked up.',
        "Thoughtful questions about the team, role, interview process or what success looks like, and confirms next steps.",
        "Also uses the questions to learn what the hiring team cares about, and leaves the recruiter wanting to advance them.",
      ],
    },
  ],
  scale: ["Not advancing", "Advance with concerns", "Advance", "Strong advance"],
  verdictRules: `Base the verdict on the scores, then adjust by at most one step for anything the scores miss (a serious red flag counts), and say why.
- Strong advance: at least three areas scored 4, none below 3.
- Advance: every area scored 3 or higher.
- Advance with concerns: at most one 2, and it is not Experience and impact; no 1s.
- Not advancing: two or more 2s, a 2 in Experience and impact, or any 1.
- n/a areas don't count for the candidate. If Pitch or Experience and impact is n/a, or three or more areas are n/a, give the verdict as "Not enough evidence", with the verdict the existing evidence points to in brackets.`,
  decide(scores) {
    const t = tally(this, scores);
    if (scores.Pitch == null || scores["Experience and impact"] == null || t.na.length >= 3) return NOT_ENOUGH;
    if (t.twos >= 2 || t.ones >= 1 || scores["Experience and impact"] === 2) return "Not advancing";
    if (t.twos === 1) return "Advance with concerns";
    if (t.fours >= 3 && t.allThreePlus) return "Strong advance";
    return "Advance";
  },
};

export const RUBRICS = { system_design: SYSTEM_DESIGN_RUBRIC, recruiter: RECRUITER_RUBRIC } as const;

/** The rubric as the grader reads it. */
export function renderRubric(r: Rubric): string {
  return r.areas.map((a) => [a.title ?? a.name, ...a.anchors.map((text, i) => `- ${i + 1}: ${text}`)].join("\n")).join("\n\n");
}

/** How many steps apart two verdicts are on the rubric's scale, or null if either isn't on it. */
export function verdictDistance(r: Rubric, a: string, b: string): number | null {
  const i = r.scale.indexOf(a);
  const j = r.scale.indexOf(b);
  return i < 0 || j < 0 ? null : Math.abs(i - j);
}
