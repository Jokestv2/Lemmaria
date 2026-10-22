/**
 * V5 (D15, O17): the scorecard's three twins — planted, clean, laundered.
 *
 * L1–L4 read one panel on three versions of one paper, and a difference
 * between two readings means something only if the workspaces differ in
 * exactly the way the comparison names. So this pins the three listings and
 * the byte identities that make the planted/clean pair differ ONLY by the
 * sixteen defects (the old clean twin carried no bibliography and no
 * `PAPER.md`, a confound), and it pins what makes the laundered twin
 * *laundered and not changed*: the same equations and tables byte for byte,
 * the same section titles in order, the same citation keys, the same numbers
 * — and most of its prose lines rewritten.
 *
 * The prose-line rule below was written BEFORE the laundered twin was (T11),
 * so the threshold measures the twin rather than being fitted to it. The
 * defects' survival is the hand audit's claim (`LAUNDERING.md`); what a
 * machine can check about it — every equation and table unchanged — is here.
 *
 * `planted-defects/` and its own listing test are untouched by all of this.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWrapping } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../live/fixtures");
const TWINS = resolve(FIXTURES, "scorecard");
const ORIGIN = resolve(FIXTURES, "planted-defects");

const read = (dir: string, rel: string): string =>
  readFileSync(resolve(dir, rel), "utf8");

const planted = read(TWINS, "planted/main.tex");
const clean = read(TWINS, "clean/main.tex");
const laundered = read(TWINS, "laundered/main.tex");

/** Environments whose every line is math, a table or a float — kept byte for
 *  byte by the laundering, and never counted as prose. */
const VERBATIM_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "table",
  "table*",
  "tabular",
  "figure",
  "figure*",
]);

/** A line that is structure, not prose, even outside those environments. */
const STRUCTURAL =
  /^\\(begin|end|section|subsection|subsubsection|label|maketitle|bibliography|bibliographystyle)\b/;

interface Classified {
  /** The document body's prose lines, trimmed, in order. */
  prose: string[];
  /** Each verbatim environment, whole, in order. */
  blocks: string[];
}

/**
 * **The prose-line rule.** A prose line is a line of the document body —
 * strictly between `\begin{document}` and `\end{document}`, so the preamble
 * is never prose — that is not blank, not a `%` comment, not inside one of
 * `VERBATIM_ENVIRONMENTS`, and does not open with a structural command
 * (`STRUCTURAL`). A `\paragraph{…}` line and a line opening with a citation
 * are prose: each carries a sentence.
 */
function classify(text: string): Classified {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "\\begin{document}");
  const end = lines.findIndex((l) => l.trim() === "\\end{document}");
  const prose: string[] = [];
  const blocks: string[] = [];
  let open: { name: string; lines: string[] } | undefined;
  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (open !== undefined) {
      open.lines.push(line);
      if (trimmed.startsWith(`\\end{${open.name}}`)) {
        blocks.push(open.lines.join("\n"));
        open = undefined;
      }
      continue;
    }
    const begins = /^\\begin\{([^}]+)\}/.exec(trimmed);
    if (begins?.[1] !== undefined && VERBATIM_ENVIRONMENTS.has(begins[1])) {
      open = { name: begins[1], lines: [line] };
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("%")) continue;
    if (STRUCTURAL.test(trimmed)) continue;
    prose.push(trimmed);
  }
  return { prose, blocks };
}

/** Every numeric literal in the file, as a sorted multiset. */
const numbers = (text: string): string[] =>
  (text.match(/\d+(?:\.\d+)?/g) ?? []).sort();

/** Every key every `\cite`, `\citep` and `\citet` names, as a sorted multiset. */
const citeKeys = (text: string): string[] =>
  [...text.matchAll(/\\cite[pt]?\{([^}]*)\}/g)]
    .flatMap((m) => (m[1] ?? "").split(","))
    .map((k) => k.trim())
    .sort();

