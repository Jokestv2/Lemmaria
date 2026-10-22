/**
 * When the literature seam may ask a host — the pacing and the backoff (R8,
 * ADR 0068).
 *
 * One responsibility: *when*, never *what*. Nothing here knows a query, a
 * result or a report; `searchLiterature` owns those and asks this module for
 * permission to make each request.
 *
 * Two mechanisms, and they answer different sentences of the brief:
 *
 *  - **the pacer** — a minimum interval between requests to the SAME host,
 *    across every caller in the process. arXiv has published one since ADR
 *    0019; DBLP, Semantic Scholar and Crossref publish or imply one too, and
 *    an agentic loop is a burst generator (R3's panel runs three seats
 *    concurrently and `literature_search` is parallel-eligible inside a tool
 *    batch). The chain generalises the arXiv slot it replaces, and keeps the
 *    B3 lesson with it: an *interval*, not a concurrency bound, and a promise
 *    chain rather than a timestamp, so concurrent claimants queue instead of
 *    all reading the same stale value and firing together.
 *
 *  - **the retry decision** — a pure function over a settled outcome. It says
 *    `retry` only when the host's own signal invited one, and it reuses
 *    `session/retry.ts`'s arithmetic (exponential, capped, one-sided jitter)
 *    rather than growing a second backoff idiom in the harness (ADR 0026).
 *
 * The pacer is keyed by **provider name**, because the host is what has the
 * limit: a keyed and an unkeyed `semantic_scholar` instance queue on one
 * chain. Its state is module-global and so refills on an extension-host
 * reload, exactly like `LITERATURE_SESSION_BUDGET` (recorded in
 * known-limits.md).
 */

import {
  type RetryPolicy,
  abortableSleep,
  retryDelayMs,
} from "../session/retry.js";
import type { LiteratureSettledOutcome } from "./literature.js";

/** Same shape as `session/loop.ts`'s `SleepFn`: false when the signal won. */
export type LiteratureSleep = (
  ms: number,
  signal?: AbortSignal,
) => Promise<boolean>;

