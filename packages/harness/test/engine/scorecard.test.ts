/**
 * V5 (ADR 0087 §3–§5, O7–O12): the scorecard is a view of the ledger —
 * derived from the persisted record, never persisted, and the same function
 * for the tab's host, the CLI and the eval tier.
 */
import { describe, expect, it } from "vitest";
import type {
  ReviewAnnotation,
  ReviewAssessment,
  ReviewItem,
  ReviewLimit,
  ReviewResult,
  ReviewSeatState,
  ReviewStrength,
  Scorecard,
  ScorecardDimension,
} from "../../src/contracts/index.js";
import { PANEL_DIMENSIONS } from "../../src/contracts/index.js";
import {
  type ScorecardSource,
  deriveScorecard,
  scorecardDelta,
} from "../../src/engine/scorecard.js";
import type { StoredReview } from "../../src/session/review-store.js";

const A = "reviewer_a";
const B = "reviewer_b";
const C = "reviewer_c";
const PDF = "pdf_reviewer";
const SEVEN = PANEL_DIMENSIONS.filter((d) => d !== "presentation");

/** A located concern, verified as upheld unless told otherwise. */
function concern(
  reviewer: string,
  n: number,
  dimension: string,
  severity: ReviewAnnotation["severity"],
  line: number,
  over: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return {
    id: `${reviewer}-${n}`,
    reviewer,
    dimension,
    severity,
    span: { file: "main.tex", line },
    message: `${reviewer} concern ${n}`,
    verification: { outcome: "upheld", kind: "judgment" },
    ...over,
  };
}

function strength(
  reviewer: string,
  n: number,
  dimension: string,
  line: number,
): ReviewStrength {
  return {
    id: `${reviewer}-s${n}`,
    reviewer,
    dimension,
    span: { file: "main.tex", line },
    message: `${reviewer} strength ${n}`,
  };
}

function seat(
  reviewer: string,
  over: Partial<ReviewSeatState> = {},
): ReviewSeatState {
  return {
    reviewer,
    status: "completed",
    model: "m1",
    ledger: { entries: 0, located: 0, relocated: 0, dropped: 0, rejected: 0 },
    searches: { attempted: 1, answered: 1 },
    ...over,
  };
}

const VERIFIER = seat("verifier", { ledger: undefined, searches: undefined });

/** A three-reviewer panel, verified, with whatever result it is handed. */
function panel(
  result: Partial<ReviewResult>,
  over: Partial<ScorecardSource> = {},
): ScorecardSource {
  return {
    result: { annotations: [], ...result },
    seats: [seat(A), seat(B), seat(C)],
    verifierSeat: VERIFIER,
    ...over,
  };
}

const row = (card: Scorecard, d: string): ScorecardDimension => {
  const found = card.dimensions.find((x) => x.dimension === d);
  if (found === undefined) throw new Error(`no row ${d}`);
  return found;
};
const standing = (card: Scorecard, d: string) => row(card, d).standing;
const seatStanding = (card: Scorecard, d: string, r: string) =>
  row(card, d).seats.find((s) => s.reviewer === r)?.standing;

