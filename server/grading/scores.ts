// Reads the scores and verdict back out of a debrief written in markdown.

import { NOT_ENOUGH, type Rubric, type Score, type Scores } from "./rubric";

/** Every verdict any debrief can give, longest first so "Strong Yes" wins over "Yes". */
const ALL_VERDICTS = [
  "Advance with concerns",
  NOT_ENOUGH,
  "Strong advance",
  "Not advancing",
  "Getting there",
  "Strong Yes",
  "Nailed it",
  "Strong No",
  "Lean Yes",
  "Lean No",
  "Not yet",
  "Advance",
  "Yes",
  "No",
];

function section(markdown: string, heading: string): string {
  const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im");
  return re.exec(markdown)?.[1]?.trim() ?? "";
}

/** The outcome named on the first line of the Verdict section, e.g. "Lean Yes". Empty if none. */
export function parseVerdict(markdown: string): string {
  const first = section(markdown, "Verdict").split("\n")[0] ?? "";
  for (const v of ALL_VERDICTS) if (new RegExp(`\\b${v}\\b`, "i").test(first)) return v;
  return "";
}

const clean = (cell: string) => cell.replace(/[*_`]/g, "").trim();

/** Scores from the Scores table: a number 1 to 4, null for "n/a", missing areas left out. */
export function parseScores(markdown: string, rubric: Rubric): Scores {
  const out: Scores = {};
  for (const line of section(markdown, "Scores").split("\n")) {
    const cells = line.split("|").map(clean);
    if (cells.length < 4) continue; // "| a | b | c |" splits into 5 cells with empty ends
    const [area = "", score = ""] = cells.slice(1);
    const match = rubric.areas.find((a) => area.toLowerCase().startsWith(a.name.toLowerCase()));
    if (!match) continue;
    const n = /^([1-4])\b/.exec(score)?.[1];
    if (n) out[match.name] = Number(n) as Score;
    else if (/^n\/?a\b/i.test(score)) out[match.name] = null;
  }
  return out;
}
