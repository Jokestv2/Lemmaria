import { describe, expect, it } from "vitest";
import type { PdfDocument, Warning } from "../../src/contracts/index.js";
import {
  PAGE_SIZE_TOLERANCE_PT,
  REFERENCES_HEADINGS,
  SMALL_TEXT_MIN_CHARS,
  computePdfFacts,
  describePdfFacts,
} from "../../src/engine/pdf-facts.js";

/** A fake document: every page's text, its size groups, and page 1's size. */
function fakeDoc(opts: {
  pages?: string[];
  sizes?: Array<Array<{ sizePt: number; chars: number }>>;
  pageSize?: { width: number; height: number };
  author?: string;
}): PdfDocument {
  const pages = opts.pages ?? ["Body text."];
  return {
    pageCount: pages.length,
    pageSize: () => opts.pageSize ?? { width: 612, height: 792 },
    renderPage: async () => ({ png: new Uint8Array(), width: 1, height: 1 }),
    pageText: async (page) => pages[page - 1] ?? "",
    pageTextSizes: async (page) => opts.sizes?.[page - 1] ?? [],
    metadata: async () =>
      opts.author !== undefined ? { author: opts.author } : {},
    close: () => {},
  };
}

const warning = (code: string): Warning => ({
  id: code,
  source: "latexmk",
  severity: "warning",
  code,
  message: code,
  file: "main.tex",
});

describe("computePdfFacts — pages and page size (V4, D3, O4)", () => {
  it("names A4 and Letter within the tolerance, and states the points always", async () => {
    const a4 = await computePdfFacts({
      document: fakeDoc({ pageSize: { width: 595.28, height: 841.89 } }),
    });
    expect(a4.pageSize).toEqual({ width: 595.28, height: 841.89, name: "a4" });
    const letter = await computePdfFacts({
      document: fakeDoc({ pageSize: { width: 613.5, height: 790.5 } }),
    });
    expect(letter.pageSize.name).toBe("letter");
    expect(PAGE_SIZE_TOLERANCE_PT).toBe(2);
    const off = await computePdfFacts({
      document: fakeDoc({ pageSize: { width: 612 + 2.5, height: 792 } }),
    });
    expect(off.pageSize.name).toBeUndefined();
    expect(off.pageSize.width).toBe(614.5);
  });

  it("names nothing for a landscape first page", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({ pageSize: { width: 792, height: 612 } }),
    });
    expect(facts.pageSize).toEqual({ width: 792, height: 612 });
  });

  it("counts the pages", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({ pages: ["a", "b", "c"] }),
    });
    expect(facts.pages).toBe(3);
  });
});

describe("computePdfFacts — where the references begin (V4, D3, O4)", () => {
  it("knows the three headings", () => {
    expect([...REFERENCES_HEADINGS]).toEqual([
      "references",
      "bibliography",
      "参考文献",
    ]);
  });

  it("counts the heading's page when prose sits above it", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: [
          "Intro text",
          "More text\r\nThe end of the conclusion.\r\nReferences\r\n[1] A. Author.",
        ],
      }),
    });
    expect(facts.referencesStart).toBe(2);
    expect(facts.mainTextPages).toBe(2);
  });

  it("does not count the heading's page when the heading opens it", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: ["p1", "p2", "\r\n  6 References  \r\n[1] Someone."],
      }),
    });
    expect(facts.referencesStart).toBe(3);
    expect(facts.mainTextPages).toBe(2);
  });

  it("accepts a numbered or lettered heading, and the Chinese heading", async () => {
    for (const heading of [
      "References",
      "REFERENCES",
      "7 References",
      "7. References",
      "A. Bibliography",
      "Bibliography",
      "参考文献",
      "8 参考文献",
    ]) {
      const facts = await computePdfFacts({
        document: fakeDoc({ pages: ["body", `text\n${heading}\n[1] x`] }),
      });
      expect(facts.referencesStart, heading).toBe(2);
    }
  });

  it("finds nothing in running prose that merely mentions the word", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: [
          "See the references below for details.",
          "references to prior work",
        ],
      }),
    });
    expect(facts.referencesStart).toBeUndefined();
    expect(facts.mainTextPages).toBeUndefined();
  });

  it("takes the FIRST page that holds a heading", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({ pages: ["x", "References\n[1]", "References"] }),
    });
    expect(facts.referencesStart).toBe(2);
  });
});

