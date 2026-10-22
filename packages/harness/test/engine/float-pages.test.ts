/**
 * ADR 0084 (V4 gate-review round 3, O39): a PDF-reviewer page cite follows the
 * float its anchor sits in — located from the compile's `.aux`, confirmed on
 * the PDF's own text, and moved only to a page the seat viewed.
 */
import { describe, expect, it } from "vitest";
import type { ReviewAnnotation } from "../../src/contracts/index.js";
import {
  auxPageCount,
  captionOnPage,
  correctFloatPages,
  enclosingFloat,
  floatPlacements,
  parseAuxLabels,
} from "../../src/engine/float-pages.js";
import type { ParsedLedger } from "../../src/engine/review.js";

const AUX = [
  "\\relax",
  "\\newlabel{fig:teaser}{{1}{2}{Teaser}{figure.caption.1}{}}",
  "\\newlabel{fig:architecture}{{2}{4}{Overview}{figure.caption.3}{}}",
  "\\newlabel{tab:quantitative}{{1}{6}}",
  "\\newlabel{fig:architecture@cref}{{[figure][2][]2}{[1][4][]4}}",
  "\\newlabel{sec:method}{{3}{3}{Method}{section.3}{}}",
  "\\newlabel{fig:front}{{1}{iv}}",
  "\\gdef \\@abspage@last{9}",
].join("\n");

const METHOD = [
  "\\section{Method}\\label{sec:method}",
  "Our pipeline has three stages.",
  "\\begin{figure*}[t]",
  "  \\centering",
  "  \\includegraphics[width=\\linewidth]{figures/architecture.pdf}",
  "  \\caption{Overview of the pipeline.}",
  "  \\label{fig:architecture}",
  "\\end{figure*}",
  "The scheduler then mixes the data.",
  "% \\begin{figure} a commented float opens nothing",
  "A closing sentence.",
].join("\n");

const EXPERIMENTS = [
  "\\section{Experiments}",
  "\\begin{table}[t]",
  "  \\caption{Quantitative comparison.}\\label{tab:quantitative}",
  "  \\input{tables/quantitative_comparison}",
  "\\end{table}",
  "Table~\\ref{tab:quantitative} reports the numbers.",
].join("\n");

const TABLE_BODY = [
  "\\begin{tabular}{lcc}",
  "Method & PSNR & SSIM \\\\",
  "Ours & 25.1 & 0.91 \\\\",
  "\\end{tabular}",
].join("\n");

const FILES = new Map([
  ["main.tex", "\\input{sections/method}\n\\input{sections/experiments}\n"],
  ["sections/method.tex", METHOD],
  ["sections/experiments.tex", EXPERIMENTS],
  ["tables/quantitative_comparison.tex", TABLE_BODY],
]);

describe("parseAuxLabels (ADR 0084, O39)", () => {
  it("reads the printed number and the page of every \\newlabel, both shapes", () => {
    const labels = parseAuxLabels(AUX);
    expect(labels.get("fig:architecture")).toEqual({ number: "2", page: "4" });
    expect(labels.get("tab:quantitative")).toEqual({ number: "1", page: "6" });
    expect(labels.get("fig:front")).toEqual({ number: "1", page: "iv" });
  });

  it("ignores every other line of the file", () => {
    expect(parseAuxLabels("\\relax\n\\bibcite{x}{1}\n").size).toBe(0);
  });
});

describe("enclosingFloat (ADR 0084, O39)", () => {
  it("finds the float around a line, and the labels inside it", () => {
    expect(enclosingFloat(METHOD, 5)).toEqual({
      kind: "figure",
      labels: ["fig:architecture"],
    });
    // The \begin line itself is inside: rule 4 anchors an overflowing table there.
    expect(enclosingFloat(EXPERIMENTS, 2)).toEqual({
      kind: "table",
      labels: ["tab:quantitative"],
    });
  });

  it("is nothing outside a float, and a commented \\begin opens none", () => {
    expect(enclosingFloat(METHOD, 2)).toBeUndefined();
    expect(enclosingFloat(METHOD, 9)).toBeUndefined();
    expect(enclosingFloat(METHOD, 11)).toBeUndefined();
  });
});

