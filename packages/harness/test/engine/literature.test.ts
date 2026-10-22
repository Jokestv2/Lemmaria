import { describe, expect, it } from "vitest";
import { createLiteraturePacer } from "../../src/engine/literature-pacer.js";
import type {
  HttpFetchLike,
  LiteratureProvider,
  LiteratureProviderOutcome,
  LiteratureResult,
  LiteratureSearchReport,
  LiteratureSourceName,
} from "../../src/engine/literature.js";
import {
  ARXIV_MIN_INTERVAL_MS,
  CROSSREF_MIN_INTERVAL_MS,
  DBLP_MIN_INTERVAL_MS,
  LITERATURE_ABSTRACT_MAX_CHARS,
  LITERATURE_MAX_AUTHORS,
  LITERATURE_REPORT_MAX_CHARS,
  LITERATURE_SOURCE_ORDER,
  SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
  arxivLiterature,
  boundLiteratureReport,
  crossrefLiterature,
  dblpLiterature,
  mergeLiterature,
  sameTitle,
  searchLiterature,
  semanticScholarLiterature,
  titleKey,
} from "../../src/engine/literature.js";

/** A canned JSON response. */
function okJson(body: unknown): ReturnType<HttpFetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function rateLimited(retryAfter?: string): ReturnType<HttpFetchLike> {
  return Promise.resolve({
    ok: false,
    status: 429,
    headers: {
      get: (n: string) =>
        n.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null,
    },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  });
}

const QUERY = { query: "attention is all you need", maxResults: 5 };
const SIGNAL = AbortSignal.timeout(2000);

