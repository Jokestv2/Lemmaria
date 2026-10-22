import type { SessionEntry } from "../contracts/index.js";

/**
 * Where a fork's copy stops, for a rewind at `itemId` (ADR 0057).
 *
 * The **index** of the first record whose `item.completed` carries the item —
 * so the copied prefix is `entries.slice(0, cut)` and the world it begins in is
 * `manifestAt(entries.slice(0, cut))`. `undefined` means no record carries that
 * item, and every caller **refuses** rather than widening the move (ADR 0018's
 * rule, carried forward through ADR 0027 and into ADR 0057).
 *
 * This is the successor to `nodeBeforeItem`, and the difference is the whole
 * point of ADR 0057: a session file is a linear log again, so the answer to
 * "where does this item start?" is a position, not a parent pointer. It stays
 * the one place the item-id space and the record space meet — callers keep
 * addressing items by the ids they already hold, and nothing stores a mapping
 * that could drift out of step with the log.
 *
 * The FIRST record wins deliberately: `edit_proposal`, `script_run` and
 * `subtask` items are persisted twice (pending, then terminal), and a rewind
 * past an item must land before it *appeared*, not before it *settled*.
 *
 * **`0` is a valid answer** — the item is the first record, and the copy is
 * empty. It is also falsy, so callers must test `=== undefined`, never `!cut`.
 */
export function cutBeforeItem(
  entries: readonly SessionEntry[],
  itemId: string,
): number | undefined {
  for (let i = 0; i < entries.length; i += 1) {
    const { event } = entries[i] as SessionEntry;
    if (event.type !== "item.completed") continue;
    if (event.item.id === itemId) return i;
  }
  return undefined;
}
