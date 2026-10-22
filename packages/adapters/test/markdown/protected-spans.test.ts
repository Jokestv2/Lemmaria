import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../../src/markdown/document.js";
import { collectMarkdownProtectedSpans } from "../../src/markdown/protected-spans.js";
import { resolveMarkdownSelection } from "../../src/markdown/selection.js";

const reader = (md: string) => ({ readFile: () => Promise.resolve(md) });

describe("collectMarkdownProtectedSpans", () => {
  it("collects every protected kind with exact raw text", async () => {
    const DOC = [
      "# A Heading",
      "",
      "Prose with $x^2$ inline and `code span` plus [a link](https://x.test)",
      "and a cite [@smith2020] and bare @doe2021 and <!-- a comment -->.",
      "",
      "$$\\sum_i x_i$$",
      "",
    ].join("\n");
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const unit = resolveMarkdownSelection(
      doc,
      { file: "d.md", startOffset: 0, endOffset: 0 },
      "document",
    );
    const spans = collectMarkdownProtectedSpans(doc, unit);
    const byRaw = new Map(spans.map((s) => [s.raw, s.kind]));
    expect(byRaw.get("# A Heading")).toBe("markup");
    expect(byRaw.get("$x^2$")).toBe("math");
    expect(byRaw.get("`code span`")).toBe("code");
    expect(byRaw.get("[a link](https://x.test)")).toBe("markup");
    expect(byRaw.get("[@smith2020]")).toBe("cite");
    expect(byRaw.get("@doe2021")).toBe("cite");
    expect(byRaw.get("<!-- a comment -->")).toBe("comment");
    expect(byRaw.get("$$\\sum_i x_i$$")).toBe("math");
    // Tokens are unique and document-ordered; offsets match the raw.
    for (const s of spans) {
      expect(DOC.slice(s.startOffset, s.endOffset)).toBe(s.raw);
    }
    expect(new Set(spans.map((s) => s.token)).size).toBe(spans.length);
  });

  it("does not double-collect inside fences or frontmatter", async () => {
    const DOC = [
      "---",
      "title: X",
      "---",
      "",
      "```js",
      "let a = `tpl` + '$x$'; // [@fake]",
      "```",
      "",
      "Real $y$ here.",
      "",
    ].join("\n");
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const unit = resolveMarkdownSelection(
      doc,
      { file: "d.md", startOffset: 0, endOffset: 0 },
      "document",
    );
    const spans = collectMarkdownProtectedSpans(doc, unit);
    // The whole frontmatter and the whole fence are single spans…
    expect(spans.filter((s) => s.kind === "code")).toHaveLength(1);
    expect(spans.some((s) => s.raw.startsWith("---"))).toBe(true);
    // …and nothing inside them is collected separately.
    expect(spans.some((s) => s.raw === "[@fake]")).toBe(false);
    expect(spans.some((s) => s.raw === "$x$")).toBe(false);
    // Real math outside the fence is still found.
    expect(spans.some((s) => s.raw === "$y$" && s.kind === "math")).toBe(true);
  });

  it("only collects spans inside the unit", async () => {
    const DOC = "# H\n\nFirst $a$ here.\n\nSecond $b$ there.\n";
    const doc = await MarkdownDocument.load(reader(DOC), "d.md");
    const cursor = DOC.indexOf("First");
    const unit = resolveMarkdownSelection(
      doc,
      { file: "d.md", startOffset: cursor, endOffset: cursor },
      "paragraph",
    );
    const spans = collectMarkdownProtectedSpans(doc, unit);
    expect(spans.map((s) => s.raw)).toEqual(["$a$"]);
  });
});

/**
 * X3 (ADR 0036), the Markdown face of the same defect. A heading is a CONTAINER
 * — `##` is protected, its text is free — but the collector accepts candidates
 * in priority order and drops any that overlaps one already accepted. Inline
 * math is scanned before headings, so `## Results for $x^2$` dropped the
 * HEADING and kept only the formula: the `##` was unprotected, and a rewrite
 * could turn a section title into a sentence with no refusal.
 */
describe("collectMarkdownProtectedSpans — nesting (X3, ADR 0036)", () => {
  const spansFor = async (
    md: string,
    opts?: { nested?: boolean },
  ): Promise<Array<[string, string]>> => {
    const doc = await MarkdownDocument.load(reader(md), "d.md");
    const unit = resolveMarkdownSelection(
      doc,
      { file: "d.md", startOffset: 0, endOffset: 0 },
      "document",
    );
    return collectMarkdownProtectedSpans(doc, unit, opts).map((s) => [
      s.kind,
      s.raw,
    ]);
  };

  it("keeps the heading container alongside a formula nested in it", async () => {
    const DOC = "## Results for $x^2$ here\n\nBody.\n";
    expect(await spansFor(DOC, { nested: true })).toEqual([
      ["markup", "## Results for $x^2$ here"],
      ["math", "$x^2$"],
    ]);
  });

  it("is OFF by default — today's freeze view, formula only", async () => {
    const DOC = "## Results for $x^2$ here\n\nBody.\n";
    expect(await spansFor(DOC)).toEqual([["math", "$x^2$"]]);
  });

  it("leaves a plain heading exactly as it was", async () => {
    const DOC = "## Plain heading\n\nBody.\n";
    expect(await spansFor(DOC, { nested: true })).toEqual([
      ["markup", "## Plain heading"],
    ]);
  });

  it("surfaces nothing inside an OPAQUE span, fence or otherwise", async () => {
    const DOC = ["```js", "let a = '$x$'; // [@fake]", "```", ""].join("\n");
    const kinds = (await spansFor(DOC, { nested: true })).map(([k]) => k);
    expect(kinds).toEqual(["code"]);
  });
});
