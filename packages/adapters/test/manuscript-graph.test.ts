import { describe, expect, it } from "vitest";
import { manuscriptGraphFor } from "../src/manuscript-graph.js";
import { memReader } from "./latex/helpers.js";

/**
 * The `ManuscriptGraphReader` the hosts wire (X5 O8, ADR 0074 §4).
 *
 * What it must get right is READING ORDER — the order a person reads the
 * paper — because that order is what the panel's brief hands each reviewer and
 * what decides which files a concern may be quoted from at all.
 */

/** The reader the port is given: the panel's own workspace read. */
function read(files: Record<string, string>) {
  const reader = memReader(files);
  return (relPath: string) => reader.readFile(relPath);
}

describe("manuscriptGraphFor — LaTeX", () => {
  it("returns reading order through a NESTED input, not the loader's BFS order", async () => {
    // `defs` is reached from inside `intro`, so BFS puts it after `method`
    // while a reader meets it second. Reading order is the one that matters.
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": [
          "\\documentclass{article}",
          "\\begin{document}",
          "\\input{sections/intro}",
          "\\input{sections/method}",
          "\\bibliography{refs}",
          "\\end{document}",
          "",
        ].join("\n"),
        "sections/intro.tex": "Intro prose.\n\\input{sections/defs}\n",
        "sections/defs.tex": "Some definitions.\n",
        "sections/method.tex": "Method prose.\n",
        "refs.bib": "@article{a, title={A}}\n",
      }),
    );
    expect(graph?.files).toEqual([
      "main.tex",
      "sections/intro.tex",
      "sections/defs.tex",
      "sections/method.tex",
      "refs.bib",
    ]);
    expect(graph?.missing).toEqual([]);
  });

  it("includes a file that contributes no AST node — empty, or only comments", async () => {
    // The one file `flatten()` structurally cannot see. It is a real file of
    // the manuscript and a reviewer may be given it.
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": "\\input{sections/blank}\n\\input{sections/after}\n",
        "sections/blank.tex": "% nothing but a comment\n",
        "sections/after.tex": "After.\n",
      }),
    );
    expect(graph?.files).toContain("sections/blank.tex");
    expect(graph?.files).toEqual([
      "main.tex",
      "sections/blank.tex",
      "sections/after.tex",
    ]);
  });

  it("ignores a COMMENTED-OUT input — it is in neither files nor missing", async () => {
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": "%\\input{ghost}\n\\input{sections/real}\n",
        "sections/real.tex": "Real.\n",
      }),
    );
    expect(graph?.files).toEqual(["main.tex", "sections/real.tex"]);
    expect(graph?.missing).toEqual([]);
  });

  it("reports a declared target that cannot be read, rather than throwing", async () => {
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": "\\input{sections/gone}\n\\input{sections/here}\n",
        "sections/here.tex": "Here.\n",
      }),
    );
    expect(graph?.files).toEqual(["main.tex", "sections/here.tex"]);
    expect(graph?.missing).toEqual(["sections/gone.tex"]);
  });

  it("reports a missing bibliography too", async () => {
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({ "main.tex": "\\bibliography{nowhere}\n" }),
    );
    expect(graph?.files).toEqual(["main.tex"]);
    expect(graph?.missing).toEqual(["nowhere.bib"]);
  });

  it("terminates on a cycle", async () => {
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": "\\input{a}\n",
        "a.tex": "A.\n\\input{b}\n",
        "b.tex": "B.\n\\input{a}\n",
      }),
    );
    expect(graph?.files).toEqual(["main.tex", "a.tex", "b.tex"]);
  });

  it("resolves every hop against the ENTRY's directory, which is TeX's own rule", async () => {
    // `\input{sections/defs}` written INSIDE `sections/intro.tex` resolves to
    // `sections/defs.tex`, not `sections/sections/defs.tex`: TeX resolves
    // against the directory the compile runs in, never the including file.
    const graph = await manuscriptGraphFor(
      "paper/main.tex",
      read({
        "paper/main.tex": "\\input{sections/intro}\n",
        "paper/sections/intro.tex": "Intro.\n\\input{sections/defs}\n",
        "paper/sections/defs.tex": "Defs.\n",
      }),
    );
    expect(graph?.files).toEqual([
      "paper/main.tex",
      "paper/sections/intro.tex",
      "paper/sections/defs.tex",
    ]);
  });

  it("puts bibliographies last, after every prose file", async () => {
    const graph = await manuscriptGraphFor(
      "main.tex",
      read({
        "main.tex": "\\addbibresource{refs.bib}\n\\input{tail}\n",
        "tail.tex": "Tail.\n",
        "refs.bib": "@book{b, title={B}}\n",
      }),
    );
    expect(graph?.files).toEqual(["main.tex", "tail.tex", "refs.bib"]);
  });
});

describe("manuscriptGraphFor — Markdown and the uncovered case", () => {
  it("reads a Markdown entry plus its front-matter bibliography, scalar form", async () => {
    const graph = await manuscriptGraphFor(
      "draft.md",
      read({
        "draft.md": "---\nbibliography: refs.bib\n---\n\n# Draft\n",
        "refs.bib": "@article{a, title={A}}\n",
      }),
    );
    expect(graph?.files).toEqual(["draft.md", "refs.bib"]);
    expect(graph?.missing).toEqual([]);
  });

  it("reads the sequence form too, and resolves against the entry's directory", async () => {
    const graph = await manuscriptGraphFor(
      "paper/draft.md",
      read({
        "paper/draft.md":
          "---\nbibliography:\n  - refs.bib\n  - more.bib\n---\n\n# Draft\n",
        "paper/refs.bib": "@article{a, title={A}}\n",
        "paper/more.bib": "@book{b, title={B}}\n",
      }),
    );
    expect(graph?.files).toEqual([
      "paper/draft.md",
      "paper/refs.bib",
      "paper/more.bib",
    ]);
  });

  it("reports a Markdown bibliography that does not read", async () => {
    const graph = await manuscriptGraphFor(
      "draft.md",
      read({ "draft.md": "---\nbibliography: gone.bib\n---\n\n# Draft\n" }),
    );
    expect(graph?.files).toEqual(["draft.md"]);
    expect(graph?.missing).toEqual(["gone.bib"]);
  });

  it("answers undefined for an extension no adapter covers — never a guess", async () => {
    expect(
      await manuscriptGraphFor("notes.txt", read({ "notes.txt": "hello" })),
    ).toBeUndefined();
  });

  it("answers undefined rather than throwing when the entry cannot be read", async () => {
    // A `.tex` entry that does not exist is not a graph the harness can use;
    // the driver's own no-manuscript precondition is what speaks to it.
    expect(await manuscriptGraphFor("main.tex", read({}))).toBeUndefined();
  });
});
