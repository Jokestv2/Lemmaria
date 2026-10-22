/**
 * X6 (ADR 0075): the four derivations the Review tab renders from — asserted
 * on data alone, because each one decides whether a sentence the tab writes
 * is TRUE, and that is a fact about the record, not about a DOM.
 */
import type { ReviewLimit } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import type {
  ReviewAnnotationInfo,
  ReviewSeatInfo,
} from "../src/webview-protocol.js";
import {
  isWithdrawn,
  limitRows,
  lostBySeat,
  panelFacts,
  setAsideLimits,
  sharedModel,
  verificationCompleted,
  verificationMark,
} from "../src/webview/parts/review-facts.js";

const dropped = (
  reviewer: string,
  n: number,
): Extract<ReviewLimit, { kind: "anchors_dropped" }> => ({
  kind: "anchors_dropped",
  reviewer,
  anchors: Array.from({ length: n }, (_, i) => ({
    anchor: `quote ${i}`,
    role: "claim" as const,
    reason: "not_found" as const,
  })),
});

const rejected = (
  reviewer: string,
  n: number,
): Extract<ReviewLimit, { kind: "entries_rejected" }> => ({
  kind: "entries_rejected",
  reviewer,
  entries: Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    reason: "model-facing English",
  })),
});

const source = (
  reviewer: string,
  name: string,
  status: "rate_limited" | "timeout" | "failed",
  anonymous?: true,
): ReviewLimit => ({
  kind: "source_unavailable",
  reviewer,
  source: name,
  status,
  ...(anonymous ? { anonymous } : {}),
});

describe("lostBySeat — entries each reviewer lost (O1)", () => {
  it("counts dropped and rejected entries per reviewer", () => {
    const lost = lostBySeat([
      dropped("reviewer_a", 4),
      rejected("reviewer_b", 2),
      dropped("reviewer_b", 1),
    ]);
    expect(lost.get("reviewer_a")).toEqual({
      dropped: 4,
      rejected: 0,
      setAside: 0,
    });
    expect(lost.get("reviewer_b")).toEqual({
      dropped: 1,
      rejected: 2,
      setAside: 0,
    });
    expect(lost.has("reviewer_c")).toBe(false);
  });

  it("counts one ENTRY per anchors[] record, whichever anchor failed", () => {
    // The interpreter pushes one record for a dropped entry — on its claim's
    // quote, or failing that its evidence's — and moves on. So a claim drop
    // and an evidence drop are two entries, not one entry with two anchors.
    const lost = lostBySeat([
      {
        kind: "anchors_dropped",
        reviewer: "reviewer_a",
        anchors: [
          { anchor: "c", role: "claim", reason: "not_found" },
          { anchor: "e", role: "evidence", reason: "ambiguous" },
        ],
      },
    ]);
    expect(lost.get("reviewer_a")?.dropped).toBe(2);
  });

  it("counts what a panel set aside apart from what was lost (ADR 0083 §2)", () => {
    const lost = lostBySeat([
      {
        kind: "concerns_set_aside",
        reviewer: "pdf_reviewer",
        entries: [{ dimension: "claims" }, { dimension: "soundness" }],
      },
      dropped("pdf_reviewer", 1),
    ]);
    expect(lost.get("pdf_reviewer")).toEqual({
      dropped: 1,
      rejected: 0,
      setAside: 2,
    });
  });

  it("sums several limits of one kind for one reviewer", () => {
    const lost = lostBySeat([
      dropped("reviewer_a", 2),
      dropped("reviewer_a", 3),
    ]);
    expect(lost.get("reviewer_a")).toEqual({
      dropped: 5,
      rejected: 0,
      setAside: 0,
    });
  });

  it("ignores the other five kinds, including the one with no reviewer", () => {
    const lost = lostBySeat([
      { kind: "seat_missing", reviewer: "reviewer_a", reason: "failed" },
      { kind: "seat_unguided", reviewer: "reviewer_a" },
      source("reviewer_a", "arxiv", "timeout"),
      { kind: "search_budget_spent", reviewer: "reviewer_a" },
      // No `reviewer` at all: reading one off it would key the map by
      // `undefined`, and a seat named nothing would appear to have lost.
      { kind: "synthesis_missing", reason: "failed" },
    ]);
    expect(lost.size).toBe(0);
  });

  it("answers an empty map for no limits at all", () => {
    expect(lostBySeat(undefined).size).toBe(0);
    expect(lostBySeat([]).size).toBe(0);
  });
});