describe("floatPlacements (ADR 0084, O39)", () => {
  const sources = {
    files: FILES,
    entry: "main.tex",
    labels: parseAuxLabels(AUX),
    pageCount: 9,
  };

  it("places an anchor inside a labelled float on its label's page", () => {
    expect(
      floatPlacements({ file: "sections/method.tex", line: 5 }, sources),
    ).toEqual([{ page: 4, kind: "figure", number: "2" }]);
  });

  it("follows an \\input made from inside a parent's float, one level", () => {
    expect(
      floatPlacements(
        { file: "tables/quantitative_comparison.tex", line: 3 },
        sources,
      ),
    ).toEqual([{ page: 6, kind: "table", number: "1" }]);
  });

  it("takes the child file's own labels when a parent's float \\inputs it", () => {
    const files = new Map([
      ["main.tex", "\\begin{table}[t]\n\\input{tables/q}\n\\end{table}\n"],
      [
        "tables/q.tex",
        "\\caption{Numbers.}\\label{tab:q}\n\\begin{tabular}{lc}\nA & 1 \\\\\n\\end{tabular}",
      ],
    ]);
    expect(
      floatPlacements(
        { file: "tables/q.tex", line: 3 },
        {
          files,
          entry: "main.tex",
          labels: parseAuxLabels("\\newlabel{tab:q}{{1}{6}}"),
          pageCount: 9,
        },
      ),
    ).toEqual([{ page: 6, kind: "table", number: "1" }]);
  });

  it("offers every label's place, so the caption can say which number it prints", () => {
    const grid = [
      "\\begin{figure}",
      "  \\subfloat{\\includegraphics{a.pdf}\\label{fig:grid-a}}",
      "  \\caption{Qualitative grid.}\\label{fig:grid}",
      "\\end{figure}",
    ].join("\n");
    const labels = parseAuxLabels(
      "\\newlabel{fig:grid-a}{{3a}{7}}\n\\newlabel{fig:grid}{{3}{7}}",
    );
    expect(
      floatPlacements(
        { file: "grid.tex", line: 2 },
        {
          files: new Map([["grid.tex", grid]]),
          entry: "main.tex",
          labels,
          pageCount: 9,
        },
      ),
    ).toEqual([
      { page: 7, kind: "figure", number: "3a" },
      { page: 7, kind: "figure", number: "3" },
    ]);
  });

  it("says nothing it cannot say exactly", () => {
    // Outside any float.
    expect(
      floatPlacements({ file: "sections/method.tex", line: 2 }, sources),
    ).toEqual([]);
    // A page that is not a plain number, or not a page of this PDF.
    const roman = new Map([
      ["x.tex", "\\begin{figure}\n\\label{fig:front}\n\\end{figure}"],
    ]);
    expect(
      floatPlacements({ file: "x.tex", line: 2 }, { ...sources, files: roman }),
    ).toEqual([]);
    expect(
      floatPlacements(
        { file: "sections/method.tex", line: 5 },
        { ...sources, pageCount: 3 },
      ),
    ).toEqual([]);
    // A label the aux does not have.
    expect(
      floatPlacements(
        { file: "sections/method.tex", line: 5 },
        { ...sources, labels: new Map() },
      ),
    ).toEqual([]);
  });
});

