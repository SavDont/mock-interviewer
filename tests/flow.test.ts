import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sessions are written to disk; keep test sessions out of the real .sessions folder.
const dir = mkdtempSync(join(tmpdir(), "sessions-"));
process.env.SESSIONS_DIR = dir;
const { commit, createSession, tick } = await import("../server/interview/flow");
const { overrideProvider } = await import("../server/llm");
const { FakeProvider } = await import("./fake-provider");

const silent = JSON.stringify({ speak: false, urgency: "low", say: "", note: "", end_call: false });
const speak = JSON.stringify({ speak: true, urgency: "normal", say: "Why Redis?", note: "probe the cache", end_call: false });

let fake: InstanceType<typeof FakeProvider>;
beforeAll(() => {
  fake = new FakeProvider([silent, speak]);
  overrideProvider(fake);
});
afterAll(() => {
  overrideProvider(null);
  rmSync(dir, { recursive: true, force: true });
});

test("the conversation is append-only, so everything but the last turn is cached", async () => {
  const s = createSession({ persona: "Design a URL shortener.", pushback: "realistic", mode: "system_design" });
  const board = 'box "API"';

  const first = await tick(s, {
    trigger: "candidate_paused_speaking",
    events: ['[00:10] Candidate: "Let me start."'],
    scene: board,
    timing: "t",
  });
  expect(first.speak).toBe(false);
  // The silent check was committed as a user turn plus "(stayed silent)".
  expect(s.history).toHaveLength(2);
  expect(s.history[1]?.content).toBe("(stayed silent)");
  expect(s.history[0]?.content).toContain("<whiteboard_now>");

  const events: unknown[] = [];
  const second = await tick(
    s,
    { trigger: "candidate_paused_speaking", events: ['[00:20] Candidate: "Redis for reads."'], scene: board, timing: "t" },
    (e) => events.push(e),
  );
  expect(second.say).toBe("Why Redis?");
  expect(events[0]).toEqual({ t: "head", speak: true, urgency: "normal" });

  const req = fake.requests[1];
  // Earlier turns are sent unchanged, and the cache breakpoint sits on the last committed one.
  expect(req?.messages.slice(0, 2)).toEqual(s.history.slice(0, 2));
  expect(req?.cacheThrough).toBe(1);
  // The board didn't change, so it isn't sent again.
  expect(req?.messages.at(-1)?.content).not.toContain("<whiteboard_now>\n");
  expect(req?.messages.at(-1)?.content).toContain("unchanged");

  commit(s, "Why Redis?", false, "00:22");
  expect(s.history).toHaveLength(4);
  expect(s.history[3]?.content).toBe("Why Redis?\n[private note: probe the cache]");
  expect(s.log.at(-1)).toBe('[00:22] Interviewer: "Why Redis?"');
});
