import type { ModelPricing, Usage } from "../contracts/adapters.js";
import { lookupPricing } from "./pricing.js";

// Canonical home is the contracts (ADR 0009); re-exported for existing importers.
export type { ModelPricing };

export interface HttpAdapterOptions {
  /** Injected by unit tests so suites stay offline. */
  fetch?: typeof globalThis.fetch;
  /** Cost table keyed by model id; absent model ⇒ costUsd omitted (ADR 0002). */
  pricing?: Record<string, ModelPricing>;
  /**
   * Max automatic retries for transient failures (HTTP 408/409/429/5xx, dropped
   * connections) — the SDK retries with exponential backoff + jitter, honors
   * `Retry-After`, and aborts on the request signal (architecture Failure
   * Handling). Non-transient errors (auth/quota/context/4xx) surface immediately.
   * Defaults to {@link DEFAULT_MAX_RETRIES}.
   */
  maxRetries?: number;
}

/** A small cap so a transient blip self-heals without hammering the endpoint. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Parse a streamed tool call's accumulated argument buffer (B2, ADR 0026).
 *
 * Both protocols stream tool arguments as text fragments and parse them once,
 * at the end. When the turn was cut off by the output-token limit, that buffer
 * is a fragment of JSON — and throwing on it, which is what both adapters used
 * to do, kills the whole task with a `SyntaxError` the user cannot act on. The
 * loop's truncated-turn recovery needs the CALL to exist (so it can fail it
 * back by id and keep the conversation's tool_use/tool_result pairing legal),
 * and needs its arguments to be worthless: `{}` is returned, and the recovery
 * executes nothing from a truncated message regardless.
 *
 * Anywhere else a broken buffer is a provider defect and still throws.
 */
export function parseStreamedToolArgs(
  raw: string,
  truncated: boolean,
  describe: () => string,
): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    if (truncated) return {};
    throw new Error(describe());
  }
}

export function withCost(
  pricing: Record<string, ModelPricing> | undefined,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Usage {
  const price = lookupPricing(pricing, model);
  if (!price) return { inputTokens, outputTokens };
  // The card is chosen by THIS call's prompt, and the whole call is priced on
  // it (ADR 0090 §5) — Haiku 5.5's long card is five times its short one.
  const long = price.longContext;
  const card =
    long !== undefined && inputTokens > long.aboveInputTokens ? long : price;
  return {
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens * card.inputPerMTok + outputTokens * card.outputPerMTok) /
      1_000_000,
  };
}
