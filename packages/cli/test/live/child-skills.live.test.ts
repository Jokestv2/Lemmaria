/**
 * R1, the **live** row of the milestone's tier table (ADR 0059).
 *
 * ## The question
 *
 * Every offline row in R1 proves the *mechanism*: an equipped child gets
 * `load_skill` and a catalogue restricted to its set, the resolution is in
 * catalogue order, the record says what it was given. **None of them can prove
 * a model uses the argument it is told about** — and that is the whole claim
 * the milestone exists for, because the failure R1 removes is a *model*
 * failure, not a harness one: the S5 spike measured a parent that, unable to
 * hand its skill down, paraphrased a 1,664-character body into 538–563-character
 * goals and lost one of the four baseline rules in transit.
 *
 * So the fixture is a **review protocol with a token nothing else carries**.
 * `concern-ledger` prefixes every concern id `CL-` and ends every report with
 * `LEDGER-CLOSE: KESTREL`; neither string appears anywhere else in the fixture,
 * and the parent never sees the body (it holds the skill, but a body reaches
 * nobody until someone calls `load_skill`). A child's report containing
 * `KESTREL` therefore means the body reached *that child* and was followed —
 * which is exactly what a paraphrase in the goal could not produce.
 *
 * Reading two children's reports and deciding whether they match a protocol is
 * the slow, unreliable task [ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
 * §2 sends to the live tier rather than to a human.
 *
 * ## What is reported
 *
 * The tally and the branch that held are logged **either way** (ADR 0038 §2,
 * and T2's rule that a null result needs a name of its own or it borrows the
 * name of a pass):
 *
 * - `equipped_and_loaded` — at least one report equipped, carrying the token.
 * - `equipped_not_loaded` — equipped reports, none carrying it. A **model**
 *   finding; the harness is correct.
 * - `parent_did_not_equip` — a fan-out with `skills` on no child.
 * - `no_fan_out` — the parent never called `spawn_subtask`.
 *
 * The test **asserts `equipped_and_loaded` on each pin**, and a failure is a
 * finding reported beside the gate, never counted in it
 * ([ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md) §5).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Skill, listSkills } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/child-skills");
const PAPER = join(FIXTURE, "paper");

/** Appears ONLY in the skill body — never in the paper, never in the prompt. */
const LEDGER_TOKEN = "KESTREL";

/** The skill the parent is asked to hand down; checked by NAME, per D9. */
const LEDGER_SKILL = "concern-ledger";

const SPEC: EvalTaskSpec = {
  id: "live-child-skills",
  prompt:
    "Review this paper's abstract and its introduction as two independent reviewers: spawn two children in one spawn_subtask call, one per section, and equip each with the concern-ledger skill so it follows our ledger format. Then relay each child's report verbatim in your answer.",
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files"],
};

/**
 * The budget override is load-bearing, and **the binding constraint is turns,
 * not output tokens** — which is the plan's A16 corrected by measurement, the
 * thing A27 said this scenario would be the first to find out.
 *
 * `carveChildBudget` (ADR 0022 §3) treats the two halves differently: output
 * tokens are **divided** across children (the cost guard), while turns and tool
 * calls are the parent's **undivided remainder** (throughput is not charged
 * back — the CM6 purpose). The plan predicted output-token starvation and
 * raised that ceiling. The first live run showed output was never close: two
 * children spent **13 and 18 output tokens** and both returned
 * `(the subtask produced no report)`, because the parent had used 4 of
 * `LIVE_BUDGET`'s 6 turns on `update_plan`/`get_outline`/`list_files` before it
 * spawned, leaving each child **two** — and a reviewer child needs three: read
 * the section, `load_skill`, then write the ledger.
 *
 * So the ceiling that matters here is `maxTurns`, sized to leave a child room
 * for all three after a parent that plans first. The numbers stay near S5's
 * measured fan-out (10 turns / 24 tool calls) rather than being opened up: this
 * suite runs every gate, so per-run cost is a first-class constraint.
 */
const BUDGET = { maxTurns: 12, maxToolCalls: 20, maxOutputTokens: 12_000 };

