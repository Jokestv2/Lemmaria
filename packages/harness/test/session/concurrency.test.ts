import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/session/concurrency.js";

describe("mapWithConcurrency (A3 fan-out concurrency)", () => {
  const defer = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("returns results in INPUT order regardless of completion order", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("runs at most `limit` workers at once, but starts ALL items (no drop)", async () => {
    let active = 0;
    let peak = 0;
    const gates = [defer(), defer(), defer(), defer(), defer()];
    const started: number[] = [];
    const run = mapWithConcurrency(gates, 2, async (g, i) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(i);
      await g.promise;
      active -= 1;
      return i;
    });
    // Let the first wave start, then release gates one at a time.
    await new Promise((r) => setTimeout(r, 0));
    expect(peak).toBe(2); // only two in flight at once
    for (const g of gates) {
      g.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await run).toEqual([0, 1, 2, 3, 4]); // every item ran
    expect(peak).toBe(2); // concurrency never exceeded the limit
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("a limit of 1 runs strictly serially, one at a time", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return n;
    });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n)).toEqual([
      1, 2,
    ]);
  });
});
