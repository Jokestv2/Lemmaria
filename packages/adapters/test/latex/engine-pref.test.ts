import { describe, expect, it } from "vitest";
import { LatexAdapter } from "../../src/index.js";
import { fixtureReader } from "./helpers.js";

describe("LatexAdapter.preferredEngines", () => {
  it("routes a CJK (ctex) project to xelatex then lualatex", async () => {
    const adapter = await LatexAdapter.load(
      fixtureReader("ctex-zh"),
      "main.tex",
    );
    expect(adapter.preferredEngines()).toEqual(["xelatex", "lualatex"]);
  });

  it("routes a plain English project to pdflatex", async () => {
    const adapter = await LatexAdapter.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    expect(adapter.preferredEngines()).toEqual(["pdflatex"]);
  });
});
