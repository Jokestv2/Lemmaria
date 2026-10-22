import { describe, expect, it } from "vitest";
import type { LiteratureSleep } from "../../src/engine/literature-pacer.js";
import {
  LITERATURE_RETRY_POLICY,
  createLiteraturePacer,
  decideLiteratureRetry,
} from "../../src/engine/literature-pacer.js";
import type { LiteratureSettledOutcome } from "../../src/engine/literature.js";
import type { RetryPolicy } from "../../src/session/retry.js";

/**
 * A virtual clock. Every wait in these tests is arithmetic on `t`, never a real
 * `setTimeout` — the pacer's whole contract is *when*, and asserting it against
 * the wall clock is what makes a pacing test flaky on a loaded machine.
 */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: { ms: number; at: number }[] = [];
  const sleep: LiteratureSleep = async (ms, signal) => {
    sleeps.push({ ms, at: t });
    if (signal?.aborted === true) return false;
    t += ms;
    return true;
  };
  return {
    now: () => t,
    sleep,
    sleeps,
    at: () => t,
  };
}

describe("createLiteraturePacer (R8/O1 — when the seam may ask a host)", () => {
  it("paces two sequential claims on one name by minIntervalMs", async () => {
    const c = fakeClock();
    const pacer = createLiteraturePacer({ now: c.now, sleep: c.sleep });

    expect(await pacer.claim("arxiv", 3000)).toBe(true);
    const first = c.at();
    expect(c.sleeps).toEqual([]); // the first claim on a host is free

    expect(await pacer.claim("arxiv", 3000)).toBe(true);
    expect(c.at() - first).toBeGreaterThanOrEqual(3000);
  });

  it("queues CONCURRENT claims on one name, in claim order (the B3 lesson)", async () => {
    // Kept from the arXiv factory's own test, which this replaces: the pacing
    // used to be a timestamp read before an await and written after it, so
    // three calls launched in one tick all read the same stale value, waited
    // the same interval and fired together. A host publishes an INTERVAL; the
    // tool batch's concurrency width is not a substitute for it.
    const c = fakeClock();
    const pacer = createLiteraturePacer({ now: c.now, sleep: c.sleep });
    const started = c.at();

    const order: number[] = [];
    const served = await Promise.all(
      [0, 1, 2].map((i) =>
        pacer.claim("dblp", 2000).then((ok) => {
          order.push(i);
          return ok;
        }),
      ),
    );

    expect(served).toEqual([true, true, true]);
    expect(order).toEqual([0, 1, 2]);
    // Each claimant waited for its PREDECESSOR's slot to open, not for the
    // same stale one: the second slept from the first's slot, the third from
    // the second's.
    expect(c.sleeps).toEqual([
      { ms: 2000, at: started },
      { ms: 2000, at: started + 2000 },
    ]);
    expect(c.at()).toBe(started + 4000);
  });

  it("does not make one host wait for another", async () => {
    const c = fakeClock();
    const pacer = createLiteraturePacer({ now: c.now, sleep: c.sleep });

    await pacer.claim("arxiv", 3000);
    await pacer.claim("arxiv", 3000); // arXiv now owes 3 s to its next caller
    const afterArxiv = c.at();

    expect(await pacer.claim("crossref", 1000)).toBe(true);
    expect(c.at()).toBe(afterArxiv);
  });

  it("resolves false when the signal aborts mid-wait, and still serves the next claimant", async () => {
    const c = fakeClock();
    const controller = new AbortController();
    const sleep: LiteratureSleep = async (ms, signal) => {
      // The episode's bound wins while this claimant is queued.
      if (signal === controller.signal) {
        controller.abort();
        return false;
      }
      return c.sleep(ms, signal);
    };
    const pacer = createLiteraturePacer({ now: c.now, sleep });

    expect(await pacer.claim("crossref", 1000)).toBe(true);
    const slotAt = c.at();
    expect(await pacer.claim("crossref", 1000, controller.signal)).toBe(false);

    // The chain is not poisoned, and the abandoned claim did NOT spend the
    // slot — no request was made, so the next caller still waits from the
    // timestamp of the last request that really happened.
    expect(await pacer.claim("crossref", 1000)).toBe(true);
    expect(c.at()).toBe(slotAt + 1000);
  });

  it("resolves at once, with no sleep, when the host declares no interval", async () => {
    const c = fakeClock();
    const pacer = createLiteraturePacer({ now: c.now, sleep: c.sleep });

    expect(await pacer.claim("scripted", 0)).toBe(true);
    expect(await pacer.claim("scripted", 0)).toBe(true);
    expect(c.sleeps).toEqual([]);
    expect(c.at()).toBe(1_000_000);
  });

  it("NEVER rejects, and a throwing sleep does not poison the host's chain", async () => {
    // The interface's promise is that a rejected link can never become the
    // chain head — otherwise one bad injected sleep would turn pacing OFF for
    // that host for the life of the process, silently.
    const c = fakeClock();
    let throwOnce = false;
    const sleep: LiteratureSleep = async (ms, signal) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("boom");
      }
      return c.sleep(ms, signal);
    };
    const pacer = createLiteraturePacer({ now: c.now, sleep });

    expect(await pacer.claim("crossref", 1000)).toBe(true);
    const slotAt = c.at();

    throwOnce = true;
    // Not a rejection: the claimant simply loses its turn.
    expect(await pacer.claim("crossref", 1000)).toBe(false);

    // And the slot was NOT spent, exactly as for an aborted wait — no request
    // was made, so the next claimant waits from the last real one.
    expect(await pacer.claim("crossref", 1000)).toBe(true);
    expect(c.at()).toBe(slotAt + 1000);
    expect(await pacer.claim("crossref", 1000)).toBe(true);
  });
});

