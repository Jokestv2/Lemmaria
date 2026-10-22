import { posix } from "node:path";
import type {
  ReviewAnnotation,
  ReviewLimit,
  ReviewSpan,
} from "../contracts/data.js";
import type { ParsedLedger } from "./review.js";

/**
 * Where a float the PDF reviewer anchored actually sits (V4 gate-review round
 * 3, ADR 0084).
 *
 * The seat cites the page it saw a problem on, and on a real paper it cited
 * one page early in whole runs — with its page notes written (ADR 0082 §3) and
 * each image named on the wire (ADR 0083 §1). So the fix goes where every
 * other position in a review already comes from: the harness. A float's page
 * is not a guess. `\label` inside a float writes `\newlabel{key}{{number}
 * {page}…}` to the compile's `.aux` when the float ships out, which is the
 * float's page exactly; and the float's caption label in the PDF's own text on
 * that page confirms both that the `.aux` belongs to this PDF and that its
 * printed page is the physical one.
 *
 * Every step here says nothing rather than guess. An anchor outside a float, a
 * float with no label, a label the `.aux` lacks, a page that is not a plain
 * number of this PDF, a caption the page does not carry: each leaves the
 * seat's cite exactly as it was. Pure; the driver reads the files.
 */

/** One `\newlabel` of a compile's `.aux`. */
export interface AuxLabel {
  /** The counter as printed — `\thefigure`, so `2`, `I` or `3a`. */
  number: string;
  /** `\thepage` where the label shipped out: the PRINTED page, which is why
   *  `captionOnPage` confirms it against the physical one. */
  page: string;
}

const NEWLABEL = /^\\newlabel\{([^{}]+)\}\{\{([^{}]*)\}\{([^{}]*)\}/;

/**
 * `\newlabel{key}{{number}{page}…}` → key → its number and page, in both the
 * plain shape and hyperref's five-group one. Every other line is ignored, and
 * a label defined twice keeps its last definition, as LaTeX does.
 */
export function parseAuxLabels(aux: string): Map<string, AuxLabel> {
  const labels = new Map<string, AuxLabel>();
  for (const line of aux.split(/\r?\n/)) {
    const m = NEWLABEL.exec(line.trim());
    const [, key, number, page] = m ?? [];
    if (key === undefined || number === undefined || page === undefined) {
      continue;
    }
    labels.set(key, {
      number: number.replace(/\\relax\s*/g, "").trim(),
      page: page.trim(),
    });
  }
  return labels;
}

/** The float environments, starred and sideways included. `wrapfigure` is
 *  set where it stands rather than floated, and its `.aux` page is right too. */
const FLOAT_ENV =
  /\\(begin|end)\s*\{((?:sideways)?(?:figure|table)\*?|wrap(?:figure|table))\}/g;
const LABEL = /\\label\s*\{([^{}]+)\}/g;
const INPUT = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g;

/** A line with its comment cut, from the first `%` no backslash escapes. */
export function uncommented(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

/** A float environment in one file: its kind and the labels inside it. */
export interface FloatSite {
  kind: "figure" | "table";
  labels: string[];
}

/**
 * The float environment enclosing a 1-based `line` of `text` — its `\begin`
 * and `\end` lines included — or `undefined` when the line is in none. Floats
 * do not nest, so one pass pairing each `\begin` with its `\end` is the whole
 * parse; an unclosed one encloses nothing.
 */
export function enclosingFloat(
  text: string,
  line: number,
): FloatSite | undefined {
  const lines = text.split(/\r?\n/).map(uncommented);
  const at = line - 1;
  let open: { begin: number; env: string } | undefined;
  for (const [i, source] of lines.entries()) {
    for (const [, which, env] of source.matchAll(FLOAT_ENV)) {
      if (env === undefined) continue;
      if (which === "begin" && open === undefined) {
        open = { begin: i, env };
        continue;
      }
      if (which !== "end" || open === undefined || env !== open.env) continue;
      if (open.begin <= at && at <= i) {
        const labels: string[] = [];
        for (const inside of lines.slice(open.begin, i + 1)) {
          for (const [, key] of inside.matchAll(LABEL)) {
            if (key !== undefined) labels.push(key.trim());
          }
        }
        return {
          kind: open.env.includes("figure") ? "figure" : "table",
          labels,
        };
      }
      open = undefined;
    }
  }
  return undefined;
}

/** Where LaTeX finds an `\input`: beside the entry, `.tex` when unsuffixed. */
function resolveInput(arg: string, entry: string): string {
  let path = arg.trim().replace(/\\/g, "/");
  if (!/\.[A-Za-z]+$/.test(path)) path += ".tex";
  return posix.normalize(posix.join(posix.dirname(entry), path));
}

/** Every `\label` in a text, comments cut. */
function labelsIn(text: string): string[] {
  const labels: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const [, key] of uncommented(line).matchAll(LABEL)) {
      if (key !== undefined) labels.push(key.trim());
    }
  }
  return labels;
}

