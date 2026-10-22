/**
 * What is DETERMINISTIC about a compiled paper (V4, ADR 0081 §1).
 *
 * Computed before any model runs, from the opened `PdfDocument`, the compile
 * log's warnings and the venue the host matched — and nothing else. S6
 * measured that page size and font size are facts in the PDF, not things a
 * model should be asked to see; here they are read, not guessed.
 *
 * **Facts, not findings.** Nothing here raises a concern: a harness-authored
 * concern would be the harness supplying an opinion, which the ledger has
 * never done. The PDF reviewer is handed these as text and may file a concern
 * ABOUT one, anchored at the source line that causes it; the author sees them
 * in a block of their own either way.
 *
 * **This file is inside the v0.3 stage guard's scope** (`test/no-*.test.ts`):
 * `describePdfFacts` is model-facing English (invariant 6 rule 3), and a
 * sentence that invited a number to be judged would fail a test before it
 * reached a model.
 */

import type { PdfDocument } from "../contracts/adapters.js";
import type {
  PdfFacts,
  ReviewPdfSource,
  ReviewVenue,
  Warning,
} from "../contracts/data.js";

/** The headings a references section opens with — the three S6 measured. A
 *  paper with another heading gets no `referencesStart`, and the block says
 *  so (a recorded limit). */
export const REFERENCES_HEADINGS = [
  "references",
  "bibliography",
  "参考文献",
] as const;

/** How many characters a size must set on a page before it counts as that
 *  page's smallest text — so a lone superscript or a stray glyph does not. */
export const SMALL_TEXT_MIN_CHARS = 10;

/** How far a page may be from A4 or Letter and still be named as it. */
export const PAGE_SIZE_TOLERANCE_PT = 2;

const NAMED_SIZES = [
  { name: "a4", width: 595.28, height: 841.89 },
  { name: "letter", width: 612, height: 792 },
] as const;

/**
 * A heading line: one of the three words, optionally preceded by a section
 * number (`6`, `6.1`) or a letter (`A`) and a separator. Matched against a
 * WHOLE trimmed line, so prose that merely mentions *the references* is not a
 * heading.
 */
const HEADING_LINE = new RegExp(
  `^(?:(?:\\d+(?:\\.\\d+)*|[a-z])[.:)]?\\s*)?(?:${REFERENCES_HEADINGS.join("|")})$`,
  "i",
);

export interface PdfFactsInput {
  document: PdfDocument;
  /** The compile log's warnings. Absent ⇒ no log was available, and the
   *  overfull fact is absent rather than zero. */
  warnings?: readonly Warning[];
  venue?: ReviewVenue;
}

export async function computePdfFacts(input: PdfFactsInput): Promise<PdfFacts> {
  const { document } = input;
  const size = document.pageSize(1);
  const named = NAMED_SIZES.find(
    (n) =>
      Math.abs(size.width - n.width) <= PAGE_SIZE_TOLERANCE_PT &&
      Math.abs(size.height - n.height) <= PAGE_SIZE_TOLERANCE_PT,
  );
  const facts: PdfFacts = {
    pages: document.pageCount,
    pageSize: {
      width: size.width,
      height: size.height,
      // Portrait only, by construction: a landscape page's width is compared
      // against a portrait height and cannot match.
      ...(named !== undefined ? { name: named.name } : {}),
    },
  };

  const references = await findReferences(document);
  if (references !== undefined) {
    facts.referencesStart = references.page;
    // The page that still holds prose above the heading counts as main text.
    facts.mainTextPages = references.opensPage
      ? references.page - 1
      : references.page;
  }

  const author = (await document.metadata()).author;
  // As authored — third-party text. Only an empty value is dropped.
  if (author !== undefined && author.trim() !== "") facts.author = author;

  if (input.warnings !== undefined) {
    facts.overfull = {
      hboxes: input.warnings.filter((w) => w.code === "overfull-hbox").length,
      vboxes: input.warnings.filter((w) => w.code === "overfull-vbox").length,
    };
  }

  const smallest: Array<{ page: number; sizePt: number }> = [];
  for (let page = 1; page <= document.pageCount; page++) {
    const counted = (await document.pageTextSizes(page)).filter(
      (g) => g.chars >= SMALL_TEXT_MIN_CHARS,
    );
    if (counted.length === 0) continue;
    smallest.push({
      page,
      sizePt: Math.min(...counted.map((g) => g.sizePt)),
    });
  }
  if (smallest.length > 0) facts.smallestText = smallest;

  if (input.venue !== undefined) facts.venue = input.venue;
  return facts;
}

