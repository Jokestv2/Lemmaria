import { describe, expect, it } from "vitest";
import type {
  ChildModel,
  ModelAdapter,
  ModelBinding,
} from "../../../src/contracts/adapters.js";
import type { SessionTaskBudget } from "../../../src/contracts/index.js";
import type { Skill } from "../../../src/contracts/skills.js";
import type { ToolName } from "../../../src/contracts/tools.js";
import {
  type FanOutChild,
  type FanOutDeps,
  runFanOut,
} from "../../../src/session/loop-tools/fan-out.js";

/**
 * R9 (ADR 0069 §D3): the fan-out core carries a child's OWN model.
 *
 * A NEW file rather than an edit to `loop-tools/subtask.test.ts`, deliberately:
 * that suite is the pin that says the tool path is byte-identical (ADR 0061
 * §3), and a pin you edit to make a change pass has stopped being one.
 *
 * The seam is asserted here at `runFanOut`; that a child's `ChildModel`
 * actually reaches a DIFFERENT adapter end-to-end is `review-panel-driver`'s
 * (O4), where a real second recording adapter can see the requests.
 */

const model = (id: string): ChildModel => ({
  adapter: { protocol: "anthropic" } as unknown as ModelAdapter,
  binding: {
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model: id,
    apiKey: "k",
  } as ModelBinding,
});

/** A `runChild` that records every positional argument it was handed. */
function recorder() {
  const calls: Array<{ goal: string; model: ChildModel | undefined }> = [];
  const runChild: FanOutDeps["runChild"] = async (
    goal: string,
    _allowedTools: ToolName[],
    _ceilings: Partial<SessionTaskBudget>,
    _skills: Skill[],
    _finalAnswerCheck?: (text: string) => string | undefined,
    childModel?: ChildModel,
  ) => {
    calls.push({ goal, model: childModel });
    return { status: "completed" as const, items: [] };
  };
  return { calls, runChild };
}

async function fanOut(children: readonly FanOutChild[]) {
  const { calls, runChild } = recorder();
  await runFanOut(
    {
      fanOutConcurrency: 1,
      carveCeiling: () => ({ maxOutputTokens: 1000 }),
      accrue: () => {},
      runChild,
    },
    children,
    { onStarted: async () => {}, onChildSettled: async () => {} },
  );
  return calls;
}

const child = (goal: string, over: Partial<FanOutChild> = {}): FanOutChild => ({
  goal,
  allowedTools: ["read_span"] as ToolName[],
  skills: [],
  ...over,
});

describe("runFanOut carries a child's own model (O4)", () => {
  it("hands the child's ChildModel to runChild as its sixth argument", async () => {
    const haiku = model("claude-haiku-4-5-20251001");
    const calls = await fanOut([child("a", { model: haiku })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(haiku);
  });

  it("hands NOTHING when the child named no model — it inherits the parent's", async () => {
    // The absence is what keeps a `spawn_subtask` child's options object
    // byte-identical to pre-R9: `parseSpawnSubtaskArgs` produces no model, so
    // the sixth argument is never set on that path.
    const calls = await fanOut([child("a")]);
    expect(calls[0]?.model).toBeUndefined();
  });

  it("keeps each child's model with its own goal, in request order", async () => {
    const luna = model("gpt-5.6-luna");
    const haiku = model("claude-haiku-4-5-20251001");
    const calls = await fanOut([
      child("first", { model: luna }),
      child("second", { model: haiku }),
      child("third"),
    ]);
    expect(calls.map((c) => [c.goal, c.model?.binding.model])).toEqual([
      ["first", "gpt-5.6-luna"],
      ["second", "claude-haiku-4-5-20251001"],
      ["third", undefined],
    ]);
  });

  it("lets two children share ONE model object", async () => {
    // Two reviewers on one model is the operator's own brief for R9; nothing
    // in the fan-out may de-duplicate them.
    const shared = model("gpt-5.6-luna");
    const calls = await fanOut([
      child("first", { model: shared }),
      child("second", { model: shared }),
    ]);
    expect(calls[0]?.model).toBe(shared);
    expect(calls[1]?.model).toBe(shared);
  });
});

describe("runFanOut carries a child's own executors (V4, ADR 0081 §6, O12)", () => {
  it("hands the child's tools to runChild as its seventh argument, and only that child's", async () => {
    const seen: Array<{
      goal: string;
      tools?: ReadonlyMap<ToolName, unknown>;
    }> = [];
    const runChild: FanOutDeps["runChild"] = async (
      goal,
      _allowed,
      _ceilings,
      _skills,
      _check,
      _model,
      childTools,
    ) => {
      seen.push({ goal, ...(childTools ? { tools: childTools } : {}) });
      return { status: "completed" as const, items: [] };
    };
    const tools = new Map([
      [
        "view_pdf_pages" as ToolName,
        {
          spec: { name: "view_pdf_pages" },
          invoke: async () => ({ ok: true, value: {} }),
        } as never,
      ],
    ]);
    await runFanOut(
      {
        fanOutConcurrency: 2,
        carveCeiling: () => ({ maxOutputTokens: 1000 }),
        accrue: () => {},
        runChild,
      },
      [child("reviewer"), child("pdf", { tools })],
      { onStarted: async () => {}, onChildSettled: async () => {} },
    );
    const byGoal = new Map(seen.map((s) => [s.goal, s.tools]));
    expect(byGoal.get("pdf")).toBe(tools);
    expect(byGoal.get("reviewer")).toBeUndefined();
  });
});

describe("runFanOut widens one child's slice by its allowance (ADR 0082 §1, O30)", () => {
  it("adds the allowance to that child's turns and calls, and its sibling keeps the slice", async () => {
    const seen = new Map<string, Partial<SessionTaskBudget>>();
    const runChild: FanOutDeps["runChild"] = async (
      goal,
      _allowed,
      ceilings,
    ) => {
      seen.set(goal, ceilings);
      return { status: "completed" as const, items: [] };
    };
    await runFanOut(
      {
        fanOutConcurrency: 2,
        carveCeiling: () => ({
          maxTurns: 12,
          maxToolCalls: 24,
          maxOutputTokens: 4000,
        }),
        accrue: () => {},
        runChild,
      },
      [
        child("reviewer"),
        child("pdf", { allowance: { turns: 9, toolCalls: 9 } }),
      ],
      { onStarted: async () => {}, onChildSettled: async () => {} },
    );
    // Output tokens are never widened: they stay carved, the cost guard.
    expect(seen.get("pdf")).toEqual({
      maxTurns: 21,
      maxToolCalls: 33,
      maxOutputTokens: 4000,
    });
    expect(seen.get("reviewer")).toEqual({
      maxTurns: 12,
      maxToolCalls: 24,
      maxOutputTokens: 4000,
    });
  });

  it("widens from the default when the slice leaves a field to it", async () => {
    const seen: Array<Partial<SessionTaskBudget>> = [];
    const runChild: FanOutDeps["runChild"] = async (_g, _a, ceilings) => {
      seen.push(ceilings);
      return { status: "completed" as const, items: [] };
    };
    await runFanOut(
      {
        fanOutConcurrency: 1,
        carveCeiling: () => ({ maxOutputTokens: 1000 }),
        accrue: () => {},
        runChild,
      },
      [child("pdf", { allowance: { turns: 2, toolCalls: 3 } })],
      { onStarted: async () => {}, onChildSettled: async () => {} },
    );
    expect(seen).toEqual([
      { maxTurns: 14, maxToolCalls: 27, maxOutputTokens: 1000 },
    ]);
  });
});