describe("deriveScorecard — the level rule (O7)", () => {
  it("every dimension, in PANEL_DIMENSIONS order, whatever the result holds", () => {
    const card = deriveScorecard(
      panel({
        annotations: [concern(A, 1, "grammar", "major", 3)],
      }),
    );
    expect(card.dimensions.map((d) => d.dimension)).toEqual([
      ...PANEL_DIMENSIONS,
    ]);
    // A quick action's dimension belongs to no row.
    expect(card.dimensions.every((d) => d.issues.major === 0)).toBe(true);
  });

  it("level 1 is a blocking major the verifier did not answer central: false", () => {
    const blocking = concern(A, 1, "soundness", "major", 3, { blocking: true });
    expect(
      standing(
        deriveScorecard(panel({ annotations: [blocking] })),
        "soundness",
      ),
    ).toEqual({
      kind: "level",
      level: 1,
      checked: true,
    });
    const notCentral = concern(A, 1, "soundness", "major", 3, {
      blocking: true,
      verification: { outcome: "upheld", kind: "judgment", central: false },
    });
    expect(
      standing(
        deriveScorecard(panel({ annotations: [notCentral] })),
        "soundness",
      ),
    ).toMatchObject({ kind: "level", level: 2 });
  });

  it("a refuted concern moves nothing — a withdrawn blocking major is not level 1", () => {
    const refuted = concern(A, 1, "soundness", "major", 3, {
      blocking: true,
      verification: {
        outcome: "refuted",
        kind: "absence",
        counter: { file: "main.tex", line: 9 },
      },
    });
    const minor = concern(B, 1, "soundness", "minor", 7);
    expect(
      standing(deriveScorecard(panel({ annotations: [refuted] })), "soundness"),
    ).toEqual({ kind: "nothing_raised" });
    const card = deriveScorecard(panel({ annotations: [refuted, minor] }));
    expect(standing(card, "soundness")).toMatchObject({
      kind: "level",
      level: 3,
    });
    expect(row(card, "soundness").issues).toEqual({
      blocking: 0,
      major: 0,
      minor: 1,
      info: 0,
    });
  });

  it("major is 2, minor is 3, info moves nothing and is counted", () => {
    const card = deriveScorecard(
      panel({
        annotations: [
          concern(A, 1, "claims", "major", 3),
          concern(A, 2, "clarity", "minor", 4),
          concern(A, 3, "language", "info", 5),
        ],
      }),
    );
    expect(standing(card, "claims")).toMatchObject({ level: 2 });
    expect(standing(card, "clarity")).toMatchObject({ level: 3 });
    expect(standing(card, "language")).toEqual({ kind: "nothing_raised" });
    expect(row(card, "language").issues.info).toBe(1);
  });

  it("a strength makes level 4 only with nothing above info, and level 4 is never checked", () => {
    const card = deriveScorecard(
      panel({
        annotations: [
          concern(A, 1, "clarity", "info", 3),
          concern(A, 2, "language", "minor", 4),
        ],
        strengths: [
          strength(A, 1, "clarity", 8),
          strength(B, 1, "language", 9),
          strength(B, 2, "significance", 10),
        ],
      }),
    );
    expect(standing(card, "clarity")).toEqual({
      kind: "level",
      level: 4,
      checked: false,
    });
    expect(standing(card, "language")).toMatchObject({ level: 3 });
    expect(standing(card, "significance")).toMatchObject({ level: 4 });
    expect(row(card, "clarity").strengths).toBe(1);
  });

  it("counts DISTINCT issues by group severity, blocking a subset of major", () => {
    const card = deriveScorecard(
      panel({
        annotations: [
          // Two reviewers on one line: one issue, blocking because one is.
          concern(A, 1, "soundness", "major", 3, { blocking: true }),
          concern(B, 1, "soundness", "minor", 3),
          // A second, non-blocking major issue elsewhere.
          concern(C, 1, "soundness", "major", 20),
          // A minor that joins nothing.
          concern(C, 2, "soundness", "minor", 30),
        ],
      }),
    );
    expect(row(card, "soundness").issues).toEqual({
      blocking: 1,
      major: 2,
      minor: 1,
      info: 0,
    });
  });
});

