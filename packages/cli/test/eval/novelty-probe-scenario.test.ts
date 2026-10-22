/**
 * V2 (O25's third clause): the novelty probe reaches the report through the
 * **real** driver.
 *
 * `novelty.test.ts` asserts the arithmetic over a hand-built record. This
 * asserts the record can actually be produced: a seat searches, cites what its
 * own search returned as `paper` evidence, and that evidence survives
 * validation, location, persistence and replay into `ReviewItem.result`.
 *
 * Asserted offline, with injected providers — the seam T9 built for exactly
 * this. A test that needed a real scholarly index to prove a wiring claim
 * would be a test nobody re-runs, and its subject would be the index's uptime
 * rather than the driver.
 */
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GenerateRequest,
  GenerateResult,
  LiteratureProvider,
  ModelAdapter,
  ModelStreamEvent,
  ReviewItem,
  Skill,
} from "@lemmaria/harness";
import { PANEL_SKILL } from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import { measureNovelty, readProbe } from "../../src/eval/novelty.js";
import { runEvalTask } from "../../src/eval/run-eval.js";
import {
  FLAGSHIP_SCENARIOS,
  PROBE_SCENARIOS,
  scenarioById,
} from "../../src/eval/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/novelty-probe");
const PAPER = resolve(FIXTURE, "paper");

const KNOWN = "Adam: A Method for Stochastic Optimization";

const PROTOCOL: Skill = {
  name: PANEL_SKILL,
  description: "the panel protocol",
  body: "quote one whole line",
  source: "bundled",
  path: `/skills/${PANEL_SKILL}/SKILL.md`,
  references: [],
};

/** A provider that returns the known work, and records what it was asked. */
function knownWorkProvider(asked: string[]): LiteratureProvider {
  return {
    name: "arxiv",
    endpoint: "injected://no-network",
    search: async (q) => {
      asked.push(q.query);
      return {
        kind: "ok",
        results: [
          {
            title: KNOWN,
            authors: ["Kingma, Diederik P.", "Ba, Jimmy"],
            year: "2015",
            venue: "ICLR",
            url: "https://arxiv.org/abs/1412.6980",
            source: "arxiv",
          },
        ],
      };
    },
  };
}

/**
 * A seat that searches first and cites second.
 *
 * The two turns are told apart by whether the conversation already carries a
 * `tool` message — not by a counter, because three seats draw from one adapter
 * concurrently and a counter would make the answer depend on which seat asked
 * first.
 */
class SearchingPanel implements ModelAdapter {
  readonly protocol = "anthropic" as const;

  private answer(request: GenerateRequest): GenerateResult {
    const usage = { inputTokens: 1, outputTokens: 1 };
    // Whether THIS seat's search has already come back, read from the one
    // string only a search result can contain.
    //
    // Not `some(m => m.role === "tool")`, which was the first thing tried and
    // is wrong: the panel driver hands a seat its manuscript as a synthetic
    // tool message, so the very FIRST request already carries one and the seat
    // answered before it had searched anything. The known title cannot reach
    // the conversation any other way — O27 asserts it appears nowhere in the
    // fixture — so its presence is exactly the signal wanted.
    const searched = request.messages.some(
      (m) => typeof m.content === "string" && m.content.includes(KNOWN),
    );
    if (!searched) {
      return {
        text: "",
        toolCalls: [
          {
            id: `s-${request.messages.length}`,
            name: "literature_search" as const,
            args: { query: "bias-corrected first and second moment optimiser" },
          },
        ],
        stopReason: "tool_use",
        usage,
      };
    }
    return {
      text: JSON.stringify({
        impressions: {},
        annotations: [
          {
            dimension: "originality",
            severity: "major",
            anchor:
              "Our contributions are as follows. We introduce the combination of",
            // The third evidence kind, on the wire exactly as a model writes
            // it: a bare `paper` object, never a tagged union (ADR 0078 §2).
            evidence: { paper: { title: KNOWN } },
            message:
              "this combination is the contribution of an existing published method",
          },
        ],
      }),
      toolCalls: [],
      stopReason: "stop",
      usage,
    };
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.answer(request));
  }

  async *generateStream(
    request: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.answer(request) };
  }
}

/** Cites the known work without ever searching for it. */
class CitingWithoutSearching implements ModelAdapter {
  readonly protocol = "anthropic" as const;

