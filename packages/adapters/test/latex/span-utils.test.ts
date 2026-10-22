import type * as Ast from "@unified-latex/unified-latex-types";
import { attachMacroArgs } from "@unified-latex/unified-latex-util-arguments";
import { getParser } from "@unified-latex/unified-latex-util-parse";
import { describe, expect, it } from "vitest";
import { argText, macroFullSpan } from "../../src/latex/span-utils.js";
import { walkAll } from "../../src/latex/walk.js";

function findMacro(tree: Ast.Root, name: string): Ast.Macro {
  let found: Ast.Macro | undefined;
  walkAll(tree.content, (n) => {
    if (!found && n.type === "macro" && n.content === name) found = n;
  });
  if (!found) throw new Error(`no \\${name}`);
  return found;
}

describe("macroFullSpan", () => {
  it("covers name + args incl. closing braces for parser-known macros", () => {
    const src = "See \\ref{sec:x} here.";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "ref"));
    expect(src.slice(span.start, span.end)).toBe("\\ref{sec:x}");
  });

  it("covers natbib cites after attachMacroArgs, incl. optional args", () => {
    const src = "As \\citep[p.~5]{key1, key2} shows.";
    const tree = getParser().parse(src);
    attachMacroArgs(tree, { citep: { signature: "s o o m" } });
    const span = macroFullSpan(src, findMacro(tree, "citep"));
    expect(src.slice(span.start, span.end)).toBe("\\citep[p.~5]{key1, key2}");
  });

  it("does not swallow closing braces of enclosing structures", () => {
    // The ] of [p.5] sits BEFORE the mandatory arg, so it is already inside
    // the span; only the final } is pending — the footnote's } must survive.
    const src = "\\footnote{See \\citep[p.5]{key}} more.";
    const tree = getParser().parse(src);
    attachMacroArgs(tree, { citep: { signature: "s o o m" } });
    const span = macroFullSpan(src, findMacro(tree, "citep"));
    expect(src.slice(span.start, span.end)).toBe("\\citep[p.5]{key}");
  });

  it("is name-only for macros without args", () => {
    const src = "Uses \\ourmethod today.";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "ourmethod"));
    expect(src.slice(span.start, span.end)).toBe("\\ourmethod");
  });
});

/**
 * X3 (ADR 0036). Counting the ROOT macro's pending `closeMark`s misses the
 * closers still owed by a nested macro, so a container whose last positioned
 * descendant sits inside a nested argument recorded an UNBALANCED raw:
 * `\textbf{\emph{x}}` came back as `\textbf{\emph{x}`. That is what made the
 * declared-removal escape unreachable in practice — the only string the
 * matcher accepted looked like a typo, so a model that tidied its own
 * quotation was refused as dishonest. Measuring the slice's brace depth
 * answers all of these, and keeps the four assertions above unchanged.
 */
describe("macroFullSpan — nested macros (X3, ADR 0036)", () => {
  it("balances a nested pair whose inner macro ENDS the container", () => {
    const src = "\\textbf{\\emph{measurement decision}} matters.";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\textbf{\\emph{measurement decision}}",
    );
  });

  it("still records the INNER macro's own balanced span", () => {
    const src = "\\textbf{\\emph{measurement decision}} matters.";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "emph"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\emph{measurement decision}",
    );
  });

  it("balances a caption whose \\label ends it", () => {
    const src = "\\caption{A figure.\\label{fig:x}}";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "caption"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\caption{A figure.\\label{fig:x}}",
    );
  });

  it("balances three levels of nesting", () => {
    const src = "\\textbf{a \\emph{b \\texttt{c}}} d";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\textbf{a \\emph{b \\texttt{c}}}",
    );
  });

  it("does not treat an unmatched [ in ordinary text as an open delimiter", () => {
    // Found while reviewing X3's own first cut, which measured `[`/`]` depth
    // alongside braces: `$[0,1)$` is one bracket and one parenthesis, so the
    // slice looked unbalanced and the scan consumed the FOOTNOTE's closing
    // brace — recording `\textbf{range $[0,1)$}}` and moving a span's bounds.
    // In LaTeX a bracket delimits an argument only where a signature says so;
    // that case is `pendingArgClosers`, which reads the parser's closeMarks.
    const src = "A \\footnote{\\textbf{range $[0,1)$}} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe("\\textbf{range $[0,1)$}");
  });

  it("does not stop a character SHORT on a stray closing bracket", () => {
    // The other direction of the same defect (review, C1): counting `]` as a
    // closer made the slice look balanced one character early.
    const src = "A \\textbf{a ] c} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe("\\textbf{a ] c}");
  });

  it("handles a closed interval, whose bracket closes nothing", () => {
    const src = "A \\textbf{the interval $(0,1]$} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\textbf{the interval $(0,1]$}",
    );
  });

  it("reads a brace inside \\verb as literal text, not structure", () => {
    // Review, I2: the scanner has no notion of verbatim, so `\verb|{|` read as
    // one brace short and consumed the FOOTNOTE's closer.
    const src = "A \\footnote{\\textbf{\\verb|{|}} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe("\\textbf{\\verb|{|}");
  });

  it("reads a percent inside \\verb as literal text, not a comment", () => {
    const src = "A \\footnote{\\textbf{a \\verb|%| b}} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe("\\textbf{a \\verb|%| b}");
  });

  it("does not mistake \\verbatim for \\verb with an 'a' delimiter", () => {
    const src = "A \\textbf{x \\verbatim y} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe("\\textbf{x \\verbatim y}");
  });

  it("stops at a trailing comment that never ends in a newline", () => {
    // The one branch that abandons the measurement rather than finishing it
    // (review, M11). A comment really does run to EOF, so stopping is right.
    const src = "A \\textbf{x % note to end of file";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    const raw = src.slice(span.start, span.end);
    // It terminates, stays inside the source, and never invents a closer that
    // is not there — the honest answer for text that has none.
    expect(raw.startsWith("\\textbf")).toBe(true);
    expect(span.end).toBeLessThanOrEqual(src.length);
    expect(raw.endsWith("}")).toBe(false);
  });

  it("leaves an unmatched [ inside a container alone", () => {
    const src = "A \\footnote{\\textbf{on the interval [0,1}} done";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\textbf{on the interval [0,1}",
    );
  });

  it("does not read an ESCAPED percent as the start of a comment", () => {
    // An unescaped % runs to end of line and can hide a brace; an escaped one
    // is ordinary text. Getting this backwards would mis-measure the depth and
    // move the span's end, which is worse than the bug being fixed.
    const src = "\\textbf{50\\% of \\emph{runs}} ok";
    const tree = getParser().parse(src);
    const span = macroFullSpan(src, findMacro(tree, "textbf"));
    expect(src.slice(span.start, span.end)).toBe(
      "\\textbf{50\\% of \\emph{runs}}",
    );
  });
});

describe("argText", () => {
  it("prints an arg's raw content", () => {
    const tree = getParser().parse("\\section{The \\emph{Big} Idea}");
    const macro = findMacro(tree, "section");
    expect(argText(macro, -1)).toBe("The \\emph{Big} Idea");
  });
});

describe("walkAll", () => {
  it("descends into macro args (labels inside captions are reachable)", () => {
    const tree = getParser().parse("\\caption{A figure.\\label{fig:x}}");
    const labels: string[] = [];
    walkAll(tree.content, (n) => {
      if (n.type === "macro" && n.content === "label")
        labels.push(argText(n, -1));
    });
    expect(labels).toEqual(["fig:x"]);
  });
});