describe("panelFacts — the panel, counted (O5)", () => {
  const seat = (over: Partial<ReviewSeatInfo>): ReviewSeatInfo => ({
    reviewer: "reviewer_a",
    count: 1,
    ...over,
  });

  it("counts reviewers and DISTINCT models", () => {
    expect(
      panelFacts([
        seat({ reviewer: "reviewer_a", model: "m1" }),
        seat({ reviewer: "reviewer_b", model: "m2" }),
        seat({ reviewer: "reviewer_c", model: "m1" }),
      ]),
    ).toEqual({
      reviewers: 3,
      models: 2,
      failed: 0,
      interrupted: 0,
      unparsed: 0,
      outOfBudget: 0,
    });
  });

  it("omits the model count when any seat has none recorded", () => {
    // A review stored before R9 replays `""`; a count over the rest would
    // claim a diversity the record cannot support.
    const facts = panelFacts([
      seat({ reviewer: "reviewer_a", model: "m1" }),
      seat({ reviewer: "reviewer_b", model: "" }),
    ]);
    expect(facts.models).toBeUndefined();
    expect("models" in facts).toBe(false);
    expect(panelFacts([seat({ model: undefined })]).models).toBeUndefined();
  });

  it("counts each way a reviewer did not report", () => {
    const missing = (
      reviewer: string,
      reason: "failed" | "interrupted" | "unparsed",
    ): ReviewSeatInfo =>
      seat({
        reviewer,
        count: 0,
        model: "m",
        missing: { kind: "seat_missing", reviewer, reason },
      });
    expect(
      panelFacts([
        missing("reviewer_a", "failed"),
        missing("reviewer_b", "failed"),
        missing("reviewer_c", "interrupted"),
        missing("reviewer_d", "unparsed"),
        seat({ reviewer: "reviewer_e", model: "m" }),
      ]),
    ).toEqual({
      reviewers: 5,
      models: 1,
      failed: 2,
      interrupted: 1,
      unparsed: 1,
      outOfBudget: 0,
    });
  });

  it("says nothing about models for no seats", () => {
    expect(panelFacts([])).toEqual({
      reviewers: 0,
      failed: 0,
      interrupted: 0,
      unparsed: 0,
      outOfBudget: 0,
    });
  });

  it("counts a reviewer that ran out of a budget as that, never as unparsed (ADR 0082 §2, O32)", () => {
    const facts = panelFacts([
      seat({
        reviewer: "reviewer_a",
        count: 0,
        model: "m",
        missing: {
          kind: "seat_missing",
          reviewer: "reviewer_a",
          reason: "unparsed",
          detail: "the seat produced no report (budget.tool_calls)",
          ranOutOf: "tool_calls",
        },
      }),
      seat({ reviewer: "reviewer_b", model: "m" }),
    ]);
    expect(facts.outOfBudget).toBe(1);
    expect(facts.unparsed).toBe(0);
  });
});

describe("sharedModel — agreement on one model (O6)", () => {
  const annotation = (id: string, reviewer: string): ReviewAnnotationInfo => ({
    index: 0,
    id,
    dimension: "soundness",
    severity: "major",
    message: "m",
    reviewer,
    file: "main.tex",
    line: 1,
    hasSuggestion: false,
    status: "pending",
  });
  const ANNOTATIONS = [
    annotation("reviewer_a-1", "reviewer_a"),
    annotation("reviewer_a-2", "reviewer_a"),
    annotation("reviewer_b-1", "reviewer_b"),
    annotation("reviewer_c-1", "reviewer_c"),
  ];
  const seats = (
    models: Record<string, string | undefined>,
  ): ReviewSeatInfo[] =>
    Object.entries(models).map(([reviewer, model]) => ({
      reviewer,
      count: 1,
      ...(model !== undefined ? { model } : {}),
    }));

  it("names the model when every cited reviewer ran on it", () => {
    expect(
      sharedModel(
        { ids: ["reviewer_a-1", "reviewer_b-1"], note: "n" },
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: "m1", reviewer_c: "m2" }),
      ),
    ).toBe("m1");
  });

  it("answers undefined when the cited reviewers' models differ", () => {
    expect(
      sharedModel(
        { ids: ["reviewer_a-1", "reviewer_b-1", "reviewer_c-1"], note: "n" },
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: "m1", reviewer_c: "m2" }),
      ),
    ).toBeUndefined();
  });

  it("never marks the unknown", () => {
    const note = { ids: ["reviewer_a-1", "reviewer_b-1"], note: "n" };
    // A seat with no model, or one that replayed `""`.
    expect(
      sharedModel(
        note,
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: undefined }),
      ),
    ).toBeUndefined();
    expect(
      sharedModel(
        note,
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: "" }),
      ),
    ).toBeUndefined();
    // A reviewer with no seat row at all.
    expect(
      sharedModel(note, ANNOTATIONS, seats({ reviewer_a: "m1" })),
    ).toBeUndefined();
    // An id that resolves to no annotation.
    expect(
      sharedModel(
        { ids: ["reviewer_a-1", "reviewer_z-9"], note: "n" },
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: "m1" }),
      ),
    ).toBeUndefined();
  });

  it("needs two DISTINCT reviewers — one reviewer agreeing with itself is not agreement", () => {
    expect(
      sharedModel(
        { ids: ["reviewer_a-1", "reviewer_a-2"], note: "n" },
        ANNOTATIONS,
        seats({ reviewer_a: "m1", reviewer_b: "m1" }),
      ),
    ).toBeUndefined();
  });
});

