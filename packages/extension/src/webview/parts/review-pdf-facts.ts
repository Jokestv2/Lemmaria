/**
 * The facts block (V4, ADR 0081 §1; plan D13): what is DETERMINISTIC about
 * the compiled PDF a review read, drawn in the reader's language.
 *
 * A block of facts, deliberately not a list of concerns — no severity, no id,
 * no action. The harness measured every value here before any model ran
 * (`pdf-facts.ts`), and a seat that thinks one of them is a problem files a
 * concern about it, anchored at the source line that causes it. So nothing
 * here invites a click: the reader compares a number against their venue's
 * rule, and the concern groups below are where anything is done about it.
 *
 * Pure in ADR 0037's sense: the locale and the record are arguments, strings
 * come from `strings.ts`, and the DOM is built with `el()` only — the webview
 * renders under a CSP with no string-to-DOM parsing (ADR 0039 §5).
 *
 * Third-party values — the PDF's author, a venue's note, a path — pass as
 * authored (invariant 6's boundary). They are filled in by one pass with a
 * replacer function, so a `$&` or a `{note}` inside one stays text.
 */
import type { ReviewPdfRecord, SessionLocale } from "@lemmaria/harness";
import { el } from "./rows.js";
import { type StringKey, tr } from "./strings.js";

/** One sentence, every `{slot}` filled at once. Single-pass on purpose: a
 *  sequential fill would substitute into a value an earlier slot inserted. */
function fill(
  locale: SessionLocale,
  key: StringKey,
  slots: Record<string, string | number>,
): string {
  return tr(locale, key).replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = slots[name];
    return value === undefined ? whole : String(value);
  });
}

/** A page dimension as the facts record names it: whole points. The
 *  harness's own brief rounds the same way, so the two cannot disagree. */
const pt = (n: number): string => `${Math.round(n)}`;

/** The pages the PDF reviewer viewed, as runs — `1–3`, `1, 3–4`. Ascending
 *  is the record's promise; sorted again here so a hand-built one reads the
 *  same. The list separator is the reader's (`rListSep`). */
export function pageRuns(
  locale: SessionLocale,
  pages: readonly number[],
): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "0";
  const runs: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const page of [...sorted.slice(1), Number.NaN]) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = page;
    prev = page;
  }
  return runs.join(tr(locale, "rListSep"));
}

/** The venue's page limit, when it is one in PAGES — a limit in words or
 *  characters is not comparable with a page count, and the line compares. */
function pageLimit(
  locale: SessionLocale,
  pdf: ReviewPdfRecord,
): string | undefined {
  const limit = pdf.facts.venue?.pageLimit;
  if (limit === undefined || !/^pages?$/i.test(limit.unit.trim()))
    return undefined;
  return limit.note !== undefined && limit.note.trim() !== ""
    ? fill(locale, "rPdfLimit", { limit: limit.value, note: limit.note })
    : fill(locale, "rPdfLimitBare", { limit: limit.value });
}

/** Where the PDF came from, and — by exception — that it is older than the
 *  manuscript (only a PDF named in settings is ever used stale). */
function sourceLine(locale: SessionLocale, pdf: ReviewPdfRecord): string {
  const path = pdf.path ?? "";
  const where =
    pdf.source === "compiled"
      ? tr(locale, "rPdfSourceCompiled")
      : pdf.source === "named"
        ? fill(locale, "rPdfSourceNamed", { path })
        : fill(locale, "rPdfSourceFound", { path });
  return pdf.stale === true
    ? `${where} · ${tr(locale, "rPdfSourceStale")}`
    : where;
}

/**
 * The block. One line per PRESENT fact, in a fixed order: the pages and the
 * paper size; where the references begin (or that no heading was found —
 * that absence is itself the fact, as the harness's brief says) with the
 * venue's page limit beside the count it limits; the author the metadata
 * names; the compile log's overfull boxes; the smallest text and its page;
 * where the PDF came from; and the pages the PDF reviewer viewed, when one
 * ran.
 */
export function pdfFactsBlock(
  locale: SessionLocale,
  pdf: ReviewPdfRecord,
): HTMLElement {
  const { facts } = pdf;
  const block = el("div", { class: "lm-review-pdffacts" });
  block.append(
    el("div", { class: "lm-review-pdffacts__title" }, tr(locale, "rPdfFacts")),
  );
  const line = (fact: string, text: string): void => {
    block.append(
      el("div", { class: "lm-review-pdffacts__line", "data-fact": fact }, text),
    );
  };

  const limit = pageLimit(locale, pdf);
  const mainText =
    facts.referencesStart !== undefined && facts.mainTextPages !== undefined;

  // The pages and the size. The venue's limit sits here only when the main
  // text could not be told apart from the references — a limit beside the
  // whole count is still a comparison the reader can make.
  const pages =
    facts.pages === 1
      ? tr(locale, "rPdfPagesOne")
      : fill(locale, "rPdfPages", { n: facts.pages });
  const { width, height, name } = facts.pageSize;
  const size = fill(
    locale,
    name === "a4"
      ? "rPdfSizeA4"
      : name === "letter"
        ? "rPdfSizeLetter"
        : "rPdfSizeOther",
    { w: pt(width), h: pt(height) },
  );
  line(
    "pages",
    `${pages}${!mainText && limit !== undefined ? limit : ""} · ${size}`,
  );

  if (mainText) {
    line(
      "references",
      `${fill(
        locale,
        facts.mainTextPages === 1 ? "rPdfReferencesOne" : "rPdfReferences",
        {
          page: facts.referencesStart as number,
          n: facts.mainTextPages as number,
        },
      )}${limit ?? ""}`,
    );
  } else {
    line("references", tr(locale, "rPdfReferencesNone"));
  }

  if (facts.author !== undefined) {
    const blind =
      facts.venue?.anonymity === "double_blind"
        ? ` · ${tr(locale, "rPdfAuthorBlind")}`
        : "";
    line(
      "author",
      `${fill(locale, "rPdfAuthor", { author: facts.author })}${blind}`,
    );
  }

  if (facts.overfull !== undefined) {
    line(
      "overfull",
      fill(locale, "rPdfOverfull", {
        h: facts.overfull.hboxes,
        v: facts.overfull.vboxes,
      }),
    );
  }

  // The GLOBAL minimum and its page — the first such page on a tie. The
  // per-page list is the PDF reviewer's brief's, not the reader's.
  let smallest: { page: number; sizePt: number } | undefined;
  for (const s of facts.smallestText ?? []) {
    if (smallest === undefined || s.sizePt < smallest.sizePt) smallest = s;
  }
  if (smallest !== undefined) {
    line(
      "smallest",
      fill(locale, "rPdfSmallestText", {
        pt: smallest.sizePt.toFixed(1),
        page: smallest.page,
      }),
    );
  }

  line("source", sourceLine(locale, pdf));

  if (pdf.viewed !== undefined) {
    line(
      "viewed",
      fill(locale, "rPdfViewed", {
        viewed: pageRuns(locale, pdf.viewed),
        total: facts.pages,
      }),
    );
  }
  return block;
}
