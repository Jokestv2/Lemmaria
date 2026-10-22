/**
 * A5 — the one fold from a session's event stream to its total usage.
 *
 * A session's spend has THREE persisted carriers, and all three are needed:
 *   - `turn.completed.usage` — the parent model call for that turn;
 *   - `SubtaskItem.usage` — a fan-out's children (A3). Child usage is accrued
 *     into the task total and stored on the item, and never reaches a turn
 *     event, so a turn-only fold under-reports every session that fanned out.
 *   - `CompactionItem.usage` — the summarization call (A2). Same story: it is
 *     a real, paid call outside any turn, and often a large one (it reads the
 *     whole conversation), so ignoring it under-reports every long session.
 * They do not overlap: a turn event reports `result.usage` for that one call.
 *
 * All three are persisted, so a session's spend is derivable from its JSONL
 * with no contract change: nothing is stored on `SessionMeta`, and the session
 * LISTING therefore shows no cost (that would need a cached aggregate, i.e. an
 * ADR). `replayEntries` deliberately drops turn events, so callers fold
 * ENTRIES.
 *
 * **ADR 0027 made this the one fold it left whole-session rather than
 * branch-scoping**, because tokens spent on a branch the user walked away from
 * were really paid for, and ADR 0018 had already decided that "rewinding does
 * not un-charge tokens already spent — cost history is deliberately not
 * rewritten". **ADR 0057 keeps the rule and moves where it bites:** the
 * abandoned tail is now a session of its own and keeps its own spend, while a
 * fork inherits the prefix's, because the copied records are its records.
 * Nothing is double-counted within a session and nothing is erased by a
 * rewind; what E5 does NOT do is subtract the shared prefix when a reader adds
 * two sessions together (ADR 0057 §7).
 */
import type { Usage } from "../contracts/adapters.js";
import type { SessionEntry } from "../contracts/sessions.js";

export interface SessionUsageTotal extends Usage {
  /**
   * Model calls that reported tokens but **no price**. When this is non-zero
   * alongside a `costUsd`, the dollar figure is a PARTIAL sum — it covers the
   * priced calls only, and the session really cost more. The UI must disclose
   * that rather than presenting the partial sum as the complete spend; a
   * number that is quietly too small is worse than no number at all.
   */
  unpricedCalls: number;
}

/**
 * Sum every paid model call in the session. `costUsd` is **omitted** unless at
 * least one call priced its own — a BYOK or local model reports tokens with no
 * price (ADR 0002), and a zeroed total would read as "this was free" rather
 * than "unknown". A mixed session sums the priced calls and reports how many
 * were unpriced, so the reader is never shown a partial total as a complete one.
 */
export function sumSessionUsage(
  entries: readonly SessionEntry[],
): SessionUsageTotal {
  let inputTokens = 0;
  let outputTokens = 0;
  let unpricedCalls = 0;
  let costUsd: number | undefined;
  const add = (usage: Usage | undefined): void => {
    if (!usage) return;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (usage.costUsd === undefined) unpricedCalls += 1;
    else costUsd = (costUsd ?? 0) + usage.costUsd;
  };
  for (const { event } of entries) {
    if (event.type === "turn.completed") add(event.usage);
    else if (event.type === "item.completed") {
      if (event.item.type === "subtask") add(event.item.usage);
      else if (event.item.type === "compaction") add(event.item.usage);
    }
  }
  return {
    inputTokens,
    outputTokens,
    unpricedCalls,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
