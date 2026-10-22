/**
 * V5 (D15, O16): the scorecard instrument — what the judge and the live rows
 * print about a review's derived card.
 *
 * Reported, never gated (ADR 0070 §5): nothing here asserts a level. What is
 * asserted is the instrument's honesty — an unreadable panel reads
 * *unmeasured* and never an empty card, levels and impressions are printed on
 * separate lines, a dimension not assessed is named with its reason and never
 * counted, and nothing it prints carries a `%` or a word the stage bans.
 */
import type {
  ReviewAnnotation,
  ReviewAssessment,
  ReviewItem,
  ReviewLimit,
  ReviewSeatState,
  ReviewStrength,
} from "@lemmaria/harness";
import { deriveScorecard } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  compareReadings,
  formatComparison,
  formatScorecardReport,
  formatSeatReadings,
  impressionsLine,
  measureScorecard,
  scorecardLine,
} from "../../src/eval/scorecard.js";

/** The harness guard's word list (`no-score.test.ts`), whole-word. */
const BANNED =
  /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;

// ── builders ────────────────────────────────────────────────────────────────

const seat = (
  reviewer: string,
  answered?: number,
  status: ReviewSeatState["status"] = "completed",
): ReviewSeatState => ({
  reviewer,
  status,
  model: "m1",
  // A seat contributes to a card only when its ledger was read (ADR 0087).
  ...(status === "completed"
    ? {
        ledger: {
          entries: 1,
          located: 1,
          relocated: 0,
          dropped: 0,
          rejected: 0,
        },
      }
    : {}),
  ...(answered !== undefined ? { searches: { attempted: 2, answered } } : {}),
});

const concern = (
  reviewer: string,
  n: number,
  dimension: string,
  severity: ReviewAnnotation["severity"],
  line: number,
  blocking = false,
): ReviewAnnotation => ({
  id: `${reviewer}-${n}`,
  reviewer,
  dimension,
  severity,
  span: { file: "main.tex", line },
  message: `concern ${reviewer}-${n}`,
  ...(blocking ? { blocking: true } : {}),
  verification: { outcome: "upheld", kind: "judgment" },
});

const strength = (
  reviewer: string,
  n: number,
  dimension: string,
  line: number,
): ReviewStrength => ({
  id: `${reviewer}-s${n}`,
  reviewer,
  dimension,
  span: { file: "main.tex", line },
  message: "done well",
});

const SEVEN = [
  "soundness",
  "claims",
  "clarity",
  "language",
  "positioning",
  "originality",
  "significance",
];
const impressions = (
  reviewer: string,
  values: Record<string, number | null>,
  declared: Record<string, string> = {},
): ReviewAssessment[] =>
  SEVEN.map((dimension) => ({
    reviewer,
    dimension,
    impression: values[dimension] ?? null,
    ...(declared[dimension] !== undefined
      ? { notAssessed: declared[dimension] }
      : {}),
  }));

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1",
    type: "review",
    status: "completed",
    skill: "blind-reviewer",
    seats: [seat("reviewer_a", 1), seat("reviewer_b", 1)],
    verifierSeat: { reviewer: "verifier", status: "completed", model: "m1" },
    result: {
      annotations: [
        concern("reviewer_a", 1, "soundness", "major", 10, true),
        concern("reviewer_b", 1, "claims", "minor", 20),
      ],
      strengths: [strength("reviewer_b", 1, "clarity", 30)],
      assessments: [
        ...impressions("reviewer_a", { soundness: 3, clarity: 7 }),
        ...impressions(
          "reviewer_b",
          { soundness: 6, clarity: 8, claims: 5 },
          // Third-party text: a note that would trip every guard if printed.
          { significance: "a 40% score is my verdict" },
        ),
      ],
      limits: [
        {
          kind: "strengths_lost",
          reviewer: "reviewer_a",
          dropped: [{ anchor: "praised", role: "claim", reason: "not_found" }],
          rejected: [{ index: 2, reason: "shape" }],
        } satisfies ReviewLimit,
      ],
    },
    ...over,
  } as ReviewItem;
}

// ── measureScorecard ────────────────────────────────────────────────────────

