import { describe, expect, it, vi } from "vitest";
import {
  type Span,
  agentMessage,
  blocks,
  inlineNodes,
  scanOpaque,
} from "../src/webview/parts/markdown.js";

/**
 * D3 / CHAT-2 — the Markdown subset renderer.
 *
 * This file is the milestone's gate. It is organised the way the renderer is
 * layered: the opaque-region scanner (T1), the inline pass (T2), the block
 * pass (T3), then the delta-by-delta sweeps (T4) and the assembled message
 * (T5).
 */

/** The source text of every span the scanner marked opaque. */
const opaque = (source: string): string[] =>
  scanOpaque(source)
    .filter((s: Span) => s.kind !== "text")
    .map((s: Span) => s.text);

/** The inline pass' output, in a container so it can be queried. */
const inline = (source: string): HTMLElement => {
  const host = document.createElement("div");
  for (const node of inlineNodes(source)) host.append(node);
  return host;
};

/** The block pass' output, in a container so it can be queried. */
const block = (source: string): HTMLElement => {
  const host = document.createElement("div");
  for (const node of blocks(source)) host.append(node);
  return host;
};

/** Everything the scanner left for the Markdown passes to look at. */
const scannable = (source: string): string =>
  scanOpaque(source)
    .filter((s: Span) => s.kind === "text")
    .map((s: Span) => s.text)
    .join("");

describe("scanOpaque — the round-trip property (D3-3)", () => {
  // The whole safety argument of the design rests on this one property: an
  // opaque span is emitted verbatim, so a FALSE POSITIVE costs formatting and
  // never a character. If concatenating the spans does not reproduce the
  // source byte for byte, the scanner can corrupt text and every other
  // assertion in this file is worth less.
  const sources = [
    "",
    "plain prose with no markers at all",
    "$\\alpha$",
    "$x_1$ and $y_2$",
    "$$\\sum_{i=0}^n x_i$$",
    "\\cite{knuth1984}",
    "\\emph{a *b* c}",
    "\\begin{equation}\nE = mc^2\n\\end{equation}",
    "it costs $5 and $10 total",
    "`code` and *em*",
    "an unclosed $ and an unclosed ` and a trailing \\",
    "混合 $\\alpha$ 中文",
  ];
  for (const source of sources) {
    it(`reproduces ${JSON.stringify(source.slice(0, 40))} byte for byte`, () => {
      expect(
        scanOpaque(source)
          .map((s) => s.text)
          .join(""),
      ).toBe(source);
    });
  }
});

describe("scanOpaque — LaTeX is opaque (D3-3)", () => {
  it("marks inline math", () => {
    expect(opaque("before $\\alpha$ after")).toEqual(["$\\alpha$"]);
  });

  it("marks BOTH math spans, so the underscores never meet", () => {
    // The case both references fail. Codex renders pulldown-cmark's decoded
    // text and Pi passes no `preserveBackslashEscapes` on the assistant path,
    // so in both of them the `_` in `x_1` and the `_` in `y_2` pair into
    // emphasis across the intervening prose.
    expect(opaque("$x_1$ and $y_2$")).toEqual(["$x_1$", "$y_2$"]);
    expect(scannable("$x_1$ and $y_2$")).toBe(" and ");
  });

  it("marks display math, including across newlines", () => {
    expect(opaque("$$\n\\sum_{i=0}^n x_i\n$$")).toEqual([
      "$$\n\\sum_{i=0}^n x_i\n$$",
    ]);
  });

  it("marks \\( \\) and \\[ \\]", () => {
    expect(opaque("\\(a_1\\)")).toEqual(["\\(a_1\\)"]);
    expect(opaque("\\[a_1\\]")).toEqual(["\\[a_1\\]"]);
  });

  it("marks a whole environment as ONE region", () => {
    // Not merely the \begin and \end tokens: the body is what carries the
    // subscripts, and marking only the delimiters would leave it exposed.
    const src = "\\begin{equation}\na_1 + b_2\n\\end{equation}";
    expect(opaque(src)).toEqual([src]);
  });

  it("marks a command with its braced argument", () => {
    expect(opaque("see \\cite{knuth1984} for it")).toEqual([
      "\\cite{knuth1984}",
    ]);
  });

  it("marks a command's argument even when it contains Markdown markers", () => {
    expect(opaque("\\emph{a *b* c}")).toEqual(["\\emph{a *b* c}"]);
    expect(scannable("\\emph{a *b* c}")).toBe("");
  });

  it("marks nested braces in an argument", () => {
    expect(opaque("\\textbf{\\emph{x}}")).toEqual(["\\textbf{\\emph{x}}"]);
  });

  it("marks optional arguments too", () => {
    expect(opaque("\\sqrt[3]{x_1}")).toEqual(["\\sqrt[3]{x_1}"]);
  });

  it("marks a bare command with no argument", () => {
    expect(opaque("$\\alpha$ vs \\alpha alone")).toEqual([
      "$\\alpha$",
      "\\alpha",
    ]);
  });

  it("marks a single-character escape, backslash and all (D3-3)", () => {
    // The divergence from both references, stated as a property: there is no
    // code path that removes a backslash, so `\_` cannot become `_`.
    for (const esc of ["\\%", "\\_", "\\&", "\\#", "\\$", "\\{", "\\\\"]) {
      expect(opaque(`a ${esc} b`)).toEqual([esc]);
    }
  });
});

describe("scanOpaque — under-renders, never corrupts (D3-3)", () => {
  it("treats a currency pair as math, and leaves every character intact", () => {
    // A false positive: `$5 and $` looks exactly like inline math. The cost is
    // that Markdown inside it is not rendered — never that a character moves.
    const src = "it costs $5 and $10 total";
    expect(opaque(src)).toEqual(["$5 and $"]);
    expect(
      scanOpaque(src)
        .map((s) => s.text)
        .join(""),
    ).toBe(src);
  });

  it("leaves an unclosed $ as ordinary scannable text", () => {
    expect(opaque("a lone $ sign")).toEqual([]);
    expect(scannable("a lone $ sign")).toBe("a lone $ sign");
  });

  it("does not let inline math cross a blank line", () => {
    // A `$` opened in one paragraph and a `$` in the next are not one span;
    // treating them as one would swallow the paragraph break between them.
    expect(opaque("$a\n\nb$")).toEqual([]);
  });

  it("leaves a trailing lone backslash alone", () => {
    expect(opaque("ends with \\")).toEqual([]);
  });
});

describe("scanOpaque — code spans (D3-4, precedence)", () => {
  it("marks a backtick span", () => {
    expect(opaque("a `code` b")).toEqual(["`code`"]);
  });

  it("hides a Markdown marker inside a code span from the inline pass", () => {
    // CommonMark resolves code spans before emphasis. Codex delegates that to
    // pulldown-cmark and Pi reaches it by masking code spans out of the source
    // before emphasis scanning; masking is adopted here because it generalises
    // to LaTeX for free.
    expect(opaque("`a *b* c`")).toEqual(["`a *b* c`"]);
    expect(scannable("`a *b* c`")).toBe("");
  });

  it("closes only on a run of equal length", () => {
    expect(opaque("``a ` b``")).toEqual(["``a ` b``"]);
  });

  it("leaves an unclosed backtick as scannable text", () => {
    expect(opaque("an unclosed ` backtick")).toEqual([]);
    expect(scannable("an unclosed ` backtick")).toBe("an unclosed ` backtick");
  });

  it("gives the region to whichever opener comes first", () => {
    // No precedence table between LaTeX and code spans: the left-to-right scan
    // decides, which is one rule instead of two and is directly testable.
    expect(opaque("`$x$`")).toEqual(["`$x$`"]);
    expect(opaque("$`x`$")).toEqual(["$`x`$"]);
  });
});

describe("inlineNodes — emphasis (D3-4)", () => {
  it("renders **strong**", () => {
    const host = inline("a **bold** b");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.textContent).toBe("a bold b");
  });

  it("renders *em*", () => {
    expect(inline("a *soft* b").querySelector("em")?.textContent).toBe("soft");
  });

  it("does NOT render _em_ — it is literal (D3-4)", () => {
    // Excluded deliberately: in a LaTeX and Markdown writing tool an
    // underscore is a subscript, an identifier or a filename far more often
    // than it is emphasis. `snake_case_name` staying literal is worth more
    // than `_italic_` working.
    const host = inline("a _soft_ b and snake_case_name");
    expect(host.querySelector("em")).toBeNull();
    expect(host.textContent).toBe("a _soft_ b and snake_case_name");
  });

  it("nests a strong inside an em without either swallowing the other", () => {
    const host = inline("*a **b** c*");
    const em = host.querySelector("em");
    expect(em?.querySelector("strong")?.textContent).toBe("b");
    expect(em?.textContent).toBe("a b c");
  });

  it("nests an em inside a strong", () => {
    const host = inline("**a *b* c**");
    expect(host.querySelector("strong > em")?.textContent).toBe("b");
  });

  it("spans emphasis across an opaque region", () => {
    // The opening `**` and the closing `**` sit in different text spans with a
    // code span between them. Scanning each text span in isolation would drop
    // the emphasis; masking keeps the indices aligned so it does not.
    const host = inline("**a `code` b**");
    const strong = host.querySelector("strong");
    expect(strong?.querySelector("code")?.textContent).toBe("code");
    expect(strong?.textContent).toBe("a code b");
  });

  it("leaves an unclosed marker literal", () => {
    expect(inline("a **bold and no closer").textContent).toBe(
      "a **bold and no closer",
    );
    expect(inline("a **bold and no closer").querySelector("strong")).toBeNull();
    expect(inline("a *soft and no closer").querySelector("em")).toBeNull();
  });
});

