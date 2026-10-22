/**
 * The harness's ONE concurrency primitive.
 *
 * Extracted from `session/subtasks.ts` at B3, when it gained a second consumer:
 * A3's `spawn_subtask` fan-out (ADR 0022) and B3's parallel tool batch
 * (ADR 0025) bound their concurrency the same way, and `tool-batch.ts`
 * importing it from the `spawn_subtask` module would say something untrue about
 * the code.
 */

/**
 * Run `items` through `worker` with at most `limit` in flight at once, returning
 * the results in input order (A3, ADR 0022). This is the concurrency model for
 * `spawn_subtask`: `lemmaria.budget.maxFanOut` bounds how many children run
 * *concurrently*, not how many may be requested — the rest queue and start as
 * slots free up (the Codex `AgentExecutionLimiter` shape: a capacity, not a
 * silent truncation). A `limit` of 1 runs them strictly serially.
 *
 * **`worker` must never reject.** `Promise.all` below is an ordering/join
 * primitive, not a failure aggregator: one rejection would discard every
 * sibling's result, including calls that already completed and were charged to
 * a budget. Both callers wrap their per-item body in a total function
 * (ADR 0025 decision 8, and the same property Pi's parallel path depends on).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await worker(item, i);
    }
  };
  await Promise.all(Array.from({ length: width }, runner));
  return results;
}