describe("crossrefLiterature", () => {
  const body = {
    message: {
      items: [
        {
          title: ["Attention Is All You Need"],
          author: [{ given: "Ashish", family: "Vaswani" }],
          issued: { "date-parts": [[2017, 6]] },
          "container-title": ["NeurIPS"],
          DOI: "10.1000/tf",
          URL: "https://doi.org/10.1000/tf",
          abstract: "<jats:p>The dominant sequence models…</jats:p>",
        },
      ],
    },
  };

  it("maps a success body to results", async () => {
    const urls: string[] = [];
    const provider = crossrefLiterature({
      fetchImpl: (url) => {
        urls.push(url);
        return okJson(body);
      },
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error(`expected ok: ${outcome.kind}`);
    expect(outcome.results[0]).toMatchObject({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani"],
      year: "2017",
      venue: "NeurIPS",
      doi: "10.1000/tf",
      source: "crossref",
    });
    expect(outcome.results[0]?.abstract).toContain("dominant sequence");
    expect(urls[0]).toContain("query.bibliographic=");
    expect(urls[0]).not.toContain("mailto");
  });

  it("sends the polite-pool mailto + UA only when configured", async () => {
    let sawUrl = "";
    let sawHeaders: Record<string, string> | undefined;
    const provider = crossrefLiterature({
      fetchImpl: (url, init) => {
        sawUrl = url;
        sawHeaders = init?.headers;
        return okJson({ message: { items: [] } });
      },
      mailto: "ops@example.org",
    });
    await provider.search(QUERY, SIGNAL);
    expect(sawUrl).toContain("mailto=ops%40example.org");
    expect(sawHeaders?.["User-Agent"]).toContain("mailto:ops@example.org");
  });

  it("maps 429 to an honest rate_limited with Retry-After", async () => {
    const provider = crossrefLiterature({
      fetchImpl: () => rateLimited("30"),
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    expect(outcome).toEqual({ kind: "rate_limited", retryAfterS: 30 });
  });

  it("carries NO year when Crossref dates the work `[[null]]`", async () => {
    // V2's gate review, issue 3. Crossref really sends this — the record for
    // `10.1109/eurmic.2002.1046142` has `issued.date-parts = [[null]]`, and a
    // `!== undefined` test waves `null` through into `String(null)`. The
    // manual run read `… image segmentation (null)` in the tab, and the two
    // assistant drafts carried it too.
    //
    // An undated result is a legitimate state that already renders with no
    // parentheses. The Semantic Scholar branch has guarded `null` since it was
    // written; this asserts the two behave the same.
    const provider = crossrefLiterature({
      fetchImpl: () =>
        okJson({
          message: {
            items: [
              {
                title: ["Dynamic task scheduling with speculative approach"],
                author: [{ given: "A.", family: "Wakatani" }],
                issued: { "date-parts": [[null]] },
              },
            ],
          },
        }),
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error(`expected ok: ${outcome.kind}`);
    expect(outcome.results[0]).not.toHaveProperty("year");
  });

  it("carries NO year when Crossref omits `issued` altogether", async () => {
    const provider = crossrefLiterature({
      fetchImpl: () =>
        okJson({ message: { items: [{ title: ["Undated Work"] }] } }),
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error(`expected ok: ${outcome.kind}`);
    expect(outcome.results[0]).not.toHaveProperty("year");
  });
});

describe("dblpLiterature", () => {
  it("maps hits and omits abstracts (dblp has none)", async () => {
    const provider = dblpLiterature({
      fetchImpl: () =>
        okJson({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    title: "Attention Is All You Need.",
                    authors: { author: [{ text: "Ashish Vaswani" }] },
                    year: "2017",
                    venue: "NIPS",
                    doi: "10.1000/TF",
                    url: "https://dblp.org/rec/x",
                  },
                },
              ],
            },
          },
        }),
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.results[0]).toMatchObject({
      title: "Attention Is All You Need.",
      authors: ["Ashish Vaswani"],
      year: "2017",
      venue: "NIPS",
      source: "dblp",
    });
    expect(outcome.results[0]?.abstract).toBeUndefined();
  });
});

describe("semanticScholarLiterature", () => {
  it("maps data[] and sends x-api-key only when given", async () => {
    let sawHeaders: Record<string, string> | undefined;
    const body = {
      data: [
        {
          title: "Attention Is All You Need",
          authors: [{ name: "Ashish Vaswani" }],
          year: 2017,
          venue: "NeurIPS",
          externalIds: { DOI: "10.1000/tf" },
          abstract: "The dominant sequence models…",
          url: "https://semanticscholar.org/x",
        },
      ],
    };
    const withKey = semanticScholarLiterature({
      fetchImpl: (_url, init) => {
        sawHeaders = init?.headers;
        return okJson(body);
      },
      apiKey: "s2key",
    });
    const outcome = await withKey.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.results[0]).toMatchObject({
      title: "Attention Is All You Need",
      year: "2017",
      doi: "10.1000/tf",
      source: "semantic_scholar",
    });
    expect(sawHeaders?.["x-api-key"]).toBe("s2key");

    sawHeaders = undefined;
    const withoutKey = semanticScholarLiterature({
      fetchImpl: (_url, init) => {
        sawHeaders = init?.headers;
        return okJson(body);
      },
    });
    await withoutKey.search(QUERY, SIGNAL);
    expect(sawHeaders?.["x-api-key"]).toBeUndefined();
  });
});

describe("arxivLiterature", () => {
  const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need &amp; More</title>
    <summary>  The dominant sequence transduction models are based on RNNs.
</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Another Paper</title>
    <summary>Something else.</summary>
    <author><name>A. Author</name></author>
  </entry>
</feed>`;

  function atomFetch(): HttpFetchLike {
    return () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.reject(new Error("not json")),
        text: () => Promise.resolve(ATOM),
      });
  }

  it("parses Atom entries: title (entities unescaped), authors, year, abstract, url", async () => {
    const provider = arxivLiterature({
      fetchImpl: atomFetch(),
      minIntervalMs: 0,
    });
    const outcome = await provider.search(QUERY, SIGNAL);
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({
      title: "Attention Is All You Need & More",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: "2017",
      url: "http://arxiv.org/abs/1706.03762v7",
      source: "arxiv",
    });
    expect(outcome.results[0]?.abstract).toContain(
      "dominant sequence transduction",
    );
  });

  it("declares its host's interval and no longer paces itself (R8/O3)", async () => {
    // R8 moved the pacing out of this factory and into `searchLiterature`
    // (ADR 0068), so the provider is now free of it: two direct calls run back
    // to back. The two properties the old tests asserted are asserted below,
    // one seam further out — the SAME two properties, not weaker ones.
    expect(arxivLiterature().minIntervalMs).toBe(ARXIV_MIN_INTERVAL_MS);
    expect(arxivLiterature({ minIntervalMs: 5 }).minIntervalMs).toBe(5);

    const at: number[] = [];
    const provider = arxivLiterature({
      fetchImpl: () => {
        at.push(Date.now());
        return atomFetch()("", {});
      },
      minIntervalMs: 3000,
    });
    const started = Date.now();
    await provider.search(QUERY, AbortSignal.timeout(5000));
    await provider.search(QUERY, AbortSignal.timeout(5000));
    expect(at).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("searchLiterature paces per host (R8/O3, moved from arxivLiterature)", () => {
  /** An arXiv provider that records when its fetch actually went out. */
  function recordingArxiv(at: number[], minIntervalMs: number) {
    return arxivLiterature({
      fetchImpl: () => {
        at.push(Date.now());
        return atomFetch()("", {});
      },
      minIntervalMs,
    });
  }

  it("paces successive requests by the declared minIntervalMs", async () => {
    const at: number[] = [];
    // A pacer of its own: the process-wide one is shared with every other
    // caller, and this test is about the mechanism, not about that instance.
    const pacer = createLiteraturePacer();
    const provider = recordingArxiv(at, 120);
    const opts = { providers: [provider], pacer };
    await searchLiterature(QUERY, opts);
    await searchLiterature(QUERY, opts);
    expect(at).toHaveLength(2);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(100);
  });

  it("paces CONCURRENT requests too (B3: literature_search became parallel)", async () => {
    // The regression B3's review caught: the pacing used to be a timestamp
    // read before an await and written after it, so three calls launched in
    // one tick all read the same stale value, waited the same interval and
    // fired together. A host asks for an INTERVAL — the tool batch's
    // concurrency width is not a substitute for it.
    const at: number[] = [];
    const pacer = createLiteraturePacer();
    const provider = recordingArxiv(at, 120);
    const opts = { providers: [provider], pacer };
    await Promise.all([
      searchLiterature(QUERY, opts),
      searchLiterature(QUERY, opts),
      searchLiterature(QUERY, opts),
    ]);
    expect(at).toHaveLength(3);
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(100);
  });

  it("asks the pacer with a ZERO interval when the host declares none", async () => {
    const claims: string[] = [];
    const spy = {
      claim: async (name: string, minIntervalMs: number) => {
        claims.push(`${name}:${minIntervalMs}`);
        return true;
      },
    };
    const scripted: LiteratureProvider = {
      name: "dblp",
      endpoint: "https://dblp.org/search/publ/api",
      search: async () => ({ kind: "ok", results: [] }),
    };
    await searchLiterature(QUERY, { providers: [scripted], pacer: spy });
    // The seam still ASKS the pacer — it is the pacer that resolves at once
    // for a zero interval, which is what keeps the rule in one place.
    expect(claims).toEqual(["dblp:0"]);
  });

  it("every shipping factory declares its host's interval (R8/O2)", () => {
    expect(crossrefLiterature().minIntervalMs).toBe(CROSSREF_MIN_INTERVAL_MS);
    expect(dblpLiterature().minIntervalMs).toBe(DBLP_MIN_INTERVAL_MS);
    expect(semanticScholarLiterature().minIntervalMs).toBe(
      SEMANTIC_SCHOLAR_MIN_INTERVAL_MS,
    );
    expect(arxivLiterature().minIntervalMs).toBe(ARXIV_MIN_INTERVAL_MS);
    // Deny-by-default, and DERIVED so it stays that way: the loop walks
    // `LITERATURE_SOURCE_ORDER` — the canonical list of the sources we ship —
    // rather than a hand-written array that a fifth host would simply not be
    // added to. Adding a name there without a factory, or with one that forgets
    // to declare, fails HERE rather than silently bursting a host in production.
    // (R4's own `ALL_TOOL_NAMES`-derived parallel set is the same idiom.)
    const factories: Record<LiteratureSourceName, () => LiteratureProvider> = {
      arxiv: arxivLiterature,
      crossref: crossrefLiterature,
      dblp: dblpLiterature,
      semantic_scholar: semanticScholarLiterature,
    };
    for (const name of LITERATURE_SOURCE_ORDER) {
      const factory = factories[name];
      expect(`${name}: ${typeof factory}`).toBe(`${name}: function`);
      const provider = factory();
      expect(provider.name).toBe(name);
      expect(provider.minIntervalMs ?? 0).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// R8 (ADR 0068) — the episode: claim, attempt, back off when the host asked,
// and stop. Every wait here is injected, so the block costs milliseconds.
// ---------------------------------------------------------------------------

describe("searchLiterature — the episode (R8/O5)", () => {
  /** A provider that answers a scripted queue and records its signals. */
  function scripted(
    name: LiteratureSourceName,
    queue: LiteratureProviderOutcome[],
  ): LiteratureProvider & { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    let i = 0;
    return {
      name,
      endpoint: `https://example.invalid/${name}`,
      signals,
      search: async (_q, signal) => {
        signals.push(signal);
        const outcome = queue[Math.min(i, queue.length - 1)];
        i += 1;
        return outcome ?? { kind: "failed", message: "empty script" };
      },
    };
  }

  const INSTANT = {
    sleep: async () => true,
    pacer: createLiteraturePacer({ sleep: async () => true }),
    random: () => 0,
  };
  const rl = (retryAfterS?: number): LiteratureProviderOutcome =>
    retryAfterS === undefined
      ? { kind: "rate_limited" }
      : { kind: "rate_limited", retryAfterS };
  const http = (status: number): LiteratureProviderOutcome => ({
    kind: "failed",
    message: `http ${status}`,
    status,
  });
  const okWith = (title: string): LiteratureProviderOutcome => ({
    kind: "ok",
    results: [{ title, authors: [], source: "crossref" }],
  });

  it("retries a 429 until the host answers, and counts the attempts", async () => {
    const provider = scripted("crossref", [rl(), rl(), okWith("Found")]);
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [provider], ...INSTANT },
    );
    expect(report.sources[0]).toMatchObject({
      name: "crossref",
      status: "ok",
      attempts: 3,
    });
    expect(report.results.map((r) => r.title)).toEqual(["Found"]);
  });

  it("reports the host's own last word when the retries run out", async () => {
    const provider = scripted("crossref", [rl(), rl(), rl()]);
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [provider], ...INSTANT },
    );
    expect(report.sources[0]).toMatchObject({
      status: "rate_limited",
      attempts: 3,
    });
  });

  it("retries the overload family", async () => {
    const provider = scripted("dblp", [http(503), okWith("Found")]);
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [provider], ...INSTANT },
    );
    expect(report.sources[0]).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("does not retry a refusal, and says nothing about attempts when it asked once", async () => {
    const provider = scripted("dblp", [http(404), okWith("never reached")]);
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [provider], ...INSTANT },
    );
    expect(report.sources[0]).toMatchObject({ status: "failed" });
    expect(report.sources[0]).not.toHaveProperty("attempts");
    expect(provider.signals).toHaveLength(1);
  });

  it("reports timeout — and nothing else — when the slot wait outlives the episode", async () => {
    // Nothing answered: no attempt was made at all, so the caller's own
    // verdict is the only honest one, and there are no attempts to count.
    const provider = scripted("arxiv", [okWith("never reached")]);
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [provider],
        pacer: { claim: async () => false },
        sleep: async () => true,
      },
    );
    expect(report.sources[0]).toMatchObject({
      name: "arxiv",
      status: "timeout",
    });
    expect(report.sources[0]).not.toHaveProperty("attempts");
    expect(provider.signals).toHaveLength(0);
  });

  it("keeps the host's word when the RETRY wait outlives the episode", async () => {
    // A clock the provider and the backoff sleep both advance, so the episode
    // runs out deterministically rather than on the wall clock.
    let t = 0;
    const provider: LiteratureProvider = {
      name: "semantic_scholar",
      endpoint: "https://api.semanticscholar.org/graph/v1",
      search: async () => {
        t += 400;
        return { kind: "rate_limited" };
      },
    };
    let attempts = 0;
    const counting: LiteratureProvider = {
      ...provider,
      search: async (q, s) => {
        attempts += 1;
        return provider.search(q, s);
      },
    };
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [counting],
        episodeMs: 1000,
        now: () => t,
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
        random: () => 0,
        sleep: async (ms) => {
          t += ms;
          return true;
        },
        pacer: createLiteraturePacer({ sleep: async () => true }),
      },
    );
    expect(attempts).toBe(2);
    expect(report.sources[0]).toMatchObject({
      status: "rate_limited",
      attempts: 2,
    });
  });

  it("keeps the host's word when the FINAL attempt is truncated by the episode", async () => {
    // The last attempt of an episode gets whatever is left of it, which can be
    // a deadline no host could meet. That self-inflicted `timeout` must not
    // overwrite the 429 the host really sent, or the report would drop a
    // `retryAfterS` and tell the model the wrong thing about the host.
    let t = 0;
    let call = 0;
    const provider: LiteratureProvider = {
      name: "dblp",
      endpoint: "https://dblp.org/search/publ/api",
      search: async () => {
        call += 1;
        if (call === 1) {
          t += 100;
          return { kind: "rate_limited", retryAfterS: 1 };
        }
        // The truncated attempt: it burns what is left and never answers.
        t += 1000;
        return { kind: "timeout" };
      },
    };
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [provider],
        episodeMs: 1200,
        now: () => t,
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
        random: () => 0,
        sleep: async (ms) => {
          t += ms;
          return true;
        },
        pacer: createLiteraturePacer({ sleep: async () => true }),
      },
    );
    expect(call).toBe(2);
    expect(report.sources[0]).toMatchObject({
      name: "dblp",
      status: "rate_limited",
      retryAfterS: 1,
      attempts: 2,
    });
  });

  it("NEVER throws when the injected pacer or sleep rejects", async () => {
    // Both are caller-supplied seams, and `searchLiterature`'s contract is that
    // a source's trouble arrives as DATA. A rejecting seam ends that provider's
    // episode; it does not become an exception in the session loop.
    const boom = async (): Promise<never> => {
      throw new Error("boom");
    };
    const provider = scripted("crossref", [rl(1), okWith("never reached")]);

    const fromPacer = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [provider],
        pacer: { claim: boom },
        sleep: async () => true,
      },
    );
    expect(fromPacer.sources[0]).toMatchObject({
      name: "crossref",
      status: "timeout",
    });
    expect(fromPacer.sources[0]).not.toHaveProperty("attempts");

    const other = scripted("crossref", [rl(1), okWith("never reached")]);
    const fromSleep = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [other],
        pacer: createLiteraturePacer({ sleep: async () => true }),
        sleep: boom,
        random: () => 0,
      },
    );
    // One attempt DID happen and the host answered, so its word is reported
    // rather than the seam's failure.
    expect(fromSleep.sources[0]).toMatchObject({
      name: "crossref",
      status: "rate_limited",
      retryAfterS: 1,
    });
  });

  it("runs providers in parallel — one host's episode never blocks another's", async () => {
    // If the episodes were serialised this deadlocks and the test times out,
    // which is a stronger statement than any elapsed-time comparison.
    let releaseBoth = (): void => {};
    const bothStarted = new Promise<void>((resolve) => {
      let started = 0;
      releaseBoth = () => {
        started += 1;
        if (started === 2) resolve();
      };
    });
    const gated = (name: LiteratureSourceName): LiteratureProvider => ({
      name,
      endpoint: `https://example.invalid/${name}`,
      search: async () => {
        releaseBoth();
        await bothStarted;
        return { kind: "ok", results: [] };
      },
    });
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [gated("crossref"), gated("dblp")], ...INSTANT },
    );
    expect(report.sources.map((s) => s.status)).toEqual(["ok", "ok"]);
  });

  it("gives every attempt its own signal", async () => {
    const provider = scripted("crossref", [rl(), rl(), okWith("Found")]);
    await searchLiterature(
      { query: "q", maxResults: 5 },
      { providers: [provider], ...INSTANT },
    );
    expect(provider.signals).toHaveLength(3);
    expect(new Set(provider.signals).size).toBe(3);
  });

  it("carries attempts on all four sources and still fits the bound (R8/O7)", async () => {
    const bulky = (name: LiteratureSourceName): LiteratureProvider => ({
      name,
      endpoint: `https://example.invalid/${name}`,
      minIntervalMs: 0,
      search: (() => {
        let n = 0;
        return async () => {
          n += 1;
          return n < 3
            ? { kind: "rate_limited" as const }
            : {
                kind: "ok" as const,
                results: Array.from({ length: 5 }, (_, i) => ({
                  title: `${name} paper ${i}`,
                  authors: ["A. Author"],
                  abstract: "x".repeat(900),
                  doi: `10.1/${name}-${i}`,
                  source: name,
                })),
              };
        };
      })(),
    });
    const report = await searchLiterature(
      { query: "q", maxResults: 20 },
      {
        providers: [
          bulky("arxiv"),
          bulky("crossref"),
          bulky("dblp"),
          bulky("semantic_scholar"),
        ],
        ...INSTANT,
      },
    );
    for (const source of report.sources) {
      expect(`${source.name}: ${source.attempts}`).toBe(`${source.name}: 3`);
    }
    const json = JSON.stringify(report);
    expect(json.length).toBeLessThanOrEqual(LITERATURE_REPORT_MAX_CHARS);
    expect(json.indexOf('"sources"')).toBeLessThan(json.indexOf('"results"'));
  });
});

