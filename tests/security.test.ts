import { expect, test } from "bun:test";
import { redact, refuseNonLocal } from "../server/security";

const h = (o: Record<string, string>) => new Headers(o);

test("accepts the app's own requests", () => {
  expect(refuseNonLocal(h({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBeNull();
  expect(refuseNonLocal(h({ host: "127.0.0.1:8787" }))).toBeNull();
  expect(refuseNonLocal(h({ host: "[::1]:8787", origin: "http://[::1]:5173" }))).toBeNull();
});

test("refuses other websites and DNS rebinding", () => {
  expect(refuseNonLocal(h({ host: "localhost:8787", origin: "https://evil.example" }))).not.toBeNull();
  expect(refuseNonLocal(h({ host: "evil.example:8787" }))).not.toBeNull();
  expect(refuseNonLocal(h({ host: "localhost.evil.example" }))).not.toBeNull();
  expect(refuseNonLocal(h({ host: "localhost:8787", origin: "null" }))).not.toBeNull();
  expect(refuseNonLocal(h({}))).not.toBeNull();
});

test("redacts anything that looks like a key", () => {
  expect(redact("bad key sk-ant-api03-abcdefghijkl and Bearer abcdefghijklmnop")).toBe("bad key [redacted] and [redacted]");
  expect(redact("401 sk-proj-abcdefghijklmnop")).toBe("401 [redacted]");
});
