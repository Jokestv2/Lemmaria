/**
 * R5 (O1): the planted-defect fixture is consistent with its own manifest.
 *
 * The fixture is three artifacts that only mean something together — the
 * completed manuscript (`clean/main.tex`), the planted one the panel actually
 * reads (`paper/main.tex`), and the ground truth that says what was planted
 * (`defects.json`). A recall number is a property of all three, so a drift
 * between any two of them silently changes the measurement rather than
 * failing it. This test is what makes that impossible: it **re-derives** the
 * planted paper from the clean twin and the manifest, and re-derives every
 * span's line number from the assembled file, so the manifest cannot be
 * edited without the paper agreeing.
 *
 * It also asserts the **layout**, which is load-bearing rather than tidy:
 * `runEvalTask` copies `paperDir` whole into the workspace the reviewers read
 * with `list_files` / `read_span`, so a manifest inside `paper/` would hand
 * the panel its own answer key (ADR 0070 §3). `defects.json` and `clean/` live
 * OUTSIDE `paper/` for that reason, and O5 asserts the copy carries neither.
 *
 * This file deliberately parses `defects.json` itself rather than through
 * `readManifest`: it is the artifacts that are under test here, and a shared
 * parser would let a lenient reader hide a malformed manifest from both.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeWrapping } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/planted-defects");
const BLIND_PANEL = resolve(here, "../live/fixtures/blind-panel/paper");

/** The manifest's shape as this test reads it — deliberately structural. */
interface RawSpan {
  anchor: string;
  line: number;
  endLine?: number;
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

const read = (rel: string): string =>
  readFileSync(resolve(FIXTURE, rel), "utf8");

const clean = read("clean/main.tex");
const planted = read("paper/main.tex");
const manifest = JSON.parse(read("defects.json")) as RawManifest;

/** 1-based line of `anchor`'s single occurrence, and the line it ends on. */
function locate(
  text: string,
  anchor: string,
): { line: number; endLine: number } {
  const at = text.indexOf(anchor);
  const line = text.slice(0, at).split("\n").length;
  return { line, endLine: line + anchor.split("\n").length - 1 };
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + 1;
  }
}

describe("R5 O1 — the planted-defect fixture and its manifest agree", () => {
  it("names the fixture and the file the panel reads", () => {
    expect(manifest.fixture).toBe("planted-defects");
    expect(manifest.file).toBe("main.tex");
    expect(manifest.categories).toEqual([
      "surface",
      "claim",
      "reasoning",
      "experimental",
    ]);
  });

  it("carries sixteen well-formed defects, four per category", () => {
    expect(manifest.defects).toHaveLength(16);
    const perCategory = new Map<string, number>();
    const ids = new Set<string>();
    for (const defect of manifest.defects) {
      expect(ids.has(defect.id)).toBe(false);
      ids.add(defect.id);
      expect(manifest.categories).toContain(defect.category);
      perCategory.set(
        defect.category,
        (perCategory.get(defect.category) ?? 0) + 1,
      );
      expect(defect.subtype).not.toBe("");
      // The verifier's "how a careful reader can tell" — what makes J1 a read
      // rather than a derivation.
      expect(defect.tell).not.toBe("");
      expect(defect.original).not.toBe("");
      expect(defect.perturbed).not.toBe("");
      expect(defect.original).not.toBe(defect.perturbed);
      expect(defect.spans.length).toBeGreaterThan(0);
    }
    for (const category of manifest.categories) {
      expect(perCategory.get(category)).toBe(4);
    }
  });

  it("re-derives the planted paper from the clean twin and the manifest", () => {
    let derived = clean;
    for (const defect of manifest.defects) {
      // Exactly once, or the perturbation is ambiguous and the ground truth
      // does not say which occurrence was planted.
      expect(occurrences(derived, defect.original)).toBe(1);
      derived = derived.replace(defect.original, defect.perturbed);
    }
    expect(derived).toBe(planted);
  });

  it("leaves no original text in the planted paper", () => {
    for (const defect of manifest.defects) {
      expect(occurrences(planted, defect.original)).toBe(0);
    }
  });

  it("records every span's anchor once, at the line it really sits on", () => {
    for (const defect of manifest.defects) {
      // The primary admissible span IS the perturbation (Appendix C).
      expect(defect.spans[0]?.anchor).toBe(defect.perturbed);
      for (const span of defect.spans) {
        expect(occurrences(planted, span.anchor)).toBe(1);
        const at = locate(planted, span.anchor);
        expect(span.line).toBe(at.line);
        if (at.endLine === at.line) {
          // `endLine` is present only when the anchor spans more than one line.
          expect(span.endLine).toBeUndefined();
        } else {
          expect(span.endLine).toBe(at.endLine);
        }
      }
    }
  });

  it("admits S1's numeric consequence, and does not hand it to S4", () => {
    // S1 flips the crossover's denominator, but the value the flip falsifies
    // is printed three lines below the equation. With only the equation's own
    // span admissible, a reviewer who objects "512.06 does not follow from
    // the crossover" MISSES S1 — and lands on 261, which is S4's second span,
    // so the recall credits a correct catch to the wrong defect. The fix is
    // the consequence's own line, and only that line: 261 stays S4's alone.
    const b = 64;
    const k = 512;
    const printed = (2 * k * b ** 2) / (2 * b ** 2 - 1);
    const derivable = (2 * k * b ** 2) / (2 * b ** 2 + 1);
    expect(printed.toFixed(2)).toBe("512.06");
    expect(derivable.toFixed(2)).not.toBe("512.06");

    const consequence = locate(planted, "512.06").line;
    const covers = (id: string): boolean => {
      const defect = manifest.defects.find((each) => each.id === id);
      if (!defect) throw new Error(`no defect ${id}`);
      return defect.spans.some(
        (span) =>
          span.line <= consequence &&
          consequence <= (span.endLine ?? span.line),
      );
    };
    expect(covers("S1")).toBe(true);
    expect(covers("S4")).toBe(false);
  });

  it("keeps the ground truth out of the directory the panel reads", () => {
    expect(readdirSync(resolve(FIXTURE, "paper")).sort()).toEqual([
      "PAPER.md",
      "main.tex",
      "refs.bib",
    ]);
    expect(readdirSync(FIXTURE).sort()).toEqual([
      "clean",
      "defects.json",
      "paper",
    ]);
  });

  it("shares R3's bibliography and PAPER.md byte for byte", () => {
    for (const name of ["refs.bib", "PAPER.md"]) {
      expect(read(`paper/${name}`)).toBe(
        readFileSync(resolve(BLIND_PANEL, name), "utf8"),
      );
    }
  });

  it("is hard-wrapped, so the seats are given the whole-line anchor rule", () => {
    // A long-line manuscript would hand every reviewer the OTHER anchor rule
    // and the recall would measure a different instrument. Fix the fixture's
    // wrapping, never `WRAP_COLUMN_THRESHOLD`.
    expect(describeWrapping(planted)).toContain("hard-wrapped");
    expect(describeWrapping(clean)).toContain("hard-wrapped");
    expect(planted.endsWith("\n")).toBe(true);
    expect(clean.endsWith("\n")).toBe(true);
  });
});