describe("searchLiterature (the never-throws report)", () => {
  it("merges, dedupes by DOI, and reports per-source statuses", async () => {
    const a = crossrefLiterature({
      fetchImpl: () =>
        okJson({
          message: {
            items: [
              { title: ["Shared"], DOI: "10.1/x", author: [] },
              { title: ["Crossref only"], DOI: "10.1/c", author: [] },
            ],
          },
        }),
    });
    const b = semanticScholarLiterature({
      fetchImpl: () =>
        okJson({
          data: [
            { title: "Shared", externalIds: { DOI: "10.1/X" }, authors: [] },
            { title: "S2 only", externalIds: {}, authors: [] },
          ],
        }),
    });
    const report = await searchLiterature(
      { query: "q", maxResults: 10 },
      { providers: [a, b] },
    );
    const titles = report.results.map((r) => r.title);
    expect(titles).toContain("Shared");
    expect(titles).toContain("Crossref only");
    expect(titles).toContain("S2 only");
    expect(titles.filter((t) => t === "Shared")).toHaveLength(1);
    expect(report.sources).toEqual([
      expect.objectContaining({ name: "crossref", status: "ok" }),
      expect.objectContaining({ name: "semantic_scholar", status: "ok" }),
    ]);
  });

  it("converts a hang to a timeout status and a 429 to rate_limited — never throws", async () => {
    const hang = dblpLiterature({
      fetchImpl: () => new Promise(() => {}),
    });
    const limited = crossrefLiterature({ fetchImpl: () => rateLimited("7") });
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [hang, limited],
        timeoutMs: 30,
        // R8: a 429 carrying `Retry-After: 7` is now retried — the assertions
        // below are unchanged, and the waits are made instant so the case
        // keeps costing milliseconds. What it pins is the honest MAPPING of a
        // hang and a 429, which is what it always pinned.
        pacer: createLiteraturePacer({ sleep: async () => true }),
        sleep: async () => true,
      },
    );
    expect(report.results).toEqual([]);
    expect(report.sources).toEqual([
      expect.objectContaining({ name: "dblp", status: "timeout" }),
      expect.objectContaining({
        name: "crossref",
        status: "rate_limited",
        retryAfterS: 7,
      }),
    ]);
  });

  it("a throwing provider reports failed and the report caps at maxResults", async () => {
    const boom = dblpLiterature({
      fetchImpl: () => Promise.reject(new Error("conn reset")),
    });
    const many = crossrefLiterature({
      fetchImpl: () =>
        okJson({
          message: {
            items: Array.from({ length: 9 }, (_, i) => ({
              title: [`P${i}`],
              DOI: `10.1/${i}`,
              author: [],
            })),
          },
        }),
    });
    const report = await searchLiterature(
      { query: "q", maxResults: 3 },
      { providers: [boom, many] },
    );
    expect(report.results).toHaveLength(3);
    expect(report.sources[0]).toMatchObject({ name: "dblp", status: "failed" });
  });
});

