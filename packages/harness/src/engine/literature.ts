/**
 * Literature search — the scholarly provider seam (ADR 0019).
 *
 * Named endpoints ONLY (Crossref / DBLP / Semantic Scholar / arXiv), metadata
 * + abstracts, never PDFs — the M7 CitationSource discipline (injectable
 * fetch, per-provider deadline, never-throws) applied to search. v0.3's web
 * search enters as a new LiteratureProvider implementation; the tool contract
 * does not change. Rate limits are honest data: a 429 is `rate_limited`,
 * never an empty result masquerading as "no papers exist."
 */

import { type RetryPolicy, abortableSleep } from "../session/retry.js";
import type { LiteraturePacer, LiteratureSleep } from "./literature-pacer.js";
import {
  LITERATURE_EPISODE_MS,
  LITERATURE_RETRY_POLICY,
  decideLiteratureRetry,
  defaultLiteraturePacer,
} from "./literature-pacer.js";

export type LiteratureSourceName =
  | "crossref"
  | "dblp"
  | "semantic_scholar"
  | "arxiv";

export type LiteratureSourceStatus =
  | "ok"
  | "rate_limited"
  | "failed"
  | "timeout";

export interface LiteratureResult {
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  doi?: string;
  url?: string;
  /** Abstract when the source returns one (metadata-only egress; no PDFs). */
  abstract?: string;
  source: LiteratureSourceName;
}

export interface LiteratureQuery {
  query: string;
  maxResults: number;
}

export type LiteratureProviderOutcome =
  | { kind: "ok"; results: LiteratureResult[] }
  | { kind: "rate_limited"; retryAfterS?: number }
  /**
   * R8: `status` carries the HTTP status when the failure was one — additive,
   * and the `message` string is unchanged. `decideLiteratureRetry` reads the
   * number rather than parsing `"http 503"` back out of the prose, so the
   * overload family (502 / 503 / 504) can be told apart from a 500 fault and a
   * 4xx refusal. Absent for a network or parse error, which is itself the
   * signal that there is no host verdict to obey.
   */
  | { kind: "failed"; message: string; status?: number };

/**
 * What `searchLiterature` actually holds once a provider has settled: its own
 * outcome, or the harness's `timeout` verdict when the per-provider deadline
 * won the race. A provider cannot report `timeout` about itself — that is a
 * judgement only the caller holding the clock can make — which is why it is
 * one arm wider than `LiteratureProviderOutcome`.
 */
export type LiteratureSettledOutcome =
  | LiteratureProviderOutcome
  | { kind: "timeout" };

/** The provider seam (ADR 0019). */
export interface LiteratureProvider {
  readonly name: LiteratureSourceName;
  /** Base URL shown in the UI (metadata-only egress; the U2 privacy footer). */
  readonly endpoint: string;
  /**
   * R4: this provider ran without an API key, so it is subject to the
   * anonymous rate limit. Only Semantic Scholar sets it — Crossref's polite
   * pool is a courtesy, not authentication, and the other two take no key.
   */
  readonly anonymous?: boolean;
  /**
   * R8 (ADR 0068): the minimum gap this host publishes between two requests.
   * A **declaration**, like `anonymous` — a fact the factory knows and the
   * seam acts on; `searchLiterature` enforces it per host name, across every
   * caller in the process.
   *
   * **A provider that declares nothing is not paced.** That keeps scripted
   * providers instant, and the guard against a real provider forgetting to
   * declare is a test over the shipping factories (O2), not a runtime default
   * that would silently pace a test double.
   */
  readonly minIntervalMs?: number;
  search(
    q: LiteratureQuery,
    signal: AbortSignal,
  ): Promise<LiteratureProviderOutcome>;
}

/** fetch slice for providers (json + text + headers; injectable for tests). */
export type HttpFetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const defaultFetch: HttpFetchLike = (url, init) =>
  fetch(url, init) as ReturnType<HttpFetchLike>;

export const LITERATURE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// R8 (ADR 0068) — what each host publishes, one constant per host.
//
// Each of these is a published policy or a stated courtesy, read on
// 2026-09-06, never a guess. `searchLiterature` enforces them per host name;
// the factories only DECLARE them.
// ---------------------------------------------------------------------------

/**
 * arXiv: *"make no more than one request every three seconds, and limit
 * requests to a single connection at a time"* —
 * <https://info.arxiv.org/help/api/tou.html>.
 */