describe("inlineNodes — code spans (D3-4)", () => {
  it("renders a code span with verbatim content", () => {
    const code = inline("a `x = *1*` b").querySelector("code");
    expect(code?.textContent).toBe("x = *1*");
    expect(code?.querySelector("em")).toBeNull();
  });

  it("keeps a backtick inside a doubled run", () => {
    expect(inline("``a ` b``").querySelector("code")?.textContent).toBe(
      "a ` b",
    );
  });

  it("leaves an unclosed backtick literal", () => {
    const host = inline("an unclosed ` backtick");
    expect(host.querySelector("code")).toBeNull();
    expect(host.textContent).toBe("an unclosed ` backtick");
  });
});

describe("inlineNodes — links are scheme-allowlisted (D3-6)", () => {
  it("renders an http(s) link", () => {
    const a = inline(
      "see [the paper](https://arxiv.org/abs/1) now",
    ).querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://arxiv.org/abs/1");
    expect(a?.textContent).toBe("the paper");
  });

  it("renders a mailto link", () => {
    expect(
      inline("[me](mailto:a@b.c)").querySelector("a")?.getAttribute("href"),
    ).toBe("mailto:a@b.c");
  });

  for (const url of [
    "javascript:alert(1)",
    "command:workbench.action.quit",
    "data:text/html;base64,x",
    "vbscript:x",
    "/relative/path",
  ]) {
    it(`refuses ${url} and renders it literally`, () => {
      // Deny-by-default. `enableCommandUris` is not set on the webview, so VS
      // Code already refuses `command:` — but a renderer that WOULD emit one
      // if the host allowed it is a single option flip away from a defect.
      const host = inline(`[t](${url})`);
      expect(host.querySelector("a")).toBeNull();
      expect(host.textContent).toBe(`[t](${url})`);
    });
  }

  it("renders an image as literal text — the CSP is default-src 'none'", () => {
    const host = inline("![alt](https://x/y.png)");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("![alt](https://x/y.png)");
  });

  it("leaves an unclosed link literal", () => {
    const host = inline("[t](https://x");
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("[t](https://x");
  });

  it("renders emphasis inside a link's text", () => {
    expect(
      inline("[a *b* c](https://x)").querySelector("a > em")?.textContent,
    ).toBe("b");
  });
});

describe("inlineNodes — model output is never markup (D3-5)", () => {
  // The PRIMARY no-innerHTML gate, in D2's proven shape
  // (`script-card.test.ts`): assert the OUTPUT, not the source that built it.
  // ADR 0037 §4 rejects a source-level assertion for a DOM claim; the grep in
  // `scripts/check-webview-innerhtml.mjs` is a backstop beside this, not a
  // substitute for it.
  it("writes a script tag as text and creates no element", () => {
    const host = inline("<script>alert(1)</script>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toBe("<script>alert(1)</script>");
  });

  it("writes an onerror image as text and creates no element", () => {
    const host = inline('<img src=x onerror="alert(1)">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("does not interpret markup hidden inside a code span", () => {
    const host = inline("`<script>alert(1)</script>`");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("code")?.textContent).toBe(
      "<script>alert(1)</script>",
    );
  });
});

describe("inlineNodes — LaTeX reaches the DOM byte-identically (D3-3)", () => {
  for (const latex of [
    "$\\alpha$",
    "$x_1$ and $y_2$",
    "\\cite{knuth1984}",
    "\\emph{a *b* c}",
    "\\begin{equation}\nE = mc^2\n\\end{equation}",
    "\\%",
    "\\_",
    "\\\\",
  ]) {
    it(`renders ${JSON.stringify(latex)} unchanged`, () => {
      const host = inline(latex);
      expect(host.textContent).toBe(latex);
      expect(host.querySelector("em")).toBeNull();
      expect(host.querySelector("strong")).toBeNull();
    });
  }

  it("renders prose around math without touching the math", () => {
    const host = inline("the term $x_1$ is **important**");
    expect(host.querySelector("strong")?.textContent).toBe("important");
    expect(host.textContent).toBe("the term $x_1$ is important");
  });
});

describe("blocks — headings (D3-4)", () => {
  for (let level = 1; level <= 6; level++) {
    it(`renders an h${level}`, () => {
      const host = block(`${"#".repeat(level)} Title`);
      expect(host.querySelector(`h${level}`)?.textContent).toBe("Title");
    });
  }

  it("carries the class the stylesheet's heading scale targets", () => {
    // `styles.test.ts` asserts the CSS declares `h1.lm-md__h`; this asserts the
    // element carries it. Without both, renaming the class would silently stop
    // the whole heading scale applying with a green suite.
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const h = block(`${"#".repeat(level)} T`).querySelector(`h${level}`);
      expect(h?.className, `h${level}`).toBe("lm-md__h");
    }
  });

  it("requires the space — #nospace is a paragraph", () => {
    const host = block("#nospace");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("p")?.textContent).toBe("#nospace");
  });

  it("stops at six — ####### is a paragraph", () => {
    expect(block("####### too deep").querySelector("h6")).toBeNull();
  });

  it("renders inline constructs inside a heading", () => {
    expect(
      block("## a **b** c").querySelector("h2 > strong")?.textContent,
    ).toBe("b");
  });

  it("leaves LaTeX in a heading alone", () => {
    expect(block("## The $x_1$ term").querySelector("h2")?.textContent).toBe(
      "The $x_1$ term",
    );
  });
});

describe("blocks — lists (D3-4)", () => {
  for (const marker of ["-", "*", "+"]) {
    it(`renders an unordered list with ${marker}`, () => {
      const host = block(`${marker} one\n${marker} two`);
      const items = [...host.querySelectorAll("ul > li")];
      expect(items.map((li) => li.textContent)).toEqual(["one", "two"]);
    });
  }

  it("renders an ordered list", () => {
    const host = block("1. one\n2. two");
    expect(
      [...host.querySelectorAll("ol > li")].map((li) => li.textContent),
    ).toEqual(["one", "two"]);
  });

  it("nests an indented item under the item above it", () => {
    const host = block("- outer\n  - inner\n- second");
    const top = host.querySelector("ul");
    expect(top?.children.length).toBe(2);
    const nested = top?.querySelector("li > ul");
    expect(nested?.textContent).toBe("inner");
    expect(top?.children[0]?.textContent).toBe("outerinner");
  });

  it("renders inline constructs inside an item", () => {
    expect(block("- a `b` c").querySelector("li > code")?.textContent).toBe(
      "b",
    );
  });

  it("does not mistake emphasis for a list marker", () => {
    // `* item` is a list; `*emphasis*` is not, because the marker rule needs
    // the space after it.
    const host = block("*emphasis* leads this line");
    expect(host.querySelector("ul")).toBeNull();
    expect(host.querySelector("p > em")?.textContent).toBe("emphasis");
  });
});

describe("blocks — paragraphs (D3-4)", () => {
  it("splits on a blank line", () => {
    const host = block("one\n\ntwo");
    expect([...host.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "one",
      "two",
    ]);
  });

  it("keeps a soft newline inside a paragraph", () => {
    // The behaviour `white-space: pre-wrap` gives today, kept: D3-7 moves the
    // rule to the paragraph rather than dropping it.
    expect(block("one\ntwo").querySelector("p")?.textContent).toBe("one\ntwo");
  });

  it("renders nothing for empty or whitespace-only text", () => {
    expect(blocks("")).toEqual([]);
    expect(blocks("   \n\n  ")).toEqual([]);
  });
});

