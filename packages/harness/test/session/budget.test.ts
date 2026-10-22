import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_BUDGET,
  TURN_MAX_TOKENS,
  carveChildBudget,
  resolveTaskBudget,
} from "../../src/session/budget.js";

describe("resolveTaskBudget (invariant 5: clamp down, never up)", () => {
  it("defaults when nothing is requested", () => {
    expect(resolveTaskBudget()).toEqual(DEFAULT_TASK_BUDGET);
  });

  it("a request below the default passes through", () => {
    expect(resolveTaskBudget({ maxTurns: 3 }).maxTurns).toBe(3);
  });

  it("a request above the ceiling clamps to the ceiling", () => {
    const budget = resolveTaskBudget(
      { maxOutputTokens: 999_999 },
      { maxOutputTokens: 8000 },
    );
    expect(budget.maxOutputTokens).toBe(8000);
  });

  it("a host ceiling above the default RAISES it (the user's setting is the authoritative ceiling, invariant 5)", () => {
    // DEFAULT_TASK_BUDGET is the fallback when the host sets no ceiling, not an
    // absolute cap — a user who configures a bigger budget gets it.
    const budget = resolveTaskBudget(undefined, { maxTurns: 100 });
    expect(budget.maxTurns).toBe(100);
  });

  it("an action request still clamps DOWN from a raised ceiling", () => {
    const budget = resolveTaskBudget({ maxTurns: 20 }, { maxTurns: 100 });
    expect(budget.maxTurns).toBe(20);
  });

  it("a ceiling below the default clamps even without a request", () => {
    const budget = resolveTaskBudget(undefined, { maxToolCalls: 5 });
    expect(budget.maxToolCalls).toBe(5);
  });

  it("exports a per-request turn cap", () => {
    expect(TURN_MAX_TOKENS).toBeGreaterThan(0);
    expect(TURN_MAX_TOKENS).toBeLessThanOrEqual(
      DEFAULT_TASK_BUDGET.maxOutputTokens,
    );
  });
});

describe("carveChildBudget (A3, invariant 5)", () => {
  const parent = { maxTurns: 12, maxToolCalls: 24, maxOutputTokens: 16_000 };

  it("carves output tokens across children but leaves turns/tool-calls per-agent", () => {
    const used = { turns: 2, toolCalls: 6, outputTokens: 4_000 };
    const slice = carveChildBudget(parent, used, 2);
    // remaining: 10 turns / 18 calls / 12000 tokens. Turns & calls pass through
    // undivided (per-agent throughput); only output tokens are halved & floored.
    expect(slice).toEqual({
      maxTurns: 10,
      maxToolCalls: 18,
      maxOutputTokens: 6_000,
    });
    // Only the cost field must sum within the parent's remainder across children.
    expect(slice.maxOutputTokens * 2).toBeLessThanOrEqual(
      parent.maxOutputTokens - used.outputTokens,
    );
    // Turns/tool-calls never exceed what the PARENT had left (can't request more).
    expect(slice.maxTurns).toBeLessThanOrEqual(parent.maxTurns - used.turns);
    expect(slice.maxToolCalls).toBeLessThanOrEqual(
      parent.maxToolCalls - used.toolCalls,
    );
  });

  it("gives a wide fan-out enough turns for every child to explore AND report", () => {
    // The production bug: 8 children under the default 12-turn budget. Dividing
    // turns gave each floor(11/8)=1 — one read tool call, no room to summarize.
    const slice = carveChildBudget(
      DEFAULT_TASK_BUDGET,
      { turns: 1, toolCalls: 1, outputTokens: 0 },
      8,
    );
    expect(slice.maxTurns).toBeGreaterThan(1);
  });

  it("never returns a negative slice when the parent is already exhausted", () => {
    const slice = carveChildBudget(
      parent,
      { turns: 12, toolCalls: 24, outputTokens: 16_000 },
      3,
    );
    expect(slice).toEqual({
      maxTurns: 0,
      maxToolCalls: 0,
      maxOutputTokens: 0,
    });
  });

  it("treats a zero/negative childCount as one child (no divide-by-zero)", () => {
    const slice = carveChildBudget(
      parent,
      { turns: 0, toolCalls: 0, outputTokens: 0 },
      0,
    );
    expect(slice).toEqual(parent);
  });
});
