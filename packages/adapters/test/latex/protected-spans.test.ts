import { describe, expect, it } from "vitest";
import { LatexProject } from "../../src/latex/project.js";
import { collectProtectedSpans } from "../../src/latex/protected-spans.js";
import { resolveSelectionIn } from "../../src/latex/selection.js";
import { fixtureReader, memReader } from "./helpers.js";

describe("collectProtectedSpans", () => {
  it("protects math, cites, refs, labels, and custom macros in a section", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const src = project.file("main.tex").source;
    const sel = src.indexOf("beta gamma");
    const section = resolveSelectionIn(
      project,
      { file: "main.tex", startOffset: sel, endOffset: sel + 4 },
      "section",
    );
    const spans = collectProtectedSpans(project, section);
    expect(spans.map((s) => [s.kind, s.raw])).toEqual([
      ["markup", "\\section{Introduction}"],
      ["ref", "\\label{sec:intro}"],
      ["cite", "\\cite{knuth1984}"],
      ["ref", "\\ref{sec:method}"],
      ["macro", "\\ourmethod"],
    ]);
    expect(spans.map((s) => s.token)).toEqual([
      "⟦P0⟧",
      "⟦P1⟧",
      "⟦P2⟧",
      "⟦P3⟧",
      "⟦P4⟧",
    ]);
    for (const s of spans) {
      expect(src.slice(s.startOffset, s.endOffset)).toBe(s.raw);
      expect(s.file).toBe("main.tex");
    }
  });

  it("protects display/inline math and verbatim as math/code", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const src = project.file("main.tex").source;
    const sel = src.indexOf("The model computes");
    const section = resolveSelectionIn(
      project,
      { file: "main.tex", startOffset: sel, endOffset: sel + 4 },
      "section",
    );
    const kinds = collectProtectedSpans(project, section).map((s) => [
      s.kind,
      s.raw.slice(0, 16),
    ]);
    expect(kinds).toContainEqual(["math", "$E = mc^2$"]);
    expect(kinds).toContainEqual(["math", "\\begin{equation}"]);
    expect(kinds).toContainEqual(["code", "\\begin{verbatim}"]);
  });

  it("freezes comments and non-prose macros so they are not counted or rewritten", async () => {
    const src =
      "\\section{Intro}\\label{sec:i}\nWe use \\textbf{bold} and \\LaTeX. % a note\n\\maketitle\n";
    const project = await LatexProject.load(
      memReader({ "main.tex": src }),
      "main.tex",
    );
    const spans = collectProtectedSpans(project, {
      scope: "document",
      text: src,
      span: { file: "main.tex", startOffset: 0, endOffset: src.length },
    });
    const byRaw = new Map(spans.map((s) => [s.raw, s.kind]));
    // Sectioning + text-formatting freeze WHOLE (command + argument text), so
    // the title/emphasis text is neither counted by word_count nor reworded.
    expect(byRaw.get("\\section{Intro}")).toBe("markup");
    expect(byRaw.get("\\textbf{bold}")).toBe("markup");
    // A bare/standalone macro and its name freeze even without an argument.
    expect(byRaw.get("\\LaTeX")).toBe("markup");
    expect(byRaw.get("\\maketitle")).toBe("markup");
    // Comments freeze verbatim (never counted, translated, or shrunk).
    const comment = spans.find((s) => s.kind === "comment");
    expect(comment?.raw.trimStart().startsWith("%")).toBe(true);
    expect(comment?.raw).toContain("a note");
    // Known ref/label macros keep their specific kind.
    expect(byRaw.get("\\label{sec:i}")).toBe("ref");
    // Every span's raw is an exact slice of the source.
    for (const s of spans) {
      expect(src.slice(s.startOffset, s.endOffset)).toBe(s.raw);
    }
  });

  it("keeps only the outermost of nested candidates", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex": "\\newcommand{\\wrap}[1]{#1}\n\\wrap{$x$} done",
      }),
      "main.tex",
    );
    const spans = collectProtectedSpans(project, {
      scope: "document",
      text: project.file("main.tex").source,
      span: {
        file: "main.tex",
        startOffset: 0,
        endOffset: project.file("main.tex").source.length,
      },
    });
    const raws = spans.map((s) => s.raw);
    expect(raws).toContain("\\wrap{$x$}");
    expect(raws).not.toContain("$x$");
  });
});

