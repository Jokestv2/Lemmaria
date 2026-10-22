/**
 * E1, the two **live** rows of the milestone's tier table.
 *
 * ## Row 24 — does a model actually take the second hop?
 *
 * STRAT-1's finding was that a real third-party pack keeps **5.7× more
 * guidance in `references/` than in its `SKILL.md` bodies**, and that 18 of 19
 * bodies are routers. E1 makes that depth reachable — `load_skill { name }`
 * returns a manifest of names, `load_skill { name, reference }` returns one.
 * Every offline test in the milestone proves the mechanism *works*. None of
 * them can prove a model *uses* it, and that is the whole claim: the failure
 * the survey called the bad kind is a router with nothing behind it, where the
 * model answers from the router's own preamble as though it had loaded the
 * depth and neither the user nor the transcript can tell.
 *
 * So the fixture is a **router with a distinctive token behind it**. `SKILL.md`
 * says almost nothing and points at `references/numerals.md`; the reference
 * names the style **ORTHOLINE** and sets a threshold of **twelve**, and neither
 * string appears anywhere else in the fixture. A model that summarises the
 * router cannot produce them. That is what separates *loaded the depth* from
 * *sounded like it had*, and it is why a human reading one answer is the wrong
 * instrument ([ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md) §2).
 *
 * ## Row 25 — will a provider accept the synthetic `/skill:` exchange?
 *
 * E1 (ADR 0047) makes `/skill:<name>` a real `load_skill` exchange pushed into
 * the message list **before the first request**, so that very first call
 * carries an assistant tool-call message the model did not generate. E1.6
 * predicts this is fine, because `plainHistory` already synthesises exactly
 * this shape for every rebuilt tool call — but *predicts* is not *verified*,
 * and a provider rejecting it is one of the milestone plan's `BLOCKED`
 * triggers. Only a real provider answers it.
 *
 * **The tally is reported either way** (ADR 0038 §2, and T2's corpus rule): the
 * question is *what do models do*, so a pass/fail bit is not an answer to it.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Skill, listSkills } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_BUDGET,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/skill-references");
const PAPER = join(FIXTURE, "paper");

/** Appears ONLY in `references/numerals.md`, never in the router body. */
const DEPTH_TOKENS = ["ORTHOLINE", "twelve", "12"] as const;

const SPEC: EvalTaskSpec = {
  id: "live-skill-references",
  prompt:
    "What does the house style say about writing numbers? Name the style and give me its threshold for spelling a number out. Load whatever guidance you need first.",
  requiredGrants: [],
  tools: [],
};

/** The `/skill:` form — the same question, reached explicitly. */
const INVOCATION_SPEC: EvalTaskSpec = {
  ...SPEC,
  id: "live-skill-invocation",
  prompt: `/skill:house-numbers ${SPEC.prompt}`,
};

async function fixtureSkills(): Promise<Skill[]> {
  const { skills, diagnostics } = await listSkills({
    userDir: join(FIXTURE, "skills"),
  });
  // A broken fixture is indistinguishable from a real regression at the moment
  // you are trying to tell them apart, so it fails HERE rather than downstream.
  expect(diagnostics).toEqual([]);
  expect(skills.map((s) => s.name)).toEqual(["house-numbers"]);
  expect(skills[0]?.references).toEqual(["numerals.md"]);
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

/** Every tool call a run made, flattened for assertion. */
function callsOf(items: readonly { type: string }[]): {
  tool: string;
  args: Record<string, unknown>;
  resultJson: string;
}[] {
  const out: {
    tool: string;
    args: Record<string, unknown>;
    resultJson: string;
  }[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const call = item as unknown as {
      tool: string;
      argsJson: string;
      resultJson?: string;
    };
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.argsJson || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    out.push({ tool: call.tool, args, resultJson: call.resultJson ?? "" });
  }
  return out;
}

const said = (items: readonly { type: string }[]): string =>
  items
    .filter((i) => i.type === "agent_message")
    .map((i) => (i as unknown as { text: string }).text)
    .join("\n");

for (const provider of PROVIDERS) {
  describe.skipIf(!provider.ready())(
    `E1 live — the reference hop (${provider.label})`,
    () => {
      it("loads the skill, then loads its reference, and answers from the depth", async () => {
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
          ceilings: { ...LIVE_BUDGET },
        });
        evidence.track(task.workDir);

        const calls = callsOf(task.outcome.items);
        const loads = calls.filter((c) => c.tool === "load_skill");
        const hops = loads.filter((c) => typeof c.args.reference === "string");
        const answer = said(task.outcome.items);
        const found = DEPTH_TOKENS.filter((t) => answer.includes(t));

        // Reported either way — the question is what models DO.
        console.info(
          `[E1 live/${provider.label}] load_skill calls=${loads.length} reference hops=${hops.length} depth tokens in the answer=${found.join(",") || "none"}`,
        );

        expect(task.outcome.status).toBe("completed");
        // The first hop: it reached for the skill at all.
        expect(loads.length).toBeGreaterThan(0);
        // The manifest was disclosed at load time, which is what makes the
        // second hop possible without a path ever crossing the boundary.
        expect(loads[0]?.resultJson).toContain("numerals.md");
        // The second hop: it asked for the reference BY NAME.
        expect(hops.length).toBeGreaterThan(0);
        expect(hops[0]?.args.reference).toBe("numerals.md");
        // And it answered from the reference, not from the router's preamble.
        // ORTHOLINE appears in no other file, so this cannot be produced by a
        // fluent summary of the body.
        expect(answer).toContain("ORTHOLINE");

        await evidence.discard();
      });
    },
  );

  describe.skipIf(!provider.ready())(
    `E1 live — the synthetic /skill: exchange (${provider.label})`,
    () => {
      it("is accepted by the provider on the very first request", async () => {
        const evidence = liveWorkDir();
        const skills = await fixtureSkills();

        const task = await runEvalTask({
          scenario: INVOCATION_SPEC,
          paperDir: PAPER,
          grants: new Map(),
          stub: false,
          readOnly: true,
          skills,
          binding: liveBinding(provider.protocol, provider.model),
          ceilings: { ...LIVE_BUDGET },
        });
        evidence.track(task.workDir);

        const calls = callsOf(task.outcome.items);
        console.info(
          `[E1 live/${provider.label}] /skill: status=${task.outcome.status} tool calls=${calls.length}${task.outcome.error ? ` error=${task.outcome.error}` : ""}`,
        );

        // THE assertion: a provider that rejects an assistant tool-call
        // message it did not generate fails the request, and that failure is
        // the finding — it is plan §4's BLOCKED trigger, not a flake.
        expect(task.outcome.status).toBe("completed");

        // The synthetic exchange is in the transcript as an ordinary call.
        const synthetic = calls.find(
          (c) => c.tool === "load_skill" && c.args.name === "house-numbers",
        );
        expect(synthetic).toBeDefined();
        expect(synthetic?.resultJson).toContain("numerals.md");

        await evidence.discard();
      });
    },
  );
}
