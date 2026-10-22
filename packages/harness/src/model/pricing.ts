/**
 * Bundled model-pricing snapshot (ADR 0009): per-MTok USD, keyed by model-id
 * PREFIX — `lookupPricing` tries the exact id, then the longest matching
 * prefix, so dated ids (claude-sonnet-4-5-20250929) resolve their family
 * price. Prices drift; a missing/unknown model honestly omits `costUsd` and
 * the UI shows token counts instead (ADR 0002). Refresh opportunistically at
 * milestones — never invent a price for an unlisted model.
 */

import type { ModelPricing } from "../contracts/adapters.js";

export const KNOWN_MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // Claude Haiku 5.5 (ADR 0090), from Anthropic's model docs read 2026-10-20:
  // two rate cards chosen by prompt length — US$0.10/US$0.50 up to 100K input
  // tokens, US$0.50/US$2.50 above. No prefix clash with haiku-4-5.
  "claude-haiku-5-5": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longContext: {
      aboveInputTokens: 100_000,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
    },
  },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  // OpenAI
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  // The live tier's OpenAI pin (R1). Read from OpenAI's published price list at
  // https://developers.openai.com/api/docs/pricing on 2026-09-02: standard
  // (non-batch, short-context) rates. Keyed on the FULL model id, not the
  // `gpt-5.6-` stem — `lookupPricing` is longest-prefix, and the siblings cost
  // up to US$12.50/US$75.00, so a stem key would under-price them sixtyfold.
  // Its long-context card (above 272K input) was read from the same page on
  // 2026-10-20, when cards became expressible (ADR 0090 §5).
  "gpt-5.6-luna": {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    longContext: {
      aboveInputTokens: 272_000,
      inputPerMTok: 0.4,
      outputPerMTok: 1.8,
    },
  },
  // gpt-6-luna (ADR 0090), the same page on 2026-10-20: short context
  // (≤ 272K input) US$0.10/US$0.50, long US$0.20/US$0.75. Keyed on the full
  // id for the reason above: its siblings' prices are not read here.
  "gpt-6-luna": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    longContext: {
      aboveInputTokens: 272_000,
      inputPerMTok: 0.2,
      outputPerMTok: 0.75,
    },
  },
  o3: { inputPerMTok: 2, outputPerMTok: 8 },
  // Family variants priced differently from the base MUST have their own
  // (longer) keys, or the prefix fallback would mis-price them (review fix).
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  "o3-pro": { inputPerMTok: 20, outputPerMTok: 80 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // DeepSeek
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19 },
};

/** Exact id, else the LONGEST key that prefix-matches the model id. */
export function lookupPricing(
  pricing: Record<string, ModelPricing> | undefined,
  model: string,
): ModelPricing | undefined {
  if (pricing === undefined) return undefined;
  const exact = pricing[model];
  if (exact !== undefined) return exact;
  let bestKey: string | undefined;
  for (const key of Object.keys(pricing)) {
    if (
      model.startsWith(key) &&
      (bestKey === undefined || key.length > bestKey.length)
    ) {
      bestKey = key;
    }
  }
  return bestKey !== undefined ? pricing[bestKey] : undefined;
}
