/**
 * Real script execution for the `run_script` tool (ADR 0020).
 *
 * Node `child_process.spawn` — argv only, `shell: false`, no shell parsing
 * (invariant 1 forbids `vscode` outside the extension package, not Node).
 * Output is byte-capped; the process TREE is killed on abort or timeout. Never
 * throws — a spawn failure or a kill resolves with `{ error }` and whatever
 * output was captured, so the harness loop can surface it as data.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ScriptRunResult } from "@lemmaria/harness";

export type { ScriptRunResult };

const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Grace after a kill before we force-settle so the promise can never hang. */
const DEFAULT_KILL_GRACE_MS = 2_000;

/** Kill a process and its tree, cross-platform (win32 has no POSIX groups). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      // A failed taskkill spawn surfaces as an async 'error' event, which the
      // try/catch cannot catch — fall back to a direct kill. A taskkill that
      // spawns but *exits non-zero* (e.g. the pid is gone, or access denied)
      // emits neither 'error' nor a useful signal to the child, so also fall
      // back on a non-zero exit (review #4).
      const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      tk.on("error", () => child.kill("SIGKILL"));
      tk.on("exit", (code) => {
        if (code !== 0) child.kill("SIGKILL");
      });
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // negative pid = the process group
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * A byte-bounded UTF-8 sink that keeps the **tail** (B4, ADR 0029).
 *
 * A4b kept the first `maxBytes` and dropped every later chunk. That is exactly
 * backwards for the case this capture exists to serve: a script that prints a
 * lot and then fails puts its traceback last, so the head cut threw away the
 * only part the model needed. The sink now retains a rolling window of the most
 * recent bytes and counts everything that ever arrived.
 *
 * Caps on encoded byte length (not UTF-16 code units, A4b review #6) so
 * multibyte output cannot exceed the documented limit. Because the window drops
 * whole leading BYTES, a drop can land inside a multibyte character; the decode
 * happens once at `value()` over the retained buffer, skipping any orphaned
 * UTF-8 continuation bytes at the front rather than emitting U+FFFD.
 */
function byteSink(maxBytes: number, onTruncate: () => void) {
  let retained: Buffer = Buffer.alloc(0);
  let total = 0;
  return {
    push(chunk: Buffer): void {
      total += chunk.length;
      retained =
        retained.length === 0 ? chunk : Buffer.concat([retained, chunk]);
      // Trim LAZILY, at twice the window (review, Important 2). Trimming on
      // every chunk copies up to `maxBytes` per `data` event, which is
      // quadratic in chunk count — and a line-buffered training script (the
      // motivating case) delivers tens of thousands of tiny chunks, so the
      // sink could burn the run's own 120 s timeout. Amortized this is O(1)
      // per byte, and memory stays bounded by 2× the window.
      if (retained.length > maxBytes * 2)
        retained = retained.subarray(retained.length - maxBytes);
      if (total > maxBytes) onTruncate();
    },
    bytes(): number {
      return total;
    },
    value(): string {
      // The lazy trim means up to 2× the window may still be held; the
      // documented cap is what we RETURN.
      const window =
        retained.length > maxBytes
          ? retained.subarray(retained.length - maxBytes)
          : retained;
      // A continuation byte is 0b10xxxxxx; skip any that lost their lead byte
      // to the window. At most 3 can precede a valid start byte.
      let start = 0;
      while (
        start < window.length &&
        start < 3 &&
        ((window[start] as number) & 0xc0) === 0x80
      )
        start += 1;
      const decoder = new StringDecoder("utf8");
      return decoder.write(window.subarray(start)) + decoder.end();
    },
  };
}

/**
 * Run argv (no shell) in cwd, capturing stdout/stderr with a byte cap, killing
 * the process tree on abort or timeout. Never throws (ADR 0020).
 */
export function spawnScript(
  argv: string[],
  cwd: string,
  opts: {
    signal?: AbortSignal;
    maxOutputBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<ScriptRunResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    let truncated = false;
    let settled = false;
    let killedReason: string | undefined;
    const markTruncated = () => {
      truncated = true;
    };
    const outSink = byteSink(maxBytes, markTruncated);
    const errSink = byteSink(maxBytes, markTruncated);

    const [command, ...commandArgs] = argv;
    if (command === undefined) {
      resolvePromise({
        stdout: "",
        stderr: "",
        exitCode: null,
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        error: "no command to run",
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, commandArgs, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", // own group for tree-kill (POSIX)
      });
    } catch (error) {
      resolvePromise({
        stdout: "",
        stderr: "",
        exitCode: null,
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        stdout: outSink.value(),
        stderr: errSink.value(),
        exitCode,
        truncated,
        stdoutBytes: outSink.bytes(),
        stderrBytes: errSink.bytes(),
        ...(killedReason !== undefined ? { error: killedReason } : {}),
      });
    };

    // Kill the tree, and arm a safety net: if the OS kill fails and 'close'
    // never fires, force-settle after a grace period so the promise can never
    // remain pending indefinitely (review #4).
    const killAndGuarantee = (reason: string): void => {
      killedReason = reason;
      killTree(child);
      if (!graceTimer)
        graceTimer = setTimeout(() => settle(null), DEFAULT_KILL_GRACE_MS);
    };

    const onAbort = (): void => killAndGuarantee("interrupted");
    const timer = setTimeout(
      () => killAndGuarantee(`timed out after ${timeoutMs} ms`),
      timeoutMs,
    );

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => outSink.push(d));
    child.stderr?.on("data", (d: Buffer) => errSink.push(d));
    child.on("error", (error) => {
      // The process never spawned (e.g. ENOENT) — record the cause, then settle.
      if (killedReason === undefined) killedReason = error.message;
      settle(null);
    });
    // When we killed the tree, the reported exit code is the kill's artifact
    // (win32 taskkill → 1, POSIX signal → null); report null honestly.
    child.on("close", (code) =>
      settle(killedReason !== undefined ? null : code),
    );
  });
}
