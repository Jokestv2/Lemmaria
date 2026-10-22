/**
 * O18: the facts block (V4, ADR 0081 §1; plan D13).
 *
 * What is deterministic about the compiled PDF, drawn in the reader's
 * language: one line per PRESENT fact, and nothing a reader could mistake for
 * a finding. These read the DOM `pdfFactsBlock` builds, in both locales.
 */
import type { ReviewPdfRecord } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  pageRuns,
  pdfFactsBlock,
} from "../src/webview/parts/review-pdf-facts.js";
import { tr } from "../src/webview/parts/strings.js";

/** The cli fixture's defective twin, as T7's driver records it. */
const FULL: ReviewPdfRecord = {
  source: "compiled",
  facts: {
    pages: 3,
    pageSize: { width: 595.28, height: 841.89, name: "a4" },
    referencesStart: 3,
    mainTextPages: 2,
    author: "A. Fixture",
    overfull: { hboxes: 3, vboxes: 1 },
    smallestText: [
      { page: 2, sizePt: 9 },
      { page: 1, sizePt: 5 },
      { page: 3, sizePt: 5 },
    ],
    venue: {
      id: "acm-sigconf",
      pageLimit: {
        value: 9,
        unit: "pages",
        note: "excl. references; check your CFP",
      },
      anonymity: "double_blind",
    },
  },
  viewed: [1, 2, 3],
};

/** The least a record can hold: a page count and a size, and where it came
 *  from. */
const BARE: ReviewPdfRecord = {
  source: "beside_entry",
  path: "main.pdf",
  facts: { pages: 1, pageSize: { width: 612, height: 792, name: "letter" } },
};

const facts = (pdf: ReviewPdfRecord, locale: "en" | "zh" = "en") =>
  pdfFactsBlock(locale, pdf);
const lineOf = (block: HTMLElement, fact: string): string | undefined =>
  block.querySelector(`[data-fact="${fact}"]`)?.textContent ?? undefined;
const factsIn = (block: HTMLElement): string[] =>
  [...block.querySelectorAll("[data-fact]")].map(
    (n) => n.getAttribute("data-fact") ?? "",
  );

describe("the facts block draws one line per present fact (O18)", () => {
  it("is titled, and draws every fact the record holds, in a fixed order", () => {
    const block = facts(FULL);
    expect(block.querySelector(".lm-review-pdffacts__title")?.textContent).toBe(
      "About the compiled PDF",
    );
    expect(factsIn(block)).toEqual([
      "pages",
      "references",
      "author",
      "overfull",
      "smallest",
      "source",
      "viewed",
    ]);
  });

  it("draws only what is there — no author, no overfull, no smallest text, no viewed line", () => {
    const block = facts(BARE);
    expect(factsIn(block)).toEqual(["pages", "references", "source"]);
  });

  it("is facts, not findings: no button, no link, no severity glyph, no id", () => {
    const block = facts(FULL);
    expect(block.querySelectorAll("button, a, select, input")).toHaveLength(0);
    expect(block.textContent).not.toMatch(/[○⚠✗]/);
    expect(block.querySelector("[data-concern]")).toBeNull();
    expect(block.querySelector(".lm-cite-row")).toBeNull();
  });

  it("is built from nodes, never parsed from a string (ADR 0039 §5)", () => {
    // `check-webview-innerhtml.mjs` guards the source; this guards the value a
    // third-party field reaches the DOM as: text, however it is spelled.
    const block = facts({
      ...FULL,
      facts: { ...FULL.facts, author: "<b>A. Fixture</b>" },
    });
    expect(block.querySelector("b")).toBeNull();
    expect(lineOf(block, "author")).toContain("<b>A. Fixture</b>");
  });
});

