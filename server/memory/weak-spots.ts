// Memory of weak spots, part 2: which rubric areas keep scoring low across past calls.
// Computed from the saved debriefs; nothing extra is stored.

import { RUBRICS } from "../grading/rubric";
import { parseScores } from "../grading/scores";
import type { Mode } from "../interview/types";

export interface AreaTrend {
  area: string;
  average: number;
  calls: number; // how many debriefs scored this area
  recent: number[]; // scores, oldest first
}

export interface WeakSpots {
  mode: Mode;
  calls: number; // graded calls considered
  areas: AreaTrend[]; // lowest average first
}

/** Debriefs of one interview type, oldest first. Drills are left out: they use a checklist, not the rubric. */
export function weakSpots(mode: Mode, debriefs: string[]): WeakSpots {
  const rubric = RUBRICS[mode];
  const per = new Map<string, number[]>(rubric.areas.map((a) => [a.name, []]));
  let calls = 0;
  for (const md of debriefs) {
    const scores = parseScores(md, rubric);
    if (Object.keys(scores).length === 0) continue;
    calls++;
    for (const [area, s] of Object.entries(scores)) if (typeof s === "number") per.get(area)?.push(s);
  }
  const areas = [...per.entries()]
    .filter(([, xs]) => xs.length > 0)
    .map(([area, xs]) => ({ area, average: xs.reduce((a, b) => a + b, 0) / xs.length, calls: xs.length, recent: xs.slice(-5) }))
    .sort((a, b) => a.average - b.average || b.calls - a.calls);
  return { mode, calls, areas };
}
