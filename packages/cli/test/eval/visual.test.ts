/**
 * V4 (O23): the visual-defects instrument, over hand-built review items.
 *
 * The hit rule is R5's — a claim (or `span` evidence) that overlaps a defect's
 * span, one defect per concern — read for the PDF reviewer's concerns only,
 * and the page rule is exact: the page a concern cites against the page the
 * defect is on.
 */
import { resolve } from "node:path";
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewPdfRecord,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type VisualManifest,
  checkVisualManifest,
  formatVisualReport,
  matchVisualDefects,
  readVisualManifest,
} from "../../src/eval/visual.js";

const MANIFEST: VisualManifest = {
  fixture: "visual-defects",
  file: "main.tex",
  venue: {
    id: "v",
    pageLimit: { value: 2, unit: "pages" },
    anonymity: "double_blind",
  },
  defective: { pages: 3, pageSize: "a4" },
  clean: { pages: 2, pageSize: "letter" },
  defects: [
    {
      id: "V1",
      category: "layout",
      kind: "text-in-the-margin",
      page: 1,
      spans: [{ anchor: "a", line: 31 }],
      facts: false,
      see: "",
      tell: "",
    },
    {
      id: "V2",
      category: "layout",
      kind: "table-past-the-column",
      page: 1,
      spans: [{ anchor: "b", line: 84 }],
      facts: false,
      see: "",
      tell: "",
    },
    {
      id: "V6",
      category: "geometry",
      kind: "wrong-page-size",
      page: null,
      spans: [{ anchor: "c", line: 2 }],
      facts: true,
      see: "",
      tell: "",
    },
    {
      id: "V8",
      category: "figure-text-agreement",
      kind: "caption-contradicts-figure",
      page: 1,
      spans: [{ anchor: "d", line: 47 }],
      facts: false,
      see: "",
      tell: "",
    },
  ],
};

const concern = (
  id: string,
  line: number,
  over: Partial<ReviewAnnotation> = {},
): ReviewAnnotation => ({
  id,
  reviewer: "pdf_reviewer",
  dimension: "presentation",
  severity: "minor",
  span: { file: "main.tex", line },
  message: "m",
  ...over,
});

const PDF: ReviewPdfRecord = {
  source: "beside_entry",
  path: "main.pdf",
  facts: {
    pages: 3,
    pageSize: { width: 595.28, height: 841.89, name: "a4" },
    smallestText: [
      { page: 1, sizePt: 5 },
      { page: 2, sizePt: 8.9 },
    ],
  },
  viewed: [1, 2, 3],
};

function itemOf(
  annotations: ReviewAnnotation[],
  opts: { ledger?: boolean } = {},
): ReviewItem {
  return {
    type: "review",
    id: "r",
    status: "completed",
    skill: "pdf-reviewer",
    seats: [],
    ...(opts.ledger !== false
      ? {
          pdfSeat: {
            reviewer: "pdf_reviewer",
            status: "completed",
            model: "m",
            ledger: {
              entries: annotations.length,
              located: annotations.length,
            },
          },
        }
      : {}),
    pdf: PDF,
    result: { annotations },
  } as unknown as ReviewItem;
}

describe("V4 O23 — checkVisualManifest refuses, never repairs", () => {
  const base = JSON.parse(JSON.stringify(MANIFEST)) as Record<string, unknown>;
  const withDefect = (patch: Record<string, unknown>) => ({
    ...base,
    defects: [{ ...(MANIFEST.defects[0] as object), ...patch }],
  });

  it("accepts the committed manifest", async () => {
    const m = await readVisualManifest(
      resolve(
        import.meta.dirname,
        "../live/fixtures/visual-defects/visual.json",
      ),
    );
    expect(m.defects).toHaveLength(10);
  });

  it.each([
    ["a page that is not a positive whole number", withDefect({ page: 0 })],
    ["a fractional page", withDefect({ page: 1.5 })],
    ["a defect with no span", withDefect({ spans: [] })],
    ["a span with no anchor", withDefect({ spans: [{ line: 3 }] })],
    ["a span with no line", withDefect({ spans: [{ anchor: "x" }] })],
    ["no facts flag", withDefect({ facts: "yes" })],
    ["an unknown key", { ...base, extra: 1 }],
    ["no venue", { ...base, venue: undefined }],
    [
      "a duplicate id",
      { ...base, defects: [MANIFEST.defects[0], MANIFEST.defects[0]] },
    ],
  ])("refuses %s", (_label, shape) => {
    expect(() => checkVisualManifest(shape)).toThrow();
  });

  it("accepts a null page — a defect of every page", () => {
    expect(() => checkVisualManifest(withDefect({ page: null }))).not.toThrow();
  });
});

