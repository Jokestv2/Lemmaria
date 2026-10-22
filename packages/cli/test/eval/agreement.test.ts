/**
 * R5 (O3, and O4's agreement half): the hivemind measurement.
 *
 * The field warns that a panel of reviewers sharing one model is one reviewer
 * with three voices. Since R9 the topology that would answer it exists — N
 * whole reviewers, each on a model the user picks — and the record says which
 * model each one ran on (`ReviewSeatState.model`, ADR 0069 §4). What it does
 * NOT do is tell the cross-review any of that, on purpose (§6), so the number
 * is reconstructed here, from the record, by the CLI.
 *
 * Reported, never gated: the first measurement is the floor (ADR 0070 §5).
 *
 * Two numbers per pair rather than one. `jaccardDefects` is the field's own
 * shape — per-paper Jaccard over what each reviewer flagged — but taken over
 * GROUND TRUTH, so it says whether two reviewers found the same *errors*.
 * `spanOverlap` needs no manifest, so it is the one that also works on the
 * operator's own manuscript (J2).
 */
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewSeatState,
  ReviewSpan,
  ReviewSynthesis,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  formatAgreementReport,
  measureAgreement,
} from "../../src/eval/agreement.js";
import type { RecallReport, ReviewerTally } from "../../src/eval/recall.js";

// ── builders ────────────────────────────────────────────────────────────────

const seat = (reviewer: string, model: string): ReviewSeatState => ({
  reviewer,
  status: "completed",
  model,
});

const at = (line: number, endLine?: number): ReviewSpan => ({
  file: "main.tex",
  line,
  ...(endLine !== undefined ? { endLine } : {}),
});

function annotation(
  id: string,
  reviewer: string,
  span: ReviewSpan,
  extra: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return {
    id,
    reviewer,
    dimension: "soundness",
    severity: "major",
    span,
    message: `concern ${id}`,
    ...extra,
  };
}

function item(
  seats: ReviewSeatState[],
  annotations: ReviewAnnotation[] = [],
  synthesis?: ReviewSynthesis,
): ReviewItem {
  return {
    id: "review-1",
    type: "review",
    status: "completed",
    skill: "blind-reviewer",
    seats,
    result: {
      annotations,
      ...(synthesis !== undefined ? { synthesis } : {}),
    },
  } as ReviewItem;
}

/** Only the half of a `RecallReport` this measurement reads. */
function recallWith(found: Record<string, string[]>): RecallReport {
  const perReviewer: Record<string, ReviewerTally> = {};
  for (const [reviewer, ids] of Object.entries(found)) {
    perReviewer[reviewer] = {
      model: "",
      concerns: ids.length,
      located: ids.length,
      dropped: 0,
      majors: ids.length,
      blockingMajors: 0,
      found: ids,
    };
  }
  return {
    fixture: "planted-defects",
    perCategory: {
      surface: { planted: 4, found: 0, recall: 0 },
      claim: { planted: 4, found: 0, recall: 0 },
      reasoning: { planted: 4, found: 0, recall: 0 },
      experimental: { planted: 4, found: 0, recall: 0 },
    },
    overall: { planted: 16, found: 0, recall: 0 },
    hits: [],
    missed: [],
    unmatched: [],
    spanOnlyHits: 0,
    // This literal has been short of `measured` and `contested` since they
    // were added, and nothing noticed: vitest transpiles with esbuild, which
    // strips types without checking them, so a type-broken test file still
    // runs green. `outageShaped` is X5's, filled here rather than left to
    // deepen a hole this milestone did not dig — the other two are recorded
    // in open-questions.md, not fixed in passing.
    outageShaped: [],
    perReviewer,
  };
}

// ── the pairs ───────────────────────────────────────────────────────────────

