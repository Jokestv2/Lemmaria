/**
 * X5 (O16): the split fixture **is** the flat one, cut.
 *
 * The round X5 answers measured a panel that loses almost everything anchored
 * in an `\input`-ed section file. Measuring the fix needs two fixtures that
 * differ in **layout and nothing else** — otherwise a change in the located
 * rate is attributable to the paper as much as to the split.
 *
 * So this fixture has **no clean twin**, and that is deliberate. The flat
 * fixture's own test proves its integrity against `clean/main.tex`; this one
 * proves the split *is* the flat one, by expanding every `\input` recursively
 * and comparing bytes. A second clean twin would be a second thing to drift.
 *
 * **The expander below is local on purpose.** Routing it through
 * `LatexProject` or `manuscriptGraphFor` would assert the fixture against the
 * very code X5 changed — the test would pass whenever the product's idea of
 * an include graph matched its own, including when both were wrong. The
 * product's reader is asserted here too, but separately and only for the
 * reading ORDER, which is a claim about the product rather than the fixture.
 *
 * Like its sibling it parses `defects.json` itself rather than through
 * `readManifest`: the artifacts are what is under test, and a shared lenient
 * parser could hide a malformed manifest from both.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manuscriptGraphFor } from "@lemmaria/adapters";
import { describeWrapping, interpretLedger } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SPLIT = resolve(here, "../live/fixtures/planted-defects-split");
const FLAT = resolve(here, "../live/fixtures/planted-defects");

interface RawSpan {
  anchor: string;
  line: number;
  endLine?: number;
  file?: string;
}
interface RawDefect {
  id: string;
  category: string;
  subtype: string;
  original: string;
  perturbed: string;
  spans: RawSpan[];
  tell: string;
}
interface RawManifest {
  fixture: string;
  file: string;
  categories: string[];
  defects: RawDefect[];
}

const readSplit = (rel: string): string =>
  readFileSync(resolve(SPLIT, rel), "utf8");
const readFlat = (rel: string): string =>
  readFileSync(resolve(FLAT, rel), "utf8");

const flat = readFlat("paper/main.tex");
const manifest = JSON.parse(readSplit("defects.json")) as RawManifest;
const flatManifest = JSON.parse(readFlat("defects.json")) as RawManifest;

/**
 * Expand every `\input` line recursively, TeX's way.
 *
 * A line that is exactly `\input{path}` is replaced by that file's contents;
 * the path is **entry-relative**, which is TeX's rule and the reason
 * `sections/experiments.tex` writes `\input{tables/main-results}` rather than
 * a path relative to itself. `.tex` is implied.
 */
function expand(rel: string): string {
  const body = readSplit(`paper/${rel}`);
  return body
    .split("\n")
    .map((line) => {
      const m = /^\\input\{([^}]+)\}$/.exec(line.trim());
      if (m === null) return line;
      // The expansion drops the file's own trailing newline: the `\input`
      // line it replaces already supplies the break.
      return expand(`${m[1]}.tex`).replace(/\n$/, "");
    })
    .join("\n");
}

