import { expect, test } from "bun:test";
import { type DecisionEvent, PartialDecision, parseDecision } from "../server/interview/decision";

const reply = JSON.stringify({
  speak: true,
  urgency: "high",
  say: 'Hold on: "why" Kafka?\nWalk me through it — é',
  note: "",
  end_call: false,
});

test("streams the head first, then the say text, however the JSON is chunked", () => {
  for (const size of [1, 3, 8, 50]) {
    const events: DecisionEvent[] = [];
    const p = new PartialDecision();
    for (let i = 0; i < reply.length; i += size) p.push(reply.slice(i, i + size), (e) => events.push(e));
    expect(events[0]).toEqual({ t: "head", speak: true, urgency: "high" });
    expect(events.filter((e) => e.t === "head")).toHaveLength(1);
    const said = events.map((e) => (e.t === "say" ? e.text : "")).join("");
    expect(said).toBe('Hold on: "why" Kafka?\nWalk me through it — é');
  }
});

test("never emits half of an escape sequence", () => {
  const events: DecisionEvent[] = [];
  const p = new PartialDecision();
  p.push('{"speak":true,"urgency":"low","say":"a\\', (e) => events.push(e));
  p.push('u00e9b"', (e) => events.push(e));
  expect(events.filter((e) => e.t === "say").map((e) => (e as { text: string }).text)).toEqual(["a", "éb"]);
});

test("parseDecision rejects anything that isn't a full decision", () => {
  expect(parseDecision(reply)?.speak).toBe(true);
  expect(parseDecision('{"speak":true}')).toBeNull();
  expect(parseDecision("not json")).toBeNull();
});
