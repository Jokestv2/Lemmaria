/**
 * R4, the **live** row L1 of the milestone's tier table (ADR 0067).
 *
 * ## The question
 *
 * S5 measured the merge against the real four providers and found it decided
 * by Crossref's mood rather than by relevance: in 8 of 10 merged calls the
 * whole result set was Crossref, and the exact-title probe's target — arXiv's
 * #1 in both runs — was **absent from the merged set** in one of them. R4
 * replaces that concatenation with an identity tier and a rank interleave, and
 * this row is the only place the replacement meets the real endpoints.
 *
 * Nothing here needs a model. What it needs is the four scholarly hosts, their
 * real rankings, their real rate limits and their real title spellings — none
 * of which a scripted outcome can stand in for, because the whole question is
 * whether `titleKey`'s normalisation survives what a real index calls a paper.
 *
 * ## Why it is guarded on a model key it never uses
 *
 * The guard is presence-only and the test needs no key. It exists so that an
 * unkeyed checkout stays silent, which is the fallback
 * [ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md)
 * §5 expects: the live tier is evidence, not a gate, and a checkout with no
 * live credentials should report nothing rather than reach out over the network
 * during what its owner believes is an offline run.
 *
 * ## What is asserted, and what is only tallied
 *
 * A live index is not a fixture: which papers Crossref ranks first this week is
 * not R4's business, and asserting it would be a test of the internet. So the
 * assertions are **outcome-set** assertions about the merge's own guarantees —
 * every source's status is one of the four honest values; every source that
 * answered `ok` with at least one result of its own is represented in the merged
 * set; and, conditionally, **if any source's own list contains the exact-title
 * target, the merged list opens with it**. That conditional is the whole of
 * S5's finding, inverted into a guarantee.
 *
 * Everything else — the per-source counts, the abstract coverage, the merged
 * composition, the wall time — is reported either way, because a green live run
 * that prints nothing answers *"did it break?"* and not *"what came back?"*.
 */