/** The float a span sits in: in its own file, or — one level up — the float
 *  a parent `\input`s its file from inside, the shape of a table kept in a
 *  file of its own. Then the whole child file is inside that float, so its
 *  own labels are the float's too (the `\caption` and `\label` may live in
 *  either file). */
function siteOf(
  span: ReviewSpan,
  files: ReadonlyMap<string, string>,
  entry: string,
): FloatSite | undefined {
  const text = files.get(span.file);
  if (text === undefined) return undefined;
  const own = enclosingFloat(text, span.line);
  if (own !== undefined) return own;
  const target = posix.normalize(span.file.replace(/\\/g, "/"));
  for (const [path, parent] of files) {
    if (path === span.file) continue;
    for (const [i, line] of parent.split(/\r?\n/).entries()) {
      for (const [, arg] of uncommented(line).matchAll(INPUT)) {
        if (arg === undefined || resolveInput(arg, entry) !== target) continue;
        const site = enclosingFloat(parent, i + 1);
        if (site !== undefined) {
          return {
            kind: site.kind,
            labels: [...site.labels, ...labelsIn(text)],
          };
        }
      }
    }
  }
  return undefined;
}

/** A float's page as the `.aux` gives it, with what its caption prints. */
export interface FloatPlacement {
  page: number;
  kind: "figure" | "table";
  number: string;
}

export interface FloatSources {
  /** The manuscript's source, by root-relative path. */
  files: ReadonlyMap<string, string>;
  /** The review's entry, which an `\input` resolves against. */
  entry: string;
  labels: ReadonlyMap<string, AuxLabel>;
  /** The PDF's page count: a printed page past it is not a physical page. */
  pageCount: number;
}

/**
 * Every place the `.aux` puts the float a span sits in — one per label inside
 * it that the `.aux` gives a plain page of this PDF — in source order.
 *
 * Several, not one, because a float holds its subfigures' labels beside its
 * own, and only the caption on the page says which number it prints: the
 * caller confirms each with `captionOnPage` and takes the first that holds.
 */
export function floatPlacements(
  span: ReviewSpan,
  sources: FloatSources,
): FloatPlacement[] {
  const site = siteOf(span, sources.files, sources.entry);
  if (site === undefined) return [];
  const placements: FloatPlacement[] = [];
  for (const key of site.labels) {
    const label = sources.labels.get(key);
    if (label === undefined || label.number === "") continue;
    if (!/^[0-9]+$/.test(label.page)) continue;
    const page = Number(label.page);
    if (page < 1 || page > sources.pageCount) continue;
    placements.push({ page, kind: site.kind, number: label.number });
  }
  return placements;
}

/** What a caption label begins with, by float kind, in the classes a
 *  submission uses — English long and short, upper case — and Chinese. */
const CAPTION_WORDS = {
  figure: { latin: ["Figure", "FIGURE", "Fig.", "FIG.", "Fig"], cjk: ["图"] },
  table: { latin: ["Table", "TABLE", "Tab.", "TAB."], cjk: ["表"] },
} as const;

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What may follow a caption's number: its colon, a period that is not a
 *  decimal point, or the end of the line (`TABLE I`, its title below). */
const LATIN_TAIL = "[ \\t]*(?:[:：]|\\.(?![0-9])|$)";
/** Chinese classes also set the title after a space: `图 2 流程概览`. */
const CJK_TAIL = `(?:${LATIN_TAIL}|[ \\t]+(?![0-9]))`;

/**
 * Whether a page's text carries the placement's CAPTION — its label opening a
 * line, `Figure 2:`, `Fig. 2.`, `TABLE I⏎`, `图 2 …` — as PDFium extracts a
 * real two-column paper (the code review's probe, 2026-09-26).
 *
 * The shape is the whole point. A reference in the running text prints the
 * same word and number (`as shown in Figure 2, the`, `numbers are in Table 1.
 * Quisque`), but inside a line; matching it would confirm the `.aux`'s page on
 * the very page that cites the float, which is typically the one before it —
 * the harness manufacturing the error this module exists to remove. No digit
 * runs on either, so Figure 12 and Figure 2.5 are never Figure 2.
 */