describe("deriveScorecard — not assessed: declared, imposed, and evidence wins (O8)", () => {
  it("no_reviewer: a PDF-only review's seven, and a panel whose every reviewer failed", () => {
    const pdfOnly = deriveScorecard({
      result: {
        annotations: [
          concern(PDF, 1, "presentation", "minor", 3, {
            verification: undefined,
          }),
        ],
      },
      seats: [],
      pdfSeat: seat(PDF, { searches: { attempted: 0, answered: 0 } }),
    });
    for (const d of SEVEN) {
      expect(standing(pdfOnly, d)).toEqual({
        kind: "not_assessed",
        reason: { kind: "no_reviewer" },
      });
    }
    expect(standing(pdfOnly, "presentation")).toMatchObject({ level: 3 });
    expect(pdfOnly.notAssessed).toBe(7);

    const failed = deriveScorecard(
      panel(
        {},
        {
          seats: [
            seat(A, { status: "failed", ledger: undefined }),
            seat(B, { status: "failed", ledger: undefined }),
            seat(C, { status: "interrupted", ledger: undefined }),
          ],
        },
      ),
    );
    for (const d of SEVEN) {
      expect(standing(failed, d)).toMatchObject({
        reason: { kind: "no_reviewer" },
      });
    }
    expect(failed.panel.reviewers).toEqual([]);
  });

  it("no_pdf: presentation with no completed PDF seat — including the role switched off", () => {
    const off = deriveScorecard(panel({}));
    expect(standing(off, "presentation")).toEqual({
      kind: "not_assessed",
      reason: { kind: "no_pdf" },
    });
    const failedSeat = deriveScorecard(
      panel(
        {},
        { pdfSeat: seat(PDF, { status: "failed", ledger: undefined }) },
      ),
    );
    expect(standing(failedSeat, "presentation")).toMatchObject({
      reason: { kind: "no_pdf" },
    });
    // A text reviewer's column carries no presentation standing at all.
    expect(seatStanding(off, "presentation", A)).toBeUndefined();
  });

  it("no_literature: per seat from searches.answered === 0, and the panel's row only when every reviewer's is", () => {
    const blind = { searches: { attempted: 3, answered: 0 } };
    const some = deriveScorecard(
      panel({}, { seats: [seat(A, blind), seat(B), seat(C, blind)] }),
    );
    expect(seatStanding(some, "originality", A)).toEqual({
      kind: "not_assessed",
      reason: { kind: "no_literature" },
    });
    expect(seatStanding(some, "positioning", C)).toMatchObject({
      reason: { kind: "no_literature" },
    });
    expect(seatStanding(some, "originality", B)).toEqual({
      kind: "nothing_raised",
    });
    expect(standing(some, "originality")).toEqual({ kind: "nothing_raised" });
    // Only originality and positioning.
    expect(seatStanding(some, "claims", A)).toEqual({ kind: "nothing_raised" });

    const all = deriveScorecard(
      panel({}, { seats: [seat(A, blind), seat(B, blind), seat(C, blind)] }),
    );
    expect(standing(all, "originality")).toMatchObject({
      reason: { kind: "no_literature" },
    });
    expect(standing(all, "positioning")).toMatchObject({
      reason: { kind: "no_literature" },
    });

    // An absent `searches` (a review stored before V5) imposes nothing.
    const unknown = deriveScorecard(
      panel(
        {},
        {
          seats: [
            seat(A, { searches: undefined }),
            seat(B, { searches: undefined }),
            seat(C, { searches: undefined }),
          ],
        },
      ),
    );
    expect(standing(unknown, "originality")).toEqual({
      kind: "nothing_raised",
    });
  });

  it("literature_budget: zero answers because the budget was spent is said as that, not as a silent literature (ADR 0089 §7)", () => {
    const blind = { searches: { attempted: 3, answered: 0 } };
    const seats = [seat(A, blind), seat(B, blind), seat(C, blind)];
    const spent = (reviewer: string): ReviewLimit => ({
      kind: "search_budget_spent",
      reviewer,
    });
    const down = (reviewer: string): ReviewLimit => ({
      kind: "source_unavailable",
      reviewer,
      source: "arxiv",
      status: "timeout",
    });

    // E1's third panel in one window: every seat refused before it asked.
    const budget = deriveScorecard(
      panel({ limits: [spent(A), spent(B), spent(C)] }, { seats }),
    );
    for (const d of ["originality", "positioning"]) {
      expect(standing(budget, d)).toEqual({
        kind: "not_assessed",
        reason: { kind: "literature_budget" },
      });
      expect(seatStanding(budget, d, B)).toEqual({
        kind: "not_assessed",
        reason: { kind: "literature_budget" },
      });
    }

    // Every source a seat asked failed, and no budget ran out: unchanged.
    const failed = deriveScorecard(
      panel({ limits: [down(A), down(B), down(C)] }, { seats }),
    );
    expect(standing(failed, "originality")).toMatchObject({
      reason: { kind: "no_literature" },
    });

    // A seat's own row reads its own limits, never a neighbour's.
    const split = deriveScorecard(
      panel({ limits: [spent(A), down(B), down(C)] }, { seats }),
    );
    expect(seatStanding(split, "originality", A)).toMatchObject({
      reason: { kind: "literature_budget" },
    });
    expect(seatStanding(split, "originality", C)).toMatchObject({
      reason: { kind: "no_literature" },
    });
    // The panel's row claims the budget only when every listing seat's does.
    expect(standing(split, "originality")).toMatchObject({
      reason: { kind: "no_literature" },
    });

    // Refused AND a source down: the budget is not the whole story.
    const both = deriveScorecard(
      panel({ limits: [spent(A), down(A), spent(B), spent(C)] }, { seats }),
    );
    expect(seatStanding(both, "originality", A)).toMatchObject({
      reason: { kind: "no_literature" },
    });
    expect(seatStanding(both, "originality", B)).toMatchObject({
      reason: { kind: "literature_budget" },
    });
    expect(standing(both, "originality")).toMatchObject({
      reason: { kind: "no_literature" },
    });
  });

  it("declared: only with nothing filed, and the panel's row only when every listing reviewer declared", () => {
    const declares = (
      r: string,
      d: string,
      note: string,
    ): ReviewAssessment => ({
      reviewer: r,
      dimension: d,
      impression: null,
      notAssessed: note,
    });
    const card = deriveScorecard(
      panel({
        assessments: [
          declares(A, "significance", "outside my field"),
          declares(B, "significance", "no reading of it"),
          declares(C, "significance", "cannot tell"),
          declares(A, "claims", "not mine"),
        ],
      }),
    );
    expect(standing(card, "significance")).toEqual({
      kind: "not_assessed",
      reason: {
        kind: "declared",
        by: [
          { reviewer: A, note: "outside my field" },
          { reviewer: B, note: "no reading of it" },
          { reviewer: C, note: "cannot tell" },
        ],
      },
    });
    expect(seatStanding(card, "claims", A)).toMatchObject({
      reason: { kind: "declared" },
    });
    // Two reviewers did not declare claims: the panel's row stands.
    expect(standing(card, "claims")).toEqual({ kind: "nothing_raised" });
    expect(card.notAssessed).toBe(2); // significance, presentation
  });

  it("evidence wins: a declaration or a failed search beside a filed concern is a level", () => {
    const blind = { searches: { attempted: 1, answered: 0 } };
    const card = deriveScorecard(
      panel(
        {
          annotations: [
            concern(A, 1, "claims", "minor", 3),
            concern(A, 2, "originality", "major", 5),
          ],
          strengths: [strength(B, 1, "positioning", 9)],
          assessments: [
            {
              reviewer: A,
              dimension: "claims",
              impression: 4,
              notAssessed: "n",
            },
          ],
        },
        { seats: [seat(A, blind), seat(B, blind), seat(C, blind)] },
      ),
    );
    expect(seatStanding(card, "claims", A)).toMatchObject({ level: 3 });
    expect(seatStanding(card, "originality", A)).toMatchObject({ level: 2 });
    expect(standing(card, "originality")).toMatchObject({ level: 2 });
    expect(standing(card, "positioning")).toMatchObject({ level: 4 });
  });
});

