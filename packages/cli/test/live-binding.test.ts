import type { Protocol } from "@lemmaria/harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveBindingFrom } from "../src/eval/command.js";
import {
  DEFAULT_LIVE_MODEL,
  DEFAULT_LIVE_PROTOCOL,
  liveBinding,
  resolveRunBinding,
} from "../src/eval/run-eval.js";
import { LIVE_OPENAI_MODEL } from "./live/pins.js";

describe("liveBinding", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the openai preset's base URL when no endpoint env var is set", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_ENDPOINT", "");
    const binding = liveBinding("openai-compatible", "gpt-5.6-luna");
    expect(binding.endpoint).toBe("https://api.openai.com/v1");
    expect(binding.model).toBe("gpt-5.6-luna");
    expect(binding.protocol).toBe("openai-compatible");
  });

  it("keeps anthropic's empty endpoint, which means 'use the protocol default'", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENDPOINT", "");
    expect(liveBinding("anthropic", "claude-haiku-4-5-20251001").endpoint).toBe(
      "",
    );
  });

  it("lets the env var override the preset", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_ENDPOINT", "https://gateway.example/v1");
    expect(liveBinding("openai-compatible", "m").endpoint).toBe(
      "https://gateway.example/v1",
    );
  });

  it("throws naming the key variable when no key is set", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "");
    expect(() => liveBinding("openai-compatible", "m")).toThrow(
      /LEMMARIA_SMOKE_OPENAI_KEY/,
    );
  });

  it("throws for a protocol with no preset rather than emitting an empty endpoint", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    expect(() => liveBinding("mystery" as Protocol, "m")).toThrow(
      /no provider preset/,
    );
  });

  it("never puts the key in the thrown message", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "sk-secret-value");
    expect(() => liveBinding("mystery" as Protocol, "m")).toThrow(
      expect.not.stringContaining("sk-secret-value") as unknown as string,
    );
  });
});

describe("liveBindingFrom", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when stub is true", () => {
    expect(
      liveBindingFrom({
        stub: true,
        protocol: "openai-compatible",
        model: "m",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when model is not given", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    expect(liveBindingFrom({ protocol: "openai-compatible" })).toBeUndefined();
  });

  it("resolves the endpoint from the preset for openai-compatible", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_ENDPOINT", "");
    const binding = liveBindingFrom({
      protocol: "openai-compatible",
      model: "gpt-5.6-luna",
    });
    expect(binding?.endpoint).toBe("https://api.openai.com/v1");
  });

  it("includes --protocol context in error message when key is missing", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "");
    expect(() =>
      liveBindingFrom({ protocol: "openai-compatible", model: "m" }),
    ).toThrow(/no API key for --protocol openai-compatible/);
  });

  it("defaults --protocol to openai-compatible", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_ENDPOINT", "");
    const binding = liveBindingFrom({ model: "m" });
    expect(binding?.protocol).toBe("openai-compatible");
    expect(binding?.endpoint).toBe("https://api.openai.com/v1");
  });

  it("still binds anthropic when --protocol names it", () => {
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_ENDPOINT", "");
    expect(
      liveBindingFrom({ protocol: "anthropic", model: "m" })?.protocol,
    ).toBe("anthropic");
  });

  it("refuses --protocol anthropic with no --model, rather than quietly running the default", () => {
    // Only the default protocol has a default model. Without this, the flag
    // would be dropped and the run would bind openai-compatible instead.
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    expect(() => liveBindingFrom({ protocol: "anthropic" })).toThrow(
      /--protocol anthropic needs --model/,
    );
  });

  it("refuses a --protocol it does not know, rather than spending on the default", () => {
    // Before the default moved, a typo fell through to anthropic. Falling
    // through to a FUNDED provider would run — and bill — the wrong one.
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    expect(() => liveBindingFrom({ protocol: "anthropc", model: "m" })).toThrow(
      /unknown --protocol "anthropc"/,
    );
  });
});

/**
 * The driver's own last resort: a live run whose caller named no binding at
 * all. OpenAI-compatible since 2026-09-17 (operator decision) — the anthropic
 * key is exported on the build machine and unfunded, so the old default made a
 * bare `lemmaria eval` fail on billing.
 */
describe("the binding a live run gets when the caller names none", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("is openai-compatible, on the live tier's cheap pin", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "test-key");
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_ENDPOINT", "");
    expect(resolveRunBinding({ stub: false })).toEqual({
      protocol: "openai-compatible",
      endpoint: "https://api.openai.com/v1",
      model: DEFAULT_LIVE_MODEL,
      apiKey: "test-key",
    });
    expect(DEFAULT_LIVE_PROTOCOL).toBe("openai-compatible");
  });

  it("names the model the live tier pins, so the two cannot drift apart", () => {
    expect(DEFAULT_LIVE_MODEL).toBe(LIVE_OPENAI_MODEL);
  });

  it("asks for the openai key — never the anthropic one — when it has none", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "test-key");
    expect(() => resolveRunBinding({ stub: false })).toThrow(
      /LEMMARIA_SMOKE_OPENAI_KEY/,
    );
  });

  it("prefers the caller's binding to the default", () => {
    const named = {
      protocol: "anthropic" as const,
      endpoint: "",
      model: "claude-haiku-4-5-20251001",
      apiKey: "k",
    };
    expect(resolveRunBinding({ stub: false, binding: named })).toBe(named);
  });

  it("lets --stub win over a named binding, and needs no key to do it", () => {
    vi.stubEnv("LEMMARIA_SMOKE_OPENAI_KEY", "");
    vi.stubEnv("LEMMARIA_SMOKE_ANTHROPIC_KEY", "");
    const named = {
      protocol: "openai-compatible" as const,
      endpoint: "https://gateway.example/v1",
      model: "m",
      apiKey: "k",
    };
    expect(resolveRunBinding({ stub: true, binding: named }).apiKey).toBe(
      "stub",
    );
  });
});