describe("measureScorecard (V5, O16)", () => {
  it("derives the card the harness derives, from the item's own rows", () => {
    const it0 = item();
    const reading = measureScorecard(it0);
    expect(reading.measured).toBe(true);
    expect(reading.card).toEqual(
      deriveScorecard({
        result: it0.result ?? { annotations: [] },
        seats: it0.seats,
        ...(it0.verifierSeat ? { verifierSeat: it0.verifierSeat } : {}),
      }),
    );
  });

  it("counts each seat's strengths, located and lost, and carries its searches", () => {
    expect(measureScorecard(item()).perSeat).toEqual([
      {
        reviewer: "reviewer_a",
        model: "m1",
        strengths: { located: 0, lost: 2 },
        searches: { attempted: 2, answered: 1 },
      },
      {
        reviewer: "reviewer_b",
        model: "m1",
        strengths: { located: 1, lost: 0 },
        searches: { attempted: 2, answered: 1 },
      },
    ]);
  });

  it("gives a seat whose ledger was never read no strength count — unmeasured, never zero", () => {
    // The code review's Issue 2: a failed seat beside a readable one used to
    // print `strengths 0 located, 0 lost`, a zero it never measured.
    const reading = measureScorecard(
      item({
        seats: [seat("reviewer_a", 1), seat("reviewer_b", undefined, "failed")],
      }),
    );
    expect(reading.measured).toBe(true);
    expect(reading.perSeat[1]).toEqual({ reviewer: "reviewer_b", model: "m1" });
    const text = formatSeatReadings(reading);
    expect(text).toContain(
      "  reviewer_b [m1]: strengths unmeasured (no ledger read); searches unrecorded",
    );
    // No figure after the model's name — the model `m1` is the only digit.
    expect(text.split("\n")[1]?.split("[m1]")[1]).not.toMatch(/\d/);
  });

  it("is UNMEASURED — no card at all — when no seat produced a ledger", () => {
    const reading = measureScorecard(
      item({
        seats: [seat("reviewer_a", 1, "failed")],
        result: {
          annotations: [],
          limits: [
            {
              kind: "seat_missing",
              reviewer: "reviewer_a",
              reason: "failed",
              detail: "x",
            },
          ],
        },
      }),
    );
    expect(reading).toEqual({ measured: false, perSeat: [] });
    const text = formatScorecardReport(reading);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("unmeasured");
    // Unmeasured is not zero: no figure of any kind.
    expect(text).not.toMatch(/\d/);
  });
});

// ── the printed lines ───────────────────────────────────────────────────────

describe("the scorecard's printed lines (V5, O16, O18)", () => {
  const card = () => {
    const c = measureScorecard(item()).card;
    if (c === undefined) throw new Error("fixture: expected a card");
    return c;
  };

  it("prints the judge's two lines — levels and impressions apart", () => {
    expect(scorecardLine(card())).toBe(
      "scorecard: soundness=1:checked claims=3:checked clarity=4:unchecked " +
        "language=nothing_raised positioning=nothing_raised " +
        "originality=nothing_raised significance=nothing_raised " +
        "presentation=not_assessed:no_pdf",
    );
    expect(impressionsLine(card())).toBe(
      "impressions: soundness=4.5 claims=5.0 clarity=7.5 language=null " +
        "positioning=null originality=null significance=null presentation=null",
    );
  });

  it("formats the report: readiness, levels, impressions, the unassessed by name, each seat", () => {
    expect(formatScorecardReport(measureScorecard(item()))).toBe(
      [
        // Level 4 is never checked, and readiness is the conjunction (O9).
        "scorecard — readiness blocking, unchecked; verification on; reviewers reviewer_a, reviewer_b",
        "  levels: soundness=1:checked claims=3:checked clarity=4:unchecked language=nothing_raised positioning=nothing_raised originality=nothing_raised significance=nothing_raised presentation=not_assessed:no_pdf",
        "  impressions: soundness=4.5 claims=5.0 clarity=7.5 language=null positioning=null originality=null significance=null presentation=null",
        "  not assessed: presentation (no_pdf)",
        "  reviewer_a levels: soundness=1:checked claims=nothing_raised clarity=nothing_raised language=nothing_raised positioning=nothing_raised originality=nothing_raised significance=nothing_raised",
        "  reviewer_a impressions: soundness=3 claims=null clarity=7 language=null positioning=null originality=null significance=null",
        // Its own declaration holds on its own row; the panel's needs both.
        "  reviewer_b levels: soundness=nothing_raised claims=3:checked clarity=4:unchecked language=nothing_raised positioning=nothing_raised originality=nothing_raised significance=not_assessed:declared(reviewer_b)",
        "  reviewer_b impressions: soundness=6 claims=5 clarity=8 language=null positioning=null originality=null significance=null",
      ].join("\n"),
    );
  });

  it("names a declaration's reviewers, never its note", () => {
    const declared = item({
      seats: [seat("reviewer_b", 1)],
      result: {
        annotations: [],
        assessments: impressions(
          "reviewer_b",
          {},
          { significance: "a 40% score is my verdict" },
        ),
      },
    });
    const text = formatScorecardReport(measureScorecard(declared));
    expect(text).toContain("significance=not_assessed:declared(reviewer_b)");
    expect(text).toContain("significance (declared by reviewer_b)");
    expect(text).not.toContain("40");
  });

  it("names a literature gap as the reason, and counts no dimension", () => {
    const dark = item({
      seats: [seat("reviewer_a", 0)],
      result: { annotations: [] },
    });
    const text = formatScorecardReport(measureScorecard(dark));
    expect(text).toContain(
      "  not assessed: positioning (no_literature), originality (no_literature), presentation (no_pdf)",
    );
  });

  it("prints numbers only as levels and impressions, and never a % or a banned word", () => {
    const text = formatScorecardReport(measureScorecard(item()));
    expect(text).not.toContain("%");
    expect(text).not.toMatch(BANNED);
    const bare = text
      .replace(/=[1-4]:(un)?checked/g, "")
      .replace(/=(10|[1-9])(\.\d)?\b/g, "");
    expect(bare).not.toMatch(/\d/);
  });

  it("prints what each seat's strengths and searches came to, apart from the report", () => {
    expect(formatSeatReadings(measureScorecard(item()))).toBe(
      [
        "  reviewer_a [m1]: strengths 0 located, 2 lost; searches 1 of 2 answered",
        "  reviewer_b [m1]: strengths 1 located, 0 lost; searches 1 of 2 answered",
      ].join("\n"),
    );
    const unknown = item({ seats: [seat("reviewer_a")] });
    expect(formatSeatReadings(measureScorecard(unknown))).toContain(
      "searches unrecorded",
    );
  });
});