// ---------------------------------------------------------------------------
// R4 (ADR 0067) — the merge takes turns, and identity comes first.
//
// The scripted shapes below are modelled on S5's five queries
// (80-v03-review-spike.md § 4): per-source counts, abstract coverage and the
// exact-title target's position are the ones that measurement recorded. They
// are MODELS of those shapes, not replayed provider bodies — the spike kept
// counts and top-3 titles, never raw responses.
// ---------------------------------------------------------------------------

const LONGFORMER = "Longformer: The Long-Document Transformer";

/** `n` results from `source`, titled `<source> 1..n`; opts add the fields S5
 *  measured (arXiv 100 % abstracts, Crossref 0–50 %, DBLP 0 %). */
function scripted(
  source: LiteratureSourceName,
  n: number,
  opts?: { abstracts?: boolean; dois?: boolean; titles?: string[] },
): LiteratureResult[] {
  return Array.from({ length: n }, (_, i) => ({
    title: opts?.titles?.[i] ?? `${source} ${i + 1}`,
    authors: [`${source} author ${i + 1}`],
    ...(opts?.abstracts ? { abstract: `abstract of ${source} ${i + 1}` } : {}),
    ...(opts?.dois ? { doi: `10.5555/${source}-${i + 1}` } : {}),
    source,
  }));
}

const okOutcome = (results: LiteratureResult[]) =>
  ({ kind: "ok", results }) as const;

type ScriptedOutcome = {
  name: LiteratureSourceName;
  outcome: LiteratureProviderOutcome;
};

/** S5's five queries as outcome shapes, in the order the spike lists them. */
const S5_SHAPES: Record<string, ScriptedOutcome[]> = {
  // Broad problem: Crossref ok 8 (4 abstracts), DBLP ok 2, arXiv ok 8 (8
  // abstracts), Semantic Scholar rate_limited.
  broad: [
    { name: "crossref", outcome: okOutcome(scripted("crossref", 8)) },
    { name: "dblp", outcome: okOutcome(scripted("dblp", 2)) },
    {
      name: "arxiv",
      outcome: okOutcome(scripted("arxiv", 8, { abstracts: true })),
    },
    { name: "semantic_scholar", outcome: { kind: "rate_limited" } },
  ],
  // Technique: Crossref ok 8, DBLP rate_limited, arXiv ok 8, S2 rate_limited.
  technique: [
    { name: "crossref", outcome: okOutcome(scripted("crossref", 8)) },
    { name: "dblp", outcome: { kind: "rate_limited" } },
    {
      name: "arxiv",
      outcome: okOutcome(scripted("arxiv", 8, { abstracts: true })),
    },
    { name: "semantic_scholar", outcome: { kind: "rate_limited" } },
  ],
  // Benchmark: Crossref ok 8 (junk), DBLP timeout, arXiv ok 8, S2 rate_limited.
  benchmark: [
    { name: "crossref", outcome: okOutcome(scripted("crossref", 8)) },
    { name: "dblp", outcome: { kind: "failed", message: "timeout" } },
    {
      name: "arxiv",
      outcome: okOutcome(scripted("arxiv", 8, { abstracts: true })),
    },
    { name: "semantic_scholar", outcome: { kind: "rate_limited" } },
  ],
  // Related problem, run 2: Crossref rate_limited, DBLP failed, arXiv ok 8.
  related: [
    { name: "crossref", outcome: { kind: "rate_limited" } },
    { name: "dblp", outcome: { kind: "failed", message: "conn reset" } },
    {
      name: "arxiv",
      outcome: okOutcome(scripted("arxiv", 8, { abstracts: true })),
    },
    { name: "semantic_scholar", outcome: { kind: "rate_limited" } },
  ],
  // Exact title: the target is arXiv's #1 and absent from Crossref's eight.
  exactTitle: [
    { name: "crossref", outcome: okOutcome(scripted("crossref", 8)) },
    { name: "dblp", outcome: { kind: "failed", message: "conn reset" } },
    {
      name: "arxiv",
      outcome: okOutcome(
        scripted("arxiv", 8, { abstracts: true, titles: [LONGFORMER] }),
      ),
    },
    { name: "semantic_scholar", outcome: { kind: "rate_limited" } },
  ],
};

