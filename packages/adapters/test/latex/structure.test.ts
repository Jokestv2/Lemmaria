import { describe, expect, it } from "vitest";
import { LatexProject } from "../../src/latex/project.js";
import { buildStructure } from "../../src/latex/structure.js";
import { fixtureReader } from "./helpers.js";

describe("buildStructure", () => {
  it("nests subsections and counts words/labels/citations per range", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    const tree = buildStructure(project);
    expect(tree.map((n) => n.title)).toEqual(["Introduction", "Method"]);

    const intro = tree[0];
    expect(intro?.file).toBe("main.tex");
    expect(intro?.labels).toEqual(["sec:intro"]);
    expect(intro?.citations).toEqual(["knuth1984"]);
    expect(intro?.wordCount).toBe(8); // Alpha beta gamma delta See for details of

    const method = tree[1];
    expect(method?.labels).toEqual(["sec:method", "eq:loss"]);
    expect(method?.children.map((n) => n.title)).toEqual(["Training"]);
    expect(method?.wordCount).toBe(14); // 9 own + 5 in Training
    expect(method?.children[0]?.wordCount).toBe(5);
  });

  it("spans \\input files with per-file line attribution", async () => {
    const project = await LatexProject.load(
      fixtureReader("multifile"),
      "main.tex",
    );
    const tree = buildStructure(project);
    expect(tree.map((n) => [n.title, n.file])).toEqual([
      ["Overview", "main.tex"],
      ["Introduction", "sections/intro.tex"],
      ["Method", "sections/method.tex"],
    ]);
    expect(tree[0]?.wordCount).toBe(3);
    expect(tree[0]?.citations).toEqual(["alpha2020"]);
    expect(tree[1]?.labels).toEqual(["sec:intro"]);
    expect(tree[1]?.startLine).toBe(1);
    expect(tree[2]?.wordCount).toBe(4); // Eight nine ten See
  });

  it("ignores macros named after Object.prototype members", async () => {
    const { memReader } = await import("./helpers.js");
    const project = await LatexProject.load(
      memReader({
        "main.tex":
          "\\begin{document}\n\\valueOf{x} \\toString{y}\n\\section{Real}\nWords here.\n\\end{document}\n",
      }),
      "main.tex",
    );
    const tree = buildStructure(project);
    expect(tree.map((n) => n.title)).toEqual(["Real"]);
  });

  it("counts mixed CN/EN content", async () => {
    const project = await LatexProject.load(
      fixtureReader("ctex-zh"),
      "main.tex",
    );
    const tree = buildStructure(project);
    expect(tree[0]?.title).toBe("引言");
    expect(tree[0]?.wordCount).toBe(14); // 12 Han chars + 2 EN words
    expect(tree[1]?.wordCount).toBe(4);
  });
});
