import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  abortableSleep,
  decideRetryOnBudget,
  decideStreamRetry,
  resolveRetryPolicy,
  retryDelayMs,
} from "../../src/session/retry.js";

/** No jitter: `random() === 0` leaves the exponential untouched. */
const noJitter = () => 0;
/** Maximum jitter: `random() → 1` takes the full 25 % off. */
const fullJitter = () => 1;

const policy = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  ...over,
});

describe("retryDelayMs (B2)", () => {
  it("doubles from the base delay, attempt by attempt", () => {
    const p = policy({ baseDelayMs: 1000 });
    expect(retryDelayMs(1, p, noJitter)).toBe(1000);
    expect(retryDelayMs(2, p, noJitter)).toBe(2000);
    expect(retryDelayMs(3, p, noJitter)).toBe(4000);
    expect(retryDelayMs(4, p, noJitter)).toBe(8000);
  });

  it("jitters DOWNWARD only, by at most a quarter", () => {
    // One-sided on purpose: the delay is reported to the user before it is
    // waited, and a jitter that can LENGTHEN the wait makes that report a lie.
    const p = policy({ baseDelayMs: 1000 });
    expect(retryDelayMs(1, p, fullJitter)).toBe(750);
    expect(retryDelayMs(2, p, fullJitter)).toBe(1500);
    for (const r of [0, 0.13, 0.5, 0.99]) {
      const delay = retryDelayMs(3, p, () => r);
      expect(delay).toBeLessThanOrEqual(4000);
      expect(delay).toBeGreaterThanOrEqual(3000);
    }
  });

  it("caps a single wait at maxDelayMs, before jitter", () => {
    const p = policy({ baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(retryDelayMs(4, p, noJitter)).toBe(5000);
    expect(retryDelayMs(9, p, noJitter)).toBe(5000);
    expect(retryDelayMs(9, p, fullJitter)).toBe(3750);
  });

  it("never returns a negative or fractional delay", () => {
    const p = policy({ baseDelayMs: 1 });
    const delay = retryDelayMs(1, p, () => 0.999);
    expect(Number.isInteger(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("a zero base delay stays zero — the value tests run at", () => {
    expect(retryDelayMs(3, policy({ baseDelayMs: 0 }), noJitter)).toBe(0);
  });
});

describe("decideStreamRetry (B2)", () => {
  const transient = Object.assign(new Error("overloaded"), { status: 503 });

  it("retries a transient failure while the budget lasts, then stops", () => {
    const p = policy({ maxRetries: 2, baseDelayMs: 1000 });
    expect(decideStreamRetry(transient, 1, p, noJitter)).toEqual({
      kind: "retry",
      delayMs: 1000,
      attempt: 1,
      maxRetries: 2,
    });
    expect(decideStreamRetry(transient, 2, p, noJitter)).toEqual({
      kind: "retry",
      delayMs: 2000,
      attempt: 2,
      maxRetries: 2,
    });
    expect(decideStreamRetry(transient, 3, p, noJitter)).toEqual({
      kind: "exhausted",
      attempts: 3,
    });
  });

  it("fails a quota failure FAST — no attempt is spent and no delay is waited", () => {
    const quota = Object.assign(new Error("insufficient_quota"), {
      status: 429,
    });
    expect(decideStreamRetry(quota, 1, policy(), noJitter)).toEqual({
      kind: "quota",
    });
  });

  it("does not retry a fatal failure", () => {
    const fatal = Object.assign(new Error("invalid_request_error"), {
      status: 400,
    });
    expect(decideStreamRetry(fatal, 1, policy(), noJitter)).toEqual({
      kind: "fatal",
    });
  });

  it("maxRetries: 0 means the first failure is terminal", () => {
    expect(
      decideStreamRetry(transient, 1, policy({ maxRetries: 0 }), noJitter),
    ).toEqual({ kind: "exhausted", attempts: 1 });
  });

  it("a disabled policy never retries, whatever the class", () => {
    expect(
      decideStreamRetry(transient, 1, policy({ enabled: false }), noJitter),
    ).toEqual({ kind: "exhausted", attempts: 1 });
  });

  it("reports the number of ATTEMPTS made, not the retries", () => {
    // The notice says "gave up after N attempts"; the first call is one of them.
    const p = policy({ maxRetries: 1 });
    expect(decideStreamRetry(transient, 2, p, noJitter)).toEqual({
      kind: "exhausted",
      attempts: 2,
    });
  });
});

describe("decideRetryOnBudget (B2)", () => {
  // The missing-terminal path's decision. It has NO error to classify, so it
  // must never depend on a classifier pattern — B1's review caught exactly
  // that regression, where routing this case through the transient classifier
  // made a bare stream end silently un-retryable.
  it("retries on attempt budget alone, with the same backoff", () => {
    const p = policy({ maxRetries: 2, baseDelayMs: 1000 });
    expect(decideRetryOnBudget(1, p, noJitter)).toEqual({
      kind: "retry",
      delayMs: 1000,
      attempt: 1,
      maxRetries: 2,
    });
    expect(decideRetryOnBudget(3, p, noJitter)).toEqual({
      kind: "exhausted",
      attempts: 3,
    });
  });

  it("can never return quota or fatal — there is nothing to classify", () => {
    for (const attempt of [1, 2, 3, 9]) {
      const kind = decideRetryOnBudget(attempt, policy(), noJitter).kind;
      expect(["retry", "exhausted"]).toContain(kind);
    }
  });

  it("honours a disabled policy", () => {
    expect(
      decideRetryOnBudget(1, policy({ enabled: false }), noJitter),
    ).toEqual({ kind: "exhausted", attempts: 1 });
  });
});

describe("resolveRetryPolicy (B2)", () => {
  it("defaults every field", () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    expect(resolveRetryPolicy({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("takes each supplied field", () => {
    expect(resolveRetryPolicy({ maxRetries: 5, baseDelayMs: 10 })).toEqual({
      ...DEFAULT_RETRY_POLICY,
      maxRetries: 5,
      baseDelayMs: 10,
    });
  });

  it("falls back rather than passing NaN to setTimeout", () => {
    // `Math.max(0, NaN)` is NaN, which would reach the timer as a delay.
    expect(
      resolveRetryPolicy({
        maxRetries: Number.NaN,
        baseDelayMs: Number.NaN,
        maxDelayMs: Number.POSITIVE_INFINITY,
      }),
    ).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("floors negative values rather than trusting them", () => {
    // A negative maxRetries would make the `attempt <= maxRetries` comparison
    // read as "no retries", which is right — but a negative DELAY would be
    // handed to setTimeout, so both are clamped at the door.
    expect(
      resolveRetryPolicy({ maxRetries: -3, baseDelayMs: -1, maxDelayMs: -1 }),
    ).toMatchObject({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 });
  });
});

describe("abortableSleep (B2)", () => {
  it("resolves true after the delay when nothing aborts", async () => {
    await expect(abortableSleep(1)).resolves.toBe(true);
  });

  it("resolves false immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(abortableSleep(10_000, controller.signal)).resolves.toBe(
      false,
    );
    // If it had waited, this test would take ten seconds.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves false as soon as the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(sleeping).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("a zero delay still yields to the event loop", async () => {
    let after = false;
    const sleeping = abortableSleep(0).then(() => {
      after = true;
    });
    expect(after).toBe(false);
    await sleeping;
    expect(after).toBe(true);
  });
});
