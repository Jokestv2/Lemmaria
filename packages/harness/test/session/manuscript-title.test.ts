/**
 * V2 (ADR 0078 §5, O10): the manuscript's own title, read out of its bytes.
 *
 * What this feeds is the withholding guard — the panel removes the reviewed
 * paper from its own reviewers' literature results — so the failure that
 * matters most is not *missed the title*, which is recorded honestly as
 * `own_title_unguarded / no_title`. It is *read the wrong string*, which would
 * withhold somebody else's paper. Every case below is shaped around that.
 */
import { describe, expect, it } from "vitest";
import { manuscriptTitle } from "../../src/session/manuscript-title.js";

const of = (
  files: Record<string, string>,
  defaultFile = Object.keys(files)[0] as string,
) => manuscriptTitle({ files: new Map(Object.entries(files)), defaultFile });

describe("manuscriptTitle — LaTeX", () => {
  it("reads a plain `\\title{…}`", () => {
    expect(of({ "main.tex": "\\title{Attention Is All You Need}" })).toBe(
      "Attention Is All You Need",
    );
  });

  it("skips an optional argument", () => {
    // `\title[short]{long}` is the beamer/acmart shape; the SHORT one is a
    // running-head abbreviation and is not what an index holds.
    expect(
      of({ "main.tex": "\\title[Attention]{Attention Is All You Need}" }),
    ).toBe("Attention Is All You Need");
  });

  it("reads a brace-balanced argument, not up to the first `}`", () => {
    expect(
      of({ "main.tex": "\\title{A Study of {Escherichia coli} in the Wild}" }),
    ).toBe("A Study of Escherichia coli in the Wild");
  });

  it("drops `\\thanks` and `\\footnote` WITH their contents", () => {
    // These carry funding lines and email addresses. Keeping their text would
    // make the title compare against nothing.
    expect(
      of({
        "main.tex":
          "\\title{Deep Residual Learning\\thanks{Supported by grant 12345, a@b.c}}",
      }),
    ).toBe("Deep Residual Learning");
    expect(
      of({
        "main.tex":
          "\\title{Deep Residual Learning\\footnote{Equal contribution}}",
      }),
    ).toBe("Deep Residual Learning");
  });

  it("turns `\\\\` and `~` into spaces and keeps a formatted word", () => {
    // `\emph{novel}` must leave `novel`: the command is markup, the argument
    // is title text, and a blanket removal would lose the word entirely.
    expect(
      of({
        "main.tex": "\\title{A~Really \\emph{Novel} Idea\\\\In Two Lines}",
      }),
    ).toBe("A Really Novel Idea In Two Lines");
  });

  it("ignores a commented-out title, and honours an escaped percent", () => {
    expect(
      of({
        "main.tex": [
          "% \\title{The Draft Title}",
          "\\title{The Real Title}",
        ].join("\n"),
      }),
    ).toBe("The Real Title");
    // `\%` is the character, not a command — the escape goes, the `%` stays.
    expect(of({ "main.tex": "\\title{A 40\\% Improvement}" })).toBe(
      "A 40% Improvement",
    );
  });

  it("is not fooled by `\\subtitle` or `\\titleformat`", () => {
    expect(
      of({
        "main.tex": [
          "\\titleformat{\\section}{\\large}{}{}{}",
          "\\subtitle{Not This One}",
          "\\title{This One}",
        ].join("\n"),
      }),
    ).toBe("This One");
  });

  it("finds the title in an included file when the entry has none", () => {
    expect(
      of(
        {
          "main.tex": "\\documentclass{article}\n\\input{front}",
          "front.tex": "\\title{From The Included File}",
        },
        "main.tex",
      ),
    ).toBe("From The Included File");
  });

  it("prefers the ENTRY's title over an included file's", () => {
    // On an \\input-split paper the entry is the preamble shell that carries
    // the real `\\title`; a section file that happens to define one is not it.
    expect(
      of(
        {
          "sections/old.tex": "\\title{An Older Draft}",
          "main.tex": "\\title{The Paper}",
        },
        "main.tex",
      ),
    ).toBe("The Paper");
  });

  it("skips `.bib`, whose every entry has a title and none of them is this paper's", () => {
    expect(
      of(
        {
          "main.tex": "\\documentclass{article}",
          "refs.bib": "@article{k, title = {Somebody Else's Paper}}",
        },
        "main.tex",
      ),
    ).toBeUndefined();
  });

  it("answers undefined for no title, an empty one, and an unclosed group", () => {
    expect(of({ "main.tex": "\\documentclass{article}" })).toBeUndefined();
    expect(of({ "main.tex": "\\title{}" })).toBeUndefined();
    expect(of({ "main.tex": "\\title{   }" })).toBeUndefined();
    expect(of({ "main.tex": "\\title{never closed" })).toBeUndefined();
    expect(of({ "main.tex": "\\title" })).toBeUndefined();
  });

  it("passes a CJK title through as authored (invariant 6 rule 1)", () => {
    expect(of({ "main.tex": "\\title{基于注意力的神经机器翻译}" })).toBe(
      "基于注意力的神经机器翻译",
    );
  });
});

describe("manuscriptTitle — Markdown", () => {
  it("reads a front-matter title, quoted or bare", () => {
    expect(
      of({
        "paper.md": ["---", "title: The Front Matter One", "---", ""].join(
          "\n",
        ),
      }),
    ).toBe("The Front Matter One");
    expect(
      of({
        "paper.md": ["---", 'title: "Quoted, With A Comma"', "---"].join("\n"),
      }),
    ).toBe("Quoted, With A Comma");
  });

  it("falls back to the first `# ` heading", () => {
    expect(
      of({
        "paper.md": [
          "Some preamble.",
          "",
          "# The Heading",
          "",
          "## Not This",
        ].join("\n"),
      }),
    ).toBe("The Heading");
  });

  it("prefers front matter over a heading", () => {
    expect(
      of({
        "paper.md": [
          "---",
          "title: From The Front",
          "---",
          "# From The Heading",
        ].join("\n"),
      }),
    ).toBe("From The Front");
  });

  it("answers undefined when neither is there", () => {
    expect(
      of({ "paper.md": "just some prose\n\n## a subheading" }),
    ).toBeUndefined();
    expect(
      of({ "paper.md": ["---", "author: nobody", "---", ""].join("\n") }),
    ).toBeUndefined();
  });
});
