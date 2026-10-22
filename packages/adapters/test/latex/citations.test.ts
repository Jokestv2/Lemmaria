import { describe, expect, it } from "vitest";
import { loadLatexAdapter } from "../../src/index.js";
import { memReader } from "./helpers.js";

const MAIN = `\\documentclass{article}
\\begin{document}
Neural nets~\\cite{smith2020} and transformers~\\citep{vaswani2017}.
\\bibliography{refs}
\\end{document}`;

const REFS = `@article{smith2020, title = {Deep Nets}, author = {Smith, J.}, year = {2020}}
@inproceedings{vaswani2017, title = {Attention Is All You Need}, year = {2017}}
@article{orphan1, title = {Never Cited}, year = {2019}}`;

describe("LatexAdapter citations", () => {
  it("extracts bib entries and cited keys across the project", async () => {
    const adapter = await loadLatexAdapter(
      memReader({ "main.tex": MAIN, "refs.bib": REFS }),
      "main.tex",
    );
    const cites = await adapter.citations();
    expect(cites.map((c) => c.key).sort()).toEqual([
      "orphan1",
      "smith2020",
      "vaswani2017",
    ]);
    expect(cites.find((c) => c.key === "smith2020")?.fields.year).toBe("2020");
    expect(adapter.citedKeys().sort()).toEqual(["smith2020", "vaswani2017"]);
    expect(adapter.bibEntries().find((e) => e.key === "smith2020")?.file).toBe(
      "refs.bib",
    );
  });

  it("returns no entries when the project has no .bib", async () => {
    const adapter = await loadLatexAdapter(
      memReader({
        "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}",
      }),
      "main.tex",
    );
    expect(await adapter.citations()).toEqual([]);
    expect(adapter.bibEntries()).toEqual([]);
  });

  it("supports \\addbibresource with an explicit .bib", async () => {
    const main = `\\documentclass{article}
\\addbibresource{lib.bib}
\\begin{document}\\cite{a}\\end{document}`;
    const adapter = await loadLatexAdapter(
      memReader({ "main.tex": main, "lib.bib": "@article{a, title={A}}" }),
      "main.tex",
    );
    expect((await adapter.citations()).map((c) => c.key)).toEqual(["a"]);
  });
});
