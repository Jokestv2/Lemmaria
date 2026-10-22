import { getParser } from "@unified-latex/unified-latex-util-parse";
import { describe, expect, it } from "vitest";
import { extractProse } from "../../src/latex/prose.js";

function prose(src: string): string {
  return extractProse(getParser().parse(src).content);
}

describe("extractProse", () => {
  it("keeps plain text and styled-macro arg text", () => {
    expect(prose("Alpha \\emph{beta} gamma.").replace(/\s+/g, " ").trim()).toBe(
      "Alpha beta gamma.",
    );
  });

  it("skips math, verbatim, and comments", () => {
    const src =
      "One $x=1$ two \\begin{verbatim}zap\\end{verbatim} three % four\n";
    expect(prose(src).replace(/\s+/g, " ").trim()).toBe("One two three");
  });

  it("skips reference-like macros entirely (\\cite keys are not words)", () => {
    expect(
      prose("See \\cite{knuth1984} and \\ref{sec:x}.")
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("See and .");
  });
});
