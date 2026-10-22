/**
 * R9, the **live** row of the milestone's tier table (L1, ADR 0069).
 *
 * ## The question
 *
 * R3's live row proved a panel survives being three seats on ONE model. R9's
 * whole claim is that the reviewers are now independent — each a whole review,
 * each on a model the user picked — and that the cross-review reads across
 * them **without being told which model said what** (D6). Three things about
 * that are unobservable offline, and each one is why this row costs money:
 *
 * - **Does the sixth argument actually reach the wire?** `runChild` now takes a
 *   `ChildModel`, and offline every reviewer runs on a scripted adapter that
 *   cannot tell two bindings apart. Only a live run proves that
 *   `reviewer_b`'s request went to the *anthropic* endpoint with the
 *   *anthropic* key while `reviewer_a`'s went to the openai one — the two
 *   protocols have different wire formats, so a binding that did not reach
 *   the adapter cannot come back with a usable review at all. **That shows up
 *   in the tally, not in the assertion**: the seat-model expectation below
 *   reads the RECORD, which `stampModel` writes from what was passed, and
 *   `panel_located` is reachable on the two openai reviewers alone by design
 *   (see the panel's shape below). So the evidence for this bullet is the
 *   per-reviewer located/dropped line for `reviewer_b` — read it; a `reviewer_b`
 *   that located nothing and errored is the failure this row exists to
 *   surface, and it is reported beside the gate rather than asserted in it.
 * - **Is cross-model agreement observable at all?** `interpretSynthesis`
 *   refuses any entry that does not cite two DIFFERENT reviewers, and under
 *   R3's topology two agreeing reviewers were always the same model. This row
 *   records whether any consensus or disagreement entry cites two reviewers on
 *   **different models** — the fact R5's hivemind measurement is built on, and
 *   the one the operator asked for.
 * - **What does N whole reviewers cost in searches?** Under D1 every reviewer
 *   is told the literature is expected of it, so ADR 0067 §6's revisit trigger
 *   — *"a fourth seat that searches"* — fires by construction. D10 declines to
 *   build the per-reviewer reservation and says the shared budget is
 *   *reachable at N ≥ 7*; this row tallies `search_budget_spent` at N = 3, so
 *   the claim is measured rather than asserted.
 *
 * ## The panel it runs
 *
 * `reviewers = [openai, anthropic, openai]`, `synthesis = openai`, over R3's
 * own fixture at R3's raised budget — the same manuscript and the same carve,
 * so a difference in what the panel finds is a difference in the TOPOLOGY and
 * not in the document or the tokens.
 *
 * Two openai reviewers rather than one of each: R3's own measurement recorded
 * the anthropic pin locating 3 of 10 anchors against the openai pin's 11 of 15,
 * and that drift is still OPEN. With two openai reviewers `panel_located` is
 * reachable even if the anthropic reviewer drops every anchor — so the
 * assertion measures the mixed-panel MACHINERY rather than re-measuring a pin's
 * known weakness, and the anthropic reviewer's drops are reported beside the
 * result instead of counted in it.
 *
 * ## What is reported
 *
 * Per reviewer: the model **as the record has it** (§D4 — not as this file
 * passed it, which would assert the test's own input), located / dropped,
 * `source_unavailable`, `search_budget_spent`, and usage. Then the
 * cross-review's entries, and whether any of them spans two models.
 *
 * Skips cleanly unless **both** keys are present: a mixed panel needs both
 * providers, and running it with one would measure a uniform panel under a
 * mixed panel's name.
 *
 * The test **asserts `panel_located`**; a failure is a finding reported beside
 * the gate, never counted in it
 * ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelBinding,
  ReviewItem,
  ReviewLimit,
  Skill,
} from "@lemmaria/harness";
import { PANEL_SKILL, listSkills } from "@lemmaria/harness";
import { bundledSkillsDir } from "@lemmaria/harness/bundled-skills";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import { classifyPanel } from "../../src/eval/scenarios.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
/** R3's fixture, unchanged — see the header for why the document is held
 *  constant while the topology moves. */
