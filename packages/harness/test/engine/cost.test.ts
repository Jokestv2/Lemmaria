import { describe, expect, it } from "vitest";
import {
  accrueUsage,
  costAsOf,
  emptyCostState,
  formatCostBucket,
  localDateString,
  runCost,
} from "../../src/engine/cost.js";

describe("costAsOf (the X5 and X6 review rounds)", () => {
  // At 23:43 on 2026-09-17, before any run that day, the Models tab read
  // `Today (2026-09-16) · … · $0.002` and the status bar `$0.002 today`:
  // the bucket rolls over only when a run is RECORDED, and both displays
  // showed it as it stood.
  const yesterday = accrueUsage(
    emptyCostState("2026-09-16"),
    { inputTokens: 9300, outputTokens: 170, costUsd: 0.002 },
    "2026-09-16",
  );

  it("reads a bucket stamped with another day as today's empty one", () => {
    expect(costAsOf(yesterday, "2026-09-17").today).toEqual({
      date: "2026-09-17",
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      unpricedRuns: 0,
    });
  });

  it("keeps the total, which is not a day's", () => {
    expect(costAsOf(yesterday, "2026-09-17").total).toEqual(yesterday.total);
  });

  it("is the state itself on the bucket's own day", () => {
    expect(costAsOf(yesterday, "2026-09-16")).toEqual(yesterday);
  });

  it("is pure: the stored state is untouched", () => {
    costAsOf(yesterday, "2026-09-17");
    expect(yesterday.today.date).toBe("2026-09-16");
    expect(yesterday.today.usd).toBe(0.002);
  });
});

describe("runCost (the X6 review round)", () => {
  it("folds a run's parts into one bucket", () => {
    // A panel is charged per reviewer, the cross-review and the pre-run
    // check; *this run* is all of them, not whichever was charged last.
    const run = runCost([
      { inputTokens: 100, outputTokens: 10, costUsd: 0.03 },
      { inputTokens: 200, outputTokens: 20, costUsd: 0.04 },
      { inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
    ]);
    expect(run.usd).toBeCloseTo(0.071, 9);
    expect(run).toMatchObject({
      inputTokens: 305,
      outputTokens: 31,
      unpricedRuns: 0,
    });
  });

  it("counts an unpriced part, so a partial dollar figure says so", () => {
    // The item's own summed usage cannot: its cost is a lower bound whenever
    // any seat was unpriced (ADR 0074 §8), and would read as the whole.
    const run = runCost([
      { inputTokens: 100, outputTokens: 10, costUsd: 0.03 },
      { inputTokens: 175000, outputTokens: 2400 },
    ]);
    expect(run.unpricedRuns).toBe(1);
    expect(formatCostBucket(run)).toBe("$0.030 (+1 unpriced)");
  });

  it("reads one part exactly as that part", () => {
    expect(runCost([{ inputTokens: 500, outputTokens: 50 }])).toEqual({
      usd: 0,
      inputTokens: 500,
      outputTokens: 50,
      unpricedRuns: 1,
    });
  });
});

describe("accrueUsage", () => {
  it("accrues a priced run into today AND total", () => {
    const s0 = emptyCostState("2026-07-06");
    const s1 = accrueUsage(
      s0,
      { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 },
      "2026-07-06",
    );
    expect(s1.today).toEqual({
      date: "2026-07-06",
      usd: 0.01,
      inputTokens: 1000,
      outputTokens: 200,
      unpricedRuns: 0,
    });
    expect(s1.total).toEqual({
      usd: 0.01,
      inputTokens: 1000,
      outputTokens: 200,
      unpricedRuns: 0,
    });
    // Pure: the input state is untouched.
    expect(s0.total.inputTokens).toBe(0);
  });

  it("an unpriced run counts tokens and increments unpricedRuns", () => {
    const s1 = accrueUsage(
      emptyCostState("2026-07-06"),
      { inputTokens: 500, outputTokens: 50 },
      "2026-07-06",
    );
    expect(s1.today.usd).toBe(0);
    expect(s1.today.unpricedRuns).toBe(1);
    expect(s1.total.inputTokens).toBe(500);
  });

  it("a new date rolls today over; total survives", () => {
    const s1 = accrueUsage(
      emptyCostState("2026-07-06"),
      { inputTokens: 100, outputTokens: 10, costUsd: 0.5 },
      "2026-07-06",
    );
    const s2 = accrueUsage(
      s1,
      { inputTokens: 30, outputTokens: 3, costUsd: 0.2 },
      "2026-07-07",
    );
    expect(s2.today).toEqual({
      date: "2026-07-07",
      usd: 0.2,
      inputTokens: 30,
      outputTokens: 3,
      unpricedRuns: 0,
    });
    expect(s2.total.usd).toBeCloseTo(0.7, 9);
    expect(s2.total.inputTokens).toBe(130);
  });
});

describe("localDateString", () => {
  it("uses LOCAL calendar components, not UTC (late-evening runs stay today)", () => {
    // 23:30 local on 2026-07-06 is already 2026-07-07 in UTC+ timezones —
    // the bucket must follow the user's wall clock.
    expect(localDateString(new Date(2026, 6, 6, 23, 30))).toBe("2026-07-06");
    expect(localDateString(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});

describe("formatCostBucket", () => {
  it("formats priced buckets as dollars", () => {
    expect(
      formatCostBucket({
        usd: 0.1234,
        inputTokens: 1,
        outputTokens: 1,
        unpricedRuns: 0,
      }),
    ).toBe("$0.123");
  });

  it("flags partially-unpriced buckets", () => {
    expect(
      formatCostBucket({
        usd: 0.5,
        inputTokens: 1,
        outputTokens: 1,
        unpricedRuns: 2,
      }),
    ).toBe("$0.500 (+2 unpriced)");
  });

  it("falls back to token counts when nothing was priced", () => {
    expect(
      formatCostBucket({
        usd: 0,
        inputTokens: 2600,
        outputTokens: 500,
        unpricedRuns: 3,
      }),
    ).toBe("3.1k tok");
  });

  it("an empty bucket reads as zero dollars", () => {
    expect(
      formatCostBucket({
        usd: 0,
        inputTokens: 0,
        outputTokens: 0,
        unpricedRuns: 0,
      }),
    ).toBe("$0.000");
  });
});
