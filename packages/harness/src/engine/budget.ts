/**
 * Lifecycle step 4 (Resolve budget): clamp the action's declared budgets DOWN
 * to the global ceilings — actions may only request less (invariant 5). The
 * four clamped fields: routing.max_tokens, routing.max_iterations,
 * context.retrieval_budget, model.fan_out. routing.timeout_s is a per-action
 * cap with no global ceiling.
 */

import type {
  ActionDefinition,
  BudgetCeilings,
  ResolvedBudget,
} from "../contracts/actions.js";

export const DEFAULT_BUDGET_CEILINGS: BudgetCeilings = {
  maxTokens: 16000,
  maxIterations: 8,
  maxRetrieval: 10,
  maxFanOut: 3,
};

export const DEFAULT_TIMEOUT_S = 60;

export function resolveBudget(
  action: ActionDefinition,
  ceilings: BudgetCeilings,
): ResolvedBudget {
  const clamp = (requested: number | undefined, ceiling: number) =>
    requested === undefined ? ceiling : Math.min(requested, ceiling);
  return {
    maxTokens: clamp(action.routing?.max_tokens, ceilings.maxTokens),
    maxIterations: clamp(
      action.routing?.max_iterations,
      ceilings.maxIterations,
    ),
    retrievalBudget: clamp(
      action.context?.retrieval_budget,
      ceilings.maxRetrieval,
    ),
    fanOut:
      action.kind === "review"
        ? clamp(action.model?.fan_out?.length, ceilings.maxFanOut)
        : 0,
    timeoutMs: (action.routing?.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000,
  };
}
