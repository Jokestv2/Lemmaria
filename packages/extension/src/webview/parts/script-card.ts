import type { SessionLocale } from "@lemmaria/harness";
import { tr } from "./strings.js";

/**
 * The `run_script` output fold (D2 / CHAT-4, ADR 0037 §5).
 *
 * `tool_call` rows have been `<details>` folds since A1a while script output
 * was appended as always-open `<pre>` blocks — so a script printing thousands
 * of lines floods the transcript while a `grep_project` over the same data
 * folds away. Worse, `.lm-script__out` has **no CSS rule at all**, so those
 * blocks render at UA defaults: no wrap, no scroll, no height bound.
 *
 * The fix is to reuse the tool row's shape verbatim, which brings its CSS with
 * it (`.lm-tool__raw`: `white-space: pre-wrap`, `max-height: 240px`,
 * `overflow-y: auto`).
 */

/** The part of a `ScriptRunItem` this fold reads. */
export interface ScriptOutput {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "denied";
  stdout?: string;
  stderr?: string;
  /** null when the process was killed before exiting. */
  exitCode?: number | null;
  truncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
}

/**
 * Collapsed on success, open on failure.
 *
 * A deliberate divergence from both references: Codex elides to five lines and
 * Pi hides all but the last five behind an expand key, and **neither
 * auto-expands on a non-zero exit** — both spend their strongest visual signal
 * on it instead. Lemmaria opens it, because a failure is the one case where
 * the user does want to read the output, and the cost of a click is highest
 * while debugging.
 *
 * `exitCode: null` (killed by an interrupt or a timeout) opens too: how far it
 * got is exactly what a collapsed fold would hide. A missing exit code on an
 * otherwise-successful run does not — that is a run that reported nothing to
 * be alarmed about.
 */
export function scriptFoldOpen(item: ScriptOutput): boolean {
  if (item.status === "failed" || item.status === "denied") return true;
  if (item.exitCode === undefined) return false;
  return item.exitCode !== 0;
}

/**
 * Folds the user has opened or closed by hand, keyed by item id.
 *
 * The transcript re-renders on EVERY streamed delta and rebuilds the DOM with
 * `replaceChildren`, so without this a fold opened to read a script's output
 * snaps shut on the next token — and a failure fold closed on purpose
 * re-opens. Collapsed-by-default makes opening the fold the intended way to
 * read output, so remembering the gesture is what makes CHAT-4 usable rather
 * than merely tidy.
 */
export type FoldMemory = Map<string, boolean>;

/**
 * The fold, or `undefined` when the run produced no output at all — an empty
 * `<details>` is worse than none.
 */
export function scriptOutputFold(
  item: ScriptOutput,
  locale: SessionLocale,
  opened?: FoldMemory,
): HTMLElement | undefined {
  const hasOut = (item.stdout ?? "") !== "";
  const hasErr = (item.stderr ?? "") !== "";
  if (!hasOut && !hasErr) return undefined;

  const parts: string[] = [tr(locale, "scriptOutput")];
  if (item.exitCode !== undefined && item.exitCode !== null) {
    parts.push(`${tr(locale, "scriptExit")} ${item.exitCode}`);
  } else if (item.exitCode === null) {
    parts.push(tr(locale, "scriptKilled"));
  }
  // Only for a stream that actually carries something: the counts are always
  // present on a terminal item (`ScriptRunResult` reports them as required
  // numbers), so reporting both unconditionally would append a bare `err 0` to
  // every successful run.
  const bytes: string[] = [];
  if (hasOut && item.stdoutBytes !== undefined) {
    bytes.push(`${tr(locale, "scriptStdout")} ${item.stdoutBytes}`);
  }
  if (hasErr && item.stderrBytes !== undefined) {
    bytes.push(`${tr(locale, "scriptStderr")} ${item.stderrBytes}`);
  }
  if (bytes.length > 0) {
    parts.push(`${bytes.join(" / ")} ${tr(locale, "scriptBytes")}`);
  }
  // B4 already put `truncated` on the item and nothing ever rendered it. A fold
  // that shows a byte count without saying the capture was cut is a worse lie
  // than the un-folded block was.
  if (item.truncated === true) parts.push(tr(locale, "scriptTruncated"));

  const fold = document.createElement("details");
  fold.className = "lm-msg lm-msg-tool";
  // The user's own gesture wins over the default, and survives the re-render
  // that every streamed delta triggers.
  const byDefault = scriptFoldOpen(item);
  fold.open = opened?.get(item.id) ?? byDefault;
  if (opened) {
    // Only a real gesture is recorded. Setting `.open` on a fresh <details>
    // queues a `toggle`, and the listener below is attached in time to receive
    // it — so without this guard the map would fill with defaults it had not
    // been asked to remember, and the comment above would be false.
    fold.addEventListener("toggle", () => {
      if (fold.open === byDefault && !opened.has(item.id)) return;
      opened.set(item.id, fold.open);
    });
  }

  const head = document.createElement("summary");
  head.className = "lm-tool__head";
  head.textContent = parts.join(" · ");
  fold.append(head);

  // `textContent`, never `innerHTML`: a script prints whatever it likes, and
  // the webview CSP carries no 'unsafe-inline' to fall back on.
  if (hasOut) {
    const out = document.createElement("pre");
    out.className = "lm-tool__raw lm-script__out";
    out.textContent = item.stdout ?? "";
    fold.append(out);
  }
  if (hasErr) {
    const err = document.createElement("pre");
    err.className = "lm-tool__raw lm-script__out lm-script__err";
    err.textContent = item.stderr ?? "";
    fold.append(err);
  }
  return fold;
}
