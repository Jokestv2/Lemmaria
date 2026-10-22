/**
 * V2, the **live** rows L1 and L2 (plan D14; ADR 0078).
 *
 * ## The question
 *
 * The literature says LLM reviewers praise novelty and never question it —
 * novelty appears in 21–34 % of the *strengths* they write and in ≤ 1 % of the
 * *weaknesses*, and is raised 10.69× less often than by humans. V2's answer is
 * not an exhortation but a **rule**: an `originality` concern must cite, as
 * its evidence, a paper one of the seat's own searches returned.
 *
 * These rows ask whether that rule can be satisfied at all by a real panel on
 * a paper where the answer genuinely exists. The fixture re-derives a known,
 * heavily cited optimiser under another name and another title, claims the
 * combination as new in four places, and never names it — so a reviewer that
 * searches for what the method DOES can find it, and one that does not, cannot.
 *
 * ## Reported, never asserted — with exactly one exception
 *
 * Every number here is tallied and printed. **No recall floor is asserted**,
 * for `planted-defects.live.test.ts`' reason: a floor asserted against a model
 * that moves under its own version is a flake generator, and is the
 * *"assertion admitting one outcome only"* ADR 0035 §5 forbids. A run in which
 * **no reviewer finds the known paper** is a finding for the Done record, not
 * a failure — the plan's acceptance gate says so in as many words.
 *
 * The one exception is **L2's structural assertion**: no `paper` evidence's
 * title is the manuscript's own. That is not a claim about how good the panel
 * is; it is the withholding guard either working or not, and a reviewer citing
 * the paper under review as its own prior art is incoherent on any model.
 * (It lives in `assertHonesty`, so it rides on every panel the tier runs.)
 *
 * ## Cost
 *
 * One panel per row on the cheap openai pin. The planted-defect rows measure
 * ≈ $0.10 per panel on the same shape and ceilings, so budget **≈ $0.2 per run
 * of this file**, and note `vitest.live.config.ts` carries `retry: 1` — a row
 * that fails once costs about twice that.
 *
 * The anthropic rows are written, typechecked and **skipped**: the pin is
 * disabled by operator decision (an exported key with no credit fails every
 * row on billing and reads as a regression). A closed pin is recorded as
 * *not measured — pin disabled*, never as zero.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelBinding, ReviewItem } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type NoveltyProbe,
  formatNoveltyReport,
  measureNovelty,
  readProbe,
} from "../../src/eval/novelty.js";
import { runEvalTask } from "../../src/eval/run-eval.js";
import { scenarioById } from "../../src/eval/scenarios.js";
import {
  RAISED_CEILINGS,
  assertHonesty,
  liveBinding,
  panelProtocol,
} from "./panel-rows.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/novelty-probe");

/** One probe panel, on whichever of the two twins the caller names. */
async function runProbe(
  tag: string,
  label: string,
  binding: ModelBinding,
  which: "paper" | "own-title",
): Promise<{
  item: ReviewItem | undefined;
  probe: NoveltyProbe;
  discard: () => Promise<void>;
}> {
  const scenario = scenarioById("novelty-probe");
  if (scenario === undefined) throw new Error("novelty-probe scenario missing");
  const probe = await readProbe(resolve(FIXTURE, "probe.json"));
  const paperDir = resolve(FIXTURE, which);

  const evidence = liveWorkDir();
  const started = Date.now();
  const task = await runEvalTask({
    scenario,
    paperDir,
    grants: new Map(),
    stub: false,
    // A panel never writes (ADR 0061 §1).
    readOnly: true,
    skills: await panelProtocol(),
    binding,
    ceilings: RAISED_CEILINGS,
  });
  evidence.track(task.workDir);

  const item = task.outcome.items.find(
    (i): i is ReviewItem => i.type === "review",
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const cost = task.usage?.costUsd;
  console.info(
    `[${tag}/${label}] ${which}: status=${item?.status ?? "no review"}` +
      ` out=${task.usage?.outputTokens ?? 0}` +
      ` cost=${cost === undefined ? "$unpriced" : `$${cost.toFixed(4)}`}` +
      ` in ${seconds}s`,
  );
  // L4 rides on every panel, the probe's included.
  assertHonesty(tag, item, label, paperDir);
  return { item, probe, discard: () => evidence.discard() };
}

/** L1's reading, printed. Nothing here is asserted. */
function reportL1(
  tag: string,
  label: string,
  item: ReviewItem | undefined,
  probe: NoveltyProbe,
): void {
  if (item === undefined) {
    console.info(`[${tag}/${label}] not measured — no review item`);
    return;
  }
  const report = measureNovelty(item, probe);
  console.info(formatNoveltyReport(report, probe));

  // `not_in_results` BEFORE and AFTER the one re-ask, read off a single run:
  // `ledger.firstPass` is the first answer's counts, so the pair says whether
  // the correction round recovers a reviewer that cited an unreturned paper —
  // which is the new floor this row exists to establish.
  const drops = (item.result?.limits ?? []).flatMap((l) =>
    l.kind === "anchors_dropped"
      ? l.anchors
          .filter((a) => a.reason === "not_in_results")
          .map(() => l.reviewer)
      : [],
  );
  console.info(
    `[${tag}/${label}] not_in_results: ${drops.length} drop(s)` +
      `${drops.length > 0 ? ` (${drops.join(", ")})` : ""}` +
      `; per seat before→after: ${
        item.seats
          .map((s) => {
            const first = s.ledger?.firstPass;
            return `${s.reviewer} ${first === undefined ? "—" : first.dropped}→${
              s.ledger?.dropped ?? "—"
            }`;
          })
          .join(" | ") || "none"
      }`,
  );
}

describe("V2 L1 — the probe under another name", () => {
  it.runIf(liveOpenAIReady())(
    "L1a: how many reviewers locate the work the paper re-derives (openai)",
    async () => {
      const run = await runProbe(
        "V2 live",
        "L1a/openai",
        liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
        "paper",
      );
      // The precondition, and the only behavioural assertion: a panel that did
      // not run measures nothing, and a zero taken from it would be fabricated.
      expect(run.item?.status).toBe("completed");
      reportL1("V2 live", "L1a/openai", run.item, run.probe);

      // Expected 0 on this fixture — REPORTED, not assumed. The probe's own
      // title is not the known work's, so nothing of its own should come back.
      console.info(
        `[V2 live/L1a/openai] ownTitleWithheld: ${
          (run.item?.seats ?? [])
            .map((s) => `${s.reviewer}:${s.ownTitleWithheld ?? 0}`)
            .join(" ") || "none"
        }`,
      );
      await run.discard();
    },
    600_000,
  );

  it.runIf(liveAnthropicReady())(
    "L1b: the same, on the anthropic pin",
    async () => {
      const run = await runProbe(
        "V2 live",
        "L1b/anthropic",
        liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
        "paper",
      );
      expect(run.item?.status).toBe("completed");
      reportL1("V2 live", "L1b/anthropic", run.item, run.probe);
      await run.discard();
    },
    600_000,
  );
});

describe("V2 L2 — the own-title twin", () => {
  it.runIf(liveOpenAIReady())(
    "L2a: the manuscript's own title is withheld from its reviewers (openai)",
    async () => {
      const run = await runProbe(
        "V2 live",
        "L2a/openai",
        liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
        "own-title",
      );
      expect(run.item?.status).toBe("completed");

      // The reading: how many results each seat had removed as its own paper.
      // A zero here is not a failure — it means no seat's query happened to
      // return the work — so it is printed and read, never asserted.
      const withheld = (run.item?.seats ?? []).map(
        (s) => `${s.reviewer}:${s.ownTitleWithheld ?? 0}`,
      );
      console.info(
        `[V2 live/L2a/openai] ownTitleWithheld per reviewer: ${
          withheld.join(" ") || "none"
        }; total=${(run.item?.seats ?? []).reduce(
          (n, s) => n + (s.ownTitleWithheld ?? 0),
          0,
        )}`,
      );

      // The structural assertion (`assertHonesty` made it on the way in): no
      // paper evidence is the manuscript itself. Restated here because THIS is
      // the fixture built to break it — the twin's `\title` IS a real, highly
      // cited paper, so a seat searching its own subject is being offered its
      // own manuscript by a real index.
      const papers = (run.item?.result?.annotations ?? []).filter(
        (a) => a.evidence?.kind === "paper",
      );
      console.info(`[V2 live/L2a/openai] paper evidences: ${papers.length}`);
      await run.discard();
    },
    600_000,
  );

  it.runIf(liveAnthropicReady())(
    "L2b: the same, on the anthropic pin",
    async () => {
      const run = await runProbe(
        "V2 live",
        "L2b/anthropic",
        liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
        "own-title",
      );
      expect(run.item?.status).toBe("completed");
      await run.discard();
    },
    600_000,
  );
});
