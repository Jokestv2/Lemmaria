import type { ReviewAnnotation } from "../contracts/data.js";
import { uncommented } from "./float-pages.js";

/**
 * What a document class prints FOR REVIEW, which the PDF reviewer must not
 * file as a defect (V4 gate-review round 4, ADR 0085 §2).
 *
 * The addendum's rule 1 already says so. Round 3 filed none of it in three
 * runs; round 4, on the same PDF, filed both cases below as major and blocking
 * in three of three. A prompt line that holds one round and not the next is
 * not a rule, so the rule is here, over the concern's own anchor:
 *
 *  - **The author block, when the class runs with `anonymous`.** `acmart` (and
 *    LIPIcs) then print *Anonymous Author(s)* in its place, so nothing of the
 *    block's source is on the page. Round 4's panel reported names that were
 *    only in the source, and its advice would have de-anonymised a
 *    double-blind submission. Without `anonymous`, an author block on the page
 *    IS a finding (E1's V10), and it is kept.
 *  - **The template's placeholder DOI and ISBN**, whatever the options: the
 *    publisher fills them in at camera-ready.
 *
 * Read from the source the review already holds — the entry's own
 * `\documentclass`, and the lines the concern's anchor located on. Pure.
 */

const BS = String.fromCharCode(92); // a literal LaTeX backslash

/** The macros of an author block, which a class's `anonymous` option keeps
 *  off the page: `acmart`'s set, its affiliation's parts included, which
 *  LIPIcs shares in part. */
export const ANONYMISED_MACROS = [
  "author",
  "affiliation",
  "institution",
  "department",
  "streetaddress",
  "city",
  "state",
  "postcode",
  "country",
  "email",
  "orcid",
  "authornote",
  "additionalaffiliation",
] as const;

/** The rights-block macros whose value a template ships as a placeholder. */
export const PLACEHOLDER_MACROS = ["acmDOI", "acmISBN"] as const;

/**
 * The classes whose `anonymous` option hides the author block. Any other
 * class ignores the option and prints the names — `article` does, with an
 * *unused global option* warning — so there an author block on the page is a
 * real finding, and it is kept (the code review of ADR 0085).
 */
const ANONYMOUS_CLASSES = /^(?:acmart|lipics(?:-v\d+)?)$/;

/** The entry's `\documentclass`: its class, and its options trimmed. */
export interface DocumentClassUse {
  name: string;
  options: string[];
}

/**
 * The entry's `\documentclass[…]{…}`, comments cut — options `[]` for a class
 * given none, and `undefined` when the entry declares no class. The options
 * may span lines, as a template's often do.
 */
export function documentClassOf(
  entryText: string,
): DocumentClassUse | undefined {
  const text = entryText.split(/\r?\n/).map(uncommented).join("\n");
  const at = text.indexOf(`${BS}documentclass`);
  if (at < 0) return undefined;
  let rest = text.slice(at + `${BS}documentclass`.length).trimStart();
  let options: string[] = [];
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return undefined;
    options = rest
      .slice(1, close)
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== "");
    rest = rest.slice(close + 1).trimStart();
  }
  if (!rest.startsWith("{")) return undefined;
  const end = rest.indexOf("}");
  if (end < 0) return undefined;
  return { name: rest.slice(1, end).trim(), options };
}

/** Whether the class runs anonymous: one that implements the option, given
 *  `anonymous` or `acmart`'s keyval `anonymous=true`, never `=false`. */
export function runsAnonymous(cls: DocumentClassUse): boolean {
  return (
    ANONYMOUS_CLASSES.test(cls.name) &&
    cls.options.some((o) => /^anonymous(\s*=\s*true)?$/i.test(o))
  );
}

/** The source lines a concern's anchor located on, comments cut. */
export function anchorLines(
  annotation: Pick<ReviewAnnotation, "span">,
  files: ReadonlyMap<string, string>,
): string[] {
  const text = files.get(annotation.span.file);
  if (text === undefined) return [];
  const first = annotation.span.line;
  const last = annotation.span.endLine ?? first;
  return text
    .split(/\r?\n/)
    .slice(first - 1, last)
    .map(uncommented);
}

export interface FurnitureSource {
  files: ReadonlyMap<string, string>;
  /** The class runs with `anonymous`: its author block is never printed. */
  anonymous: boolean;
}

/**
 * Is this concern about what the class prints for review — an author block
 * `anonymous` hides, or a template's placeholder DOI or ISBN?
 */
export function isReviewFurniture(
  annotation: Pick<ReviewAnnotation, "span">,
  source: FurnitureSource,
): boolean {
  // EVERY line of the anchor, not some (the code review of ADR 0085): a quote
  // that runs from `\title` into `\author` is about the title as much as the
  // block, and a set-aside errs toward keeping. A line of braces alone — the
  // `}` that closes an `\affiliation{%` — says nothing either way.
  const lines = anchorLines(annotation, source.files).filter(
    (line) => !/^[\s{},]*$/.test(line),
  );
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        (source.anonymous && AUTHOR_BLOCK.test(line)) || PLACEHOLDER.test(line),
    )
  );
}

/** A line that opens one of the author block's macros. */
const AUTHOR_BLOCK = new RegExp(
  `^\\s*${BS}${BS}(?:${ANONYMISED_MACROS.join("|")})(?![A-Za-z])`,
);

/**
 * A rights-block macro whose value holds a run of three or more X's — the
 * template's `XXXXXXX.XXXXXXX` and `978-1-4503-XXXX-X`. A run, not one X,
 * because an ISBN-10's check digit is legitimately `X`.
 */
const PLACEHOLDER = new RegExp(
  `${BS}${BS}(?:${PLACEHOLDER_MACROS.join("|")})\\s*\\{[^}]*X{3,}[^}]*\\}`,
);

/** The predicate for one review: the entry's class read once, then each
 *  concern's anchor against it. */
export function reviewFurniture(sources: {
  files: ReadonlyMap<string, string>;
  entry: string;
}): (annotation: ReviewAnnotation) => boolean {
  const cls = documentClassOf(sources.files.get(sources.entry) ?? "");
  const source: FurnitureSource = {
    files: sources.files,
    anonymous: cls !== undefined && runsAnonymous(cls),
  };
  return (annotation) => isReviewFurniture(annotation, source);
}
