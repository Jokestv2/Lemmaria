/**
 * V6 (ADR 0088 §2, plan D2, O20): which stored review a card is compared
 * against.
 *
 * `previousComparable` is pure and imports no `vscode`, so these records are
 * plain literals in the shape the host's `ReviewState` carries — the fields
 * `deriveScorecard` reads, plus the manuscript (`root` + `entry`) and the
 * version stamp. Oldest first, as the host holds them.
 */
import * as assert from "node:assert";
import type {
  ReviewResult,
  ReviewSeatState,
  StoredReview,
} from "@lemmaria/harness";
import { deriveScorecard, scorecardDelta } from "@lemmaria/harness";
import {
  type ComparableReview,
  previousComparable,
} from "../src/review-previous";

const ROOT = "/papers/corridor";

/** A report's counts. A seat is a CONTRIBUTOR to the card only when it
 *  completed and wrote one (ADR 0087 §4) — without it every card here would
 *  be unmeasured, and any two unmeasured cards compare as the same panel. */
const LEDGER = {
  entries: 1,
  located: 1,
  relocated: 0,
  dropped: 0,
  rejected: 0,
};

const result: ReviewResult = {
  annotations: [
    {
      id: "reviewer_a-1",
      reviewer: "reviewer_a",
      dimension: "soundness",
      severity: "major",
      span: { file: "main.tex", line: 4 },
      message: "the exclusion restriction is never argued",
    },
  ],
};

const seats = (model: string): ReviewSeatState[] => [
  { reviewer: "reviewer_a", status: "completed", model, ledger: LEDGER },
  { reviewer: "reviewer_b", status: "completed", model, ledger: LEDGER },
];

/** A panel of two on `model`, of `entry`, stamped `version`. */
const panel = (
  version: number,
  model = "m1",
  entry = "main.tex",
): ComparableReview => ({
  mode: "panel",
  result,
  root: ROOT,
  entry,
  version,
  seats: seats(model),
});

/** A `/review-pdf` run: no text reviewers, one PDF seat on `model`. */
const pdfOnly = (version: number, model = "vision-1"): ComparableReview => ({
  mode: "pdf",
  result: {
    annotations: [
      {
        id: "pdf_reviewer-1",
        reviewer: "pdf_reviewer",
        dimension: "presentation",
        severity: "minor",
        span: { file: "main.tex", line: 1 },
        message: "the figure's axis labels are unreadable at print size",
      },
    ],
  },
  root: ROOT,
  entry: "main.tex",
  version,
  seats: [],
  pdfSeat: {
    reviewer: "pdf_reviewer",
    status: "completed",
    model,
    ledger: LEDGER,
  },
});

/** A quick review: no version, no seats. */
const quick: ComparableReview = {
  mode: "quick",
  result,
  root: ROOT,
  entry: "main.tex",
};

const choose = (reviews: readonly ComparableReview[], selected: number) =>
  previousComparable(reviews, selected, deriveScorecard);

/** The engine's own compare of two records' cards. */
function deriveDelta(
  before: ComparableReview,
  after: ComparableReview,
): ReturnType<typeof scorecardDelta> {
  return scorecardDelta(deriveScorecard(before), deriveScorecard(after));
}

