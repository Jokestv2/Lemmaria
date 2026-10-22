/**
 * Citation checking C2 — online metadata verification (M7). Compares each .bib
 * entry against the injected `CitationSource`s (Crossref/DBLP/Semantic Scholar),
 * matching DOI-first then falling back to a fuzzy title query, and classifies:
 * ok / metadata_mismatch (+ correction) / preprint_superseded (+ correction) /
 * not_found / unverified. Best-effort: a per-lookup timeout or network error
 * yields `unverified` for that entry — it NEVER throws and NEVER fails the batch
 * (data contract: unverified ≠ not_found). Results are cached per source+query.
 */

import type { BibDiff, CitationResult } from "../contracts/data.js";
import type {
  CitationMetadata,
  CitationQuery,
  CitationSource,
} from "./citation-lookup.js";

export interface CheckMetadataOptions {
  sources: CitationSource[];
  /** Per-lookup deadline in ms (default 8000). A slower lookup → `unverified`. */
  timeoutMs?: number;
  /** Response cache keyed by `${source}|doi:…|title:…`. */
  cache?: Map<string, CitationMetadata | null>;
}

export interface BibEntryLike {
  key: string;
  fields: Record<string, string>;
}

type Outcome =
  | { kind: "found"; source: CitationSource; metadata: CitationMetadata }
  | { kind: "absent" }
  | { kind: "failed" };

const DEFAULT_TIMEOUT_MS = 8000;

export async function checkCitationMetadata(
  entries: BibEntryLike[],
  opts: CheckMetadataOptions,
): Promise<CitationResult[]> {
  const results: CitationResult[] = [];
  for (const entry of entries) {
    results.push(await checkOne(entry, opts));
  }
  return results;
}

async function checkOne(
  entry: BibEntryLike,
  opts: CheckMetadataOptions,
): Promise<CitationResult> {
  const { sources } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doi = normDoi(entry.fields.doi);
  const title = entry.fields.title?.trim();
  const fallbackSource = sources[0]?.name ?? "crossref";

  if (!doi && !title) {
    return { key: entry.key, status: "not_found", source: fallbackSource };
  }

  const outcomes: Outcome[] = [];

  // DOI-first
  if (doi) {
    const agg = await queryAllSources(sources, { doi }, timeoutMs, opts.cache);
    if (agg.found) {
      return classify(entry, agg.found.metadata, agg.found.source, "doi");
    }
    outcomes.push(...agg.outcomes);
  }
  // Title fallback (also the only path when there is no DOI)
  if (title) {
    const agg = await queryAllSources(
      sources,
      { title },
      timeoutMs,
      opts.cache,
    );
    if (agg.found) {
      return classify(entry, agg.found.metadata, agg.found.source, "title");
    }
    outcomes.push(...agg.outcomes);
  }

  const anyFailed = outcomes.some((o) => o.kind === "failed");
  return {
    key: entry.key,
    status: anyFailed ? "unverified" : "not_found",
    source: fallbackSource,
  };
}

/** Query every source for one query; short-circuit on the first `found`. */
async function queryAllSources(
  sources: CitationSource[],
  query: CitationQuery,
  timeoutMs: number,
  cache: CheckMetadataOptions["cache"],
): Promise<{
  found?: { source: CitationSource; metadata: CitationMetadata };
  outcomes: Outcome[];
}> {
  const outcomes: Outcome[] = [];
  for (const source of sources) {
    const outcome = await lookup(source, query, timeoutMs, cache);
    if (outcome.kind === "found") {
      return { found: { source, metadata: outcome.metadata }, outcomes };
    }
    outcomes.push(outcome);
  }
  return { outcomes };
}

async function lookup(
  source: CitationSource,
  query: CitationQuery,
  timeoutMs: number,
  cache: CheckMetadataOptions["cache"],
): Promise<Outcome> {
  const cacheKey = `${source.name}|${query.doi ? `doi:${query.doi}` : `title:${query.title}`}`;
  if (cache?.has(cacheKey)) {
    const cached = cache.get(cacheKey) ?? null;
    return cached
      ? { kind: "found", source, metadata: cached }
      : { kind: "absent" };
  }
  try {
    const md = await withDeadline(source, query, timeoutMs);
    cache?.set(cacheKey, md); // cache found/absent (not failures — those retry)
    return md ? { kind: "found", source, metadata: md } : { kind: "absent" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Run a source lookup with a hard deadline: an `AbortSignal.timeout` is passed
 * to the source (so a well-behaved fetch aborts) AND races a rejecting timer (so
 * a source that ignores the signal still can't hang the batch).
 */
function withDeadline(
  source: CitationSource,
  query: CitationQuery,
  timeoutMs: number,
): Promise<CitationMetadata | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<CitationMetadata | null>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("lookup timeout")));
    source.lookup(query, signal).then(resolve, reject);
  });
}