/** How many of a page's leading lines — digit-only ones aside — may hold its
 *  running head or foot (ADR 0082 §4). */
export const FURNITURE_LINES = 3;

/** A line equal to another page's leading line, digits masked, is furniture
 *  only from this length — so a short line that happens to repeat
 *  ("Results") stays prose. */
export const FURNITURE_MIN_CHARS = 12;

/** …or one sharing a run of characters this long with such a line: acmart's
 *  twoside heads differ by page parity but carry the same venue text. */
export const FURNITURE_SHARED_RUN = 20;

/** …provided that run is most of the OTHER page's line: a head recurs in a
 *  line that is itself mostly furniture (the heads the tests pin, 0.87–1.00),
 *  while a phrase two lines of prose share is a sliver of the line it came
 *  from (0.31–0.41) — however much of a short spilled line it fills. */
export const FURNITURE_SHARED_SHARE = 0.6;

/** A running head is short. A longer line is never furniture and never
 *  evidence of it, which also bounds the shared-run search. */
export const FURNITURE_MAX_CHARS = 200;

/** Line numbers and page numbers: `acmart`'s `review` option sets a column of
 *  them, and PDFium emits it ahead of the page's text. */
const DIGITS_ONLY = /^\d+$/;

/**
 * The first page holding a references heading, and whether the heading OPENS
 * it — no prose above it, once the page's furniture is set aside (ADR 0082
 * §4): digit-only lines, and a running head or foot that recurs among another
 * page's leading lines. Before J1's round only a heading on a page's very
 * first line opened it, so every `acmart` paper whose references start a page
 * was counted a page long — the head sits above the heading.
 *
 * It can err both ways, and is built to err the safe one. A head that recurs
 * on no other page is kept as prose and the page counts as main text, which
 * can overstate the main text by a page but never hides one. The unsafe way —
 * a line of prose taken for furniture, which would hide a page — is what the
 * bounds guard: at most `FURNITURE_LINES` lines above the heading, none longer
 * than a head, each recurring verbatim or in a line mostly made of it. Both
 * are recorded limits.
 */
async function findReferences(
  document: PdfDocument,
): Promise<{ page: number; opensPage: boolean } | undefined> {
  const pages: string[][] = [];
  for (let page = 1; page <= document.pageCount; page++) {
    pages.push(
      (await document.pageText(page))
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    );
  }
  const leading = pages.map((lines) =>
    lines
      .filter((l) => !DIGITS_ONLY.test(l))
      .slice(0, FURNITURE_LINES)
      .map(maskDigits),
  );
  for (const [index, lines] of pages.entries()) {
    const at = lines.findIndex((l) => HEADING_LINE.test(l));
    if (at < 0) continue;
    const above = lines.slice(0, at).filter((l) => !DIGITS_ONLY.test(l));
    const opensPage =
      above.length <= FURNITURE_LINES &&
      above.every((l) => isFurniture(maskDigits(l), leading, index));
    return { page: index + 1, opensPage };
  }
  return undefined;
}

/** Digit runs masked and spaces collapsed, so `Title 3` and `Title 5` are one
 *  running head. */
function maskDigits(line: string): string {
  return line.replace(/\d+/g, "#").replace(/\s+/g, " ");
}

/** Does `line`, already masked, recur among another page's leading lines? */
function isFurniture(
  line: string,
  leading: readonly string[][],
  own: number,
): boolean {
  if (line.length > FURNITURE_MAX_CHARS) return false;
  return leading.some(
    (lines, page) =>
      page !== own && lines.some((other) => recursIn(line, other)),
  );
}