describe("the page count and the paper size (O18)", () => {
  it("names A4 and Letter, in whole points", () => {
    expect(lineOf(facts(FULL), "pages")).toBe("3 pages · A4 (595 × 842 pt)");
    expect(lineOf(facts(BARE), "pages")).toBe("1 page · Letter (612 × 792 pt)");
  });

  it("names nothing for any other size — it gives the dimensions alone", () => {
    const block = facts({
      ...BARE,
      facts: { pages: 2, pageSize: { width: 842, height: 595 } },
    });
    expect(lineOf(block, "pages")).toBe("2 pages · page size 842 × 595 pt");
  });

  it("says each in Chinese", () => {
    expect(lineOf(facts(FULL, "zh"), "pages")).toBe(
      "共 3 页 · A4（595 × 842 pt）",
    );
    expect(lineOf(facts(BARE, "zh"), "pages")).toBe(
      "共 1 页 · Letter（612 × 792 pt）",
    );
    expect(
      lineOf(
        facts(
          {
            ...BARE,
            facts: { pages: 2, pageSize: { width: 842, height: 595 } },
          },
          "zh",
        ),
        "pages",
      ),
    ).toBe("共 2 页 · 页面尺寸 842 × 595 pt");
  });
});

describe("the references and the venue's page limit (O18)", () => {
  it("says where the references begin and how long the main text runs, against the limit, quoting the note as authored", () => {
    expect(lineOf(facts(FULL), "references")).toBe(
      "references begin on page 3 — main text 2 pages of a 9-page limit (excl. references; check your CFP)",
    );
  });

  it("says so in Chinese, the venue's note passing through as authored", () => {
    expect(lineOf(facts(FULL, "zh"), "references")).toBe(
      "参考文献从第 3 页开始——正文 2 页（页数上限 9 页：excl. references; check your CFP）",
    );
  });

  it("says a one-page main text in the singular", () => {
    const block = facts({
      ...FULL,
      facts: { ...FULL.facts, referencesStart: 2, mainTextPages: 1 },
    });
    expect(lineOf(block, "references")).toMatch(
      /^references begin on page 2 — main text 1 page of a 9-page limit/,
    );
  });

  it("draws the limit bare when the venue gives no note", () => {
    const block = facts({
      ...FULL,
      facts: {
        ...FULL.facts,
        venue: { id: "x", pageLimit: { value: 8, unit: "pages" } },
      },
    });
    expect(lineOf(block, "references")).toBe(
      "references begin on page 3 — main text 2 pages of a 8-page limit",
    );
  });

  it("draws no limit that is not in pages — a word limit does not compare with a page count", () => {
    const block = facts({
      ...FULL,
      facts: {
        ...FULL.facts,
        venue: { id: "x", pageLimit: { value: 6000, unit: "words" } },
      },
    });
    expect(lineOf(block, "references")).toBe(
      "references begin on page 3 — main text 2 pages",
    );
    expect(block.textContent).not.toContain("6000");
  });

  it("says no heading was found, and puts the limit beside the whole count instead", () => {
    const block = facts({
      ...FULL,
      facts: {
        pages: 4,
        pageSize: FULL.facts.pageSize,
        venue: FULL.facts.venue,
      },
    });
    expect(lineOf(block, "references")).toBe("no references heading found");
    expect(lineOf(block, "pages")).toBe(
      "4 pages of a 9-page limit (excl. references; check your CFP) · A4 (595 × 842 pt)",
    );
  });
});

describe("the author the metadata names (O18)", () => {
  it("quotes the author as authored", () => {
    const block = facts({
      ...FULL,
      facts: { ...FULL.facts, venue: { id: "x" } },
    });
    expect(lineOf(block, "author")).toBe(
      "author named in the PDF's metadata: A. Fixture",
    );
  });

  it("adds that the venue is double-blind, when it is", () => {
    expect(lineOf(facts(FULL), "author")).toBe(
      "author named in the PDF's metadata: A. Fixture · the venue is double-blind",
    );
    expect(lineOf(facts(FULL, "zh"), "author")).toBe(
      `PDF 元数据中署名作者：A. Fixture · ${tr("zh", "rPdfAuthorBlind")}`,
    );
  });

  it("does not for a single-blind venue", () => {
    const block = facts({
      ...FULL,
      facts: {
        ...FULL.facts,
        venue: { id: "x", anonymity: "single_blind" },
      },
    });
    expect(lineOf(block, "author")).not.toContain("double-blind");
  });

  it("keeps a `$&` in the author as text", () => {
    const block = facts({
      ...FULL,
      facts: { ...FULL.facts, author: "$& {note} $1", venue: undefined },
    });
    expect(lineOf(block, "author")).toBe(
      "author named in the PDF's metadata: $& {note} $1",
    );
  });
});