/**
 * X3 (ADR 0036). ADR 0033 §3 freed a CONTAINER's prose while the detector went
 * on dropping every candidate inside an accepted span — so freeing the prose
 * freed whatever was nested in it too. Measured on the shipped code: a `$…$`
 * inside `\textbf{}`, a `\cite{}` inside `\footnote{}` and a `\label{}` inside
 * `\section{}` were each droppable with no refusal at all.
 *
 * The nesting is surfaced ONLY on the agentic path. The quick-action freeze
 * path substitutes `⟦Pn⟧` by offset and would be corrupted by overlapping
 * spans — and it does not need them, because freezing the outermost span
 * protects everything inside it more strongly.
 */
describe("collectProtectedSpans — nesting (X3, ADR 0036)", () => {
  const spansFor = async (
    src: string,
    opts?: { nested?: boolean },
  ): Promise<Array<[string, string]>> => {
    const project = await LatexProject.load(
      memReader({ "main.tex": src }),
      "main.tex",
    );
    return collectProtectedSpans(
      project,
      {
        scope: "document",
        text: src,
        span: { file: "main.tex", startOffset: 0, endOffset: src.length },
      },
      opts,
    ).map((s) => [s.kind, s.raw]);
  };

  it("surfaces an opaque span nested inside a container", async () => {
    const src = "The \\textbf{value $x^2$ here} matters.\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\textbf{value $x^2$ here}"],
      ["math", "$x^2$"],
    ]);
  });

  it("surfaces a citation nested inside a \\footnote{}", async () => {
    const src = "Text\\footnote{See \\cite{smith2020} for more.} continues.\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\footnote{See \\cite{smith2020} for more.}"],
      ["cite", "\\cite{smith2020}"],
    ]);
  });

  it("surfaces a \\label{} nested inside a \\section{}", async () => {
    const src = "\\section{The \\label{sec:x} bit}\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\section{The \\label{sec:x} bit}"],
      ["ref", "\\label{sec:x}"],
    ]);
  });

  it("surfaces a markup command nested inside a markup container", async () => {
    const src = "A \\textbf{\\emph{measurement decision}} matters.\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\textbf{\\emph{measurement decision}}"],
      ["markup", "\\emph{measurement decision}"],
    ]);
  });

  it("surfaces NOTHING inside an opaque span — the whole raw is required", async () => {
    // A custom macro is `macro`, an opaque kind: its whole raw is enforced, so
    // a second entry for the `$x$` inside would be noise the model cannot act
    // on. This is the pre-X3 "outermost only" test, re-asserted WITH nesting on.
    const src = "\\newcommand{\\wrap}[1]{#1}\n\\wrap{$x$} done";
    const raws = (await spansFor(src, { nested: true })).map(([, raw]) => raw);
    expect(raws).toContain("\\wrap{$x$}");
    expect(raws).not.toContain("$x$");
  });

  it("surfaces nothing inside a comment", async () => {
    const src = "Prose. % see \\cite{smith2020} and $x$\nMore prose.\n";
    const kinds = (await spansFor(src, { nested: true })).map(([k]) => k);
    expect(kinds).toEqual(["comment"]);
  });

  it("is OFF by default — the freeze set is outermost-only and non-overlapping", async () => {
    const src = "The \\textbf{value $x^2$ here} matters.\n";
    expect(await spansFor(src)).toEqual([
      ["markup", "\\textbf{value $x^2$ here}"],
    ]);
  });

  it("does NOT surface a single-character escape from inside a container", async () => {
    // Review, I4. `\%` parses as a macro and classifies as `markup`, and
    // `containerSkeleton` recognises neither shape, so it falls back to the
    // whole raw and is enforced OPAQUELY. Surfacing it from inside a container
    // makes rewriting `\emph{50\% of runs}` into `\emph{half the runs}` a
    // refusal — ordinary prose inside a container's free prose, which is what
    // ADR 0033 §3 exists to permit.
    const src = "The \\emph{50\\% of runs} that failed.\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\emph{50\\% of runs}"],
    ]);
  });

  it("still protects a TOP-LEVEL escape — the freeze view is untouched", async () => {
    // Turning `\%` into `%` comments out the rest of the line, so the
    // top-level answer is unchanged in both views.
    const src = "Roughly 30\\% of cases were dropped.\n";
    expect(await spansFor(src)).toEqual([["markup", "\\%"]]);
    expect(await spansFor(src, { nested: true })).toEqual([["markup", "\\%"]]);
  });

  it("nests two levels deep", async () => {
    const src = "A \\textbf{a \\emph{b $c$}} d\n";
    expect(await spansFor(src, { nested: true })).toEqual([
      ["markup", "\\textbf{a \\emph{b $c$}}"],
      ["markup", "\\emph{b $c$}"],
      ["math", "$c$"],
    ]);
  });
});