describe("deriveScorecard — checked or not (O9)", () => {
  const verified = [concern(A, 1, "claims", "major", 3)];

  it("checked only when a verifier completed and looked at every concern the level rests on", () => {
    expect(
      standing(deriveScorecard(panel({ annotations: verified })), "claims"),
    ).toEqual({
      kind: "level",
      level: 2,
      checked: true,
    });
    const unanswered = [
      ...verified,
      concern(B, 1, "claims", "minor", 9, { verification: undefined }),
    ];
    expect(
      standing(deriveScorecard(panel({ annotations: unanswered })), "claims"),
    ).toMatchObject({ checked: false });
  });

  it("off, failed, missing or skipped with concerns marks the whole card unchecked", () => {
    const missing = (reason: "off" | "failed" | "incomplete"): ReviewLimit => ({
      kind: "verification_missing",
      reason,
    });
    for (const reason of ["off", "failed", "incomplete"] as const) {
      const card = deriveScorecard(
        panel({ annotations: verified, limits: [missing(reason)] }),
      );
      expect(standing(card, "claims")).toMatchObject({ checked: false });
      expect(card.readiness.checked).toBe(false);
      expect(card.panel.verificationOn).toBe(reason !== "off");
    }
    const skipped = deriveScorecard(
      panel({ annotations: verified }, { verifierSeat: undefined }),
    );
    expect(standing(skipped, "claims")).toMatchObject({ checked: false });
  });

  it("presentation is unchecked, and a PDF-seat concern in claims makes the panel's claims row unchecked", () => {
    const card = deriveScorecard(
      panel(
        {
          annotations: [
            ...verified,
            concern(PDF, 1, "presentation", "minor", 4, {
              verification: undefined,
            }),
            concern(PDF, 2, "claims", "minor", 12, { verification: undefined }),
          ],
        },
        { pdfSeat: seat(PDF, { model: "seeing" }) },
      ),
    );
    expect(standing(card, "presentation")).toMatchObject({
      level: 3,
      checked: false,
    });
    expect(standing(card, "claims")).toMatchObject({
      level: 2,
      checked: false,
    });
    // The text reviewer's own claims standing was checked.
    expect(seatStanding(card, "claims", A)).toMatchObject({ checked: true });
    // The PDF seat's claims concern appears in no column of its own.
    expect(seatStanding(card, "claims", PDF)).toBeUndefined();
    expect(card.readiness).toEqual({ label: "major", checked: false });
  });

  it("readiness.checked is the conjunction over the level rows; ADR 0023's seat mark is not read", () => {
    const card = deriveScorecard(
      panel(
        { annotations: verified },
        { seats: [seat(A, { unverified: true }), seat(B), seat(C)] },
      ),
    );
    expect(card.readiness).toEqual({ label: "major", checked: true });
  });
});