describe("captionOnPage (ADR 0084, O39)", () => {
  // PDFium's text as a real two-column `acmart` paper extracted it (the code
  // review's probe, 2026-09-26): a caption opens a line, a reference sits
  // inside one — and may end its sentence with the same period.
  it("finds the float's caption where a caption stands: opening a line", () => {
    const fig = { page: 4, kind: "figure" as const, number: "2" };
    expect(
      captionOnPage("231\r\n232\r\nFigure 2: Overview of the pipeline.", fig),
    ).toBe(true);
    expect(captionOnPage("stages.\r\nFig. 2. Overview", fig)).toBe(true);
    expect(captionOnPage("\r\n  图 2 流程概览", fig)).toBe(true);
    expect(captionOnPage("图 2：流程概览", fig)).toBe(true);
    const tab = { page: 6, kind: "table" as const, number: "I" };
    expect(captionOnPage("TABLE I\r\nQuantitative comparison", tab)).toBe(true);
  });

  it("never takes a reference in the running text for the caption", () => {
    const fig = { page: 4, kind: "figure" as const, number: "2" };
    expect(
      captionOnPage(
        "\r\nAs shown in Figure 2, the pipeline has three stages.",
        fig,
      ),
    ).toBe(false);
    expect(
      captionOnPage("We summarise it all in Figure 2. Morbi\r\nluctus", fig),
    ).toBe(false);
    expect(captionOnPage("见图 2 所示的流程，如图2所示", fig)).toBe(false);
    const tab = { page: 1, kind: "table" as const, number: "1" };
    expect(
      captionOnPage("The\r\nnumbers are in Table 1. Quisque ullamcorper", tab),
    ).toBe(false);
  });

  it("never takes Figure 12, Figure 2.5 or a table for Figure 2", () => {
    const fig = { page: 4, kind: "figure" as const, number: "2" };
    expect(captionOnPage("Figure 12: Another plot.", fig)).toBe(false);
    expect(captionOnPage("Figure 2.5 shows the detail.", fig)).toBe(false);
    expect(captionOnPage("Table 2: Numbers.", fig)).toBe(false);
    expect(captionOnPage("page 4 text", fig)).toBe(false);
  });
});

describe("auxPageCount (ADR 0084, O39)", () => {
  it("reads the page count of the build that wrote the aux", () => {
    expect(auxPageCount(AUX)).toBe(9);
    expect(auxPageCount("\\relax\n\\gdef \\@abspage@last{12}\n")).toBe(12);
  });

  it("is undefined for an aux whose kernel does not write it", () => {
    expect(auxPageCount("\\relax\n\\newlabel{a}{{1}{2}}\n")).toBeUndefined();
  });
});

describe("correctFloatPages — a settled ledger's page cites moved (ADR 0084, O39)", () => {
  const concern = (
    id: string,
    evidence: ReviewAnnotation["evidence"],
    line = 5,
  ): ReviewAnnotation => ({
    id,
    reviewer: "pdf_reviewer",
    dimension: "presentation",
    severity: "minor",
    span: { file: "sections/method.tex", line },
    message: "m",
    ...(evidence !== undefined ? { evidence } : {}),
  });
  const ledgerOf = (annotations: ReviewAnnotation[]): ParsedLedger => ({
    result: {
      annotations,
      limits: [{ kind: "pages_unviewed", viewed: 8, total: 9 }],
    },
    counts: {
      entries: annotations.length,
      located: annotations.length,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    },
    relocatedIds: new Set(),
  });
  const viewed = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

  it("moves a cite to its float's page, and records the move", () => {
    const ledger = ledgerOf([
      concern("pdf_reviewer-1", { kind: "page", page: 2 }),
      concern("pdf_reviewer-2", { kind: "page", page: 4 }),
    ]);
    const moved = correctFloatPages(ledger, () => 4, viewed);
    expect(moved.result.annotations.map((a) => a.evidence)).toEqual([
      { kind: "page", page: 4 },
      { kind: "page", page: 4 },
    ]);
    expect(moved.result.limits).toEqual([
      { kind: "pages_unviewed", viewed: 8, total: 9 },
      {
        kind: "pages_corrected",
        reviewer: "pdf_reviewer",
        entries: [{ id: "pdf_reviewer-1", cited: 2, page: 4 }],
      },
    ]);
    // Ids and counts are untouched: nothing was dropped or re-stamped.
    expect(moved.result.annotations.map((a) => a.id)).toEqual([
      "pdf_reviewer-1",
      "pdf_reviewer-2",
    ]);
    expect(moved.counts).toEqual(ledger.counts);
  });

  it("never moves a cite to a page the seat did not view, nor one it cannot place", () => {
    const ledger = ledgerOf([
      concern("pdf_reviewer-1", { kind: "page", page: 2 }),
      concern("pdf_reviewer-2", { kind: "missing" }),
    ]);
    expect(correctFloatPages(ledger, () => 9, viewed)).toBe(ledger);
    expect(correctFloatPages(ledger, () => undefined, viewed)).toBe(ledger);
  });

  it("returns the ledger itself when every cite is already right", () => {
    const ledger = ledgerOf([
      concern("pdf_reviewer-1", { kind: "page", page: 4 }),
    ]);
    expect(correctFloatPages(ledger, () => 4, viewed)).toBe(ledger);
  });
});
