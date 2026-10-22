/**
 * V4 (ADR 0081 §3, §7; O9, O10): the PDF reviewer's verb and its brief.
 *
 * The driver's behaviour is `review-panel-pdf.test.ts`'s; this file is the two
 * pure pieces the seat is built from.
 */
import { describe, expect, it } from "vitest";
import { PANEL_DIMENSIONS, type PdfFacts } from "../../src/contracts/index.js";
import type { ReviewAnnotation } from "../../src/contracts/index.js";
import {
  PANEL_SKILL,
  parseReviewCommand,
} from "../../src/session/review-panel.js";
import {
  PDF_REVIEWER_NAME,
  PDF_SKILL,
  isPdfArgumentConcern,
  parsePdfReviewCommand,
  pdfReviewerBrief,
} from "../../src/session/review-pdf-seat.js";

describe("isPdfArgumentConcern — what a panel sets aside (ADR 0083 §2, O36)", () => {
  const concern = (
    dimension: string,
    evidence?: ReviewAnnotation["evidence"],
  ): ReviewAnnotation => ({
    id: `${PDF_REVIEWER_NAME}-1`,
    reviewer: PDF_REVIEWER_NAME,
    dimension,
    severity: "major",
    span: { file: "main.tex", line: 3 },
    message: "m",
    ...(evidence !== undefined ? { evidence } : {}),
  });

  it("sets aside a concern outside presentation that names no page", () => {
    // J1 round 2's four, by evidence: none and a source span.
    expect(isPdfArgumentConcern(concern("claims", { kind: "missing" }))).toBe(
      true,
    );
    expect(
      isPdfArgumentConcern(
        concern("soundness", { kind: "span", file: "main.tex", line: 9 }),
      ),
    ).toBe(true);
    expect(isPdfArgumentConcern(concern("clarity"))).toBe(true);
  });

  it("keeps what the page shows, under any dimension", () => {
    expect(
      isPdfArgumentConcern(concern("presentation", { kind: "page", page: 4 })),
    ).toBe(false);
    // A figure that contradicts its caption: `claims`, with the page.
    expect(
      isPdfArgumentConcern(concern("claims", { kind: "page", page: 2 })),
    ).toBe(false);
  });
});

describe("parsePdfReviewCommand (O9)", () => {
  it("parses the bare verb and a focus, verbatim, multi-line included", () => {
    expect(parsePdfReviewCommand("/review-pdf")).toEqual({});
    expect(parsePdfReviewCommand("  /review-pdf  ")).toEqual({});
    expect(parsePdfReviewCommand("/review-pdf the tables")).toEqual({
      focus: "the tables",
    });
    expect(parsePdfReviewCommand("/review-pdf 表格\nand figure 2")).toEqual({
      focus: "表格\nand figure 2",
    });
  });

  it("leaves prose that merely contains it, and a longer word, alone", () => {
    expect(parsePdfReviewCommand("please /review-pdf")).toBeNull();
    expect(parsePdfReviewCommand("/review-pdfx")).toBeNull();
    expect(parsePdfReviewCommand("/review")).toBeNull();
  });

  it("`/review pdf` is the panel with the focus pdf, and never this verb", () => {
    expect(parsePdfReviewCommand("/review pdf")).toBeNull();
    expect(parseReviewCommand("/review pdf")).toEqual({ focus: "pdf" });
    expect(parseReviewCommand("/review-pdf")).toBeNull();
  });
});

describe("pdfReviewerBrief (O10)", () => {
  const ctx = {
    entry: "main.tex",
    files: ["main.tex", "sections/method.tex"],
    wrapping: "The source is hard-wrapped: quote ONE WHOLE LINE.",
  };
  const facts: PdfFacts = {
    pages: 3,
    pageSize: { width: 595.28, height: 841.89, name: "a4" },
    referencesStart: 3,
    mainTextPages: 2,
    author: "A. Fixture",
  };
  const brief = (focus?: string) =>
    pdfReviewerBrief(
      { ...ctx, ...(focus !== undefined ? { focus } : {}) },
      facts,
      { source: "beside_entry", path: "main.pdf" },
      60,
    );

  it("opens with both forced loads, on the first line", () => {
    expect(brief().split("\n")[0]).toBe(
      `/skill:${PANEL_SKILL} /skill:${PDF_SKILL}`,
    );
    expect(brief()).toContain(`\`${PDF_REVIEWER_NAME}\``);
  });

  it("lists all eight dimensions and the page rule", () => {
    expect(PANEL_DIMENSIONS).toHaveLength(8);
    expect(brief()).toContain(
      `must be one of: ${PANEL_DIMENSIONS.join(", ")}.`,
    );
    expect(brief()).toContain("presentation");
    expect(brief()).toContain('"evidence": {"page": N}');
  });

  it("carries the facts, the view budget and the files, and names no model", () => {
    const text = brief();
    expect(text).toContain("these are facts, not findings");
    expect(text).toContain("The PDF has 3 pages.");
    expect(text).toContain("A. Fixture");
    expect(text).toContain("You may view at most 60 pages in this review.");
    expect(text).toContain("main.tex");
    expect(text).toContain(ctx.wrapping);
    expect(text).not.toMatch(/model|claude|gpt|haiku|sonnet|opus/i);
  });

  it("carries a focus as emphasis, and only when one was given", () => {
    expect(brief()).not.toContain("attend to the following");
    const focused = brief("the tables on page 2");
    expect(focused).toContain("attend to the following");
    expect(focused).toContain("the tables on page 2");
    expect(
      focused.trimEnd().endsWith("exactly one JSON ledger and nothing else."),
    ).toBe(true);
  });
});
