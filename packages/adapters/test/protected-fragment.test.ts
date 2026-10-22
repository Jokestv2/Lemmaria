import { describe, expect, it } from "vitest";
import { protectedSpansIn } from "../src/protected-fragment.js";

/**
 * D1 (ADR 0032): the stateless fragment detector the agentic path uses on BOTH
 * sides — `read_span` marks with it, `propose_edit` enforces with it. It parses
 * the text it is handed and nothing else, so a read and a later write can never
 * disagree and nothing goes stale between a proposal and its apply.
 */

describe("protectedSpansIn — latex", () => {
  it("finds a comment, inline math and a citation in a bare fragment", async () => {
    const text = [
      "The result is significant. % TODO: double-check this",
      "We observe $O(n^2)$ growth, following \\cite{he2015}.",
    ].join("\n");
    const spans = await protectedSpansIn("latex", text);
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain("comment");
    expect(kinds).toContain("math");
    expect(kinds).toContain("cite");
    // `raw` is the exact source text — that is what the write-side rule counts.
    expect(spans.find((s) => s.kind === "math")?.raw).toBe("$O(n^2)$");
    expect(spans.find((s) => s.kind === "cite")?.raw).toBe("\\cite{he2015}");
    expect(spans.find((s) => s.kind === "comment")?.raw).toContain(
      "% TODO: double-check this",
    );
  });

  it("reports offsets relative to the fragment, not to any file", async () => {
    const text = "Prose before $x$ prose after.";
    const spans = await protectedSpansIn("latex", text);
    const math = spans.find((s) => s.kind === "math");
    expect(math).toBeDefined();
    expect(text.slice(math?.startOffset, math?.endOffset)).toBe("$x$");
  });

  it("returns [] for a fragment with no protected content", async () => {
    expect(
      await protectedSpansIn("latex", "Just ordinary prose here."),
    ).toEqual([]);
  });

  it("resolves a fragment whose \\input and \\bibliography targets do not exist", async () => {
    const text = "\\input{missing-section}\n\\bibliography{nope}\nProse.";
    await expect(protectedSpansIn("latex", text)).resolves.toBeInstanceOf(
      Array,
    );
  });

  it("never throws on an unparseable fragment", async () => {
    // A fragment cut mid-construct is the ordinary case for an anchor.
    await expect(
      protectedSpansIn("latex", "\\begin{itemize} \\item one"),
    ).resolves.toBeInstanceOf(Array);
  });
});

/**
 * X3 (ADR 0036): the four under-protections measured against the shipped code
 * on 2026-08-13, each of which passed `propose_edit` with no refusal at all.
 * The agentic reader is the ONLY caller that turns nesting on — the freeze path
 * keeps the outermost-only view, asserted below.
 */
describe("protectedSpansIn — nested spans (X3, ADR 0036)", () => {
  const raws = async (text: string): Promise<string[]> =>
    (await protectedSpansIn("latex", text)).map((s) => s.raw);

  it("surfaces a formula nested inside \\textbf{}", async () => {
    expect(await raws("The \\textbf{value $x^2$ here} matters.")).toEqual([
      "\\textbf{value $x^2$ here}",
      "$x^2$",
    ]);
  });

  it("surfaces a citation nested inside \\footnote{}", async () => {
    expect(
      await raws("Text\\footnote{See \\cite{smith2020} for more.} continues."),
    ).toEqual([
      "\\footnote{See \\cite{smith2020} for more.}",
      "\\cite{smith2020}",
    ]);
  });

  it("surfaces a \\label{} nested inside \\section{}", async () => {
    expect(await raws("\\section{The \\label{sec:x} bit}")).toEqual([
      "\\section{The \\label{sec:x} bit}",
      "\\label{sec:x}",
    ]);
  });

  it("surfaces the inner command of a nested markup pair, balanced", async () => {
    // Pre-X3 this was ONE span whose raw was the unbalanced
    // `\textbf{\emph{measurement decision}` — the string that made the declared
    // removal look like a typo, and so unreachable.
    expect(
      await raws("A \\textbf{\\emph{measurement decision}} matters."),
    ).toEqual([
      "\\textbf{\\emph{measurement decision}}",
      "\\emph{measurement decision}",
    ]);
  });

  it("keeps every span's raw an exact slice of the text it was given", async () => {
    const text = "A \\textbf{a \\emph{b $c$}} and \\cite{x} d.";
    for (const s of await protectedSpansIn("latex", text)) {
      expect(text.slice(s.startOffset, s.endOffset)).toBe(s.raw);
    }
  });

  /**
   * The property that catches this whole defect class in ONE assertion, in
   * both directions. X3's own first cut failed it the other way round from the
   * bug it was fixing: measuring `[`/`]` depth alongside braces made
   * `\footnote{\textbf{range $[0,1)$}}` record the inner span as
   * `\textbf{range $[0,1)$}}`, swallowing the footnote's brace.
   *
   * Only macro-derived kinds — a `comment` or a `$…$` may legitimately hold an
   * unmatched brace, and neither comes from `macroFullSpan`.
   */
  it("records a BALANCED raw for every macro-derived span", async () => {
    const MACRO_KINDS = new Set(["markup", "macro", "cite", "ref"]);
    const fixtures = [
      "A \\textbf{\\emph{measurement decision}} matters.",
      "A \\footnote{\\textbf{range $[0,1)$}} done",
      "A \\footnote{\\textbf{on the interval [0,1}} done",
      "A \\textbf{a \\emph{b \\texttt{c}}} d",
      "A \\textbf{50\\% of \\emph{runs}} ok",
      "\\section{The \\label{sec:x} bit}",
      "Text\\footnote{See \\cite{smith2020} for more.} continues.",
      "\\caption{A figure.\\label{fig:x}}",
      "\\textbf{a [b] c} and \\textbf{d}",
    ];
    for (const text of fixtures) {
      for (const s of await protectedSpansIn("latex", text)) {
        if (!MACRO_KINDS.has(s.kind)) continue;
        let depth = 0;
        for (let i = 0; i < s.raw.length; i += 1) {
          const c = s.raw.charAt(i);
          if (c === "\\") i += 1;
          else if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
        }
        expect({ text, raw: s.raw, depth }).toEqual({
          text,
          raw: s.raw,
          depth: 0,
        });
      }
    }
  });
});

describe("protectedSpansIn — markdown", () => {
  it("finds a fenced block, inline math and a pandoc citation", async () => {
    const text = [
      "Some prose with $\\alpha$ inline, per [@smith2020].",
      "",
      "```python",
      "print('hi')",
      "```",
    ].join("\n");
    const spans = await protectedSpansIn("markdown", text);
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain("code");
    expect(kinds).toContain("math");
    expect(kinds).toContain("cite");
    expect(spans.find((s) => s.kind === "math")?.raw).toBe("$\\alpha$");
    expect(spans.find((s) => s.kind === "cite")?.raw).toBe("[@smith2020]");
  });

  it("returns [] for plain Markdown prose", async () => {
    expect(
      await protectedSpansIn("markdown", "Just a plain sentence."),
    ).toEqual([]);
  });
});

describe("protectedSpansIn — bilingual (invariant 6)", () => {
  it("finds the same constructs in Chinese prose", async () => {
    const text = "准确率为 $94.7\\%$，见 \\cite{he2015}。% 待核对";
    const spans = await protectedSpansIn("latex", text);
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain("math");
    expect(kinds).toContain("cite");
    expect(kinds).toContain("comment");
  });
});
