import { describe, expect, it } from "vitest";
import type {
  SessionEvent,
  SessionItem,
  SessionTaskBudget,
  SubtaskItem,
  Usage,
} from "../../../src/contracts/index.js";
import type { Skill } from "../../../src/contracts/skills.js";
import type { ToolName } from "../../../src/contracts/tools.js";
import {
  MAX_SUBTASK_CHILDREN,
  SPAWN_SUBTASK_SPEC,
  createSpawnSubtaskTool,
} from "../../../src/session/loop-tools/subtask.js";

type Deps = Parameters<typeof createSpawnSubtaskTool>[0];

function bed(over: Partial<Deps> = {}) {
  const items: SessionItem[] = [];
  // Recorded, not discarded: a pre-flight rejection's guarantee is that NOTHING
  // happened, and `item.started` goes out through `emit` while only the
  // terminal item goes through `emitItem`. Asserting an empty `items` alone
  // would leave a refactor that moved validation below `emitProgress` green.
  const events: SessionEvent[] = [];
  const accrued: Usage[] = [];
  const base: Deps = {
    emit: async (e: SessionEvent) => void events.push(e),
    emitItem: async (i: SessionItem) => void items.push(i),
    parentAllowed: ["read_span", "grep_project"] as ToolName[],
    fanOutConcurrency: 2,
    carveCeiling: (): Partial<SessionTaskBudget> => ({}),
    accrue: (u: Usage) => void accrued.push(u),
    runChild: async (goal: string) => ({
      status: "completed" as const,
      items: [
        { id: "a1", type: "agent_message" as const, text: `did ${goal}` },
      ],
    }),
  };
  return {
    items,
    events,
    accrued,
    tool: createSpawnSubtaskTool({ ...base, ...over }),
  };
}

describe("createSpawnSubtaskTool (B1)", () => {
  it("declares itself SEQUENTIAL — invariant 5 has no categorical backstop", async () => {
    // The one tool where the declaration IS the guard. `spawn_subtask` is
    // `analysis`, so ADR 0025's mutation rule does not cover it, and its
    // budget carve reads the parent's REMAINING consumption at call time —
    // two overlapping carves would each see the same remainder and
    // over-allocate. Deleting the field would make that concurrent, silently.
    expect(bed().tool.executionMode).toBe("sequential");
    expect(bed().tool.category).toBe("analysis");
  });

  it("reports one summary per child, in request order", async () => {
    const { items, tool } = bed();
    const out = await tool.invoke({
      children: [{ goal: "survey a" }, { goal: "survey b" }],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual({
        reports: [
          { goal: "survey a", status: "completed", summary: "did survey a" },
          { goal: "survey b", status: "completed", summary: "did survey b" },
        ],
      });
    }
    const item = items.at(-1) as SubtaskItem;
    expect(item.type).toBe("subtask");
    expect(item.status).toBe("completed");
    expect(item.reports.map((r) => r.goal)).toEqual(["survey a", "survey b"]);
  });

  it("narrows a child to a subset of the parent's tools", async () => {
    const seen: ToolName[][] = [];
    const { tool } = bed({
      runChild: async (_goal, allowedTools) => {
        seen.push(allowedTools);
        return { status: "completed", items: [] };
      },
    });
    await tool.invoke({
      children: [{ goal: "g", allowed_tools: ["read_span", "run_script"] }],
    });
    // run_script is not in the parent's allowlist, so the child cannot have it.
    expect(seen).toEqual([["read_span"]]);
  });

  it(`rejects more than ${MAX_SUBTASK_CHILDREN} children with too_large and emits nothing`, async () => {
    const { items, events, accrued, tool } = bed();
    const children = Array.from(
      { length: MAX_SUBTASK_CHILDREN + 1 },
      (_, i) => ({ goal: `g${i}` }),
    );
    const out = await tool.invoke({ children });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("too_large");
      expect(out.error.message).toContain(String(MAX_SUBTASK_CHILDREN));
    }
    expect(items).toEqual([]);
    // The precedent R1's own pre-flight checks copy — pinned to the same
    // standard now that `bed` can see it.
    expect(events).toEqual([]);
    expect(accrued).toEqual([]);
  });

  it("rolls a child's usage up into the parent", async () => {
    const accrued: { inputTokens: number; outputTokens: number }[] = [];
    const { tool } = bed({
      accrue: (usage) => void accrued.push(usage),
      runChild: async () => ({
        status: "completed",
        items: [],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      }),
    });
    await tool.invoke({ children: [{ goal: "a" }, { goal: "b" }] });
    expect(accrued).toEqual([
      { inputTokens: 20, outputTokens: 10, costUsd: 0.02 },
    ]);
  });

  it("an already-aborted task reports every child interrupted and runs none", async () => {
    const controller = new AbortController();
    controller.abort();
    const { tool } = bed({
      signal: controller.signal,
      runChild: async () => {
        throw new Error("no child may start after an abort");
      },
    });
    const out = await tool.invoke({ children: [{ goal: "a" }] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        reports: [{ goal: "a", status: "interrupted" }],
      });
    }
  });

  it("a bad shape is a ToolError, never a throw", async () => {
    const { tool } = bed();
    const out = await tool.invoke({ children: [] });
    expect(out.ok).toBe(false);
  });

  it("advertises the allowlisted name and the analysis category", () => {
    const { tool } = bed();
    expect(tool.name).toBe("spawn_subtask");
    expect(tool.category).toBe("analysis");
  });
});

