import { expect, test } from "bun:test";
import { titleOf } from "../server/history";
import { cleanTranscript } from "../server/stt";
import { describeEdit } from "../src/scene";
import { turnPauseMs } from "../src/turn-taking";

test("answers questions and check-ins quickly, waits on trailing words", () => {
  expect(turnPauseMs("What's the read to write ratio?", 1500)).toBe(400);
  expect(turnPauseMs("Cool.", 1500)).toBe(400);
  expect(turnPauseMs("so the write path goes to the", 1500)).toBe(2600);
  expect(turnPauseMs("That's the API.", 1500)).toBe(1500);
});

test("long whiteboard edits are described by what changed", () => {
  expect(describeEdit('box "API"', 'box "API server"')).toBe('changed box "API" ⇒ box "API server"');
  const old = `text "${"requirements ".repeat(10)}"`;
  const next = old.replace("requirements requirements", "requirements 100M links/day requirements");
  expect(describeEdit(old, next)).toContain('added "100M links/day ');
});

test("call titles come from the design problem or the company", () => {
  expect(titleOf({ log: ['[00:01] Interviewer: "Today, design a URL shortener that handles 100M links."'] })).toBe("Design URL shortener");
  expect(
    titleOf({ mode: "recruiter", log: [], recruiter: { source: "", company: "https://www.example.com/jobs", role: "", brief: "" } }),
  ).toBe("example.com");
});

test("whisper noise and hallucinations are dropped", () => {
  expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
  expect(cleanTranscript("Thanks for watching!")).toBe("");
  expect(cleanTranscript("the right path goes to cafe car")).toBe("the write path goes to Kafka");
});