describe("limitRows — one row per failed source (O12)", () => {
  const ORDER = ["reviewer_a", "reviewer_b", "reviewer_c"];

  it("merges a source's limits into one row at its FIRST position", () => {
    const budget: ReviewLimit = {
      kind: "search_budget_spent",
      reviewer: "reviewer_a",
    };
    const rows = limitRows(
      [
        dropped("reviewer_a", 1),
        source("reviewer_c", "arxiv", "timeout"),
        budget,
        source("reviewer_a", "arxiv", "rate_limited"),
        source("reviewer_b", "semantic_scholar", "failed"),
        source("reviewer_b", "arxiv", "timeout"),
      ],
      ORDER,
    );
    expect(
      rows.map((r) => (r.kind === "source" ? r.source : r.limit.kind)),
    ).toEqual([
      "anchors_dropped",
      "arxiv",
      "search_budget_spent",
      "semantic_scholar",
    ]);
    expect(rows[1]).toEqual({
      kind: "source",
      source: "arxiv",
      // Panel order, not first-seen order.
      reviewers: ["reviewer_a", "reviewer_b", "reviewer_c"],
      // Distinct, in the fixed order.
      statuses: ["rate_limited", "timeout"],
      anonymous: false,
    });
  });

  it("leaves every other kind in place and untouched", () => {
    const others: ReviewLimit[] = [
      dropped("reviewer_a", 2),
      rejected("reviewer_b", 1),
      { kind: "seat_missing", reviewer: "reviewer_c", reason: "failed" },
      { kind: "seat_unguided", reviewer: "reviewer_a" },
      { kind: "search_budget_spent", reviewer: "reviewer_a" },
      { kind: "synthesis_missing", reason: "insufficient_seats" },
    ];
    const rows = limitRows(others, ORDER);
    expect(rows).toEqual(others.map((limit) => ({ kind: "limit", limit })));
    // The same objects, not copies — a view never rewrites the record.
    rows.forEach((r, i) => {
      expect(r.kind === "limit" && r.limit).toBe(others[i]);
    });
  });

  it("orders statuses rate-limited · timed out · failed, whatever came first", () => {
    const [row] = limitRows(
      [
        source("reviewer_a", "arxiv", "failed"),
        source("reviewer_b", "arxiv", "rate_limited"),
        source("reviewer_c", "arxiv", "failed"),
        source("reviewer_c", "arxiv", "timeout"),
      ],
      ORDER,
    );
    expect(row?.kind === "source" && row.statuses).toEqual([
      "rate_limited",
      "timeout",
      "failed",
    ]);
  });

  it("is anonymous if ANY folded limit ran without a key", () => {
    const [row] = limitRows(
      [
        source("reviewer_a", "semantic_scholar", "rate_limited"),
        source("reviewer_b", "semantic_scholar", "rate_limited", true),
      ],
      ORDER,
    );
    expect(row?.kind === "source" && row.anonymous).toBe(true);
  });

  it("puts reviewers the panel does not list last, in first-seen order", () => {
    const [row] = limitRows(
      [
        source("reviewer_z", "arxiv", "timeout"),
        source("reviewer_b", "arxiv", "timeout"),
        source("reviewer_y", "arxiv", "timeout"),
        source("reviewer_a", "arxiv", "timeout"),
      ],
      ORDER,
    );
    expect(row?.kind === "source" && row.reviewers).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_z",
      "reviewer_y",
    ]);
  });

  it("keeps a single-reviewer, single-status source a row of one", () => {
    expect(
      limitRows([source("reviewer_c", "arxiv", "rate_limited")], ORDER),
    ).toEqual([
      {
        kind: "source",
        source: "arxiv",
        reviewers: ["reviewer_c"],
        statuses: ["rate_limited"],
        anonymous: false,
      },
    ]);
  });

  it("draws no row for a set-aside, which has a fold of its own (ADR 0086, O44)", () => {
    const argument: ReviewLimit = {
      kind: "concerns_set_aside",
      reviewer: "pdf_reviewer",
      entries: [{ dimension: "soundness" }],
    };
    const furniture: ReviewLimit = {
      kind: "furniture_set_aside",
      reviewer: "pdf_reviewer",
      entries: [{ dimension: "presentation" }],
    };
    const unviewed: ReviewLimit = {
      kind: "pages_unviewed",
      viewed: 2,
      total: 3,
    };
    const limits = [furniture, unviewed, argument];
    expect(limitRows(limits, ORDER)).toEqual([
      { kind: "limit", limit: unviewed },
    ]);
    // …and the fold reads them in record order, the one kind never mistaken
    // for another.
    expect(setAsideLimits(limits)).toEqual([furniture, argument]);
    expect(setAsideLimits(undefined)).toEqual([]);
  });
});