describe("computePdfFacts — a references page under line numbers and a running head (J1's round, ADR 0082 §4, O33)", () => {
  /** `acmart`'s `review` line numbers: digit-only lines, which PDFium emits
   *  ahead of the page's text, the head part-way through them. */
  const numbers = (from: number, to: number): string =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join(
      "\n",
    );
  /** acmart's twoside heads, as J1's paper printed them. */
  const ODD_HEAD =
    "PrismGPT: A Short Title ACM MM '26, November 2026, Rio de Janeiro, Brazil";
  const EVEN_HEAD = "ACM MM '26, November 2026, Rio de Janeiro, Brazil Anon.";
  /** One page as the real PDF reads: numbers, the head, numbers, the text. */
  const page = (head: string | undefined, text: string): string =>
    [numbers(1, 58), ...(head ? [head] : []), numbers(59, 116), text].join(
      "\n",
    );
  const body = (n: number): string =>
    `Section ${n} prose runs here.\nIt continues on this page.`;

  it("does not count a references page that opens under them — J1's nine pages", async () => {
    const pages = [
      page(undefined, `Title\nAbstract\n${body(1)}`),
      ...[2, 3, 4, 5, 6, 7, 8].map((p) =>
        page(
          p % 2 === 0 ? EVEN_HEAD : ODD_HEAD,
          p === 8 ? "6 Conclusion\nThe conclusion ends here." : body(p),
        ),
      ),
      page(ODD_HEAD, "References\n[1] A. Author. 2024. A paper."),
    ];
    const facts = await computePdfFacts({ document: fakeDoc({ pages }) });
    expect(facts.referencesStart).toBe(9);
    expect(facts.mainTextPages).toBe(8);
  });

  it("knows a head by the venue it shares with the other parity's, on a paper too short to repeat it", async () => {
    // On three pages the references page's odd head recurs nowhere verbatim;
    // the even head on page 2 carries the same venue line.
    const pages = [
      page(undefined, `Title\n${body(1)}`),
      page(EVEN_HEAD, body(2)),
      page(ODD_HEAD, "References\n[1] A. Author."),
    ];
    const facts = await computePdfFacts({ document: fakeDoc({ pages }) });
    expect(facts.referencesStart).toBe(3);
    expect(facts.mainTextPages).toBe(2);
  });

  it("still counts the page when prose sits above the heading, under the same furniture", async () => {
    const pages = [
      page(undefined, body(1)),
      page(EVEN_HEAD, body(2)),
      page(
        ODD_HEAD,
        "the last paragraph of the conclusion ends here.\nReferences\n[1] A. Author.",
      ),
    ];
    const facts = await computePdfFacts({ document: fakeDoc({ pages }) });
    expect(facts.referencesStart).toBe(3);
    expect(facts.mainTextPages).toBe(3);
  });

  it("counts the page when its head recurs nowhere — the direction that never hides a page", async () => {
    const pages = [
      page(undefined, body(1)),
      page(
        "An unrepeated heading line of its own",
        "References\n[1] A. Author.",
      ),
    ];
    const facts = await computePdfFacts({ document: fakeDoc({ pages }) });
    expect(facts.mainTextPages).toBe(2);
  });

  it("does not take a short line that happens to recur for a head", async () => {
    // "Results" tops page 2 and sits above the heading on page 3: prose.
    const pages = [
      page(undefined, body(1)),
      page(undefined, "Results\nThe numbers follow."),
      page(undefined, "Results\nReferences\n[1] A. Author."),
    ];
    const facts = await computePdfFacts({ document: fakeDoc({ pages }) });
    expect(facts.mainTextPages).toBe(3);
  });

  it("skips page numbers alone, with no head at all", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: ["body\n1", "more body\n2", "3\nReferences\n[1] A. Author."],
      }),
    });
    expect(facts.mainTextPages).toBe(2);
  });

  /** Nine pages whose references page holds `spill` between its head and the
   *  heading — a conclusion that ran one line over — and whose other pages'
   *  top lines hold `tops` (page number → first line of prose). */
  const spilled = (spill: string, tops: Record<number, string>): string[] => [
    page(undefined, `Title\nAbstract\n${body(1)}`),
    ...[2, 3, 4, 5, 6, 7, 8].map((p) =>
      page(
        p % 2 === 0 ? EVEN_HEAD : ODD_HEAD,
        `${tops[p] ?? `Section ${p} prose runs here.`}\nIt continues on this page.`,
      ),
    ),
    page(ODD_HEAD, `${spill}\nReferences\n[1] A. Author. 2024. A paper.`),
  ];

  it("counts the page when a spilled line shares a phrase with another page's top line — the code review's repro", async () => {
    // " other large language models " is 29 characters: a run the head rule
    // accepted, though the line it came from is prose on both pages.
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: spilled(
          "results that generalize to other large language models families.",
          {
            4: "We compare against other large language models on the same benchmarks.",
          },
        ),
      }),
    });
    expect(facts.referencesStart).toBe(9);
    expect(facts.mainTextPages).toBe(9);
  });

  it("counts it when the phrase is shared only because digits are masked", async () => {
    // "as shown in Figure 4" and "as shown in Figure 2" mask to one run.
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: spilled("consistent with the trend as shown in Figure 4.", {
          6: "The ablation, as shown in Figure 2, isolates each component we add.",
        }),
      }),
    });
    expect(facts.mainTextPages).toBe(9);
  });

  it("counts it when the spilled line is short and almost all shared phrase", async () => {
    // Most of the SHORT line is the shared run, so a rule measured against the
    // shorter line would take it for a head; the other page's line is prose.
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: spilled("of large language models.", {
          4: "We compare against other large language models on the same benchmarks.",
        }),
      }),
    });
    expect(facts.mainTextPages).toBe(9);
  });

  it("never takes more than three lines above the heading for furniture", async () => {
    const lines = [
      "Alpha line that repeats itself",
      "Beta line that repeats itself",
      "Gamma line that repeats itself",
    ];
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: [
          lines.join("\n"),
          [...lines, lines[0], "References", "[1] A. Author."].join("\n"),
        ],
      }),
    });
    expect(facts.mainTextPages).toBe(2);
  });

  it("never takes a line longer than a running head for one", async () => {
    const long = `A line far longer than any running head ${"and so on ".repeat(20)}`;
    expect(long.length).toBeGreaterThan(200);
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: [`${long}\nbody`, `${long}\nReferences\n[1] A. Author.`],
      }),
    });
    expect(facts.mainTextPages).toBe(2);
  });
});

