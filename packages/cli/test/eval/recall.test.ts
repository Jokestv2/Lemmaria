/**
 * R5 (O2, and O4's recall half): the instrument itself.
 *
 * `matchDefects` is the whole measurement: it decides what counts as the panel
 * having FOUND a planted error, and every recall number R5 reports is its
 * output. The field's benchmark needs a fuzzy substring stage and then a judge
 * model to answer *is this comment about that error?*; Lemmaria's harness has
 * already located every concern byte-exactly in the manuscript's own bytes
 * (ADR 0060 §2), so the substring stage is at 100% by construction and what
 * remains is a **span-and-dimension** question a hand-authored manifest
 * answers deterministically (ADR 0070 §2).
 *
 * That makes the rule small enough to test exhaustively, which is the point:
 * a judge model's errors would be unmeasured, and these are not.
 *
 * The items here are hand-built rather than driven through the panel — the
 * seam that produces them is asserted by R3's and R9's driver suites, and what
 * is under test here is arithmetic over the record, not the record's making.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewLimit,
  ReviewSeatState,
  ReviewSpan,
} from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFECT_CATEGORIES,
  type DefectManifest,
  type DefectSpan,
  MATCHING_DIMENSIONS,
  type PlantedDefect,
  formatRecallReport,
  formatReviewerTallies,
  matchDefects,
  parsedSeats,
  readManifest,
} from "../../src/eval/recall.js";

// ── builders ────────────────────────────────────────────────────────────────

function defect(
  id: string,
  category: PlantedDefect["category"],
  spans: Array<{ line: number; endLine?: number }>,
): PlantedDefect {
  return {
    id,
    category,
    subtype: `${category}-subtype`,
    original: `original ${id}`,
    perturbed: `perturbed ${id}`,
    spans: spans.map((s, i) => ({
      anchor: i === 0 ? `perturbed ${id}` : `extra ${id}-${i}`,
      line: s.line,
      ...(s.endLine !== undefined ? { endLine: s.endLine } : {}),
    })),
    tell: `how a reader tells ${id}`,
  };
}

function manifestOf(defects: PlantedDefect[]): DefectManifest {
  return {
    fixture: "planted-defects",
    file: "main.tex",
    categories: [...DEFECT_CATEGORIES],
    defects,
  };
}

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

function seat(reviewer: string, model: string): ReviewSeatState {
  return { reviewer, status: "completed", model };
}

function item(
  annotations: ReviewAnnotation[],
  seats: ReviewSeatState[] = [seat("reviewer_a", "pin-x")],
  limits: ReviewLimit[] = [],
): ReviewItem {
  return {
    id: "review-1",
    type: "review",
    status: "completed",
    skill: "blind-reviewer",
    seats,
    result: {
      annotations,
      ...(limits.length > 0 ? { limits } : {}),
    },
  } as ReviewItem;
}

const at = (line: number, endLine?: number): ReviewSpan => ({
  file: "main.tex",
  line,
  ...(endLine !== undefined ? { endLine } : {}),
});

// ── the rule ────────────────────────────────────────────────────────────────

describe("R5 O2 — a hit is a located span over an admissible span", () => {
  it("counts a concern whose CLAIM span overlaps the defect", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(10))]),
      manifest,
    );
    expect(report.overall).toEqual({ planted: 1, found: 1, recall: 1 });
    expect(report.hits).toEqual([
      { defect: "S1", ids: ["a-1"], reviewers: ["reviewer_a"] },
    ]);
    expect(report.missed).toEqual([]);
    expect(report.unmatched).toEqual([]);
  });

  it("counts a concern whose EVIDENCE span overlaps it, anchored elsewhere", () => {
    // A reviewer may raise the concern on the abstract's summary and cite the
    // perturbed equation as its evidence. Both pointers are harness-located,
    // and either one landing on an admissible span is the reviewer pointing at
    // the error (ADR 0070 §2).
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(99), {
          evidence: { kind: "span", ...at(10) },
        }),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
    expect(report.hits[0]?.ids).toEqual(["a-1"]);
  });

  it('never counts `evidence: { kind: "missing" }` as a pointer', () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(99), {
          evidence: { kind: "missing" },
        }),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(0);
  });

  it("never counts a `paper` evidence as a pointer either (V2, O24)", () => {
    // ADR 0078 §1 gives `evidence` a third kind, and the reason the two
    // no-pointer cases read alike is the reason they are BOTH here: a paper is
    // a position in the literature, not a position in the manuscript. It has
    // no line to overlap with, so crediting it would mean crediting a concern
    // for pointing somewhere the manifest cannot describe.
    //
    // The claim anchor still counts, which the second half asserts — this
    // gates the evidence pointer, not the concern.
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const elsewhere = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(99), {
          evidence: {
            kind: "paper",
            title: "Widget representations",
            authors: ["Roe, Alex"],
            source: "arxiv",
          },
        }),
      ]),
      manifest,
    );
    expect(elsewhere.overall.found).toBe(0);

    const onTheDefect = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(10), {
          evidence: {
            kind: "paper",
            title: "Widget representations",
            authors: ["Roe, Alex"],
            source: "arxiv",
          },
        }),
      ]),
      manifest,
    );
    expect(onTheDefect.overall.found).toBe(1);
  });

  it("gates on dimension, and says so in spanOnlyHits rather than silently", () => {
    // A `language` concern on a sign-flipped equation is not a detection of the
    // sign flip. The gate is panel-wide, and the ungated tally is reported
    // beside the gated one so its effect is visible rather than assumed.
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(10), { dimension: "language" }),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(0);
    expect(report.spanOnlyHits).toBe(1);
    expect(report.missed).toEqual(["S1"]);
    // Not in `unmatched` either: it is a matched span, gated out by dimension.
    expect(report.unmatched).toEqual([]);
    expect(MATCHING_DIMENSIONS).toEqual(["soundness", "claims"]);
  });

  it("misses when the concern is in another file", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", {
          file: "sections/intro.tex",
          line: 10,
        }),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(0);
    expect(report.unmatched).toEqual(["a-1"]);
  });

  it("normalizes a path the harness's own two rules normalize", () => {
    // Exact, else one leading `./` stripped and `\` converted to `/` — the same
    // rule the locator uses (ADR 0060 §2). No basename fallback.
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", { file: "./main.tex", line: 10 })]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
  });

  it("misses when the concern is on another line", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10, endLine: 12 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(13))]),
      manifest,
    );
    expect(report.overall.found).toBe(0);
    expect(report.unmatched).toEqual(["a-1"]);
  });

  it("counts a range that merely intersects the defect's range", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10, endLine: 12 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(12, 20))]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
  });

  it("counts a concern whose range ENDS on the defect's first line", () => {
    // The other half of `pointer.line <= endOf(span) && span.line <= endOf(pointer)`.
    // The upper edge is covered twice above; without this one, a matcher that
    // compared only the two start lines would still pass every other case here.
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10, endLine: 12 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(5, 10))]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
  });

  it("misses when the concern's range stops one line short", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10, endLine: 12 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(5, 9))]),
      manifest,
    );
    expect(report.overall.found).toBe(0);
  });

  it("counts a hit through a defect's SECOND admissible span", () => {
    // The table row the perturbed sentence contradicts is where a reviewer
    // often points, and the manifest lists every span where the error is
    // visible for exactly that reason.
    const manifest = manifestOf([
      defect("C2", "claim", [{ line: 10 }, { line: 40 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(40))]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
    expect(report.hits[0]?.defect).toBe("C2");
  });

  it("never counts a dropped anchor — it is not in the annotations at all", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const limits: ReviewLimit[] = [
      {
        kind: "anchors_dropped",
        reviewer: "reviewer_a",
        anchors: [
          {
            anchor: "perturbed S1",
            file: "main.tex",
            role: "claim",
            reason: "not_found",
          },
        ],
      },
    ];
    const report = matchDefects(
      item([], [seat("reviewer_a", "pin-x")], limits),
      manifest,
    );
    expect(report.overall.found).toBe(0);
    expect(report.missed).toEqual(["S1"]);
    expect(report.perReviewer.reviewer_a?.dropped).toBe(1);
    expect(report.perReviewer.reviewer_a?.located).toBe(0);
    expect(report.perReviewer.reviewer_a?.concerns).toBe(1);
  });

  it("counts one defect once when two concerns land on it", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item(
        [
          annotation("a-1", "reviewer_a", at(10)),
          annotation("b-1", "reviewer_b", at(10)),
        ],
        [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-y")],
      ),
      manifest,
    );
    expect(report.overall).toEqual({ planted: 1, found: 1, recall: 1 });
    expect(report.hits).toEqual([
      {
        defect: "S1",
        ids: ["a-1", "b-1"],
        reviewers: ["reviewer_a", "reviewer_b"],
      },
    ]);
  });

  it("counts ONE defect when one concern spans two of them", () => {
    // **This assertion was inverted at the review round (I3).** It used to
    // expect 2/2 — a single concern covering two defects' lines crediting
    // both — which is the behaviour the round found in the shipped fixture,
    // where `C3` and `R2` both admit line 253 and one concern quoting it
    // scored 12.5% of an overall figure. A concern is credited with at most
    // one defect now; see the I3 block below for the rule and its tie-breaks.
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10 }]),
      defect("S2", "surface", [{ line: 11 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(10, 11))]),
      manifest,
    );
    expect(report.overall.found).toBe(1);
    expect(report.perCategory.surface).toEqual({
      planted: 2,
      found: 1,
      recall: 0.5,
    });
    expect(report.contested).toEqual([
      { id: "a-1", credited: "S1", alsoReached: ["S2"] },
    ]);
  });

  it("does the per-category arithmetic, and reports null where nothing is planted", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10 }]),
      defect("S2", "surface", [{ line: 20 }]),
      defect("S3", "surface", [{ line: 30 }]),
      defect("S4", "surface", [{ line: 40 }]),
      defect("C1", "claim", [{ line: 50 }]),
    ]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(10)),
        annotation("a-2", "reviewer_a", at(20)),
        annotation("a-3", "reviewer_a", at(50)),
      ]),
      manifest,
    );
    expect(report.perCategory.surface).toEqual({
      planted: 4,
      found: 2,
      recall: 0.5,
    });
    expect(report.perCategory.claim).toEqual({
      planted: 1,
      found: 1,
      recall: 1,
    });
    // Never NaN: a category with nothing planted has no recall, not a zero.
    expect(report.perCategory.reasoning).toEqual({
      planted: 0,
      found: 0,
      recall: null,
    });
    expect(report.perCategory.experimental.recall).toBeNull();
    expect(report.overall).toEqual({ planted: 5, found: 3, recall: 0.6 });
    expect(report.missed).toEqual(["S3", "S4"]);
  });

  it("lists as unmatched only concerns in a matching dimension", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(99)),
        annotation("a-2", "reviewer_a", at(99), { dimension: "claims" }),
        annotation("a-3", "reviewer_a", at(99), { dimension: "positioning" }),
        annotation("a-4", "reviewer_a", at(99), { dimension: "clarity" }),
      ]),
      manifest,
    );
    // A panel that flags everything is visible for what it is (ADR 0070 §6) —
    // but only over the dimensions the gate admits, or the number would be a
    // tally of style notes.
    expect(report.unmatched).toEqual(["a-1", "a-2"]);
    expect(report.spanOnlyHits).toBe(0);
  });

  it("tallies each reviewer from the seats and the limits", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10 }]),
      defect("C1", "claim", [{ line: 20 }]),
    ]);
    const limits: ReviewLimit[] = [
      {
        kind: "anchors_dropped",
        reviewer: "reviewer_b",
        anchors: [
          { anchor: "x", role: "claim", reason: "not_found" },
          { anchor: "y", role: "evidence", reason: "ambiguous" },
        ],
      },
      { kind: "seat_missing", reviewer: "reviewer_c", reason: "failed" },
    ];
    const report = matchDefects(
      item(
        [
          annotation("a-1", "reviewer_a", at(10), { blocking: true }),
          annotation("a-2", "reviewer_a", at(20), { severity: "minor" }),
          annotation("b-1", "reviewer_b", at(20)),
        ],
        [
          seat("reviewer_a", "pin-x"),
          seat("reviewer_b", "pin-y"),
          { reviewer: "reviewer_c", status: "failed", model: "pin-x" },
        ],
        limits,
      ),
      manifest,
    );
    expect(report.perReviewer.reviewer_a).toEqual({
      model: "pin-x",
      concerns: 2,
      located: 2,
      dropped: 0,
      majors: 1,
      blockingMajors: 1,
      found: ["S1", "C1"],
    });
    expect(report.perReviewer.reviewer_b).toEqual({
      model: "pin-y",
      concerns: 3,
      located: 1,
      dropped: 2,
      majors: 1,
      blockingMajors: 0,
      found: ["C1"],
    });
    // A seat that never reported is still a row, with nothing in it.
    expect(report.perReviewer.reviewer_c).toEqual({
      model: "pin-x",
      concerns: 0,
      located: 0,
      dropped: 0,
      majors: 0,
      blockingMajors: 0,
      found: [],
    });
  });

  it("reports a panel that ran and found nothing as zeros, not as an error", () => {
    // `recall_zero` is an outcome, tallied and named in the Done record as a
    // finding — never a failure (ADR 0035 §5).
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const report = matchDefects(item([]), manifest);
    expect(report.overall).toEqual({ planted: 1, found: 0, recall: 0 });
    expect(report.fixture).toBe("planted-defects");
  });

  it("survives an item with no result at all", () => {
    const manifest = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    const bare = { ...item([]), result: undefined } as ReviewItem;
    const report = matchDefects(bare, manifest);
    expect(report.overall.found).toBe(0);
    expect(report.perReviewer.reviewer_a?.concerns).toBe(0);
  });
});

describe("X5 O17 — a span may name its own file, for a split manuscript", () => {
  /** A defect whose span sits in a section file, not the entry. */
  const inMethod = (): PlantedDefect => {
    const d = defect("M1", "reasoning", [{ line: 89 }]);
    return {
      ...d,
      spans: d.spans.map((s) => ({ ...s, file: "sections/method.tex" })),
    };
  };

  it("is reached only by a concern in THAT file", () => {
    // The whole point of the split fixture: a concern anchored at
    // `method.tex:89` and one anchored at `main.tex:89` are different
    // findings, and a matcher blind to the file would credit both.
    const manifest = manifestOf([inMethod()]);
    const hit = matchDefects(
      item([
        annotation("a-1", "reviewer_a", {
          file: "sections/method.tex",
          line: 89,
        }),
      ]),
      manifest,
    );
    expect(hit.overall.found).toBe(1);
    const miss = matchDefects(
      item([annotation("a-1", "reviewer_a", { file: "main.tex", line: 89 })]),
      manifest,
    );
    expect(miss.overall.found).toBe(0);
  });

  it("falls back to the manifest's own file when a span names none", () => {
    // Absent means "the manifest's `file`", so the FLAT manifest — where no
    // span carries one — keeps matching exactly as it did. That backward
    // reading is what lets the two fixtures share one matcher.
    const manifest = manifestOf([defect("F1", "surface", [{ line: 12 }])]);
    const hit = matchDefects(
      item([annotation("a-1", "reviewer_a", at(12))]),
      manifest,
    );
    expect(hit.overall.found).toBe(1);
  });

  it("lets one defect span two files, which a shared table needs", () => {
    // C1/C2 in the split fixture have spans in both `experiments.tex` and
    // `tables/main-results.tex`: the prose makes the claim, the table carries
    // the numbers. Either anchor is admissible, so the file lives on the
    // SPAN and not on the defect.
    const d = defect("C1", "claim", [{ line: 55 }, { line: 14 }]);
    const manifest = manifestOf([
      {
        ...d,
        spans: [
          { ...(d.spans[0] as DefectSpan), file: "sections/experiments.tex" },
          { ...(d.spans[1] as DefectSpan), file: "tables/main-results.tex" },
        ],
      },
    ]);
    for (const span of [
      { file: "sections/experiments.tex", line: 55 },
      { file: "tables/main-results.tex", line: 14 },
    ]) {
      expect(
        matchDefects(item([annotation("a-1", "reviewer_a", span)]), manifest)
          .overall.found,
      ).toBe(1);
    }
  });
});

