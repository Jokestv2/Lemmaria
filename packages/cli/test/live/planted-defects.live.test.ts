/**
 * R5, the **live** rows of the milestone's tier table (L1, L2, L3 — ADR 0070).
 *
 * ## The question
 *
 * Six milestones built a review panel and none of them said how good it is.
 * R3's panel found *"the empty Method and Experiments sections"* on a fixture
 * whose only defects were those two sections; R9's mixed panel located 4, 2 and
 * 4 concerns on the same fixture. Those are counts of what the panel **said**.
 * These rows measure what it **found**: sixteen defects planted by hand into a
 * completed manuscript, four per category after the field's own taxonomy, and
 * the panel's located concerns matched against them by span.
 *
 * ## Reported, never asserted — and why that is not a weaker test
 *
 * The only behavioural assertion here is `panel_located`, R3's, unchanged: the
 * precondition for measuring anything at all. **Every recall number is
 * tallied, not gated.** A recall floor asserted against a model that moves
 * under its own version is a flake generator, and precisely the *"assertion
 * admitting one outcome only"*
 * [ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md)
 * §5 forbids. The first measurement **is** the floor: it goes into the Done
 * record and ADR 0070's evidence table in prose, and a later milestone that
 * touches the panel compares against that prose by reading it.
 *
 * A run where the panel located concerns and hit **zero** defects is the
 * outcome `recall_zero` — tallied, printed, and named in the Done record as a
 * finding. Not a failure.
 *
 * ## The three panels, and what each is for
 *
 * - **L1a** — the default three reviewers on the openai pin. Recall per
 *   category on one model, and the same-model agreement over its three pairs.
 * - **L1b** — the same, on the anthropic pin. Two pins because R3 measured
 *   them locating 11 of 15 and 3 of 10 anchors respectively, and that drift is
 *   still OPEN: a recall difference between them is the second reading that
 *   question asked for.
 * - **L2** — R9's mixed shape, `[openai, anthropic, openai]`. The hivemind
 *   number: two cross-model pairs against one same-model pair, over the same
 *   manuscript and the same carve, so a difference is a difference in the
 *   TOPOLOGY.
 *
 * **L3 rides on all three at no extra spend**: the honesty record is asserted
 * as an implication over whatever each run produced. What it can assert is
 * bounded by what the record holds — a panel discards its seats' transcripts
 * (ADR 0061 §7), so *"this reviewer searched and the source was down"* is not
 * observable from here; what is observable is that every `source_unavailable`
 * names a real seat and a real non-`ok` status, that a seat which did not
 * complete is named by a `seat_missing`, and that `seat_unguided` never
 * appears. The branch each run took is printed either way.
 *
 * ## Cost
 *
 * **Measured**, where a run funded both pins: `L1a` $0.0750 and `L1b` $0.5579
 * (ADR 0070's one anthropic reading on this fixture) — so budget **≈ $0.9 per
 * run of this file**, and note that `vitest.live.config.ts` carries `retry: 1`,
 * which buys a SECOND panel for any row that fails its first attempt. A row
 * that fails once therefore costs about twice its estimate.
 *
 * The estimate this replaces — *"L1b ≈ $0.35 … about $0.65 per run"* — was
 * extrapolated from R3's and R9's runs before either pin had been measured on
 * this fixture, and it sat in the file the operator is told to run (the review
 * round's I15). The figures above are also pre-F2: a raised ceiling that now
 * really applies buys more output, so expect them to move up rather than down.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelBinding } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  DEFECT_CATEGORIES,
  type DefectManifest,
} from "../../src/eval/recall.js";
import {
  PLANTED_DEFECTS,
  type PanelRun,
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
const FIXTURE = resolve(here, "fixtures/planted-defects");
const PAPER = resolve(FIXTURE, "paper");
const DEFAULT_FILE = "main.tex";

/** The completed, planted manuscript. Pinned so a fixture edit is visible in
 *  the same breath as the number it would move. */
const FIXTURE_LINES = 457;

