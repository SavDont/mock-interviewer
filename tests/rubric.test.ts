import { describe, expect, test } from "bun:test";
import { NOT_ENOUGH, RECRUITER_RUBRIC, renderRubric, type Scores, SYSTEM_DESIGN_RUBRIC, verdictDistance } from "../server/grading/rubric";

const sd = (
  req: number | null,
  est: number | null,
  hld: number | null,
  dd: number | null,
  to: number | null,
  comm: number | null,
): Scores => ({
  "Requirements and scoping": req as never,
  Estimation: est as never,
  "High-level design": hld as never,
  "Deep dives": dd as never,
  "Trade-offs": to as never,
  Communication: comm as never,
});

describe("system design verdict rules", () => {
  const cases: [Scores, string][] = [
    [sd(4, 4, 4, 4, 3, 3), "Strong Yes"],
    [sd(4, 4, 4, 3, 3, 3), "Yes"],
    [sd(2, 3, 3, 3, 3, 3), "Lean Yes"],
    [sd(3, 3, 3, 2, 3, 3), "Lean No"], // a 2 in Deep dives
    [sd(2, 2, 3, 3, 3, 3), "Lean No"],
    [sd(2, 2, 3, 3, 2, 3), "No"],
    [sd(1, 3, 3, 3, 3, 3), "No"],
    [sd(1, 1, 3, 3, 3, 3), "Strong No"],
    [sd(3, 3, 1, 3, 3, 3), "Strong No"], // no workable design
    [sd(3, 3, 3, null, 3, 3), NOT_ENOUGH],
    [sd(null, null, 3, 3, 3, 3), NOT_ENOUGH],
    [sd(null, 3, 3, 3, 3, 3), "Yes"], // one n/a outside the core areas doesn't block a verdict
  ];
  for (const [scores, verdict] of cases) {
    test(`${Object.values(scores).join(",")} -> ${verdict}`, () => expect(SYSTEM_DESIGN_RUBRIC.decide(scores)).toBe(verdict));
  }
});

describe("recruiter verdict rules", () => {
  const r = (pitch: number | null, exp: number | null, rest: number[]): Scores => ({
    Pitch: pitch as never,
    "Experience and impact": exp as never,
    "Motivation and fit": rest[0] as never,
    "Logistics and compensation": rest[1] as never,
    Communication: rest[2] as never,
    "Questions and close": rest[3] as never,
  });
  test("strong advance needs three 4s and nothing below 3", () =>
    expect(RECRUITER_RUBRIC.decide(r(4, 4, [4, 3, 3, 3]))).toBe("Strong advance"));
  test("one 2 outside experience is a concern", () => expect(RECRUITER_RUBRIC.decide(r(3, 3, [2, 3, 3, 3]))).toBe("Advance with concerns"));
  test("a 2 in experience is not advancing", () => expect(RECRUITER_RUBRIC.decide(r(3, 2, [3, 3, 3, 3]))).toBe("Not advancing"));
  test("missing pitch is not enough evidence", () => expect(RECRUITER_RUBRIC.decide(r(null, 3, [3, 3, 3, 3]))).toBe(NOT_ENOUGH));
});

test("the rubric text lists every area with four anchors", () => {
  const text = renderRubric(RECRUITER_RUBRIC);
  expect(text).toContain('Pitch ("tell me about yourself")\n- 1: ');
  expect(text.match(/^- [1-4]: /gm)).toHaveLength(24);
});

test("verdict distance counts steps on the scale", () => {
  expect(verdictDistance(SYSTEM_DESIGN_RUBRIC, "Lean No", "Yes")).toBe(2);
  expect(verdictDistance(SYSTEM_DESIGN_RUBRIC, "Yes", NOT_ENOUGH)).toBeNull();
});