describe("X5 O20 — the instrument reads the ledger tally", () => {
  const withLedger = (
    reviewer: string,
    ledger: ReviewSeatState["ledger"],
  ): ReviewSeatState => ({
    reviewer,
    status: "completed",
    model: "pin-x",
    ...(ledger !== undefined ? { ledger } : {}),
    ...(ledger?.firstPass !== undefined ? { retried: true as const } : {}),
  });

  it("copies each seat's counts onto its tally", () => {
    const report = matchDefects(
      item(
        [annotation("a-1", "reviewer_a", at(10))],
        [
          withLedger("reviewer_a", {
            entries: 3,
            located: 2,
            relocated: 1,
            dropped: 0,
            rejected: 1,
            firstPass: {
              entries: 3,
              located: 1,
              relocated: 0,
              dropped: 1,
              rejected: 1,
            },
          }),
        ],
      ),
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    expect(report.perReviewer.reviewer_a?.ledger?.located).toBe(2);
    expect(report.perReviewer.reviewer_a?.ledger?.firstPass?.located).toBe(1);
  });

  it("prints before and after the re-ask, and what relocated", () => {
    // `first=… → final=…` is how "before and after the re-ask" is read off ONE
    // run. A seat that never retried prints only its final counts, because
    // there is no before to compare against.
    const report = matchDefects(
      item(
        [annotation("a-1", "reviewer_a", at(10))],
        [
          withLedger("reviewer_a", {
            entries: 3,
            located: 2,
            relocated: 1,
            dropped: 0,
            rejected: 1,
            firstPass: {
              entries: 3,
              located: 1,
              relocated: 0,
              dropped: 1,
              rejected: 1,
            },
          }),
          withLedger("reviewer_b", {
            entries: 2,
            located: 2,
            relocated: 0,
            dropped: 0,
            rejected: 0,
          }),
        ],
      ),
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    const text = formatReviewerTallies(report);
    expect(text).toContain("first=3/1/1/1 → final=3/2/0/1 relocated=1");
    expect(text).toContain("final=2/2/0/0 relocated=0");
    expect(text).not.toContain("first=2/2/0/0");
  });

  it("prints the panel's located rate before and after, and the conservative one", () => {
    // A WITHDRAWN entry leaves `entries` (ADR 0074 §5), so a rate can rise
    // because a seat gave up on an entry rather than because it corrected
    // one. Final `located` over FIRST-PASS `entries` is the reading that
    // cannot be flattered that way, and both are printed from the same raw
    // counts so a reader can see which is which.
    const report = matchDefects(
      item(
        [annotation("a-1", "reviewer_a", at(10))],
        [
          withLedger("reviewer_a", {
            // Two entries survived of the four first sent: one corrected, one
            // withdrawn. Final rate 2/2 = 100%; conservative 2/4 = 50%.
            entries: 2,
            located: 2,
            relocated: 0,
            dropped: 0,
            rejected: 0,
            firstPass: {
              entries: 4,
              located: 1,
              relocated: 0,
              dropped: 2,
              rejected: 1,
            },
          }),
        ],
      ),
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    const text = formatRecallReport(report);
    expect(text).toContain("located rate: first 1/4 (25%) → final 2/2 (100%)");
    expect(text).toContain("conservative 2/4 (50%)");
    expect(text).toContain("relocated 0");
    expect(text).toContain("rejected 0");
  });

  it("says nothing about the ledger when no seat reported one", () => {
    // A panel from before X5, or one whose seats all failed. The line is
    // absent rather than printed as zeros, for the same reason `measured`
    // exists: an absent measurement and a measured zero are opposite
    // findings.
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(10))]),
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    expect(formatRecallReport(report)).not.toContain("located rate:");
    expect(formatReviewerTallies(report)).not.toContain("final=");
  });
});