/** Every `.tex` under `paper/`, workspace-relative, sorted. */
function texFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(resolve(SPLIT, "paper", dir))) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      if (statSync(resolve(SPLIT, "paper", rel)).isDirectory()) {
        walk(rel);
      } else if (name.endsWith(".tex")) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("X5 O16 — the split fixture expands to the flat one, byte for byte", () => {
  it("reproduces `paper/main.tex` exactly", () => {
    // THE test. Everything else in this file is a property of a fixture that
    // has already passed this one; if this fails, the split is a different
    // paper and every comparison between the two measures two things.
    expect(expand("main.tex")).toBe(flat);
  });

  it("has the seven sections and the one nested table", () => {
    expect(texFiles()).toEqual([
      "main.tex",
      "sections/background.tex",
      "sections/conclusion.tex",
      "sections/discussion.tex",
      "sections/experiments.tex",
      "sections/introduction.tex",
      "sections/method.tex",
      "sections/related.tex",
      "tables/main-results.tex",
    ]);
  });

  it("writes every `\\input` alone on its line, entry-relative", () => {
    // Alone on the line because that is what the expander above — and the
    // adapter's own reader — recognise; entry-relative because that is TeX's
    // rule, and `sections/experiments.tex` inputs `tables/main-results`
    // rather than `../tables/main-results`.
    for (const rel of texFiles()) {
      for (const line of readSplit(`paper/${rel}`).split("\n")) {
        if (!line.includes("\\input")) continue;
        expect(`${rel}: ${line}`).toBe(`${rel}: ${line.trim()}`);
        expect(/^\\input\{[^}]+\}$/.test(line)).toBe(true);
      }
    }
    // Two levels deep: the table is inputted from a section, not the entry.
    expect(readSplit("paper/sections/experiments.tex")).toContain(
      "\\input{tables/main-results}",
    );
    expect(readSplit("paper/main.tex")).not.toContain("main-results");
  });

  it("ends every file with a newline", () => {
    // The expander strips exactly one trailing newline per `\input`, so a
    // file that ended without one would silently join two lines.
    for (const rel of texFiles()) {
      expect(`${rel} ends with a newline`).toBe(
        `${rel} ends with ${readSplit(`paper/${rel}`).endsWith("\n") ? "a newline" : "no newline"}`,
      );
    }
  });

  it("shares the flat fixture's bibliography and PAPER.md byte for byte", () => {
    // Same reason the flat fixture shares R3's: a difference here would be a
    // difference in what the reviewers can cite, which is not layout.
    for (const rel of ["paper/refs.bib", "paper/PAPER.md"]) {
      expect(`${rel}: ${readSplit(rel) === readFlat(rel)}`).toBe(
        `${rel}: true`,
      );
    }
  });

  it("keeps the ground truth out of the directory the panel reads", () => {
    // `runEvalTask` copies `paper/` whole into the workspace the reviewers
    // read with `list_files`, so a manifest inside it would hand the panel
    // its own answer key (ADR 0070 §3).
    expect(readdirSync(resolve(SPLIT, "paper"))).not.toContain("defects.json");
    expect(readdirSync(resolve(SPLIT))).toContain("defects.json");
    // And no clean twin, deliberately: `expand === flat` is this fixture's
    // whole integrity argument (ADR 0074 §10).
    expect(readdirSync(resolve(SPLIT))).not.toContain("clean");
  });
});

describe("X5 O16 — the split manifest is the flat one, re-addressed", () => {
  it("carries the same sixteen defects, unchanged but for their addresses", () => {
    expect(manifest.fixture).toBe("planted-defects-split");
    expect(manifest.file).toBe("main.tex");
    expect(manifest.categories).toEqual(flatManifest.categories);
    expect(manifest.defects).toHaveLength(16);
    expect(manifest.defects.map((d) => d.id)).toEqual(
      flatManifest.defects.map((d) => d.id),
    );
    for (const [i, d] of manifest.defects.entries()) {
      const twin = flatManifest.defects[i] as RawDefect;
      // Everything except the address is the flat row's, verbatim. A fixture
      // that re-worded a `tell` or a `perturbed` would be measuring a
      // different defect under the same id.
      expect(`${d.id}: category`).toBe(
        `${d.id}: ${d.category === twin.category ? "category" : twin.category}`,
      );
      for (const key of ["subtype", "original", "perturbed", "tell"] as const) {
        expect(`${d.id}.${key}`).toBe(
          `${d.id}.${d[key] === twin[key] ? key : "DIFFERS"}`,
        );
      }
      expect(d.spans.map((s) => s.anchor)).toEqual(
        twin.spans.map((s) => s.anchor),
      );
    }
  });

  it("puts every span at the line it really sits on, in the file it names", () => {
    // Re-derived from the split files rather than trusted: the manifest is
    // the ground truth, so it may not be the only witness to itself.
    for (const d of manifest.defects) {
      for (const s of d.spans) {
        expect(`${d.id}: ${s.file !== undefined}`).toBe(`${d.id}: true`);
        const body = readSplit(`paper/${s.file}`);
        const at = body.indexOf(s.anchor);
        expect(`${d.id} @ ${s.file}: found`).toBe(
          `${d.id} @ ${s.file}: ${at === -1 ? "MISSING" : "found"}`,
        );
        const line = body.slice(0, at).split("\n").length;
        const endLine = line + s.anchor.split("\n").length - 1;
        expect(`${d.id} @ ${s.file}:${s.line}`).toBe(
          `${d.id} @ ${s.file}:${line}`,
        );
        expect(`${d.id} ends ${s.endLine ?? s.line}`).toBe(
          `${d.id} ends ${endLine}`,
        );
      }
    }
  });

  it("maps the four worked checks the plan derived by hand", () => {
    // Independent arithmetic, so a self-consistent but wrong cut cannot pass
    // the test above by agreeing with itself.
    const lineOf = (id: string, i: number): string => {
      const s = manifest.defects.find((d) => d.id === id)?.spans[i];
      return `${s?.file}:${s?.line}`;
    };
    const flatLineOf = (id: string, i: number): number =>
      flatManifest.defects.find((d) => d.id === id)?.spans[i]?.line ?? -1;
    // Every span, against the plan's chunk table — the offsets are what the
    // cut IS, and the four hand-worked rows below are what proves the table.
    const CHUNKS: Array<[number, number, string, number]> = [
      [1, 37, "main.tex", 0],
      [38, 101, "sections/introduction.tex", 37],
      [102, 128, "sections/background.tex", 101],
      [129, 164, "sections/related.tex", 128],
      [165, 279, "sections/method.tex", 164],
      [280, 323, "sections/experiments.tex", 279],
      [324, 344, "tables/main-results.tex", 323],
      [345, 429, "sections/experiments.tex", 299],
      [430, 445, "sections/discussion.tex", 429],
      [446, 453, "sections/conclusion.tex", 445],
      [454, 457, "main.tex", 409],
    ];
    const where = (flatLine: number): string => {
      const chunk = CHUNKS.find(([lo, hi]) => flatLine >= lo && flatLine <= hi);
      return chunk === undefined
        ? "OUT OF RANGE"
        : `${chunk[2]}:${flatLine - chunk[3]}`;
    };
    for (const [i, d] of manifest.defects.entries()) {
      const twin = flatManifest.defects[i] as RawDefect;
      for (const [j] of d.spans.entries()) {
        expect(`${d.id}[${j}] ${lineOf(d.id, j)}`).toBe(
          `${d.id}[${j}] ${where(twin.spans[j]?.line ?? -1)}`,
        );
      }
    }
    // The chunks are contiguous and cover the flat paper exactly.
    expect(CHUNKS.at(-1)?.[1]).toBe(flat.replace(/\n$/, "").split("\n").length);
    for (let i = 0; i < CHUNKS.length - 1; i += 1) {
      expect(`${i}: ${(CHUNKS[i]?.[1] ?? 0) + 1}`).toBe(
        `${i}: ${CHUNKS[i + 1]?.[0]}`,
      );
    }
    expect(flatLineOf("S1", 0)).toBeGreaterThan(0);
  });
});