// ── Classification ───────────────────────────────────────────────────────────

function classify(
  entry: BibEntryLike,
  md: CitationMetadata,
  source: CitationSource,
  matchedBy: "doi" | "title",
): CitationResult {
  const { fields } = entry;
  const base = { key: entry.key, source: source.name, matchedBy } as const;

  // A preprint with a published version → suggest replacing it.
  if ((looksPreprint(fields) || md.isPreprint) && md.publishedDoi) {
    const changes: BibDiff["changes"] = [
      {
        field: "doi",
        ...(fields.doi ? { from: fields.doi } : {}),
        to: md.publishedDoi,
      },
    ];
    if (md.venue && !bibVenue(fields)) {
      changes.push({ field: venueField(fields), to: md.venue });
    }
    return {
      ...base,
      status: "preprint_superseded",
      correction: { key: entry.key, changes },
    };
  }

  const changes: BibDiff["changes"] = [];
  if (md.year && fields.year && normText(md.year) !== normText(fields.year)) {
    changes.push({ field: "year", from: fields.year, to: md.year });
  }
  const bv = bibVenue(fields);
  if (md.venue && bv && !venueMatches(bv, md.venue)) {
    changes.push({ field: venueField(fields), from: bv, to: md.venue });
  }
  if (md.authors && md.authors.length > 0 && fields.author) {
    if (!authorsOverlap(fields.author, md.authors)) {
      changes.push({
        field: "author",
        from: fields.author,
        to: md.authors.join(" and "),
      });
    }
  }

  if (changes.length > 0) {
    return {
      ...base,
      status: "metadata_mismatch",
      correction: { key: entry.key, changes },
    };
  }
  return { ...base, status: "ok" };
}

// ── Field helpers ────────────────────────────────────────────────────────────

function normDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const d = doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  return d || undefined;
}

function normText(s: string): string {
  return s.trim().toLowerCase();
}

function looksPreprint(fields: Record<string, string>): boolean {
  if (fields.archiveprefix || fields.eprint) return true;
  const j =
    `${fields.journal ?? ""} ${fields.note ?? ""} ${fields.publisher ?? ""}`.toLowerCase();
  return j.includes("arxiv") || j.includes("preprint");
}

function bibVenue(fields: Record<string, string>): string | undefined {
  return fields.journal ?? fields.booktitle ?? fields.venue ?? undefined;
}

function venueField(fields: Record<string, string>): string {
  if (fields.booktitle) return "booktitle";
  if (fields.venue) return "venue";
  return "journal";
}

function venueMatches(a: string, b: string): boolean {
  const x = normText(a).replace(/[^a-z0-9]/g, "");
  const y = normText(b).replace(/[^a-z0-9]/g, "");
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}

/** Reduce one author name ("Smith, Jane" | "Jane Smith" | "Smith") to a surname key. */
function surnameOf(name: string): string {
  const surname = name.includes(",")
    ? (name.split(",")[0] ?? "")
    : (name.split(/\s+/).pop() ?? "");
  return normText(surname).replace(/[^a-z]/g, "");
}

function surnameSet(names: string[]): Set<string> {
  return new Set(names.map(surnameOf).filter(Boolean));
}

/**
 * Whether the bib and source author lists overlap on any surname. Both sides are
 * reduced to surnames first, so a source that returns full names ("Jane Smith")
 * still matches a bib surname ("Smith") — avoiding a spurious author mismatch.
 */
function authorsOverlap(bibAuthors: string, mdAuthors: string[]): boolean {
  const a = surnameSet(bibAuthors.split(/\s+and\s+/i));
  const b = surnameSet(mdAuthors);
  if (a.size === 0 || b.size === 0) return true;
  for (const s of a) if (b.has(s)) return true;
  return false;
}