describe("X5 O21 — the outage-shaped concern count (D12's instrument)", () => {
  const about = (message: string): ReviewAnnotation =>
    annotation("a-1", "reviewer_a", at(10), { message });

  it("counts a concern that is really a literature outage, and names it", () => {
    // The instrument for D12's skill change, REPORTED and never asserted: the
    // whole point is to watch the number fall as the protocol takes effect,
    // and an assertion would turn the first reading into a threshold.
    const report = matchDefects(
      item([
        about("Crossref timed out, so the novelty claim cannot be checked."),
      ]),
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    expect(report.outageShaped.map((o) => o.id)).toEqual(["a-1"]);
  });

  it("needs BOTH a source and an outage word, so a real concern is not caught", () => {
    // Two independent patterns, deliberately: "the arXiv version differs from
    // this one" names a source and is a real finding; "the proof timed out"
    // is a joke about a prover. Only the conjunction is outage-shaped.
    for (const message of [
      "The arXiv version of [3] differs from the one cited here.",
      "The experiment timed out at 40 epochs, which is not reported.",
      "",
    ]) {
      const report = matchDefects(
        item([about(message)]),
        manifestOf([defect("S1", "surface", [{ line: 10 }])]),
      );
      expect(`${message}: ${report.outageShaped.length}`).toBe(`${message}: 0`);
    }
  });

  it("matches the outage words the round actually produced", () => {
    for (const message of [
      "DBLP was rate limited, so this may already exist.",
      "Semantic Scholar did not answer; the comparison is inconclusive.",
      "crossref unavailable — I could not verify the citation.",
      "arXiv search failed, so novelty is unconfirmed.",
    ]) {
      const report = matchDefects(
        item([about(message)]),
        manifestOf([defect("S1", "surface", [{ line: 10 }])]),
      );
      expect(`${message}: ${report.outageShaped.length}`).toBe(`${message}: 1`);
    }
  });
});

// ── the manifest reader ─────────────────────────────────────────────────────

describe("R5 O2 — readManifest refuses a manifest that cannot be ground truth", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });

  async function write(manifest: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-manifest-"));
    dirs.push(dir);
    const path = join(dir, "defects.json");
    await writeFile(path, JSON.stringify(manifest), "utf8");
    return path;
  }

  it("refuses a manifest whose span `file` is not a string", async () => {
    // The same standard the other span fields already hold. A manifest that
    // is wrong about WHERE a defect is would measure the wrong thing while
    // looking healthy, and a silently wrong instrument is worse than none.
    const bad = manifestOf([
      defect("S1", "surface", [{ line: 3 }]),
    ]) as unknown as {
      defects: Array<{ spans: Array<Record<string, unknown>> }>;
    };
    const firstSpan = bad.defects[0]?.spans[0];
    if (firstSpan) firstSpan.file = 7;
    await expect(readManifest(await write(bad))).rejects.toThrow(
      /malformed span/,
    );
  });

  it("reads a well-formed one", async () => {
    const path = await write(
      manifestOf([defect("S1", "surface", [{ line: 10 }])]),
    );
    const manifest = await readManifest(path);
    expect(manifest.defects).toHaveLength(1);
    expect(manifest.defects[0]?.id).toBe("S1");
  });

  it("refuses a duplicate id", async () => {
    const path = await write(
      manifestOf([
        defect("S1", "surface", [{ line: 10 }]),
        defect("S1", "claim", [{ line: 20 }]),
      ]),
    );
    await expect(readManifest(path)).rejects.toThrow(/duplicate/i);
  });

  it("refuses an unknown category", async () => {
    const bad = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    (bad.defects[0] as { category: string }).category = "typographic";
    const path = await write(bad);
    await expect(readManifest(path)).rejects.toThrow(/category/i);
  });

  it("refuses a defect with no admissible span", async () => {
    const bad = manifestOf([defect("S1", "surface", [])]);
    const path = await write(bad);
    await expect(readManifest(path)).rejects.toThrow(/span/i);
  });

  it("refuses a defect with no subtype", async () => {
    const bad = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    (bad.defects[0] as { subtype: string }).subtype = "";
    await expect(readManifest(await write(bad))).rejects.toThrow(/subtype/i);
  });

  it("refuses a defect that perturbs nothing", async () => {
    // A row whose `original` equals its `perturbed` planted no defect, so a
    // reviewer that "misses" it missed nothing -- and the recall would read
    // one lower than the truth for a reason no reader could see.
    const bad = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    (bad.defects[0] as { original: string }).original = "perturbed S1";
    await expect(readManifest(await write(bad))).rejects.toThrow(
      /perturbs nothing/i,
    );
  });

  it("refuses a defect whose first span is not its perturbed text", async () => {
    const bad = manifestOf([defect("S1", "surface", [{ line: 10 }])]);
    (bad.defects[0] as PlantedDefect).spans[0] = {
      anchor: "some other line entirely",
      line: 10,
    };
    await expect(readManifest(await write(bad))).rejects.toThrow(
      /first span is not its perturbed text/i,
    );
  });

  it("refuses a file that is not a manifest at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-manifest-"));
    dirs.push(dir);
    const path = join(dir, "defects.json");
    await writeFile(path, "not json", "utf8");
    await expect(readManifest(path)).rejects.toThrow();
  });

  describe("V1 (ADR 0076, plan D11): the traps beside the defects", () => {
    const trap = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      complaint: "the paper reports no limitation",
      bait: [{ anchor: "bait line", line: 3 }],
      answer: [{ anchor: "answer line", line: 40 }],
      tell: "the discussion states two limitations",
      ...over,
    });
    const withTraps = (traps: unknown[]) => ({
      ...manifestOf([defect("S1", "surface", [{ line: 10 }])]),
      traps,
    });

    it("reads them, and a manifest without any reads as it did", async () => {
      const read = await readManifest(await write(withTraps([trap("T1")])));
      expect(read.traps?.map((t) => t.id)).toEqual(["T1"]);
      const none = await readManifest(
        await write(manifestOf([defect("S1", "surface", [{ line: 10 }])])),
      );
      expect(none.traps ?? []).toEqual([]);
    });

    it.each([
      ["an id that is not T<n>", [trap("S9")], /trap id/i],
      ["a duplicate id", [trap("T1"), trap("T1")], /duplicate trap/i],
      ["an empty complaint", [trap("T1", { complaint: "" })], /complaint/i],
      ["an empty tell", [trap("T1", { tell: "" })], /tell/i],
      ["no bait span", [trap("T1", { bait: [] })], /bait/i],
      ["no answer span", [trap("T1", { answer: [] })], /answer/i],
      [
        "a malformed span",
        [trap("T1", { answer: [{ anchor: 4, line: 40 }] })],
        /malformed/i,
      ],
    ])("refuses %s — refuse, never repair", async (_label, traps, pattern) => {
      await expect(readManifest(await write(withTraps(traps)))).rejects.toThrow(
        pattern,
      );
    });

    it("refuses a traps key that is not a list", async () => {
      await expect(
        readManifest(await write({ ...withTraps([]), traps: "T1" })),
      ).rejects.toThrow(/traps/i);
    });
  });

  it("reads the shipped fixture's own manifest", async () => {
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = await readManifest(
      resolve(here, "../live/fixtures/planted-defects/defects.json"),
    );
    expect(manifest.defects).toHaveLength(16);
    expect(manifest.file).toBe("main.tex");
  });
});