const PAPER = resolve(here, "fixtures/blind-panel/paper");

const SPEC: EvalTaskSpec = {
  id: "live-reviewer-panel",
  prompt: "/review",
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files", "literature_search"],
};

/**
 * R3's raised budget, so the carve per reviewer is the one R3 measured.
 *
 * **Passed as `ceilings`, and R9's recorded figures were taken before that was
 * true** (the R5 review round's F2). As `budget` it was an action's *request*,
 * which `resolveTaskBudget` clamps down from the ceiling and cannot raise, so
 * `min(16_000, 24_000) = 16_000` applied and the carve per reviewer was
 * **5,333** output tokens at N = 3, not the 8,000 this comment claims. Whether
 * R9's mixed-panel numbers are re-measured against the ceiling they were meant
 * to have is the operator's call; ADR 0071 records the discrepancy.
 */
const RAISED_CEILINGS = {
  maxTurns: 12,
  maxToolCalls: 24,
  maxOutputTokens: 24_000,
};

/** The SHIPPED protocol, through the bundled loader — never a hand-written
 *  fixture, which would measure a protocol nobody ships. */
async function panelProtocol(): Promise<Skill[]> {
  const { skills, diagnostics } = await listSkills({
    bundledDir: bundledSkillsDir(),
  });
  expect(diagnostics).toEqual([]);
  const protocol = skills.find((s) => s.name === PANEL_SKILL);
  expect(protocol?.source).toBe("bundled");
  expect(protocol?.body ?? "").not.toBe("");
  return skills;
}

/** Did any cross-review entry cite two reviewers on DIFFERENT models?
 *
 *  The whole reason R9 lands before R5: `interpretSynthesis` has always
 *  demanded two different reviewers, and under one model that could never mean
 *  two different models. The cross-review is not told any of this (D6) — the
 *  fact is reconstructed HERE, from ids → reviewer → the record's model. */
function spansTwoModels(item: ReviewItem): boolean {
  const modelOf = new Map(item.seats.map((s) => [s.reviewer, s.model]));
  const reviewerOf = new Map(
    (item.result?.annotations ?? []).map((a) => [a.id, a.reviewer]),
  );
  const entries = [
    ...(item.result?.synthesis?.consensus ?? []),
    ...(item.result?.synthesis?.disagreements ?? []),
  ];
  return entries.some((e) => {
    const models = new Set(
      e.ids.map((id) => modelOf.get(reviewerOf.get(id) ?? "") ?? ""),
    );
    models.delete("");
    return models.size >= 2;
  });
}

/** One line per reviewer, keyed on the panel that actually ran rather than on
 *  a constant — the count is a setting now. */
function reviewerTally(
  item: ReviewItem,
  limits: readonly ReviewLimit[],
): string {
  return item.seats
    .map((seat) => {
      const name = seat.reviewer;
      const located =
        item.result?.annotations.filter((a) => a.reviewer === name) ?? [];
      const dropped = limits
        .filter((l) => l.kind === "anchors_dropped" && l.reviewer === name)
        .flatMap((l) => (l.kind === "anchors_dropped" ? l.anchors : []));
      const gone = limits.find(
        (l) => l.kind === "seat_missing" && l.reviewer === name,
      );
      const sources = limits
        .filter((l) => l.kind === "source_unavailable" && l.reviewer === name)
        .map((l) =>
          l.kind === "source_unavailable" ? `${l.source}:${l.status}` : "",
        );
      const spent = limits.filter(
        (l) => l.kind === "search_budget_spent" && l.reviewer === name,
      ).length;
      return (
        // The model AS RECORDED (§D4). Reading it back from the item rather
        // than from this file's own input is what makes it evidence.
        `${name}@${seat.model}${seat.unverified === true ? "!unverified" : ""}` +
        `=${seat.status}${seat.retried === true ? "+retried" : ""}` +
        `/${located.length}loc/${dropped.length}drop` +
        `${sources.length > 0 ? `/sources:${sources.join(",")}` : ""}` +
        `${spent > 0 ? "/search-budget-spent" : ""}` +
        `${gone?.kind === "seat_missing" ? `/missing:${gone.reason}` : ""}` +
        `/${seat.usage?.outputTokens ?? "?"}out`
      );
    })
    .join(" ");
}

