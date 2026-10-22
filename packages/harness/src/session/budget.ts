import type { SessionTaskBudget } from "../contracts/sessions.js";

/**
 * Per-task budget defaults (ADR 0015; invariant 5). Wall-clock is
 * deliberately absent — human-in-the-loop pauses make elapsed time
 * meaningless as a runaway guard; these deterministic counters are also what
 * scripted-model tests can pin.
 */
export const DEFAULT_TASK_BUDGET: SessionTaskBudget = {
  maxTurns: 12,
  maxToolCalls: 24,
  maxOutputTokens: 16_000,
};

/**
 * Per-request output cap inside a task turn — a single turn never asks the
 * model for more than this, further capped by the task's remaining output
 * budget (`run.ts`: `min(TURN_MAX_TOKENS, remainingOutput)`).
 *
 * **Raised 4096 → 8192 at A6.** The v0.2 flagship is "draft a Methods section",
 * and a section arrives as a single `propose_edit` whose JSON carries escaped
 * LaTeX (`\\`, `\cite{}`, `$…$`) *plus* whatever prose the model writes in the
 * same turn. At 4096 tokens that ceiling is roughly 2 000 words of escaped
 * source — below a realistic section — and overflowing it is expensive: the
 * partial tool call is discarded (S4 disproof 1) and the task ends with the
 * `turn.truncated` notice, having produced nothing.
 *
 * This is a **judgement call awaiting measurement**, not a measured value — the
 * retained eval driver (`lemmaria eval`) against real papers on live models is
 * what should confirm or correct it. It stays a per-request cap clamped by the
 * task's remaining budget, so invariant 5 is untouched: no task can spend more
 * than its ceiling, and a bigger per-request cap costs nothing when the model
 * has less to say.
 */
export const TURN_MAX_TOKENS = 8192;

/**
 * Resolve the effective task budget. Per field the **host ceiling is the
 * authoritative cap** (the user's global `lemmaria.budget.*` setting), falling
 * back to `DEFAULT_TASK_BUDGET` when the host sets none — so a user who
 * configures a *bigger* budget gets it (the default is a fallback, not an
 * absolute cap). An action's `requested` value can then only ever shrink the
 * budget below that ceiling, never grow it (invariant 5).
 */
export function resolveTaskBudget(
  requested?: Partial<SessionTaskBudget>,
  ceilings?: Partial<SessionTaskBudget>,
): SessionTaskBudget {
  const field = (key: keyof SessionTaskBudget): number => {
    const ceiling = ceilings?.[key] ?? DEFAULT_TASK_BUDGET[key];
    return Math.min(ceiling, requested?.[key] ?? Number.POSITIVE_INFINITY);
  };
  return {
    maxTurns: field("maxTurns"),
    maxToolCalls: field("maxToolCalls"),
    maxOutputTokens: field("maxOutputTokens"),
  };
}

/** Per-field budget already consumed by the parent task (A3). */
export interface BudgetUsed {
  turns: number;
  toolCalls: number;
  outputTokens: number;
}

/**
 * Carve one child's ceiling from the parent's REMAINING budget (A3, invariant 5).
 *
 * **Output tokens are the only field divided across children.** They are the
 * real dollar cost and the real runaway guard — a child's output usage rolls up
 * into the parent's usage *and* its output budget — so each child gets an equal,
 * floored slice and N children's output ceilings sum to ≤ the parent's remainder.
 *
 * **Turns and tool calls are per-agent, NOT divided.** Their throughput is not
 * charged back to the parent (ADR 0022 §3, post-gate revert), so dividing them
 * by `childCount` buys no protection — it only *starves* each child: a fan-out
 * of 8 under the default 12-turn budget left each child a single turn, enough to
 * call one read tool but never to also write its summary, so every child
 * reported nothing. Each child instead gets the parent's full *remaining*
 * turn/tool-call allowance (a child can never exceed what the parent had left,
 * but is not throttled by how many siblings it has). Output tokens still bound
 * total cost regardless. The child loop then double-clamps via
 * `resolveTaskBudget(childRequest, slice)`.
 */
export function carveChildBudget(
  parent: SessionTaskBudget,
  used: BudgetUsed,
  childCount: number,
): SessionTaskBudget {
  const n = Math.max(1, childCount);
  const remaining = (total: number, spent: number) =>
    Math.max(0, total - spent);
  return {
    // per-agent: the parent's remaining allowance, undivided (throughput isn't
    // charged back, so a fan-out amplifies read capacity — the CM6 purpose).
    maxTurns: remaining(parent.maxTurns, used.turns),
    maxToolCalls: remaining(parent.maxToolCalls, used.toolCalls),
    // carved: the cost/runaway guard — N children sum to ≤ the parent's remainder.
    maxOutputTokens: Math.floor(
      remaining(parent.maxOutputTokens, used.outputTokens) / n,
    ),
  };
}

/**
 * Turns and tool calls ONE harness-issued child gets on top of its carved
 * slice (ADR 0082 §1). Output tokens never: they stay carved, the cost guard.
 */
export interface ChildAllowance {
  turns: number;
  toolCalls: number;
}

/**
 * Widen one child's carved slice by its allowance (ADR 0082 §1).
 *
 * Set only by the review driver, for the PDF reviewer, whose protocol spends
 * a turn and a call on every page it views — so a slice sized for reading a
 * manuscript cannot also hold a nine-page paper viewed one page at a time
 * (J1's round lost a whole report that way). The allowance is bounded by the
 * tool it pays for (ADR 0080 §7's sixty views), never by the paper's length,
 * and a field the slice leaves to the default widens from the default.
 */
export function withChildAllowance(
  slice: Partial<SessionTaskBudget>,
  allowance: ChildAllowance,
): Partial<SessionTaskBudget> {
  return {
    ...slice,
    maxTurns:
      (slice.maxTurns ?? DEFAULT_TASK_BUDGET.maxTurns) + allowance.turns,
    maxToolCalls:
      (slice.maxToolCalls ?? DEFAULT_TASK_BUDGET.maxToolCalls) +
      allowance.toolCalls,
  };
}