import {
  ARXIV_MIN_INTERVAL_MS,
  LITERATURE_REPORT_MAX_CHARS,
  type LiteratureProvider,
  type LiteratureResult,
  type LiteratureSearchReport,
  type LiteratureSourceName,
  arxivLiterature,
  crossrefLiterature,
  dblpLiterature,
  searchLiterature,
  semanticScholarLiterature,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { report } from "./observe.js";
import { liveAnthropicReady, liveOpenAIReady } from "./pins.js";

/** S5's exact-title probe (§4, row 5): arXiv's #1 in both runs. */
const EXACT_TITLE = "Longformer: The Long-Document Transformer";
/** S5's broad-problem query (§4, row 1). */
const BROAD = "efficient attention for long-context transformers";

const MAX_RESULTS = 8;

/** The same normalisation the merge compares titles by. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * ONE arXiv provider instance, shared by every call in the file.
 *
 * The courtesy pacer is a module-level promise chain, so instances already
 * queue behind each other — but sharing one is what S5 did, and a file that
 * built a fresh instance per call would be asserting that fact rather than
 * relying on it.
 */
const arxiv = arxivLiterature();

function allProviders(): LiteratureProvider[] {
  return [
    crossrefLiterature(),
    dblpLiterature(),
    // No key, deliberately: this is the configuration a user has before they
    // run `Lemmaria: Set Semantic Scholar API Key`, and the `anonymous` flag
    // it produces is one of the things this row exists to confirm.
    semanticScholarLiterature(),
    arxiv,
  ];
}

const STATUSES = ["ok", "rate_limited", "timeout", "failed"];

/** `crossref:ok(8,4a,3d)` — status, count, abstracts, DOIs. */
function composition(report: LiteratureSearchReport): string {
  const counts = new Map<LiteratureSourceName, LiteratureResult[]>();
  for (const r of report.results) {
    counts.set(r.source, [...(counts.get(r.source) ?? []), r]);
  }
  return report.sources
    .map((s) => {
      const mine = counts.get(s.name) ?? [];
      const a = mine.filter((r) => r.abstract !== undefined).length;
      const d = mine.filter((r) => r.doi !== undefined).length;
      return `${s.name}:${s.status}${s.anonymous === true ? "(anon)" : ""}=${mine.length}${
        mine.length > 0 ? `/${a}a/${d}d` : ""
      }`;
    })
    .join(" ");
}

/** Every source that answered `ok` with at least one result of its own. */
function answeringSources(
  alone: Map<LiteratureSourceName, LiteratureSearchReport>,
): LiteratureSourceName[] {
  return [...alone.entries()]
    .filter(
      ([name, r]) =>
        r.sources.find((s) => s.name === name)?.status === "ok" &&
        r.results.length > 0,
    )
    .map(([name]) => name);
}

// Presence-only, and never the value. See the header for why a row that uses
// no model is nonetheless gated on a live credential being configured at all.
const live = liveOpenAIReady() || liveAnthropicReady();

describe.skipIf(!live)(
  "R4 live — the merge against the real four providers, no model",
  () => {
    /** Merged, then each provider alone — S5's method, so the merged set can
     *  be read against what each index actually offered. */
    async function probe(query: string): Promise<{
      merged: LiteratureSearchReport;
      alone: Map<LiteratureSourceName, LiteratureSearchReport>;
      ms: number;
    }> {
      const started = Date.now();
      const merged = await searchLiterature(
        { query, maxResults: MAX_RESULTS },
        { providers: allProviders() },
      );
      const alone = new Map<LiteratureSourceName, LiteratureSearchReport>();
      for (const provider of allProviders()) {
        alone.set(
          provider.name,
          await searchLiterature(
            { query, maxResults: MAX_RESULTS },
            { providers: [provider] },
          ),
        );
      }
      return { merged, alone, ms: Date.now() - started };
    }

    /** The broad-problem probe, run ONCE and shared: the five-call fan-out
     *  costs ~15 s of arXiv pacing, and a second identical run measures
     *  nothing the first did not. */
    let broad: Awaited<ReturnType<typeof probe>> | undefined;
    const broadProbe = async (): Promise<Awaited<ReturnType<typeof probe>>> => {
      broad ??= await probe(BROAD);
      return broad;
    };

    it("reports an honest status per source, and Semantic Scholar as anonymous", async () => {
      const { merged, ms } = await broadProbe();
      report("R4 live/broad-problem", {
        query: BROAD,
        composition: composition(merged),
        merged: merged.results.length,
        top3: merged.results.slice(0, 3).map((r) => `${r.source}: ${r.title}`),
        ms,
      });

      expect(merged.sources.map((s) => s.name).sort()).toEqual([
        "arxiv",
        "crossref",
        "dblp",
        "semantic_scholar",
      ]);
      for (const source of merged.sources) {
        expect(`${source.name}: ${STATUSES.includes(source.status)}`).toBe(
          `${source.name}: true`,
        );
      }
      // The one fact S5 found nothing told the user (finding 3).
      expect(
        merged.sources.find((s) => s.name === "semantic_scholar")?.anonymous,
      ).toBe(true);
      // No other host takes a key, so none may claim to have run without one.
      for (const name of ["crossref", "dblp", "arxiv"] as const) {
        expect(
          `${name}: ${merged.sources.find((s) => s.name === name)?.anonymous}`,
        ).toBe(`${name}: undefined`);
      }
      // The bound holds against real payloads, not just modelled ones.
      expect(JSON.stringify(merged).length).toBeLessThanOrEqual(
        LITERATURE_REPORT_MAX_CHARS,
      );
    });

    it("represents every source that answered, whichever ones did", async () => {
      const { merged, alone, ms } = await broadProbe();
      const answered = answeringSources(alone).sort();
      const represented = [...new Set(merged.results.map((r) => r.source))]
        .slice()
        .sort();
      report("R4 live/representation", {
        answeredAlone: answered,
        representedInMerge: represented,
        composition: composition(merged),
        ms,
      });

      // S5's finding 1, inverted: no source that had something to offer is
      // silently dropped because another one was listed first. A source whose
      // every hit is a cross-source duplicate contributes its fields through
      // the fill rather than an entry of its own, so representation is asserted
      // as a subset relation rather than as equality.
      const missing = answered.filter((n) => !represented.includes(n));
      const explained = missing.every((name) =>
        (alone.get(name)?.results ?? []).every((r) =>
          merged.results.some(
            (m) =>
              titleKey(m.title) === titleKey(r.title) ||
              (m.doi !== undefined &&
                r.doi !== undefined &&
                m.doi.toLowerCase() === r.doi.toLowerCase()),
          ),
        ),
      );
      expect(
        `unrepresented=${missing.join(",") || "none"} allExplainedAsDuplicates=${explained}`,
      ).toBe(
        `unrepresented=${missing.join(",") || "none"} allExplainedAsDuplicates=true`,
      );
    });

    it("answers the exact title first, when any source has it", async () => {
      const { merged, alone, ms } = await probe(EXACT_TITLE);
      const wanted = titleKey(EXACT_TITLE);
      const holders = [...alone.entries()]
        .filter(([, r]) => r.results.some((x) => titleKey(x.title) === wanted))
        .map(([name]) => name);
      report("R4 live/exact-title", {
        query: EXACT_TITLE,
        sourcesHoldingTheTarget: holders.length > 0 ? holders : "none",
        first: merged.results[0]
          ? `${merged.results[0].source}: ${merged.results[0].title}`
          : "none",
        composition: composition(merged),
        ms,
      });

      // Conditional by design: if not one of the four indexes returned the
      // paper today, there is nothing for identity-first to place, and that is
      // a fact about the internet rather than a defect in the merge. When one
      // DID return it, the merged list must open with it — which is exactly
      // what S5's run 1 failed to do.
      if (holders.length === 0) {
        report("R4 live/exact-title", {
          note: "no source returned the target; the identity tier had nothing to place",
        });
        return;
      }
      expect(
        `first=${merged.results[0] === undefined ? "none" : titleKey(merged.results[0].title) === wanted}`,
      ).toBe("first=true");
    });

    it("paces arXiv at its courtesy interval across the whole file", () => {
      // Not a network assertion — a guard on the constant the timings above
      // depend on. Five sequential merged/alone calls cost at least this much
      // pacing, which is what keeps the file inside the tier's 300 s timeout.
      expect(ARXIV_MIN_INTERVAL_MS).toBe(3000);
    });
  },
);