// ── the report says nothing about the paper ─────────────────────────────────

describe("R5 O4 — the recall report carries no score", () => {
  it("uses no word a reader could mistake for a verdict on the manuscript", () => {
    // The home of this rule is `packages/harness/test/no-score.test.ts`, whose
    // SCOPE is harness-relative and stays unchanged; this is the CLI's own
    // guard over its own output (ADR 0070 §6). A measurement of the reviewer is
    // not a score of the paper.
    const banned =
      /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10 }]),
      defect("C1", "claim", [{ line: 20 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(10))]),
      manifest,
    );
    expect(JSON.stringify(report)).not.toMatch(banned);
    expect(formatRecallReport(report)).not.toMatch(banned);
  });

  it("prints found/planted per category, never a bare percentage", () => {
    const manifest = manifestOf([
      defect("S1", "surface", [{ line: 10 }]),
      defect("S2", "surface", [{ line: 20 }]),
      defect("C1", "claim", [{ line: 30 }]),
      defect("R1", "reasoning", [{ line: 40 }]),
      defect("E1", "experimental", [{ line: 50 }]),
    ]);
    const text = formatRecallReport(
      matchDefects(item([annotation("a-1", "reviewer_a", at(10))]), manifest),
    );
    expect(text).toContain("surface: 1/2");
    expect(text).toContain("claim: 0/1");
    expect(text).toContain("overall: 1/5");
    expect(text).toContain("unmatched: 0");
    expect(text).toContain("span-only: 0");
    for (const category of DEFECT_CATEGORIES) expect(text).toContain(category);
  });
});