describe("blocks — fenced code (D3-2, D3-4)", () => {
  it("renders a closed fence as a pre > code", () => {
    const host = block("```\nx = 1\n```");
    expect(host.querySelector("pre > code")?.textContent).toBe("x = 1");
  });

  it("keeps the content verbatim, markers and all", () => {
    const host = block("```\n# not a heading\n*not em*\n```");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("em")).toBeNull();
    expect(host.querySelector("code")?.textContent).toBe(
      "# not a heading\n*not em*",
    );
  });

  it("captures the info string without leaking it into the content", () => {
    const code = block("```python\nx = 1\n```").querySelector("code");
    expect(code?.className).toContain("language-python");
    expect(code?.textContent).toBe("x = 1");
  });

  it("renders an empty fence without crashing", () => {
    expect(block("```\n```").querySelector("pre > code")?.textContent).toBe("");
  });

  it("closes a fence whose lines end in CRLF", () => {
    // A model quoting a Windows file emits `\r\n`. Without the per-line CR
    // drop the closing line is "```\r", which matches nothing, and the whole
    // rest of the message silently becomes verbatim text.
    const host = block("```py\r\nx = 1\r\n```\r\nafter");
    expect(host.querySelector("pre > code")?.textContent).toBe("x = 1");
    expect(host.querySelector("p")?.textContent).toBe("after");
  });

  it("renders an UNCLOSED fence as a code block from its opening line (ADR 0040)", () => {
    // The reversal. Round 1 rendered this as verbatim text until the closer
    // arrived, which measured ~9 seconds of raw fence syntax on a long block.
    const host = block("```python\nx = 1\nstill going");
    const code = host.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("language-python");
    // Every character of the BODY, and not one character of the marker line.
    expect(code?.textContent).toBe("x = 1\nstill going");
  });

  it("marks the open block so the stylesheet can lift its height clamp", () => {
    // While the fence is open the block grows; the 240px clamp lands at the
    // closing backtick (ADR 0040 §2). The class is the whole mechanism.
    expect(block("```py\nx = 1").querySelector("pre")?.className).toContain(
      "lm-md__pre--open",
    );
    expect(
      block("```py\nx = 1\n```").querySelector("pre")?.className,
    ).not.toContain("lm-md__pre--open");
  });

  it("takes the text after an unclosed fence INTO the block, losing nothing", () => {
    // Codex's accepted trade (`markdown.rs:86-88`): a fence that never closes
    // styles the remainder as code. The prose is still on screen, character for
    // character — under-render, never hide — which is the property that
    // survives the reversal.
    const host = block("intro\n\n```\ncode\n\nlater prose");
    expect(host.querySelector("p")?.textContent).toBe("intro");
    expect(host.querySelector("pre > code")?.textContent).toBe(
      "code\n\nlater prose",
    );
    expect(host.textContent).toContain("later prose");
  });

  it("keeps a partial closing fence on screen rather than trimming it", () => {
    // Pi strips a trailing partial closer so the block does not grow then
    // shrink by a line (`markdown.ts:25-48`). Refused: the property that
    // survives ADR 0040 is *no prefix loses a BODY character*, and a trimmed
    // closer is a body line losing one. One line of flicker is the smaller price.
    expect(block("```\nx = 1\n``").querySelector("code")?.textContent).toBe(
      "x = 1\n``",
    );
  });

  it("parses blocks normally on both sides of a closed fence", () => {
    const host = block("# Title\n\n```\ncode\n```\n\n- item");
    expect(host.querySelector("h1")?.textContent).toBe("Title");
    expect(host.querySelector("pre > code")?.textContent).toBe("code");
    expect(host.querySelector("ul > li")?.textContent).toBe("item");
  });

  it("drops the fence's marker line and its info string, deliberately", () => {
    // ADR 0040's surviving property is *no prefix loses a BODY character*, not
    // "no prefix loses a character". The marker line is chrome: its backticks,
    // its language and any further info-string text are all gone the moment
    // three backticks make it an opener — exactly as they always were on the
    // closed path. Round 1 showed them while the fence was open; round 2 does
    // not, and this is the one deliberate loss, pinned so it is checked rather
    // than merely permitted by a sweep that mirrors the implementation.
    expect(block("```").textContent).toBe("");
    expect(block("```py").textContent).toBe("");
    expect(block("```py note to self").textContent).toBe("");
    // And everything after it survives, character for character.
    expect(block("```py note\nx = 1").textContent).toBe("x = 1");
  });

  it("still renders prose before the fence as blocks", () => {
    const host = block("# Title\n\n- one\n\n```\ncode");
    expect(host.querySelector("h1")?.textContent).toBe("Title");
    expect(host.querySelector("ul > li")?.textContent).toBe("one");
    expect(host.querySelector("pre > code")?.textContent).toBe("code");
  });

  it("leaves an unclosed INLINE construct literal — the reversal is fences only", () => {
    // The rest of D3-2 stands. ADR 0040's scope is stated narrowly for exactly
    // this reason.
    const host = block("**bold and `code and [t](https://x");
    expect(host.querySelector("strong")).toBeNull();
    expect(host.querySelector("code")).toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("**bold and `code and [t](https://x");
  });

  it("leaves an unclosed LaTeX block opener as verbatim text — fences only", () => {
    // `$$` / `\[` / `\begin{env}` alone on a line keep round 1's degradation.
    // A fence's opener states what kind of thing it opens and a bare `$$` does
    // not: rendering THAT early would mean choosing between display math and a
    // currency figure on evidence that has not arrived.
    const host = block("$$\n- a_1\nmore");
    expect(host.querySelector("pre")).toBeNull();
    expect(host.querySelector("ul")).toBeNull();
    expect(host.textContent).toBe("$$\n- a_1\nmore");
  });

  it("does not treat a mid-line ``` as an opener", () => {
    // FENCE_OPEN is anchored at the line start, and stays so: "see the ```"
    // must not turn the rest of a finished answer into code.
    const host = block("see the ``` marker\n\nnext para");
    expect(host.querySelector("pre")).toBeNull();
    expect(host.textContent).toContain("next para");
  });
});

