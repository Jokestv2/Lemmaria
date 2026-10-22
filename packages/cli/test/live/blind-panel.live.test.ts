/**
 * R3, the **live** row of the milestone's tier table (L1, ADR 0061).
 *
 * ## The question
 *
 * R2's live row proved one thing: a real model can write a concern ledger the
 * harness locates in a whole manuscript's own bytes, given the wire format
 * stated in full **in the prompt**. R3 moves that format into a bundled skill
 * and hands it to **three seats at once**, each with a lens of its own, each
 * made to load the protocol through a forced `/skill:` exchange — and then asks
 * a fourth, tool-less child to read the three ledgers against each other.
 *
 * Every one of those steps is a place the protocol can be lost, and **not one
 * of them is observable offline**:
 *
 * - Does a real model, handed the protocol as a SKILL body rather than as the
 *   prompt's own words, still produce a locatable ledger? S5's finding was that
 *   a paraphrased protocol is a lost protocol; ADR 0059's forced load is the
 *   remedy, and this is the first row that measures it over a real manuscript.
 * - Do three seats with different lenses find **different** things, or does one
 *   lens dominate and the panel cost three times a single review for one
 *   review's worth of findings?
 * - Can a model produce a synthesis that cites **ids it was given** rather than
 *   inventing them — the check `interpretSynthesis` enforces and no offline
 *   test can predict a model will pass?
 *
 * ## The two budgets, and why both run
 *
 * `carveChildBudget` divides **output tokens** across the children and leaves
 * turns and tool calls per-agent. So at the stage default
 * (`DEFAULT_TASK_BUDGET`, 16,000 output tokens) each of the three seats gets
 * ≈ 5,333 — above `PANEL_SEAT_TOKEN_FLOOR`, so no `review.seat_budget` notice,
 * but **unmeasured** for a seat that must read a whole manuscript AND write a
 * ledger. R2's single seat was given 6,000 and used a fraction of it, which
 * makes 5,333 plausible and nothing more.
 *
 * So the row runs twice per pin. The **raised** budget (`{12, 24, 24_000}`,
 * 8,000 per seat) is the one asserted: it answers the protocol question without
 * a starved seat confounding it. The **default** budget is run and tallied, and
 * a seat that starves there is a finding recorded at the gate — never a reason
 * to move `DEFAULT_TASK_BUDGET`, which is a stage constraint this milestone
 * does not touch. *"Both pins starve at the default"* becomes an operator
 * question (raise the setting's default? a panel-specific budget?), which is
 * what the plan's Watch-for says it becomes.
 *
 * ## `literature_search` is offered, deliberately
 *
 * The `positioning` seat's lens says searching the literature is expected of
 * it, and live that tool reaches the real Crossref / DBLP / arXiv / Semantic
 * Scholar providers — real egress, real pacing, real wall time, and a real
 * source of flakes. It is offered anyway, because two of L1's tallies
 * (`source_unavailable`, `search_budget_spent`) exist precisely to record what
 * a seat could not reach, and a run that never searched would measure a panel
 * nobody ships. A source that fails is therefore **tallied, not fatal**: the
 * limits are the honest record, which is the whole point of ADR 0060's ledger.
 *
 * ## What is reported
 *
 * The tally and the branch that held are logged **either way** (a null result
 * needs a name of its own, or it borrows the name of a pass):
 *
 * - `panel_located` — ≥ 2 seats parsed, each of ≥ 2 of them carrying at least
 *   one located concern, and a synthesis present.
 * - `panel_partial` — parsed, but short of that: one contributing seat, or no
 *   synthesis.
 * - `panel_empty` — seats parsed and every one of them raised nothing. Named so
 *   it cannot borrow a pass: *no quota* is correct behaviour in general, but on
 *   THIS fixture it is a model finding, because all nine S5 seats found its two
 *   deliberately empty scaffolds.
 * - `panel_unparsed` — no seat produced a ledger the harness could read.
 * - `no_run` — a precondition refused the panel, or the task did not complete.
 *
 * The test **asserts `panel_located` on each pin at the raised budget**; a
 * failure is a finding reported beside the gate, never counted in it
 * ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewLimit,
  Skill,
} from "@lemmaria/harness";
import {
  DEFAULT_REVIEWER_COUNT,
  DEFAULT_TASK_BUDGET,
  PANEL_SKILL,
  REVIEWER_NAMES,
  describeWrapping,
  listSkills,
} from "@lemmaria/harness";
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
const PAPER = resolve(here, "fixtures/blind-panel/paper");
const DEFAULT_FILE = "main.tex";

/**
 * R2's fixture, copied rather than shared: R2's row is pinned to it as the
 * document its measurement was taken over, and a later edit made for R3 would
 * silently move R2's numbers. 223 newline-terminated lines — one `read_span`
 * covers it whole (`READ_SPAN_MAX_LINES` is 300), which is what keeps each seat
 * inside the pins' turn budget. Counted the way `wc -l` counts.
 */