describe("deriveScorecard — the panel's row, the spread, readiness (O10)", () => {
  it("the union counts two reviewers' overlapping concerns once, and each seat keeps its own standing", () => {
    const card = deriveScorecard(
      panel({
        annotations: [
          concern(A, 1, "claims", "major", 3, { blocking: true }),
          concern(B, 1, "claims", "minor", 3),
        ],
      }),
    );
    expect(row(card, "claims").issues).toMatchObject({
      blocking: 1,
      major: 1,
      minor: 0,
    });
    expect(seatStanding(card, "claims", A)).toMatchObject({ level: 1 });
    expect(seatStanding(card, "claims", B)).toMatchObject({ level: 3 });
    expect(seatStanding(card, "claims", C)).toEqual({ kind: "nothing_raised" });
    expect(row(card, "claims").seats.map((s) => s.reviewer)).toEqual([A, B, C]);
  });

  it("the PDF seat stands in presentation alone, after the reviewers", () => {
    const card = deriveScorecard(
      panel(
        { strengths: [strength(PDF, 1, "presentation", 4)] },
        { pdfSeat: seat(PDF, { model: "seeing" }) },
      ),
    );
    expect(row(card, "presentation").seats.map((s) => s.reviewer)).toEqual([
      A,
      B,
      C,
      PDF,
    ]);
    expect(seatStanding(card, "presentation", PDF)).toMatchObject({ level: 4 });
    expect(seatStanding(card, "soundness", PDF)).toBeUndefined();
    expect(card.panel.pdf).toEqual({ model: "seeing" });
  });

  it("names the contributing reviewers with their models, an unknown one as empty", () => {
    const card = deriveScorecard(
      panel(
        {},
        {
          seats: [
            seat(A, { model: "m1" }),
            seat(B, { model: "" }),
            seat(C, { status: "failed", ledger: undefined }),
          ],
        },
      ),
    );
    expect(card.panel.reviewers).toEqual([
      { reviewer: A, model: "m1" },
      { reviewer: B, model: "" },
    ]);
  });

  it("the impression that rides along is the median — odd, even, none — and nothing reads it", () => {
    const impressions = (values: Array<number | null>): ReviewAssessment[] =>
      [A, B, C].map((r, i) => ({
        reviewer: r,
        dimension: "soundness",
        impression: values[i] ?? null,
      }));
    const at = (values: Array<number | null>) =>
      row(
        deriveScorecard(panel({ assessments: impressions(values) })),
        "soundness",
      ).impression;
    expect(at([3, 9, 5])).toBe(5);
    expect(at([4, 6, null])).toBe(5);
    expect(at([null, null, null])).toBeNull();
    const card = deriveScorecard(
      panel({ assessments: impressions([2, 8, 7]) }),
    );
    expect(row(card, "soundness").seats.map((s) => s.impression)).toEqual([
      2, 8, 7,
    ]);

    // Replace every impression with null: every standing, count and the
    // readiness word are identical.
    const source = panel({
      annotations: [
        concern(A, 1, "claims", "major", 3, { blocking: true }),
        concern(B, 1, "clarity", "minor", 4),
      ],
      strengths: [strength(C, 1, "language", 5)],
      assessments: [
        ...impressions([2, 8, 7]),
        { reviewer: A, dimension: "claims", impression: 9 },
      ],
    });
    const nulled = {
      ...source,
      result: {
        ...source.result,
        assessments: source.result.assessments?.map((a) => ({
          ...a,
          impression: null,
        })),
      },
    };
    const strip = (c: Scorecard) => ({
      readiness: c.readiness,
      notAssessed: c.notAssessed,
      rows: c.dimensions.map((d) => ({
        standing: d.standing,
        issues: d.issues,
        strengths: d.strengths,
        seats: d.seats.map((s) => s.standing),
      })),
    });
    expect(strip(deriveScorecard(nulled))).toEqual(
      strip(deriveScorecard(source)),
    );
  });

  it("readiness is the worst assessed level, with the not-assessed count beside it", () => {
    const worst = deriveScorecard(
      panel({
        annotations: [
          concern(A, 1, "claims", "major", 3, { blocking: true }),
          concern(B, 1, "clarity", "minor", 4),
        ],
      }),
    );
    expect(worst.readiness.label).toBe("blocking");
    expect(worst.notAssessed).toBe(1); // presentation: no PDF seat
    const minor = deriveScorecard(
      panel({ annotations: [concern(B, 1, "clarity", "minor", 4)] }),
    );
    expect(minor.readiness.label).toBe("minor");
    const none = deriveScorecard(
      panel({ strengths: [strength(A, 1, "clarity", 3)] }),
    );
    expect(none.readiness).toEqual({ label: "none", checked: false });
    const nobody = deriveScorecard({ result: { annotations: [] }, seats: [] });
    expect(nobody.readiness.label).toBe("not_assessed");
    expect(nobody.notAssessed).toBe(8);
  });

  it("a bare result derives: its named reviewers with unknown models, and no_reviewer when none", () => {
    const bare = deriveScorecard({
      result: {
        annotations: [concern(B, 1, "claims", "minor", 3)],
        strengths: [strength(A, 1, "clarity", 4)],
      },
    });
    expect(bare.panel.reviewers).toEqual([
      { reviewer: B, model: "" },
      { reviewer: A, model: "" },
    ]);
    expect(standing(bare, "claims")).toMatchObject({
      level: 3,
      checked: false,
    });
    const empty = deriveScorecard({ result: { annotations: [] } });
    expect(standing(empty, "soundness")).toMatchObject({
      reason: { kind: "no_reviewer" },
    });
  });
});