/** Every ordering of `items` — the merge must not depend on any of them. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe("mergeLiterature (the interleave, ADR 0067)", () => {
  it("represents every source that answered ok with at least one result", () => {
    for (const [name, shape] of Object.entries(S5_SHAPES)) {
      const answered = shape
        .filter((s) => s.outcome.kind === "ok" && s.outcome.results.length > 0)
        .map((s) => s.name)
        .sort();
      const merged = mergeLiterature(
        { query: "attention", maxResults: 8 },
        shape,
      );
      const represented = [...new Set(merged.map((r) => r.source))].sort();
      expect(`${name}: ${represented.join(",")}`).toBe(
        `${name}: ${answered.join(",")}`,
      );
    }
  });

  it("takes turns by per-source rank in LITERATURE_SOURCE_ORDER", () => {
    // arXiv 8, Crossref 8, DBLP 2 answering; canonical order is alphabetical,
    // so round 1 is arxiv/crossref/dblp and DBLP is exhausted after round 2.
    const merged = mergeLiterature(
      { query: "attention", maxResults: 8 },
      S5_SHAPES.broad ?? [],
    );
    expect(merged.map((r) => r.title)).toEqual([
      "arxiv 1",
      "crossref 1",
      "dblp 1",
      "arxiv 2",
      "crossref 2",
      "dblp 2",
      "arxiv 3",
      "crossref 3",
    ]);
  });

  it("stops at maxResults", () => {
    const merged = mergeLiterature(
      { query: "attention", maxResults: 3 },
      S5_SHAPES.broad ?? [],
    );
    expect(merged.map((r) => r.title)).toEqual([
      "arxiv 1",
      "crossref 1",
      "dblp 1",
    ]);
  });

  it("the exact-title target is first even though Crossref answered first", () => {
    const merged = mergeLiterature(
      { query: LONGFORMER, maxResults: 8 },
      S5_SHAPES.exactTitle ?? [],
    );
    expect(merged[0]).toMatchObject({ title: LONGFORMER, source: "arxiv" });
  });

  it("a title match from the LAST canonical source still comes first", () => {
    const merged = mergeLiterature({ query: LONGFORMER, maxResults: 8 }, [
      { name: "arxiv", outcome: okOutcome(scripted("arxiv", 4)) },
      {
        name: "semantic_scholar",
        outcome: okOutcome(
          scripted("semantic_scholar", 4, { titles: ["x", LONGFORMER] }),
        ),
      },
    ]);
    expect(merged[0]).toMatchObject({
      title: LONGFORMER,
      source: "semantic_scholar",
    });
  });

  it("a DOI-shaped query places the DOI-matching result first", () => {
    for (const query of [
      "10.5555/crossref-4",
      "doi:10.5555/CROSSREF-4",
      "https://doi.org/10.5555/crossref-4",
    ]) {
      const merged = mergeLiterature({ query, maxResults: 8 }, [
        {
          name: "arxiv",
          outcome: okOutcome(scripted("arxiv", 4, { dois: true })),
        },
        {
          name: "crossref",
          outcome: okOutcome(scripted("crossref", 8, { dois: true })),
        },
      ]);
      expect(`${query}: ${merged[0]?.title}`).toBe(`${query}: crossref 4`);
    }
  });

  it("an empty identity key never matches", () => {
    // A query of pure punctuation normalises to "", which must not select the
    // first result whose title also normalises to "" (invariant 6 rule 1:
    // titles arrive in whatever script they were written in).
    const merged = mergeLiterature({ query: "《》——", maxResults: 4 }, [
      {
        name: "crossref",
        outcome: okOutcome(scripted("crossref", 2, { titles: ["《》", "b"] })),
      },
      { name: "arxiv", outcome: okOutcome(scripted("arxiv", 2)) },
    ]);
    expect(merged.map((r) => r.title)).toEqual([
      "arxiv 1",
      "《》",
      "arxiv 2",
      "b",
    ]);
  });

  it("two distinct non-Latin titles both survive the dedup", () => {
    // Both normalise to the empty title key; an empty key is NOT a key.
    const merged = mergeLiterature({ query: "长文本", maxResults: 8 }, [
      {
        name: "arxiv",
        outcome: okOutcome(
          scripted("arxiv", 2, {
            titles: ["长上下文注意力", "稀疏注意力路由"],
          }),
        ),
      },
    ]);
    expect(merged.map((r) => r.title)).toEqual([
      "长上下文注意力",
      "稀疏注意力路由",
    ]);
  });

  it("an arXiv preprint and its Crossref twin collapse into one filled entry", () => {
    const merged = mergeLiterature({ query: "attention", maxResults: 8 }, [
      {
        name: "crossref",
        outcome: okOutcome([
          {
            title: "Longformer: the long-document transformer!",
            authors: ["Beltagy"],
            doi: "10.1/longformer",
            venue: "TACL",
            year: "2020",
            source: "crossref",
          },
        ]),
      },
      {
        name: "arxiv",
        outcome: okOutcome([
          {
            title: LONGFORMER,
            authors: ["Beltagy"],
            abstract: "we present Longformer",
            url: "https://arxiv.org/abs/2004.05150",
            source: "arxiv",
          },
        ]),
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      title: LONGFORMER,
      authors: ["Beltagy"],
      abstract: "we present Longformer",
      url: "https://arxiv.org/abs/2004.05150",
      doi: "10.1/longformer",
      venue: "TACL",
      year: "2020",
      source: "arxiv",
    });
  });

  it("a source advances past a duplicate inside the same round", () => {
    // D1's round r takes each source's r-th REMAINING result: Crossref's first
    // hit is the arXiv entry's published twin, so it is folded in and Crossref
    // still spends its turn on the next result it actually owns. Losing the
    // turn instead would break the representation property for exactly the
    // source whose top hit another index also returned.
    const merged = mergeLiterature({ query: "attention", maxResults: 3 }, [
      {
        name: "arxiv",
        outcome: okOutcome([
          {
            title: "A preprint title",
            authors: [],
            doi: "10.1/same",
            source: "arxiv",
          },
          { title: "arxiv second", authors: [], source: "arxiv" },
        ]),
      },
      {
        name: "crossref",
        outcome: okOutcome([
          {
            title: "The published title",
            authors: [],
            doi: "10.1/SAME",
            venue: "NeurIPS",
            source: "crossref",
          },
          { title: "crossref second", authors: [], source: "crossref" },
        ]),
      },
    ]);
    expect(merged.map((r) => r.title)).toEqual([
      "A preprint title",
      "crossref second",
      "arxiv second",
    ]);
    // DOI-equal entries with different titles collapse, the surviving entry
    // keeps its own source and position, and the duplicate never eats a slot.
    expect(merged[0]).toMatchObject({ venue: "NeurIPS", source: "arxiv" });
  });

  it("a DOI learned from a duplicate is itself deduped against", () => {
    // The Crossref twin fills the arXiv entry's missing DOI; a third result
    // carrying that DOI under a third title must not slip through.
    const merged = mergeLiterature({ query: "attention", maxResults: 8 }, [
      {
        name: "arxiv",
        outcome: okOutcome([
          { title: "same title", authors: [], source: "arxiv" },
        ]),
      },
      {
        name: "crossref",
        outcome: okOutcome([
          {
            title: "same title",
            authors: [],
            doi: "10.1/learned",
            source: "crossref",
          },
        ]),
      },
      {
        name: "dblp",
        outcome: okOutcome([
          {
            title: "a quite different title",
            authors: [],
            doi: "10.1/learned",
            source: "dblp",
          },
        ]),
      },
    ]);
    expect(merged.map((r) => r.title)).toEqual(["same title"]);
  });

  it("is identical under every permutation of the outcomes array", () => {
    for (const [name, shape] of Object.entries(S5_SHAPES)) {
      const query = name === "exactTitle" ? LONGFORMER : "attention";
      const expected = mergeLiterature({ query, maxResults: 8 }, shape);
      for (const permuted of permutations(shape)) {
        const got = mergeLiterature({ query, maxResults: 8 }, permuted);
        expect(`${name}: ${got.map((r) => r.title).join("|")}`).toBe(
          `${name}: ${expected.map((r) => r.title).join("|")}`,
        );
      }
    }
  });
});

describe("boundLiteratureReport (R4/D4 — the envelope never eats the statuses)", () => {
  /** A report the interleave could really produce: arXiv carries an abstract
   *  for every hit (S5: 100 % coverage), so 20 results is 20 abstracts. */
  function fatReport(): LiteratureSearchReport {
    return {
      sources: [
        {
          name: "crossref",
          endpoint: "https://api.crossref.org",
          status: "ok",
        },
        {
          name: "semantic_scholar",
          endpoint: "https://api.semanticscholar.org/graph/v1",
          status: "rate_limited",
        },
      ],
      results: Array.from({ length: 20 }, (_, i) => ({
        title: `a long-context attention paper, number ${i + 1}`,
        authors: Array.from(
          { length: 30 },
          (_, a) => `Author ${a + 1} of the very large collaboration`,
        ),
        abstract: "x".repeat(3000),
        venue: "Transactions of the Association for Computational Linguistics",
        doi: `10.5555/long-context-attention-${i + 1}`,
        url: `https://arxiv.org/abs/2400.0${i + 1}`,
        source: "arxiv" as const,
      })),
    };
  }

  it("serializes under LITERATURE_REPORT_MAX_CHARS with sources first", () => {
    const json = JSON.stringify(boundLiteratureReport(fatReport()));
    expect(json.length).toBeLessThanOrEqual(LITERATURE_REPORT_MAX_CHARS);
    // capToolResult keeps a HEAD slice, so the statuses must be in the head.
    expect(json.indexOf('"sources"')).toBeLessThan(json.indexOf('"results"'));
    expect(json).toContain("rate_limited");
  });

  it("cuts an over-long abstract to LITERATURE_ABSTRACT_MAX_CHARS with an ellipsis", () => {
    const bounded = boundLiteratureReport({
      sources: [],
      results: [
        {
          title: "one",
          authors: [],
          abstract: "x".repeat(3000),
          source: "arxiv",
        },
      ],
    });
    expect(bounded.results[0]?.abstract).toBe(
      `${"x".repeat(LITERATURE_ABSTRACT_MAX_CHARS)}…`,
    );
  });

  it("cuts an over-long author list at LITERATURE_MAX_AUTHORS, ending in the scholarly et al.", () => {
    const bounded = boundLiteratureReport({
      sources: [],
      results: [
        {
          title: "one",
          authors: Array.from({ length: 30 }, (_, a) => `author ${a + 1}`),
          source: "arxiv",
        },
      ],
    });
    const authors = bounded.results[0]?.authors ?? [];
    expect(authors).toHaveLength(LITERATURE_MAX_AUTHORS + 1);
    expect(authors[LITERATURE_MAX_AUTHORS - 1]).toBe(
      `author ${LITERATURE_MAX_AUTHORS}`,
    );
    expect(authors[LITERATURE_MAX_AUTHORS]).toBe("et al.");
  });

  it("drops whole abstracts from the LAST result backwards when the cut is not enough", () => {
    const bounded = boundLiteratureReport(fatReport());
    // The head of the list keeps its (truncated) abstract; the tail loses it.
    expect(bounded.results[0]?.abstract).toMatch(/^x+…$/);
    expect(bounded.results.at(-1)?.abstract).toBe("…");
  });

  it("returns a report that already fits unchanged", () => {
    const small: LiteratureSearchReport = {
      sources: [
        {
          name: "arxiv",
          endpoint: "https://export.arxiv.org/api",
          status: "ok",
        },
      ],
      results: [
        {
          title: "one",
          authors: ["a", "b"],
          abstract: "short",
          doi: "10.5555/one",
          source: "arxiv",
        },
      ],
    };
    expect(JSON.stringify(boundLiteratureReport(small))).toBe(
      JSON.stringify(small),
    );
  });

  it("searchLiterature returns a bounded report, statuses first", async () => {
    const fat = crossrefLiterature({
      fetchImpl: () =>
        okJson({
          message: {
            items: Array.from({ length: 20 }, (_, i) => ({
              title: [`P${i}`],
              DOI: `10.5555/${i}`,
              author: [],
              abstract: "y".repeat(3000),
            })),
          },
        }),
    });
    const json = JSON.stringify(
      await searchLiterature(
        { query: "q", maxResults: 20 },
        { providers: [fat] },
      ),
    );
    expect(json.length).toBeLessThanOrEqual(LITERATURE_REPORT_MAX_CHARS);
    expect(json.indexOf('"sources"')).toBeLessThan(json.indexOf('"results"'));
  });
});