const FIXTURE_LINES = 223;

/**
 * `/review` and nothing else: the whole point is that the harness — not a model
 * turn — issues the fan-out (ADR 0061 §2). The prompt carries no protocol,
 * because the protocol is the bundled skill each seat is made to load.
 */
const SPEC: EvalTaskSpec = {
  id: "live-blind-panel",
  prompt: "/review",
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files", "literature_search"],
};

/** The plan's raised budget: 8,000 output tokens per seat, turns undivided. */
const RAISED_BUDGET = {
  maxTurns: 12,
  maxToolCalls: 24,
  maxOutputTokens: 24_000,
};

const PROVIDERS = [
  {
    label: "openai-compatible",
    protocol: "openai-compatible" as const,
    model: LIVE_OPENAI_MODEL,
    ready: liveOpenAIReady,
  },
  {
    label: "anthropic",
    protocol: "anthropic" as const,
    model: LIVE_ANTHROPIC_MODEL,
    ready: liveAnthropicReady,
  },
];

/**
 * The SHIPPED protocol, through the bundled loader (`dist/skills`) — never a
 * hand-written fixture. A skill written here would measure a protocol nobody
 * ships, which is the one thing this row exists not to do.
 */
async function panelProtocol(): Promise<Skill[]> {
  const { skills, diagnostics } = await listSkills({
    bundledDir: bundledSkillsDir(),
  });
  // A broken fixture is indistinguishable from a real regression at the moment
  // you are trying to tell them apart, so it fails HERE, before any spend.
  expect(diagnostics).toEqual([]);
  const protocol = skills.find((s) => s.name === PANEL_SKILL);
  expect(protocol?.source).toBe("bundled");
  expect(protocol?.body ?? "").not.toBe("");
  return skills;
}

/** Every `.tex` under the fixture, keyed the way a seat would cite it. */
function manuscriptFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".tex")) {
        files.set(
          relative(PAPER, child).split(sep).join("/"),
          readFileSync(child, "utf8"),
        );
      }
    }
  };
  walk(PAPER);
  return files;
}

/** The fixture check, run before any spend (the E1 pattern). */
function checkFixture(): void {
  const files = manuscriptFiles();
  expect(files.has(DEFAULT_FILE)).toBe(true);
  const main = files.get(DEFAULT_FILE) as string;
  expect(
    main.split("\n").filter((_, i, all) => i < all.length - 1),
  ).toHaveLength(FIXTURE_LINES);
  expect(main.endsWith("\n")).toBe(true);
  // A30: the hard-wrapped hint is the one this manuscript exercises. If the
  // fixture were replaced by a long-line document the seats would be given the
  // OTHER anchor rule and the row would measure something else.
  expect(describeWrapping(main)).toContain("hard-wrapped");
}

/**
 * X5 (ADR 0074 §10): the shared classifier, imported rather than copied.
 *
 * This file held its own definition, byte-equivalent in behaviour to
 * `classifyPanel` — same `missing` set from the `seat_missing` limits, same
 * `completed && !missing` count, same thresholds. Confirmed identical before
 * switching, because X5 adds a fourth caller and a fourth copy is what
 * `known-limits.md` names as the trigger.
 *
 * "≥ 1 located annotation each" reads as: at least two of the parsed seats
 * each contributed one. A third seat that parsed and raised nothing is a
 * finding under *no quota*, not a downgrade of the panel's outcome.
 */
type Outcome = ReturnType<typeof classifyPanel>;
const classify = classifyPanel;

/**
 * One line per reviewer: what it located, what it dropped, and how.
 *
 * R9: the names are ORDINALS now, and this reads the default panel's set. It
 * only ever NAMED the seats — no assertion in this file depends on which
 * reviewer found what — so the rename is a relabelling of the tally, not a
 * change to what is measured.
 */
function seatTally(item: ReviewItem, limits: readonly ReviewLimit[]): string {
  return REVIEWER_NAMES.slice(0, DEFAULT_REVIEWER_COUNT)
    .map((name) => {
      const mine = (a: ReviewAnnotation) => a.reviewer === name;
      const located = item.result?.annotations.filter(mine) ?? [];
      const dropped = limits
        .filter((l) => l.kind === "anchors_dropped" && l.reviewer === name)
        .flatMap((l) => (l.kind === "anchors_dropped" ? l.anchors : []));
      const state = item.seats.find((s) => s.reviewer === name);
      const gone = limits.find(
        (l) => l.kind === "seat_missing" && l.reviewer === name,
      );
      return (
        `${name}=${state?.status ?? "?"}` +
        `${state?.retried === true ? "+retried" : ""}` +
        `/${located.length}loc/${dropped.length}drop` +
        `${dropped.length > 0 ? `(${dropped.map((d) => `${d.role}:${d.reason}`).join(" ")})` : ""}` +
        // A starved seat says so in the driver's own words — the budget code it
        // stopped on is carried in `detail`, which is what tells starvation apart
        // from a model that simply wrote an unreadable ledger.
        `${gone?.kind === "seat_missing" ? `/missing:${gone.reason}${gone.detail !== undefined ? `(${gone.detail})` : ""}` : ""}`
      );
    })
    .join(" ");
}