export interface LiteraturePacer {
  /**
   * Resolves true when it is the caller's turn for `name`; false if `signal`
   * aborted while it waited. NEVER rejects — a rejected link would poison the
   * chain for the process. `minIntervalMs <= 0` resolves at once. Concurrent
   * claimants queue, and land in claim order.
   */
  claim(
    name: string,
    minIntervalMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export function createLiteraturePacer(opts?: {
  now?: () => number;
  sleep?: LiteratureSleep;
}): LiteraturePacer {
  const now = opts?.now ?? Date.now;
  const sleep = opts?.sleep ?? abortableSleep;
  /** name → when the last claimant on that host took its slot. */
  const chains = new Map<string, Promise<number>>();
  return {
    claim(name, minIntervalMs, signal) {
      if (!(minIntervalMs > 0)) {
        return Promise.resolve(signal?.aborted !== true);
      }
      const previous = chains.get(name) ?? Promise.resolve(0);
      let served = false;
      const claimed = previous.then(async (previousAt) => {
        try {
          if (signal?.aborted === true) return previousAt;
          const wait = previousAt + minIntervalMs - now();
          if (wait > 0 && !(await sleep(wait, signal))) {
            // Aborted mid-wait: no request was made, so the slot was not spent
            // and the next claimant inherits the ORIGINAL timestamp rather than
            // waiting a fresh interval from an attempt that never happened.
            return previousAt;
          }
          served = true;
          return now();
        } catch {
          // The interface's NEVER-rejects promise is ENFORCED here, not merely
          // documented: an injected `sleep` or `now` that throws must cost this
          // claimant its turn and nothing more. Were the rejection allowed to
          // become the chain head, every later claim on this host would reject
          // for the life of the process — pacing silently off for that host,
          // which is the exact failure this module exists to prevent.
          served = false;
          return previousAt;
        }
      });
      chains.set(name, claimed);
      return claimed.then(() => served);
    },
  };
}

/**
 * The process-wide instance `searchLiterature` uses when none is injected.
 *
 * Module-global on purpose: the extension rebuilds its providers per task
 * (`grants-host.ts` reads the Semantic Scholar key from SecretStorage each
 * time), so a pacer living on a provider instance would pace nothing.
 */
export const defaultLiteraturePacer: LiteraturePacer = createLiteraturePacer();

/**
 * The wall-clock bound on ONE provider's episode inside one `searchLiterature`
 * call — slot waits, attempts and backoff together. The attempt's own deadline
 * stays `LITERATURE_TIMEOUT_MS`; this is the bound on the whole sequence.
 */
export const LITERATURE_EPISODE_MS = 30_000;

/**
 * Two retries, 1 s and 2 s before jitter. The only divergence from
 * `DEFAULT_RETRY_POLICY` is the cap: 10 s, sized to the 30 s episode above
 * rather than to a model stream.
 */
export const LITERATURE_RETRY_POLICY = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
} as const satisfies RetryPolicy;

/**
 * The overload family. A 500 is a fault, not a load signal, and is NOT here.
 */
export const LITERATURE_RETRYABLE_HTTP: readonly number[] = [502, 503, 504];

export type LiteratureRetryDecision =
  | { kind: "retry"; delayMs: number }
  | { kind: "stop" };

/**
 * Should the seam ask this host again, and after how long?
 *
 * `attempt` is 1 for the first attempt's outcome. `remainingMs` is what is
 * left of the episode. Retries follow the host's own signal and only that:
 *
 * | outcome                       | decision | why                                     |
 * | ----------------------------- | -------- | --------------------------------------- |
 * | `rate_limited` (HTTP 429)     | retry    | the host's own overload signal          |
 * | `failed` 502 / 503 / 504      | retry    | the overload family                     |
 * | `failed` any other 4xx        | stop     | a refusal repeating cannot fix          |
 * | `failed` 500                  | stop     | a fault, not a load                     |
 * | `failed` with no status       | stop     | a network or parse error                |
 * | `timeout`                     | stop     | the CALLER's verdict — a host that took 8 s is not asking for another request |
 * | `ok`                          | stop     | nothing to retry                        |
 *
 * **A `Retry-After` is honoured in full or not at all.** The brief is to
 * *honour* the host's header, so clamping a 12 s `Retry-After` down to
 * `maxDelayMs` — which would ask the host again before it said we could — is
 * the brief inverted, and is why this diverges from the plan's D3 wording:
 * a `Retry-After` longer than what the episode has left, or longer than the
 * policy's ceiling on a single wait, ends the episode without waiting and the
 * host's own last word is what gets reported. A 429 with no parseable header
 * (Crossref publishes none) falls through to the pure backoff.
 */
export function decideLiteratureRetry(
  outcome: LiteratureSettledOutcome,
  attempt: number,
  remainingMs: number,
  policy: RetryPolicy = LITERATURE_RETRY_POLICY,
  random: () => number = Math.random,
): LiteratureRetryDecision {
  const stop = { kind: "stop" } as const;
  if (!policy.enabled) return stop;
  // `maxRetries` counts the retries AFTER the first attempt, so attempt N may
  // be retried only while N <= maxRetries.
  if (attempt > policy.maxRetries) return stop;
  // `Number.isFinite` and not `> 0`: `NaN <= 0` is false and every later
  // comparison against a NaN is false too, so an unguarded NaN would sail past
  // this line and return a `retry` with a NaN delay — the same trap
  // `resolveRetryPolicy` records in `session/retry.ts`.
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return stop;

  const backoff = retryDelayMs(attempt, policy, random);

  if (outcome.kind === "rate_limited") {
    // An UNREADABLE header and an INFINITE one deserve opposite answers, so
    // they are separated rather than both folded into "no header". A NaN is a
    // header we could not read at all, and falls through to the pure backoff;
    // `Infinity` is a host asking for longer than we have, and `Infinity * 1000`
    // trips the ceiling test below into the same `stop` a 12 s header gets.
    const raw = outcome.retryAfterS;
    const asked =
      raw === undefined || Number.isNaN(raw) ? 0 : Math.max(0, raw) * 1000;
    if (asked > remainingMs || asked > policy.maxDelayMs) return stop;
    const delayMs = Math.min(Math.max(asked, backoff), policy.maxDelayMs);
    return delayMs >= remainingMs ? stop : { kind: "retry", delayMs };
  }

  if (outcome.kind === "failed") {
    const status = outcome.status;
    if (status === undefined || !LITERATURE_RETRYABLE_HTTP.includes(status)) {
      return stop;
    }
    return backoff >= remainingMs ? stop : { kind: "retry", delayMs: backoff };
  }

  return stop;
}
