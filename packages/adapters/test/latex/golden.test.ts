import { describe, expect, it } from "vitest";
import { LatexAdapter } from "../../src/index.js";
import { fixtureReader } from "./helpers.js";

const PROJECTS = ["simple-en", "ctex-zh", "multifile"] as const;

describe.each(PROJECTS)("golden: %s", (name) => {
  it("structure tree matches the golden file", async () => {
    const adapter = await LatexAdapter.load(fixtureReader(name), "main.tex");
    const tree = await adapter.parseStructure();
    await expect(JSON.stringify(tree, null, 2)).toMatchFileSnapshot(
      `./golden/${name}.structure.json`,
    );
  });

  it("protected spans of every top-level section match the golden file", async () => {
    const adapter = await LatexAdapter.load(fixtureReader(name), "main.tex");
    const tree = await adapter.parseStructure();
    const spans = tree.map((section) => {
      const src = adapter.project.file(section.file).source;
      const offset = src
        .split("\n")
        .slice(0, section.startLine - 1)
        .join("\n").length;
      const unit = adapter.resolveSelection(
        { file: section.file, startOffset: offset + 1, endOffset: offset + 1 },
        "section",
      );
      return { section: section.title, spans: adapter.protectedSpans(unit) };
    });
    await expect(JSON.stringify(spans, null, 2)).toMatchFileSnapshot(
      `./golden/${name}.protected-spans.json`,
    );
  });

  it("applyEdit identity round-trips every file byte-for-byte (M2 acceptance)", async () => {
    const adapter = await LatexAdapter.load(fixtureReader(name), "main.tex");
    for (const [path, file] of adapter.project.files) {
      const unit = adapter.resolveSelection(
        { file: path, startOffset: 0, endOffset: file.source.length },
        "document",
      );
      expect(adapter.applyEdit(unit, unit.text).newText).toBe(file.source);
    }
  });
});
