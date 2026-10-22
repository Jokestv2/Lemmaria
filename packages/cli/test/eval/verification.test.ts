/**
 * V1 (plan D12, O25): what verification did to one review, read twice.
 *
 * The verifier withdraws concerns, and nothing it does is a measurement of
 * itself: it can withdraw careless complaints (good), withdraw true defects
 * (the error that would condemn it), or do nothing at all. This instrument
 * says which — recall before and after on the same run, the defects lost to a
 * withdrawal, which planted traps were raised and whether they were answered
 * where the manuscript answers them, and what the verifier made of *blocking*.
 *
 * Hand-built items, as in `recall.test.ts`: what is under test is arithmetic
 * over the record, not the record's making.
 */
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewLimit,
  ReviewSeatState,
  ReviewSpan,
  ReviewVerification,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  DEFECT_CATEGORIES,
  type DefectManifest,
  type PlantedDefect,
  type Trap,
} from "../../src/eval/recall.js";
import {
  formatVerificationReport,
  measureVerification,
} from "../../src/eval/verification.js";

// ── builders ────────────────────────────────────────────────────────────────

const at = (line: number, file = "main.tex"): ReviewSpan => ({ file, line });

function defect(id: string, line: number): PlantedDefect {
  return {
    id,
    category: "claim",
    subtype: "claim-subtype",
    original: `original ${id}`,
    perturbed: `perturbed ${id}`,
    spans: [{ anchor: `perturbed ${id}`, line }],
    tell: `how a reader tells ${id}`,
  };
}

function trap(id: string, bait: number, answers: number[]): Trap {
  return {
    id,
    complaint: `careless complaint ${id}`,
    bait: [{ anchor: `bait ${id}`, line: bait }],
    answer: answers.map((line, i) => ({ anchor: `answer ${id}-${i}`, line })),
    tell: `where the paper answers ${id}`,
  };
}

function manifestOf(defects: PlantedDefect[], traps?: Trap[]): DefectManifest {
  return {
    fixture: "planted-defects",
    file: "main.tex",
    categories: [...DEFECT_CATEGORIES],
    defects,
    ...(traps !== undefined ? { traps } : {}),
  };
}

function concern(
  id: string,
  span: ReviewSpan,
  extra: Partial<ReviewAnnotation> = {},
): ReviewAnnotation {
  return {
    id,
    reviewer: "reviewer_a",
    dimension: "soundness",
    severity: "major",
    span,
    message: `concern ${id}`,
    ...extra,
  };
}

const refuted = (counter: ReviewSpan): ReviewVerification => ({
  outcome: "refuted",
  kind: "absence",
  counter,
});
const upheld: ReviewVerification = { outcome: "upheld", kind: "absence" };

const verifierSeat = (
  counts: Partial<NonNullable<ReviewSeatState["verification"]>> = {},
): ReviewSeatState => ({
  reviewer: "verifier",
  status: "completed",
  model: "verifier-model",
  verification: {
    concerns: 0,
    upheld: 0,
    refuted: 0,
    unverifiable: 0,
    downgraded: 0,
    unanswered: 0,
    ...counts,
  },
});

function item(
  annotations: ReviewAnnotation[],
  over: Partial<ReviewItem> = {},
  limits: ReviewLimit[] = [],
): ReviewItem {
  return {
    id: "review-1",
    type: "review",
    status: "completed",
    skill: "blind-reviewer",
    seats: [{ reviewer: "reviewer_a", status: "completed", model: "pin-x" }],
    verification: "completed",
    verifierSeat: verifierSeat(),
    result: {
      annotations,
      ...(limits.length > 0 ? { limits } : {}),
    },
    ...over,
  } as ReviewItem;
}

// ── before and after: one run, read twice ───────────────────────────────────