describe("decideLiteratureRetry (R8/O4 — only the host's own signal)", () => {
  const NO_JITTER = () => 0;
  const REMAINING = 30_000;
  const rateLimited = (retryAfterS?: number): LiteratureSettledOutcome =>
    retryAfterS === undefined
      ? { kind: "rate_limited" }
      : { kind: "rate_limited", retryAfterS };
  const failed = (status?: number): LiteratureSettledOutcome => ({
    kind: "failed",
    message: status === undefined ? "conn reset" : `http ${status}`,
    ...(status === undefined ? {} : { status }),
  });

  it("retries a 429 after the longer of Retry-After and the backoff", () => {
    // Retry-After 3 s beats attempt 1's 1 s backoff.
    expect(
      decideLiteratureRetry(
        rateLimited(3),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "retry", delayMs: 3000 });
    // Attempt 2's 2 s backoff beats a 1 s Retry-After.
    expect(
      decideLiteratureRetry(
        rateLimited(1),
        2,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "retry", delayMs: 2000 });
  });

  it("retries a 429 that carries no Retry-After on the pure backoff (the Crossref case)", () => {
    expect(
      decideLiteratureRetry(
        rateLimited(),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "retry", delayMs: 1000 });
  });

  it("stops on a Retry-After the episode cannot afford", () => {
    expect(
      decideLiteratureRetry(
        rateLimited(20),
        1,
        5_000,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("stops on a Retry-After longer than the policy's ceiling — it is honoured in full or not at all", () => {
    // 12 s > maxDelayMs. Clamping it to 10 s would ask the host again BEFORE
    // it said we could, which is the brief inverted (ADR 0068).
    expect(
      decideLiteratureRetry(
        rateLimited(12),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("answers an UNREADABLE Retry-After and an INFINITE one differently", () => {
    // A NaN is a header we could not read: it is not the host asking for
    // anything, so it falls through to the pure backoff like an absent one.
    expect(
      decideLiteratureRetry(
        rateLimited(Number.NaN),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "retry", delayMs: 1000 });
    // `Infinity` IS the host asking — for longer than anyone has — so it stops,
    // exactly as a 12 s header does.
    expect(
      decideLiteratureRetry(
        rateLimited(Number.POSITIVE_INFINITY),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("stops on a NaN remainingMs rather than returning a NaN delay", () => {
    // `NaN <= 0` is false and so is every later comparison, so an unguarded
    // NaN would sail through and reach a `setTimeout` — the trap
    // `resolveRetryPolicy` records in session/retry.ts.
    expect(
      decideLiteratureRetry(
        rateLimited(),
        1,
        Number.NaN,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("retries the overload family and nothing else", () => {
    for (const status of [502, 503, 504]) {
      expect(
        decideLiteratureRetry(
          failed(status),
          1,
          REMAINING,
          LITERATURE_RETRY_POLICY,
          NO_JITTER,
        ),
      ).toEqual({ kind: "retry", delayMs: 1000 });
    }
    // 500 is a fault, not a load; 4xx is a refusal repeating cannot fix.
    for (const status of [500, 404, 403, 400]) {
      expect(
        decideLiteratureRetry(
          failed(status),
          1,
          REMAINING,
          LITERATURE_RETRY_POLICY,
          NO_JITTER,
        ),
      ).toEqual({ kind: "stop" });
    }
    // A network or parse error carries no status.
    expect(
      decideLiteratureRetry(
        failed(),
        1,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("never retries the caller's own timeout verdict, or a success", () => {
    expect(decideLiteratureRetry({ kind: "timeout" }, 1, REMAINING)).toEqual({
      kind: "stop",
    });
    expect(
      decideLiteratureRetry({ kind: "ok", results: [] }, 1, REMAINING),
    ).toEqual({ kind: "stop" });
  });

  it("stops once the attempts are spent, and when the episode is over", () => {
    // maxRetries = 2, so attempt 1 and attempt 2 may be retried; attempt 3 is
    // the third and last request this episode may make.
    expect(
      decideLiteratureRetry(
        rateLimited(),
        3,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
    expect(
      decideLiteratureRetry(
        rateLimited(),
        4,
        REMAINING,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
    expect(
      decideLiteratureRetry(
        rateLimited(),
        1,
        0,
        LITERATURE_RETRY_POLICY,
        NO_JITTER,
      ),
    ).toEqual({ kind: "stop" });
  });

  it("uses session/retry.ts's arithmetic — exponential, capped, jittered down", () => {
    // One backoff idiom in the harness, not two (ADR 0026).
    const policy: RetryPolicy = {
      enabled: true,
      maxRetries: 10,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
    };
    // 1000 * 2^1 = 2000, no jitter.
    expect(
      decideLiteratureRetry(failed(503), 2, 60_000, policy, () => 0),
    ).toEqual({ kind: "retry", delayMs: 2000 });
    // 1000 * 2^5 = 32000, capped to 10000, then jittered down by the full 25 %.
    expect(
      decideLiteratureRetry(failed(503), 6, 60_000, policy, () => 1),
    ).toEqual({ kind: "retry", delayMs: 7500 });
  });

  it("honours a disabled policy", () => {
    expect(
      decideLiteratureRetry(rateLimited(1), 1, REMAINING, {
        ...LITERATURE_RETRY_POLICY,
        enabled: false,
      }),
    ).toEqual({ kind: "stop" });
  });
});
