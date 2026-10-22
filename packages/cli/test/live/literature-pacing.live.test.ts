/**
 * R8, the **live** row L1 of the milestone's tier table (ADR 0068).
 *
 * ## The question
 *
 * R8 says Lemmaria never bursts a scholarly host and asks one again only when
 * the host's own signal invited it. What it deliberately does NOT promise is
 * that an unkeyed Semantic Scholar therefore answers: that limit is a pool
 * shared with every other unauthenticated caller on the internet, and our own
 * cadence is the only part of it we control. So the honest thing to measure is
 * *what pacing plus backoff changes at agentic cadence*, on the real four
 * hosts — and to report it rather than to assert it.
 *
 * The shape is the one R4's step-8 session probed by hand on 2026-09-06, when
 * one cold call to Semantic Scholar came back `ok`, three sequential calls came
 * back `rate_limited, rate_limited, ok`, and six concurrent calls came back
 * `rate_limited` on all six. Six concurrent calls is therefore the cadence this
 * row reproduces.
 *
 * ## What is asserted, and what is only tallied
 *
 * Assertions are outcome-set properties that hold whatever the internet did
 * today: nothing throws, every status is one of the four honest values,
 * `attempts` is absent on a first-try answer and never exceeds
 * `maxRetries + 1`, and the paced run's Semantic Scholar answer rate is **not
 * lower** than the unpaced run's. Everything else — the two per-source tallies
 * and the wall clock — is reported either way, and those two tallies are R8's
 * own evidence.
 *
 * A paced run's answer rate coming out LOWER than the unpaced one's is a
 * finding about the pool, not a reason to loosen the assertion (the plan's own
 * *Watch for*).
 *
 * ## Run order, stated because it is a confound
 *
 * The paced run goes first, then a settle, then the unpaced control — so the
 * shipped configuration is the one measured against a cold pool. The control
 * run does briefly burst the four hosts, which is the whole point of a
 * control; it happens once per gate, never in shipped code, and it is the only
 * place in the repo that asks a host faster than it published.
 *
 * ## Why it is guarded on a model key it never uses
 *
 * Presence-only, and the test needs no key: an unkeyed checkout stays silent
 * rather than reaching the network during what its owner believes is an
 * offline run (ADR 0035 §5). Same guard as R4's L1.
 */