describe("V1 O25 — recall before and after verification", () => {
  it("drops what verification withdrew, and names the defect it cost", () => {
    const manifest = manifestOf([defect("S1", 10), defect("C1", 20)]);
    const report = measureVerification(
      item([
        concern("a-1", at(10), { verification: refuted(at(40)) }),
        concern("a-2", at(20), { verification: upheld }),
      ]),
      manifest,
    );
    expect(report.before.overall).toEqual({
      planted: 2,
      found: 2,
      recall: 1,
    });
    expect(report.after.overall).toEqual({
      planted: 2,
      found: 1,
      recall: 0.5,
    });
    expect(report.after.hits.map((h) => h.defect)).toEqual(["C1"]);
    // A true defect the verifier refuted is the verifier's error — the one
    // number that would condemn it, so it is named, not just counted.
    expect(report.lost).toEqual(["S1"]);
  });

  it("loses nothing a surviving concern still credits", () => {
    const manifest = manifestOf([defect("S1", 10)]);
    const report = measureVerification(
      item([
        concern("a-1", at(10), { verification: refuted(at(40)) }),
        concern("b-1", at(10), { reviewer: "reviewer_b" }),
      ]),
      manifest,
    );
    expect(report.after.overall.found).toBe(1);
    expect(report.after.hits[0]?.ids).toEqual(["b-1"]);
    expect(report.lost).toEqual([]);
  });

  it("keeps a run where everything was withdrawn MEASURED — 0/n, never unmeasured", () => {
    // ADR 0071 §1: a withdrawal is a reading, not an outage. `measured` keys
    // off the seats that produced a ledger, which verification cannot change.
    const manifest = manifestOf([defect("S1", 10), defect("C1", 20)]);
    const report = measureVerification(
      item([
        concern("a-1", at(10), { verification: refuted(at(40)) }),
        concern("a-2", at(20), { verification: refuted(at(41)) }),
      ]),
      manifest,
    );
    expect(report.after.measured).toBe(true);
    expect(report.after.overall.found).toBe(0);
    const text = formatVerificationReport(report);
    expect(text).toContain("2/2 → 0/2");
    expect(text).not.toMatch(/unmeasured/);
  });

  it("carries the verifier's own tally, and says so when there was no verifier", () => {
    const counts = {
      concerns: 2,
      upheld: 1,
      refuted: 1,
      unverifiable: 0,
      downgraded: 0,
      unanswered: 0,
    };
    const ran = measureVerification(
      item([], { verifierSeat: verifierSeat(counts) }),
      manifestOf([defect("S1", 10)]),
    );
    expect(ran.ran).toBe(true);
    expect(ran.tally).toEqual(counts);

    const off = measureVerification(
      item(
        [concern("a-1", at(10))],
        {
          verification: "off",
          verifierSeat: undefined,
        },
        [{ kind: "verification_missing", reason: "off" }],
      ),
      manifestOf([defect("S1", 10)]),
    );
    expect(off.ran).toBe(false);
    expect(off.tally).toBeUndefined();
    // Nothing withdrawn, so the second reading is the first.
    expect(off.after.overall).toEqual(off.before.overall);
    expect(formatVerificationReport(off)).toMatch(/not run.*off/);
  });

  it("counts the concerns nobody checked, and says so beside the second reading", () => {
    // What was never checked cannot have been withdrawn, so *after* equals
    // *before* for it — the recall line has to say how much of that sameness
    // is a reading and how much is silence.
    const manifest = manifestOf([defect("S1", 10), defect("C1", 20)]);
    const partial = measureVerification(
      item([
        concern("a-1", at(10), { verification: upheld }),
        concern("a-2", at(20)),
        concern("a-3", at(60)),
      ]),
      manifest,
    );
    expect(partial.unchecked).toBe(2);
    expect(formatVerificationReport(partial)).toContain(
      "lost to verification: none; 2 of 3 concerns not checked",
    );

    const whole = measureVerification(
      item([concern("a-1", at(10), { verification: upheld })]),
      manifest,
    );
    expect(whole.unchecked).toBe(0);
    expect(formatVerificationReport(whole)).not.toContain("not checked");
  });

  it("names every way verification fell short, beside the tally", () => {
    const report = measureVerification(
      item([], { verification: "missing" }, [
        { kind: "verification_missing", reason: "incomplete" },
        { kind: "verification_missing", reason: "failed" },
        { kind: "seat_missing", reviewer: "reviewer_b" },
      ] as ReviewLimit[]),
      manifestOf([defect("S1", 10)]),
    );
    expect(report.limits).toEqual(["incomplete", "failed"]);
    expect(formatVerificationReport(report)).toContain(
      "fell short: incomplete, failed",
    );
  });
});