function report(
  label: string,
  budget: string,
  item: ReviewItem | undefined,
  task: { turns: number; toolCalls: number; usage?: { costUsd?: number } },
): Outcome {
  const outcome = classify(item);
  const limits = item?.result?.limits ?? [];
  const annotations = item?.result?.annotations ?? [];
  const majors = annotations.filter((a) => a.severity === "major");
  const synthesis = item?.result?.synthesis;
  // R4/L2: the per-seat SEARCH COUNT is not observable from here. The plan
  // assumed a seat's items were reachable (A24); they are not — a panel
  // discards its seats' transcripts (ADR 0061 §7) and `ReviewSeatState` carries
  // only reviewer/status/retried/usage. So the tally reports what the review
  // item does hold: which sources a seat could not reach, and — new at R4 —
  // whether one of them ran without an API key.
  console.info(
    `[R3 live/${label}/${budget}] outcome=${outcome} status=${item?.status ?? "none"} ` +
      `${seatTally(item ?? ({ seats: [] } as unknown as ReviewItem), limits)} ` +
      `majors=${majors.length} blocking=${majors.filter((a) => a.blocking !== undefined).length} ` +
      `evidence-missing=${annotations.filter((a) => a.evidence?.kind === "missing").length} ` +
      `evidence-located=${annotations.filter((a) => a.evidence?.kind === "span").length} ` +
      `synthesis=${item?.synthesis ?? "?"}` +
      `${synthesis ? `(${synthesis.consensus.length}c/${synthesis.disagreements.length}d)` : ""} ` +
      `unguided=${limits.filter((l) => l.kind === "seat_unguided").length} ` +
      `sources=${
        limits
          .filter((l) => l.kind === "source_unavailable")
          .map((l) =>
            l.kind === "source_unavailable"
              ? `${l.reviewer}/${l.source}:${l.status}${l.anonymous === true ? ":anon" : ""}`
              : "",
          )
          .join(" ") || "all-ok"
      } ` +
      `search-budget-spent=${limits.filter((l) => l.kind === "search_budget_spent").length} searches=not-observable ` +
      `turns=${task.turns} tool-calls=${task.toolCalls} ` +
      `usage=${item?.usage?.outputTokens ?? "?"}out` +
      `${task.usage?.costUsd === undefined ? "" : `/$${task.usage.costUsd.toFixed(4)}`}`,
  );
  return outcome;
}

for (const provider of PROVIDERS) {
  describe.skipIf(!provider.ready())(
    `R3 live — three blind seats and a synthesis over a whole manuscript (${provider.label})`,
    () => {
      const run = async (budget?: typeof RAISED_BUDGET) => {
        const evidence = liveWorkDir();
        checkFixture();
        const task = await runEvalTask({
          scenario: SPEC,
          paperDir: PAPER,
          grants: new Map(),
          stub: false,
          // A panel never writes (ADR 0061 §1), so the eval offers no edit host
          // — otherwise `propose_edit` is loop-injected into every seat and the
          // row would measure a panel with a capability the product's has not.
          readOnly: true,
          skills: await panelProtocol(),
          binding: liveBinding(provider.protocol, provider.model),
          ...(budget ? { budget } : {}),
        });
        evidence.track(task.workDir);
        const item = task.outcome.items.find(
          (i): i is ReviewItem => i.type === "review",
        );
        return { task, item, evidence };
      };

      it("reaches panel_located at the raised budget", async () => {
        const { task, item, evidence } = await run(RAISED_BUDGET);
        const outcome = report(provider.label, "raised", item, task);

        // THE assertion: the protocol survives being a skill body handed to
        // three parallel seats, the harness locates what they quote in the
        // manuscript's own bytes, and a fourth child reads their ledgers
        // against each other citing only ids it was given.
        expect(outcome).toBe("panel_located");

        await evidence.discard();
      });

      it("is tallied, not asserted, at the stage default budget", async () => {
        const { task, item, evidence } = await run(undefined);
        report(provider.label, "default", item, task);
        // Deliberately no assertion on the outcome. The question this run
        // answers is how many seats starve at `DEFAULT_TASK_BUDGET` — a finding
        // for the gate record and, if both pins starve, an operator question.
        // Asserting it here would turn a measurement into a constant change
        // this milestone is not allowed to make.
        expect(DEFAULT_TASK_BUDGET.maxOutputTokens).toBe(16_000);
        await evidence.discard();
      });
    },
  );
}