describe("a code block carries chrome and a Copy button (ADR 0040)", () => {
  /** The block pass with the chrome wired, and a spy for what was copied. */
  const withCopy = (
    source: string,
    locale: "en" | "zh" = "en",
  ): { host: HTMLElement; copied: string[] } => {
    const copied: string[] = [];
    const host = document.createElement("div");
    for (const node of blocks(source, {
      locale,
      onCopy: (text) => copied.push(text),
    })) {
      host.append(node);
    }
    return { host, copied };
  };

  /**
   * A real press, not `.click()`.
   *
   * The button listens on `mousedown` because the transcript rebuilds
   * `document.body` once per streamed frame, and a `click` is dispatched to the
   * nearest common ancestor of the press and the release — so a button detached
   * between the two receives no click at all. A test that synthesises a `click`
   * asserts the one path a real user cannot rely on.
   */
  const press = (btn: Element | null): void => {
    btn?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  };

  /** The keyboard path, which `mousedown` never covers. */
  const key = (btn: Element | null, k: string): void => {
    btn?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };

  it("wraps the pre so the button has something to be positioned against", () => {
    const { host } = withCopy("```\nx = 1\n```");
    const wrap = host.querySelector(".lm-md__codeblock");
    expect(wrap).not.toBeNull();
    // Two children, the reference's shape: the button, then the pre.
    expect(wrap?.children.length).toBe(2);
    expect(wrap?.querySelector("pre > code")?.textContent).toBe("x = 1");
  });

  it("copies the block's exact text, markers excluded", () => {
    const { host, copied } = withCopy("```python\nx = 1\ny = 2\n```");
    press(host.querySelector(".lm-md__copy"));
    expect(copied).toEqual(["x = 1\ny = 2"]);
  });

  it("copies the body of a still-streaming block too", () => {
    const { host, copied } = withCopy("```py\nhalf writ");
    press(host.querySelector(".lm-md__copy"));
    expect(copied).toEqual(["half writ"]);
  });

  it("labels itself in the reader's language, and only one", () => {
    expect(
      withCopy("```\nx\n```", "en")
        .host.querySelector(".lm-md__copy")
        ?.getAttribute("aria-label"),
    ).toBe("Copy code");
    const zh = withCopy("```\nx\n```", "zh").host.querySelector(".lm-md__copy");
    expect(zh?.getAttribute("aria-label")).toBe("复制代码");
    expect(zh?.getAttribute("title")).toBe("复制代码");
  });

  it("confirms with a glyph swap and reverts after 2 seconds", () => {
    vi.useFakeTimers();
    try {
      const { host } = withCopy("```\nx\n```");
      const btn = host.querySelector<HTMLButtonElement>(".lm-md__copy");
      expect(btn?.className).not.toContain("lm-md__copy--done");
      press(btn);
      expect(btn?.className).toContain("lm-md__copy--done");
      expect(btn?.getAttribute("aria-label")).toBe("Copied");
      vi.advanceTimersByTime(2000);
      expect(btn?.className).not.toContain("lm-md__copy--done");
      expect(btn?.getAttribute("aria-label")).toBe("Copy code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds no text of its own to the bubble", () => {
    // The icon is an inline SVG, so the button contributes no text node. This
    // is what keeps every `textContent` assertion in this file about content.
    const { host } = withCopy("```\nx = 1\n```");
    expect(host.textContent).toBe("x = 1");
    const svg = host.querySelector(".lm-md__copy svg");
    expect(svg).not.toBeNull();
    // Built with createElementNS, never a markup string.
    expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("renders no button when nothing is wired to it", () => {
    // `blocks(source)` with no chrome is the pure content renderer the rest of
    // this file uses. A Copy button with no handler would be a lie.
    const host = block("```\nx\n```");
    expect(host.querySelector(".lm-md__copy")).toBeNull();
    expect(host.querySelector(".lm-md__codeblock")).toBeNull();
  });

  it("copies on PRESS — a pointer click does not copy a second time", () => {
    // The transcript rebuilds `document.body` once per streamed frame. A `click`
    // goes to the nearest common ancestor of the mousedown and mouseup targets,
    // so a button detached between them receives none — and a human press lasts
    // 50–150 ms, i.e. several rebuilds. Listening for `click` would leave the
    // affordance simply dead for the duration of an answer.
    const { host, copied } = withCopy("```\nx = 1\n```");
    const btn = host.querySelector<HTMLButtonElement>(".lm-md__copy");
    // A real pointer click carries `detail >= 1` and was already handled on the
    // press, so it must not copy a second time.
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(copied).toEqual([]);
    press(btn);
    expect(copied).toEqual(["x = 1"]);
  });

  it("still answers an assistive-technology Invoke, which arrives as detail 0", () => {
    // A screen reader activating the button dispatches a synthetic `click` with
    // no press before it and `detail: 0`, exactly like `element.click()`. Without
    // this arm the button would be audible and impossible to activate — and the
    // two string keys ADR 0040 spends on its label would be pointless.
    const { host, copied } = withCopy("```\nx = 1\n```");
    host.querySelector<HTMLButtonElement>(".lm-md__copy")?.click();
    expect(copied).toEqual(["x = 1"]);
  });

  it("ignores a non-primary mouse button", () => {
    // `click` was implicitly primary-only; `mousedown` is not. A right-click
    // would otherwise replace the clipboard silently AND open the context menu.
    const { host, copied } = withCopy("```\nx = 1\n```");
    host
      .querySelector(".lm-md__copy")
      ?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 2 }),
      );
    expect(copied).toEqual([]);
  });

  it("copies from the keyboard too, on Enter and on Space", () => {
    // `mousedown` never fires for the keyboard, and the native Enter/Space
    // activation a <button> would otherwise ride is itself a `click`.
    for (const k of ["Enter", " "]) {
      const { host, copied } = withCopy("```\nx = 1\n```");
      key(host.querySelector(".lm-md__copy"), k);
      expect(copied, k).toEqual(["x = 1"]);
    }
    const { host, copied } = withCopy("```\nx = 1\n```");
    key(host.querySelector(".lm-md__copy"), "a");
    expect(copied).toEqual([]);
  });

  it("re-arms the confirmation on a second press rather than reverting early", () => {
    vi.useFakeTimers();
    try {
      const { host } = withCopy("```\nx\n```");
      const btn = host.querySelector<HTMLButtonElement>(".lm-md__copy");
      press(btn);
      vi.advanceTimersByTime(1500);
      press(btn);
      // The first press's timer would fire here and cut the second short.
      vi.advanceTimersByTime(600);
      expect(btn?.className).toContain("lm-md__copy--done");
      vi.advanceTimersByTime(1400);
      expect(btn?.className).not.toContain("lm-md__copy--done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the chrome through agentMessage", () => {
    const copied: string[] = [];
    const box = agentMessage("```\nx = 1\n```", {
      locale: "en",
      onCopy: (t) => copied.push(t),
    });
    press(box.querySelector(".lm-md__copy"));
    expect(copied).toEqual(["x = 1"]);
  });
});

describe("blocks — a multi-line LaTeX span survives the BLOCK pass (D3-3)", () => {
  // The code review's Critical, and the layer the rest of the LaTeX suite was
  // missing. `scanOpaque` marked these correctly all along; `blocks` ran first
  // and shredded them into lines before any scanner saw them, DELETING the
  // marker characters. That is corruption, not under-rendering — the one
  // failure mode ADR 0039 §3 claims is structurally impossible — so every case
  // here asserts the whole source survives `blocks`, not just `scanOpaque`.
  for (const source of [
    "$$\n- a_1\n$$",
    "$$\n# not a heading\n$$",
    "\\begin{itemize}\n- first\n- second\n\\end{itemize}",
    "\\begin{equation}\n# not a heading\n\\end{equation}",
    "\\begin{align}\n+ 1 & 2 \\\\\n- 3 & 4\n\\end{align}",
    "\\begin{tabular}{cc}\n1 & 2 \\\\\n\\end{tabular}",
  ]) {
    it(`renders ${JSON.stringify(source.slice(0, 32))}… byte for byte`, () => {
      const host = block(source);
      expect(host.textContent).toBe(source);
      expect(host.querySelector("ul")).toBeNull();
      expect(host.querySelector("ol")).toBeNull();
      expect(host.querySelector("h1")).toBeNull();
    });
  }

  it("keeps a blank line inside an ENVIRONMENT from splitting it", () => {
    // An environment is delimited by an explicit `\end{}` pair, so it is safe
    // to let it span a blank line. Display math is not, and must not — see the
    // stray-`$$` cases below.
    const source = "\\begin{figure}\na_1\n\ncaption\n\\end{figure}";
    expect(block(source).textContent).toBe(source);
  });

  it("does not let a stray $$ in prose swallow the document", () => {
    // Blank lines inside mathematics are a LaTeX error, so refusing to cross
    // one costs nothing real — and without it a price in prose eats every
    // paragraph break, heading and list after it.
    const host = block(
      "The GPU costs $$5 an hour.\n\nThe CPU costs $$10 an hour.",
    );
    expect(host.querySelectorAll("p").length).toBe(2);
    expect(host.textContent).toContain("$$5");
    expect(host.textContent).toContain("$$10");
  });

  it("does not let a stray $$ swallow a heading and a list", () => {
    const host = block("Budget: $$\n\n# Heading\n\n- one\n- two");
    expect(host.querySelector("h1")?.textContent).toBe("Heading");
    expect(host.querySelectorAll("ul > li").length).toBe(2);
  });

  it("does not let a code span straddle a paragraph break", () => {
    const host = block("a `b\n\n# H\n\n- x\n\nc` d");
    expect(host.querySelector("h1")?.textContent).toBe("H");
    expect(host.querySelector("ul > li")?.textContent).toBe("x");
  });

  it("still classifies normally on both sides of the span", () => {
    const host = block("# Title\n\n$$\n- a_1\n$$\n\n- real item");
    expect(host.querySelector("h1")?.textContent).toBe("Title");
    expect(host.querySelector("ul > li")?.textContent).toBe("real item");
    expect(host.textContent).toContain("$$\n- a_1\n$$");
  });

  it("degrades to text under an UNCLOSED block opener, losing nothing", () => {
    // The second review round's finding, and the half of the Critical the
    // first fix left open. This is the STREAMING case — the webview renders
    // every prefix — so a third of the deltas of any display-math block with a
    // leading `-` used to show characters vanishing and coming back.
    //
    // The earlier version of this test asserted the opposite and justified it
    // as refusing to "guess that a closer is coming". That was a false
    // dichotomy: declining to classify guesses nothing, and it is what the
    // unclosed FENCE has always done.
    for (const source of [
      "$$\n- a_1",
      "$$\n# not a heading",
      "\\begin{align}\n- 1 & 2",
      "\\begin{itemize}\n- first",
      "\\[\n+ b_2",
    ]) {
      const host = block(source);
      expect(host.textContent, source).toBe(source);
      expect(host.querySelector("ul"), source).toBeNull();
      expect(host.querySelector("h1"), source).toBeNull();
    }
  });

  it("never deletes a list marker at any prefix of a display-math block", () => {
    // Asserted as "the marker characters are still on screen" rather than as
    // full string equality, because whitespace BETWEEN blocks is structural
    // and legitimately consumed — `"Here:\n"` renders one paragraph. What must
    // never happen is a `- ` or `+ ` disappearing, which is what a `<ul>` here
    // would mean.
    const source = "Here:\n$$\n- a_1\n+ b_2\n$$\ndone";
    for (let n = 0; n <= source.length; n++) {
      const prefix = source.slice(0, n);
      const text = block(prefix).textContent ?? "";
      expect(block(prefix).querySelector("ul"), `at ${n}`).toBeNull();
      for (const marker of ["- a_1", "+ b_2"]) {
        if (prefix.includes(marker)) expect(text, `at ${n}`).toContain(marker);
      }
    }
  });

  it("does not bail out on a CLOSED but indented block", () => {
    // Round 3's regression: coverage was read at the line's first byte while
    // the opener pattern allowed leading whitespace, so an indented — and
    // perfectly closed — display-math block looked unterminated and flattened
    // everything after it. Math indented under a numbered step is routine.
    const host = block(
      "1. First step:\n\n   $$\n   x = 1\n   $$\n\n2. Second step",
    );
    expect(host.textContent).toContain("   $$\n   x = 1\n   $$");
    expect(host.querySelector("ol[start='2'] > li")?.textContent).toBe(
      "Second step",
    );
  });

  it("keeps an indented environment under a bullet from eating the next one", () => {
    const host = block("- a\n  \\begin{align}\n  x\n  \\end{align}\n- b");
    expect([...host.querySelectorAll("li")].at(-1)?.textContent).toBe("b");
  });

  it("still classifies below an opener once its closer arrives", () => {
    const host = block("$$\na_1\n$$\n\n- real item");
    expect(host.querySelector("ul > li")?.textContent).toBe("real item");
    expect(host.textContent).toContain("$$\na_1\n$$");
  });
});

describe("blocks — an ordered list keeps the author's numbers (D3-4)", () => {
  // The code review's Important 2: the marker is consumed either way, so a
  // list that does not begin at 1 must SAY so or the number is deleted.
  it("carries `start` when the list does not begin at 1", () => {
    const list = block("3. third\n4. fourth").querySelector("ol");
    expect(list?.getAttribute("start")).toBe("3");
  });

  it("omits `start` for an ordinary list beginning at 1", () => {
    expect(
      block("1. one\n2. two").querySelector("ol")?.hasAttribute("start"),
    ).toBe(false);
  });

  it("keeps a year-like number on screen", () => {
    // The number is carried by the list marker, which the browser draws from
    // `start` — so it is present on screen but never in `textContent`. That is
    // exactly why this needed the attribute: without it the marker draws "1."
    // and the year the author typed is simply gone.
    const list = block("2024. That was the year we started.").querySelector(
      "ol",
    );
    expect(list?.getAttribute("start")).toBe("2024");
    expect(list?.querySelector("li")?.textContent).toBe(
      "That was the year we started.",
    );
  });

  it("starts a new list when the marker kind changes", () => {
    const host = block("- a\n1. b");
    expect(host.querySelector("ul > li")?.textContent).toBe("a");
    expect(host.querySelector("ol > li")?.textContent).toBe("b");
  });
});

describe("blocks — tables (X4, ADR 0044)", () => {
  // The construct D3 bet against and the corpus refuted: nine of ten measured
  // corpus passes emitted one, on both pinned providers, and the shipped
  // renderer put raw `| --- |` pipe syntax on screen as literal text.
  const table = (source: string): HTMLTableElement | null =>
    block(source).querySelector("table");

  /** Every cell of a row, as text — the shape most assertions here want. */
  const row = (t: HTMLTableElement | null, n: number): string[] =>
    Array.from(t?.rows[n]?.cells ?? [], (c) => c.textContent ?? "");

  const SIMPLE =
    "| Aspect | Systems | Theory |\n|---|---|---|\n| Subject | Code | Proof |\n";

  it("renders a header row, a delimiter row and a body row as a table", () => {
    const t = table(SIMPLE);
    expect(t).not.toBeNull();
    expect(t?.tHead?.rows[0]?.cells.length).toBe(3);
    expect(row(t, 0)).toEqual(["Aspect", "Systems", "Theory"]);
    expect(row(t, 1)).toEqual(["Subject", "Code", "Proof"]);
  });

  it("puts the header row in `th` and the body in `td`", () => {
    const t = table(SIMPLE);
    expect(t?.tHead?.rows[0]?.cells[0]?.tagName).toBe("TH");
    expect(t?.tBodies[0]?.rows[0]?.cells[0]?.tagName).toBe("TD");
  });

  it("renders inline Markdown inside a cell", () => {
    const t = table("| a | b |\n|---|---|\n| **bold** | `code` |\n");
    expect(t?.querySelector("strong")?.textContent).toBe("bold");
    expect(t?.querySelector("code")?.textContent).toBe("code");
  });

  it("renders a link inside a cell, still scheme-allowlisted", () => {
    const t = table(
      "| paper | note |\n|---|---|\n| [x](https://arxiv.org/abs/1) | [y](javascript:alert) |\n",
    );
    expect(t?.querySelector("a")?.getAttribute("href")).toBe(
      "https://arxiv.org/abs/1",
    );
    // Exactly one anchor: the second link's scheme is refused, as D3-6 requires
    // wherever `inlineNodes` runs — a cell is not an exception to it.
    expect(t?.querySelectorAll("a").length).toBe(1);
  });

  it("is NOT a table when the delimiter row's cell count differs", () => {
    // GFM's rule. Under-render: the two lines stay prose.
    const host = block("| a | b | c |\n|---|---|\n");
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toBe("| a | b | c |\n|---|---|");
  });

  it("is NOT a table when the delimiter row carries no pipe", () => {
    // The setext trap. `---` under a prose line is a setext heading, which ADR
    // 0039 excludes deliberately — turning it into a one-column table would
    // reopen an exclusion this milestone re-affirms.
    const host = block("Some prose here\n---\n");
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toBe("Some prose here\n---");
  });

  it("is NOT a table when a delimiter cell holds anything but dashes and colons", () => {
    const host = block("| a | b |\n|---| x |\n");
    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toBe("| a | b |\n|---| x |");
  });

  it("accepts a table with no leading or trailing pipes", () => {
    const t = table("a | b\n--- | ---\n1 | 2\n");
    expect(row(t, 0)).toEqual(["a", "b"]);
    expect(row(t, 1)).toEqual(["1", "2"]);
  });

  it("honours alignment colons as classes (X4-4)", () => {
    const t = table("| l | c | r |\n|:---|:---:|---:|\n| 1 | 2 | 3 |\n");
    const head = Array.from(t?.tHead?.rows[0]?.cells ?? [], (c) => c.className);
    expect(head).toEqual([
      "lm-md__cell lm-md__cell--left",
      "lm-md__cell lm-md__cell--center",
      "lm-md__cell lm-md__cell--right",
    ]);
    // The body row carries the same alignment, or the columns disagree.
    expect(t?.tBodies[0]?.rows[0]?.cells[2]?.className).toBe(
      "lm-md__cell lm-md__cell--right",
    );
  });

  it("carries no alignment class when the author wrote no colon", () => {
    const t = table(SIMPLE);
    expect(t?.tHead?.rows[0]?.cells[0]?.className).toBe("lm-md__cell");
  });

  it("uses no inline style for alignment — the CSP has no 'unsafe-inline'", () => {
    const t = table("| l | r |\n|:---|---:|\n| 1 | 2 |\n");
    for (const cell of Array.from(t?.querySelectorAll("th, td") ?? [])) {
      expect(cell.getAttribute("style")).toBeNull();
    }
  });

  it("pads a short row, and FOLDS a long one's surplus into its last cell", () => {
    // The code review's Critical 1. The first draft truncated, on the grounds
    // that GFM does — and `| A | B |` over `| 1 | 2 | 3 |` rendered "AB12" with
    // the `3` **deleted from the screen**. GFM is a document formatter and may
    // discard; this renderer may not. Folding keeps the row rectangular AND
    // keeps every character, which is the only combination that satisfies both
    // the column count and ADR 0039 §3.
    const t = table("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |\n");
    expect(row(t, 1)).toEqual(["1", "", ""]);
    expect(row(t, 2)).toEqual(["1", "2", "3 | 4"]);
  });

  it("loses no Chinese character from a RAGGED row (invariant 6 rule 1)", () => {
    // The same defect in the form that made it unarguable: truncation dropped
    // 备注 outright. A rectangular fixture cannot see this, which is why the
    // sweep that was supposed to catch it did not.
    const host = block("| 方面 | 系统 |\n|---|---|\n| 主题 | 代码 | 备注 |\n");
    expect(host.textContent).toContain("备注");
  });

  it("keeps a heading after a table OUT of the table (review)", () => {
    // A body row must carry an unmasked pipe of its own. Without that rule the
    // table swallowed whatever followed it, so `# Head` became a cell with its
    // `#` on screen — the literal-syntax defect D3 exists to remove,
    // reappearing for one adjacency. GFM breaks a table at the next block
    // structure for the same reason.
    const host = block("| a | b |\n|---|---|\n# Head\n");
    expect(host.querySelector("h1")?.textContent).toBe("Head");
    expect(host.textContent).not.toContain("#");
  });

  it("keeps a list and ordinary prose after a table out of it too", () => {
    const list = block("| a | b |\n|---|---|\n- item\n");
    expect(list.querySelector("ul > li")?.textContent).toBe("item");
    const prose = block("| a | b |\n|---|---|\nplain words\n");
    expect(prose.querySelector("p")?.textContent).toBe("plain words");
  });

  it("keeps `-`, `:` and `>` inside a cell (review 2)", () => {
    // The streamed sweep compares every NON-MARKER character, which means it
    // strips `-`, `:` and `>` from both sides — and all three are legitimate
    // cell content. Deleting every `:` from every cell leaves that sweep green
    // while `ratio 3:4` renders as `ratio 34`. A point assertion closes the
    // hole the marker-agnostic comparison structurally cannot.
    const t = table(
      "| term | value |\n|---|---|\n| well-known | 3:4 |\n| a > b | -5 |\n",
    );
    expect(row(t, 1)).toEqual(["well-known", "3:4"]);
    expect(row(t, 2)).toEqual(["a > b", "-5"]);
  });

  it("keeps a LaTeX forced space at a cell edge (review)", () => {
    // `\ ` is a forced space and `scanOpaque` marks it opaque, so its second
    // character IS the token. Trimming the raw line turned `| x\ |` into `x\`
    // — a character deleted. Cell bounds are trimmed on the MASK, where that
    // space is `\0` and therefore not whitespace.
    const t = table("| a | b |\n|---|---|\n| x\\ | y |\n");
    expect(row(t, 1)).toEqual(["x\\ ", "y"]);
  });

  it("stops being a table past the cell budget, losing no character", () => {
    // Columns and rows are both unbounded and padding builds a cell for every
    // product: 500 x 500 measured 250,500 cells and 3.4 s from a 4 KB message,
    // on a parser that re-runs at every streamed delta. Past `MAX_TABLE_CELLS`
    // the lines are prose — under-rendered, every character on screen.
    const wide = `|${"a|".repeat(500)}\n|${"-|".repeat(500)}\n${"|x|\n".repeat(500)}`;
    const host = block(wide);
    expect(host.querySelector("table")).toBeNull();
    expect((host.textContent ?? "").replace(/\n/g, "")).toBe(
      wide.replace(/\n/g, ""),
    );
  });

  it("still renders a table that sits inside the budget", () => {
    const ok = `|${"a|".repeat(8)}\n|${"-|".repeat(8)}\n${"|x|\n".repeat(8)}`;
    expect(block(ok).querySelector("table")).not.toBeNull();
  });

  it("survives CRLF, which the fence rule already had to learn", () => {
    // A model quoting a Windows file emits `\r\n`. `blocks` drops a trailing
    // `\r` per line, so the delimiter row still matches — asserted rather than
    // assumed, because the same trap silently turned a whole message into
    // verbatim text once already.
    const t = block("| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n").querySelector(
      "table",
    );
    expect(Array.from(t?.rows[1]?.cells ?? [], (c) => c.textContent)).toEqual([
      "1",
      "2",
    ]);
  });

  it("promotes at the FENCE flush site too, not only at end of stream", () => {
    // `tailOpen` has two callers and only one of them was asserted. A region
    // flushed by a fence line has every line terminated — the fence line could
    // not follow otherwise — so the table promotes even though the delimiter
    // row is the region's last line.
    const host = block("| a | b |\n|---|---|\n```py\nx = 1\n```\n");
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("pre > code")?.textContent).toBe("x = 1");
  });

  it("keeps the prose above a table as its own paragraph", () => {
    const host = block("Here are the results:\n| a |\n|---|\n| 1 |\n");
    expect(host.querySelector("p")?.textContent).toBe("Here are the results:");
    expect(host.querySelector("table")).not.toBeNull();
  });

  it("wraps the table so it can scroll rather than widen the bubble (X4-7)", () => {
    const host = block(SIMPLE);
    const wrap = host.querySelector(".lm-md__tablewrap");
    expect(wrap).not.toBeNull();
    expect(wrap?.firstElementChild?.tagName).toBe("TABLE");
    expect(wrap?.firstElementChild?.className).toBe("lm-md__table");
  });
});

describe("blocks — a table's cells are split on the MASK (X4-3, ADR 0039 §3)", () => {
  const table = (source: string): HTMLTableElement | null =>
    block(source).querySelector("table");
  const row = (t: HTMLTableElement | null, n: number): string[] =>
    Array.from(t?.rows[n]?.cells ?? [], (c) => c.textContent ?? "");

  it("does not split a cell on a `|` inside inline math", () => {
    // The norm. `$|x|$` is ordinary academic notation, and splitting it across
    // three cells destroys real mathematics on screen — the one failure ADR
    // 0039 §3 makes structurally impossible.
    const t = table("| symbol | meaning |\n|---|---|\n| $|x|$ | the norm |\n");
    expect(row(t, 1)).toEqual(["$|x|$", "the norm"]);
  });

  it("keeps a backslashed pipe whole AND keeps its backslash", () => {
    // GFM would decode `\|` to `|`. ADR 0039 §3 says no backslash escape is
    // ever decoded, and `\|` is already an opaque LaTeX token — so the rule
    // holds here with no special case written for it.
    const t = table("| a | b |\n|---|---|\n| $\\|v\\|$ | norm |\n");
    expect(row(t, 1)).toEqual(["$\\|v\\|$", "norm"]);
    expect(t?.textContent).toContain("\\|");
  });

  it("does not split a cell on a `|` inside a code span", () => {
    const t = table("| shell | note |\n|---|---|\n| `a | b` | a pipeline |\n");
    expect(row(t, 1)).toEqual(["a | b", "a pipeline"]);
    expect(t?.querySelector("code")?.textContent).toBe("a | b");
  });

  it("does not split a cell on a `|` inside a LaTeX environment", () => {
    const t = table(
      "| m | note |\n|---|---|\n| \\begin{matrix} a | b \\end{matrix} | two |\n",
    );
    expect(row(t, 1)).toEqual(["\\begin{matrix} a | b \\end{matrix}", "two"]);
  });

  it("MERGES cells on a currency false positive, and loses no character", () => {
    // The recorded cost of X4-3. `$5 | and $` looks exactly like inline math,
    // so the row is two cells rather than three. Every character is still on
    // screen — under-rendering, the direction this renderer is allowed to fail
    // in, and the same false positive ADR 0039 §3 already documents for prose.
    const t = table(
      "| a | b | c |\n|---|---|---|\n| costs $5 | and $10 | ok |\n",
    );
    expect(row(t, 1)).toEqual(["costs $5 | and $10", "ok", ""]);
    expect(t?.textContent).toContain("$5");
    expect(t?.textContent).toContain("$10");
  });

  it("keeps `$x_1$` in a cell byte-identical, with no emphasis pairing", () => {
    const t = table("| a | b |\n|---|---|\n| $x_1$ | $y_2$ |\n");
    expect(row(t, 1)).toEqual(["$x_1$", "$y_2$"]);
    expect(t?.querySelector("em")).toBeNull();
  });
});

describe("blocks — a table renders only once its delimiter row is settled (X4-2)", () => {
  it("waits for the delimiter row's newline", () => {
    // The marker is on the SECOND line, so ADR 0039 §2's end-of-text relaxation
    // does not transfer: `|---|---|-` is a three-cell delimiter row and
    // `|---|---|- x` is not one, so something arriving later CAN change what
    // the line means.
    const head = "| a | b |\n";
    expect(block(`${head}|---|---|`).querySelector("table")).toBeNull();
    expect(block(`${head}|---|---|\n`).querySelector("table")).not.toBeNull();
  });

  it("renders the header alone once the delimiter row has closed", () => {
    const t = block("| a | b |\n|---|---|\n").querySelector("table");
    expect(t?.tHead?.rows.length).toBe(1);
    expect(t?.tBodies[0]?.rows.length ?? 0).toBe(0);
  });

  it("grows a partial trailing body row in place", () => {
    // A body row needs no completeness rule: after the delimiter row every line
    // in the group is a row, so nothing arriving later changes its meaning.
    const t = block("| a | b |\n|---|---|\n| 1 | 2").querySelector("table");
    expect(Array.from(t?.rows[1]?.cells ?? [], (c) => c.textContent)).toEqual([
      "1",
      "2",
    ]);
  });

  it("never classifies a line a multi-line LaTeX span owns as a row (X4-5)", () => {
    // ADR 0039 §3's block-pass rule: a protected line is never classified, and
    // calling one a table row is classifying it.
    const host = block("| a | b |\n|---|---|\n$$\n| not | a row |\n$$\n");
    expect(host.textContent).toContain("$$\n| not | a row |\n$$");
    const t = host.querySelector("table");
    expect(t?.tBodies[0]?.rows.length ?? 0).toBe(0);
  });
});

describe("blocks — blockquotes (X4-6, ADR 0044)", () => {
  it("renders a `>` run as a blockquote", () => {
    const host = block("> the key point\n> stands out\n");
    const quote = host.querySelector("blockquote");
    expect(quote?.className).toBe("lm-md__quote");
    expect(quote?.querySelector("p")?.textContent).toBe(
      "the key point\nstands out",
    );
    // The marker is chrome and is dropped, exactly as `#` and `- ` are.
    expect(host.textContent).not.toContain(">");
  });

  it("ends the quote at the first line without a marker — no lazy continuation", () => {
    // GFM would absorb the second line. Absorbing it means guessing, and
    // guessing wrong pulls a paragraph into a quote box, which is a MIS-render.
    const host = block("> quoted\nnot quoted\n");
    expect(host.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(host.querySelectorAll("p")[1]?.textContent).toBe("not quoted");
  });

  it("accepts a marker with no space after it", () => {
    expect(block(">tight\n").querySelector("blockquote")?.textContent).toBe(
      "tight",
    );
  });

  it("splits paragraphs inside a quote on a bare marker line", () => {
    const quote = block("> one\n>\n> two\n").querySelector("blockquote");
    expect(
      Array.from(quote?.querySelectorAll("p") ?? [], (p) => p.textContent),
    ).toEqual(["one", "two"]);
  });

  it("renders a heading and a list inside a quote", () => {
    const quote = block("> ## Head\n> - one\n> - two\n").querySelector(
      "blockquote",
    );
    expect(quote?.querySelector("h2")?.textContent).toBe("Head");
    expect(quote?.querySelectorAll("li").length).toBe(2);
  });

  it("renders a table inside a quote", () => {
    const nested = block("> | a |\n> |---|\n> | 1 |\n").querySelector(
      "blockquote > .lm-md__tablewrap > table",
    ) as HTMLTableElement | null;
    expect(nested?.rows[1]?.cells[0]?.textContent).toBe("1");
  });

  it("nests a quote inside a quote", () => {
    const outer = block("> outer\n> > inner\n").querySelector("blockquote");
    expect(outer?.querySelector("blockquote")?.textContent).toBe("inner");
  });

  it("keeps LaTeX in a quote byte-identical", () => {
    const quote = block("> we use $x_1$ and $y_2$ here\n").querySelector(
      "blockquote",
    );
    expect(quote?.textContent).toBe("we use $x_1$ and $y_2$ here");
    expect(quote?.querySelector("em")).toBeNull();
  });

  it("degrades to literal text past the nesting cap rather than throwing", () => {
    const deep = `${"> ".repeat(64)}x`;
    let host: HTMLElement | undefined;
    expect(() => {
      host = block(deep);
    }).not.toThrow();
    // Nothing is lost — the markers past the cap are still on screen as text.
    expect(host?.textContent).toContain("> > ");
  });
});

describe("blocks — the blockquote cap and the empty quote (review)", () => {
  const boxes = (source: string): number =>
    block(source).querySelectorAll("blockquote").length;

  it("nests exactly MAX_QUOTE_DEPTH boxes and no more", () => {
    // The cap was asserted only as "contains `> > `", which pins neither the
    // number nor where the degradation starts.
    expect(boxes(`${"> ".repeat(8)}x`)).toBe(8);
    expect(boxes(`${"> ".repeat(9)}x`)).toBe(8);
    expect(boxes(`${"> ".repeat(64)}x`)).toBe(8);
  });

  it("leaves every surplus marker on screen, character for character", () => {
    const deep = `${"> ".repeat(12)}x`;
    // Eight levels are consumed as chrome; the remaining four markers are text.
    expect(block(deep).textContent).toBe(`${"> ".repeat(4)}x`);
  });

  it("renders no empty box for a run of bare markers", () => {
    // An empty `<blockquote>` is a bordered rectangle with nothing in it, and
    // the marker is the only character there — so it is content, not chrome.
    const host = block(">\n>\n");
    expect(host.querySelector("blockquote")).toBeNull();
    expect(host.textContent).toBe(">\n>");
  });

  it("still quotes a run whose bare marker is only a paragraph break", () => {
    const host = block("> one\n>\n> two\n");
    expect(host.querySelectorAll("blockquote").length).toBe(1);
  });
});

describe("the parser cannot be made to hang or overflow (review)", () => {
  // Model output on the webview's repaint path: the whole accumulated message
  // is re-parsed on every delta, so an O(n²) pass is O(n³) across a stream.
  // Degenerate token repetition is a known model failure mode.
  //
  // This is a COMPLEXITY guard, not a performance budget, and the number is
  // loose on purpose: wall-clock in a loaded parallel suite is noisy, while
  // the regression being caught is not subtle. Before the fix a 16k run of
  // asterisks took ~193 ms and 16k brackets ~406 ms *with the machine idle*,
  // both growing quadratically — at 20k under load a reintroduced O(n²) lands
  // in the seconds, so it fails this comfortably while ordinary jitter cannot.
  const budgetMs = 1500;

  // Single-character runs are the easy half. The second review round found two
  // quadratics that survived the first fix precisely because every case here
  // was one repeated character, so the compound shapes below are the ones that
  // actually earn their place.
  for (const [name, source] of [
    ["asterisks", "*".repeat(20000)],
    ["open brackets", "[".repeat(20000)],
    ["backticks", "`".repeat(20000)],
    ["dollars", "$".repeat(20000)],
    ["backslashes", "\\".repeat(20000)],
    ["mixed", "*[`$\\".repeat(4000)],
    ["unclosed environments", "\\begin{a}".repeat(20000)],
    ["unclosed align blocks", "\\begin{align}\n".repeat(20000)],
    ["balanced brackets", "[".repeat(20000) + "]".repeat(20000)],
    ["brackets with one closer", `${"[".repeat(20000)}a]`],
    ["link openers", "[a](".repeat(20000)],
    ["unclosed inline math", "\\(".repeat(10000)],
    ["unclosed display math", "\\[".repeat(10000)],
    ["unclosed math in prose", "see f\\(x for detail. ".repeat(1000)],
    ["closed environments", "\\begin{a}x\\end{a}".repeat(5000)],
    ["commands", "\\cite{a} ".repeat(20000)],
    // X4: the two new constructs. A run of pipes is the easy half — the shapes
    // that matter are the ones that make the cell splitter and the quote
    // recursion do real work at every line, which is what ADR 0039's review
    // meant by an alphabet that can produce pairs rather than only runs.
    ["pipes", "|".repeat(20000)],
    ["delimiter cells", "|-".repeat(10000)],
    // 3,998 cells — deliberately just UNDER `MAX_TABLE_CELLS`, so this row
    // exercises the rendering path rather than the rejection one.
    ["table rows", "| a | b |\n|---|---|\n".repeat(1000)],
    [
      "table rows, one row past the budget",
      "| a | b |\n|---|---|\n".repeat(1025),
    ],
    ["rows of math cells", "| $x_1$ | $y_2$ |\n|---|---|\n".repeat(700)],
    ["unclosed delimiter rows", "| a |\n|---".repeat(4000)],
    ["quote markers", "> ".repeat(20000)],
    ["quoted lines", "> a\n".repeat(10000)],
    ["deeply nested quotes", `${"> ".repeat(10000)}x`],
    // COLUMNS x ROWS — the pair the first draft of this list missed. Every
    // row above varies one dimension; this one multiplies two, which is the
    // shape that measured 250,500 cells and 3.4 s from a 4 KB message before
    // `MAX_TABLE_CELLS` existed.
    [
      "a wide header over many short rows",
      `|${"a|".repeat(500)}\n|${"-|".repeat(500)}\n${"|x|\n".repeat(2000)}`,
    ],
    // The second review's two quadratics, both introduced by the FIRST
    // review's fixes and both on a fall-through that re-derived a run one line
    // at a time. Measured before the memo: 5.6 s and 3.9 s.
    ["bare marker lines", ">\n".repeat(10000)],
    ["bare marker lines with a space", "> \n".repeat(6666)],
    [
      "repeated header groups, over budget",
      "| a | b |\n|---|---|\n".repeat(5000),
    ],
    [
      "a square table",
      `|${"a|".repeat(120)}\n|${"-|".repeat(120)}\n${`|${"x|".repeat(120)}\n`.repeat(120)}`,
    ],
  ] as const) {
    it(`renders 20k ${name} well inside a frame budget`, () => {
      const started = Date.now();
      expect(() => blocks(source)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(budgetMs);
    });
  }

  it("degrades to text rather than overflowing the stack on deep nesting", () => {
    // `renderItem` runs INSIDE `render()` before `replaceChildren`, so a throw
    // would freeze the panel on the previous frame for every later delta too.
    const deep = `${"[".repeat(20000)}a${"](https://x)".repeat(20000)}`;
    expect(() => blocks(deep)).not.toThrow();
    expect(() =>
      blocks(`${"*".repeat(20000)}a${"*".repeat(20000)}`),
    ).not.toThrow();
  });
});

describe("delta by delta — no prefix loses a BODY character (D3-2, ADR 0040)", () => {
  // The stage gate's named test. `session/loop.ts` accumulates the message and
  // emits the WHOLE string on every `item.updated`, so the renderer sees every
  // prefix of the final text in turn. These sweep all of them rather than
  // sampling, because the failure this guards against is a single bad prefix.
  //
  // The claim this block used to make — "nothing incomplete ever renders" — was
  // withdrawn for fenced blocks by ADR 0040. What survives, and what every
  // sweep below asserts, is that no prefix loses a BODY character. The one
  // exception is a fence's own marker line, which is chrome and is pinned
  // separately by "drops the fence's marker line and its info string,
  // deliberately" — the word *body* is load-bearing, and the review that proved
  // the looser wording false is why it is repeated at every statement of it.
  const prefixes = (source: string): string[] =>
    Array.from({ length: source.length + 1 }, (_, n) => source.slice(0, n));

  const cjk = (s: string): number => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;

  it("opens the block at the opening fence and loses no BODY character at any prefix", () => {
    // The re-aimed gate test. Round 1 asserted that no prefix rendered anything
    // but plain text; ADR 0040 withdraws that. What survives — and what this
    // sweeps every prefix for — is that no prefix loses a BODY character.
    const source = "```py\nx = 1\ny = 2\n```";
    for (const prefix of prefixes(source)) {
      const host = block(prefix);
      const at = `at ${prefix.length}`;
      // The opening fence line is complete as soon as three backticks have
      // arrived; before that "`" and "``" are an unclosed code span, i.e. text.
      if (prefix.length < 3) {
        expect(host.querySelector("pre"), at).toBeNull();
        expect(host.textContent, at).toBe(prefix);
        continue;
      }
      const code = host.querySelector("pre > code");
      expect(code, at).not.toBeNull();
      // The body is everything after the first line — including a trailing
      // partial closer, which is not trimmed.
      const lines = prefix.split("\n");
      const closed = lines.length > 1 && lines[lines.length - 1] === "```";
      const body = (closed ? lines.slice(1, -1) : lines.slice(1)).join("\n");
      expect(code?.textContent, at).toBe(body);
    }
  });

  it("opens the block at the fence and only drops the closer at the end", () => {
    // The promotion moment moved to the OPENING fence (ADR 0040). What still
    // happens at the last backtick is that the closer stops being body.
    expect(block("```py").querySelector("pre > code")?.textContent).toBe("");
    expect(block("```py\nx = 1\n``").querySelector("code")?.textContent).toBe(
      "x = 1\n``",
    );
    expect(block("```py\nx = 1\n```").querySelector("code")?.textContent).toBe(
      "x = 1",
    );
  });

  it("never renders an inline construct before its closer arrives", () => {
    const source = "**bold** and `code` and [l](https://x) end";
    const strongAt = source.indexOf("**bold**") + "**bold**".length;
    const codeAt = source.indexOf("`code`") + "`code`".length;
    const linkAt = source.indexOf("[l](https://x)") + "[l](https://x)".length;
    for (const prefix of prefixes(source)) {
      const host = block(prefix);
      const at = `at ${prefix.length}`;
      if (prefix.length < strongAt)
        expect(host.querySelector("strong"), at).toBeNull();
      if (prefix.length < codeAt)
        expect(host.querySelector("code"), at).toBeNull();
      if (prefix.length < linkAt)
        expect(host.querySelector("a"), at).toBeNull();
    }
    const done = block(source);
    expect(done.querySelector("strong")?.textContent).toBe("bold");
    expect(done.querySelector("code")?.textContent).toBe("code");
    expect(done.querySelector("a")?.getAttribute("href")).toBe("https://x");
  });

  it("never renders a partial LaTeX span as emphasis at any prefix", () => {
    // The stream passes through `$x_` — one bare underscore, with the closing
    // `$` not yet arrived. Nothing may pair with it, at any prefix.
    const source = "the term $x_1$ and $y_2$ follow";
    for (const prefix of prefixes(source)) {
      expect(
        block(prefix).querySelector("em"),
        `at ${prefix.length}`,
      ).toBeNull();
    }
  });

  it("loses no Chinese character at any prefix (invariant 6 rule 1)", () => {
    // Message content passes through unaltered in whatever language it
    // arrives. Markers are ASCII, so stripping a rendered one can never change
    // how many CJK characters are on screen — with ONE exception, which is why
    // this fixture's fence carries an ASCII info string: a fence's info string
    // is chrome, is dropped, and is not necessarily ASCII. That case is pinned
    // below rather than hidden by a fixture that cannot reach it.
    const source =
      "## 方法\n\n我们用 $\\alpha$ 表示学习率。\n\n- 第一步：准备数据\n- 第二步：训练模型\n\n```python\n# 注释\nx = 1\n```\n";
    for (const prefix of prefixes(source)) {
      expect(cjk(block(prefix).textContent ?? ""), `at ${prefix.length}`).toBe(
        cjk(prefix),
      );
    }
  });

  it("drops a NON-ASCII info string too, which the CJK sweep cannot see", () => {
    // The sweep above reasons that markers are ASCII. A fence's info string is
    // not a marker and need not be ASCII: ````数学` is chrome, so its two
    // characters are dropped exactly as `python` is. This is the one place
    // invariant 6 rule 1's "unaltered" and ADR 0040's "body character" meet,
    // and it is asserted rather than left to a fixture that avoids it.
    expect(block("```数学").textContent).toBe("");
    expect(block("```数学\n我们用 $a$。").textContent).toBe("我们用 $a$。");
  });

  /**
   * Everything that is not a table marker, in order.
   *
   * The first version of this sweep asked "does each of these six words appear
   * exactly once", and the code review's Critical 1 was invisible to it twice
   * over: a word not on the list could vanish unseen, and the fixture was
   * rectangular so no cell was ever dropped. Removing the markers from BOTH
   * sides and comparing the remainder is exact — it catches a character that is
   * dropped, duplicated OR moved — while staying agnostic about which markers
   * the renderer consumes and how it trims a cell.
   */
  const bare = (s: string): string => s.replace(/[|:\->\s]/g, "");

  it("loses no BODY character at any prefix of a streamed table", () => {
    // A table has TWO promotion moments — the delimiter row's newline, and each
    // body row's arrival — and the pipes and dashes it consumes are chrome, like
    // a heading's `#`. What must survive every prefix is the CONTENT.
    const source =
      "| Aspect | Systems |\n|---|---:|\n| Subject | Code |\n| Venue | OSDI | extra |\n";
    for (const prefix of prefixes(source)) {
      expect(bare(block(prefix).textContent ?? ""), `at ${prefix.length}`).toBe(
        bare(prefix),
      );
    }
  });

  it("loses no BODY character at any prefix of a table inside a quote", () => {
    // The quote recursion inherits `tailOpen` from the run's last line, so the
    // nested table's delimiter-row gate has to work one level down as well.
    const source = "> | a | b |\n> |---|---|\n> | 1 | 2 |\n";
    for (const prefix of prefixes(source)) {
      expect(bare(block(prefix).textContent ?? ""), `at ${prefix.length}`).toBe(
        bare(prefix),
      );
    }
    const done = block(source);
    expect(
      done.querySelector("blockquote > .lm-md__tablewrap > table"),
    ).not.toBeNull();
  });

  it("loses no BODY character at any prefix of a streamed quote", () => {
    const source = "> the single most important thing\n> is the claim\n";
    for (const prefix of prefixes(source)) {
      // The marker is chrome; everything else is body. Strip the markers the
      // renderer would have stripped and the two must agree character for
      // character — with the one exception the renderer itself makes: a run of
      // BARE markers quotes nothing, so it stays on screen as text rather than
      // becoming an empty bordered box. That case is the first two prefixes.
      const stripped = prefix
        .split("\n")
        .map((l) => l.replace(/^[ \t]{0,3}>[ \t]?/, ""));
      const expected = stripped.some((l) => l.trim() !== "")
        ? stripped.join("\n").trimEnd()
        : prefix.trimEnd();
      expect(
        (block(prefix).textContent ?? "").trimEnd(),
        `at ${prefix.length}`,
      ).toBe(expected);
    }
  });

  it("loses no Chinese character at any prefix of a table or a quote", () => {
    // Invariant 6 rule 1, over the two new constructs. Their markers are ASCII
    // — `|`, `-`, `:`, `>` — so stripping a rendered one can never change how
    // many CJK characters are on screen, and unlike a fence there is no info
    // string to make an exception of.
    const source =
      "| 方面 | 系统 |\n|---|---|\n| 主题 | 代码 |\n\n> 关键在于论证\n";
    for (const prefix of prefixes(source)) {
      expect(cjk(block(prefix).textContent ?? ""), `at ${prefix.length}`).toBe(
        cjk(prefix),
      );
    }
  });

  it("holds the whole bubble, so main.ts keeps no rendering decision (D3-8)", () => {
    const box = agentMessage("# Title\n\nprose");
    expect(box.tagName).toBe("DIV");
    // The classes the transcript's own stylesheet targets, plus `lm-md`, which
    // is what turns off `.lm-msg`'s pre-wrap now that the bubble has block
    // children.
    expect(box.className).toBe("lm-msg lm-msg-agent lm-md");
    expect(box.querySelector("h1")?.textContent).toBe("Title");
    expect(box.querySelector("p")?.textContent).toBe("prose");
  });

  it("renders an empty message as an empty bubble rather than throwing", () => {
    // `item.started` carries `text: ""` — the very first thing the webview
    // sees for every answer.
    const box = agentMessage("");
    expect(box.childNodes.length).toBe(0);
    expect(box.className).toContain("lm-md");
  });

  it("renders the finished Chinese answer with its LaTeX intact", () => {
    const host = block("我们用 $\\alpha$ 表示学习率。");
    expect(host.querySelector("p")?.textContent).toBe(
      "我们用 $\\alpha$ 表示学习率。",
    );
    expect(host.querySelector("em")).toBeNull();
  });

  it("survives every prefix of a document using every construct", () => {
    const source = [
      "# Title",
      "",
      "Some **bold** and *soft* prose with `code` and $x_1$.",
      "",
      "- one",
      "  - nested",
      "1. first",
      "",
      "See [the paper](https://arxiv.org/abs/1).",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "\\begin{equation}\na_1 + b_2\n\\end{equation}",
      "",
    ].join("\n");
    for (const prefix of prefixes(source)) {
      expect(() => block(prefix), `at ${prefix.length}`).not.toThrow();
    }
    const done = block(source);
    expect(done.querySelector("h1")?.textContent).toBe("Title");
    expect(done.querySelector("pre > code")?.textContent).toBe(
      "const x: number = 1;",
    );
    expect(done.textContent).toContain("\\begin{equation}");
    expect(done.textContent).toContain("a_1 + b_2");
  });
});
