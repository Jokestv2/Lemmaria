import type { DocumentAdapter } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { LatexAdapter, loadLatexAdapter } from "../../src/index.js";
import { fixtureReader, memReader } from "./helpers.js";

describe("LatexAdapter", () => {
  it("implements the DocumentAdapter contract end to end", async () => {
    const adapter: DocumentAdapter = await loadLatexAdapter(
      fixtureReader("simple-en"),
      "main.tex",
    );
    expect(adapter.kind).toBe("latex");

    const tree = await adapter.parseStructure();
    expect(tree.map((n) => n.title)).toEqual(["Introduction", "Method"]);

    const src = (adapter as LatexAdapter).project.file("main.tex").source;
    const sel = src.indexOf("beta gamma");
    const unit = adapter.resolveSelection(
      { file: "main.tex", startOffset: sel, endOffset: sel + 4 },
      "paragraph",
    );
    expect(adapter.protectedSpans(unit).length).toBeGreaterThan(0);
    expect(adapter.countWords("one two").count).toBe(2);
    expect(adapter.applyEdit(unit, unit.text).newText).toBe(src);
  });

  it("exposes ctex detection via features", async () => {
    const adapter = await LatexAdapter.load(
      fixtureReader("ctex-zh"),
      "main.tex",
    );
    expect(adapter.features).toEqual({
      ctex: true,
      xecjk: false,
      engine: "xelatex",
    });
  });

  it("protectedSpans() stays the outermost-only freeze view (X3, ADR 0036)", async () => {
    // `freezeUnit` substitutes ⟦Pn⟧ by offset, so two overlapping spans would
    // corrupt the frozen text. X3 surfaces nested spans for the AGENTIC reader
    // only; if this ever starts overlapping, the quick-action path is broken in
    // a way its own round-trip tests would only catch by luck.
    //
    // Driven over source that is KNOWN to nest (review, M9): asserted against a
    // fixture with no nested markup, this would pass vacuously and prove
    // nothing at all.
    const src = [
      "\\documentclass{article}",
      "\\begin{document}",
      "A \\textbf{\\emph{measurement decision}} and \\footnote{See \\cite{a}.}",
      "with \\textbf{value $x^2$ here} plus \\section{The \\label{sec:x} bit}",
      "\\end{document}",
      "",
    ].join("\n");
    const adapter = await LatexAdapter.load(
      memReader({ "main.tex": src }),
      "main.tex",
    );
    const spans = adapter.protectedSpans({
      scope: "document",
      text: src,
      span: { file: "main.tex", startOffset: 0, endOffset: src.length },
    });
    // The nesting really is there — otherwise the non-overlap check is trivial.
    expect(spans.some((s) => s.raw.includes("\\emph{"))).toBe(true);
    for (const [i, s] of spans.entries()) {
      const next = spans[i + 1];
      if (next) expect(next.startOffset).toBeGreaterThanOrEqual(s.endOffset);
    }
  });

  it("citations() resolves empty when the project declares no .bib (M7)", async () => {
    const adapter = await LatexAdapter.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    // Full bib-extraction behavior is covered in citations.test.ts.
    await expect(adapter.citations()).resolves.toEqual([]);
  });
});
