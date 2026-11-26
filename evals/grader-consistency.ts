// Grader eval: runs canned interviews through the real grader several times and checks that it is
// consistent with itself and with the rubric.
//
//   bun run eval                  # 3 fixtures x 3 runs, with the configured provider
//   bun run eval --runs 5 --only mixed
//
// Each run is a real API call at the debrief's effort level, so this costs money (roughly $0.10 to
// $0.40 per run on Claude Opus 5.5; the total is printed at the end). It is not part of CI.
//
// Checks, per fixture:
//   complete   every rubric area got a score (or n/a) in every run
//   rules      the verdict is within one step of what the rubric's rules give for the scores
//              (the rules allow one step of judgment)
//   stable     each area's score varies by at most 1 across runs, and the verdict by at most 1 step
//   calibrated the verdict is one the fixture expects
// And across fixtures:
//   ordered    average total score: strong > mixed > weak

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { type GradingInput, grade } from "../server/grading/grader";
import { NOT_ENOUGH, type Scores, SYSTEM_DESIGN_RUBRIC, verdictDistance } from "../server/grading/rubric";
import { DEFAULT_PERSONA } from "../server/interview/prompts-system-design";
import { getProvider } from "../server/llm";

interface Fixture {
  name: string;
  description: string;
  expect: { verdicts: string[] };
  log: string[];
  notes: string[];
  scene: string;
}

interface Run {
  verdict: string;
  scores: Scores;
  ruleVerdict: string;
  costUsd: number;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(flag("runs") ?? 3);
const ONLY = flag("only");
const rubric = SYSTEM_DESIGN_RUBRIC;
const dir = new URL("./fixtures/", import.meta.url).pathname;

const fixtures: Fixture[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(dir + f, "utf8")) as Fixture)
  .filter((f) => !ONLY || f.name === ONLY);

const provider = getProvider(); // fails here, with a clear message, if no key is set
console.log(`Grading ${fixtures.length} fixtures x ${RUNS} runs with ${provider.id} (${provider.model})\n`);

const total = (s: Scores) => rubric.areas.reduce((sum, a) => sum + (s[a.name] ?? 0), 0);
const results: { fixture: Fixture; runs: Run[]; checks: Record<string, boolean> }[] = [];
let spent = 0;

for (const fixture of fixtures) {
  const input: GradingInput = {
    mode: "system_design",
    persona: DEFAULT_PERSONA,
    log: fixture.log,
    notes: fixture.notes,
    scene: fixture.scene,
  };
  const runs: Run[] = [];
  // Runs of one fixture go in parallel; fixtures go one after another to stay under rate limits.
  await Promise.all(
    Array.from({ length: RUNS }, async () => {
      const g = await grade(input, { provider });
      spent += g.costUsd;
      const scores = g.scores ?? {};
      runs.push({ verdict: g.verdict, scores, ruleVerdict: rubric.decide(scores), costUsd: g.costUsd });
    }),
  );

  const complete = runs.every((r) => rubric.areas.every((a) => r.scores[a.name] !== undefined));
  const rules = runs.every((r) =>
    r.ruleVerdict === NOT_ENOUGH || r.verdict === NOT_ENOUGH
      ? r.verdict === r.ruleVerdict
      : (verdictDistance(rubric, r.verdict, r.ruleVerdict) ?? 99) <= 1,
  );
  const areaSpread = Math.max(
    ...rubric.areas.map((a) => {
      const xs = runs.map((r) => r.scores[a.name]).filter((x): x is NonNullable<typeof x> => typeof x === "number");
      return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    }),
  );
  const verdictSpread = Math.max(...runs.flatMap((a) => runs.map((b) => verdictDistance(rubric, a.verdict, b.verdict) ?? 0)));
  const stable = areaSpread <= 1 && verdictSpread <= 1;
  const calibrated = runs.every((r) => fixture.expect.verdicts.includes(r.verdict));
  results.push({ fixture, runs, checks: { complete, rules, stable, calibrated } });

  console.log(`${fixture.name}: ${fixture.description}`);
  console.log(
    `  ${"run".padEnd(5)}${"verdict".padEnd(22)}${"rules say".padEnd(22)}${rubric.areas.map((a) => a.name.split(" ")[0]?.slice(0, 6).padEnd(8)).join("")}`,
  );
  runs.forEach((r, i) => {
    const cells = rubric.areas.map((a) => String(r.scores[a.name] === null ? "n/a" : (r.scores[a.name] ?? "-")).padEnd(8)).join("");
    console.log(`  ${String(i + 1).padEnd(5)}${(r.verdict || "(none)").padEnd(22)}${r.ruleVerdict.padEnd(22)}${cells}`);
  });
  console.log(
    `  ${Object.entries(results.at(-1)?.checks ?? {})
      .map(([k, ok]) => `${ok ? "✓" : "✗"} ${k}`)
      .join("   ")}\n`,
  );
}

// Strong should outscore mixed, which should outscore weak.
const avg = (name: string) => {
  const r = results.find((x) => x.fixture.name === name);
  return r ? r.runs.reduce((s, run) => s + total(run.scores), 0) / r.runs.length : undefined;
};
const [strong, mixed, weak] = [avg("strong"), avg("mixed"), avg("weak")];
const ordered = strong === undefined || mixed === undefined || weak === undefined ? null : strong > mixed && mixed > weak;
if (ordered !== null) {
  console.log(
    `${ordered ? "✓" : "✗"} ordered: average total score strong ${strong?.toFixed(1)} > mixed ${mixed?.toFixed(1)} > weak ${weak?.toFixed(1)}`,
  );
}

const failed = results.flatMap((r) =>
  Object.entries(r.checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => `${r.fixture.name}/${k}`),
);
if (ordered === false) failed.push("ordered");
console.log(`\nSpent about $${spent.toFixed(2)}. ${failed.length ? `Failed: ${failed.join(", ")}` : "All checks passed."}`);

mkdirSync("evals/results", { recursive: true });
const out = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ provider: provider.id, model: provider.model, runs: RUNS, results, ordered }, null, 2));
console.log(`Full results: ${out}`);
process.exit(failed.length ? 1 : 0);