describe("computePdfFacts — author, overfull boxes, venue (V4, D3, O4)", () => {
  it("passes the metadata author through as authored, and omits an empty one", async () => {
    const named = await computePdfFacts({
      document: fakeDoc({ author: "A. Fixture；张三" }),
    });
    expect(named.author).toBe("A. Fixture；张三");
    const blank = await computePdfFacts({
      document: fakeDoc({ author: "  " }),
    });
    expect(blank.author).toBeUndefined();
    const none = await computePdfFacts({ document: fakeDoc({}) });
    expect("author" in none).toBe(false);
  });

  it("counts overfull boxes from the warnings, and says nothing without a log", async () => {
    const facts = await computePdfFacts({
      document: fakeDoc({}),
      warnings: [
        warning("overfull-hbox"),
        warning("overfull-hbox"),
        warning("overfull-vbox"),
        warning("underfull-hbox"),
        warning("undefined-ref"),
      ],
    });
    expect(facts.overfull).toEqual({ hboxes: 2, vboxes: 1 });
    const clean = await computePdfFacts({
      document: fakeDoc({}),
      warnings: [],
    });
    expect(clean.overfull).toEqual({ hboxes: 0, vboxes: 0 });
    const noLog = await computePdfFacts({ document: fakeDoc({}) });
    expect("overfull" in noLog).toBe(false);
  });

  it("copies the venue through", async () => {
    const venue = {
      id: "acm-sigconf",
      pageLimit: { value: 9, unit: "pages", note: "excl. references" },
      anonymity: "double_blind" as const,
    };
    const facts = await computePdfFacts({ document: fakeDoc({}), venue });
    expect(facts.venue).toEqual(venue);
  });
});

