/**
 * Which stored review a card is compared against (V6, ADR 0088 §2).
 *
 * ADR 0087 §5 left it here on purpose: *"which stored review is previous is
 * V6's — the store is a flat array under a cap, with no chain."* The engine's
 * `scorecardDelta` decides whether two CARDS may be compared and how each row
 * moved; this decides which two.
 *
 * Pure, and free of `vscode` — the host's `ReviewState` carries a `vscode.Uri`,
 * so the input is the structural slice of it the rule reads, which a stored
 * review satisfies as it is.
 */
import type {
  Scorecard,
  ScorecardDelta,
  ScorecardSource,
} from "@lemmaria/harness";
import { scorecardDelta } from "@lemmaria/harness";

/** What the rule reads of one review: what `deriveScorecard` reads, which
 *  manuscript it is of, and the version stamp the picker shows. */
export interface ComparableReview extends ScorecardSource {
  mode: "quick" | "panel" | "pdf";
  /** The workspace root every span is relative to. */
  root: string;
  /** The workspace-relative entry — with `root`, the manuscript. */
  entry: string;
  /** Absent for a quick review and a panel from before versions. */
  version?: number;
}

export interface PreviousComparison {
  /** The review compared against, by its version, and whether the pair is
   *  comparable. `unmeasured` (present only when true) says the compared
   *  version's card had no contributor, so it measured nothing at all. */
  previous: { version: number; comparable: boolean; unmeasured?: true };
  /** `scorecardDelta(its card, the selected card)`. */
  delta: ScorecardDelta;
}

/**
 * Did any seat contribute to this card? Not when every seat failed, or when
 * the review was stored before a seat recorded its ledger (X5, ADR 0074 §8).
 * Such a card measured nothing, so it is never *the same panel* as another —
 * unknown is never same (ADR 0070 §4) — whatever the engine's comparison of
 * two empty reviewer lists says. The tab's `hasContributor` is the same test
 * (`parts/review-scorecard.ts`), for the same card.
 */
function measured(card: Scorecard): boolean {
  return card.panel.reviewers.length > 0 || card.panel.pdf !== undefined;
}

/** The two reasons that are facts about the PAIR — the same on every row they
 *  reach — as against `pdf` and `not_assessed`, which are one row's. */
function pairComparable(delta: ScorecardDelta): boolean {
  return !delta.dimensions.some(
    (d) =>
      !d.comparable &&
      (d.reason === "reviewers" || d.reason === "verification"),
  );
}

/**
 * The review `reviews[selected]` is compared against, or `undefined` on the
 * manuscript's first reading.
 *
 * 1. **Candidates** sit below `selected` in the array (oldest first, so
 *    position is production order), are VERSIONED — a quick review is
 *    unnumbered and its bare-result card is never comparable, so it is skipped
 *    rather than compared — and read the SAME manuscript (`root` and `entry`):
 *    the store is per workspace and mixes papers, and an arrow across two
 *    papers means nothing.
 * 2. Walking from the nearest backward, the **first comparable** candidate
 *    wins — the design's phrase is *the previous comparable version*, so an
 *    author who ran one panel on a bigger model and came back to the usual one
 *    still gets arrows. The tab names the version compared against, so a skip
 *    is never hidden.
 * 3. With candidates but none comparable, the **nearest**, marked not
 *    comparable — its delta rides along, since the rows' reasons are real.
 *
 * A candidate whose card measured nothing is never comparable, and is marked
 * `unmeasured` so the tab says that rather than *a different panel* (ADR
 * 0088 §2).
 *
 * `derive` is `deriveScorecard`, passed in so the host's one import is the one
 * this uses.
 */
export function previousComparable<R extends ComparableReview>(
  reviews: readonly R[],
  selected: number,
  derive: (review: R) => Scorecard,
): PreviousComparison | undefined {
  const current = reviews[selected];
  if (current === undefined) return undefined;
  let card: Scorecard | undefined;
  let nearest: PreviousComparison | undefined;
  for (let i = selected - 1; i >= 0; i--) {
    const candidate = reviews[i] as R;
    if (candidate.mode === "quick" || candidate.version === undefined) continue;
    if (candidate.root !== current.root || candidate.entry !== current.entry)
      continue;
    card ??= derive(current);
    const before = derive(candidate);
    const delta = scorecardDelta(before, card);
    const unmeasured = !measured(before);
    const comparable = !unmeasured && pairComparable(delta);
    const found = {
      previous: {
        version: candidate.version,
        comparable,
        ...(unmeasured ? { unmeasured: true as const } : {}),
      },
      delta,
    };
    if (comparable) return found;
    nearest ??= found;
  }
  return nearest;
}
