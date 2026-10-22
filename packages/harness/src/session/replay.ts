import type {
  GrantedRoot,
  SessionEntry,
  SessionItem,
  SessionLocale,
} from "../contracts/index.js";
import { messagesFor } from "./messages.js";

/**
 * Fold ONE SESSION's entries into the transcript item list a UI renders (ADR
 * 0014, reshaped by ADR 0027 and again by ADR 0057, which deleted the tree it
 * was a branch of). `item.started`/`item.updated`/`item.completed` upsert
 * by item id — the last event for an id wins; order is first appearance. Pure:
 * used by the store's load(), the runner's return value, and mirrored by the
 * webview transcript.
 *
 * There is no rewind case any more. A rewind used to be a folded instruction
 * (`{type:"rewound"}` truncated the live list, and the tail became unreachable
 * forever); it is now structural — the abandoned tail is simply not among the
 * entries this fold was handed, and is still readable in the session it was
 * written to (ADR 0057).
 *
 * ADR 0016 normalization: an edit_proposal's non-terminal statuses
 * (`pending`/`accepted`) become `stale` — a persisted transcript can only
 * carry those mid-decision states if the process died mid-pause, and an
 * undecided proposal replays stale, never dangling, never auto-applied. The
 * live webview fold deliberately does NOT mirror this rule (live pending
 * statuses are what the approval UI renders).
 */
export function replayEntries(
  entries: readonly SessionEntry[],
  /** X2 (ADR 0034): the language a replayed note renders in. Defaults to English. */
  locale?: SessionLocale,
): SessionItem[] {
  const msg = messagesFor(locale);
  const order: string[] = [];
  const byId = new Map<string, SessionItem>();
  for (const { event } of entries) {
    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      if (!byId.has(event.item.id)) order.push(event.item.id);
      byId.set(event.item.id, event.item);
    }
  }
  const items: SessionItem[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) items.push(normalizeUndecided(item, msg));
  }
  return items;
}

/**
 * Fold the transcript's grant_update items into the currently-active grant
 * set (ADR 0019). Add is ignored for an already-active id; revoke for an
 * unknown id is a no-op. Order = grant order (first added first).
 *
 * Session-scoped for free, because it consumes the items `replayEntries`
 * produced. ADR 0027 got that from the branch walk; since ADR 0057 it falls
 * out of there being one line of entries — and a fork inherits the grants that
 * stood at its cut, because `fork` copies their records with the prefix.
 */
export function activeGrants(items: readonly SessionItem[]): GrantedRoot[] {
  const byId = new Map<string, GrantedRoot>();
  for (const item of items) {
    if (item.type !== "grant_update") continue;
    if (item.action === "added") {
      if (!byId.has(item.grant.id)) byId.set(item.grant.id, item.grant);
    } else {
      byId.delete(item.grant.id);
    }
  }
  return [...byId.values()];
}

/**
 * Normalize an item persisted in a non-terminal state (a process death
 * mid-decision/mid-run replays honestly): an undecided edit_proposal's edits
 * become `stale` (ADR 0016); an undecided script_run becomes `failed`
 * (ADR 0020) — never a phantom success, never dangling.
 */
function normalizeUndecided(
  item: SessionItem,
  msg: ReturnType<typeof messagesFor>,
): SessionItem {
  if (item.type === "edit_proposal") {
    if (
      !item.edits.some((e) => e.status === "pending" || e.status === "accepted")
    ) {
      return item;
    }
    return {
      ...item,
      edits: item.edits.map((e) =>
        e.status === "pending" || e.status === "accepted"
          ? {
              ...e,
              status: "stale" as const,
              // Say WHY. A bare `stale` renders as "the file changed", which is
              // the wrong story here — the file is untouched; the window (or
              // the process) went away while this batch waited on the user.
              note: e.note ?? msg.editSessionEnded,
            }
          : e,
      ),
    };
  }
  if (
    item.type === "script_run" &&
    (item.status === "pending" || item.status === "running")
  ) {
    return {
      ...item,
      status: "failed" as const,
      note: item.note ?? msg.scriptInterruptedBeforeCompletion,
    };
  }
  // A3: a subtask still `running` at replay = a fan-out that never settled
  // (process death mid-fan-out) — fail it honestly, never a phantom success.
  if (item.type === "subtask" && item.status === "running") {
    return { ...item, status: "failed" as const };
  }
  if (item.type === "review") {
    // R9 (ADR 0069 §D4, A22): `model` is REQUIRED on a seat row, and a
    // `review` item persisted before R9 has none. `""` is the honest answer —
    // every surface renders the model by exception — and it is the
    // alternative to a migration path, which this build does not do.
    //
    // Normalized on EVERY replayed review, not only a running one. It used to
    // sit inside the `running` branch below, which left a pre-R9 review
    // persisted as `completed` carrying `undefined` — and that is exactly the
    // review a reader opens from the tab's picker. Two readers guard on `""`
    // alone and would have rendered `· undefined`; making the ADR's *"every
    // reader omits the segment"* true is this line's job, not theirs.
    const withModel = <T extends { model?: string }>(s: T): T => ({
      ...s,
      model: s.model ?? "",
    });
    const seats = item.seats.map(withModel);
    const normalized = {
      ...item,
      seats,
      ...(item.synthesisSeat
        ? { synthesisSeat: withModel(item.synthesisSeat) }
        : {}),
      // V1 (ADR 0076 §7): the verifier's sibling row, the same way. A review
      // persisted before V1 has none and replays unchanged.
      ...(item.verifierSeat
        ? { verifierSeat: withModel(item.verifierSeat) }
        : {}),
    };
    // R3 (ADR 0061 §9): a panel left running never settled — fail it honestly.
    // Its SEATS are failed too: a seat row still saying `running` under a
    // failed panel would show a review that is still working inside one that
    // is not.
    if (item.status !== "running") return normalized;
    return {
      ...normalized,
      status: "failed" as const,
      seats: seats.map((s) =>
        s.status === "running" ? { ...s, status: "failed" as const } : s,
      ),
    };
  }
  return item;
}