describe("anonymous sources (R4/D5)", () => {
  it("an unkeyed Semantic Scholar reports anonymous; a keyed one does not", async () => {
    const body = { data: [{ title: "One", authors: [] }] };
    for (const [label, provider] of [
      ["unkeyed", semanticScholarLiterature({ fetchImpl: () => okJson(body) })],
      [
        "keyed",
        semanticScholarLiterature({
          fetchImpl: () => okJson(body),
          apiKey: "s2key",
        }),
      ],
    ] as const) {
      const report = await searchLiterature(
        { query: "q", maxResults: 5 },
        { providers: [provider] },
      );
      expect(`${label}: ${report.sources[0]?.anonymous}`).toBe(
        `${label}: ${label === "unkeyed" ? "true" : "undefined"}`,
      );
    }
  });

  it("carries the flag even when the anonymous source did not answer", async () => {
    // The pointer is worth most exactly here: rate_limited is what an
    // anonymous S2 returns at agentic cadence (S5: 40 of 40 calls).
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [
          semanticScholarLiterature({ fetchImpl: () => rateLimited("60") }),
        ],
      },
    );
    expect(report.sources[0]).toMatchObject({
      name: "semantic_scholar",
      status: "rate_limited",
      anonymous: true,
    });
  });

  it("no other provider carries the field — a polite pool is not a key", async () => {
    const report = await searchLiterature(
      { query: "q", maxResults: 5 },
      {
        providers: [
          crossrefLiterature({
            fetchImpl: () => okJson({ message: { items: [] } }),
            mailto: "ops@example.org",
          }),
          dblpLiterature({ fetchImpl: () => okJson({}) }),
          arxivLiterature({ fetchImpl: () => okJson({}), minIntervalMs: 0 }),
        ],
      },
    );
    for (const source of report.sources) {
      expect(`${source.name}: ${source.anonymous}`).toBe(
        `${source.name}: undefined`,
      );
    }
  });
});

