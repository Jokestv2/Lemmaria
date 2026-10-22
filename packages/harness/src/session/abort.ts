/**
 * Race a host decision against the task's AbortSignal (ADR 0016): a wedged
 * or slow host cannot wedge an interrupted task, and a rejecting host
 * degrades to "no decisions" (→ stale) rather than a loop throw.
 *
 * Shared by the two loop-injected tools that pause on a human (`propose_edit`,
 * `run_script`); extracted from `run.ts` at B1.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (!signal) return promise.catch(() => undefined);
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      },
    );
  });
}