describe.skipIf(!liveOpenAIReady() || !liveAnthropicReady())(
  "R9 live — three reviewers on two providers, and a cross-review blind to both",
  () => {
    it("runs each reviewer on the model it was given, and reads across them", async () => {
      const evidence = liveWorkDir();
      const openai: ModelBinding = liveBinding(
        "openai-compatible",
        LIVE_OPENAI_MODEL,
      );
      const anthropic: ModelBinding = liveBinding(
        "anthropic",
        LIVE_ANTHROPIC_MODEL,
      );
      const task = await runEvalTask({
        scenario: SPEC,
        paperDir: PAPER,
        grants: new Map(),
        stub: false,
        // A panel never writes (invariant 3): no edit host, so `propose_edit`
        // is not loop-injected into any reviewer.
        readOnly: true,
        skills: await panelProtocol(),
        // The PARENT's binding is the openai pin, which is also what a
        // "same as Writing" role would resolve to — so the anthropic reviewer
        // is the one that can only be running on its own binding.
        binding: openai,
        reviewers: [openai, anthropic, openai],
        synthesis: openai,
        ceilings: RAISED_CEILINGS,
      });
      evidence.track(task.workDir);

      const item = task.outcome.items.find(
        (i): i is ReviewItem => i.type === "review",
      );
      const limits = item?.result?.limits ?? [];
      const synthesis = item?.result?.synthesis;
      const contributing = new Set(
        (item?.result?.annotations ?? []).map((a) => a.reviewer),
      ).size;
      // X5 (ADR 0074 §10): the shared classifier. This was an inline ternary
      // chain applying exactly `classifyPanel`'s rules over a locally-counted
      // `parsed` — confirmed identical before switching, so the panel outcome
      // has one definition rather than three.
      const outcome = classifyPanel(item);

      console.info(
        `[R9 live/mixed/raised] outcome=${outcome} status=${item?.status ?? "none"} ` +
          `${item ? reviewerTally(item, limits) : "no-item"} ` +
          `cross-review=${item?.synthesis ?? "?"}` +
          `${synthesis ? `(${synthesis.consensus.length}c/${synthesis.disagreements.length}d)` : ""} ` +
          `spans-two-models=${item ? spansTwoModels(item) : false} ` +
          `cross-review-model=${item?.synthesisSeat?.model ?? "?"}` +
          `/${item?.synthesisSeat?.usage?.outputTokens ?? "?"}out ` +
          `search-budget-spent=${limits.filter((l) => l.kind === "search_budget_spent").length} ` +
          `turns=${task.turns} tool-calls=${task.toolCalls} ` +
          `usage=${item?.usage?.outputTokens ?? "?"}out` +
          `${task.usage?.costUsd === undefined ? "" : `/$${task.usage.costUsd.toFixed(4)}`}`,
      );

      // The record says which model each reviewer ran on, and the two
      // protocols are different wire formats — so a binding that never
      // reached its adapter cannot pass this quietly.
      expect(item?.seats.map((s) => s.model)).toEqual([
        LIVE_OPENAI_MODEL,
        LIVE_ANTHROPIC_MODEL,
        LIVE_OPENAI_MODEL,
      ]);
      expect(item?.synthesisSeat?.model).toBe(LIVE_OPENAI_MODEL);

      // THE assertion. Reachable from the two openai reviewers alone, by
      // design: the anthropic pin's anchor drift is OPEN and is reported in
      // the line above rather than counted here.
      expect(outcome).toBe("panel_located");

      await evidence.discard();
    });
  },
);
