import { describe, expect, it } from "vitest";
import {
  L2_FLOOR_LABEL,
  L2_VERIFIED_MODEL_PREFIXES,
  classifyModelForSession,
} from "../../src/model/floor.js";

/**
 * A6 / ADR 0023 — the L2 model floor. The table is an evidence claim, so these
 * tests pin the evidence: every model S4 actually probed must classify
 * `verified`, and everything Lemmaria has NOT probed must classify `unverified`
 * rather than being guessed either way.
 */
describe("classifyModelForSession (A6, ADR 0023)", () => {
  // S4 finding 5 — the four models the spike drove through the full L2 loop.
  const s4Probed = [
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "gpt-4o-mini",
    "gpt-5-mini",
  ];

  it("classifies every S4-probed model as verified", () => {
    for (const model of s4Probed) {
      expect(classifyModelForSession(model), model).toBe("verified");
    }
  });

  it("classifies larger same-family siblings as verified", () => {
    // The ADR states this is an INFERENCE from the probed tier, not a probe.
    for (const model of [
      "claude-opus-4-5",
      "claude-sonnet-4-5-20260101",
      "gpt-4o",
      "gpt-5",
      "gpt-5-pro",
    ]) {
      expect(classifyModelForSession(model), model).toBe("verified");
    }
  });

  it("holds EXACTLY the entries ADR 0023 licenses, and no others", () => {
    // The table is an evidence claim, and the failure mode is that it quietly
    // grows into "models that seem capable" — which is what it must never be.
    // Adding an entry has to be a deliberate act that updates the ADR, so this
    // asserts membership exactly rather than merely that the table is sane.
    expect([...L2_VERIFIED_MODEL_PREFIXES].sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4",
      "claude-sonnet-4-5",
      "gpt-4o",
      "gpt-5",
      // ADR 0090 §8: PROBED live 2026-10-20, methods-from-codebase 3/3.
      "gpt-6-luna",
    ]);
  });

  it("verifies gpt-6-luna on its probe, and NOT Claude Haiku 5.5, which nothing has probed (ADR 0090 §8)", () => {
    expect(classifyModelForSession("gpt-6-luna")).toBe("verified");
    // Full id: a gpt-6 sibling is not claimed on luna's probe.
    expect(classifyModelForSession("gpt-6-sol")).toBe("unverified");
    // The Anthropic pin is off, so Haiku 5.5 has never run the loop here; and
    // the inference runs UP a family to a larger sibling, never across to a
    // new generation — haiku-4-5's verdict is not haiku-5-5's.
    expect(classifyModelForSession("claude-haiku-5-5")).toBe("unverified");
  });

  it("does not infer DOWNWARD to older or smaller unprobed releases", () => {
    // The inference runs upward only (a larger sibling of a passing model).
    for (const model of [
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet",
      "claude-haiku-3",
      "o3-mini",
      "o1-preview",
    ]) {
      expect(classifyModelForSession(model), model).toBe("unverified");
    }
  });

  it("classifies unprobed, local and unknown models as unverified", () => {
    // S4 recorded that the floor claim does NOT extend below the probed tier
    // and does NOT extend to local/OSS endpoints — so Lemmaria says "unknown",
    // never "this will fail".
    for (const model of [
      "",
      "llama3.1:8b",
      "mistral-small",
      "qwen2.5-coder:7b",
      "gpt-3.5-turbo",
      "claude-2.1",
      "some-vendor/some-model",
    ]) {
      expect(classifyModelForSession(model), model).toBe("unverified");
    }
  });

  it("matches on prefix, not on substring", () => {
    // A vendor shipping "not-gpt-4o" must not inherit gpt-4o's verdict.
    expect(classifyModelForSession("not-gpt-4o")).toBe("unverified");
    expect(classifyModelForSession("my-claude-sonnet-4-5")).toBe("unverified");
  });

  it("exposes a floor label naming the probed tier", () => {
    // The label is what the user is told; it must name a real, probed class.
    expect(L2_FLOOR_LABEL).toContain("claude-haiku-4-5");
    expect(L2_FLOOR_LABEL).toContain("gpt-4o-mini");
  });

  it("keeps the verified table non-empty and prefix-shaped", () => {
    expect(L2_VERIFIED_MODEL_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of L2_VERIFIED_MODEL_PREFIXES) {
      expect(prefix).not.toBe("");
      expect(prefix.trim()).toBe(prefix);
    }
  });
});
