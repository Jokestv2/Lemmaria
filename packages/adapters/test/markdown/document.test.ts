import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../../src/markdown/document.js";

const reader = (files: Record<string, string>) => ({
  readFile: (p: string) => {
    const c = files[p];
    if (c === undefined) return Promise.reject(new Error(`no file: ${p}`));
    return Promise.resolve(c);
  },
});

const DOC = `---
title: Draft
bibliography: refs.bib
---

# Introduction

Some prose with $x^2$ math.

\`\`\`python
# not a heading
print("hi")
\`\`\`

## Motivation

More prose.
`;

describe("MarkdownDocument", () => {
  it("extracts frontmatter with a scalar bibliography", async () => {
    const doc = await MarkdownDocument.load(reader({ "d.md": DOC }), "d.md");
    expect(doc.frontmatter?.bibliography).toEqual(["refs.bib"]);
  });

  it("extracts a list-form bibliography", async () => {
    const md = "---\nbibliography:\n  - a.bib\n  - b.bib\n---\nBody.\n";
    const doc = await MarkdownDocument.load(reader({ "d.md": md }), "d.md");
    expect(doc.frontmatter?.bibliography).toEqual(["a.bib", "b.bib"]);
  });

  it("maps fenced code blocks and flags an unclosed fence", async () => {
    const doc = await MarkdownDocument.load(reader({ "d.md": DOC }), "d.md");
    expect(doc.fences).toHaveLength(1);
    expect(doc.fences[0]?.unclosed).toBe(false);
    const open = "Text\n\n```js\nlet x = 1;\n";
    const doc2 = await MarkdownDocument.load(reader({ "d.md": open }), "d.md");
    expect(doc2.fences[0]?.unclosed).toBe(true);
  });

  it("finds ATX headings but not '#' inside fences or frontmatter", async () => {
    const doc = await MarkdownDocument.load(reader({ "d.md": DOC }), "d.md");
    expect(doc.headings.map((h) => [h.level, h.title])).toEqual([
      [1, "Introduction"],
      [2, "Motivation"],
    ]);
  });

  it("offset/line helpers round-trip", async () => {
    const doc = await MarkdownDocument.load(reader({ "d.md": DOC }), "d.md");
    const intro = doc.headings[0];
    if (!intro) throw new Error("missing heading");
    expect(doc.text.slice(intro.offset).startsWith("# Introduction")).toBe(
      true,
    );
    expect(doc.lineOf(intro.offset)).toBe(intro.line);
    expect(doc.offsetOf(intro.line)).toBe(intro.offset);
  });
});