// ── the traps ───────────────────────────────────────────────────────────────

describe("V1 O25 — a trap hit is a careless complaint at the bait", () => {
  const manifest = manifestOf(
    [defect("S1", 10)],
    [trap("T1", 30, [80]), trap("T3", 34, [90, 95])],
  );

  it("needs the CLAIM on the bait AND evidence recorded as missing — any dimension", () => {
    const report = measureVerification(
      item([
        concern("hit", at(30), { evidence: { kind: "missing" } }),
        concern("cited", at(30), { evidence: { kind: "span", ...at(50) } }),
        concern("no-evidence-key", at(30)),
        concern("elsewhere", at(99), { evidence: { kind: "missing" } }),
        concern("evidence-on-bait", at(99), {
          evidence: { kind: "span", ...at(30) },
        }),
        concern("language", at(34), {
          dimension: "language",
          evidence: { kind: "missing" },
        }),
        concern("other-file", at(30, "sections/intro.tex"), {
          evidence: { kind: "missing" },
        }),
        // V2 (ADR 0078 §1, O24): the third kind, on the bait. A reviewer who
        // answered the bait with a PAPER looked something up and cited what it
        // found — the opposite of the carelessness a trap is built to catch —
        // so it is no more a hit than the `cited` row above. The expectation
        // below is unchanged by this row, which is the assertion.
        concern("paper-cited", at(30), {
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
    expect(report.traps.planted).toBe(2);
    expect(report.traps.hits.map((h) => [h.trap, h.concern])).toEqual([
      ["T1", "hit"],
      ["T3", "language"],
    ]);
  });

  it("says whether each hit was withdrawn, and whether its counter is on the answer", () => {
    const report = measureVerification(
      item([
        concern("on-answer", at(30), {
          evidence: { kind: "missing" },
          verification: refuted(at(80)),
        }),
        concern("off-answer", at(30), {
          evidence: { kind: "missing" },
          verification: refuted(at(70)),
        }),
        concern("kept", at(30), {
          evidence: { kind: "missing" },
          verification: upheld,
        }),
        concern("second-answer", at(34), {
          evidence: { kind: "missing" },
          verification: refuted(at(95)),
        }),
        concern("answer-in-another-file", at(34), {
          evidence: { kind: "missing" },
          verification: refuted(at(90, "sections/intro.tex")),
        }),
      ]),
      manifest,
    );
    const by = new Map(report.traps.hits.map((h) => [h.concern, h]));
    expect(by.get("on-answer")).toMatchObject({
      withdrawn: true,
      counterOnAnswer: true,
    });
    expect(by.get("off-answer")).toMatchObject({
      withdrawn: true,
      counterOnAnswer: false,
    });
    expect(by.get("kept")).toMatchObject({
      withdrawn: false,
      counterOnAnswer: false,
    });
    // A trap may be answered in two places; a counter on either counts.
    expect(by.get("second-answer")?.counterOnAnswer).toBe(true);
    expect(by.get("answer-in-another-file")?.counterOnAnswer).toBe(false);
  });

  it("prints each pick with its id and message, because a rule this loose has to show them", () => {
    const report = measureVerification(
      item([
        concern("a-3", at(30), {
          evidence: { kind: "missing" },
          message: "the cost model is never validated",
          verification: refuted(at(80)),
        }),
        concern("a-4", at(34), {
          evidence: { kind: "missing" },
          message: "no limitation is reported",
          verification: upheld,
        }),
      ]),
      manifest,
    );
    const text = formatVerificationReport(report);
    expect(text).toContain("trap hits: 2 → 1 of 2 planted");
    expect(text).toContain(
      'T1 a-3 withdrawn, counter on the answer: "the cost model is never validated"',
    );
    expect(text).toContain('T3 a-4 kept: "no limitation is reported"');
  });

  it("reads a hit nobody checked as NOT CHECKED — never as kept (ADR 0071 §1)", () => {
    // A chunk that failed leaves its concerns with no `verification` at all.
    // Calling such a trap "kept" would report the verifier's silence as its
    // judgment: unmeasured is not zero.
    const report = measureVerification(
      item([
        concern("a-3", at(30), {
          evidence: { kind: "missing" },
          verification: upheld,
        }),
        concern("a-4", at(34), {
          evidence: { kind: "missing" },
          message: "no limitation is reported",
        }),
      ]),
      manifest,
    );
    const by = new Map(report.traps.hits.map((h) => [h.concern, h]));
    expect(by.get("a-3")?.checked).toBe(true);
    expect(by.get("a-4")).toMatchObject({ checked: false, withdrawn: false });
    const text = formatVerificationReport(report);
    expect(text).toContain('T3 a-4 not checked: "no limitation is reported"');
    expect(text).not.toContain("a-4 kept");
    expect(text).toContain("trap hits: 2 → 2 of 2 planted (1 not checked)");
  });

  it("reads a manifest with no traps as none planted, not as none raised", () => {
    const report = measureVerification(
      item([concern("a-1", at(30), { evidence: { kind: "missing" } })]),
      manifestOf([defect("S1", 10)]),
    );
    expect(report.traps).toEqual({ planted: 0, hits: [] });
    expect(formatVerificationReport(report)).toContain(
      "trap hits: none planted",
    );
  });
});

// ── central among majors ────────────────────────────────────────────────────

describe("V1 O25 — what the verifier made of blocking", () => {
  it("tallies central among majors, beside blocking among majors", () => {
    const central = (value: boolean): ReviewVerification => ({
      ...upheld,
      central: value,
    });
    const report = measureVerification(
      item([
        concern("m-1", at(10), { blocking: true, verification: central(true) }),
        concern("m-2", at(11), {
          blocking: true,
          verification: central(false),
        }),
        concern("m-3", at(12), { verification: upheld }),
        // A withdrawn major is still a major the reviewer raised.
        concern("m-4", at(13), {
          blocking: true,
          verification: { ...refuted(at(40)), central: true },
        }),
        concern("minor", at(14), { severity: "minor" }),
      ]),
      manifestOf([defect("S1", 10)]),
    );
    expect(report.central).toEqual({
      majors: 4,
      blocking: 3,
      asked: 3,
      centralTrue: 2,
      centralFalse: 1,
    });
    expect(formatVerificationReport(report)).toContain(
      "central among majors: 2 true, 1 false of 3 answered; blocking 3/4 majors",
    );
  });
});

// ── the report says nothing about the paper ─────────────────────────────────

describe("V1 O25 — the verification report carries no score", () => {
  it("uses no word a reader could mistake for a verdict on the manuscript", () => {
    // The same guard `recall.test.ts` runs over the recall report (ADR 0070
    // §6): this reading is of the verifier, never of the paper.
    const banned =
      /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;
    const report = measureVerification(
      item([
        concern("a-1", at(10), {
          blocking: true,
          verification: { ...refuted(at(80)), central: false },
        }),
        concern("a-2", at(30), { evidence: { kind: "missing" } }),
      ]),
      manifestOf([defect("S1", 10)], [trap("T1", 30, [80])]),
    );
    expect(JSON.stringify(report)).not.toMatch(banned);
    expect(formatVerificationReport(report)).not.toMatch(banned);
  });
});
