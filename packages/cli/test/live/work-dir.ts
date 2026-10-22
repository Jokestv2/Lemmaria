/**
 * Keeping a failed live run's evidence.
 *
 * `runEvalTask` never removes its working copy — its contract hands that call to
 * the caller precisely because "keep it or not" depends on whether the run
 * passed, and only the caller knows. A live test that removed the copy in a
 * `finally` therefore destroyed the transcript, the session store and the
 * resulting bytes of exactly the run worth looking at, and diagnosing a failure
 * meant paying for another nondeterministic run.
 *
 * So: keep the copy when the test fails and print where it is, remove it only on
 * the passing path. A persistent live failure is a real finding whose report
 * belongs in the gate record (ADR 0035 §5) — it needs the evidence attached.
 * A green run still leaks nothing.
 */

import { rm } from "node:fs/promises";
import { onTestFailed } from "vitest";

export interface LiveWorkDir {
  /** Record the working copy this test produced, as soon as it exists. */
  track: (workDir: string) => void;
  /** Remove it. Call only where the test has finished asserting successfully. */
  discard: () => Promise<void>;
}

/**
 * Call at the TOP of a live test, before the run starts — `onTestFailed` has to
 * be registered while the test is running, and registering it first is what
 * makes a failure *inside* the run report something sensible rather than
 * nothing.
 */
export function liveWorkDir(): LiveWorkDir {
  let workDir: string | undefined;

  onTestFailed(() => {
    console.error(
      workDir === undefined
        ? "live run failed before a working copy existed — nothing to inspect"
        : `live run kept for inspection: ${workDir}`,
    );
  });

  return {
    track(dir: string) {
      workDir = dir;
    },
    async discard() {
      if (workDir === undefined) return;
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // A locked file on Windows is not a reason to fail a passing live run
        // (the same trade `runFlagshipEval` makes).
      }
      workDir = undefined;
    },
  };
}