describe("X5 O16 — the split fixture behaves like a manuscript", () => {
  it("is read in reading order, entry first and the table in place", async () => {
    // The product's reader, asserted separately from the expansion above: an
    // include graph that agreed with the test's own expander would prove
    // nothing, but the ORDER is a claim about `manuscriptGraphFor` itself.
    const graph = await manuscriptGraphFor("main.tex", async (rel) =>
      readSplit(`paper/${rel}`),
    );
    expect(graph?.files).toEqual([
      "main.tex",
      "sections/introduction.tex",
      "sections/background.tex",
      "sections/related.tex",
      "sections/method.tex",
      "sections/experiments.tex",
      "tables/main-results.tex",
      "sections/discussion.tex",
      "sections/conclusion.tex",
      "refs.bib",
    ]);
    expect(graph?.missing).toEqual([]);
  });

  it("is hard-wrapped, so the seats are given the whole-line anchor rule", () => {
    // Same property the flat fixture has, measured over the manuscript's
    // prose rather than one file — it is what makes the brief's "quote one
    // whole line" instruction the right one for this paper.
    const prose = texFiles()
      .map((rel) => readSplit(`paper/${rel}`))
      .join("\n");
    expect(describeWrapping(prose)).toContain("hard-wrapped");
  });

  it("locates every unique anchor whatever file the ledger names (claim 1)", () => {
    // The stage gate's claim 1, offline half, on the REAL fixture rather than
    // a two-file synthetic map. Each manifest anchor is sent through
    // `interpretLedger` three ways — naming its own file, naming a *sibling*
    // that does not hold it, and naming a file the manuscript does not have —
    // and must land at the same line every time. A unique anchor carries its
    // own position, so which file a reviewer *claims* it is in supplies
    // nothing, which is exactly why the widened locator is not the anchor
    // matching ADR 0060 §2 forbids.
    //
    // The three namings are the round's three observed behaviours: the seat
    // that names the file correctly, the seat that says `main.tex` because the
    // brief told it to, and the seat that invents a plausible path.
    const files = new Map(
      texFiles().map((rel) => [rel, readSplit(`paper/${rel}`)] as const),
    );
    const unique = (anchor: string): boolean =>
      [...files.values()].reduce(
        (n, body) => n + body.split(anchor).length - 1,
        0,
      ) === 1;
    /** An existing manuscript file that is NOT the anchor's own. */
    const elsewhere = (own: string): string =>
      texFiles().find((rel) => rel !== own) ?? "main.tex";
    let checked = 0;
    for (const d of manifest.defects) {
      for (const s of d.spans) {
        if (!unique(s.anchor)) continue;
        const own = s.file ?? manifest.file;
        for (const [naming, named] of [
          ["its own file", own],
          ["a sibling that does not hold it", elsewhere(own)],
          ["a file the manuscript does not have", "sections/nope.tex"],
        ] as const) {
          const outcome = interpretLedger({
            answer: JSON.stringify({
              annotations: [
                {
                  dimension: "soundness",
                  severity: "major",
                  anchor: s.anchor,
                  file: named,
                  evidence: "missing",
                  message: `concern about ${d.id}`,
                },
              ],
            }),
            reviewer: "reviewer_a",
            files,
            defaultFile: "main.tex",
            suggestEdits: false,
          });
          const located = outcome.result?.annotations[0];
          const where = `${d.id} naming ${naming}`;
          expect(`${where}: ${located?.span.file}:${located?.span.line}`).toBe(
            `${where}: ${s.file}:${s.line}`,
          );
          // And the record says whether the harness had to go looking: a
          // correctly named anchor is not `relocated`, a mis-named one is.
          // Without this the three cases could pass by the locator ignoring
          // `file` entirely, which would be a different — and wrong — design.
          expect(`${where}: relocated ${outcome.counts?.relocated}`).toBe(
            `${where}: relocated ${named === own ? 0 : 1}`,
          );
          checked += 1;
        }
      }
    }
    // The loop above is only evidence if it ran. A manifest whose anchors all
    // turned out non-unique would assert nothing and still pass green.
    expect(checked).toBeGreaterThan(30);
  });
});

