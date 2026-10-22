/**
 * The visual-defects instrument (V4, ADR 0081; plan D14).
 *
 * What the PDF reviewer found on S6's defective twin, read off one `review`
 * item against `visual.json`. It lives in the CLI because ADR 0070 §6 keeps
 * measurements off the harness's surface: the harness records a review, and
 * what a review is *worth* against a planted answer key is the eval's question.
 *
 * Reported, never asserted (ADR 0035 §5). The report prints counts — `found
 * f/p`, *page named right k of h* — and never a percentage or a judging word:
 * the record reads the same to a reviewer who has not seen the plan.
 */

import { readFile } from "node:fs/promises";
import type { ReviewItem, ReviewVenue } from "@lemmaria/harness";
import { type DefectSpan, defectsReached } from "./recall.js";

/** One defect S6 planted that only the rendered page shows. */
export interface VisualDefect {
  id: string;
  category: string;
  kind: string;
  /** The page it is on, or `null` for a defect of every page (V6's size). */
  page: number | null;
  /** The source line(s) that cause it, in the committed `paper/main.tex`. */
  spans: DefectSpan[];
  /**
   * True for the three the deterministic facts answer (V3, V6, V7): the
   * instrument reads them off `item.pdf.facts` and expects no concern, so
   * they are never in `planted`.
   */
  facts: boolean;
  see: string;
  tell: string;
}

export interface VisualManifest {
  fixture: string;
  /** The manuscript every span is in. */
  file: string;
  venue: ReviewVenue;
  defective: { pages: number; pageSize: string };
  clean: { pages: number; pageSize: string };
  defects: VisualDefect[];
}

const MANIFEST_KEYS = new Set([
  "fixture",
  "file",
  "venue",
  "defective",
  "clean",
  "defects",
]);

/**
 * Read and check `visual.json`. Refuses, never repairs: a manifest that is
 * wrong about where a defect sits measures the wrong thing while looking
 * healthy. Whether each anchor locates once in `paper/main.tex` is the
 * fixture test's (O25) — this reader has no paper.
 */
export async function readVisualManifest(
  path: string,
): Promise<VisualManifest> {
  return checkVisualManifest(JSON.parse(await readFile(path, "utf8")), path);
}

/** The checks, apart from the file read, so a test can hand in a shape. */
export function checkVisualManifest(
  parsed: unknown,
  path = "visual.json",
): VisualManifest {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: not a visual manifest`);
  }
  const m = parsed as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) {
      throw new Error(`${path}: unknown key "${key}"`);
    }
  }
  if (typeof m.file !== "string" || m.file === "") {
    throw new Error(`${path}: no "file"`);
  }
  if (!Array.isArray(m.defects) || m.defects.length === 0) {
    throw new Error(`${path}: no defects`);
  }
  const venue = m.venue as ReviewVenue | undefined;
  if (typeof venue?.id !== "string") {
    throw new Error(`${path}: no venue id`);
  }
  const seen = new Set<string>();
  for (const d of m.defects as VisualDefect[]) {
    if (typeof d?.id !== "string" || d.id === "") {
      throw new Error(`${path}: a defect has no id`);
    }
    if (seen.has(d.id)) throw new Error(`${path}: duplicate id "${d.id}"`);
    seen.add(d.id);
    if (
      d.page !== null &&
      !(Number.isInteger(d.page) && (d.page as number) > 0)
    ) {
      throw new Error(
        `${path}: ${d.id}'s page must be a positive whole number or null`,
      );
    }
    if (!Array.isArray(d.spans) || d.spans.length === 0) {
      throw new Error(`${path}: ${d.id} has no span`);
    }
    for (const span of d.spans) {
      if (
        typeof span?.anchor !== "string" ||
        span.anchor === "" ||
        !Number.isInteger(span.line) ||
        span.line < 1
      ) {
        throw new Error(`${path}: ${d.id} has a malformed span`);
      }
    }
    if (typeof d.facts !== "boolean") {
      throw new Error(`${path}: ${d.id} does not say whether facts answer it`);
    }
    if (typeof d.kind !== "string" || d.kind === "") {
      throw new Error(`${path}: ${d.id} has no kind`);
    }
  }
  return parsed as VisualManifest;
}

export interface VisualHit {
  defect: string;
  /** The concerns credited to it — one concern credits one defect at most. */
  ids: string[];
  /**
   * Whether the concern named the defect's page as its evidence: `null` when
   * no credited concern carried a page, or the defect has none (V6).
   */
  pageNamed: boolean | null;
}

export interface VisualReport {
  /** Did the PDF reviewer produce a ledger the driver could read? */
  measured: boolean;
  /** Defects a concern is expected for — every one the facts do not answer. */
  planted: number;
  found: number;
  hits: VisualHit[];
  missed: string[];
  /** The PDF reviewer's concerns that reached no defect, by id. */
  unmatched: string[];
  byKind: Record<string, { planted: number; found: number }>;
  /** Concerns carrying a page as evidence, and hits whose page was right. */
  pageEvidence: { withPage: number; onDefectPage: number; named: number };
  viewed: number[];
  facts: {
    smallestText?: { page: number; sizePt: number };
    pageSize?: string;
    pages?: number;
    /** Against the venue's limit in pages, when it has one. */
    overLimit?: boolean;
  };
}

const PDF_REVIEWER = "pdf_reviewer";