describe("mergeLiterature — the source table's own guarantees", () => {
  it("LITERATURE_SOURCE_ORDER covers every source name", () => {
    // The merge visits sources THROUGH this constant, so a name missing from
    // it is a name whose every result is silently discarded while `sources[]`
    // still reports that it answered — the exact dishonesty R4 exists to
    // remove, and it would compile. The union is closed, so enumerate it here
    // and let this fail the day a fifth source is added.
    const every: LiteratureSourceName[] = [
      "arxiv",
      "crossref",
      "dblp",
      "semantic_scholar",
    ];
    expect([...LITERATURE_SOURCE_ORDER].sort()).toEqual([...every].sort());
  });

  it("a source the canonical order does not name is placed last, never dropped", () => {
    // ADR 0019's own header advertises a future `web_search` provider through
    // this seam. Until its name reaches the constant it has no rank, but it
    // must still reach the reader: dropping it would make `sources[]` say a
    // source answered while the model saw nothing it returned.
    const merged = mergeLiterature({ query: "attention", maxResults: 4 }, [
      {
        name: "web" as LiteratureSourceName,
        outcome: okOutcome([
          {
            title: "web one",
            authors: [],
            source: "web" as LiteratureSourceName,
          },
          {
            title: "web two",
            authors: [],
            source: "web" as LiteratureSourceName,
          },
        ]),
      },
      { name: "arxiv", outcome: okOutcome(scripted("arxiv", 2)) },
    ]);
    expect(merged.map((r) => r.title)).toEqual([
      "arxiv 1",
      "web one",
      "arxiv 2",
      "web two",
    ]);
  });

  it("two providers sharing a name both contribute", () => {
    // A host may build a keyed and an unkeyed instance of the same source, or
    // two arXiv mirrors. The pre-R4 loop iterated the settled array and so
    // counted both; visiting by name must not quietly keep only the first.
    const merged = mergeLiterature({ query: "attention", maxResults: 4 }, [
      {
        name: "arxiv",
        outcome: okOutcome(scripted("arxiv", 1, { titles: ["first arxiv"] })),
      },
      {
        name: "arxiv",
        outcome: okOutcome(scripted("arxiv", 1, { titles: ["second arxiv"] })),
      },
    ]);
    expect(merged.map((r) => r.title)).toEqual(["first arxiv", "second arxiv"]);
  });

  it("dedup is non-transitive, and that is recorded rather than fixed", () => {
    // ADR 0067 recorded limit 4. A candidate is matched by DOI when it has
    // one and only otherwise by title, so a chain A—(title)—B—(DOI)—C does not
    // collapse whole: the DOI-linked pair merges and the title-only record
    // stands apart. Pinned so the behaviour is a decision on the record rather
    // than a surprise; union-find would be disproportionate here.
    const merged = mergeLiterature({ query: "attention", maxResults: 8 }, [
      {
        name: "arxiv",
        outcome: okOutcome([
          { title: "Paper One", authors: [], source: "arxiv" },
        ]),
      },
      {
        name: "crossref",
        outcome: okOutcome([
          {
            title: "Paper One: A Revised Version",
            authors: [],
            doi: "10.5555/d1",
            source: "crossref",
          },
        ]),
      },
      {
        name: "dblp",
        outcome: okOutcome([
          {
            title: "Paper One",
            authors: [],
            doi: "10.5555/d1",
            source: "dblp",
          },
        ]),
      },
    ]);
    // DBLP folds into Crossref by DOI; the arXiv record never learns the DOI.
    expect(merged.map((r) => r.title)).toEqual([
      "Paper One",
      "Paper One: A Revised Version",
    ]);
  });

  it("orders SEVERAL unnamed sources independently of the outcomes array", () => {
    // The unranked tail must be ordered by something INTRINSIC, not by the
    // order the caller happened to build its array in — that is the whole of
    // D1, and the permutation test above cannot catch it because every S5
    // shape uses names the canonical order already carries.
    const web = (title: string): LiteratureResult => ({
      title,
      authors: [],
      source: "web" as LiteratureSourceName,
    });
    const shape: ScriptedOutcome[] = [
      { name: "zeta" as LiteratureSourceName, outcome: okOutcome([web("z1")]) },
      {
        name: "alpha" as LiteratureSourceName,
        outcome: okOutcome([web("a1")]),
      },
      { name: "arxiv", outcome: okOutcome(scripted("arxiv", 1)) },
    ];
    const expected = ["arxiv 1", "a1", "z1"];
    for (const permuted of permutations(shape)) {
      expect(
        mergeLiterature({ query: "attention", maxResults: 8 }, permuted).map(
          (r) => r.title,
        ),
      ).toEqual(expected);
    }
  });
});

describe("boundLiteratureReport — the cut respects what it is cutting", () => {
  it("never splits a surrogate pair when it truncates an abstract", () => {
    // Slicing at a UTF-16 code-unit boundary can leave a lone high surrogate,
    // which the model reads as one garbage character. The wire stays valid
    // JSON either way, which is why nothing else would have caught it.
    const bounded = boundLiteratureReport({
      sources: [],
      results: [
        {
          title: "one",
          authors: [],
          // The pair straddles index 1000 exactly.
          abstract: `${"x".repeat(999)}${"🙂".repeat(20)}`,
          source: "arxiv",
        },
      ],
    });
    const cut = bounded.results[0]?.abstract ?? "";
    expect(cut.endsWith("…")).toBe(true);
    for (const unit of [...cut].map((c) => c.codePointAt(0) ?? 0)) {
      expect(unit >= 0xd800 && unit <= 0xdfff).toBe(false);
    }
  });
});

