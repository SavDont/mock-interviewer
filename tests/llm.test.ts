import { afterEach, beforeEach, expect, test } from "bun:test";
import { activeProviderId, clearAppKey, getProvider, MissingKeyError, providerStatus, setAppKey } from "../server/llm";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_PROVIDER;
  process.env.HOME = "/nonexistent-home"; // no `ant auth login` profile
});
afterEach(() => {
  clearAppKey("anthropic");
  clearAppKey("openai");
  process.env = { ...saved };
});

test("a placeholder key in .env counts as no key", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-...";
  expect(() => getProvider()).toThrow(MissingKeyError);
});

test("uses whichever provider has a key", () => {
  process.env.OPENAI_API_KEY = "sk-test-0123456789abcdefghij";
  expect(activeProviderId()).toBe("openai");
  expect(getProvider().id).toBe("openai");
});

test("LLM_PROVIDER picks the provider", () => {
  process.env.LLM_PROVIDER = "openai";
  expect(activeProviderId()).toBe("openai");
  expect(() => getProvider()).toThrow(/OPENAI_API_KEY/);
});

test("keys entered in the app are validated and never reported back", () => {
  expect(setAppKey("openai", "short")).not.toBeNull();
  expect(setAppKey("openai", "has spaces in it 0123456789")).not.toBeNull();
  const key = "sk-test-0123456789abcdefghijklmnop";
  expect(setAppKey("openai", key)).toBeNull();
  const status = providerStatus();
  expect(status.active).toBe("openai");
  expect(status.providers.find((p) => p.id === "openai")?.keySource).toBe("app");
  expect(JSON.stringify(status)).not.toContain(key);
});