describe("what verification made of a concern (V1 O22, ADR 0076 §9)", () => {
  const concern = (
    verification?: ReviewAnnotationInfo["verification"],
  ): ReviewAnnotationInfo => ({
    index: 0,
    id: "reviewer_a-1",
    dimension: "soundness",
    severity: "major",
    message: "m",
    reviewer: "reviewer_a",
    file: "main.tex",
    line: 4,
    hasSuggestion: false,
    status: "pending",
    ...(verification !== undefined ? { verification } : {}),
  });

  it("withdraws exactly the refuted", () => {
    expect(
      isWithdrawn(
        concern({
          outcome: "refuted",
          kind: "absence",
          counter: { file: "main.tex", line: 9 },
        }),
      ),
    ).toBe(true);
    expect(isWithdrawn(concern({ outcome: "upheld", kind: "absence" }))).toBe(
      false,
    );
    expect(
      isWithdrawn(concern({ outcome: "unverifiable", kind: "judgment" })),
    ).toBe(false);
    expect(isWithdrawn(concern())).toBe(false);
  });

  it("marks by exception: unchecked, a matter of judgment, or unsettled — and nothing on the rest", () => {
    expect(verificationMark(concern())).toBe("unchecked");
    expect(
      verificationMark(concern({ outcome: "unverifiable", kind: "judgment" })),
    ).toBe("opinion");
    for (const kind of ["absence", "contradiction", "literature"] as const)
      expect(
        verificationMark(concern({ outcome: "unverifiable", kind })),
        kind,
      ).toBe("unsettled");
    expect(
      verificationMark(concern({ outcome: "upheld", kind: "absence" })),
    ).toBeUndefined();
    expect(
      verificationMark(
        concern({
          outcome: "refuted",
          kind: "absence",
          counter: { file: "main.tex", line: 9 },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("verificationCompleted — when the PDF reviewer's group says it was not checked (V4 O19)", () => {
  it("is true when a verifier ran and recorded no verification_missing", () => {
    expect(verificationCompleted({ model: "m" }, undefined)).toBe(true);
    expect(verificationCompleted({}, [])).toBe(true);
    // Another kind of limit is not about verification.
    expect(
      verificationCompleted({ model: "m" }, [
        { kind: "pages_unviewed", viewed: 1, total: 3 },
      ]),
    ).toBe(true);
  });

  it("is false when no verifier ran — off, nothing to check, or a PDF review", () => {
    expect(verificationCompleted(undefined, undefined)).toBe(false);
    expect(
      verificationCompleted(undefined, [
        { kind: "verification_missing", reason: "off" },
      ]),
    ).toBe(false);
  });

  it("is false when the verifier ran and fell short", () => {
    for (const reason of ["incomplete", "failed", "interrupted"] as const)
      expect(
        verificationCompleted({ model: "m" }, [
          { kind: "verification_missing", reason },
        ]),
        reason,
      ).toBe(false);
  });
});