describe("R5 O3 — agreement is measured from the record, pair by pair", () => {
  it("enumerates every unordered pair of reviewers", () => {
    const report = measureAgreement(
      item([
        seat("reviewer_a", "pin-x"),
        seat("reviewer_b", "pin-y"),
        seat("reviewer_c", "pin-x"),
        seat("reviewer_d", "pin-y"),
      ]),
    );
    expect(report.pairs).toHaveLength(6); // 4·3/2
    expect(report.pairs.map((p) => `${p.a}+${p.b}`)).toEqual([
      "reviewer_a+reviewer_b",
      "reviewer_a+reviewer_c",
      "reviewer_a+reviewer_d",
      "reviewer_b+reviewer_c",
      "reviewer_b+reviewer_d",
      "reviewer_c+reviewer_d",
    ]);
  });

  it("reads sameModel off the seats, not off what a caller passed", () => {
    const report = measureAgreement(
      item([
        seat("reviewer_a", "pin-x"),
        seat("reviewer_b", "pin-y"),
        seat("reviewer_c", "pin-x"),
      ]),
    );
    expect(report.pairs.map((p) => p.sameModel)).toEqual([false, true, false]);
    expect(report.sameModel.pairs).toBe(1);
    expect(report.crossModel.pairs).toBe(2);
  });

  it("calls an empty model unknown, never the same", () => {
    // `""` is a pre-R9 replay. Two reviewers whose model is unrecorded are not
    // evidence of a same-model pair, so the pair joins neither group.
    const report = measureAgreement(
      item([
        seat("reviewer_a", ""),
        seat("reviewer_b", ""),
        seat("reviewer_c", "pin-x"),
      ]),
    );
    expect(report.pairs.map((p) => p.sameModel)).toEqual([null, null, null]);
    expect(report.sameModel.pairs).toBe(0);
    expect(report.crossModel.pairs).toBe(0);
    expect(report.sameModel.meanSpanOverlap).toBeNull();
    expect(report.crossModel.meanJaccardDefects).toBeNull();
  });
});

describe("R5 O3 — the two numbers a pair carries", () => {
  it("takes jaccardDefects over the two reviewers' found sets", () => {
    const report = measureAgreement(
      item([seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-x")]),
      recallWith({
        reviewer_a: ["S1", "S2", "C1"],
        reviewer_b: ["S2", "C1", "R1", "E1"],
      }),
    );
    // |{S2,C1}| / |{S1,S2,C1,R1,E1}| = 2/5
    expect(report.pairs[0]?.jaccardDefects).toBeCloseTo(0.4, 10);
  });

  it("reports no jaccardDefects when neither reviewer found anything", () => {
    const report = measureAgreement(
      item([seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-x")]),
      recallWith({ reviewer_a: [], reviewer_b: [] }),
    );
    expect(report.pairs[0]?.jaccardDefects).toBeNull();
  });

  it("reports no jaccardDefects at all without a manifest to match against", () => {
    // On the operator's own manuscript there is no ground truth, and inventing
    // a zero would read as perfect disagreement rather than as no measurement.
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("b-1", "reviewer_b", at(10)),
        ],
      ),
    );
    expect(report.pairs[0]?.jaccardDefects).toBeNull();
    expect(report.pairs[0]?.spanOverlap).toBe(1);
  });

  it("takes spanOverlap symmetrically over located concerns", () => {
    // reviewer_a: 10, 20, 30 · reviewer_b: 20-21, 99
    // a-side matched: 20 → 1 of 3; b-side matched: 20-21 → 1 of 2; (1+1)/(3+2)
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("a-2", "reviewer_a", at(20)),
          annotation("a-3", "reviewer_a", at(30)),
          annotation("b-1", "reviewer_b", at(20, 21)),
          annotation("b-2", "reviewer_b", at(99)),
        ],
      ),
    );
    expect(report.pairs[0]?.spanOverlap).toBeCloseTo(2 / 5, 10);
  });

  it("counts an overlap through either pointer, claim or evidence", () => {
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [
          annotation("a-1", "reviewer_a", at(10), {
            evidence: { kind: "span", ...at(50) },
          }),
          annotation("b-1", "reviewer_b", at(50)),
        ],
      ),
    );
    expect(report.pairs[0]?.spanOverlap).toBe(1);
  });

  it("never counts two concerns in different files as overlapping", () => {
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [
          annotation("a-1", "reviewer_a", {
            file: "sections/one.tex",
            line: 10,
          }),
          annotation("b-1", "reviewer_b", at(10)),
        ],
      ),
    );
    expect(report.pairs[0]?.spanOverlap).toBe(0);
  });

  it("reports no spanOverlap when both reviewers located nothing", () => {
    const report = measureAgreement(
      item([seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")]),
    );
    expect(report.pairs[0]?.spanOverlap).toBeNull();
  });

  it("averages each number within its group, skipping the pairs that have none", () => {
    const report = measureAgreement(
      item(
        [
          seat("reviewer_a", "pin-x"),
          seat("reviewer_b", "pin-x"),
          seat("reviewer_c", "pin-y"),
        ],
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("b-1", "reviewer_b", at(10)),
          annotation("c-1", "reviewer_c", at(99)),
        ],
      ),
    );
    // a+b same model, overlap 1; a+c and b+c cross model, overlap 0 each.
    expect(report.sameModel).toEqual({
      pairs: 1,
      meanJaccardDefects: null,
      meanSpanOverlap: 1,
    });
    expect(report.crossModel).toEqual({
      pairs: 2,
      meanJaccardDefects: null,
      meanSpanOverlap: 0,
    });
  });
});

