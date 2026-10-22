import { describe, expect, it } from "vitest";
import { LatexProject } from "../../src/latex/project.js";
import { resolveSelectionIn } from "../../src/latex/selection.js";
import { fixtureReader } from "./helpers.js";

async function simpleEn() {
  return LatexProject.load(fixtureReader("simple-en"), "main.tex");
}

/** Load a project from an inline source string (no fixture file needed). */
async function inlineProject(source: string) {
  return LatexProject.load(
    { readFile: () => Promise.resolve(source) },
    "main.tex",
  );
}

function spanOf(source: string, needle: string) {
  const startOffset = source.indexOf(needle);
  if (startOffset < 0) throw new Error(`needle not found: ${needle}`);
  return {
    file: "main.tex",
    startOffset,
    endOffset: startOffset + needle.length,
  };
}

describe("resolveSelectionIn", () => {
  it("scope=selection returns the exact span", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "beta gamma"),
      "selection",
    );
    expect(unit).toEqual({
      scope: "selection",
      text: "beta gamma",
      span: spanOf(src, "beta gamma"),
    });
  });

  it("scope=paragraph expands to blank-line boundaries", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "beta gamma"),
      "paragraph",
    );
    expect(unit.text).toBe(
      "Alpha beta gamma delta \\cite{knuth1984}.\nSee \\ref{sec:method} for details of \\ourmethod.",
    );
    expect(src.slice(unit.span.startOffset, unit.span.endOffset)).toBe(
      unit.text,
    );
  });

  it("scope=paragraph keeps display math inside and stops at headings", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "epsilon zeta"),
      "paragraph",
    );
    // No blank line separates these sentences, so the display equation stays
    // inside the paragraph (locked design decision) — but headings bound it.
    expect(unit.text.startsWith("The model computes")).toBe(true);
    expect(unit.text).toContain("\\end{equation}");
    expect(unit.text.endsWith("epsilon zeta.")).toBe(true);
    expect(unit.text).not.toContain("\\section");
    expect(unit.text).not.toContain("\\subsection");
  });

  it("scope=section covers heading through last content line", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "beta gamma"),
      "section",
    );
    expect(unit.text.startsWith("\\section{Introduction}")).toBe(true);
    expect(unit.text).toContain("\\ourmethod.");
    expect(unit.text).not.toContain("\\section{Method}");
  });

  it("scope=environment finds the smallest enclosing environment", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(project, spanOf(src, "x_i"), "environment");
    expect(unit.text.startsWith("\\begin{equation}")).toBe(true);
    expect(unit.text.endsWith("\\end{equation}")).toBe(true);
  });

  it("scope=environment throws when there is none", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    expect(() =>
      resolveSelectionIn(project, spanOf(src, "beta gamma"), "environment"),
    ).toThrow(/no enclosing environment/);
  });

  it("normalizes an inverted selection (host anchor/active may arrive swapped)", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const fwd = spanOf(src, "beta gamma");
    const unit = resolveSelectionIn(
      project,
      {
        file: "main.tex",
        startOffset: fwd.endOffset,
        endOffset: fwd.startOffset,
      },
      "selection",
    );
    expect(unit.text).toBe("beta gamma");
    expect(unit.span).toEqual(fwd);
  });

  it("scope=paragraph never includes the \\begin/\\end{document} delimiters", async () => {
    // A typo'd heading (\secion) gives NO heading boundary, and the body has no
    // interior blank line, so without a delimiter guard the 'paragraph' would
    // swallow the whole document environment — the auto-fix corruption bug.
    const src = [
      "\\documentclass{article}",
      "\\begin{document}",
      "",
      "\\secion{Introduction}\\label{sec:intro}",
      "In this paper we introduce a method.",
      "",
      "\\end{document}",
      "",
    ].join("\n");
    const project = await inlineProject(src);
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "\\secion"),
      "paragraph",
    );
    expect(unit.text).not.toContain("\\begin{document}");
    expect(unit.text).not.toContain("\\end{document}");
    expect(unit.text).toContain("\\secion{Introduction}");
    expect(unit.text).toContain("In this paper we introduce a method.");
    // The span still round-trips exactly to the source.
    expect(src.slice(unit.span.startOffset, unit.span.endOffset)).toBe(
      unit.text,
    );
  });

  it("scope=paragraph in the last paragraph does not swallow \\end{document}", async () => {
    const src = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}",
      "",
      "The final paragraph of the body.",
      "",
      "\\end{document}",
      "",
    ].join("\n");
    const project = await inlineProject(src);
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "final paragraph"),
      "paragraph",
    );
    expect(unit.text).toBe("The final paragraph of the body.");
    expect(unit.text).not.toContain("\\end{document}");
  });

  it("scope=document returns the whole file", async () => {
    const project = await simpleEn();
    const src = project.file("main.tex").source;
    const unit = resolveSelectionIn(
      project,
      spanOf(src, "beta gamma"),
      "document",
    );
    expect(unit.text).toBe(src);
  });
});