/** V1 (plan D11, O24): the six traps, re-addressed into the split paper. */
describe("V1 O24 — the split traps are the flat ones, re-addressed", () => {
  interface RawTrap {
    id: string;
    complaint: string;
    bait: RawSpan[];
    answer: RawSpan[];
    tell: string;
  }
  const trapsOf = (m: RawManifest): RawTrap[] =>
    (m as RawManifest & { traps?: RawTrap[] }).traps ?? [];
  const split = trapsOf(manifest);
  const flatTraps = trapsOf(flatManifest);

  it("carries the same six traps, unchanged but for their addresses", () => {
    expect(split.map((t) => t.id)).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
    ]);
    expect(split.map((t) => t.id)).toEqual(flatTraps.map((t) => t.id));
    for (const [i, t] of split.entries()) {
      const twin = flatTraps[i] as RawTrap;
      expect(t.complaint).toBe(twin.complaint);
      expect(t.tell).toBe(twin.tell);
      expect(t.bait.map((s) => s.anchor)).toEqual(
        twin.bait.map((s) => s.anchor),
      );
      expect(t.answer.map((s) => s.anchor)).toEqual(
        twin.answer.map((s) => s.anchor),
      );
    }
  });

  it("puts every trap span, once in the whole manuscript, at the line of the file it names", () => {
    const bodies = texFiles().map(
      (rel) => [rel, readSplit(`paper/${rel}`)] as const,
    );
    for (const t of split) {
      for (const span of [...t.bait, ...t.answer]) {
        expect(span.file, t.id).toBeDefined();
        const total = bodies.reduce(
          (n, [, body]) => n + body.split(span.anchor).length - 1,
          0,
        );
        expect(`${t.id} ${total}`).toBe(`${t.id} 1`);
        const lines = readSplit(`paper/${span.file}`).split("\n");
        expect(`${t.id} ${lines[span.line - 1]}`).toBe(
          `${t.id} ${span.anchor}`,
        );
      }
    }
  });

  it("touches no defect span in the split paper either", () => {
    const defectSpans = manifest.defects.flatMap((d) => d.spans);
    for (const t of split) {
      for (const span of [...t.bait, ...t.answer]) {
        for (const d of defectSpans) {
          const same = d.file === span.file;
          const overlap =
            same &&
            span.line <= (d.endLine ?? d.line) &&
            d.line <= (span.endLine ?? span.line);
          expect(`${t.id} ${overlap}`).toBe(`${t.id} false`);
        }
      }
    }
  });
});