/**
 * V2 (ADR 0078 §3, O6): the merge's own title key, made public, plus the
 * comparison the ledger validates a cited paper with.
 *
 * **One key, not two.** A second normalisation would let the interpreter accept
 * a title the merge would have deduplicated, or refuse one it would have
 * matched — and the two would drift apart the first time either was tuned.
 */
describe("sameTitle (V2, ADR 0078 §3)", () => {
  it("exports the merge's own key", () => {
    // Lowercased, everything outside a-z0-9 stripped — the merge's rule,
    // reachable now rather than copied.
    expect(titleKey("Adam: A Method for Stochastic Optimization")).toBe(
      "adamamethodforstochasticoptimization",
    );
    expect(titleKey("ADAM — a method, for stochastic optimization!")).toBe(
      "adamamethodforstochasticoptimization",
    );
    // "An empty key is not a key": a wholly non-Latin title normalises away.
    expect(titleKey("基于注意力的神经机器翻译")).toBe("");
  });

  it("matches two non-empty keys whatever their case or punctuation", () => {
    expect(
      sameTitle(
        "Adam: A Method for Stochastic Optimization",
        "adam - a method for stochastic optimization",
      ),
    ).toBe(true);
    expect(sameTitle("Attention Is All You Need", "Attention is all you")).toBe(
      false,
    );
  });

  it("matches two wholly non-Latin titles only when they are really the same", () => {
    // Both keys are "", so R4's rule alone would refuse to answer — and a CJK
    // title must at least match itself, or a Chinese-language paper could
    // never be cited as evidence at all (invariant 6 rule 1).
    expect(
      sameTitle("基于注意力的神经机器翻译", " 基于注意力的神经机器翻译 "),
    ).toBe(true);
    expect(sameTitle("基于注意力的神经机器翻译", "深度残差学习")).toBe(false);
    // Whitespace is collapsed, case is folded; nothing else is.
    expect(sameTitle("Ｄｅｅｐ　学习", "Ｄｅｅｐ 学习")).toBe(true);
  });

  it("refuses when exactly one key is empty", () => {
    // One side normalises to a key and the other does not: they are not the
    // same paper, and guessing across that boundary is what R4 declined to do.
    expect(sameTitle("基于注意力的神经机器翻译", "Attention")).toBe(false);
    expect(sameTitle("Attention", "基于注意力的神经机器翻译")).toBe(false);
  });

  it("is reflexive on an empty string, and never matches empty to a real title", () => {
    expect(sameTitle("", "")).toBe(true);
    expect(sameTitle("", "Attention Is All You Need")).toBe(false);
  });
});

/**
 * V2 (ADR 0078 §5, O11): a review's searches never return the manuscript.
 *
 * Removal happens over each source's own `ok` results, BEFORE the merge. After
 * the merge would be simpler and would keep ADR 0067 §1's every-source
 * property intact — and it would also let the identity tier promote the
 * manuscript to rank one and then delete it, wasting the slot a real candidate
 * should have had. That trade is the supersession ADR 0078 §5 records.
 */
describe("searchLiterature withholds the manuscript itself (V2, O11)", () => {
  const source = (
    name: LiteratureSourceName,
    titles: string[],
  ): LiteratureProvider => ({
    name,
    endpoint: `https://${name}.test`,
    search: async () => ({
      kind: "ok" as const,
      results: titles.map((title) => ({ title, authors: [], source: name })),
    }),
  });

  it("removes it before the identity tier, so the slot is not wasted", async () => {
    // The query IS the manuscript's title, so without the guard the identity
    // tier would place it first and the real candidate would be pushed down.
    const report = await searchLiterature(
      { query: "A Two-Stage Least Squares Study", maxResults: 1 },
      {
        providers: [
          source("arxiv", [
            "A Two-Stage Least Squares Study",
            "A Real Candidate",
          ]),
        ],
        excludeTitles: ["A Two-Stage Least Squares Study"],
        pacer: createLiteraturePacer(),
      },
    );
    expect(report.results.map((r) => r.title)).toEqual(["A Real Candidate"]);
    expect(report.withheld).toEqual({ ownTitle: 1 });
  });

  it("matches by the merge's own key, not by exact string", async () => {
    const report = await searchLiterature(
      { query: "anything", maxResults: 10 },
      {
        providers: [source("arxiv", ["A  TWO-STAGE, least squares study!"])],
        excludeTitles: ["A Two-Stage Least Squares Study"],
        pacer: createLiteraturePacer(),
      },
    );
    expect(report.results).toEqual([]);
    expect(report.withheld).toEqual({ ownTitle: 1 });
  });

  it("counts across sources, and omits the key when nothing was withheld", async () => {
    const both = await searchLiterature(
      { query: "q", maxResults: 10 },
      {
        providers: [
          source("arxiv", ["The Paper", "Other A"]),
          source("crossref", ["The Paper", "Other B"]),
        ],
        excludeTitles: ["The Paper"],
        pacer: createLiteraturePacer(),
      },
    );
    expect(both.withheld).toEqual({ ownTitle: 2 });
    expect(both.results.map((r) => r.title).sort()).toEqual([
      "Other A",
      "Other B",
    ]);

    // No withholding, no key — so a report from any call that is not a review
    // serializes byte-identically to what R4 produced.
    const clean = await searchLiterature(
      { query: "q", maxResults: 10 },
      {
        providers: [source("arxiv", ["Other A"])],
        excludeTitles: ["Nothing Matches This"],
        pacer: createLiteraturePacer(),
      },
    );
    expect(clean).not.toHaveProperty("withheld");
    expect(Object.keys(clean)).toEqual(["sources", "results"]);
  });

  it("changes nothing at all when no titles are excluded", async () => {
    const withEmpty = await searchLiterature(
      { query: "q", maxResults: 10 },
      {
        providers: [source("arxiv", ["A", "B"])],
        excludeTitles: [],
        pacer: createLiteraturePacer(),
      },
    );
    const without = await searchLiterature(
      { query: "q", maxResults: 10 },
      {
        providers: [source("arxiv", ["A", "B"])],
        pacer: createLiteraturePacer(),
      },
    );
    expect(withEmpty).toEqual(without);
  });

  it("survives the bound, which rebuilds the report rather than spreading it", () => {
    const bounded = boundLiteratureReport({
      sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
      withheld: { ownTitle: 3 },
      results: [],
    });
    expect(bounded.withheld).toEqual({ ownTitle: 3 });
    // And it sits between the statuses and the results, so a report that ever
    // did get sliced keeps it in the head (R4/D4's ordering rule).
    expect(Object.keys(bounded)).toEqual(["sources", "withheld", "results"]);
  });
});
