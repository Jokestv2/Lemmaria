import type { ProposedEdit } from "@lemmaria/harness";

/**
 * What a per-file proposal row shows the moment it is decided (D2 / CHAT-5,
 * ADR 0037 §5).
 *
 * **The diagnosis, established by reading the code before anything was
 * changed** — the reported symptom is a latency, which no test can produce:
 *
 * - **(a), the primary cause.** `decideAll` writes into the local `editChoices`
 *   map and re-renders, and the buttons are replaced by a static span — but
 *   the row's glyph and label still came from `summarizeEditGroup` over the
 *   SERVER status, which is still `pending`. No spinner, no disabled state, no
 *   "applying". The row kept saying pending until the host echoed a new
 *   `item.completed` after the write-through-buffer save. On a single-file
 *   proposal, which is the common case, that is the whole defect.
 * - **(b), a real second defect on multi-file batches.** `maybePostDecisions`
 *   returns without posting unless every pending edit has a choice, so
 *   accepting file 1 of 3 posts nothing — and said nothing about why.
 *
 * (a) is answered by the optimistic view below; (b) by `waitingFor`.
 *
 * **What is deliberately NOT changed: the all-or-nothing post.** Codex approves
 * all-at-once per patch and has no per-file approve at all. Lemmaria's per-file
 * *granularity* is A1b's manual-test finding and stays, but the *transaction*
 * stays one batch — making it incremental would change apply semantics, which
 * is invariant 3 and outside a presentation milestone.
 */

export interface EditChoice {
  accept: boolean;
  note?: string;
}

/**
 * What the user has chosen about a proposal's edits, in TWO layers.
 *
 * **`live`** is the collecting layer: `maybePostDecisions` posts only once
 * every pending index has an entry, so this is what gates the round trip.
 *
 * **`posted`** is what the first cut of D2 did not have, and the code review
 * caught. Posting deletes the live entry — and the re-render that follows in
 * the same tick is the *one* render the optimistic state exists for. On a
 * single-file proposal, which is the common case, the row therefore went
 * straight back to `● pending` with its buttons: byte-identical to the pre-D2
 * behaviour CHAT-5 exists to fix.
 *
 * **It needs no expiry of its own**, which is what keeps an optimistic row
 * from getting stuck: `groupDecisionView` refuses to override any settled
 * status, so the host's `applied` / `rejected` / `stale` echo retracts it —
 * Lemmaria's equivalent of Codex's `dismiss_resolved_request`. It is cleared
 * outright wherever the transcript itself is (reset, replay).
 */
export interface DecisionMemory {
  live: Map<string, Map<number, EditChoice>>;
  posted: Map<string, Map<number, EditChoice>>;
}

export function createDecisionMemory(): DecisionMemory {
  return { live: new Map(), posted: new Map() };
}

/** The collecting map for one proposal, created on first use. */
export function liveChoices(
  mem: DecisionMemory,
  itemId: string,
): Map<number, EditChoice> {
  const found = mem.live.get(itemId);
  if (found) return found;
  const fresh = new Map<number, EditChoice>();
  mem.live.set(itemId, fresh);
  return fresh;
}

/**
 * The choices collected but NOT yet posted for one proposal, or `undefined`.
 *
 * This is what gates the round trip — a batch posts only once every pending
 * index is in here. Distinct from `choiceAt`, which also sees what has already
 * gone, and that difference is the whole two-layer design: reading the wrong
 * one here would re-post a decided batch on the next render.
 */
export function pendingChoices(
  mem: DecisionMemory,
  itemId: string,
): Map<number, EditChoice> | undefined {
  return mem.live.get(itemId);
}

/** The user's choice for one edit, live first, then what was posted. */
export function choiceAt(
  mem: DecisionMemory,
  itemId: string,
  index: number,
): EditChoice | undefined {
  return mem.live.get(itemId)?.get(index) ?? mem.posted.get(itemId)?.get(index);
}

/**
 * Move a proposal's collected choices to the posted layer. Called at the post,
 * so the live map stops gating — a posted batch left in `live` would be
 * re-posted by the next render.
 */
export function rememberPosted(mem: DecisionMemory, itemId: string): void {
  const live = mem.live.get(itemId);
  if (live) mem.posted.set(itemId, new Map(live));
  mem.live.delete(itemId);
}

export function forgetDecisions(mem: DecisionMemory): void {
  mem.live.clear();
  mem.posted.clear();
}

export interface GroupDecisionInput {
  /** What `summarizeEditGroup` says, which stays the one home for that fold. */
  serverStatus: ProposedEdit["status"];
  /**
   * The choice the user has made about this file, from either layer of the
   * `DecisionMemory` above. Reading it rather than caching a "decided" flag is
   * what lets the host's echo end the optimistic view without bookkeeping.
   */
  localChoice?: { accept: boolean };
  /** Files in this batch still undecided, so the post is still blocked. */
  undecidedRemaining?: number;
}

export interface GroupDecisionView {
  status: ProposedEdit["status"];
  /** True when `status` is the user's choice rather than the server's word. */
  optimistic: boolean;
  /** How many other files this row is waiting on; 0 when it is not. */
  waitingFor: number;
}

export function groupDecisionView(
  input: GroupDecisionInput,
): GroupDecisionView {
  const { serverStatus, localChoice, undecidedRemaining = 0 } = input;
  // Only a still-pending edit may be shown optimistically. `stale`, `invalid`,
  // `applied` and `rejected` are the server's settled word, and a click cannot
  // make a stale edit fresh — saying otherwise is a lie the user acts on.
  if (localChoice === undefined || serverStatus !== "pending") {
    return { status: serverStatus, optimistic: false, waitingFor: 0 };
  }
  return {
    status: localChoice.accept ? "applied" : "rejected",
    optimistic: true,
    waitingFor: undecidedRemaining,
  };
}
