import { expect, test } from "bun:test";
import { SYSTEM_DESIGN_RUBRIC } from "../server/grading/rubric";
import { parseScores, parseVerdict } from "../server/grading/scores";
import { weakSpots } from "../server/memory/weak-spots";

const debrief = (verdict: string, scores: string[]) => `## Verdict
**${verdict}** at senior. Deep dives decided it.

## Scores
| Area | Score | Evidence |
|---|---|---|
| Requirements and scoping | ${scores[0]} | [02:10] asked about read/write ratio |
| **Estimation** | ${scores[1]} | [05:00] 1,200 writes/s |
| High-level design | ${scores[2]} | board: API → Redis → Postgres |
| Deep dives | ${scores[3]} | never probed |
| Trade-offs | ${scores[4]} | [20:00] SQL vs Cassandra |
| Communication | ${scores[5]} | clear |

## What went well
- Fast estimates.
`;

test("reads scores, including n/a and bold labels", () => {
  expect(parseScores(debrief("Lean No", ["3", "**2**", "3/4", "n/a", "3", "4"]), SYSTEM_DESIGN_RUBRIC)).toEqual({
    "Requirements and scoping": 3,
    Estimation: 2,
    "High-level design": 3,
    "Deep dives": null,
    "Trade-offs": 3,
    Communication: 4,
  });
});

test("reads the verdict from the first line of its section", () => {
  expect(parseVerdict(debrief("Strong Yes", ["4", "4", "4", "4", "4", "4"]))).toBe("Strong Yes");
  expect(parseVerdict(debrief("Not enough evidence (Lean No)", ["3", "3", "3", "n/a", "3", "3"]))).toBe("Not enough evidence");
  expect(parseVerdict("## Verdict\nNailed it, covered everything.")).toBe("Nailed it");
  expect(parseVerdict("no sections here")).toBe("");
});

test("weak spots average each area across debriefs, lowest first", () => {
  const w = weakSpots("system_design", [debrief("No", ["2", "2", "3", "1", "3", "3"]), debrief("Lean No", ["3", "2", "3", "2", "3", "3"])]);
  expect(w.calls).toBe(2);
  expect(w.areas[0]).toMatchObject({ area: "Deep dives", average: 1.5, calls: 2 });
  expect(w.areas[1]).toMatchObject({ area: "Estimation", average: 2 });
});
