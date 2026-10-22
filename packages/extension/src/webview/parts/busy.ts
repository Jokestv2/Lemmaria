import type { NoticeItem } from "@lemmaria/harness";

/**
 * When the transcript's "Thinking…" row is shown (D2 / CHAT-3, ADR 0037 §5).
 */

export interface BusyState {
  /** True from `task.started` / `turn.started` until `task.completed`. */
  sessionBusy: boolean;
  /** A1b: the loop is paused on an edit decision the user has not made. */
  awaitsEditDecision: boolean;
  /** A4b: the loop is paused on a script approval. */
  awaitsScript: boolean;
  /**
   * The CURRENT turn has put text on screen. **`nextTurnStreamed` below is the
   * one home for when this is set and cleared** — do not restate its
   * transitions here; an earlier version of this comment named only one of
   * them and went stale the moment a second was added.
   */
  turnStreamed: boolean;
}

/**
 * The busy row means *"nothing is happening on screen yet"*. It is therefore
 * suppressed by anything that puts something on screen instead: a pending edit
 * decision (A1b), a pending script approval (A4b), and — new in D2 — the
 * answer itself, from its first streamed delta.
 *
 * Adapted from Codex, which hides its status row at the first committed stream
 * cell; diverged from Pi, whose spinner persists for the whole turn and so
 * sits under visibly-arriving text. Two concurrent "I am busy" affordances
 * read as a bug.
 */
export function busyRowVisible(s: BusyState): boolean {
  return (
    s.sessionBusy && !s.awaitsEditDecision && !s.awaitsScript && !s.turnStreamed
  );
}

/** The shape of a `SessionEvent` this rule reads. */
export interface StreamFlagEvent {
  type: string;
  item?: { type: string; code?: NoticeItem["code"] | string };
}

/**
 * The notice that says a turn is being retried — and therefore that
 * `dropUncompletedItems` is about to take the partial answer off screen.
 *
 * ONE home, because it is read twice: here, to clear `turnStreamed`, and in
 * `main.ts`, to do the dropping. `code` is typed against the contract's own
 * union, so renaming the notice breaks the build rather than silently leaving
 * one of the two halves behind with the suite still green.
 */
export function isStreamRetried(event: StreamFlagEvent): boolean {
  const retried: NoticeItem["code"] = "stream.retried";
  return (
    event.type === "item.completed" &&
    event.item?.type === "notice" &&
    event.item.code === retried
  );
}

/**
 * `turnStreamed` after one session event — the whole rule, in one place.
 *
 * Four transitions, and the third is the one the code review caught missing:
 *
 * 1. **`task.started` / `turn.started` → false.** A new turn has nothing on
 *    screen yet. This is also Codex's deferred restore, for free: the row
 *    comes back because the same event that sets `sessionBusy` clears this.
 * 2. **an `agent_message` item → true.** The answer is arriving, and the text
 *    itself is the progress indicator.
 * 3. **`stream.retried` → false.** The retry loop lives INSIDE the turn, so
 *    no `turn.started` follows it — but `dropUncompletedItems` has just taken
 *    the partial answer out of the transcript. Left set, the busy row would
 *    stay suppressed through the backoff and the retried attempt with nothing
 *    on screen at all: CHAT-3's own failure mode, inverted.
 * 4. **`task.completed` → false.** Nothing is in flight; `sessionBusy` also
 *    clears, so this only matters for a replay that reads the flag after.
 */
export function nextTurnStreamed(
  current: boolean,
  event: StreamFlagEvent,
): boolean {
  if (event.type === "task.started" || event.type === "turn.started")
    return false;
  if (event.type === "task.completed") return false;
  if (isStreamRetried(event)) return false;
  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.item?.type === "agent_message"
  )
    return true;
  return current;
}

/**
 * `turnStreamed` for a transcript that arrives as a SNAPSHOT rather than as a
 * stream — a `transcriptReplay` after a window reload, where the live flag was
 * lost with the page.
 *
 * The newest item being an `agent_message` is what "text is already on screen
 * for the turn in flight" looks like from a snapshot. Deriving it beats
 * defaulting to `false`, which would put the busy row back underneath an
 * answer the user can already read — the exact defect CHAT-3 is about,
 * re-introduced by the reload path.
 */
export function turnStreamedFromSnapshot(
  items: readonly { readonly type: string }[],
): boolean {
  return items.at(-1)?.type === "agent_message";
}