suite("V6: which stored review is previous (O20, ADR 0088 §2)", () => {
  test("a manuscript's first reading has no previous", () => {
    assert.strictEqual(choose([panel(1)], 0), undefined);
  });

  test("the nearest earlier comparable version of the same manuscript", () => {
    const got = choose([panel(1), panel(2), panel(3)], 2);
    assert.deepStrictEqual(got?.previous, { version: 2, comparable: true });
    assert.deepStrictEqual(
      got?.delta,
      // Dependent on nothing but the two cards: the engine's own compare.
      deriveDelta(panel(2), panel(3)),
    );
  });

  test("another manuscript is never a candidate, whatever its panel", () => {
    const got = choose([panel(1), panel(2, "m1", "other.tex"), panel(3)], 2);
    assert.deepStrictEqual(got?.previous, { version: 1, comparable: true });
    // Same entry name under another root is another manuscript too.
    const elsewhere = { ...panel(2), root: "/papers/other" };
    assert.strictEqual(choose([elsewhere, panel(3)], 1), undefined);
  });

  test("a quick review between two versions is skipped, never compared", () => {
    const got = choose([panel(1), quick, panel(2)], 2);
    assert.deepStrictEqual(got?.previous, { version: 1, comparable: true });
    // And an unversioned review is no candidate even when it is the only one.
    assert.strictEqual(choose([quick, panel(1)], 1), undefined);
  });

  test("relative to the SELECTED review, not the newest", () => {
    const reviews = [panel(1), panel(2), panel(3)];
    assert.deepStrictEqual(choose(reviews, 1)?.previous, {
      version: 1,
      comparable: true,
    });
    assert.strictEqual(choose(reviews, 0), undefined);
  });

  test("the nearest COMPARABLE beats a nearer one on another model", () => {
    const got = choose([panel(1), panel(2, "bigger-model"), panel(3)], 2);
    assert.deepStrictEqual(got?.previous, { version: 1, comparable: true });
  });

  test("with no comparable candidate, the nearest one, marked not comparable", () => {
    const got = choose(
      [panel(1, "old-model"), panel(2, "bigger-model"), panel(3)],
      2,
    );
    assert.deepStrictEqual(got?.previous, { version: 2, comparable: false });
    // The delta still rides along: its per-row reasons are real.
    assert.ok(
      got?.delta.dimensions.some(
        (d) => !d.comparable && d.reason === "reviewers",
      ),
    );
  });

  test("a verification dial that moved makes the pair not comparable", () => {
    const off = {
      ...panel(1),
      result: {
        ...result,
        limits: [
          { kind: "verification_missing" as const, reason: "off" as const },
        ],
      },
    };
    assert.deepStrictEqual(choose([off, panel(2)], 1)?.previous, {
      version: 1,
      comparable: false,
    });
  });

  test("a PDF-only run against a panel is not comparable", () => {
    assert.deepStrictEqual(choose([pdfOnly(1), panel(2)], 1)?.previous, {
      version: 1,
      comparable: false,
    });
  });

  test("two PDF-only runs on one model are", () => {
    const got = choose([pdfOnly(1), pdfOnly(2)], 1);
    assert.deepStrictEqual(got?.previous, { version: 1, comparable: true });
    const presentation = got?.delta.dimensions.find(
      (d) => d.dimension === "presentation",
    );
    assert.strictEqual(presentation?.comparable, true);
  });

  test("a stored review satisfies the input as it is", () => {
    // What `initReviews` restores is a `StoredReview` plus triage; the chooser
    // reads nothing a stored review lacks.
    const stored: StoredReview = {
      mode: "panel",
      result,
      root: ROOT,
      entry: "main.tex",
      file: `${ROOT}/main.tex`,
      at: 1_757_000_000_000,
      version: 1,
      seats: seats("m1"),
    };
    assert.deepStrictEqual(choose([stored, panel(2)], 1)?.previous, {
      version: 1,
      comparable: true,
    });
  });
  test("an earlier version no seat contributed to is never comparable, and says so", () => {
    // Stored before X5 (no seat carried a ledger), or every seat failed: its
    // card measured nothing — unknown is never the same panel (ADR 0070 §4).
    const unmeasured: ComparableReview = {
      ...panel(1),
      seats: [
        { reviewer: "reviewer_a", status: "completed", model: "m1" },
        { reviewer: "reviewer_b", status: "completed", model: "m1" },
      ],
    };
    assert.deepStrictEqual(choose([unmeasured, panel(2)], 1)?.previous, {
      version: 1,
      comparable: false,
      unmeasured: true,
    });
    // A measured comparable version behind it still wins.
    assert.deepStrictEqual(
      choose([panel(1), { ...unmeasured, version: 2 }, panel(3)], 2)?.previous,
      { version: 1, comparable: true },
    );
  });

  test("a PDF-only run is not compared with a text panel that measured nothing", () => {
    // Both cards have no text reviewer, so the engine alone would call the
    // pair the same panel; an unmeasured card is never that.
    const bare: ComparableReview = {
      ...panel(1),
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m1" }],
    };
    assert.deepStrictEqual(choose([bare, pdfOnly(2)], 1)?.previous, {
      version: 1,
      comparable: false,
      unmeasured: true,
    });
  });
});