async function fixtureSkills(): Promise<Skill[]> {
  const { skills, diagnostics } = await listSkills({
    userDir: join(FIXTURE, "skills"),
  });
  // A broken fixture is indistinguishable from a real regression at the moment
  // you are trying to tell them apart, so it fails HERE rather than downstream.
  expect(diagnostics).toEqual([]);
  expect(skills.map((s) => s.name)).toEqual([LEDGER_SKILL]);
  expect(skills[0]?.body).toContain(LEDGER_TOKEN);
  return skills;
}

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

type Report = {
  goal: string;
  status: string;
  summary: string;
  skills?: string[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};

/** Every child report the run persisted, across every fan-out it made. */
function reportsOf(items: readonly { type: string }[]): Report[] {
  const out: Report[] = [];
  for (const item of items) {
    if (item.type !== "subtask") continue;
    out.push(...(item as unknown as { reports: Report[] }).reports);
  }
  return out;
}

function spawnedWithSkills(items: readonly { type: string }[]): boolean {
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const call = item as unknown as { tool: string; argsJson?: string };
    if (call.tool !== "spawn_subtask") continue;
    if ((call.argsJson ?? "").includes('"skills"')) return true;
  }
  return false;
}

const hasFanOut = (items: readonly { type: string }[]): boolean =>
  items.some((i) => i.type === "subtask");

type Outcome =
  | "equipped_and_loaded"
  | "equipped_not_loaded"
  | "parent_did_not_equip"
  | "no_fan_out";

function classify(items: readonly { type: string }[]): Outcome {
  if (!hasFanOut(items)) return "no_fan_out";
  const reports = reportsOf(items);
  // By NAME, not merely "some skill" (D9). It cannot diverge with a one-skill
  // fixture — but R3 copies this classifier, and there the panel briefs
  // different seats with different skills, where "equipped with anything"
  // would silently pass a child handed the wrong one.
  const equipped = reports.filter((r) => r.skills?.includes(LEDGER_SKILL));
  if (equipped.length === 0) return "parent_did_not_equip";
  return equipped.some((r) => r.summary.includes(LEDGER_TOKEN))
    ? "equipped_and_loaded"
    : "equipped_not_loaded";
}

for (const provider of PROVIDERS) {
  describe.skipIf(!provider.ready())(
    `R1 live — a parent equips a child, the child loads and follows (${provider.label})`,
    () => {
      it("reaches equipped_and_loaded", async () => {
        const evidence = liveWorkDir();
        const skills = await fixtureSkills();

        const task = await runEvalTask({
          scenario: SPEC,
          paperDir: PAPER,
          grants: new Map(),
          stub: false,
          readOnly: true,
          skills,
          binding: liveBinding(provider.protocol, provider.model),
          ceilings: BUDGET,
        });
        evidence.track(task.workDir);

        const reports = reportsOf(task.outcome.items);
        const outcome = classify(task.outcome.items);
        const equipped = reports.filter((r) =>
          r.skills?.includes(LEDGER_SKILL),
        );
        const withToken = equipped.filter((r) =>
          r.summary.includes(LEDGER_TOKEN),
        );

        // Reported either way — the question is what models DO. Read the
        // statuses before believing `equipped_not_loaded`: a child that ran out
        // of budget reports the same way as one that ignored its skill.
        // Per-CHILD usage, because that is what the budget question is about:
        // the carve divides the parent's remaining output tokens across the
        // children, so a child that reported nothing may have been starved
        // rather than disobedient (A16).
        const usage = reports.map(
          (r) =>
            `${r.usage?.outputTokens ?? "?"}out${
              r.usage?.costUsd === undefined
                ? ""
                : `/$${r.usage.costUsd.toFixed(4)}`
            }`,
        );
        console.info(
          `[R1 live/${provider.label}] outcome=${outcome} children=${reports.length} equipped=${equipped.length} with-token=${withToken.length} ` +
            `spawn-args-carried-skills=${spawnedWithSkills(task.outcome.items)} ` +
            `statuses=${reports.map((r) => r.status).join(",") || "none"} ` +
            `child-usage=${usage.join(",") || "none"}` +
            `${task.outcome.error ? ` error=${task.outcome.error}` : ""}`,
        );

        expect(task.outcome.status).toBe("completed");
        // THE assertion: the body reached a child and was followed there.
        // KESTREL appears in no other file, so a fluent paraphrase of the goal
        // cannot produce it — which is the whole difference R1 exists to make.
        expect(outcome).toBe("equipped_and_loaded");

        await evidence.discard();
      });
    },
  );
}