describe("the overfull boxes and the smallest text (O18)", () => {
  it("counts the overfull boxes by direction", () => {
    expect(lineOf(facts(FULL), "overfull")).toBe(
      "overfull boxes: 3 horizontal, 1 vertical",
    );
    expect(lineOf(facts(FULL, "zh"), "overfull")).toBe(
      "溢出盒子：横向 3 个，纵向 1 个",
    );
  });

  it("names the global minimum and its first page, to a tenth of a point", () => {
    expect(lineOf(facts(FULL), "smallest")).toBe(
      "smallest text: 5.0 pt on page 1",
    );
    expect(lineOf(facts(FULL, "zh"), "smallest")).toBe(
      "最小文字：第 1 页 5.0 pt",
    );
  });

  it("draws no smallest-text line for an empty list", () => {
    const block = facts({
      ...FULL,
      facts: { ...FULL.facts, smallestText: [] },
    });
    expect(lineOf(block, "smallest")).toBeUndefined();
  });
});

describe("where the PDF came from (O18)", () => {
  it("says it was compiled for this review", () => {
    expect(lineOf(facts(FULL), "source")).toBe("compiled for this review");
    expect(lineOf(facts(FULL, "zh"), "source")).toBe("为本次评审编译");
  });

  it("names a found PDF by its path, newer than the manuscript", () => {
    for (const source of ["beside_entry", "output_dir"] as const) {
      const block = facts({ ...BARE, source, path: "out/main.pdf" });
      expect(lineOf(block, "source")).toBe(
        "out/main.pdf, newer than the manuscript",
      );
    }
    expect(
      lineOf(facts({ ...BARE, path: "out/main.pdf" }, "zh"), "source"),
    ).toBe("out/main.pdf，比手稿更新");
  });

  it("names a PDF named in settings, and says when it is older than the manuscript", () => {
    const named: ReviewPdfRecord = {
      ...BARE,
      source: "named",
      path: "build/paper.pdf",
    };
    expect(lineOf(facts(named), "source")).toBe(
      "build/paper.pdf, named in settings",
    );
    expect(lineOf(facts({ ...named, stale: true }), "source")).toBe(
      "build/paper.pdf, named in settings · older than the manuscript",
    );
    expect(lineOf(facts({ ...named, stale: true }, "zh"), "source")).toBe(
      "build/paper.pdf，由设置指定 · 比手稿旧",
    );
  });
});

describe("the pages the PDF reviewer viewed (O18)", () => {
  it("draws them as runs, against the page count", () => {
    expect(lineOf(facts(FULL), "viewed")).toBe(
      "pages viewed by the PDF reviewer: 1–3 of 3",
    );
    expect(lineOf(facts(FULL, "zh"), "viewed")).toBe(
      "PDF 评审人查看的页面：1–3 / 3",
    );
  });

  it("breaks the runs where pages were skipped", () => {
    expect(pageRuns("en", [1, 3, 4, 7])).toBe("1, 3–4, 7");
    expect(pageRuns("zh", [4, 3, 1])).toBe("1、3–4");
    expect(pageRuns("en", [2])).toBe("2");
    expect(pageRuns("en", [])).toBe("0");
  });

  it("draws no viewed line when no PDF reviewer ran", () => {
    expect(lineOf(facts({ ...FULL, viewed: undefined }), "viewed")).toBe(
      undefined,
    );
  });
});

describe("the facts block is one language per reader (O18, invariant 6)", () => {
  it("says nothing in English to a Chinese reader but the third-party values and the units", () => {
    // The author, the note and the paper-size names pass as authored; `pt`,
    // `PDF`, `A4` and `Letter` are the units and names the zh table itself
    // uses. Nothing else in the block may be Latin.
    const zh = (facts(FULL, "zh").textContent ?? "")
      .replace("A. Fixture", "")
      .replace("excl. references; check your CFP", "")
      .replace(/\b(pt|PDF|A4|Letter)\b/g, "");
    expect(zh).not.toMatch(/[A-Za-z]{2,}/);
  });

  it("says nothing in Chinese to an English reader", () => {
    expect(facts(FULL, "en").textContent).not.toMatch(/[一-鿿]/);
  });
});