export const ARXIV_MIN_INTERVAL_MS = 3000;

/**
 * DBLP: *"You should always be fine when waiting for at least one or two
 * second between two consecutive requests."* — the conservative reading of
 * that range. <https://dblp.org/faq/Am+I+allowed+to+crawl+the+dblp+website.html>
 */
export const DBLP_MIN_INTERVAL_MS = 2000;

/**
 * Semantic Scholar: *"the introductory rate limit for an API key is 1 RPS on
 * all endpoints"* — applied keyed or not, because the anonymous limit is a
 * pool shared with every other unauthenticated caller and our own cadence is
 * the only part of it we control. <https://www.semanticscholar.org/product/api>
 */
export const SEMANTIC_SCHOLAR_MIN_INTERVAL_MS = 1000;

/**
 * Crossref publishes no interval, only *"pay attention to the http status code
 * and back off if you start seeing 429 statuses"* — so one request per second
 * is the courtesy cadence this seam gives a host that names none.
 * <https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/>
 */
export const CROSSREF_MIN_INTERVAL_MS = 1000;

type FetchResponse = Awaited<ReturnType<HttpFetchLike>>;

/** Map a non-ok response to the honest outcome (429 → rate_limited). */
function failureOutcome(res: FetchResponse): LiteratureProviderOutcome {
  if (res.status === 429) {
    const raw = res.headers?.get("Retry-After") ?? undefined;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed)
      ? { kind: "rate_limited", retryAfterS: parsed }
      : { kind: "rate_limited" };
  }
  return { kind: "failed", message: `http ${res.status}`, status: res.status };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** Strip markup (Crossref abstracts arrive as JATS XML) and squeeze spaces. */
function plainText(v: unknown): string | undefined {
  const s = str(v);
  return s
    ? s
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : undefined;
}

export function crossrefLiterature(opts?: {
  fetchImpl?: HttpFetchLike;
  /** Polite-pool contact (ADR 0019) — sent as mailto= and in the UA when set. */
  mailto?: string;
}): LiteratureProvider {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const mailto = opts?.mailto;
  return {
    name: "crossref",
    endpoint: "https://api.crossref.org",
    minIntervalMs: CROSSREF_MIN_INTERVAL_MS,
    async search(q, signal) {
      const params = new URLSearchParams({
        "query.bibliographic": q.query,
        rows: String(q.maxResults),
        select: "title,author,issued,container-title,DOI,URL,abstract",
      });
      if (mailto) params.set("mailto", mailto);
      const res = await fetchImpl(
        `https://api.crossref.org/works?${params.toString()}`,
        {
          signal,
          ...(mailto
            ? { headers: { "User-Agent": `Lemmaria (mailto:${mailto})` } }
            : {}),
        },
      );
      if (!res.ok) return failureOutcome(res);
      const body = (await res.json()) as {
        message?: { items?: Record<string, unknown>[] };
      };
      const results: LiteratureResult[] = [];
      for (const item of body.message?.items ?? []) {
        const title = plainText((item.title as unknown[] | undefined)?.[0]);
        if (!title) continue;
        const authors = ((item.author as Record<string, unknown>[]) ?? [])
          .map((a) => [str(a.given), str(a.family)].filter(Boolean).join(" "))
          .filter((s) => s !== "");
        // `!= null`, not `!== undefined`: Crossref sends `[[null]]` for a work
        // it holds no date for, and `String(null)` is the literal "null" —
        // which V2's gate review (issue 3) read on screen as `… (null)`, and
        // in both assistant drafts. An undated result is a legitimate state
        // that renders with no parentheses at all. The Semantic Scholar branch
        // below has guarded this since it was written.
        const dateParts = (
          item.issued as { "date-parts"?: unknown[][] } | undefined
        )?.["date-parts"]?.[0]?.[0];
        results.push({
          title,
          authors,
          ...(dateParts != null ? { year: String(dateParts) } : {}),
          ...(plainText((item["container-title"] as unknown[])?.[0])
            ? { venue: plainText((item["container-title"] as unknown[])?.[0]) }
            : {}),
          ...(str(item.DOI) ? { doi: str(item.DOI) } : {}),
          ...(str(item.URL) ? { url: str(item.URL) } : {}),
          ...(plainText(item.abstract)
            ? { abstract: plainText(item.abstract) }
            : {}),
          source: "crossref",
        });
      }
      return { kind: "ok", results };
    },
  };
}