import {
  LITERATURE_RETRY_POLICY,
  type LiteratureProvider,
  type LiteratureSearchReport,
  type LiteratureSourceName,
  arxivLiterature,
  createLiteraturePacer,
  crossrefLiterature,
  dblpLiterature,
  searchLiterature,
  semanticScholarLiterature,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { report } from "./observe.js";
import { liveAnthropicReady, liveOpenAIReady } from "./pins.js";

/** S5's broad-problem query (§4, row 1) — the same one R4's L1 probes. */
const BROAD = "efficient attention for long-context transformers";
const MAX_RESULTS = 8;
/** R4's step-8 probe shape: the cadence that produced 6 of 6 `rate_limited`. */
const CONCURRENT = 6;
const STATUSES = ["ok", "rate_limited", "timeout", "failed"];
const SOURCES: LiteratureSourceName[] = [
  "arxiv",
  "crossref",
  "dblp",
  "semantic_scholar",
];

function allProviders(): LiteratureProvider[] {
  return [
    crossrefLiterature(),
    dblpLiterature(),
    // No key, deliberately: the anonymous pool is the case R8 cannot fix and
    // is honest about not fixing.
    semanticScholarLiterature(),
    arxivLiterature(),
  ];
}

/** `semantic_scholar: ok=1 rate_limited=5 (attempts 2×3)` — per source. */
function tally(reports: LiteratureSearchReport[]): string {
  return SOURCES.map((name) => {
    const mine = reports.flatMap((r) =>
      r.sources.filter((s) => s.name === name),
    );
    const byStatus = new Map<string, number>();
    const attempts: number[] = [];
    for (const s of mine) {
      byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
      if (s.attempts !== undefined) attempts.push(s.attempts);
    }
    const statuses = [...byStatus.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return `${name}: ${statuses}${
      attempts.length > 0
        ? ` (retried ${attempts.length}×, attempts ${attempts.join("/")})`
        : ""
    }`;
  }).join(" | ");
}

function answered(
  reports: LiteratureSearchReport[],
  name: LiteratureSourceName,
): number {
  return reports.filter(
    (r) => r.sources.find((s) => s.name === name)?.status === "ok",
  ).length;
}

const live = liveOpenAIReady() || liveAnthropicReady();

describe.skipIf(!live)(
  "R8 live — pacing and backoff against the real four hosts, no model",
  () => {
    it("never bursts a host, and reports what that changed", async () => {
      // --- the shipped configuration, against a cold pool -----------------
      const pacedPacer = createLiteraturePacer();
      const pacedStarted = Date.now();
      const paced = await Promise.all(
        Array.from({ length: CONCURRENT }, () =>
          searchLiterature(
            { query: BROAD, maxResults: MAX_RESULTS },
            { providers: allProviders(), pacer: pacedPacer },
          ),
        ),
      );
      const pacedMs = Date.now() - pacedStarted;

      // Let the hosts settle before the control run, so the burst below is
      // measured against a pool this test has stopped touching.
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // --- the control: no wait anywhere, one attempt each ----------------
      const unpacedStarted = Date.now();
      const unpaced = await Promise.all(
        Array.from({ length: CONCURRENT }, () =>
          searchLiterature(
            { query: BROAD, maxResults: MAX_RESULTS },
            {
              providers: allProviders(),
              pacer: createLiteraturePacer({ sleep: async () => true }),
              retry: { ...LITERATURE_RETRY_POLICY, maxRetries: 0 },
              sleep: async () => true,
            },
          ),
        ),
      );
      const unpacedMs = Date.now() - unpacedStarted;

      report("R8 live/paced", {
        calls: CONCURRENT,
        tally: tally(paced),
        merged: paced.map((r) => r.results.length).join(","),
        ms: pacedMs,
      });
      report("R8 live/unpaced (control)", {
        calls: CONCURRENT,
        tally: tally(unpaced),
        merged: unpaced.map((r) => r.results.length).join(","),
        ms: unpacedMs,
      });

      for (const [label, reports] of [
        ["paced", paced],
        ["unpaced", unpaced],
      ] as const) {
        for (const r of reports) {
          expect(r.sources.map((s) => s.name).sort()).toEqual(SOURCES);
          for (const s of r.sources) {
            expect(`${label}/${s.name}: ${STATUSES.includes(s.status)}`).toBe(
              `${label}/${s.name}: true`,
            );
            // `attempts` is by exception: a host asked once says nothing.
            if (s.attempts !== undefined) {
              expect(`${label}/${s.name} attempts=${s.attempts}`).toBe(
                `${label}/${s.name} attempts=${Math.min(
                  Math.max(s.attempts, 2),
                  LITERATURE_RETRY_POLICY.maxRetries + 1,
                )}`,
              );
            }
          }
        }
      }

      // The control asked once per host, so nothing in it may claim a retry.
      for (const r of unpaced) {
        for (const s of r.sources) expect(s.attempts).toBeUndefined();
      }

      // The claim R8 does make about the shared pool: being polite never
      // costs answers. A LOWER paced rate is a finding, not a flake.
      const pacedS2 = answered(paced, "semantic_scholar");
      const unpacedS2 = answered(unpaced, "semantic_scholar");
      report("R8 live/semantic_scholar answer rate", {
        paced: `${pacedS2} of ${CONCURRENT}`,
        unpaced: `${unpacedS2} of ${CONCURRENT}`,
      });
      expect(pacedS2).toBeGreaterThanOrEqual(unpacedS2);
    });
  },
);