/** The `\section` and `\subsection` titles, in order. */
const titles = (text: string): string[] =>
  [...text.matchAll(/\\(sub)?section\{([^}]*)\}/g)].map(
    (m) => `${m[1] ?? ""}section:${m[2]}`,
  );

describe("V5 O17 — the scorecard's three twins", () => {
  it("lays out three twins of exactly three files, and the audit beside them", () => {
    expect(readdirSync(TWINS).sort()).toEqual([
      "LAUNDERING.md",
      "clean",
      "laundered",
      "planted",
    ]);
    for (const twin of ["planted", "clean", "laundered"]) {
      expect(readdirSync(resolve(TWINS, twin)).sort(), twin).toEqual([
        "PAPER.md",
        "main.tex",
        "refs.bib",
      ]);
    }
  });

  it("takes the planted and clean manuscripts byte for byte from planted-defects", () => {
    expect(planted).toBe(read(ORIGIN, "paper/main.tex"));
    expect(clean).toBe(read(ORIGIN, "clean/main.tex"));
    expect(read(TWINS, "planted/refs.bib")).toBe(
      read(ORIGIN, "paper/refs.bib"),
    );
    expect(read(TWINS, "planted/PAPER.md")).toBe(
      read(ORIGIN, "paper/PAPER.md"),
    );
  });

  it("gives all three the same bibliography and PAPER.md — the old clean twin's confound removed", () => {
    for (const twin of ["clean", "laundered"]) {
      for (const name of ["refs.bib", "PAPER.md"]) {
        expect(read(TWINS, `${twin}/${name}`), `${twin}/${name}`).toBe(
          read(TWINS, `planted/${name}`),
        );
      }
    }
  });

  it("is hard-wrapped and newline-terminated, every twin, with no control character", () => {
    for (const [twin, text] of [
      ["planted", planted],
      ["clean", clean],
      ["laundered", laundered],
    ] as const) {
      expect(describeWrapping(text), twin).toContain("hard-wrapped");
      expect(text.endsWith("\n"), twin).toBe(true);
      // A tool that un-escapes `\f`, `\t` or `\b` would turn `\frac`,
      // `\top` or `\begin` into a control byte and a broken command.
      expect([...text].filter((c) => c < " " && c !== "\n").length, twin).toBe(
        0,
      );
    }
  });

  it("keeps every equation and table of the planted twin, byte for byte and in order", () => {
    const before = classify(planted).blocks;
    expect(before.length).toBeGreaterThan(0);
    expect(classify(laundered).blocks).toEqual(before);
  });

  it("keeps the section titles in order, the citation keys and the numbers", () => {
    expect(titles(laundered)).toEqual(titles(planted));
    expect(citeKeys(laundered)).toEqual(citeKeys(planted));
    expect(numbers(laundered)).toEqual(numbers(planted));
  });

  it("keeps the preamble whole — the laundering is of the body's prose", () => {
    const preamble = (text: string) =>
      text.slice(0, text.indexOf("\\begin{document}"));
    expect(preamble(laundered)).toBe(preamble(planted));
  });

  it("rewrites at least 60 of every 100 prose lines — a line differs when the planted twin has no such line", () => {
    const original = new Set(planted.split("\n").map((l) => l.trim()));
    const { prose } = classify(laundered);
    expect(prose.length).toBeGreaterThan(0);
    const rewritten = prose.filter((line) => !original.has(line)).length;
    // Integer arithmetic, so the threshold has no rounding to argue about.
    expect(
      rewritten * 100 >= prose.length * 60,
      `${rewritten} of ${prose.length} prose lines rewritten`,
    ).toBe(true);
  });

  it("the audit names all sixteen defects", () => {
    const audit = read(TWINS, "LAUNDERING.md");
    const manifest = JSON.parse(read(ORIGIN, "defects.json")) as {
      defects: Array<{ id: string }>;
    };
    expect(manifest.defects).toHaveLength(16);
    for (const { id } of manifest.defects) {
      expect(audit, id).toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
});