export function captionOnPage(
  text: string,
  placement: FloatPlacement,
): boolean {
  const words = CAPTION_WORDS[placement.kind];
  const number = escapeRe(placement.number);
  const latin = words.latin.map(escapeRe).join("|");
  const cjk = words.cjk.map(escapeRe).join("|");
  return new RegExp(
    `^[ \\t]*(?:(?:${latin})[ \\t]*${number}${LATIN_TAIL}|(?:${cjk})[ \\t]*${number}${CJK_TAIL})`,
    "m",
  ).test(text);
}

/**
 * The physical page count of the build that wrote an `.aux` — the LaTeX
 * kernel's `\gdef \@abspage@last{N}`, written since 2020 — or `undefined` when
 * the file does not carry it. A count other than the PDF's means the `.aux` is
 * another build's, and nothing in it is read.
 */
export function auxPageCount(aux: string): number | undefined {
  const m = /\\gdef\s*\\@abspage@last\{([0-9]+)\}/.exec(aux);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** Whether an `.aux` counts pages other than the PDF's — another build's, so
 *  nothing in it is read. An `.aux` that does not count is not judged. */
export function auxOfAnotherBuild(aux: string, pageCount: number): boolean {
  const shipped = auxPageCount(aux);
  return shipped !== undefined && shipped !== pageCount;
}

/**
 * A SETTLED ledger that says which page cites ADR 0084's step could NOT check
 * (ADR 0085 §3). Pure.
 *
 * Called only when an `.aux` WAS found and could not be used, so the step
 * checked nothing. Every page-cited concern whose anchor sits in a figure or
 * table is one it would have checked, and a `pages_unchecked` limit names
 * them, with why. A ledger with no such concern is returned ITSELF: a cite
 * outside every float is one no `.aux` checks.
 */
export function recordUncheckedPages(
  ledger: ParsedLedger,
  reason: Extract<ReviewLimit, { kind: "pages_unchecked" }>["reason"],
  sources: Pick<FloatSources, "files" | "entry">,
): ParsedLedger {
  const inFloat = ledger.result.annotations.filter(
    (a) =>
      a.evidence?.kind === "page" &&
      siteOf(a.span, sources.files, sources.entry) !== undefined,
  );
  const first = inFloat[0];
  if (first === undefined) return ledger;
  const limit: ReviewLimit = {
    kind: "pages_unchecked",
    reviewer: first.reviewer,
    reason,
    entries: inFloat.map((a) => ({ id: a.id })),
  };
  return {
    ...ledger,
    result: {
      ...ledger.result,
      limits: [...(ledger.result.limits ?? []), limit],
    },
  };
}

/**
 * A SETTLED ledger whose page cites follow their floats (ADR 0084). Pure.
 *
 * `pageOf` is the confirmed page of the float an annotation's anchor sits in,
 * or `undefined`. A page-evidence concern whose cite differs from it moves
 * there — only to a page the seat viewed, so the harness never manufactures a
 * sighting (ADR 0081 §4) — and every move is recorded in a `pages_corrected`
 * limit, never silently. Ids, counts and every other field stand: nothing is
 * dropped or re-stamped.
 *
 * Returns the ledger ITSELF when nothing moves.
 */
export function correctFloatPages(
  ledger: ParsedLedger,
  pageOf: (annotation: ReviewAnnotation) => number | undefined,
  viewed: ReadonlySet<number>,
): ParsedLedger {
  const entries: Array<{ id: string; cited: number; page: number }> = [];
  let reviewer: string | undefined;
  const annotations = ledger.result.annotations.map((a) => {
    if (a.evidence?.kind !== "page") return a;
    const cited = a.evidence.page;
    const page = pageOf(a);
    if (page === undefined || page === cited || !viewed.has(page)) return a;
    entries.push({ id: a.id, cited, page });
    reviewer ??= a.reviewer;
    return { ...a, evidence: { kind: "page" as const, page } };
  });
  if (reviewer === undefined) return ledger;
  const limit: ReviewLimit = { kind: "pages_corrected", reviewer, entries };
  return {
    ...ledger,
    result: {
      ...ledger.result,
      annotations,
      limits: [...(ledger.result.limits ?? []), limit],
    },
  };
}