/**
 * R1 (ADR 0059) — the parent equips a child with a named subset of its own
 * skills. Everything here is decided in this module, because it is the only
 * one that knows both what the parent holds and what each child asked for.
 */
describe("createSpawnSubtaskTool skills (R1)", () => {
  const skill = (name: string): Skill => ({
    name,
    description: `${name} rules.`,
    body: `Follow ${name}.`,
    source: "project",
    path: `.lemmaria/skills/${name}/SKILL.md`,
    references: [],
  });
  /** Deliberately NOT alphabetical, so "catalogue order" is a real claim. */
  const CATALOGUE = [skill("ledger"), skill("abstracts"), skill("figures")];

  it("rejects a name the parent does not hold — before any child runs", async () => {
    const ran: string[] = [];
    const { items, events, accrued, tool } = bed({
      parentSkills: CATALOGUE,
      runChild: async (goal: string) => {
        ran.push(goal);
        return { status: "completed" as const, items: [] };
      },
    });
    const out = await tool.invoke({
      children: [{ goal: "a" }, { goal: "b", skills: ["ledger", "nope"] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("invalid");
      // Names the child and what IS available, so the parent can re-issue.
      expect(out.error.message).toContain("nope");
      expect(out.error.message).toContain("ledger");
    }
    // Deny-by-default and PRE-FLIGHT: the whole call is refused, exactly as
    // the MAX_SUBTASK_CHILDREN cap refuses it. A partially-run fan-out would be
    // the worse outcome, so all four halves of "nothing happened" are asserted
    // — including `item.started`, which rides `emit` and not `emitItem`.
    expect(ran).toEqual([]);
    expect(items).toEqual([]);
    expect(events).toEqual([]);
    expect(accrued).toEqual([]);
  });

  it("rejects skills when the parent's surface offers none", async () => {
    const ran: string[] = [];
    const { items, events, accrued, tool } = bed({
      runChild: async (goal: string) => {
        ran.push(goal);
        return { status: "completed" as const, items: [] };
      },
    });
    const out = await tool.invoke({
      children: [{ goal: "a", skills: ["ledger"] }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("invalid");
      expect(out.error.message).toMatch(/skills/);
    }
    expect(ran).toEqual([]);
    expect(items).toEqual([]);
    expect(events).toEqual([]);
    expect(accrued).toEqual([]);
  });

  it("resolves to Skill objects in the PARENT's catalogue order", async () => {
    const seen: string[][] = [];
    const { tool } = bed({
      parentSkills: CATALOGUE,
      runChild: async (
        _goal: string,
        _allowed: ToolName[],
        _ceilings: Partial<SessionTaskBudget>,
        skills: Skill[],
      ) => {
        seen.push(skills.map((s) => s.name));
        return { status: "completed" as const, items: [] };
      },
    });
    await tool.invoke({
      children: [
        // Requested in the opposite order to the catalogue's, on purpose.
        { goal: "a", skills: ["figures", "ledger"] },
        { goal: "b" },
      ],
    });
    // A filter over the parent's set, not a map over the request — so a
    // child's block order is stable however the model happened to list them.
    expect(seen).toEqual([["ledger", "figures"], []]);
  });

  it("records what each child was equipped with, and nothing when it was not", async () => {
    const { items, tool } = bed({
      parentSkills: CATALOGUE,
      runChild: async () => ({ status: "completed" as const, items: [] }),
    });
    const out = await tool.invoke({
      children: [{ goal: "a", skills: ["figures", "ledger"] }, { goal: "b" }],
    });
    const item = items.at(-1) as SubtaskItem;
    const [equipped, plain] = item.reports;

    // Catalogue order again, and `load_skill` named because the child's own
    // surface really does hold it — a report that understated the child's
    // allowlist is the A3 review's defect.
    expect(equipped?.skills).toEqual(["ledger", "figures"]);
    expect(equipped?.allowedTools).toContain("load_skill");

    // The unequipped sibling is byte-identical to pre-R1: NO `skills` key at
    // all (not an empty array), and today's allowlist.
    expect(plain && "skills" in plain).toBe(false);
    expect(plain?.allowedTools).toEqual(["read_span", "grep_project"]);

    // The model-facing report-back is unchanged — the parent already knows
    // what it asked for.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual({
        reports: [
          { goal: "a", status: "completed", summary: expect.any(String) },
          { goal: "b", status: "completed", summary: expect.any(String) },
        ],
      });
    }
  });

  it("an explicitly EMPTY skills list equips nothing and records nothing", async () => {
    const seen: string[][] = [];
    const { items, tool } = bed({
      parentSkills: CATALOGUE,
      runChild: async (
        _goal: string,
        _allowed: ToolName[],
        _ceilings: Partial<SessionTaskBudget>,
        skills: Skill[],
      ) => {
        seen.push(skills.map((s) => s.name));
        return { status: "completed" as const, items: [] };
      },
    });
    await tool.invoke({ children: [{ goal: "a", skills: [] }] });
    expect(seen).toEqual([[]]);
    const report = (items.at(-1) as SubtaskItem).reports[0];
    expect(report && "skills" in report).toBe(false);
    expect(report?.allowedTools).not.toContain("load_skill");
  });

  it("an empty skills list is accepted even by a SKILL-FREE parent", async () => {
    // D1 and D2 can be read to disagree here: D1 says "absent, or `[]`, means
    // unequipped", D2 says "`skills` given when the parent offers none →
    // invalid". The implementation takes D1 — `[]` is not `skills` *given* —
    // and this pins that reading, so it cannot flip on a later reading of the
    // plan. The rejection is for a parent asked to hand down a name it lacks.
    const { items, tool } = bed({ parentSkills: [] });
    const out = await tool.invoke({ children: [{ goal: "a", skills: [] }] });
    expect(out.ok).toBe(true);
    const report = (items.at(-1) as SubtaskItem).reports[0];
    expect(report && "skills" in report).toBe(false);
  });

  it("the spec is byte-identical to SPAWN_SUBTASK_SPEC when the parent has no skills", () => {
    // The prompt's standing rule, applied to the tool spec: never advertise
    // what the surface withheld. Every skill-free session — which is every
    // session written before R1 — sees exactly what it saw before.
    expect(bed().tool.spec).toEqual(SPAWN_SUBTASK_SPEC);
  });

  it("the spec gains the skills property and clause when the parent has skills", () => {
    const { tool } = bed({ parentSkills: CATALOGUE });
    const params = tool.spec.parameters as {
      properties: {
        children: { items: { properties: Record<string, unknown> } };
      };
    };
    expect(params.properties.children.items.properties).toHaveProperty(
      "skills",
    );
    // The argument shape the model is told to send. Asserted literally
    // because it is produced by a `.replace()` over the skill-free
    // description: if that base string is ever reworded, the replace would
    // silently no-op and the model would be told about `skills` while still
    // being shown a two-field shape. This is the assertion that catches it.
    expect(tool.spec.description).toContain(
      "{ goal, allowed_tools?, skills? }",
    );
    expect(tool.spec.description).not.toContain("as { goal, allowed_tools? }");
    // The finding S5 measured, stated to the model that made it.
    expect(tool.spec.description).toMatch(/paraphrase/i);
    // …and the unchanged half is genuinely unchanged.
    expect(tool.spec.name).toBe(SPAWN_SUBTASK_SPEC.name);
  });
});