/**
 * The review round's **I3**: two defects may legitimately share an admissible
 * span, and nothing stopped ONE concern from being credited with both.
 *
 * Reproduced in the shipped fixture — `C3` and `R2` both admit line 253
 * (`eq:cost`) — where a single `soundness` concern quoting that line scored
 * 2/16 across two different categories, 12.5% of an overall figure, off one
 * sentence. It is the mirror image of the failure the span-list audit (J1)
 * exists to catch: there a vague concern inflates recall by being admitted,
 * here one concern inflates it by being admitted twice.
 */
describe("R5 I3 — one concern is credited with at most one defect", () => {
  it("credits a concern reaching two defects to exactly one of them", () => {
    const manifest = manifestOf([
      defect("C3", "claim", [{ line: 450 }, { line: 253 }]),
      defect("R2", "reasoning", [{ line: 263 }, { line: 253 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(253))]),
      manifest,
    );
    expect(report.overall).toEqual({ planted: 2, found: 1, recall: 0.5 });
    // Manifest order decides when neither pointer discriminates, and the
    // report NAMES the loser rather than dropping it silently.
    expect(report.hits).toEqual([
      { defect: "C3", ids: ["a-1"], reviewers: ["reviewer_a"] },
    ]);
    expect(report.missed).toEqual(["R2"]);
    expect(report.contested).toEqual([
      { id: "a-1", credited: "C3", alsoReached: ["R2"] },
    ]);
    // One concern, one defect, in one reviewer's found list.
    expect(report.perReviewer.reviewer_a?.found).toEqual(["C3"]);
  });

  it("lets the CLAIM pointer win over a pointer that is only evidence", () => {
    // The case the shared span was widened FOR: `C1`'s objection is against
    // the lemma and cites a Table 1 row, `C2`'s is against the 98% sentence
    // and cites the same row. Each concern is about what its claim anchor
    // points at, so each must reach its own defect even though both touch 337.
    const manifest = manifestOf([
      defect("C1", "claim", [{ line: 227, endLine: 228 }, { line: 337 }]),
      defect("C2", "claim", [{ line: 315 }, { line: 337 }]),
    ]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(227, 228), {
          evidence: { kind: "span", ...at(337) },
        }),
        annotation("a-2", "reviewer_a", at(315), {
          evidence: { kind: "span", ...at(337) },
        }),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(2);
    expect(report.hits).toEqual([
      { defect: "C1", ids: ["a-1"], reviewers: ["reviewer_a"] },
      { defect: "C2", ids: ["a-2"], reviewers: ["reviewer_a"] },
    ]);
    // Both concerns DID reach the other defect through their evidence anchor;
    // the rule resolved it, and the report says so.
    expect(report.contested).toEqual([
      { id: "a-1", credited: "C1", alsoReached: ["C2"] },
      { id: "a-2", credited: "C2", alsoReached: ["C1"] },
    ]);
  });

  it("still lets two DIFFERENT concerns credit two sharing defects", () => {
    // The rule bounds one concern, never a defect: a panel that really found
    // both errors is credited with both.
    const manifest = manifestOf([
      defect("C3", "claim", [{ line: 450 }, { line: 253 }]),
      defect("R2", "reasoning", [{ line: 263 }, { line: 253 }]),
    ]);
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(450)),
        annotation("a-2", "reviewer_a", at(263)),
      ]),
      manifest,
    );
    expect(report.overall.found).toBe(2);
    expect(report.contested).toEqual([]);
    expect(report.missed).toEqual([]);
  });

  it("V1 O25: filters BEFORE the contest — a withdrawn concern is out of it, not merely uncounted", () => {
    // ADR 0071 §2: the one-credit rule picks among what is left. A concern
    // verification withdrew must not appear as a contest the rule resolved,
    // nor as an unmatched concern, because it is no longer in the review.
    const manifest = manifestOf([
      defect("C3", "claim", [{ line: 450 }, { line: 253 }]),
      defect("R2", "reasoning", [{ line: 263 }, { line: 253 }]),
    ]);
    const withdrawn = { outcome: "refuted", kind: "absence" } as const;
    const report = matchDefects(
      item([
        annotation("a-1", "reviewer_a", at(253), { verification: withdrawn }),
        annotation("a-2", "reviewer_a", at(263)),
        annotation("a-3", "reviewer_a", at(900), { verification: withdrawn }),
      ]),
      manifest,
      (a) => a.verification?.outcome !== "refuted",
    );
    expect(report.hits).toEqual([
      { defect: "R2", ids: ["a-2"], reviewers: ["reviewer_a"] },
    ]);
    expect(report.contested).toEqual([]);
    expect(report.unmatched).toEqual([]);
    // What the reviewer SAID is unchanged by what verification withdrew.
    expect(report.perReviewer.reviewer_a?.located).toBe(3);
    expect(report.perReviewer.reviewer_a?.found).toEqual(["R2"]);
  });

  it("counts a contested concern once in unmatched-vs-matched bookkeeping", () => {
    const manifest = manifestOf([
      defect("C3", "claim", [{ line: 450 }, { line: 253 }]),
      defect("R2", "reasoning", [{ line: 263 }, { line: 253 }]),
    ]);
    const report = matchDefects(
      item([annotation("a-1", "reviewer_a", at(253))]),
      manifest,
    );
    expect(report.unmatched).toEqual([]);
    expect(report.spanOnlyHits).toBe(0);
  });
});