describe("scorecardDelta — only between comparable reviews (O11)", () => {
  const cardOf = (
    annotations: ReviewAnnotation[],
    over: Partial<ScorecardSource> = {},
    limits?: ReviewLimit[],
  ) =>
    deriveScorecard(
      panel({ annotations, ...(limits !== undefined ? { limits } : {}) }, over),
    );
  const entry = (delta: ReturnType<typeof scorecardDelta>, d: string) =>
    delta.dimensions.find((x) => x.dimension === d);

  it("a same-panel pair yields a change per row, ranked 1 < 2 < 3 < nothing raised < 4", () => {
    const before = cardOf([
      concern(A, 1, "claims", "major", 3, { blocking: true }),
      concern(A, 2, "clarity", "minor", 4),
      concern(A, 3, "language", "major", 5),
    ]);
    const after = deriveScorecard(
      panel({
        annotations: [
          concern(A, 1, "claims", "major", 3),
          concern(A, 2, "language", "major", 5, { blocking: true }),
        ],
        strengths: [strength(B, 1, "significance", 9)],
      }),
    );
    const delta = scorecardDelta(before, after);
    expect(delta.dimensions.map((d) => d.dimension)).toEqual([
      ...PANEL_DIMENSIONS,
    ]);
    expect(entry(delta, "claims")).toMatchObject({
      comparable: true,
      change: "improved",
    });
    expect(entry(delta, "clarity")).toMatchObject({ change: "improved" });
    expect(entry(delta, "language")).toMatchObject({ change: "worsened" });
    expect(entry(delta, "significance")).toMatchObject({ change: "improved" });
    expect(entry(delta, "soundness")).toMatchObject({ change: "unchanged" });
    expect(entry(delta, "presentation")).toEqual({
      dimension: "presentation",
      comparable: false,
      reason: "pdf",
    });
  });

  it("a different panel, an unknown model or a different dial is not comparable", () => {
    const base = cardOf([]);
    const otherModel = cardOf([], {
      seats: [seat(A), seat(B), seat(C, { model: "m2" })],
    });
    expect(entry(scorecardDelta(base, otherModel), "claims")).toEqual({
      dimension: "claims",
      comparable: false,
      reason: "reviewers",
    });
    const fewer = cardOf([], { seats: [seat(A), seat(B)] });
    expect(entry(scorecardDelta(base, fewer), "claims")).toMatchObject({
      reason: "reviewers",
    });
    const unknown = cardOf([], {
      seats: [seat(A, { model: "" }), seat(B), seat(C)],
    });
    expect(entry(scorecardDelta(unknown, unknown), "claims")).toMatchObject({
      reason: "reviewers",
    });
    const off = cardOf([], {}, [
      { kind: "verification_missing", reason: "off" },
    ]);
    expect(entry(scorecardDelta(base, off), "claims")).toMatchObject({
      reason: "verification",
    });
    // Reordered seats are the same multiset.
    const reordered = cardOf([], { seats: [seat(C), seat(A), seat(B)] });
    expect(entry(scorecardDelta(base, reordered), "claims")).toMatchObject({
      comparable: true,
    });
  });

  it("presentation compares by the PDF seat's model, and a not-assessed side is not comparable", () => {
    const withPdf = (model: string) =>
      cardOf([], { pdfSeat: seat(PDF, { model }) });
    expect(
      entry(
        scorecardDelta(withPdf("seeing"), withPdf("seeing")),
        "presentation",
      ),
    ).toMatchObject({ comparable: true, change: "unchanged" });
    expect(
      entry(
        scorecardDelta(withPdf("seeing"), withPdf("other")),
        "presentation",
      ),
    ).toMatchObject({ reason: "pdf" });
    expect(
      entry(scorecardDelta(withPdf(""), withPdf("")), "presentation"),
    ).toMatchObject({ reason: "pdf" });
    const blind = { searches: { attempted: 1, answered: 0 } };
    const noLiterature = cardOf([], {
      seats: [seat(A, blind), seat(B, blind), seat(C, blind)],
    });
    expect(
      entry(scorecardDelta(cardOf([]), noLiterature), "originality"),
    ).toEqual({
      dimension: "originality",
      comparable: false,
      reason: "not_assessed",
    });
  });
});

