import { describe, expect, it } from "vitest";
import {
  detectBibliographyStyle,
  detectDocumentClass,
  detectLatexFeatures,
} from "../../src/latex/detect.js";
import { LatexProject } from "../../src/latex/project.js";
import { fixtureReader, memReader } from "./helpers.js";

describe("detectLatexFeatures", () => {
  it("detects ctex document classes and routes to xelatex", async () => {
    const project = await LatexProject.load(
      fixtureReader("ctex-zh"),
      "main.tex",
    );
    expect(detectLatexFeatures(project)).toEqual({
      ctex: true,
      xecjk: false,
      engine: "xelatex",
    });
  });

  it("detects \\usepackage{xeCJK}", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex": "\\documentclass{article}\n\\usepackage{xeCJK}\n",
      }),
      "main.tex",
    );
    expect(detectLatexFeatures(project)).toEqual({
      ctex: false,
      xecjk: true,
      engine: "xelatex",
    });
  });

  it("detects \\usepackage[options]{ctex} in any loaded file", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex": "\\input{preamble}\nBody",
        "preamble.tex": "\\usepackage[heading=true]{ctex}",
      }),
      "main.tex",
    );
    expect(detectLatexFeatures(project).ctex).toBe(true);
  });

  it("defaults to pdflatex", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    expect(detectLatexFeatures(project)).toEqual({
      ctex: false,
      xecjk: false,
      engine: "pdflatex",
    });
  });
});

describe("detectDocumentClass (M10 {{venue}} detection)", () => {
  it("extracts class name and options", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex":
          "\\documentclass[sigconf,review]{acmart}\n\\begin{document}Hi\\end{document}\n",
      }),
      "main.tex",
    );
    expect(detectDocumentClass(project)).toEqual({
      name: "acmart",
      options: ["sigconf", "review"],
    });
  });

  it("has empty options when the optional argument is absent", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex":
          "\\documentclass{article}\n\\begin{document}Hi\\end{document}\n",
      }),
      "main.tex",
    );
    expect(detectDocumentClass(project)).toEqual({
      name: "article",
      options: [],
    });
  });

  it("returns undefined when there is no documentclass", async () => {
    const project = await LatexProject.load(
      memReader({ "main.tex": "Just a fragment, no preamble.\n" }),
      "main.tex",
    );
    expect(detectDocumentClass(project)).toBeUndefined();
  });

  it("reads the ENTRY file, not an \\input child", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex": "\\documentclass{book}\n\\input{child}\n",
        "child.tex": "\\documentclass{article}\n",
      }),
      "main.tex",
    );
    expect(detectDocumentClass(project)?.name).toBe("book");
  });
});

describe("detectBibliographyStyle", () => {
  it("finds \\bibliographystyle in the entry file", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex":
          "\\documentclass{article}\n\\begin{document}\nHi\n\\bibliographystyle{IEEEtran}\n\\bibliography{refs}\n\\end{document}\n",
      }),
      "main.tex",
    );
    expect(detectBibliographyStyle(project)).toBe("IEEEtran");
  });

  it("finds it in an \\input child when the entry has none", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex": "\\documentclass{article}\n\\input{tail}\n",
        "tail.tex": "\\bibliographystyle{splncs04}\n",
      }),
      "main.tex",
    );
    expect(detectBibliographyStyle(project)).toBe("splncs04");
  });

  it("ignores commented-out declarations", async () => {
    const project = await LatexProject.load(
      memReader({
        "main.tex":
          "\\documentclass{article}\n% \\bibliographystyle{plain}\n\\bibliographystyle{acm}\n",
      }),
      "main.tex",
    );
    expect(detectBibliographyStyle(project)).toBe("acm");
  });

  it("returns undefined when absent", async () => {
    const project = await LatexProject.load(
      memReader({ "main.tex": "\\documentclass{article}\nBody\n" }),
      "main.tex",
    );
    expect(detectBibliographyStyle(project)).toBeUndefined();
  });
});