describe("V4 O23 — matchVisualDefects", () => {
  it("credits the PDF reviewer's concerns on span overlap, one defect each, and reads the page rule", () => {
    const report = matchVisualDefects(
      itemOf([
        concern("pdf_reviewer-1", 31, { evidence: { kind: "page", page: 1 } }),
        concern("pdf_reviewer-2", 47, {
          dimension: "claims",
          evidence: { kind: "page", page: 2 },
        }),
        concern("pdf_reviewer-3", 84),
        concern("pdf_reviewer-4", 150, { evidence: { kind: "page", page: 3 } }),
        // A text reviewer on a planted line is not the PDF reviewer's find.
        concern("reviewer_a-1", 84, { reviewer: "reviewer_a" }),
      ]),
      MANIFEST,
    );
    expect(report.measured).toBe(true);
    expect(report.planted).toBe(3);
    expect(report.found).toBe(3);
    expect(report.hits).toEqual([
      { defect: "V1", ids: ["pdf_reviewer-1"], pageNamed: true },
      { defect: "V2", ids: ["pdf_reviewer-3"], pageNamed: null },
      { defect: "V8", ids: ["pdf_reviewer-2"], pageNamed: false },
    ]);
    expect(report.unmatched).toEqual(["pdf_reviewer-4"]);
    expect(report.missed).toEqual([]);
    expect(report.pageEvidence).toEqual({
      withPage: 3,
      onDefectPage: 1,
      named: 2,
    });
    expect(report.byKind["text-in-the-margin"]).toEqual({
      planted: 1,
      found: 1,
    });
    // V6 is answered by the facts, so it is never expected of a concern.
    expect(report.byKind["wrong-page-size"]).toBeUndefined();
    expect(report.viewed).toEqual([1, 2, 3]);
    expect(report.facts).toEqual({
      smallestText: { page: 1, sizePt: 5 },
      pageSize: "a4",
      pages: 3,
      overLimit: true,
    });
  });

  it("a concern on a facts defect's line is credited to it, and counts toward nothing planted", () => {
    const report = matchVisualDefects(
      itemOf([concern("pdf_reviewer-1", 2)]),
      MANIFEST,
    );
    expect(report.hits.map((h) => h.defect)).toEqual(["V6"]);
    expect(report.found).toBe(0);
    expect(report.unmatched).toEqual([]);
  });

  it("is not measured without the PDF reviewer's ledger — never zero", () => {
    const report = matchVisualDefects(itemOf([], { ledger: false }), MANIFEST);
    expect(report.measured).toBe(false);
    expect(formatVisualReport(report)).toContain("not measured");
    expect(matchVisualDefects(undefined, MANIFEST).measured).toBe(false);
  });

  it("prints counts only — no percentage and no judging word", () => {
    const text = formatVisualReport(
      matchVisualDefects(
        itemOf([
          concern("pdf_reviewer-1", 31, {
            evidence: { kind: "page", page: 1 },
          }),
        ]),
        MANIFEST,
      ),
    );
    expect(text).toContain("found 1/3");
    expect(text).toContain("page named right 1 of 1");
    expect(text).toContain("smallest text 5.0 pt on page 1");
    expect(text).toContain("over the page limit");
    expect(text).not.toMatch(
      /%|\b(score|rate|rating|accuracy|precision|verdict)\b/i,
    );
  });
});