/**
 * The review round's **I1**: a run where no seat produced a readable ledger
 * printed a complete recall table of 0/16, byte-shaped exactly like a
 * measurement.
 *
 * `tests/r5/1-audit-the-ground-truth` and `4-flagship-recall` tell the
 * operator three times that `panel_unparsed` *"is not a measurement — record
 * it as unmeasured, never as a recall of zero"*, and the instrument printed
 * the number they forbid, with the only distinguishing token on a previous
 * line. The absence of a measurement and a measured zero are opposite
 * findings, and the one that reaches a durable record must not be a guess.
 */
describe("R5 I1 — no parsed ledger is unmeasured, not a recall of zero", () => {
  const manifest = manifestOf([
    defect("S1", "surface", [{ line: 10 }]),
    defect("C1", "claim", [{ line: 20 }]),
  ]);

  it("marks a panel whose every seat is missing as unmeasured", () => {
    const dead = item(
      [],
      [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-x")],
      [
        { kind: "seat_missing", reviewer: "reviewer_a", reason: "failed" },
        { kind: "seat_missing", reviewer: "reviewer_b", reason: "unparsed" },
      ],
    );
    expect(parsedSeats(dead)).toBe(0);
    expect(matchDefects(dead, manifest).measured).toBe(false);
  });

  it("prints no category line, no overall ratio and no missed list", () => {
    const dead = item(
      [],
      [seat("reviewer_a", "pin-x")],
      [{ kind: "seat_missing", reviewer: "reviewer_a", reason: "failed" }],
    );
    const text = formatRecallReport(matchDefects(dead, manifest));
    expect(text).toContain("unmeasured");
    // The four numbers an operator would otherwise copy into the ledger.
    expect(text).not.toContain("overall:");
    expect(text).not.toContain("missed:");
    expect(text).not.toContain("surface:");
    expect(text).not.toMatch(/\b0\/2\b/);
  });

  it("keeps an EMPTY panel measured — the seats reported, and found nothing", () => {
    // `panel_empty` is a model finding on this fixture, not an absent
    // measurement: sixteen defects were planted in it on purpose, so a panel
    // that read it and raised nothing really did score zero.
    const quiet = item([], [seat("reviewer_a", "pin-x")]);
    expect(parsedSeats(quiet)).toBe(1);
    const report = matchDefects(quiet, manifest);
    expect(report.measured).toBe(true);
    expect(report.overall).toEqual({ planted: 2, found: 0, recall: 0 });
    const text = formatRecallReport(report);
    expect(text).toContain("overall: 0/2");
    expect(text).not.toContain("unmeasured");
  });

  it("keeps a PARTIAL panel measured — one live seat is a reading", () => {
    // ADR 0070's one anthropic reading on this fixture is a `panel_partial`
    // of 1 of 16, and it is recorded as a real measurement.
    const partial = item(
      [annotation("a-1", "reviewer_a", at(10))],
      [seat("reviewer_a", "pin-x"), seat("reviewer_b", "pin-x")],
      [{ kind: "seat_missing", reviewer: "reviewer_b", reason: "unparsed" }],
    );
    expect(parsedSeats(partial)).toBe(1);
    const report = matchDefects(partial, manifest);
    expect(report.measured).toBe(true);
    expect(report.overall.found).toBe(1);
  });
});
