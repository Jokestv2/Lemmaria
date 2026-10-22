import { describe, expect, it } from "vitest";
import { LatexProject } from "../../src/latex/project.js";
import { fixtureReader, memReader } from "./helpers.js";

describe("LatexProject.load", () => {
  it("loads the entry file and everything it \\input's", async () => {
    const project = await LatexProject.load(
      fixtureReader("multifile"),
      "main.tex",
    );
    expect([...project.files.keys()].sort()).toEqual([
      "main.tex",
      "sections/intro.tex",
      "sections/method.tex",
    ]);
    expect(project.missingInputs).toEqual([]);
  });

  it("appends .tex when the \\input path has no extension", async () => {
    const project = await LatexProject.load(
      memReader({ "main.tex": "\\input{ch1}", "ch1.tex": "Hello" }),
      "main.tex",
    );
    expect(project.files.has("ch1.tex")).toBe(true);
  });

  it("records missing inputs instead of failing the load", async () => {
    const project = await LatexProject.load(
      memReader({ "main.tex": "\\input{ghost}" }),
      "main.tex",
    );
    expect(project.missingInputs).toEqual(["ghost.tex"]);
  });

  it("survives \\input cycles", async () => {
    const project = await LatexProject.load(
      memReader({ "a.tex": "\\input{b}", "b.tex": "\\input{a}" }),
      "a.tex",
    );
    expect(project.files.size).toBe(2);
  });

  it("discovers \\newcommand signatures and attaches their args", async () => {
    const project = await LatexProject.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    expect(project.newcommands).toContainEqual({
      name: "ourmethod",
      signature: "",
    });
  });

  it("attaches natbib-style cite args project-wide", async () => {
    const project = await LatexProject.load(
      memReader({ "main.tex": "\\citep[p.~5]{key1, key2}" }),
      "main.tex",
    );
    let citepArgs = 0;
    const { walkAll } = await import("../../src/latex/walk.js");
    walkAll(project.file("main.tex").ast.content, (n) => {
      if (n.type === "macro" && n.content === "citep")
        citepArgs = (n.args ?? []).length;
    });
    expect(citepArgs).toBeGreaterThan(0);
  });

  it("resolves \\input relative to the entry file's directory (paper in a subfolder)", async () => {
    const project = await LatexProject.load(
      memReader({
        "paper/main.tex": "\\input{ch1}",
        "paper/ch1.tex": "Hello",
      }),
      "paper/main.tex",
    );
    expect(project.files.has("paper/ch1.tex")).toBe(true);
    expect(project.missingInputs).toEqual([]);
  });

  it("resolves \\bibliography relative to the entry file's directory (paper in a subfolder)", async () => {
    const project = await LatexProject.load(
      memReader({
        "paper/main.tex": "\\cite{a}\\bibliography{refs}",
        "paper/refs.bib": "@article{a, title = {T}, year = {2020}}",
      }),
      "paper/main.tex",
    );
    expect(project.bibliographies.map((b) => b.path)).toEqual([
      "paper/refs.bib",
    ]);
    expect(project.bibliographies[0]?.entries.map((e) => e.key)).toEqual(["a"]);
    expect(project.missingBibs).toEqual([]);
  });

  it("flatten() splices \\input content in document order with per-file attribution", async () => {
    const project = await LatexProject.load(
      fixtureReader("multifile"),
      "main.tex",
    );
    const headings = project
      .flatten()
      .filter((i) => i.node.type === "macro" && i.node.content === "section");
    expect(headings.map((h) => h.file)).toEqual([
      "main.tex",
      "sections/intro.tex",
      "sections/method.tex",
    ]);
  });

  it("readingOrder() is document order, the entry first (X5 O8)", async () => {
    const project = await LatexProject.load(
      fixtureReader("multifile"),
      "main.tex",
    );
    expect(project.readingOrder()).toEqual([
      "main.tex",
      "sections/intro.tex",
      "sections/method.tex",
    ]);
    // Every file of the project is in it, exactly once — the list the panel's
    // brief hands a reviewer may not quietly omit a file it will then be
    // allowed to quote from.
    expect(new Set(project.readingOrder()).size).toBe(
      project.readingOrder().length,
    );
    for (const path of project.files.keys()) {
      expect(project.readingOrder()).toContain(path);
    }
  });
});
