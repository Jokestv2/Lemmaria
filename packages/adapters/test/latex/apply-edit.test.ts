import { describe, expect, it } from "vitest";
import { applyEditIn } from "../../src/latex/apply-edit.js";
import { LatexProject } from "../../src/latex/project.js";
import { resolveSelectionIn } from "../../src/latex/selection.js";
import { fixtureReader } from "./helpers.js";

describe("applyEditIn", () => {
  it("round-trips byte-for-byte when replacement === original (M2 acceptance)", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const src = project.file("main.tex").source;
    const sel = src.indexOf("beta gamma");
    for (const scope of [
      "selection",
      "paragraph",
      "section",
      "document",
    ] as const) {
      const unit = resolveSelectionIn(
        project,
        { file: "main.tex", startOffset: sel, endOffset: sel + 4 },
        scope,
      );
      expect(applyEditIn(project, unit, unit.text).newText).toBe(src);
    }
  });

  it("splices a replacement, touching nothing outside the unit", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const src = project.file("main.tex").source;
    const sel = src.indexOf("Alpha beta gamma delta");
    const unit = resolveSelectionIn(
      project,
      { file: "main.tex", startOffset: sel, endOffset: sel + 5 },
      "paragraph",
    );
    const { newText } = applyEditIn(project, unit, "REWRITTEN.");
    expect(newText.slice(0, unit.span.startOffset)).toBe(
      src.slice(0, unit.span.startOffset),
    );
    expect(
      newText.slice(unit.span.startOffset, unit.span.startOffset + 10),
    ).toBe("REWRITTEN.");
    expect(newText.slice(unit.span.startOffset + 10)).toBe(
      src.slice(unit.span.endOffset),
    );
  });

  it("round-trips byte-for-byte from an inverted host selection", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const src = project.file("main.tex").source;
    const sel = src.indexOf("beta gamma");
    const unit = resolveSelectionIn(
      project,
      { file: "main.tex", startOffset: sel + 10, endOffset: sel },
      "selection",
    );
    expect(applyEditIn(project, unit, unit.text).newText).toBe(src);
  });

  it("rejects a unit whose span is inverted or out of bounds", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const len = project.file("main.tex").source.length;
    const base = { scope: "selection" as const, text: "" };
    expect(() =>
      applyEditIn(
        project,
        { ...base, span: { file: "main.tex", startOffset: 25, endOffset: 20 } },
        "x",
      ),
    ).toThrow(/invalid span/i);
    expect(() =>
      applyEditIn(
        project,
        { ...base, span: { file: "main.tex", startOffset: -1, endOffset: 5 } },
        "x",
      ),
    ).toThrow(/invalid span/i);
    expect(() =>
      applyEditIn(
        project,
        {
          ...base,
          span: { file: "main.tex", startOffset: 0, endOffset: len + 1 },
        },
        "x",
      ),
    ).toThrow(/invalid span/i);
  });

  it("rejects a stale unit (content anchor mismatch)", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const unit = {
      scope: "selection" as const,
      text: "NOT WHAT IS THERE",
      span: { file: "main.tex", startOffset: 0, endOffset: 17 },
    };
    expect(() => applyEditIn(project, unit, "x")).toThrow(/stale/i);
  });
});
