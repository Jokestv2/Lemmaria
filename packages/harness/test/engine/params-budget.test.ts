import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../src/contracts/actions.js";
import {
  DEFAULT_BUDGET_CEILINGS,
  DEFAULT_TIMEOUT_S,
  resolveBudget,
} from "../../src/engine/budget.js";
import { resolveParams } from "../../src/engine/params.js";

function action(overrides: Partial<ActionDefinition>): ActionDefinition {
  return {
    schema_version: "1",
    id: "t",
    kind: "edit",
    version: "1.0.0",
    name: { en: "T" },
    prompt: { user: "x" },
    ...overrides,
  };
}

describe("resolveParams", () => {
  const shrink = action({
    parameters: [
      { id: "target", type: "integer", required: true, min: 1 },
      { id: "tolerance", type: "number", default: 0.05 },
      {
        id: "mode",
        type: "enum",
        enum: ["gentle", "aggressive"],
        default: "gentle",
      },
    ],
  });

  it("applies defaults and derives _pct for numeric params", () => {
    const { params, errors } = resolveParams(shrink, { target: 500 });
    expect(errors).toEqual([]);
    expect(params).toMatchObject({
      target: 500,
      tolerance: 0.05,
      mode: "gentle",
    });
    expect(params.tolerance_pct).toBe(5);
    expect(params.target_pct).toBe(50000);
  });

  it("reports missing required, wrong types, range and enum violations", () => {
    expect(resolveParams(shrink, {}).errors[0]).toMatch(/target/);
    expect(resolveParams(shrink, { target: "many" }).errors[0]).toMatch(
      /integer/,
    );
    expect(resolveParams(shrink, { target: 0 }).errors[0]).toMatch(/min/);
    expect(
      resolveParams(shrink, { target: 5, mode: "brutal" }).errors[0],
    ).toMatch(/enum|one of/);
  });

  it("rejects params not declared by the action", () => {
    expect(resolveParams(shrink, { target: 5, bogus: 1 }).errors[0]).toMatch(
      /bogus/,
    );
  });
});

describe("resolveBudget (invariant 5: clamp down, never up)", () => {
  it("clamps declared values above the ceiling and keeps ones below", () => {
    const a = action({
      kind: "review",
      routing: { max_tokens: 999999, max_iterations: 2, timeout_s: 30 },
      context: { retrieval_budget: 50 },
      model: {
        fan_out: [
          "reviewer_a",
          "reviewer_b",
          "reviewer_c",
          "reviewer_a",
          "reviewer_b",
        ],
      },
    });
    const b = resolveBudget(a, DEFAULT_BUDGET_CEILINGS);
    expect(b.maxTokens).toBe(16000); // clamped down
    expect(b.maxIterations).toBe(2); // requested less — kept
    expect(b.retrievalBudget).toBe(10); // clamped down
    expect(b.fanOut).toBe(3); // clamped down
    expect(b.timeoutMs).toBe(30_000);
  });

  it("defaults to the ceilings when the action declares nothing; fan-out 0 for non-review", () => {
    const b = resolveBudget(action({}), DEFAULT_BUDGET_CEILINGS);
    expect(b).toEqual({
      maxTokens: 16000,
      maxIterations: 8,
      retrievalBudget: 10,
      fanOut: 0,
      timeoutMs: DEFAULT_TIMEOUT_S * 1000,
    });
  });
});