// ── what the cross-review managed to say ────────────────────────────────────

describe("R5 O3 — the cross-review's entries, counted by the models behind them", () => {
  const synthesis: ReviewSynthesis = {
    consensus: [
      { ids: ["a-1", "b-1"], note: "both reviewers raise the same equation" },
      { ids: ["a-2", "c-1"], note: "two reviewers on the same model" },
    ],
    disagreements: [
      { ids: ["a-1", "b-2"], note: "they read the table differently" },
    ],
  };

  it("counts entries, and how many of them span two models", () => {
    // `interpretSynthesis` has always demanded two DIFFERENT reviewers; under
    // R3's one-model topology that could never mean two different models.
    const report = measureAgreement(
      item(
        [
          seat("reviewer_a", "pin-x"),
          seat("reviewer_b", "pin-y"),
          seat("reviewer_c", "pin-x"),
        ],
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("a-2", "reviewer_a", at(20)),
          annotation("b-1", "reviewer_b", at(10)),
          annotation("b-2", "reviewer_b", at(30)),
          annotation("c-1", "reviewer_c", at(20)),
        ],
        synthesis,
      ),
    );
    expect(report.crossReview).toEqual({
      consensus: 2,
      consensusCrossModel: 1,
      disagreements: 1,
      disagreementsCrossModel: 1,
    });
  });

  it("resolves an id it cannot place as no model at all", () => {
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [annotation("a-1", "reviewer_a", at(10))],
        {
          consensus: [{ ids: ["a-1", "z-9"], note: "one id is not ours" }],
          disagreements: [],
        },
      ),
    );
    expect(report.crossReview.consensus).toBe(1);
    expect(report.crossReview.consensusCrossModel).toBe(0);
  });

  it("counts nothing when the panel produced no cross-review", () => {
    const report = measureAgreement(
      item([seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")]),
    );
    expect(report.crossReview).toEqual({
      consensus: 0,
      consensusCrossModel: 0,
      disagreements: 0,
      disagreementsCrossModel: 0,
    });
  });
});

describe("R5 O4 — the agreement report carries no score", () => {
  it("uses no word a reader could mistake for a verdict on the manuscript", () => {
    // The rule's home is `packages/harness/test/no-score.test.ts`; this is the
    // CLI's own guard over its own output (ADR 0070 §6).
    const banned =
      /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;
    const report = measureAgreement(
      item(
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("b-1", "reviewer_b", at(10)),
        ],
        {
          consensus: [{ ids: ["a-1", "b-1"], note: "agreed" }],
          disagreements: [],
        },
      ),
      recallWith({ reviewer_a: ["S1"], reviewer_b: ["S1"] }),
    );
    expect(JSON.stringify(report)).not.toMatch(banned);
    expect(formatAgreementReport(report)).not.toMatch(banned);
  });

  it("prints both group means and the cross-review's counts", () => {
    const text = formatAgreementReport(
      measureAgreement(
        item(
          [
            seat("reviewer_a", "pin-x"),
            seat("reviewer_b", "pin-x"),
            seat("reviewer_c", "pin-y"),
          ],
          [
            annotation("a-1", "reviewer_a", at(10)),
            annotation("b-1", "reviewer_b", at(10)),
            annotation("c-1", "reviewer_c", at(99)),
          ],
        ),
      ),
    );
    expect(text).toContain("same-model");
    expect(text).toContain("cross-model");
    expect(text).toContain("cross-review");
    expect(text).toContain("reviewer_a+reviewer_b");
  });
});