export function dblpLiterature(opts?: {
  fetchImpl?: HttpFetchLike;
}): LiteratureProvider {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  return {
    name: "dblp",
    endpoint: "https://dblp.org/search/publ/api",
    minIntervalMs: DBLP_MIN_INTERVAL_MS,
    async search(q, signal) {
      const res = await fetchImpl(
        `https://dblp.org/search/publ/api?q=${encodeURIComponent(q.query)}&format=json&h=${q.maxResults}`,
        { signal },
      );
      if (!res.ok) return failureOutcome(res);
      const body = (await res.json()) as {
        result?: { hits?: { hit?: { info?: Record<string, unknown> }[] } };
      };
      const results: LiteratureResult[] = [];
      for (const hit of body.result?.hits?.hit ?? []) {
        const info = hit.info ?? {};
        const title = plainText(info.title);
        if (!title) continue;
        const rawAuthors = (info.authors as { author?: unknown } | undefined)
          ?.author;
        const authorList = Array.isArray(rawAuthors)
          ? rawAuthors
          : rawAuthors !== undefined
            ? [rawAuthors]
            : [];
        const authors = authorList
          .map((a) =>
            typeof a === "string"
              ? a
              : (str((a as Record<string, unknown>).text) ?? ""),
          )
          .filter((s) => s !== "");
        results.push({
          title,
          authors,
          ...(str(info.year) ? { year: str(info.year) } : {}),
          ...(str(info.venue) ? { venue: str(info.venue) } : {}),
          ...(str(info.doi) ? { doi: str(info.doi) } : {}),
          ...(str(info.url) ? { url: str(info.url) } : {}),
          source: "dblp",
        });
      }
      return { kind: "ok", results };
    },
  };
}

