/**
 * X5 (L2, L4): the same measurement, on the same paper, cut into `\input`-ed
 * files — and a panel refused before it spends.
 *
 * **Why this file exists.** The operator's gate-review round measured a panel
 * that loses almost everything anchored in a section file: 37 anchors dropped,
 * 33 of them (89%) present verbatim and uniquely in another manuscript file.
 * The flat fixture cannot see that failure at all, because it has one file.
 * This fixture is the flat one cut along `\input` boundaries and **expands to
 * it byte for byte** (`planted-defects-split-fixture.test.ts`), so a difference
 * in the located rate between the two rows is attributable to **layout alone**.
 *
 * **What is asserted is structure, never a number.** The located rate, the
 * recall, the relocated and rejected counts and the outage-shaped count are all
 * **reported** ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5)
 * — the first reading is the new floor, recorded in prose, and a threshold here
 * would be a flake generator across model versions. What fails is the run not
 * happening.
 *
 * **Both pins have rows; only the enabled one is read.** The Anthropic pin is
 * off by operator decision (unfunded) and skips cleanly, which is recorded as
 * *not measured — pin disabled*, never as zero. Nothing here asks for it to be
 * funded.
 *
 * **Cost.** ≈ US$0.08 a cheap-pin panel before X5; the re-ask adds at most one
 * turn per seat. L4 is a refused request and costs essentially nothing — which
 * is the whole point of it.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DefectManifest } from "../../src/eval/recall.js";
import { DEFECT_CATEGORIES } from "../../src/eval/recall.js";
import {
  PLANTED_DEFECTS,
  checkFixture as checkPanelFixture,
  liveBinding,
  runPanel as runPanelRow,
} from "./panel-rows.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/planted-defects-split");

/** The split fixture's own shape. The entry is 48 lines — 37 of preamble, the
 *  seven `\input` lines, and four of back matter — which is exactly why a
 *  seat told only *"the main file is main.tex"* read a preamble. */
const ENTRY_LINES = 48;

const checkFixture = (manifest: DefectManifest): void =>
  checkPanelFixture(resolve(FIXTURE, "paper"), manifest, {
    // The answer key must not be in the directory the reviewers read, and the
    // listing is the whole cut — nine `.tex` files plus the two shared ones.
    files: [
      "PAPER.md",
      "main.tex",
      "refs.bib",
      "sections/background.tex",
      "sections/conclusion.tex",
      "sections/discussion.tex",
      "sections/experiments.tex",
      "sections/introduction.tex",
      "sections/method.tex",
      "sections/related.tex",
      "tables/main-results.tex",
    ],
    entry: "main.tex",
    lines: ENTRY_LINES,
  });

const WHERE = {
  tag: "X5 live",
  scenario: "planted-defects-split",
  fixtureDir: FIXTURE,
};

const PINS = [
  {
    label: "L2a/openai",
    protocol: "openai-compatible" as const,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "L2b/anthropic",
    protocol: "anthropic" as const,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

for (const pin of PINS) {
  describe.skipIf(!pin.ready())(
    `X5 live — planted-defect recall on an \\input-split paper (${pin.label})`,
    () => {
      it("locates a panel across the manuscript's files, and reports its rate", async () => {
        const run = await runPanelRow(
          WHERE,
          pin.label,
          liveBinding(pin.protocol, pin.model),
          { precheck: checkFixture },
        );

        // THE assertion, the flat row's and unchanged: the precondition for
        // measuring anything at all. Everything else printed above is a
        // number, and numbers are the floor being recorded, never a gate.
        expect(
          run.outcome === "panel_located" || run.outcome === "recall_zero",
        ).toBe(true);
        expect(run.recall.overall.planted).toBe(PLANTED_DEFECTS);
        // Sixteen planted AND all four categories present. A report short a
        // category would read as a clean zero for it rather than as an absent
        // measurement.
        expect(Object.keys(run.recall.perCategory)).toEqual([
          ...DEFECT_CATEGORIES,
        ]);
        // A uniform panel on the pin this row named, which is what makes its
        // three pairs same-model pairs.
        expect(run.item?.seats.every((s) => s.model === pin.model)).toBe(true);
        expect(run.agreement.sameModel.pairs).toBe(3);
        expect(run.agreement.crossModel.pairs).toBe(0);

        // X5's own precondition: the pre-run check ran and passed, so the
        // seats' numbers are a measurement rather than the arithmetic of a
        // panel that never reached a model.
        expect(run.item?.preflight?.every((p) => p.status === "ok")).toBe(true);

        // L5 — the tally's identities, as implications over whatever the run
        // produced. `assertHonesty` already checks them per seat; this is the
        // panel-level one, and it is arithmetic rather than a threshold.
        const located = Object.values(run.recall.perReviewer).reduce(
          (n, r) => n + (r.ledger?.located ?? 0),
          0,
        );
        const entries = Object.values(run.recall.perReviewer).reduce(
          (n, r) => n + (r.ledger?.entries ?? 0),
          0,
        );
        expect(located).toBeLessThanOrEqual(entries);

        await run.discard();
      });
    },
  );
}

for (const pin of PINS) {
  describe.skipIf(!pin.ready())(
    `X5 live — a model that cannot answer refuses the panel (${pin.label.replace("L2", "L4")})`,
    () => {
      it("refuses before a single seat runs, and says which model", async () => {
        // The failure the whole preflight exists for, reproduced against a
        // REAL provider: a binding whose endpoint and credential are good and
        // whose model id is not. Before X5 this cost a whole panel — two dead
        // seats and one paid — and the author paid to find out.
        //
        // The model id is deliberately one no provider will ever have. The
        // endpoint and key are the pin's own, so what is under test is the
        // model id alone rather than a whole broken binding.
        const good = liveBinding(pin.protocol, pin.model);
        const bad = { ...good, model: "lemmaria-no-such-model" };
        const run = await runPanelRow(WHERE, `${pin.label}/refused`, good, {
          reviewers: [good, bad],
          precheck: checkFixture,
        });

        // The panel is refused whole. Running the one good seat would make the
        // author pay for this panel twice — once now, once when they re-run it
        // having fixed the model — and a refusal costs nothing.
        expect(run.item?.status).toBe("failed");
        expect(run.item?.seats).toEqual([]);

        // Two distinct bindings, so two checks; exactly the bad one failed.
        const rows = run.item?.preflight ?? [];
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const failed = rows.filter((p) => p.status === "failed");
        expect(failed.map((p) => p.model)).toEqual(["lemmaria-no-such-model"]);
        // The provider's OWN sentence, kept as authored — third-party text,
        // never translated and never rewritten. Non-empty is the structural
        // claim; which words it uses is the provider's business.
        expect(failed[0]?.cause?.message ?? "").not.toBe("");
        // The class is REPORTED, not asserted: providers disagree about
        // whether an unknown model is a 404 or a 400, and pinning it here
        // would fail on a provider's own wording change.
        console.info(
          `[X5 live/${pin.label.replace("L2", "L4")}] refusal class=${failed[0]?.cause?.class} ` +
            `message=${JSON.stringify(failed[0]?.cause?.message ?? "")}`,
        );

        // And nothing was spent on a seat. A check that failed reports no
        // usage of its own, so a refused panel's cost is at most the checks
        // that PASSED before it.
        expect(run.item?.seats ?? []).toHaveLength(0);
        expect(failed[0]?.usage).toBeUndefined();

        await run.discard();
      });
    },
  );
}
