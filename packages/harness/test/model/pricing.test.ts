import { describe, expect, it } from "vitest";
import { KNOWN_MODEL_PRICING, lookupPricing } from "../../src/model/pricing.js";
import { withCost } from "../../src/model/shared.js";

const table = {
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 4, outputPerMTok: 20 },
};

describe("lookupPricing", () => {
  it("returns the exact match", () => {
    expect(lookupPricing(table, "claude-sonnet-4-5")).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
  });

  it("falls back to the LONGEST prefix match for dated model ids", () => {
    expect(lookupPricing(table, "claude-sonnet-4-5-20250929")).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
    expect(lookupPricing(table, "claude-sonnet-4-20250514")).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it("returns undefined for an unknown model or an absent table", () => {
    expect(lookupPricing(table, "totally-local-model")).toBeUndefined();
    expect(lookupPricing(undefined, "claude-sonnet-4-5")).toBeUndefined();
  });
});

describe("withCost with prefix pricing", () => {
  it("prices a dated model id through the family prefix", () => {
    const usage = withCost(table, "claude-sonnet-4-5-20250929", 1_000_000, 0);
    expect(usage.costUsd).toBe(4);
  });

  it("still omits costUsd for unknown models (ADR 0002)", () => {
    const usage = withCost(table, "local-llama", 1000, 1000);
    expect(usage.costUsd).toBeUndefined();
  });
});

describe("withCost across a long-context rate card", () => {
  // Both providers choose the card by the CALL's prompt length and price the
  // whole call on it — not the excess above the threshold.
  const tiered = {
    "m-1": {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      longContext: {
        aboveInputTokens: 100_000,
        inputPerMTok: 0.5,
        outputPerMTok: 2.5,
      },
    },
  };

  it("prices a call at the threshold on the short card", () => {
    expect(withCost(tiered, "m-1", 100_000, 1_000_000).costUsd).toBeCloseTo(
      0.01 + 0.5,
      10,
    );
  });

  it("prices the whole call on the long card once its input passes the threshold", () => {
    expect(withCost(tiered, "m-1", 200_000, 1_000_000).costUsd).toBeCloseTo(
      0.1 + 2.5,
      10,
    );
  });

  it("leaves a single-card price exactly as it was", () => {
    expect(withCost(table, "claude-sonnet-4", 2_000_000, 0).costUsd).toBe(6);
  });
});

describe("KNOWN_MODEL_PRICING", () => {
  it("family variants with their own prices do NOT inherit the base family's", () => {
    // o3-mini must not prefix-match onto o3's price (review fix).
    const o3 = lookupPricing(KNOWN_MODEL_PRICING, "o3");
    const o3mini = lookupPricing(KNOWN_MODEL_PRICING, "o3-mini");
    const o3pro = lookupPricing(KNOWN_MODEL_PRICING, "o3-pro");
    expect(o3mini).toBeDefined();
    expect(o3pro).toBeDefined();
    expect(o3mini).not.toEqual(o3);
    expect(o3pro).not.toEqual(o3);
  });

  it("covers the commonly-bound model families", () => {
    expect(
      lookupPricing(KNOWN_MODEL_PRICING, "claude-sonnet-4-5"),
    ).toBeDefined();
    expect(
      lookupPricing(KNOWN_MODEL_PRICING, "claude-haiku-4-5"),
    ).toBeDefined();
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-4o")).toBeDefined();
    expect(lookupPricing(KNOWN_MODEL_PRICING, "deepseek-chat")).toBeDefined();
  });

  it("prices BOTH live-tier pins, so a live record carries both costs (R1)", () => {
    // The S5 spike reported tokens and no dollars for its OpenAI runs, because
    // no key matched the pin. R1's live row runs on both pins, so the record
    // would otherwise carry one cost and one blank.
    //
    // The ids are LITERALS, not imports: `harness` cannot import from
    // `packages/cli/test/live/pins.ts`, which is where they are declared. So
    // this test must be moved in step with that file — change a pin without
    // touching this and the row goes silently un-covered rather than red.
    expect(
      lookupPricing(KNOWN_MODEL_PRICING, "claude-haiku-4-5-20251001"),
    ).toBeDefined();
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-5.6-luna")).toEqual({
      inputPerMTok: 0.2,
      outputPerMTok: 1.2,
      // OpenAI's list, read 2026-10-20: the long-context card past 272K.
      longContext: {
        aboveInputTokens: 272_000,
        inputPerMTok: 0.4,
        outputPerMTok: 1.8,
      },
    });
  });

  it("prices the two new models from their providers' own lists, both rate cards", () => {
    // OpenAI's pricing page and Anthropic's model docs, read 2026-10-20.
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-6-luna")).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      longContext: {
        aboveInputTokens: 272_000,
        inputPerMTok: 0.2,
        outputPerMTok: 0.75,
      },
    });
    expect(lookupPricing(KNOWN_MODEL_PRICING, "claude-haiku-5-5")).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      longContext: {
        aboveInputTokens: 100_000,
        inputPerMTok: 0.5,
        outputPerMTok: 2.5,
      },
    });
  });

  it("does not let a new generation's price reach the old, or the old's the new", () => {
    expect(lookupPricing(KNOWN_MODEL_PRICING, "claude-haiku-4-5")).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
    expect(
      lookupPricing(KNOWN_MODEL_PRICING, "gpt-6-luna")?.inputPerMTok,
    ).not.toBe(
      lookupPricing(KNOWN_MODEL_PRICING, "gpt-5.6-luna")?.inputPerMTok,
    );
    // Keyed on the full id, as gpt-5.6-luna is: a sibling is not priced.
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-6-sol")).toBeUndefined();
  });

  it("does not let gpt-5.6-luna's price leak to its dearer siblings", () => {
    // `lookupPricing` is longest-prefix, and the family shares the `gpt-5.6-`
    // stem — so a row keyed on the stem would price gpt-5.6-cyber (US$12.50/
    // US$75.00) at a sixtieth of its real cost. The key is the full model id.
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-5.6-cyber")).toBeUndefined();
    expect(lookupPricing(KNOWN_MODEL_PRICING, "gpt-5.6-sol")).toBeUndefined();
  });
});
