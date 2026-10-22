/**
 * Stream-failure classification (B2, ADR 0026) — one definition shared by the
 * task loop's per-turn retry, A2's compaction retry, and every `spawn_subtask`
 * child, so they can never disagree about what a failure means.
 *
 * Three classes, not a boolean. A1a's `isTransientStreamError` answered only
 * "retry or not", which left quota/billing exhaustion — which arrives as a
 * **429 and looks exactly like a throttle** — burning the whole retry budget on
 * a deterministic failure and then reporting a sentence the user cannot act on.
 *
 * Adapted from Pi's `isRetryableAssistantError` (MIT,
 * `pi/packages/ai/src/utils/retry.ts`), whose pattern lists carry the issue
 * numbers they were learned from. **Deliberate divergences:**
 *
 *  - Lemmaria classifies the SDK error object, which still carries a numeric
 *    `status`, so status is consulted first and the message patterns are the
 *    fallback. Pi classifies a stringified `errorMessage` because by then the
 *    status is gone — its status patterns ("429", "500", …) are string matches,
 *    which is strictly worse when the number is still in hand.
 *  - The quota patterns are checked BEFORE anything else, including the status.
 *    Pi does the same among its two lists and it is the load-bearing ordering:
 *    a "429 quota exceeded" matches every retryable signal there is.
 *  - Codex reaches the same place from the other side (`retry_429: false`, then
 *    parse the body). Not adopted: it needs a typed provider body, which the
 *    harness deliberately does not have — the model seam is protocol-shaped,
 *    not vendor-shaped.
 */

import type { ModelFailureClass } from "../contracts/data.js";

/**
 * What a failed model stream means for the retry policy — **an alias of the
 * contract's `ModelFailureClass`** since X5 (ADR 0074 §7).
 *
 * The three classes were already exactly this union; X5 gave them a home on
 * the wire (a failed seat's `cause`, a preflight's) and the record must not
 * spell them differently from the classifier that decides them. One
 * vocabulary, declared in the contracts, aliased here so every existing
 * `StreamFailureClass` reference keeps reading as what it is.
 */
export type StreamFailureClass = ModelFailureClass;

/**
 * Account-level exhaustion, in the wordings the providers actually use. These
 * arrive with a 429 (OpenAI's `insufficient_quota`) or a 400 (Anthropic's
 * credit-balance message), i.e. as statuses that otherwise mean "retry" and
 * "give up" respectively — the status alone cannot tell you.
 */
const QUOTA_PATTERN =
  /insufficient_quota|quota exceeded|exceeded your current quota|out of budget|billing|credit balance|usage limit reached|subscription/i;

/**
 * Transport, provider-load and premature-stream-end wordings. The premature-end
 * group is the one that earns this layer its keep: the vendor SDKs retry a
 * request that never established, but never a stream that died mid-body.
 */
const RETRYABLE_PATTERN =
  /connection|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|socket connection was closed|other side closed|network|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|terminated|overloaded|rate.?limit|too many requests|service.?unavailable|timed? out|timeout|stream ended|ended without|did not get a response/i;

/** The text a classifier gets to look at: the error's name and message. */
function textOf(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : String(error);
}

export function classifyStreamFailure(error: unknown): StreamFailureClass {
  const text = textOf(error);
  // FIRST, unconditionally: a quota failure wearing a transient status is the
  // exact case this class exists for, so nothing may short-circuit past it.
  if (QUOTA_PATTERN.test(text)) return "quota";

  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") {
    // A1a's rule, unchanged: the statuses a provider uses for "later".
    return status === 408 || status === 429 || status >= 500
      ? "retryable"
      : "fatal";
  }
  return RETRYABLE_PATTERN.test(text) ? "retryable" : "fatal";
}