describe("computePdfFacts — the smallest text on each page (V4, D3, O4)", () => {
  it("takes, per page, the smallest size set with enough characters to count", async () => {
    expect(SMALL_TEXT_MIN_CHARS).toBe(10);
    const facts = await computePdfFacts({
      document: fakeDoc({
        pages: ["a", "b", "c"],
        sizes: [
          [
            { sizePt: 3, chars: 2 }, // a stray superscript does not set it
            { sizePt: 5, chars: 95 },
            { sizePt: 10.9, chars: 1800 },
          ],
          [{ sizePt: 9, chars: 9 }], // nothing counts on this page
          [
            { sizePt: 8, chars: 10 },
            { sizePt: 10.9, chars: 80 },
          ],
        ],
      }),
    });
    expect(facts.smallestText).toEqual([
      { page: 1, sizePt: 5 },
      { page: 3, sizePt: 8 },
    ]);
  });

  it("omits the fact when no page has countable text", async () => {
    const facts = await computePdfFacts({ document: fakeDoc({ sizes: [[]] }) });
    expect("smallestText" in facts).toBe(false);
  });
});

describe("describePdfFacts — the seat's facts sentence (V4, D3, O4)", () => {
  const facts = {
    pages: 12,
    pageSize: { width: 595.28, height: 841.89, name: "a4" as const },
    referencesStart: 10,
    mainTextPages: 9,
    author: "A. Fixture",
    overfull: { hboxes: 3, vboxes: 1 },
    smallestText: [
      { page: 1, sizePt: 5 },
      { page: 2, sizePt: 10.9 },
    ],
    venue: {
      id: "acm-sigconf",
      pageLimit: { value: 9, unit: "pages", note: "excl. references" },
      anonymity: "double_blind" as const,
    },
  };

  it("states every present fact, and names where the PDF came from last", () => {
    const text = describePdfFacts(facts, { source: "compiled" });
    for (const needle of [
      "12 pages",
      "A4",
      "595 × 842 pt",
      "page 10",
      "9 pages",
      "acm-sigconf",
      "excl. references",
      "double-blind",
      "A. Fixture",
      "3 overfull horizontal",
      "1 overfull vertical",
      "page 1: 5.0 pt",
      "page 2: 10.9 pt",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(text.trim().endsWith("The PDF was compiled for this review.")).toBe(
      true,
    );
  });

  it("names a found PDF's path, and a named one's staleness", () => {
    expect(
      describePdfFacts(facts, { source: "output_dir", path: "out/main.pdf" }),
    ).toContain("The PDF is `out/main.pdf`, newer than every manuscript file.");
    expect(
      describePdfFacts(facts, {
        source: "named",
        path: "paper.pdf",
        stale: true,
      }),
    ).toContain(
      "The PDF is `paper.pdf`, the file named in the workspace settings; it is older than the manuscript.",
    );
  });

  it("says when no references heading was found, and states nothing absent", () => {
    const text = describePdfFacts(
      { pages: 2, pageSize: { width: 500, height: 700 } },
      { source: "beside_entry", path: "main.pdf" },
    );
    expect(text).toContain("500 × 700 pt");
    expect(text).toContain("No references heading was found");
    expect(text).not.toContain("author");
    expect(text).not.toContain("overfull");
    expect(text).not.toContain("venue");
  });

  it("is written with no word that invites a number to be judged, and names no model", () => {
    const text = describePdfFacts(facts, {
      source: "named",
      path: "p.pdf",
      stale: true,
    });
    expect(text).not.toMatch(
      /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i,
    );
    expect(text).not.toMatch(/gpt|claude|model/i);
  });
});
