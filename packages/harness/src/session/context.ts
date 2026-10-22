import type { ChatMessage, Usage } from "../contracts/adapters.js";
import type { SessionEntry } from "../contracts/sessions.js";
import { estimateTokens } from "../text/truncate.js";

/**
 * Context-window accounting for the pre-A2 honest stop (ADR 0015): the
 * Codex-style *reactive measured* check — occupancy is what the API reported
 * for the last turn, never a forecast. A2 upgrades the same trigger into
 * compaction.
 *
 * Windows are keyed by model-id prefix (the `KNOWN_MODEL_PRICING` matching
 * discipline). Values are deliberately conservative floors, not marketing
 * maxima — an unknown model gets `DEFAULT_CONTEXT_WINDOW`, chosen low enough
 * that stopping early beats a mid-turn hard API error.
 */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  "gpt-4o": 128_000,
  "gpt-4-": 128_000,
  "gpt-5": 272_000,
  // ADR 0090 §2: OpenAI publishes 1,050,000, and the floor is the gpt-5 row's
  // instead — the family's input cap, the edge of the short-context rate card
  // (2× input above it), and the largest window ADR 0048's skill-catalogue
  // budget was sized against. The full id: no sibling is claimed.
  "gpt-6-luna": 272_000,
  o1: 200_000,
  o3: 200_000,
  deepseek: 128_000,
};

/** Conservative fallback for models the table does not know. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Stop threshold as a fraction of the window (Codex's auto-compact default). */
export const CONTEXT_STOP_FRACTION = 0.9;

/** Longest-prefix match against the known-windows table. */
export function contextWindowFor(model: string): number {
  let best: { prefix: string; window: number } | undefined;
  for (const [prefix, window] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (
      model.startsWith(prefix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { prefix, window };
    }
  }
  return best?.window ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Occupancy after a turn = that turn's inputTokens + outputTokens — the
 * input covers the whole history sent, so this measures the live context.
 */
export function tokensInWindow(lastTurnUsage: Usage): number {
  return lastTurnUsage.inputTokens + lastTurnUsage.outputTokens;
}

/**
 * The last MEASURED occupancy on a persisted BRANCH, or undefined when there
 * is nothing honest to report.
 *
 * Occupancy is pushed to the UI on turn boundaries only, so it lives in host
 * memory — and a window reload restarts that host. The persisted stream is the
 * only other record of it, and this is the one fold that reads it back.
 *
 * Scoped to ONE session's entries. Under ADR 0027 that mattered because a
 * whole-file scan would find whichever branch was written last, and the ring
 * would report a branch the user was not on. ADR 0057 deleted the branches and
 * the property survives for a simpler reason: a rewind now forks, so the file
 * this reads holds only the turns the user is actually on, and a whole-file
 * scan IS the scan we want.
 *
 * Scanned backwards, and a compaction ENDS the scan: after one, the live
 * context is a summary far smaller than anything the turns before it measured,
 * so the newest turn figure would overstate it. Unknown beats stale — the ring
 * shows "—", exactly as the live path does after a compaction.
 */
export function lastMeasuredOccupancy(
  entries: readonly SessionEntry[],
): number | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const event = entries[i]?.event;
    if (!event) continue;
    if (event.type === "item.completed" && event.item.type === "compaction") {
      return undefined;
    }
    if (event.type === "turn.completed" && event.usage) {
      return tokensInWindow(event.usage);
    }
  }
  return undefined;
}

/**
 * Estimated occupancy of a request, for the providers that report none
 * ([ADR 0051](../../../../Lemmaria-design-doc/docs/adr/0051-the-compaction-trigger-falls-back-to-an-estimate.md)).
 *
 * The input is the same thing the provider would have billed — the assembled
 * request, system envelope included — so this measures the live context in the
 * same sense `tokensInWindow` does, from the other side.
 *
 * **Deliberately an under-count.** It counts message text and not tool-call
 * JSON, reasoning blocks or per-message protocol overhead. That makes the
 * trigger fire LATE, never early: a provider that does report usage is
 * unaffected, and one that does not gets compaction somewhat after the ideal
 * point instead of never. Early is the dangerous direction — it would compact
 * sessions that still had room.
 */
/**
 * What one LIVE page image costs a request (V3, ADR 0080 §5).
 *
 * S6 measured ~2,153 provider-reported input tokens for a page at 1100 px on
 * the enabled pin; Anthropic's published pixels ÷ 750 rule gives ~2,090 for the
 * same page. One constant for every provider, because the two agree closely
 * enough that a per-provider table would be precision with no consumer — and
 * because with view-then-evict at most one batch's pages are ever live.
 *
 * **V3's own live rows then measured ~3,950, and this constant was NOT moved.**
 * T12's `pdf-marker` row reports 3,987 input tokens for a request whose prompt
 * is two sentences and one page at this width — so the figure above is roughly
 * 45 % low against the only end-to-end reading anyone has taken, and the two
 * estimates it cites agreeing with each other turns out to say nothing about
 * whether either is right.
 *
 * It stays 2,200 for this function's own stated reason, three paragraphs up:
 * **this estimate is deliberately an under-count, and late is the safe
 * direction.** Eviction bounds the error at one batch — at most six live parts,
 * so under ~10k tokens unaccounted — and raising the constant on one reading
 * from one pin would trade a known-safe bias for a guess. What it does owe is
 * to be *recorded* rather than quietly contradicted: it is a deliberate limit
 * in `known-limits.md` with its own revisit trigger, and the first thing to
 * re-measure if `PDF_RENDER_WIDTH_PX` ever moves.
 */
export const IMAGE_TOKEN_ESTIMATE = 2_200;

export function estimateWindowTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content);
    // Only a part that still has its pixels costs anything: an EVICTED part
    // reaches the wire as a short text placeholder, which the text estimate
    // above does not see but which is worth a handful of tokens at most.
    for (const image of message.images ?? []) {
      if (image.data !== undefined) total += IMAGE_TOKEN_ESTIMATE;
    }
  }
  return total;
}

/**
 * The occupancy the compaction trigger acts on: the measurement when there is
 * one, the estimate when there is not (ADR 0051).
 *
 * **A reported ZERO is not a measurement.** `openai-compatible` maps a missing
 * `usage` block to `{ inputTokens: 0, outputTokens: 0 }`, so the silence
 * arrives wearing a number and is truthy — which is how it slipped past the
 * old `priorUsage &&` guard. A completed turn always consumed input, because
 * the history was sent, so `inputTokens === 0` means "not reported". Folded in
 * here rather than at each call site, so the two trigger sites cannot drift.
 *
 * This does NOT weaken ADR 0021 §5's stale-reading rule: the fallback is
 * computed from the CURRENT assembled history, never from an older turn's
 * number, so it cannot resurrect the reading that rule forbids. After a
 * checkpoint it is taken over the compacted history and is correspondingly
 * small.
 */
export function windowOccupancy(
  measured: Usage | undefined,
  messages: readonly ChatMessage[],
): number {
  if (measured && measured.inputTokens > 0) return tokensInWindow(measured);
  return estimateWindowTokens(messages);
}

/** True when occupancy has crossed the stop fraction of the model's window. */
export function contextLimitReached(
  occupiedTokens: number,
  model: string,
): boolean {
  return (
    occupiedTokens >=
    Math.floor(contextWindowFor(model) * CONTEXT_STOP_FRACTION)
  );
}
