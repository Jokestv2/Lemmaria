import { describe, expect, it } from "vitest";
import { loadMarkdownAdapter } from "../../src/markdown/adapter.js";

const reader = (files: Record<string, string>) => ({
  readFile: (p: string) => {
    const c = files[p];
    if (c === undefined) return Promise.reject(new Error(`no file: ${p}`));
    return Promise.resolve(c);
  },
});

const DOC = `---
bibliography: refs.bib
---

# Introduction

Attention is useful [@smith2020], with $O(n^2)$ cost.

## 方法

注意力机制的中文段落。

`;

const REFS = `@article{smith2020,
  title = {A Study},
  year = {2020},
}
@article{orphan2021,
  title = {Uncited},
}
`;

describe("MarkdownAdapter (DocumentAdapter surface)", () => {
  const load = () =>
    loadMarkdownAdapter(
      reader({ "draft.md": DOC, "refs.bib": REFS }),
      "draft.md",
    );

  it("kind, structure, and countWords (bilingual, invariant 6)", async () => {
    const adapter = await load();
    expect(adapter.kind).toBe("markdown");
    const tree = await adapter.parseStructure();
    expect(tree.map((n) => n.title)).toEqual(["Introduction"]);
    expect(tree[0]?.children.map((n) => n.title)).toEqual(["方法"]);
    expect(adapter.countWords("one two three").unit).toBe("words");
    expect(adapter.countWords("注意力机制").unit).toBe("字");
  });

  it("citations() reads the frontmatter bibliography; citedKeys sees pandoc cites", async () => {
    const adapter = await load();
    const entries = await adapter.citations();
    expect(entries.map((e) => e.key).sort()).toEqual([
      "orphan2021",
      "smith2020",
    ]);
    expect(adapter.citedKeys()).toEqual(["smith2020"]);
    expect(adapter.bibEntries()[0]?.file).toBe("refs.bib");
  });

  it("applyEdit splices by offset and round-trips identity", async () => {
    const adapter = await load();
    const cursor = DOC.indexOf("Attention is useful");
    const unit = adapter.resolveSelection(
      { file: "draft.md", startOffset: cursor, endOffset: cursor },
      "paragraph",
    );
    // identity: replacement === original ⇒ byte-identical document
    expect(adapter.applyEdit(unit, unit.text).newText).toBe(DOC);
    // real edit splices exactly the unit span
    const edited = adapter.applyEdit(unit, "Rewritten. ⟦stays⟧");
    expect(edited.newText).toContain("Rewritten. ⟦stays⟧");
    expect(edited.newText).toContain("## 方法");
  });

  it("applyEdit refuses a stale unit (content anchor mismatch)", async () => {
    const adapter = await load();
    const cursor = DOC.indexOf("Attention is useful");
    const unit = adapter.resolveSelection(
      { file: "draft.md", startOffset: cursor, endOffset: cursor },
      "paragraph",
    );
    expect(() =>
      adapter.applyEdit({ ...unit, text: "something else" }, "x"),
    ).toThrow(/match|stale|anchor/i);
  });
});
