import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveAnthropicReady, liveOpenAIReady } from "./live/pins.js";

/**
 * The live tier's two gates, tested OFFLINE — `pins.ts` reads the environment
 * and nothing else, so nothing here reaches a network.
 *
 * The Anthropic pin is **off by default** (operator decision, 2026-09-17): a
 * key that is present but unfunded is not a pin that can run, and an exported
 * key is exactly the environment the build machine has. The rows still exist;
 * what these tests pin down is that a key alone no longer opens them.
 */
describe("the live tier's pin gates", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENABLED", "");
  });

  it("keeps the anthropic pin closed on a key alone", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    expect(liveAnthropicReady()).toBe(false);
  });

  it("opens the anthropic pin on a key plus the explicit opt-in", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENABLED", "1");
    expect(liveAnthropicReady()).toBe(true);
  });

  it("keeps the anthropic pin closed on the opt-in alone — there is no key to call with", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENABLED", "1");
    expect(liveAnthropicReady()).toBe(false);
  });

  it("reads the opt-in as exactly `1`, so a stray value never spends money", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    for (const value of ["0", "true", "yes", " 1"]) {
      vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENABLED", value);
      expect(liveAnthropicReady(), `value ${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  it("leaves the openai pin as it was: a key is enough", () => {
    expect(liveOpenAIReady()).toBe(false);
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    expect(liveOpenAIReady()).toBe(true);
  });
});