describe("deriveScorecard — purity and the record (O12)", () => {
  const RESULT: ReviewResult = {
    annotations: [
      concern(A, 1, "claims", "major", 3, { blocking: true }),
      concern(B, 1, "clarity", "minor", 4),
    ],
    strengths: [strength(C, 1, "language", 5)],
    assessments: [{ reviewer: A, dimension: "claims", impression: 3 }],
  };
  const SEATS = [seat(A), seat(B), seat(C)];

  it("a StoredReview and the ReviewItem of the same run derive the same card", () => {
    const stored: StoredReview = {
      mode: "panel",
      result: RESULT,
      root: "/p",
      entry: "main.tex",
      file: "/p/main.tex",
      at: 1,
      version: 2,
      seats: SEATS,
      verifierSeat: VERIFIER,
    };
    const item: ReviewItem = {
      id: "r1",
      type: "review",
      status: "completed",
      skill: "blind-reviewer",
      seats: SEATS,
      verifierSeat: VERIFIER,
      verification: "completed",
      result: RESULT,
    };
    expect(deriveScorecard(stored)).toEqual(
      deriveScorecard(item as ReviewItem & { result: ReviewResult }),
    );
  });

  it("does not mutate its source, and answers the same twice", () => {
    const source = panel(RESULT);
    const before = structuredClone(source);
    const first = deriveScorecard(source);
    expect(source).toEqual(before);
    expect(deriveScorecard(source)).toEqual(first);
  });

  it("a panel stored before V5 derives: null impressions, no level 4, no literature imposed", () => {
    const old = deriveScorecard({
      result: { annotations: [concern(A, 1, "claims", "minor", 3)] },
      seats: [
        {
          reviewer: A,
          status: "completed",
          model: "m1",
          ledger: {
            entries: 1,
            located: 1,
            relocated: 0,
            dropped: 0,
            rejected: 0,
          },
        },
        {
          reviewer: B,
          status: "completed",
          model: "m1",
          ledger: {
            entries: 0,
            located: 0,
            relocated: 0,
            dropped: 0,
            rejected: 0,
          },
        },
      ],
      verifierSeat: VERIFIER,
    });
    expect(old.dimensions.every((d) => d.impression === null)).toBe(true);
    expect(
      old.dimensions.some(
        (d) => d.standing.kind === "level" && d.standing.level === 4,
      ),
    ).toBe(false);
    expect(standing(old, "originality")).toEqual({ kind: "nothing_raised" });
    expect(standing(old, "claims")).toMatchObject({ level: 3 });
  });
});