/** `line` recurs in `other`: verbatim, or as a run that is most of `other`. */
function recursIn(line: string, other: string): boolean {
  if (other.length > FURNITURE_MAX_CHARS) return false;
  if (other === line) return line.length >= FURNITURE_MIN_CHARS;
  const need = Math.max(
    FURNITURE_SHARED_RUN,
    Math.ceil(FURNITURE_SHARED_SHARE * other.length),
  );
  return (
    Math.min(line.length, other.length) >= need &&
    sharedRun(line, other) >= need
  );
}

/** The length of the longest run of characters `a` and `b` share. */
function sharedRun(a: string, b: string): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const run = (previous[j - 1] ?? 0) + 1;
        current[j] = run;
        if (run > best) best = run;
      }
    }
    previous = current;
  }
  return best;
}

/** Points, as the brief and the block state them: whole numbers. */
const pt = (n: number): string => `${Math.round(n)}`;

/**
 * The facts as one English paragraph for the PDF reviewer's brief — every
 * present fact, one sentence each, where the PDF came from last. Nothing
 * absent is mentioned, except a references heading that was looked for and
 * not found, because that absence is itself the fact.
 */
export function describePdfFacts(
  facts: PdfFacts,
  source: { source: ReviewPdfSource; path?: string; stale?: true },
): string {
  const sentences: string[] = [];
  sentences.push(
    `The PDF has ${facts.pages} ${facts.pages === 1 ? "page" : "pages"}.`,
  );
  const dims = `${pt(facts.pageSize.width)} × ${pt(facts.pageSize.height)} pt`;
  sentences.push(
    facts.pageSize.name === "a4"
      ? `Its page size is A4 (${dims}).`
      : facts.pageSize.name === "letter"
        ? `Its page size is US Letter (${dims}).`
        : `Its page size is ${dims}.`,
  );
  if (
    facts.referencesStart !== undefined &&
    facts.mainTextPages !== undefined
  ) {
    sentences.push(
      `The references begin on page ${facts.referencesStart}, so the main text runs to ${facts.mainTextPages} ${facts.mainTextPages === 1 ? "page" : "pages"}.`,
    );
  } else {
    sentences.push(
      "No references heading was found in the PDF's text, so where the main text ends is not known.",
    );
  }
  const venue = facts.venue;
  if (venue !== undefined) {
    const parts = [`The venue is \`${venue.id}\``];
    if (venue.pageLimit !== undefined) {
      parts.push(
        `with a limit of ${venue.pageLimit.value} ${venue.pageLimit.unit}${
          venue.pageLimit.note !== undefined ? ` (${venue.pageLimit.note})` : ""
        }`,
      );
    }
    if (venue.anonymity === "double_blind")
      parts.push("and double-blind review");
    else if (venue.anonymity === "single_blind")
      parts.push("and single-blind review");
    sentences.push(`${parts.join(", ")}.`);
  }
  if (facts.author !== undefined) {
    sentences.push(
      `The PDF's metadata names an author: "${facts.author}".${
        venue?.anonymity === "double_blind"
          ? " The venue's review is double-blind."
          : ""
      }`,
    );
  }
  if (facts.overfull !== undefined) {
    const { hboxes, vboxes } = facts.overfull;
    sentences.push(
      `The compile log reports ${hboxes} overfull horizontal ${hboxes === 1 ? "box" : "boxes"} and ${vboxes} overfull vertical ${vboxes === 1 ? "box" : "boxes"}.`,
    );
  }
  if (facts.smallestText !== undefined) {
    sentences.push(
      `The smallest text set on each page, in points: ${facts.smallestText
        .map((s) => `page ${s.page}: ${s.sizePt.toFixed(1)} pt`)
        .join("; ")}.`,
    );
  }
  sentences.push(sourceSentence(source));
  return sentences.join(" ");
}

function sourceSentence(source: {
  source: ReviewPdfSource;
  path?: string;
  stale?: true;
}): string {
  switch (source.source) {
    case "compiled":
      return "The PDF was compiled for this review.";
    case "named":
      return `The PDF is \`${source.path ?? "the named file"}\`, the file named in the workspace settings${
        source.stale === true ? "; it is older than the manuscript." : "."
      }`;
    case "beside_entry":
    case "output_dir":
      return `The PDF is \`${source.path ?? "the compiled file"}\`, newer than every manuscript file.`;
  }
}
