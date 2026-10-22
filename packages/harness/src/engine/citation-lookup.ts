/**
 * Citation checking C2 — metadata sources (M7). Each source queries one public
 * bibliographic API (Crossref / DBLP / Semantic Scholar), sending ONLY metadata
 * (DOI or title) — never body text (product-design privacy boundary) — and maps
 * the response to a normalized `CitationMetadata`. The `endpoint` string is the
 * human-readable base URL the UI surfaces so the user sees where a lookup goes.
 *
 * The HTTP client is injectable (`FetchLike`) so every test runs offline against
 * a canned response; the acceptance strategy checks C2 against mocked responses.
 */

export interface CitationMetadata {
  title?: string;
  year?: string;
  authors?: string[];
  venue?: string;
  doi?: string;
  /** True when the matched record is itself a preprint (e.g. arXiv posted-content). */
  isPreprint?: boolean;
  /** Set when a preprint has a published version — drives `preprint_superseded`. */
  publishedDoi?: string;
}

export interface CitationQuery {
  doi?: string;
  title?: string;
}

export type SourceName = "crossref" | "dblp" | "semantic_scholar";

export interface CitationSource {
  readonly name: SourceName;
  /** Base URL shown in the UI (metadata-only egress). */
  readonly endpoint: string;
  /** Look up one reference; resolves `null` when the source has no such record. */
  lookup(
    query: CitationQuery,
    signal: AbortSignal,
  ): Promise<CitationMetadata | null>;
}

/** The slice of `fetch` the sources use (injectable for offline tests). */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as ReturnType<FetchLike>;

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function encode(s: string): string {
  return encodeURIComponent(s);
}

// ── Crossref ─────────────────────────────────────────────────────────────────

export function crossrefSource(
  fetchImpl: FetchLike = defaultFetch,
): CitationSource {
  const endpoint = "https://api.crossref.org";
  return {
    name: "crossref",
    endpoint,
    async lookup(query, signal) {
      const url = query.doi
        ? `${endpoint}/works/${encode(query.doi)}`
        : query.title
          ? `${endpoint}/works?query.bibliographic=${encode(query.title)}&rows=1`
          : undefined;
      if (!url) return null;
      const res = await fetchImpl(url, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        message?: Record<string, unknown> & { items?: unknown[] };
      };
      const msg = query.doi
        ? body.message
        : (body.message?.items?.[0] as Record<string, unknown> | undefined);
      if (!msg) return null;
      return mapCrossref(msg);
    },
  };
}

function mapCrossref(msg: Record<string, unknown>): CitationMetadata {
  const dateParts = (
    msg.published as { "date-parts"?: number[][] } | undefined
  )?.["date-parts"]?.[0];
  const authors = Array.isArray(msg.author)
    ? (msg.author as Array<{ family?: string }>)
        .map((a) => a.family)
        .filter((x): x is string => typeof x === "string")
    : undefined;
  const type = typeof msg.type === "string" ? msg.type : undefined;
  const md: CitationMetadata = {};
  const title = firstString(msg.title);
  if (title) md.title = title;
  if (dateParts?.[0] !== undefined) md.year = String(dateParts[0]);
  const venue = firstString(msg["container-title"]);
  if (venue) md.venue = venue;
  if (typeof msg.DOI === "string") md.doi = msg.DOI;
  if (authors && authors.length > 0) md.authors = authors;
  if (type === "posted-content") md.isPreprint = true;
  return md;
}

// ── DBLP ─────────────────────────────────────────────────────────────────────

export function dblpSource(
  fetchImpl: FetchLike = defaultFetch,
): CitationSource {
  const endpoint = "https://dblp.org/search/publ/api";
  return {
    name: "dblp",
    endpoint,
    async lookup(query, signal) {
      const q = query.doi ?? query.title;
      if (!q) return null;
      const res = await fetchImpl(
        `${endpoint}?q=${encode(q)}&format=json&h=1`,
        {
          signal,
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        result?: { hits?: { hit?: Array<{ info?: Record<string, unknown> }> } };
      };
      const info = body.result?.hits?.hit?.[0]?.info;
      if (!info) return null;
      const md: CitationMetadata = {};
      if (typeof info.title === "string") md.title = info.title;
      if (info.year !== undefined) md.year = String(info.year);
      if (typeof info.venue === "string") md.venue = info.venue;
      if (typeof info.doi === "string") md.doi = info.doi;
      return md;
    },
  };
}

// ── Semantic Scholar ─────────────────────────────────────────────────────────

export function semanticScholarSource(
  fetchImpl: FetchLike = defaultFetch,
): CitationSource {
  const endpoint = "https://api.semanticscholar.org/graph/v1";
  const fields = "title,year,venue,externalIds";
  return {
    name: "semantic_scholar",
    endpoint,
    async lookup(query, signal) {
      const url = query.doi
        ? `${endpoint}/paper/DOI:${encode(query.doi)}?fields=${fields}`
        : query.title
          ? `${endpoint}/paper/search?query=${encode(query.title)}&limit=1&fields=${fields}`
          : undefined;
      if (!url) return null;
      const res = await fetchImpl(url, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown> & {
        data?: Array<Record<string, unknown>>;
      };
      const paper = query.doi ? body : body.data?.[0];
      if (!paper) return null;
      const md: CitationMetadata = {};
      if (typeof paper.title === "string") md.title = paper.title;
      if (paper.year !== undefined && paper.year !== null)
        md.year = String(paper.year);
      if (typeof paper.venue === "string" && paper.venue)
        md.venue = paper.venue;
      const doi = (paper.externalIds as { DOI?: string } | undefined)?.DOI;
      if (typeof doi === "string") md.doi = doi;
      return md;
    },
  };
}

// ── Test helper ──────────────────────────────────────────────────────────────

export type MockResponder = (
  query: CitationQuery,
  signal: AbortSignal,
) => CitationMetadata | null | Promise<CitationMetadata | null>;

/** A deterministic in-memory source for tests (no network). */
export function mockSource(
  name: SourceName,
  responder: MockResponder,
): CitationSource {
  return {
    name,
    endpoint: `mock://${name}`,
    lookup: (query, signal) => Promise.resolve(responder(query, signal)),
  };
}
