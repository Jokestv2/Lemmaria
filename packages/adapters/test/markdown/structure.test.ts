import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../../src/markdown/document.js";
import { buildMarkdownStructure } from "../../src/markdown/structure.js";

const reader = (md: string) => ({
  readFile: () => Promise.resolve(md),
});

const DOC = `# Introduction

Prose citing [@smith2020] and [@doe2021; @roe2022].

\`\`\`python
ignored_words = "not counted [@fake]"
\`\`\`

## Motivation

Bare cite @smith2020 again.

# Method

Final section prose.
`;

describe("buildMarkdownStructure", () => {
  it("nests headings by level with line ranges", async () => {
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const tree = buildMarkdownStructure(doc);
    expect(tree.map((n) => n.title)).toEqual(["Introduction", "Method"]);
    expect(tree[0]?.children.map((n) => n.title)).toEqual(["Motivation"]);
    expect(tree[0]?.startLine).toBe(1);
    expect(tree[0]?.endLine).toBe(12); // ends before "# Method" on line 13
    expect(tree[1]?.file).toBe("d.md");
  });

  it("collects pandoc citations per section, outside fences", async () => {
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const tree = buildMarkdownStructure(doc);
    expect(tree[0]?.citations).toEqual(["smith2020", "doe2021", "roe2022"]);
    expect(tree[0]?.children[0]?.citations).toEqual(["smith2020"]);
    expect(tree[1]?.citations).toEqual([]);
  });

  it("word counts exclude fenced code and the heading line; labels are empty", async () => {
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const tree = buildMarkdownStructure(doc);
    const intro = tree[0];
    expect(intro?.labels).toEqual([]);
    // "Prose citing [@smith2020] and [@doe2021; @roe2022]." — fence excluded.
    expect(intro?.wordCount).toBeGreaterThan(0);
    expect(intro?.wordCount).toBeLessThan(12);
  });
});