// ── compareReadings ─────────────────────────────────────────────────────────

describe("compareReadings (V5, O16)", () => {
  const worse = item({
    result: {
      annotations: [
        concern("reviewer_a", 1, "soundness", "major", 10, true),
        concern("reviewer_b", 1, "claims", "major", 20),
      ],
      assessments: [
        ...impressions("reviewer_a", { soundness: 3, clarity: 7 }),
        ...impressions("reviewer_b", { soundness: 6, clarity: 8 }),
      ],
    },
  });

  it("says, per dimension, whether the standing moved and whether the impression did", () => {
    const c = compareReadings(
      measureScorecard(item()),
      measureScorecard(worse),
      "planted vs laundered",
    );
    expect(c.measured).toBe(true);
    const soundness = c.dimensions.find((d) => d.dimension === "soundness");
    expect(soundness?.standing).toEqual({
      from: "1:checked",
      to: "1:checked",
      moved: false,
      change: "unchanged",
    });
    expect(soundness?.impression).toEqual({ from: 4.5, to: 4.5, moved: false });
    const claims = c.dimensions.find((d) => d.dimension === "claims");
    expect(claims?.standing).toMatchObject({
      from: "3:checked",
      to: "2:checked",
      moved: true,
      change: "worsened",
    });
    expect(claims?.impression).toEqual({ from: 5, to: null, moved: true });
    // A strength gone is a level gone: 4 → nothing raised.
    const clarity = c.dimensions.find((d) => d.dimension === "clarity");
    expect(clarity?.standing).toMatchObject({
      moved: true,
      change: "worsened",
    });
  });

  it("prints levels and impressions on separate lines", () => {
    const text = formatComparison(
      compareReadings(
        measureScorecard(item()),
        measureScorecard(worse),
        "planted vs laundered",
      ),
    );
    const [levels, impressionsText, ...rest] = text.split("\n");
    expect(rest).toEqual([]);
    expect(levels).toContain("planted vs laundered — levels: ");
    expect(levels).toContain("claims 3:checked→2:checked moved (worsened)");
    expect(levels).toContain("soundness 1:checked→1:checked held");
    expect(impressionsText).toContain("planted vs laundered — impressions: ");
    expect(impressionsText).toContain("claims 5.0→null moved");
    expect(impressionsText).toContain("soundness 4.5→4.5 held");
    expect(text).not.toContain("%");
    expect(text).not.toMatch(BANNED);
  });

  it("compares nothing when either side is unmeasured", () => {
    const none = measureScorecard(
      item({ seats: [seat("reviewer_a", 1, "failed")] }),
    );
    const c = compareReadings(none, measureScorecard(item()), "retest");
    expect(c).toEqual({ label: "retest", measured: false, dimensions: [] });
    expect(formatComparison(c)).toBe(
      "retest: unmeasured — one side produced no ledger the driver could read",
    );
  });
});