/**
 * The span-list findings of the operator's ground-truth audit (J1) and of the
 * flagship-recall round (J4), pinned so they cannot silently come undone.
 *
 * Every one is a **manifest-only** widening: no `perturbed` string and no byte
 * of `paper/main.tex` moves, so the planted manuscript the panel reads is the
 * same manuscript. What changes is which places a referee may point at and
 * still be credited — and that does move the number, which is why ADR 0071
 * records that figures taken before the widening are not comparable with ones
 * taken after it.
 */
describe("R5 review round — the widened span lists", () => {
  const spansOf = (id: string): RawSpan[] => {
    const defect = manifest.defects.find((d) => d.id === id);
    if (!defect) throw new Error(`no defect ${id}`);
    return defect.spans;
  };
  const covers = (id: string, line: number): boolean =>
    spansOf(id).some(
      (span) => span.line <= line && line <= (span.endLine ?? span.line),
    );

  it("admits the proposition R1's circular proof smuggles in (I7)", () => {
    // The objection a referee writes against a circular proof is written
    // against the STATEMENT — "the proof of Prop. 1 assumes what it sets out to
    // prove" — and only the proof paragraph was admissible. R1 was missed by
    // every panel ever measured, including a 14/16 whose only other miss was E1,
    // which is stronger evidence of a span problem than of a detection one.
    expect(covers("R1", 237)).toBe(true);
    expect(covers("R1", 242)).toBe(true);
    // The proposition is R1's alone: the lemma above it is C1's and its proof
    // is R3's, and neither moved.
    expect(covers("C1", 237)).toBe(false);
    expect(covers("R3", 237)).toBe(false);
  });

  it("admits the Table 1 rows C1's own tell argues from (I8)", () => {
    // C1's tell names its own contradiction — "…and Table 1 contradicts it
    // (12.1 vs 11.9)" — while the span list declined to score it, so a referee
    // writing exactly that objection and quoting the table scored a miss.
    expect(covers("C1", 337)).toBe(true);
    expect(covers("C1", 330)).toBe(true);
  });

  it("admits the prose S2's edit contradicts (I10)", () => {
    // S2 was the only surface row with a single span, while S1, S3 and S4 each
    // admit the line their perturbation contradicts. S2's is the sentence one
    // line above the equation: "block $j$ is represented by the mean of its
    // keys", which the edited equation no longer computes.
    expect(covers("S2", 184)).toBe(true);
    expect(covers("S2", 187)).toBe(true);
  });

  it("records the three span lines two defects deliberately share", () => {
    // Sharing is legitimate and sometimes necessary: C1's objection and C2's
    // both point at the same Table 1 rows, and C3 and R2 both turn on eq:cost.
    // `matchDefects` credits ONE concern with at most one defect (I3) and its
    // claim-over-evidence tie-break is what keeps each objection on its own
    // row — so this list is the instrument's contract with the manifest, and a
    // FOURTH shared line appearing here unreviewed is what it guards against.
    const byLine = new Map<number, string[]>();
    for (const defect of manifest.defects) {
      for (const span of defect.spans) {
        for (
          let line = span.line;
          line <= (span.endLine ?? span.line);
          line++
        ) {
          const ids = byLine.get(line) ?? [];
          if (!ids.includes(defect.id)) ids.push(defect.id);
          byLine.set(line, ids);
        }
      }
    }
    const shared = [...byLine.entries()]
      .filter(([, ids]) => ids.length > 1)
      .sort((a, b) => a[0] - b[0])
      .map(([line, ids]) => `${line}:${ids.join("/")}`);
    expect(shared).toEqual(["253:C3/R2", "330:C1/C2", "337:C1/C2"]);
  });

  it("carries thirteen multi-span rows and three single ones", () => {
    // The count an auditor checks their own against, and it has been wrong in
    // two places at once: NOTES.md's verified table said nine (omitting S1) and
    // `1-audit-the-ground-truth/TEST.md` step 6 said "nine … the other seven".
    // It was ten and six before this round's widenings, and is thirteen and
    // three after them. Asserted rather than written down again.
    const multi = manifest.defects.filter((d) => d.spans.length > 1);
    const single = manifest.defects.filter((d) => d.spans.length === 1);
    expect(multi).toHaveLength(13);
    expect(single.map((d) => d.id)).toEqual(["R3", "R4", "E2"]);
  });

  it("states C3's tell without the error R2 is planted to catch (I11)", () => {
    // C3's tell used to read "the layer's cost is `4nkd_h` — linear in n",
    // which drops eq:cost's second term `2nd_h/b²`. That term grows with n, so
    // the layer's total is quadratic and only within a factor of two of linear
    // below `n < 2kb²` — and R2 is planted precisely to punish the unbounded
    // version of that statement. A tell that states the error another row
    // exists to catch teaches an auditor the wrong thing.
    const tell = manifest.defects.find((d) => d.id === "C3")?.tell ?? "";
    expect(tell).toContain("2kb");
    expect(tell).not.toMatch(/the layer's cost is `4nkd_h`/);
    // The bound is the clean manuscript's own, which is the check that it is
    // not merely a differently-worded guess.
    expect(clean).toContain("n < 2 k b^{2}");
  });
});

/**
 * V1 (plan D11, O24): six TRAPS — careless complaints the manuscript already
 * answers. Each is a pair of spans in the UNPERTURBED text: a bait, where a
 * careless complaint would anchor, and an answer, the passage elsewhere that
 * settles it. No byte of the paper moves for them; the re-derivation above is
 * still the proof of that.
 */
describe("V1 O24 — the traps point at text the fixture already has", () => {
  interface RawTrap {
    id: string;
    complaint: string;
    bait: RawSpan[];
    answer: RawSpan[];
    tell: string;
  }
  const traps = (manifest as RawManifest & { traps?: RawTrap[] }).traps ?? [];

  const overlaps = (a: RawSpan, b: RawSpan): boolean =>
    a.line <= (b.endLine ?? b.line) && b.line <= (a.endLine ?? a.line);

  it("carries six well-formed traps, T1 to T6", () => {
    expect(traps.map((t) => t.id)).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
    ]);
    for (const t of traps) {
      expect(t.complaint.trim(), t.id).not.toBe("");
      expect(t.tell.trim(), t.id).not.toBe("");
      expect(t.bait.length, t.id).toBeGreaterThan(0);
      expect(t.answer.length, t.id).toBeGreaterThan(0);
    }
  });

  it("records every bait and answer anchor once, at the line it really sits on", () => {
    for (const t of traps) {
      for (const span of [...t.bait, ...t.answer]) {
        expect(`${t.id} ${occurrences(planted, span.anchor)}`).toBe(
          `${t.id} 1`,
        );
        const at = locate(planted, span.anchor);
        expect(`${t.id} ${span.line}`).toBe(`${t.id} ${at.line}`);
        // One whole source line each — the form the brief asks a quote in.
        expect(span.endLine).toBeUndefined();
        expect(planted.split("\n")[span.line - 1]).toBe(span.anchor);
      }
    }
  });

  it("touches no defect span, so a trap hit can never be a defect hit", () => {
    const defectSpans = manifest.defects.flatMap((d) => d.spans);
    for (const t of traps) {
      for (const span of [...t.bait, ...t.answer]) {
        for (const d of defectSpans) {
          expect(
            `${t.id}@${span.line} overlaps a defect at ${d.line}: ${overlaps(span, d)}`,
          ).toBe(`${t.id}@${span.line} overlaps a defect at ${d.line}: false`);
        }
      }
    }
  });

  it("answers each complaint ELSEWHERE — at least twenty lines from its bait", () => {
    for (const t of traps) {
      for (const bait of t.bait) {
        for (const answer of t.answer) {
          expect(overlaps(bait, answer), t.id).toBe(false);
          expect(
            Math.abs(answer.line - bait.line),
            t.id,
          ).toBeGreaterThanOrEqual(20);
        }
      }
    }
  });
});
