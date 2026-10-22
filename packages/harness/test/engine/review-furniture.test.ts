import { describe, expect, it } from "vitest";
import type { ReviewAnnotation } from "../../src/contracts/data.js";
import {
  documentClassOf,
  reviewFurniture,
  runsAnonymous,
} from "../../src/engine/review-furniture.js";

const tex = String.fromCharCode(92); // a literal LaTeX backslash

/** An `acmart` preamble as a submission template ships it. */
const preamble = (options: string, cls = "acmart"): string[] => [
  `${tex}documentclass[${options}]{${cls}}`,
  `${tex}acmDOI{XXXXXXX.XXXXXXX}`,
  `${tex}acmISBN{978-1-4503-XXXX-X/2018/06}`,
  `${tex}begin{document}`,
  `${tex}title{Corridor Attention}`,
  `${tex}author{Author Name}`,
  `${tex}affiliation{%`,
  `  ${tex}institution{Your Institution}`,
  `  ${tex}city{Dublin}`,
  `  ${tex}country{Ireland}`,
  "}",
  `${tex}email{author@example.org}`,
  `% ${tex}author{A Real Name, commented out}`,
  `${tex}maketitle`,
  `${tex}begin{figure}`,
  `${tex}includegraphics{figures/teaser.pdf}`,
  `${tex}end{figure}`,
  `${tex}end{document}`,
];

/** A located concern on 1-based `line` (through `endLine`) of main.tex. */
const at = (line: number, endLine?: number): ReviewAnnotation => ({
  id: "pdf_reviewer-1",
  reviewer: "pdf_reviewer",
  dimension: "presentation",
  severity: "major",
  span: { file: "main.tex", line, ...(endLine ? { endLine } : {}) },
  message: "m",
});

const furnitureOf = (lines: string[]) =>
  reviewFurniture({
    files: new Map([["main.tex", lines.join("\n")]]),
    entry: "main.tex",
  });

describe("documentClassOf — the entry's class and options (ADR 0085 §2)", () => {
  it("reads them trimmed, across lines, with comments cut", () => {
    expect(
      documentClassOf(
        `${tex}documentclass[sigconf, screen,\n  review, anonymous]{acmart}`,
      ),
    ).toEqual({
      name: "acmart",
      options: ["sigconf", "screen", "review", "anonymous"],
    });
    expect(
      documentClassOf(
        `% ${tex}documentclass[anonymous]{acmart}\n${tex}documentclass[sigconf]{acmart}`,
      ),
    ).toEqual({ name: "acmart", options: ["sigconf"] });
  });

  it("gives [] for a class given no options, and undefined for an entry with no class", () => {
    expect(documentClassOf(`${tex}documentclass{article}`)).toEqual({
      name: "article",
      options: [],
    });
    expect(documentClassOf("Just prose.")).toBeUndefined();
  });

  it("runs anonymous only on a class that implements the option, and never `=false`", () => {
    const cls = (name: string, ...options: string[]) => ({ name, options });
    expect(runsAnonymous(cls("acmart", "sigconf", "anonymous"))).toBe(true);
    expect(runsAnonymous(cls("acmart", "anonymous = true"))).toBe(true);
    expect(runsAnonymous(cls("lipics-v2021", "anonymous"))).toBe(true);
    expect(runsAnonymous(cls("acmart", "anonymous=false"))).toBe(false);
    expect(runsAnonymous(cls("acmart", "sigconf", "review"))).toBe(false);
    // The code review: `article` ignores the option and prints the name.
    expect(runsAnonymous(cls("article", "anonymous"))).toBe(false);
  });
});

describe("isReviewFurniture — what the class prints for review (ADR 0085 §2, O41)", () => {
  const anonymous = furnitureOf(preamble("sigconf, review, anonymous"));
  const named = furnitureOf(preamble("sigconf, review"));

  it("an author block the anonymous option hides is furniture, its sub-macros included", () => {
    expect(anonymous(at(6))).toBe(true); // \author
    expect(anonymous(at(7))).toBe(true); // \affiliation{%
    expect(anonymous(at(8))).toBe(true); // \institution
    expect(anonymous(at(9))).toBe(true); // \city
    expect(anonymous(at(12))).toBe(true); // \email
  });

  it("the same block WITHOUT anonymous is on the page, and is kept (E1's V10)", () => {
    expect(named(at(6))).toBe(false);
    expect(named(at(8))).toBe(false);
    expect(furnitureOf(preamble("sigconf, anonymous=false"))(at(6))).toBe(
      false,
    );
  });

  it("an `anonymous` passed to a class that ignores it hides nothing (the code review)", () => {
    const article = furnitureOf(preamble("anonymous", "article"));
    expect(article(at(6))).toBe(false);
    // A template placeholder is still one, whatever the class.
    expect(article(at(2))).toBe(true);
  });

  it("the template's placeholder DOI and ISBN are furniture in any mode", () => {
    for (const review of [anonymous, named]) {
      expect(review(at(2))).toBe(true); // \acmDOI{XXXXXXX.XXXXXXX}
      expect(review(at(3))).toBe(true); // \acmISBN{…-XXXX-X/…}
    }
  });

  it("a real DOI, and an ISBN whose check digit is X, are not placeholders", () => {
    const real = furnitureOf([
      `${tex}documentclass[sigconf]{acmart}`,
      `${tex}acmDOI{10.1145/3664647.3680912}`,
      `${tex}acmISBN{0-306-40615-X}`,
    ]);
    expect(real(at(2))).toBe(false);
    expect(real(at(3))).toBe(false);
  });

  it("anything else is not furniture — a figure, the title, a commented-out author", () => {
    expect(anonymous(at(16))).toBe(false); // \includegraphics
    expect(anonymous(at(5))).toBe(false); // \title
    expect(anonymous(at(13))).toBe(false); // % \author{…}
  });

  it("a multi-line anchor is furniture only when every line of it is (the code review)", () => {
    expect(anonymous(at(6, 12))).toBe(true); // the whole block, its `}` included
    expect(anonymous(at(5, 6))).toBe(false); // \title … \author
  });
});
