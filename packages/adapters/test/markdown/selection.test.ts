import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../../src/markdown/document.js";
import { resolveMarkdownSelection } from "../../src/markdown/selection.js";

const reader = (md: string) => ({ readFile: () => Promise.resolve(md) });

const DOC = `# Introduction

First paragraph of prose
spanning two lines.

Second paragraph.

\`\`\`python
code line one
code line two
\`\`\`

# Method

Method prose.
`;

async function load() {
  return MarkdownDocument.load(reader(DOC), "d.md");
}
const at = (offset: number) => ({
  file: "d.md",
  startOffset: offset,
  endOffset: offset,
});

describe("resolveMarkdownSelection", () => {
  it("paragraph = blank-line-delimited block", async () => {
    const doc = await load();
    const cursor = DOC.indexOf("spanning");
    const unit = resolveMarkdownSelection(doc, at(cursor), "paragraph");
    expect(unit.text).toBe("First paragraph of prose\nspanning two lines.");
    expect(DOC.slice(unit.span.startOffset, unit.span.endOffset)).toBe(
      unit.text,
    );
  });

  it("a fenced block is ONE paragraph and never merges with prose", async () => {
    const doc = await load();
    const cursor = DOC.indexOf("code line one");
    const unit = resolveMarkdownSelection(doc, at(cursor), "paragraph");
    expect(unit.text).toBe("```python\ncode line one\ncode line two\n```");
  });

  it("environment = the enclosing fence, else the paragraph", async () => {
    const doc = await load();
    const inFence = resolveMarkdownSelection(
      doc,
      at(DOC.indexOf("code line two")),
      "environment",
    );
    expect(inFence.text).toContain("```python");
    const outside = resolveMarkdownSelection(
      doc,
      at(DOC.indexOf("Second")),
      "environment",
    );
    expect(outside.text).toBe("Second paragraph.");
  });

  it("section = the enclosing heading section; document = whole file", async () => {
    const doc = await load();
    const section = resolveMarkdownSelection(
      doc,
      at(DOC.indexOf("Second")),
      "section",
    );
    expect(section.text.startsWith("# Introduction")).toBe(true);
    expect(section.text).not.toContain("# Method");
    const whole = resolveMarkdownSelection(doc, at(0), "document");
    expect(whole.text).toBe(DOC);
  });

  it("selection scope returns the span verbatim", async () => {
    const doc = await load();
    const start = DOC.indexOf("Second");
    const unit = resolveMarkdownSelection(
      doc,
      { file: "d.md", startOffset: start, endOffset: start + 6 },
      "selection",
    );
    expect(unit.text).toBe("Second");
  });
});
