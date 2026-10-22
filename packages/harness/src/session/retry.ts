import {
  type StreamFailureClass,
  classifyStreamFailure,
} from "./stream-errors.js";

/**
 * The retry policy for model streams (B2, ADR 0026) — bounded attempts,
 * exponential backoff, one-sided jitter, a hard delay cap, and an abortable
 * wait. Shared by the task loop, A2's compaction call, and every
 * `spawn_subtask` child.
 *
 * Adapted from Pi's `RetryPolicy` / `retryAssistantCall` (MIT,
 * `pi/packages/ai/src/utils/retry.ts`) and its provider layer's cap + jitter
 * (`provider-retry.ts`). **Deliberate divergences:**
 *
 *  - **`maxRetries: 2`, not Pi's 3**, because Lemmaria keeps a retry layer
 *    UNDERNEATH this one: `model/shared.ts` passes `DEFAULT_MAX_RETRIES = 3`
 *    into both vendor SDKs, which back off, jitter and honour `Retry-After` on
 *    their own. Pi avoids the multiplication by passing `maxRetries: 0` to the
 *    SDK and owning everything; Lemmaria keeps the SDK layer for its
 *    `Retry-After` handling and sizes this one to complement it. What this
 *    layer is genuinely alone in covering is a stream that dies mid-body —
 *    which no SDK retries, because the request already succeeded.
 *  - **Jitter is one-sided (downward) and applied once, at schedule time**, and
 *    the caller reports the jittered value. Codex jitters two-sided (0.9–1.1)
 *    and Pi leaves the user-visible layer un-jittered so its countdown is
 *    honest; jittering once and then naming that number gets both properties.
 *  - **`maxDelayMs` exists** because Pi's tests fossilise a provider asking for
 *    a 77-hour delay. Nothing here honours a server-requested delay yet (the
 *    SDK consumed the header), so today the cap only bounds the exponential.
 *  - **The sleep is injected at the call site**, not stubbed with a fake timer.
 *    Every other seam in this harness is injected, and no test in the repo has
 *    ever needed a fake clock.
 */

export interface RetryPolicy {
  /** False = one attempt, no retries, whatever the class. */
  enabled: boolean;
  /** Retries AFTER the first attempt. 0 = no retries. */
  maxRetries: number;
  /** `delay(attempt) = baseDelayMs * 2^(attempt-1)`, then capped, then jittered. */
  baseDelayMs: number;
  /** Hard ceiling on any single wait, applied before jitter. */
  maxDelayMs: number;
}

/**
 * Two retries, 1s and 2s (before jitter) — at most ~3s of visible waiting.
 * Sized against the SDK layer underneath: see the divergence note above.
 */
export const DEFAULT_RETRY_POLICY = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
} as const satisfies RetryPolicy;

/** Fill in the defaults, and clamp values that would reach `setTimeout`. */
export function resolveRetryPolicy(
  requested?: Partial<RetryPolicy>,
): RetryPolicy {
  // `Math.max(0, NaN)` is NaN, and a NaN delay reaches `setTimeout` — so a
  // non-finite value falls back rather than being clamped (review).
  const nonNegative = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0, value as number) : fallback;
  return {
    enabled: requested?.enabled ?? DEFAULT_RETRY_POLICY.enabled,
    maxRetries: nonNegative(
      requested?.maxRetries,
      DEFAULT_RETRY_POLICY.maxRetries,
    ),
    baseDelayMs: nonNegative(
      requested?.baseDelayMs,
      DEFAULT_RETRY_POLICY.baseDelayMs,
    ),
    maxDelayMs: nonNegative(
      requested?.maxDelayMs,
      DEFAULT_RETRY_POLICY.maxDelayMs,
    ),
  };
}

/**
 * How long to wait before retry number `attempt` (1-based). Exponential, capped
 * at `maxDelayMs`, then jittered down by up to 25 %.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.max(0, Math.floor(capped * (1 - random() * 0.25)));
}

/**
 * What to do about a failed stream. `attempt` is 1 for a turn's first failure.
 *
 * `exhausted` and `fatal` are kept apart because they say different things to
 * the user: one means "we tried and the provider kept failing", the other means
 * "this will not work". `quota` is a third because only it has an action the
 * user can take outside Lemmaria.
 */
export type RetryDecision =
  | { kind: "retry"; delayMs: number; attempt: number; maxRetries: number }
  | { kind: "exhausted"; attempts: number }
  | { kind: "quota" }
  | { kind: "fatal" };

export function decideStreamRetry(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): RetryDecision {
  const failure: StreamFailureClass = classifyStreamFailure(error);
  if (failure === "quota") return { kind: "quota" };
  if (failure === "fatal") return { kind: "fatal" };
  return decideRetryOnBudget(attempt, policy, random);
}

/**
 * The attempt-budget half of the decision, with NO classification — for the
 * failure that has no error to classify: a stream that ended with no terminal
 * event (ADR 0015's adapter contract, broken).
 *
 * Its own function on purpose (B2 review). Routing that case through
 * `decideStreamRetry` with a stand-in error made its retryability depend on the
 * classifier's regex happening to match the stand-in's wording — the exact
 * shape of the regression B1's review caught as Critical, where a bare stream
 * end silently stopped being retried. Here it cannot: there is nothing to
 * match. The caller shares the attempt counter, so one turn's budget still
 * covers both causes.
 */
export function decideRetryOnBudget(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): RetryDecision {
  if (!policy.enabled || attempt > policy.maxRetries) {
    // `attempt` counts failures, so the number of ATTEMPTS made is the same
    // number — the first call is the first attempt.
    return { kind: "exhausted", attempts: attempt };
  }
  return {
    kind: "retry",
    delayMs: retryDelayMs(attempt, policy, random),
    attempt,
    maxRetries: policy.maxRetries,
  };
}

/**
 * Wait `ms`, or stop early if `signal` aborts. Resolves `true` when the wait
 * completed, `false` when it was cut short — never rejects, so a caller in the
 * loop's never-throws contract can branch on it.
 *
 * Interrupting the SLEEP (not just the request) is what keeps ◼ Stop responsive
 * during a backoff; both references treat it as a first-class terminal state.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