  private answer(): GenerateResult {
    return {
      text: JSON.stringify({
        impressions: {},
        annotations: [
          {
            dimension: "originality",
            severity: "major",
            anchor:
              "Our contributions are as follows. We introduce the combination of",
            evidence: { paper: { title: KNOWN } },
            message: "this combination is not new",
          },
        ],
      }),
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(): Promise<GenerateResult> {
    return Promise.resolve(this.answer());
  }

  async *generateStream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed", result: this.answer() };
  }
}

const trash: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const d of trash.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("V2 O25 — the novelty-probe scenario", () => {
  it("resolves by id, and is NOT swept into `--scenario all`", () => {
    const scenario = scenarioById("novelty-probe");
    expect(scenario?.id).toBe("novelty-probe");
    expect(scenario?.tools).toContain("literature_search");
    expect(scenario?.readOnly).toBe(true);
    // A probe spends a whole panel, so it is opt-in for `EVIDENCE_SCENARIOS`'
    // reason: `--scenario all` must not get quietly more expensive.
    expect(FLAGSHIP_SCENARIOS.map((s) => s.id)).not.toContain("novelty-probe");
    // V3 (ADR 0080): a second probe, `pdf-marker`. Kept exhaustive rather
    // than relaxed to `toContain` — what the list holds is the claim, and the
    // property the test is really about (neither is in `all`) is asserted
    // above, against `FLAGSHIP_SCENARIOS`.
    expect(PROBE_SCENARIOS.map((s) => s.id)).toEqual([
      "novelty-probe",
      "pdf-marker",
    ]);
  });

  it("carries a scripted reviewer's `paper` evidence into the report", async () => {
    const asked: string[] = [];
    const scenario = scenarioById("novelty-probe");
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;

    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      adapter: new SearchingPanel(),
      literatureProviders: [knownWorkProvider(asked)],
    });
    trash.push(task.workDir);

    // The seats really did search — without this the assertions below could
    // pass on a paper that was never retrieved, which is the one thing V2's
    // validation exists to prevent.
    expect(asked.length).toBeGreaterThan(0);

    const item = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(item?.status).toBe("completed");
    const annotations = item?.result?.annotations ?? [];
    expect(annotations.length).toBeGreaterThan(0);

    const paper = annotations.find((a) => a.evidence?.kind === "paper");
    expect(paper, "no paper evidence survived into the report").toBeDefined();
    if (paper?.evidence?.kind !== "paper") return;
    expect(paper.evidence.title).toBe(KNOWN);
    expect(paper.dimension).toBe("originality");
    // The claim anchor is still located in the manuscript's own bytes: a paper
    // evidence widens what may corroborate a concern, never where it points.
    expect(paper.span.line).toBe(47);

    // And the fixture's own probe reads it as a hit.
    const probe = await readProbe(resolve(FIXTURE, "probe.json"));
    const report = measureNovelty(item as ReviewItem, probe);
    expect(report.measured).toBe(true);
    expect(report.citingKnown).toBeGreaterThan(0);
    expect(report.reviewers.some((r) => r.citedKnown)).toBe(true);
    expect(report.reviewers.find((r) => r.citedKnown)?.citedUnder).toEqual([
      "originality",
    ]);
  });

  it("has a stub arm with enough turns for the panel AND its re-asks", async () => {
    // `--stub --scenario novelty-probe`, which is the only caller of the
    // `stubTurnsFor` arm. A script one turn short throws `ScriptExhaustedError`
    // mid-panel, and nothing else in the suite would notice: the arm has no
    // other reader.
    const scenario = scenarioById("novelty-probe");
    if (scenario === undefined) throw new Error("no novelty-probe scenario");
    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: true,
      readOnly: true,
      skills: [PROTOCOL],
    });
    trash.push(task.workDir);

    expect(task.outcome.status).toBe("completed");
    const item = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(item?.status).toBe("completed");
    // Every seat reached an answer rather than dying on an exhausted script.
    expect(item?.seats.length).toBeGreaterThan(0);
    for (const s of item?.seats ?? []) {
      expect(s.status, `${s.reviewer} did not complete`).toBe("completed");
    }
  });

  it("drops a paper no search returned, and says `not_in_results`", async () => {
    // The rule V2 exists for, through the same real driver. This was first
    // observed by accident — a seat whose search never fired cited the paper
    // anyway and the record came back `entries: 1, located: 0, dropped: 1` —
    // which is exactly the behaviour worth pinning deliberately.
    const asked: string[] = [];
    const scenario = scenarioById("novelty-probe");
    if (scenario === undefined) throw new Error("no novelty-probe scenario");

    const task = await runEvalTask({
      scenario,
      paperDir: PAPER,
      grants: new Map(),
      stub: false,
      readOnly: true,
      skills: [PROTOCOL],
      // Never searches: it answers the ledger on the first turn.
      adapter: new CitingWithoutSearching(),
      literatureProviders: [knownWorkProvider(asked)],
    });
    trash.push(task.workDir);

    expect(asked).toEqual([]);
    const item = task.outcome.items.find(
      (i): i is ReviewItem => i.type === "review",
    );
    expect(item?.result?.annotations ?? []).toEqual([]);

    const dropped = (item?.result?.limits ?? []).filter(
      (l) => l.kind === "anchors_dropped",
    );
    expect(dropped.length).toBeGreaterThan(0);
    const reasons = dropped.flatMap((l) =>
      l.kind === "anchors_dropped" ? l.anchors.map((a) => a.reason) : [],
    );
    expect(reasons).toContain("not_in_results");

    // And the instrument reads the drop rather than silently reporting zero.
    const probe = await readProbe(resolve(FIXTURE, "probe.json"));
    const report = measureNovelty(item as ReviewItem, probe);
    expect(report.citingKnown).toBe(0);
    expect(report.reviewers.some((r) => r.notInResults > 0)).toBe(true);
  });
});