/**
 * Read one review against the manifest.
 *
 * The hit rule is R5's (`defectsReached`): a `pdf_reviewer` concern whose claim
 * span — or, failing that, its `span` evidence — overlaps a defect's span, in
 * any dimension; the first defect it reaches takes the credit. Only the PDF
 * reviewer's concerns are read: the text reviewers never saw the page.
 */
export function matchVisualDefects(
  item: ReviewItem | undefined,
  manifest: VisualManifest,
): VisualReport {
  const concerns = (item?.result?.annotations ?? []).filter(
    (a) => a.reviewer === PDF_REVIEWER,
  );
  const credited = new Map<string, string[]>();
  const pageOf = new Map<string, boolean | null>();
  const unmatched: string[] = [];
  const byId = new Map(manifest.defects.map((d) => [d.id, d]));
  for (const a of concerns) {
    const [defectId] = defectsReached(a, manifest, manifest.file);
    const defect = defectId !== undefined ? byId.get(defectId) : undefined;
    if (defect === undefined) {
      unmatched.push(a.id);
      continue;
    }
    credited.set(defect.id, [...(credited.get(defect.id) ?? []), a.id]);
    const named =
      a.evidence?.kind === "page" && defect.page !== null
        ? a.evidence.page === defect.page
        : null;
    // Once any credited concern names the right page, the defect's page was
    // named right; a wrong one does not undo it.
    const prior = pageOf.get(defect.id);
    pageOf.set(
      defect.id,
      prior === true || named === true
        ? true
        : named === false || prior === false
          ? false
          : null,
    );
  }

  const expected = manifest.defects.filter((d) => !d.facts);
  const hits: VisualHit[] = manifest.defects
    .filter((d) => credited.has(d.id))
    .map((d) => ({
      defect: d.id,
      ids: credited.get(d.id) ?? [],
      pageNamed: pageOf.get(d.id) ?? null,
    }));
  const byKind: VisualReport["byKind"] = {};
  for (const d of expected) {
    const row = byKind[d.kind] ?? { planted: 0, found: 0 };
    row.planted += 1;
    if (credited.has(d.id)) row.found += 1;
    byKind[d.kind] = row;
  }

  const factsOf = item?.pdf?.facts;
  const smallest = (factsOf?.smallestText ?? []).reduce<
    { page: number; sizePt: number } | undefined
  >(
    (min, s) => (min === undefined || s.sizePt < min.sizePt ? s : min),
    undefined,
  );
  const limit = factsOf?.venue?.pageLimit ?? manifest.venue.pageLimit;
  const facts: VisualReport["facts"] = {
    ...(smallest !== undefined ? { smallestText: smallest } : {}),
    ...(factsOf !== undefined
      ? {
          pageSize:
            factsOf.pageSize.name ??
            `${Math.round(factsOf.pageSize.width)} x ${Math.round(factsOf.pageSize.height)} pt`,
          pages: factsOf.pages,
        }
      : {}),
    ...(factsOf !== undefined && limit?.unit === "pages"
      ? { overLimit: factsOf.pages > limit.value }
      : {}),
  };

  return {
    measured: item?.pdfSeat?.ledger !== undefined,
    planted: expected.length,
    found: expected.filter((d) => credited.has(d.id)).length,
    hits,
    missed: expected.filter((d) => !credited.has(d.id)).map((d) => d.id),
    unmatched,
    byKind,
    pageEvidence: {
      withPage: concerns.filter((a) => a.evidence?.kind === "page").length,
      onDefectPage: hits.filter((h) => h.pageNamed === true).length,
      named: hits.filter((h) => h.pageNamed !== null).length,
    },
    viewed: item?.pdf?.viewed ?? [],
    facts,
  };
}

/**
 * The report as the record prints it. Counts only: *page named right k of h*,
 * never a percentage — the stage's no-quota rule, and ADR 0035 §5's reason a
 * number read once is a floor, not a grade.
 */
export function formatVisualReport(r: VisualReport): string {
  if (!r.measured) {
    return "visual defects: not measured — the PDF reviewer produced no ledger";
  }
  const lines = [
    `visual defects: found ${r.found}/${r.planted}`,
    ...Object.entries(r.byKind).map(
      ([kind, k]) => `  ${kind}: ${k.found}/${k.planted}`,
    ),
    `page named right ${r.pageEvidence.onDefectPage} of ${r.pageEvidence.named}`,
    `concerns citing a page: ${r.pageEvidence.withPage}`,
    `unmatched ${r.unmatched.length}${r.unmatched.length > 0 ? ` (${r.unmatched.join(", ")})` : ""}`,
    `pages viewed: ${r.viewed.length > 0 ? r.viewed.join(", ") : "none"}`,
  ];
  const f = r.facts;
  const facts = [
    f.pages !== undefined ? `${f.pages} pages` : undefined,
    f.pageSize,
    f.smallestText !== undefined
      ? `smallest text ${f.smallestText.sizePt.toFixed(1)} pt on page ${f.smallestText.page}`
      : undefined,
    f.overLimit !== undefined
      ? f.overLimit
        ? "over the page limit"
        : "within the page limit"
      : undefined,
  ].filter((x): x is string => x !== undefined);
  if (facts.length > 0) lines.push(`facts: ${facts.join(" · ")}`);
  return lines.join("\n");
}