/**
 * The flat fixture's own shape, checked before any spend (the E1 pattern).
 *
 * The listing and the line count are this fixture's; everything else about a
 * planted-defect row lives in `panel-rows.ts`, shared with the split fixture
 * so the two rows are comparable (X5, ADR 0074 §10).
 */
const checkFixture = (manifest: DefectManifest): void =>
  checkPanelFixture(PAPER, manifest, {
    // The answer key must not be in the directory the reviewers read.
    files: ["PAPER.md", "main.tex", "refs.bib"],
    entry: DEFAULT_FILE,
    lines: FIXTURE_LINES,
  });

const WHERE = {
  tag: "R5 live",
  scenario: "planted-defects",
  fixtureDir: FIXTURE,
};

const runPanel = (
  label: string,
  binding: ModelBinding,
  over: { reviewers?: ModelBinding[]; synthesis?: ModelBinding } = {},
): Promise<PanelRun> =>
  runPanelRow(WHERE, label, binding, { ...over, precheck: checkFixture });

const PINS = [
  {
    label: "L1a/openai",
    protocol: "openai-compatible" as const,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "L1b/anthropic",
    protocol: "anthropic" as const,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

for (const pin of PINS) {
  describe.skipIf(!pin.ready())(
    `R5 live — planted-defect recall on one model (${pin.label})`,
    () => {
      it("locates a panel, and its recall is reported", async () => {
        const run = await runPanel(
          pin.label,
          liveBinding(pin.protocol, pin.model),
        );

        // THE assertion, R3's and unchanged: the precondition for measuring
        // anything. Everything else above is a number, and numbers are the
        // floor being recorded, never a gate (ADR 0035 §5).
        expect(
          run.outcome === "panel_located" || run.outcome === "recall_zero",
        ).toBe(true);
        expect(run.recall.overall.planted).toBe(PLANTED_DEFECTS);
        // D3's shape has two halves: sixteen planted, AND all four
        // categories present. A report short a category would read as a
        // clean zero for it rather than as an absent measurement.
        expect(Object.keys(run.recall.perCategory)).toEqual([
          ...DEFECT_CATEGORIES,
        ]);
        // Every seat ran on the pin this row named — a uniform panel, which is
        // what makes its three pairs same-model pairs.
        expect(run.item?.seats.every((s) => s.model === pin.model)).toBe(true);
        expect(run.agreement.sameModel.pairs).toBe(3);
        expect(run.agreement.crossModel.pairs).toBe(0);

        await run.discard();
      });
    },
  );
}

describe.skipIf(!liveOpenAIReady() || !liveAnthropicReady())(
  "R5 live — the hivemind: two cross-model pairs against one same-model pair (L2)",
  () => {
    it("measures agreement across models on the same manuscript", async () => {
      const openai = liveBinding("openai-compatible", LIVE_OPENAI_MODEL);
      const anthropic = liveBinding("anthropic", LIVE_ANTHROPIC_MODEL);
      const run = await runPanel("L2/mixed", openai, {
        // R9's own shape: `panel_located` stays reachable on the two openai
        // reviewers alone, so the row measures the mixed-panel MACHINERY
        // rather than re-measuring the anthropic pin's known anchor drift.
        reviewers: [openai, anthropic, openai],
        synthesis: openai,
      });

      expect(run.item?.seats.map((s) => s.model)).toEqual([
        LIVE_OPENAI_MODEL,
        LIVE_ANTHROPIC_MODEL,
        LIVE_OPENAI_MODEL,
      ]);
      expect(run.item?.synthesisSeat?.model).toBe(LIVE_OPENAI_MODEL);
      // One same-model pair (a, c) against two cross-model pairs (a, b) and
      // (b, c) — the comparison D6 defines, taken rather than promised.
      expect(run.agreement.sameModel.pairs).toBe(1);
      expect(run.agreement.crossModel.pairs).toBe(2);
      expect(
        run.outcome === "panel_located" || run.outcome === "recall_zero",
      ).toBe(true);

      await run.discard();
    });
  },
);