export function semanticScholarLiterature(opts?: {
  fetchImpl?: HttpFetchLike;
  /** Optional S2 key — SecretStorage-held by the host, injected here (ADR 0019). */
  apiKey?: string;
}): LiteratureProvider {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const apiKey = opts?.apiKey;
  return {
    name: "semantic_scholar",
    endpoint: "https://api.semanticscholar.org/graph/v1",
    minIntervalMs: SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
    // S5 measured anonymous S2 as `rate_limited` on 40 of 40 calls, and
    // nothing told the user that a key would change that. Now the report does.
    anonymous: !apiKey,
    async search(q, signal) {
      const fields = "title,authors,year,venue,externalIds,abstract,url";
      const res = await fetchImpl(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q.query)}&limit=${q.maxResults}&fields=${fields}`,
        { signal, ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}) },
      );
      if (!res.ok) return failureOutcome(res);
      const body = (await res.json()) as { data?: Record<string, unknown>[] };
      const results: LiteratureResult[] = [];
      for (const item of body.data ?? []) {
        const title = plainText(item.title);
        if (!title) continue;
        const authors = ((item.authors as Record<string, unknown>[]) ?? [])
          .map((a) => str(a.name) ?? "")
          .filter((s) => s !== "");
        const doi = str(
          (item.externalIds as Record<string, unknown> | undefined)?.DOI,
        );
        results.push({
          title,
          authors,
          ...(item.year !== undefined && item.year !== null
            ? { year: String(item.year) }
            : {}),
          ...(str(item.venue) ? { venue: str(item.venue) } : {}),
          ...(doi ? { doi } : {}),
          ...(str(item.url) ? { url: str(item.url) } : {}),
          ...(plainText(item.abstract)
            ? { abstract: plainText(item.abstract) }
            : {}),
          source: "semantic_scholar",
        });
      }
      return { kind: "ok", results };
    },
  };
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function unescapeXml(s: string): string {
  return s.replace(
    /&(?:amp|lt|gt|quot|#39|apos);/g,
    (m) => XML_ENTITIES[m] ?? m,
  );
}

/** First <tag>…</tag> text inside a block (minimal Atom extraction, ADR 0019). */
function xmlText(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  const raw = m?.[1];
  if (raw === undefined) return undefined;
  const text = unescapeXml(raw).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

/**
 * arXiv used to pace itself: a module-level promise chain inside this factory,
 * awaited at the top of `search`. R8 (ADR 0068) moved that mechanism to
 * `searchLiterature`, where it serves every host rather than the one that
 * happened to publish its rule first — so this factory now only **declares**
 * its interval, exactly as the other three do. The chain, and the B3 lesson
 * that made it a chain rather than a timestamp, live on in
 * `engine/literature-pacer.ts`.
 */
export function arxivLiterature(opts?: {
  fetchImpl?: HttpFetchLike;
  /** Declaration override; production keeps the 3 s courtesy default. */
  minIntervalMs?: number;
}): LiteratureProvider {
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const minIntervalMs = opts?.minIntervalMs ?? ARXIV_MIN_INTERVAL_MS;
  return {
    name: "arxiv",
    endpoint: "https://export.arxiv.org/api",
    minIntervalMs,
    async search(q, signal) {
      if (signal.aborted) return { kind: "failed", message: "aborted" };
      const res = await fetchImpl(
        `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q.query)}&max_results=${q.maxResults}`,
        { signal },
      );
      if (!res.ok) return failureOutcome(res);
      const xml = await res.text();
      const results: LiteratureResult[] = [];
      const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
      for (const entry of entries) {
        const title = xmlText(entry, "title");
        if (!title) continue;
        const authors = (entry.match(/<name>[\s\S]*?<\/name>/g) ?? [])
          .map((n) => unescapeXml(n.replace(/<\/?name>/g, "")).trim())
          .filter((s) => s !== "");
        const published = xmlText(entry, "published");
        const url = xmlText(entry, "id");
        const abstract = xmlText(entry, "summary");
        const doi = xmlText(entry, "arxiv:doi");
        results.push({
          title,
          authors,
          ...(published ? { year: published.slice(0, 4) } : {}),
          ...(url ? { url } : {}),
          ...(abstract ? { abstract } : {}),
          ...(doi ? { doi } : {}),
          source: "arxiv",
        });
      }
      return { kind: "ok", results };
    },
  };
}

export interface LiteratureSearchReport {
  /**
   * Per-source statuses — rate limits and failures are data, never throws.
   *
   * **Declared and serialized BEFORE `results`** (R4/D4): a report that ever
   * did get sliced would keep its statuses in the head, which is the half the
   * panel's honesty record reads.
   */
  sources: {
    name: LiteratureSourceName;
    endpoint: string;
    status: LiteratureSourceStatus;
    retryAfterS?: number;
    /** R4: this source ran without an API key, so its rate limit is the
     *  anonymous one. Present only when true. */
    anonymous?: true;
    /**
     * R8: how many times this host was asked inside this call — present
     * **only when it was asked more than once**, so a first-try answer
     * serializes byte-identically to R4's report. It is the model's and the
     * live tier's evidence that a failed source was already retried; the
     * reader's question is *did it answer*, which `status` already says.
     */
    attempts?: number;
  }[];
  /**
   * V2 (ADR 0078 §5): how many results were removed because they were the
   * reviewed manuscript itself.
   *
   * **Present only when greater than zero**, so every other report serializes
   * byte-identically to R4's — which is what the model reads and what the
   * stage's recorded figures were taken against. Declared after `sources` and
   * before `results`, so that a report which ever did get sliced keeps it in
   * the head with the statuses.
   */
  withheld?: { ownTitle: number };
  /**
   * Merged by `mergeLiterature` — identity first, then a rank interleave over
   * the sources that answered (ADR 0067) — deduped, capped at `maxResults`.
   */
  results: LiteratureResult[];
}

/** An abstract longer than this is cut, with a trailing `…` (R4/D4). */
export const LITERATURE_ABSTRACT_MAX_CHARS = 1000;
/** An author list longer than this is cut, ending in a literal `et al.`. */
export const LITERATURE_MAX_AUTHORS = 20;
/**
 * The serialized bound for the whole report.
 *
 * Deliberately under `TOOL_RESULT_MAX_CHARS` (32,000), so a bounded report is
 * never wrapped in `capToolResult`'s truncation envelope. That envelope is
 * valid JSON but it is not a *report*: `observeSeat` would parse it, find no
 * `sources[]`, and the review panel's honesty record would go silent exactly
 * when the tool had the most to say. The interleave is what puts an
 * abstract-bearing result into every merged set (S5: arXiv 100 % coverage), so
 * the growth is R4's own doing and the bound is R4's to carry.
 */
export const LITERATURE_REPORT_MAX_CHARS = 28_000;

/**
 * Bound a report by construction, applied after the merge and before return.
 *
 * Three rungs, cheapest first: cut each over-long abstract, cut each over-long
 * author list, and — only if it still does not fit — replace whole abstracts
 * from the LAST result backwards, so the highest-ranked candidates keep theirs.
 * A report that already fits comes back unchanged.
 *
 * **Recorded limit:** `title`, `venue` and `url` are not capped, so pathological
 * metadata (a title of many kilobytes) can still exceed the bound. There
 * `capToolResult` behaves exactly as it did before R4 — degraded, not broken.
 */
/**
 * `text` cut to at most `max` UTF-16 code units, never mid-character.
 *
 * `slice` counts code units, so a cut landing between the halves of a surrogate
 * pair leaves a lone high surrogate. The wire stays valid JSON — `JSON.stringify`
 * escapes it — so nothing downstream complains, and the model simply reads one
 * garbage character where an author wrote an emoji or a rarer CJK glyph.
 * Invariant 6 rule 1 says the bytes we hand a model are the author's, and
 * mangling one is a small breach of that.
 */
function cutAt(text: string, max: number): string {
  const code = text.charCodeAt(max - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

export function boundLiteratureReport(
  report: LiteratureSearchReport,
): LiteratureSearchReport {
  const results = report.results.map((r) => ({
    ...r,
    ...(r.abstract !== undefined &&
    r.abstract.length > LITERATURE_ABSTRACT_MAX_CHARS
      ? { abstract: `${cutAt(r.abstract, LITERATURE_ABSTRACT_MAX_CHARS)}…` }
      : {}),
    ...(r.authors.length > LITERATURE_MAX_AUTHORS
      ? { authors: [...r.authors.slice(0, LITERATURE_MAX_AUTHORS), "et al."] }
      : {}),
  }));
  const bounded: LiteratureSearchReport = {
    sources: report.sources,
    // V2: carried through the bound. `boundLiteratureReport` rebuilds the
    // object rather than spreading it, so a key it does not name is dropped —
    // which is why this line has to exist at all.
    ...(report.withheld !== undefined ? { withheld: report.withheld } : {}),
    results,
  };
  for (let i = results.length - 1; i >= 0; i -= 1) {
    if (JSON.stringify(bounded).length <= LITERATURE_REPORT_MAX_CHARS) break;
    const entry = results[i];
    if (entry?.abstract !== undefined) entry.abstract = "…";
  }
  return bounded;
}

/**
 * The canonical visiting order for the merge (R4, ADR 0067) — **alphabetical
 * by source name**, so that it is visibly not a weight.
 *
 * The harness has no opinion on which scholarly index is better. S5 measured
 * arXiv as the source carrying the signal for topic queries, but that is a fact
 * about *coverage* — abstracts, which the model can see per result — not a fact
 * the merge should encode. What the order is FOR is that the merged ranking no
 * longer depends on the order a caller happened to build its provider array in:
 * before R4 the extension and the CLI eval driver ranked differently for that
 * reason alone.
 */
export const LITERATURE_SOURCE_ORDER: readonly LiteratureSourceName[] = [
  "arxiv",
  "crossref",
  "dblp",
  "semantic_scholar",
];

/**
 * A title reduced to its comparison key: lowercased, everything that is not
 * `a–z0–9` stripped.
 *
 * **An empty key is not a key.** A title written wholly in a non-Latin script
 * normalises to `""`, and treating that as a key would collapse every such
 * paper into one entry — invariant 6 rule 1 says titles pass through in
 * whatever language they arrive, so the comparison must simply decline to
 * answer rather than guess.
 */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Are these two titles the same paper? (V2, ADR 0078 §3.)
 *
 * The ledger validates a cited paper against the results a reviewer's own
 * searches returned, and the withholding guard removes the manuscript from
 * those results. Both ask this one question, and both ask it with **the
 * merge's own key** — a second normalisation would let the interpreter accept
 * a title the merge had already deduplicated away, and the two would drift
 * apart the first time either was tuned.
 *
 * Two rungs, and the second exists for invariant 6 rule 1. When both keys are
 * non-empty, `titleKey` decides. When both are EMPTY — two titles written
 * wholly in a non-Latin script — the key declines to answer, so the fallback
 * compares the titles themselves after trim, whitespace collapse and
 * lower-casing. Without it a Chinese-language paper could never be cited as
 * evidence at all, because it would fail to match even itself.
 *
 * When exactly one key is empty the answer is `false`: one title reduced to a
 * comparable key and the other did not, and guessing across that boundary is
 * what R4 declined to do.
 */
export function sameTitle(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (ka !== "" && kb !== "") return ka === kb;
  if (ka !== "" || kb !== "") return false;
  const loose = (t: string): string =>
    t.trim().replace(/\s+/g, " ").toLowerCase();
  return loose(a) === loose(b);
}

/** A DOI reduced to its comparison key. DOIs are case-insensitive. */
function doiKey(doi: string): string {
  return doi.toLowerCase();
}

/** `10.1234/suffix`, bare or wearing a `doi:` / doi.org prefix. */
const DOI_QUERY =
  /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;

/**
 * The identity key of a QUERY (R4/D2): what an exact-title or DOI query is
 * asking to be answered first. `undefined` when the query carries no key —
 * an empty title key never matches anything.
 */
export function identityKey(query: string): string | undefined {
  const trimmed = query.trim();
  const doi = DOI_QUERY.exec(trimmed)?.[1];
  if (doi !== undefined) return `doi:${doiKey(doi)}`;
  const t = titleKey(trimmed);
  return t === "" ? undefined : `t:${t}`;
}

/** The keys a result can be recognised by; either may be absent. */
function resultKeys(r: LiteratureResult): {
  doi?: string;
  title?: string;
} {
  const t = titleKey(r.title);
  return {
    ...(r.doi ? { doi: `doi:${doiKey(r.doi)}` } : {}),
    ...(t !== "" ? { title: `t:${t}` } : {}),
  };
}

/** The optional fields a duplicate may fill in on the entry that outranked it. */
const FILLABLE = ["doi", "abstract", "venue", "year", "url"] as const;

/**
 * Merge the providers' answers into ONE ranked list (R4, ADR 0067, superseding
 * ADR 0019 §3's unstated concatenation rule).
 *
 * Two tiers. **Identity first:** a result whose title key — or DOI, for a
 * DOI-shaped query — equals the query's own is placed before anything else,
 * from whichever source returned it. No provider is asked anything new; this is
 * a filter over the candidates the sources already returned, so the egress set
 * is still exactly ADR 0019's four hosts. **Then a rank interleave:** sources
 * are visited in `LITERATURE_SOURCE_ORDER` and each round takes each answering
 * source's next placeable result, so every source that answered `ok` with a
 * result of its own is represented rather than buried under whichever source
 * the caller happened to list first.
 *
 * A source whose r-th result is a duplicate **advances past it inside the same
 * round** rather than losing its turn — otherwise the representation property
 * would fail for exactly the source whose top hits another index also returned.
 *
 * Pure: it issues no request and reads no clock.
 */
export function mergeLiterature(
  q: LiteratureQuery,
  outcomes: readonly {
    name: LiteratureSourceName;
    outcome: LiteratureSettledOutcome;
  }[],
): LiteratureResult[] {
  // Group by source name, then visit the KNOWN names in canonical order and
  // any unknown one after them, in the order it arrived.
  //
  // Two things this must not do, both of which a `find` over the canonical
  // order would. It must not **drop** a source whose name the constant does not
  // carry — this file's own header advertises a future `web_search` provider
  // through this seam, and a dropped source would still be reported as having
  // answered, so `sources[]` would say a source answered while the model saw
  // nothing it returned. And it must not keep only the **first** provider of a
  // given name: a host may build a keyed and an unkeyed instance of the same
  // source, and the pre-R4 loop, which walked the settled array, counted both.
  const byName = new Map<LiteratureSourceName, LiteratureResult[]>();
  for (const { name, outcome } of outcomes) {
    if (outcome.kind !== "ok") continue;
    byName.set(name, [...(byName.get(name) ?? []), ...outcome.results]);
  }
  const answering = [
    ...LITERATURE_SOURCE_ORDER.filter((name) => byName.has(name)),
    // A name the constant does not carry still needs an INTRINSIC rank, or the
    // ranking of two such sources would fall back to Map insertion order —
    // which is the settled array's order, the very coupling D1 removes. Sorted,
    // for the same reason the canonical order is alphabetical: it is a rule a
    // reader can restate, not a preference between sources.
    ...[...byName.keys()]
      .filter((name) => !LITERATURE_SOURCE_ORDER.includes(name))
      .sort(),
  ].map((name) => ({ name, results: byName.get(name) ?? [] }));

  const placed: LiteratureResult[] = [];
  /** key → the index in `placed` of the entry that owns it. */
  const owner = new Map<string, number>();

  const register = (index: number, r: LiteratureResult): void => {
    const keys = resultKeys(r);
    if (keys.doi !== undefined) owner.set(keys.doi, index);
    if (keys.title !== undefined) owner.set(keys.title, index);
  };

  /** Place `r`, or fold it into the entry it duplicates. */
  const consider = (r: LiteratureResult): "placed" | "duplicate" | "full" => {
    const keys = resultKeys(r);
    const at =
      (keys.doi !== undefined ? owner.get(keys.doi) : undefined) ??
      (keys.title !== undefined ? owner.get(keys.title) : undefined);
    if (at !== undefined) {
      // D3: the first-placed entry stands — position, `source` and every field
      // it already carries — and the duplicate fills only its GAPS. An arXiv
      // preprint (abstract, no DOI) and its Crossref twin (DOI, venue, no
      // abstract) become one useful entry instead of two half-entries.
      const kept = placed[at];
      if (kept !== undefined) {
        for (const field of FILLABLE) {
          if (kept[field] === undefined && r[field] !== undefined) {
            kept[field] = r[field];
          }
        }
        // A DOI learned from the duplicate is itself a key from now on.
        register(at, kept);
      }
      return "duplicate";
    }
    if (placed.length >= q.maxResults) return "full";
    placed.push({ ...r });
    register(placed.length - 1, r);
    return "placed";
  };

  // Tier 1 — identity.
  const identity = identityKey(q.query);
  if (identity !== undefined) {
    for (const source of answering) {
      for (const r of source.results) {
        const keys = resultKeys(r);
        if (keys.doi === identity || keys.title === identity) consider(r);
      }
    }
  }

  // Tier 2 — the rank interleave.
  const cursor = new Map<LiteratureSourceName, number>();
  for (;;) {
    if (placed.length >= q.maxResults) break;
    let advanced = false;
    for (const source of answering) {
      if (placed.length >= q.maxResults) break;
      let i = cursor.get(source.name) ?? 0;
      while (i < source.results.length) {
        const r = source.results[i];
        i += 1;
        advanced = true;
        if (r !== undefined && consider(r) === "placed") break;
      }
      cursor.set(source.name, i);
    }
    if (!advanced) break;
  }
  return placed;
}

/**
 * Query every provider in parallel with a per-provider deadline (the M7
 * withDeadline race — a provider ignoring its signal still cannot hang the
 * loop). NEVER throws.
 *
 * R8 (ADR 0068): each provider runs an **episode** rather than a single
 * attempt — *claim the host's slot → one attempt under `timeoutMs` → on an
 * outcome the host itself invited a retry for, wait the backoff and claim
 * again* — the whole episode bounded by `episodeMs`. Providers still run in
 * parallel with one another: different hosts never block each other, and
 * `timeoutMs` is still the **attempt's** deadline rather than the call's.
 */
export async function searchLiterature(
  q: LiteratureQuery,
  opts: {
    providers: LiteratureProvider[];
    /** The ATTEMPT's deadline. Unchanged from R4. */
    timeoutMs?: number;
    /** The whole per-provider episode's bound: slot waits, attempts, backoff. */
    episodeMs?: number;
    /** Injectable for tests; production shares one process-wide pacer. */
    pacer?: LiteraturePacer;
    /**
     * V2 (ADR 0078 §5): titles to remove from every source's results BEFORE
     * the merge — in practice, the reviewed manuscript's own.
     *
     * Before the merge and not after, deliberately: an identity-tier match
     * would otherwise promote the manuscript to rank one and then have it
     * deleted, wasting the slot a real candidate should have had. This is the
     * part of the change that supersedes ADR 0067 §1 for a review run.
     */
    excludeTitles?: readonly string[];
    retry?: RetryPolicy;
    sleep?: LiteratureSleep;
    random?: () => number;
    /** The episode clock. The attempt deadline still uses real time. */
    now?: () => number;
  },
): Promise<LiteratureSearchReport> {
  const timeoutMs = opts.timeoutMs ?? LITERATURE_TIMEOUT_MS;
  const episodeMs = opts.episodeMs ?? LITERATURE_EPISODE_MS;
  const pacer = opts.pacer ?? defaultLiteraturePacer;
  const policy = opts.retry ?? LITERATURE_RETRY_POLICY;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  const deadline = now() + episodeMs;
  // Bounds the slot waits and the backoff sleeps. The attempt gets its own,
  // narrower signal below.
  const episodeSignal = AbortSignal.timeout(episodeMs);
  const remaining = () => deadline - now();

  /** One attempt, never throwing: the M7 withDeadline race, unchanged. */
  const attemptOnce = async (
    provider: LiteratureProvider,
  ): Promise<LiteratureSettledOutcome> => {
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(timeoutMs, remaining())),
    );
    try {
      return await new Promise<LiteratureProviderOutcome>((resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("lookup timeout")),
        );
        provider.search(q, signal).then(resolve, reject);
      });
    } catch (error) {
      return signal.aborted
        ? ({ kind: "timeout" } as const)
        : ({ kind: "failed", message: (error as Error).message } as const);
    }
  };

  const settled = await Promise.all(
    opts.providers.map(async (provider) => {
      let attempts = 0;
      let last: LiteratureSettledOutcome | undefined;
      try {
        for (;;) {
          if (remaining() <= 0) break;
          // Being polite is the FIRST thing that happens, before the request
          // and before the clock is spent on it.
          const turn = await pacer.claim(
            provider.name,
            provider.minIntervalMs ?? 0,
            episodeSignal,
          );
          if (!turn || remaining() <= 0) break;
          attempts += 1;
          const outcome = await attemptOnce(provider);
          // A LATER timeout never overwrites a verdict the host already gave.
          // The last attempt of an episode gets whatever is left of it — which
          // can be a deadline no host could meet — so without this line a 429
          // followed by a truncated attempt would be reported as `timeout`,
          // dropping the `retryAfterS` the host actually sent and contradicting
          // the rule stated at the return below.
          if (!(outcome.kind === "timeout" && last !== undefined)) {
            last = outcome;
          }
          const decision = decideLiteratureRetry(
            outcome,
            attempts,
            remaining(),
            policy,
            random,
          );
          if (decision.kind === "stop") break;
          if (!(await sleep(decision.delayMs, episodeSignal))) break;
        }
      } catch {
        // `searchLiterature` NEVER throws, and the two awaits above reach code
        // a caller can inject. A pacer or sleep that rejects ends this episode
        // and reports what the host had actually said — it does not become an
        // exception in the session loop.
      }
      return {
        provider,
        attempts,
        // `timeout` is the caller's verdict and is given ONLY when nothing
        // answered — a slot wait or an attempt that outlived the episode with
        // no word from the host. A host that said `rate_limited` and then ran
        // out of episode is reported as `rate_limited`, because that is what
        // it said.
        outcome: last ?? ({ kind: "timeout" } as const),
      };
    }),
  );

  // `sources[]` keeps PROVIDER-ARRAY order — it is the report of what each
  // host did, and a reader comparing two runs wants it stable. Only the merged
  // `results` are re-ranked, in `LITERATURE_SOURCE_ORDER`.
  const sources: LiteratureSearchReport["sources"] = settled.map(
    ({ provider, outcome, attempts }) => ({
      name: provider.name,
      endpoint: provider.endpoint,
      status:
        outcome.kind === "ok"
          ? ("ok" as const)
          : outcome.kind === "rate_limited"
            ? ("rate_limited" as const)
            : outcome.kind === "timeout"
              ? ("timeout" as const)
              : ("failed" as const),
      ...(outcome.kind === "rate_limited" && outcome.retryAfterS !== undefined
        ? { retryAfterS: outcome.retryAfterS }
        : {}),
      ...(provider.anonymous === true ? { anonymous: true as const } : {}),
      ...(attempts > 1 ? { attempts } : {}),
    }),
  );

  // V2 (ADR 0078 §5): removal happens HERE — over each source's own `ok`
  // results, before they are merged — so the manuscript is never a candidate
  // for the identity tier and never occupies a rank.
  const exclude = opts.excludeTitles ?? [];
  let withheldCount = 0;
  const forMerge = settled.map(({ provider, outcome }) => {
    if (exclude.length === 0 || outcome.kind !== "ok") {
      return { name: provider.name, outcome };
    }
    const kept = outcome.results.filter(
      (r) => !exclude.some((t) => sameTitle(r.title, t)),
    );
    withheldCount += outcome.results.length - kept.length;
    return { name: provider.name, outcome: { ...outcome, results: kept } };
  });

  const results = mergeLiterature(q, forMerge);
  return boundLiteratureReport({
    sources,
    ...(withheldCount > 0 ? { withheld: { ownTitle: withheldCount } } : {}),
    results,
  });
}
