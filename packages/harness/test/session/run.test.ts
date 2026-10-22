import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  EditDecision,
  EditProposalItem,
  GenerateRequest,
  GrantedRoot,
  ModelAdapter,
  ModelBinding,
  ScriptApproval,
  ScriptRunItem,
  ScriptRunResult,
  SessionEditHost,
  SessionEditPolicy,
  SessionEntry,
  SessionEvent,
  SessionScriptHost,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import type { Skill } from "../../src/contracts/skills.js";
import type { ToolName } from "../../src/contracts/tools.js";
import { canonicalizeGrantRoot } from "../../src/engine/grants.js";
import {
  type ToolExecutor,
  buildToolRegistry,
} from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
  scriptedByKey,
} from "../../src/model/scripted.js";
import { TURN_MAX_TOKENS } from "../../src/session/budget.js";
import {
  SUMMARY_PREFIX,
  buildConversationHistory,
} from "../../src/session/compaction.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";
import {
  cleanupSessionHarnesses,
  createSessionHarness,
} from "../support/session-harness.js";

const temps: string[] = [];
async function mkStore(): Promise<SessionStore> {
  const d = await mkdtemp(join(tmpdir(), "lemmaria-session-run-"));
  temps.push(d);
  return new SessionStore(join(d, "sessions"));
}
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
  await cleanupSessionHarnesses();
});

// A6: a REAL, verified model id (ADR 0023). These suites assert loop
// behaviour, so the binding must not also trip the `model.unverified` notice —
// the unverified path has its own dedicated tests below.
const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};

/** A minimal read-tool registry (the engine-test stubbing discipline). */
function fakeRegistry(
  onInvoke?: (name: ToolName, args: unknown) => void,
): Map<ToolName, ToolExecutor> {
  const registry = new Map<ToolName, ToolExecutor>();
  registry.set("read_span", {
    name: "read_span",
    category: "retrieval",
    spec: {
      name: "read_span",
      description: "read a section",
      parameters: { type: "object" },
    },
    invoke: async (args) => {
      onInvoke?.("read_span", args);
      return ok({
        content: `content of ${(args as { section?: string }).section ?? "?"}`,
      });
    },
  });
  return registry;
}

/**
 * The events of a loaded session's own branch (ADR 0027). These suites all
 * drive a session that is never rewound, so its branch IS its file, and every
 * assertion below reads exactly what it read before the tree.
 */
function eventsOf(loaded: {
  entries: readonly SessionEntry[];
}): SessionEvent[] {
  // `entries`, not `branch`: "no partial item was persisted" is a claim about
  // the FILE, and a branch-scoped read would let a partial hide off-branch.
  return loaded.entries.map((e) => e.event);
}

/** Persisted records may only carry completed items and turn/task events. */
function assertNoPartials(events: SessionEvent[]): void {
  for (const e of events) {
    expect(e.type === "item.started" || e.type === "item.updated").toBe(false);
  }
}

describe("runSessionTask", () => {
  it("streams a single-turn chat: deltas live, only completed items persisted", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "hi", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "Hello!" }]);
    const seen: SessionEvent[] = [];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
      onEvent: (e) => seen.push(e),
    });
    expect(result.status).toBe("completed");
    // Live stream: the agent message streamed as deltas before completing.
    expect(
      seen.some(
        (e) => e.type === "item.updated" && e.item.type === "agent_message",
      ),
    ).toBe(true);
    expect(seen[0]?.type).toBe("task.started");
    expect(seen.at(-1)).toEqual({
      type: "task.completed",
      status: "completed",
    });
    expect(result.items.map((i) => i.type)).toEqual([
      "user_message",
      "agent_message",
    ]);
    // Persisted stream: no partials, and it replays to the same transcript.
    const loaded = await store.load(session.id);
    assertNoPartials(eventsOf(loaded));
    expect(loaded.items).toEqual(result.items);
    expect(result.usage).toBeDefined();
  });

  it("sends the system prompt and prior conversation as history on task 2", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "first", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { text: "first reply" },
      { text: "second reply" },
    ]);
    await runSessionTask({ store, session, model, binding, text: "first" });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "second",
    });
    expect(result.status).toBe("completed");
    const req = model.requests[1];
    expect(req).toBeDefined();
    const roles = (req?.messages ?? []).map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    const loaded = await store.load(session.id);
    const turns = eventsOf(loaded).filter((e) => e.type === "turn.started");
    expect(turns.map((e) => (e.type === "turn.started" ? e.turn : 0))).toEqual([
      1, 2,
    ]);
  });

  it("a store failure mid-task still terminates the stream with task.completed and reports failed (P1)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "p1", workspace: "/w" });
    let appends = 0;
    const broken = new (class extends SessionStore {
      override async append(
        ...args: Parameters<SessionStore["append"]>
      ): Promise<void> {
        appends += 1;
        if (appends > 2) throw new Error("disk full");
        return super.append(...args);
      }
    })(store.rootDir);
    const seen: SessionEvent[] = [];
    const result = await runSessionTask({
      store: broken,
      session,
      model: new ScriptedModelAdapter([{ text: "ok" }]),
      binding,
      text: "hi",
      onEvent: (e) => seen.push(e),
    });
    // The stream is complete despite the broken store: an honest error item
    // about lost persistence, and the terminal task event always arrives.
    expect(
      seen.some((e) => e.type === "item.completed" && e.item.type === "error"),
    ).toBe(true);
    expect(seen.at(-1)).toEqual({ type: "task.completed", status: "failed" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/disk full/);
  });

  it("model stream failure + broken store still delivers turn.failed and task.completed (P1)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "p1b", workspace: "/w" });
    const broken = new (class extends SessionStore {
      override async append(): Promise<void> {
        throw new Error("disk full");
      }
    })(store.rootDir);
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: async () => {
        throw new Error("api down");
      },
      // biome-ignore lint/correctness/useYield: scripted immediate failure
      generateStream: async function* () {
        throw new Error("api down");
      },
    };
    const seen: SessionEvent[] = [];
    const result = await runSessionTask({
      store: broken,
      session,
      model,
      binding,
      text: "hi",
      onEvent: (e) => seen.push(e),
    });
    expect(seen.some((e) => e.type === "turn.failed")).toBe(true);
    expect(seen.at(-1)).toEqual({ type: "task.completed", status: "failed" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("api down");
  });

  it("a non-transient model failure yields an error item + turn.failed, never a throw, no retry", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "boom", workspace: "/w" });
    let calls = 0;
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: async () => {
        throw new Error("api down");
      },
      // biome-ignore lint/correctness/useYield: scripted immediate failure
      generateStream: async function* () {
        calls += 1;
        throw Object.assign(new Error("api down"), { status: 400 });
      },
    };
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("api down");
    expect(calls).toBe(1);
    expect(result.items.map((i) => i.type)).toEqual(["user_message", "error"]);
    const loaded = await store.load(session.id);
    expect(
      eventsOf(loaded).some(
        (e) => e.type === "turn.failed" && e.error === "api down",
      ),
    ).toBe(true);
  });

  it("an adapter without generateStream fails honestly with an error item", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "old", workspace: "/w" });
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: async () => {
        throw new Error("unreachable");
      },
    };
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
    });
    expect(result.status).toBe("failed");
    expect(result.items.at(-1)?.type).toBe("error");
    expect(result.error).toMatch(/stream/i);
  });

  it("runs a 2-turn read-tool task: tool executed, result fed back, transcript well-formed", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "tools", workspace: "/w" });
    const invoked: unknown[] = [];
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "c1", name: "read_span", args: { section: "Intro" } },
        ],
      },
      { text: "The intro says hello." },
    ]);
    const seen: SessionEvent[] = [];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "what does the intro say?",
      registry: fakeRegistry((_n, args) => invoked.push(args)),
      onEvent: (e) => seen.push(e),
    });
    expect(result.status).toBe("completed");
    expect(invoked).toEqual([{ section: "Intro" }]);
    // The tool_call item streamed in_progress and completed with the result.
    const started = seen.find(
      (e) => e.type === "item.started" && e.item.type === "tool_call",
    );
    expect(started).toBeDefined();
    const completedCall = result.items.find((i) => i.type === "tool_call");
    expect(completedCall).toMatchObject({
      tool: "read_span",
      status: "completed",
    });
    if (completedCall?.type === "tool_call") {
      expect(completedCall.resultJson).toContain("content of Intro");
    }
    // The tool result reached the model on turn 2.
    const secondTurn = model.requests[1]?.messages ?? [];
    expect(secondTurn.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    // Final message + summed usage.
    expect(result.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "The intro says hello.",
    });
    expect(result.usage?.inputTokens).toBe(20);
    // Only completed items persist.
    const loaded = await store.load(session.id);
    assertNoPartials(eventsOf(loaded));
    expect(loaded.items).toEqual(result.items);
  });

  it("update_plan produces a todo_list item and a success result", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "plan", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "p1",
            name: "update_plan",
            args: {
              items: [
                { text: "read the intro", completed: true },
                { text: "summarize" },
              ],
            },
          },
        ],
      },
      { text: "Done." },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "plan then do",
      registry: fakeRegistry(),
    });
    expect(result.status).toBe("completed");
    const todo = result.items.find((i) => i.type === "todo_list");
    expect(todo).toMatchObject({
      items: [
        { text: "read the intro", completed: true },
        { text: "summarize", completed: false },
      ],
    });
    const toolResult = model.requests[1]?.messages.at(-1);
    expect(toolResult?.content).toBe('{"updated":true}');
  });

  it("refuses a tool outside the allowlist with an error result and continues", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "refuse", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "x1", name: "grep_project", args: { query: "q" } }],
      },
      { text: "Understood." },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "grep something",
      registry: fakeRegistry(),
    });
    expect(result.status).toBe("completed");
    const call = result.items.find((i) => i.type === "tool_call");
    expect(call).toMatchObject({ status: "failed" });
    const fed = model.requests[1]?.messages.at(-1)?.content ?? "";
    expect(fed).toContain("not permitted");
    expect(result.items.at(-1)).toMatchObject({ type: "agent_message" });
  });

  // ── ADR 0024: every tool failure carries a branchable code ──────────────
  describe("tool failure codes (ADR 0024)", () => {
    /** Run one tool call, then a plain answer, and hand back that call's row. */
    async function callOnce(
      registry: Map<ToolName, ToolExecutor>,
      call: { id: string; name: ToolName; args: unknown },
      allowedTools?: ToolName[],
    ) {
      const store = await mkStore();
      const session = await store.create({ title: "codes", workspace: "/w" });
      const model = new ScriptedModelAdapter([
        { toolCalls: [call] },
        { text: "Understood." },
      ]);
      const result = await runSessionTask({
        store,
        session,
        model,
        binding,
        text: "go",
        registry,
        ...(allowedTools ? { allowedTools } : {}),
      });
      const row = result.items.find((i) => i.type === "tool_call");
      if (row?.type !== "tool_call")
        throw new Error("expected a tool_call row");
      return {
        result,
        row,
        error: JSON.parse(row.resultJson ?? "{}").error as {
          code: string;
          message: string;
        },
      };
    }

    it("a tool outside the session allowlist fails as `denied`; the task continues", async () => {
      const { result, row, error } = await callOnce(
        fakeRegistry(),
        { id: "x1", name: "grep_project", args: { query: "q" } },
        ["read_span"],
      );
      expect(row.status).toBe("failed");
      expect(error).toEqual({
        code: "denied",
        message: 'tool "grep_project" is not permitted in this session',
      });
      expect(result.status).toBe("completed");
    });

    it("a tool the build does not have fails as `unavailable`", async () => {
      const { row, error } = await callOnce(
        fakeRegistry(),
        { id: "x1", name: "verify", args: {} },
        ["read_span", "verify"],
      );
      expect(row.status).toBe("failed");
      expect(error).toEqual({
        code: "unavailable",
        message: 'tool "verify" is not available',
      });
    });

    it("malformed update_plan args fail as `invalid`, with no todo item", async () => {
      const store = await mkStore();
      const session = await store.create({
        title: "bad plan",
        workspace: "/w",
      });
      const model = new ScriptedModelAdapter([
        { toolCalls: [{ id: "p1", name: "update_plan", args: { items: [] } }] },
        { text: "ok" },
      ]);
      const result = await runSessionTask({
        store,
        session,
        model,
        binding,
        text: "plan",
        registry: fakeRegistry(),
      });
      const row = result.items.find((i) => i.type === "tool_call");
      if (row?.type !== "tool_call")
        throw new Error("expected a tool_call row");
      expect(JSON.parse(row.resultJson ?? "{}").error.code).toBe("invalid");
      expect(result.items.some((i) => i.type === "todo_list")).toBe(false);
    });

    it("an over-wide fan-out fails as `too_large` and spawns nothing", async () => {
      const children = Array.from({ length: 17 }, (_, i) => ({
        goal: `child ${i}`,
      }));
      const { row, error } = await callOnce(fakeRegistry(), {
        id: "s1",
        name: "spawn_subtask",
        args: { children },
      });
      expect(row.status).toBe("failed");
      expect(error.code).toBe("too_large");
      expect(error.message).toMatch(/at most 16/);
    });

    it("a tool that throws anyway is reported `unavailable`; the loop survives", async () => {
      // The contract says tools do not throw (ADR 0024). One that does is a
      // defect — it must not kill a session the user is mid-way through.
      const registry = fakeRegistry();
      registry.set("read_span", {
        name: "read_span",
        category: "retrieval",
        spec: {
          name: "read_span",
          description: "read a section",
          parameters: { type: "object" },
        },
        invoke: async () => {
          throw new Error("contract violation");
        },
      });
      const { result, row, error } = await callOnce(registry, {
        id: "r1",
        name: "read_span",
        args: { section: "Intro" },
      });
      expect(row.status).toBe("failed");
      expect(error).toEqual({
        code: "unavailable",
        message: "contract violation",
      });
      expect(result.status).toBe("completed");
    });
  });

  it("stops with an honest notice when the turn budget is exhausted", async () => {
    // Endless tool_use — the loop must stop after maxTurns model calls.
    const h = await createSessionHarness({
      title: "turns",
      turns: [
        {
          toolCalls: [{ id: "t1", name: "read_span", args: { section: "A" } }],
        },
        {
          toolCalls: [{ id: "t2", name: "read_span", args: { section: "B" } }],
        },
        {
          toolCalls: [{ id: "t3", name: "read_span", args: { section: "C" } }],
        },
      ],
      registry: fakeRegistry(),
    });
    const result = await h.run({
      text: "loop forever",
      budget: { maxTurns: 2 },
    });
    expect(result.status).toBe("completed");
    expect(h.model.requests).toHaveLength(2);
    const notice = result.items.find((i) => i.type === "notice");
    expect(notice).toMatchObject({ code: "budget.turns" });
  });

  it("stops before executing a batch that would exceed the tool-call budget", async () => {
    const invoked: unknown[] = [];
    const h = await createSessionHarness({
      title: "calls",
      turns: [
        {
          toolCalls: [
            { id: "a", name: "read_span", args: { section: "A" } },
            { id: "b", name: "read_span", args: { section: "B" } },
          ],
        },
      ],
      registry: fakeRegistry((_n, args) => invoked.push(args)),
    });
    const result = await h.run({
      text: "read two",
      budget: { maxToolCalls: 1 },
    });
    expect(result.status).toBe("completed");
    expect(invoked).toHaveLength(0);
    const notice = result.items.find((i) => i.type === "notice");
    expect(notice).toMatchObject({ code: "budget.tool_calls" });
  });

  it("stops with an honest notice when the output-token budget is exhausted", async () => {
    const h = await createSessionHarness({
      title: "out",
      turns: [
        {
          toolCalls: [{ id: "o1", name: "read_span", args: { section: "A" } }],
          usage: { outputTokens: 5 },
        },
      ],
      registry: fakeRegistry(),
    });
    const result = await h.run({ text: "go", budget: { maxOutputTokens: 4 } });
    expect(result.status).toBe("completed");
    expect(h.model.requests).toHaveLength(1);
    const notice = result.items.find((i) => i.type === "notice");
    expect(notice).toMatchObject({ code: "budget.output_tokens" });
  });

  it("makes NO model call when the output budget is zero (review: no forced 1-token turn)", async () => {
    const h = await createSessionHarness({
      title: "zero",
      turns: [{ text: "should never run" }],
    });
    const result = await h.run({
      text: "go",
      budget: { maxOutputTokens: 0 }, // a fully-carved child slice looks like this
    });
    expect(h.model.requests).toHaveLength(0);
    expect(result.status).toBe("completed");
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "budget.output_tokens",
      ),
    ).toBe(true);
  });

  it("interrupts cleanly mid-tool-JSON: partial turn discarded, transcript well-formed (S4)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "stop", workspace: "/w" });
    const ctrl = new AbortController();
    const model = new ScriptedModelAdapter([
      {
        text: "Let me read that section.",
        toolCalls: [
          { id: "k1", name: "read_span", args: { section: "Methods" } },
        ],
      },
      { text: "never reached" },
    ]);
    const seen: SessionEvent[] = [];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read it",
      registry: fakeRegistry(),
      signal: ctrl.signal,
      onEvent: (e) => {
        seen.push(e);
        // Abort the moment the tool call starts streaming its JSON.
        if (e.type === "item.started" && e.item.type === "tool_call") {
          ctrl.abort();
        }
      },
    });
    expect(result.status).toBe("interrupted");
    expect(seen.at(-1)).toEqual({
      type: "task.completed",
      status: "interrupted",
    });
    // The partial turn is discarded: no tool_call, no agent_message persisted.
    const loaded = await store.load(session.id);
    assertNoPartials(eventsOf(loaded));
    expect(loaded.items.map((i) => i.type)).toEqual([
      "user_message",
      "interrupted",
    ]);
    // A follow-up task carries a history without any trace of the partial turn.
    const model2 = new ScriptedModelAdapter([{ text: "recovered" }]);
    await runSessionTask({
      store,
      session,
      model: model2,
      binding,
      text: "continue",
    });
    const roles = (model2.requests[0]?.messages ?? []).map((m) => m.role);
    expect(roles).toEqual(["system", "user", "user"]);
  });

  it("steering queued mid-task joins the next turn boundary as a user message", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "steer", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "s1", name: "read_span", args: { section: "Intro" } },
        ],
      },
      { text: "Focused on section B as asked." },
    ]);
    const queue = ["focus on section B only"];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "summarize the paper",
      registry: fakeRegistry(),
      takeSteering: () => queue.shift(),
    });
    expect(result.status).toBe("completed");
    // The steering text is an ordinary user message in the transcript…
    const userTexts = result.items
      .filter((i) => i.type === "user_message")
      .map((i) => (i.type === "user_message" ? i.text : ""));
    expect(userTexts).toEqual([
      "summarize the paper",
      "focus on section B only",
    ]);
    // …and reaches the model at the turn boundary, after the tool result.
    const turn2 = model.requests[1]?.messages ?? [];
    expect(turn2.at(-1)).toEqual({
      role: "user",
      content: "focus on section B only",
    });
    expect(turn2.at(-2)).toMatchObject({ role: "tool", toolCallId: "s1" });
  });

  it("retries once on a transient stream failure with an honest notice, then succeeds", async () => {
    const h = await createSessionHarness({
      title: "retry",
      turns: [
        { text: "made it", failure: { message: "conn reset", status: 503 } },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    // Two stream requests on unchanged history.
    expect(h.model.requests).toHaveLength(2);
    expect(h.model.requests[0]?.messages).toEqual(
      h.model.requests[1]?.messages,
    );
    const notice = result.items.find((i) => i.type === "notice");
    // B2 (ADR 0026): the notice now names the delay it is about to wait, and
    // the delay is the DEFAULT policy's first step — this is the one test that
    // proves `run.ts` wires the real defaults, not a test-only policy.
    expect(notice).toMatchObject({ code: "stream.retried" });
    expect(h.slept).toHaveLength(1);
    expect(h.slept[0]).toBeGreaterThanOrEqual(750);
    expect(h.slept[0]).toBeLessThanOrEqual(1000);
    expect(result.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "made it",
    });
  });

  it("keeps retrying while the policy allows, then stops honestly (B2)", async () => {
    // Before B2 the SECOND consecutive failure was terminal (one immediate
    // retry, no backoff). The policy's default is two retries, so the same
    // script now recovers — which is the milestone's point.
    const h = await createSessionHarness({
      title: "retry2",
      turns: [
        {
          text: "made it on the third",
          failure: { message: "conn reset", status: 503, times: 2 },
        },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    expect(h.model.requests).toHaveLength(3);
    // Exponential: the second wait is twice the first (jitter aside).
    expect(h.slept).toHaveLength(2);
    expect(h.slept[1]).toBeGreaterThan(h.slept[0] ?? 0);
    expect(
      result.items.filter(
        (i) => i.type === "notice" && i.code === "stream.retried",
      ),
    ).toHaveLength(2);
  });

  it("gives up when the retry budget is spent, naming the attempts (B2)", async () => {
    const h = await createSessionHarness({
      title: "retry-exhausted",
      turns: [
        {
          text: "never",
          failure: { message: "conn reset", status: 503, times: 9 },
        },
      ],
    });
    const seen = h.events;
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("conn reset");
    // Three attempts: the first, plus the policy's two retries.
    expect(h.model.requests).toHaveLength(3);
    expect(seen.some((e) => e.type === "turn.failed")).toBe(true);
    expect(seen.at(-1)).toEqual({ type: "task.completed", status: "failed" });
    const notices = result.items.filter((i) => i.type === "notice");
    expect(notices.map((n) => n.type === "notice" && n.code)).toEqual([
      "stream.retried",
      "stream.retried",
      "stream.retry_failed",
    ]);
    // The count the user reads is attempts made, including the first.
    expect(notices.at(-1)).toMatchObject({ n: 3 });
  });

  it("fails a quota refusal FAST — one request, no backoff, its own notice (B2)", async () => {
    // The class the survey identified: quota exhaustion arrives as a 429 and
    // looks exactly like a throttle, so it used to burn the whole budget and
    // then report a sentence the user could not act on.
    const h = await createSessionHarness({
      title: "quota",
      turns: [
        {
          text: "never",
          failure: {
            message: "You exceeded your current quota: insufficient_quota",
            status: 429,
            times: 9,
          },
        },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("failed");
    expect(h.model.requests).toHaveLength(1);
    expect(h.slept).toEqual([]);
    const notices = result.items.filter((i) => i.type === "notice");
    expect(notices.map((n) => n.type === "notice" && n.code)).toEqual([
      "provider.quota",
    ]);
    // The provider's own sentence still reaches the transcript as detail.
    expect(result.items.some((i) => i.type === "error")).toBe(true);
  });

  it("a subagent child inherits the parent's retry policy (B2)", async () => {
    // The survey said children "have no retry at all". Their TURNS always did
    // — what they could not do is inherit a configured policy, because
    // `run.ts` enumerates a child's options and would drop a new one.
    const h = await createSessionHarness({
      title: "child-retry",
      registry: fakeRegistry(),
      turns: [
        // Parent: fan out one child.
        {
          toolCalls: [
            {
              id: "s1",
              name: "spawn_subtask",
              args: { children: [{ goal: "survey the intro" }] },
            },
          ],
        },
        // Child turn 1: a transient failure, then the same turn re-served.
        {
          text: "the intro is short",
          failure: { message: "socket hang up", times: 1 },
        },
        // Parent's closing turn.
        { text: "done" },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    // The child retried rather than reporting failed.
    const subtask = result.items.find((i) => i.type === "subtask");
    expect(subtask).toMatchObject({
      reports: [{ status: "completed", summary: "the intro is short" }],
    });
    expect(h.slept).toHaveLength(1);
  });

  it("a max_tokens-truncated turn names the PER-TURN cap, not the task budget (A6)", async () => {
    // A1a review #3 made this path emit a notice at all; A6 makes the notice
    // TRUE. It used to emit `budget.output_tokens`, whose message reads "Task
    // stopped: output-token budget (16000) reached" — naming a limit that had
    // not been reached, since the real cause is the per-request TURN_MAX_TOKENS
    // cap and the task had spent a fraction of its budget.
    const h = await createSessionHarness({
      title: "trunc",
      turns: [{ text: "cut off mid-sent", stopReason: "max_tokens" }],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).toContain("turn.truncated");
    expect(codes).not.toContain("budget.output_tokens");
    expect(result.items.some((i) => i.type === "agent_message")).toBe(true);
  });

  it("an interrupt during the retry backoff ends the task, end to end (B2)", async () => {
    // ADR 0026 decision 6: ◼ Stop must not be dead for the length of a delay.
    // The harness builder's sleep always completes, so this one wires
    // `runSessionTask` directly with a sleep that aborts mid-wait.
    const store = await mkStore();
    const session = await store.create({ title: "abort", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { text: "never", failure: { message: "socket hang up", times: 9 } },
    ]);
    const controller = new AbortController();
    const events: SessionEvent[] = [];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "go",
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        return false;
      },
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("interrupted");
    expect(result.items.some((i) => i.type === "interrupted")).toBe(true);
    // Not a failure: the user stopped it, and blaming the provider would be
    // dishonest. Exactly one attempt was made before the aborted wait.
    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    expect(model.requests).toHaveLength(1);
  });

  it("a truncated turn WITH tool calls recovers instead of ending the task (B2)", async () => {
    // Before B2 this ended the task and the model's half-written call was
    // discarded silently. Now every call in the truncated message is failed
    // back with "re-issue", and the loop takes another turn.
    const h = await createSessionHarness({
      title: "trunc-recover",
      registry: fakeRegistry(),
      turns: [
        {
          text: "let me read that",
          toolCalls: [{ id: "c1", name: "read_span", args: { section: "In" } }],
          stopReason: "max_tokens",
        },
        { text: "done, in smaller steps" },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).toContain("turn.truncated_recovered");
    expect(codes).not.toContain("turn.truncated");
    // The tool row is present and FAILED, coded so the model knows to re-issue.
    const row = result.items.find((i) => i.type === "tool_call");
    expect(row).toMatchObject({ tool: "read_span", status: "failed" });
    expect(
      JSON.parse((row as { resultJson: string }).resultJson),
    ).toMatchObject({ error: { code: "invalid" } });
    // A second turn really happened, on a history the provider would accept:
    // the truncated assistant message and one tool result for its call.
    expect(h.model.requests).toHaveLength(2);
    const sent = h.model.requests[1]?.messages ?? [];
    expect(sent.at(-2)).toMatchObject({ role: "assistant" });
    expect(sent.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(result.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "done, in smaller steps",
    });
  });

  it("fails EVERY call in a truncated message, not just the last (B2)", async () => {
    // A salvage-parsed argument buffer can leave earlier calls looking
    // complete; they are still part of a request the model never finished.
    const invoked: ToolName[] = [];
    const h = await createSessionHarness({
      title: "trunc-all",
      registry: fakeRegistry((n) => invoked.push(n)),
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read_span", args: { section: "One" } },
            { id: "c2", name: "read_span", args: { section: "Two" } },
          ],
          stopReason: "max_tokens",
        },
        { text: "ok" },
      ],
    });
    const result = await h.run({ text: "go" });
    expect(invoked).toEqual([]);
    const rows = result.items.filter((i) => i.type === "tool_call");
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.type === "tool_call" && r.status === "failed"),
    ).toBe(true);
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "turn.truncated_recovered",
    );
    expect(notice).toMatchObject({ n: 2 });
  });

  it("a truncated turn that ALSO spends the budget reports both facts (B2 review)", async () => {
    // The likely case, not an exotic one: TURN_MAX_TOKENS is 8192 against a
    // 16 000-token default task budget, so a truncated second turn lands on
    // the output-budget check by arithmetic. Reporting only the budget would
    // leave the discarded tool calls unexplained — the exact A6 failure mode
    // `turn.truncated` was written to end. Truncation is named FIRST, because
    // it happened first.
    const h = await createSessionHarness({
      title: "trunc-and-spent",
      registry: fakeRegistry(),
      turns: [
        {
          toolCalls: [{ id: "c1", name: "read_span", args: {} }],
          stopReason: "max_tokens",
          usage: { inputTokens: 1, outputTokens: 50 },
        },
        { text: "unreached" },
      ],
    });
    const result = await h.run({ text: "go", budget: { maxOutputTokens: 10 } });
    expect(result.status).toBe("completed");
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).toEqual(["turn.truncated", "budget.output_tokens"]);
    // The task really ended — no second turn, no recovery it could not afford.
    expect(h.model.requests).toHaveLength(1);
  });

  it("does NOT charge a truncated turn's calls against the tool-call budget (B2)", async () => {
    // Invariant 5: budgets count what was spent, never what was refused.
    const h = await createSessionHarness({
      title: "trunc-budget",
      registry: fakeRegistry(),
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "read_span", args: {} },
            { id: "c2", name: "read_span", args: {} },
          ],
          stopReason: "max_tokens",
        },
        { toolCalls: [{ id: "c3", name: "read_span", args: {} }] },
        { text: "done" },
      ],
    });
    // A budget of 1 would be blown by the truncated pair if they were charged;
    // the real call on the next turn must still be allowed through.
    const result = await h.run({ text: "go", budget: { maxToolCalls: 1 } });
    expect(result.status).toBe("completed");
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).not.toContain("budget.tool_calls");
    const completed = result.items.filter(
      (i) => i.type === "tool_call" && i.status === "completed",
    );
    expect(completed).toHaveLength(1);
  });

  it("still reports budget.output_tokens when the TASK budget really is spent (A6)", async () => {
    // The regression guard for the change above: the two situations are
    // genuinely different and must keep genuinely different messages.
    // A tool-calling turn: the post-turn budget check only runs when the loop
    // is about to CONTINUE (a text-only turn ends the task before it).
    const h = await createSessionHarness({
      title: "spent",
      turns: [
        {
          toolCalls: [{ id: "c1", name: "read_span", args: {} }],
          usage: { inputTokens: 1, outputTokens: 50 },
        },
        { text: "two", usage: { inputTokens: 1, outputTokens: 50 } },
      ],
      registry: fakeRegistry(),
    });
    const result = await h.run({ text: "go", budget: { maxOutputTokens: 10 } });
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).toContain("budget.output_tokens");
    expect(codes).not.toContain("turn.truncated");
  });

  it("asks the model for min(TURN_MAX_TOKENS, remaining task budget) (A6)", async () => {
    const h = await createSessionHarness({
      title: "cap",
      turns: [{ text: "hi" }],
    });
    await h.run({
      text: "go",
      // Far above the per-request cap, so the per-request cap is what binds.
      budget: { maxOutputTokens: 1_000_000 },
    });
    expect(h.model.requests[0]?.maxTokens).toBe(TURN_MAX_TOKENS);

    // ...and when the task has less left than the cap, the remainder binds.
    const h2 = await createSessionHarness({
      title: "cap2",
      turns: [{ text: "hi" }],
    });
    await h2.run({ text: "go", budget: { maxOutputTokens: 100 } });
    expect(h2.model.requests[0]?.maxTokens).toBe(100);
  });

  it("a throwing onEvent sink never propagates out of the loop (review #5)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "sink", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "still fine" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "go",
      onEvent: () => {
        throw new Error("disposed webview");
      },
    });
    expect(result.status).toBe("completed");
    expect(result.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "still fine",
    });
  });

  it("compacts mid-task when a turn's measured usage crosses the context limit (review #9; A2 upgraded the A1a stop)", async () => {
    // claude-* window 200k, threshold 180k: turn 1 measures 190k and wants
    // more tools — pre-A2 the loop stopped here; A2 compacts and continues.
    // (The honest stop is still pinned: see the compaction-failure and
    // still-full-window cases in the A2 suite below.)
    const h = await createSessionHarness({
      title: "ctx2",
      turns: [
        {
          toolCalls: [{ id: "c1", name: "read_span", args: { section: "A" } }],
          usage: { inputTokens: 190_000, outputTokens: 100 },
        },
        { text: "HANDOFF" },
        { text: "sent after compaction", usage: { inputTokens: 400 } },
      ],
      registry: fakeRegistry(),
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("completed");
    expect(result.items.some((i) => i.type === "compaction")).toBe(true);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
  });

  it("malformed update_plan args produce an error tool result, no todo item (review #9)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "badplan", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "p1", name: "update_plan", args: { items: [] } }] },
      { text: "understood" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "plan badly",
      registry: fakeRegistry(),
    });
    expect(result.status).toBe("completed");
    expect(result.items.some((i) => i.type === "todo_list")).toBe(false);
    const call = result.items.find((i) => i.type === "tool_call");
    expect(call).toMatchObject({ status: "failed" });
    const fed = model.requests[1]?.messages.at(-1)?.content ?? "";
    expect(fed).toContain("update_plan");
  });

  it("compacts on a provider that reports no usage, off the estimate (ADR 0051)", async () => {
    // An unknown model gets the 128k default window, so the threshold is
    // 115,200 estimated tokens; CJK bills one token per character.
    const h = await createSessionHarness({
      title: "silent provider",
      model: "local-llama",
      turns: [{ text: "HANDOFF" }, { text: "answered on the fresh window" }],
    });
    await h.store.append(h.session.id, { type: "turn.started", turn: 1 });
    await h.store.append(h.session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "望".repeat(120_000) },
    });
    // The turn completed, but the provider reported NOTHING — which reaches us
    // as zeros rather than as absent usage, and so used to pass the truthiness
    // guard and be compared as a real measurement of zero.
    await h.store.append(h.session.id, {
      type: "turn.completed",
      turn: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const result = await h.run({ text: "one more thing" });
    expect(result.status).toBe("completed");
    expect(result.items.some((i) => i.type === "compaction")).toBe(true);
  });

  it("compacts before the first turn when the session already sits at the context limit (A2 upgraded the A1a stop)", async () => {
    const h = await createSessionHarness({
      title: "full",
      turns: [{ text: "HANDOFF" }, { text: "answered on the fresh window" }],
    });
    // claude-* window = 200k; 0.9 threshold = 180k. A prior turn measured 185k.
    await h.store.append(h.session.id, { type: "turn.started", turn: 1 });
    await h.store.append(h.session.id, {
      type: "turn.completed",
      turn: 1,
      usage: { inputTokens: 185_000, outputTokens: 500 },
    });
    const result = await h.run({ text: "one more thing" });
    expect(result.status).toBe("completed");
    expect(result.items.some((i) => i.type === "compaction")).toBe(true);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
    // The user's message is still recorded (the transcript is honest).
    expect(result.items.some((i) => i.type === "user_message")).toBe(true);
    // The summarization call is PERSISTED on the item, not merely accrued into
    // the task total: `total` dies with the task, so a cost surface folding the
    // stream (sumSessionUsage — every one of them does) reported an automatic
    // compaction as free. It is often the most expensive call in the session.
    const checkpoint = result.items.find((i) => i.type === "compaction");
    expect(checkpoint?.type === "compaction" && checkpoint.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("a rewind rescues a context-limited session (round-2 review)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "full", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "a small first ask" },
    });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u1", type: "user_message", text: "the huge turn" },
    });
    await store.append(session.id, { type: "turn.started", turn: 1 });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: { inputTokens: 185_000, outputTokens: 500 },
    });
    // The user rewinds away the turn that filled the window. The history the
    // child sends is short, so refusing to run would strand them forever.
    // ADR 0027 made this work by reading occupancy from the BRANCH rather than
    // the whole log; ADR 0057 makes it work because the huge turn is in a
    // different FILE, which is why nothing here scopes anything any more.
    const child = await store.fork(session.id, { cutBeforeItemId: "u1" });
    const model = new ScriptedModelAdapter([{ text: "plenty of room now" }]);
    const result = await runSessionTask({
      store,
      session: child,
      model,
      binding,
      text: "smaller ask",
    });
    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(1);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
    // ...and the rescue cost nothing: the huge turn is still on record, in the
    // session the user left (ADR 0057 — ADR 0018 deleted it, ADR 0027 kept it
    // as a sibling branch).
    const after = await store.load(session.id);
    expect(after.entries.some((e) => e.event.type === "turn.completed")).toBe(
      true,
    );
  });
});

/** In-memory SessionEditHost double for the write-path tests (ADR 0016). */
function fakeEditHost(
  files: Record<string, string>,
  opts: {
    policy?: SessionEditPolicy | (() => SessionEditPolicy);
    decide?: (
      item: EditProposalItem,
    ) => EditDecision[] | undefined | Promise<EditDecision[] | undefined>;
  } = {},
) {
  const calls = {
    requestDecisions: [] as EditProposalItem[],
    writes: [] as [string, string][],
    order: [] as string[],
  };
  const host: SessionEditHost = {
    policy: () =>
      typeof opts.policy === "function"
        ? opts.policy()
        : (opts.policy ?? "review"),
    readFile: async (f) => files[f],
    writeFile: async (f, c) => {
      calls.order.push(`write:${f}`);
      calls.writes.push([f, c]);
      files[f] = c;
    },
    fileExists: async (f) => files[f] !== undefined,
    requestDecisions: async (item) => {
      calls.requestDecisions.push(item);
      return opts.decide ? opts.decide(item) : undefined;
    },
  };
  return { host, files, calls };
}

function proposeCall(
  id: string,
  edits: Record<string, unknown>[],
): { id: string; name: ToolName; args: unknown } {
  return { id, name: "propose_edit", args: { edits } };
}

async function proposalRecords(store: SessionStore, sessionId: string) {
  const loaded = await store.load(sessionId);
  return eventsOf(loaded).flatMap((e) =>
    e.type === "item.completed" && e.item.type === "edit_proposal"
      ? [e.item]
      : [],
  );
}

describe("runSessionTask propose_edit (A1b)", () => {
  it("B2 invariant 3: a TRUNCATED propose_edit writes nothing, under auto_apply", async () => {
    // The milestone's headline hazard. B2 makes a `max_tokens` turn continue
    // instead of ending the task, so the calls it carried now reach the point
    // where they would have been executed. A half-written anchor under the
    // auto-apply policy — the policy with no human in the loop — must not
    // reach the user's file, and the recovery is what guarantees it: EVERY
    // call in a truncated message is failed, with no per-tool carve-out.
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
          ]),
        ],
        stopReason: "max_tokens",
      },
      { text: "re-issued in smaller steps" },
    ]);
    const { host, files, calls } = fakeEditHost(
      { "main.tex": "teh wrold" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix typos",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    // Untouched — and no proposal was ever recorded, applied or pending.
    expect(files["main.tex"]).toBe("teh wrold");
    expect(calls.requestDecisions).toHaveLength(0);
    expect(await proposalRecords(store, session.id)).toHaveLength(0);
    expect(result.items.some((i) => i.type === "edit_proposal")).toBe(false);
    expect(result.items.some((i) => i.type === "changed_files")).toBe(false);
    // The model was told why, and got another turn to re-issue.
    const row = result.items.find((i) => i.type === "tool_call");
    expect(row).toMatchObject({ tool: "propose_edit", status: "failed" });
    expect(String((row as { resultJson: string }).resultJson)).toContain(
      "Re-issue the call",
    );
    expect(model.requests).toHaveLength(2);
  });

  it("review: a two-edit batch pauses, Accept-both applies with revalidation, terminal statuses persist", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
            { file: "main.tex", anchor: "wrold", replacement: "world" },
          ]),
        ],
      },
      { text: "fixed both" },
    ]);
    const { host, files, calls } = fakeEditHost(
      { "main.tex": "teh wrold" },
      { decide: () => [{ accept: true }, { accept: true }] },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix typos",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(files["main.tex"]).toBe("the world");
    expect(calls.requestDecisions).toHaveLength(1);
    expect(calls.requestDecisions[0]?.edits.map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);
    // Persisted twice: the pause record (pending) then the terminal record.
    const records = await proposalRecords(store, session.id);
    expect(records).toHaveLength(2);
    expect(records[0]?.edits.map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(records[1]?.edits.map((e) => e.status)).toEqual([
      "applied",
      "applied",
    ]);
    // Replay upserts to the terminal record.
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits.map((e) => e.status)).toEqual(["applied", "applied"]);
    // The model received the decision array as the tool result.
    const toolMsg = model.requests[1]?.messages.at(-1);
    expect(toolMsg?.role).toBe("tool");
    const parsed = JSON.parse(String(toolMsg?.content)) as {
      decisions: { file: string; status: string }[];
    };
    expect(parsed.decisions.map((d) => d.status)).toEqual([
      "applied",
      "applied",
    ]);
  });

  it("review: Reject-with-note leaves the file alone and returns the note as steering", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
            { file: "main.tex", anchor: "wrold", replacement: "world" },
          ]),
        ],
      },
      { text: "ok" },
    ]);
    const { host, files } = fakeEditHost(
      { "main.tex": "teh wrold" },
      {
        decide: () => [
          { accept: true },
          { accept: false, note: "keep the original spelling" },
        ],
      },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(files["main.tex"]).toBe("the wrold");
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits.map((e) => e.status)).toEqual([
      "applied",
      "rejected",
    ]);
    expect(proposal.edits[1]?.note).toBe("keep the original spelling");
    const toolMsg = model.requests[1]?.messages.at(-1);
    expect(String(toolMsg?.content)).toContain("keep the original spelling");
  });

  it("auto_apply: applies immediately, no pause, and emits the per-turn changed_files summary", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
            { file: "main.tex", anchor: "wrold", replacement: "world" },
          ]),
        ],
      },
      { text: "done" },
    ]);
    const { host, files, calls } = fakeEditHost(
      { "main.tex": "teh wrold" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(calls.requestDecisions).toHaveLength(0);
    expect(files["main.tex"]).toBe("the world");
    // One terminal record only — no pause record under auto_apply.
    expect(await proposalRecords(store, session.id)).toHaveLength(1);
    const summary = result.items.find((i) => i.type === "changed_files");
    if (summary?.type !== "changed_files") throw new Error("no changed_files");
    expect(summary.files).toEqual([
      { file: "main.tex", edits: 2, created: false },
    ]);
  });

  // D2 / X2's task T6. ADR 0033 §2 withdrew D1's anchor carve-out BECAUSE a
  // declared removal would be "legible in the proposal row" — and under
  // auto_apply there is no proposal row, only this summary. A deliberate
  // removal of a comment, formula or citation reached disk unannounced.
  it("auto_apply: the changed_files summary names what the model declared it removed", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor: "teh % TODO: cite",
              replacement: "the",
              removes_protected: ["% TODO: cite"],
            },
            {
              file: "main.tex",
              anchor: "wrold",
              replacement: "world",
              removes_protected: ["% TODO: cite"],
            },
          ]),
        ],
      },
      { text: "done" },
    ]);
    const { host } = fakeEditHost(
      { "main.tex": "teh % TODO: cite wrold" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    const summary = result.items.find((i) => i.type === "changed_files");
    if (summary?.type !== "changed_files") throw new Error("no changed_files");
    // Deduped: two edits declaring the same span is one thing removed, and a
    // summary that said it twice would misreport the damage.
    expect(summary.files).toEqual([
      {
        file: "main.tex",
        edits: 2,
        created: false,
        removesProtected: ["% TODO: cite"],
      },
    ]);
  });

  it("auto_apply: a batch that declares nothing carries no removesProtected key at all", async () => {
    // The contract's absent-not-empty discipline — `parseProposeEditArgs`
    // already drops an empty array rather than storing one.
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
          ]),
        ],
      },
      { text: "done" },
    ]);
    const { host } = fakeEditHost(
      { "main.tex": "teh wrold" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    const summary = result.items.find((i) => i.type === "changed_files");
    if (summary?.type !== "changed_files") throw new Error("no changed_files");
    expect(summary.files[0]).not.toHaveProperty("removesProtected");
  });

  it("an edit whose file mutated between proposal and Accept turns stale; nothing is written", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
          ]),
        ],
      },
      { text: "ok" },
    ]);
    const shared: Record<string, string> = { "main.tex": "teh word" };
    const { host, files, calls } = fakeEditHost(shared, {
      decide: () => {
        shared["main.tex"] = "the user rewrote everything meanwhile";
        return [{ accept: true }];
      },
    });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(files["main.tex"]).toBe("the user rewrote everything meanwhile");
    expect(calls.writes).toHaveLength(0);
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits[0]?.status).toBe("stale");
    const toolMsg = model.requests[1]?.messages.at(-1);
    expect(String(toolMsg?.content)).toContain("stale");
  });

  it("create round-trips under auto_apply; create over an existing file is invalid and writes nothing", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "figs/new.tex", create: true, content: "\\input{plot}" },
            { file: "exists.tex", create: true, content: "clobber" },
          ]),
        ],
      },
      { text: "done" },
    ]);
    const { host, files } = fakeEditHost(
      { "exists.tex": "precious" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "add a figure",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(files["figs/new.tex"]).toBe("\\input{plot}");
    expect(files["exists.tex"]).toBe("precious");
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits.map((e) => e.status)).toEqual(["applied", "invalid"]);
    expect(proposal.edits[1]?.note).toMatch(/exists/i);
    const summary = result.items.find((i) => i.type === "changed_files");
    if (summary?.type !== "changed_files") throw new Error("no changed_files");
    expect(summary.files).toEqual([
      { file: "figs/new.tex", edits: 1, created: true },
    ]);
  });

  it("proposal-time anchor defects are invalid, and an all-invalid batch never pauses", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "gone", replacement: "x" },
            { file: "main.tex", anchor: "dup", replacement: "y" },
          ]),
        ],
      },
      { text: "I will re-read" },
    ]);
    const { host, calls } = fakeEditHost({ "main.tex": "dup and dup" });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
    });
    expect(result.status).toBe("completed");
    expect(calls.requestDecisions).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits.map((e) => e.status)).toEqual(["invalid", "invalid"]);
    expect(proposal.edits[0]?.note).toMatch(/not found/i);
    expect(proposal.edits[1]?.note).toMatch(/ambiguous|once/i);
  });

  it("interrupt mid-pause: pending statuses persist as stale, task ends interrupted, nothing written", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "teh", replacement: "the" },
          ]),
        ],
      },
      { text: "never reached" },
    ]);
    const ctrl = new AbortController();
    const { host, files, calls } = fakeEditHost(
      { "main.tex": "teh word" },
      { decide: () => new Promise(() => {}) }, // a wedged host never resolves
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "fix",
      editHost: host,
      signal: ctrl.signal,
      onEvent: (e) => {
        // Stop the moment the pause record lands (the user hits ◼ while reviewing).
        if (
          e.type === "item.completed" &&
          e.item.type === "edit_proposal" &&
          e.item.edits.some((edit) => edit.status === "pending")
        ) {
          ctrl.abort();
        }
      },
    });
    expect(result.status).toBe("interrupted");
    expect(calls.writes).toHaveLength(0);
    expect(files["main.tex"]).toBe("teh word");
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits[0]?.status).toBe("stale");
    expect(result.items.at(-1)?.type).toBe("interrupted");
    // And the persisted stream replays to the same honest transcript.
    const loaded = await store.load(session.id);
    expect(loaded.items).toEqual(result.items);
  });

  it("a mid-pause process death replays the pending proposal as stale (store round-trip)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "p1",
        type: "edit_proposal",
        policy: "review",
        edits: [
          {
            file: "a.tex",
            kind: "replace",
            anchor: "x",
            replacement: "y",
            status: "pending",
          },
        ],
      },
    });
    const loaded = await store.load(session.id);
    const proposal = loaded.items.find((i) => i.type === "edit_proposal");
    if (proposal?.type !== "edit_proposal") throw new Error("no proposal item");
    expect(proposal.edits[0]?.status).toBe("stale");
  });

  it("without an editHost, propose_edit is neither advertised nor permitted", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: "a", replacement: "b" },
          ]),
        ],
      },
      { text: "understood" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "edit something",
      registry: fakeRegistry(),
    });
    expect(result.status).toBe("completed");
    const advertised = (model.requests[0]?.tools ?? []).map((t) => t.name);
    expect(advertised).not.toContain("propose_edit");
    const call = result.items.find((i) => i.type === "tool_call");
    expect(call).toMatchObject({ status: "failed" });
    expect(result.items.some((i) => i.type === "edit_proposal")).toBe(false);
  });

  it("advertises the create-a-file rule on the tool spec itself (finding 3)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "ok" }]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
      registry: fakeRegistry(),
      editHost: fakeEditHost({ "main.tex": "body" }).host,
    });
    const spec = (model.requests[0]?.tools ?? []).find(
      (t) => t.name === "propose_edit",
    );
    // The spec travels with every request even when the envelope prompt is
    // truncated or summarized away, so the rule lives in both places.
    expect(spec?.description.toLowerCase()).toMatch(/script|non-prose/);
    expect(spec?.description.toLowerCase()).toMatch(/create/);
  });

  it("propose_edit calls count toward the tool-call budget (no partial batch)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "w", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [{ file: "a.tex", anchor: "x", replacement: "y" }]),
          proposeCall("c2", [{ file: "a.tex", anchor: "y", replacement: "z" }]),
        ],
      },
      { text: "never reached" },
    ]);
    const { host, calls } = fakeEditHost(
      { "a.tex": "x" },
      { policy: "auto_apply" },
    );
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "go",
      editHost: host,
      budget: { maxToolCalls: 1 },
    });
    expect(result.status).toBe("completed");
    expect(calls.writes).toHaveLength(0);
    const notice = result.items.find(
      (i) => i.type === "notice" && i.code === "budget.tool_calls",
    );
    expect(notice).toBeDefined();
  });
});

describe("runSessionTask granted reads end-to-end (A4, ADR 0019)", () => {
  /** A real temp "codebase" + a real grant-aware registry. */
  function codebaseFixture(grants: () => GrantedRoot[]) {
    const dir = mkdtempSync(join(tmpdir(), "lemmaria-flagship-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "train.py"),
      "def load(path):\n    return read_results(path)\n",
    );
    const grant: GrantedRoot = {
      id: "g1",
      path: canonicalizeGrantRoot(dir),
      label: "codebase",
    };
    const registry = buildToolRegistry({
      tools: ["list_files", "read_span", "grep_project"],
      adapter: {
        countWords: () => ({ language: "en", unit: "words", count: 0 }),
      },
      glossary: [],
      outline: [],
      workspace: { readFile: async () => "", listFiles: async () => [] },
      defaultFile: "main.tex",
      grants,
    });
    return { grant, registry };
  }

  /** The tool-result message a scripted turn fed back to the model. */
  function toolResult(model: ScriptedModelAdapter, request: number): string {
    const msgs = model.requests[request]?.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === "tool");
    return last?.content ?? "";
  }

  it("flagship-shaped: lists + reads a granted codebase, then drafts prose via propose_edit", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "methods", workspace: "/w" });
    const live: GrantedRoot[] = [];
    const { grant, registry } = codebaseFixture(() => live);
    live.push(grant);
    const draft =
      "The training pipeline loads results via \\texttt{load()} in src/train.py.";
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "list_files", args: { root: "g1" } }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "read_span",
            args: {
              root: "g1",
              file: "src/train.py",
              start_line: 1,
              end_line: 2,
            },
          },
        ],
      },
      {
        toolCalls: [
          proposeCall("c3", [
            { file: "methods-draft.tex", create: true, content: draft },
          ]),
        ],
      },
      { text: "Drafted methods from the granted codebase." },
    ]);
    const { host, files } = fakeEditHost({}, { policy: "auto_apply" });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "draft the methods section from my codebase",
      registry,
      editHost: host,
      grants: () => live,
    });
    expect(result.status).toBe("completed");
    // The listing the model saw named the real file…
    expect(toolResult(model, 1)).toContain("src/train.py");
    // …the read fed back the real content…
    expect(toolResult(model, 2)).toContain("def load(path):");
    // …and the draft landed through the normal write path.
    expect(files["methods-draft.tex"]).toBe(draft);
    const toolItems = result.items.filter((i) => i.type === "tool_call");
    expect(toolItems).toHaveLength(3);
    expect(toolItems.every((i) => i.status === "completed")).toBe(true);
  });

  it("mid-task revocation: the next tool call is refused honestly and the task continues", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "revoke", workspace: "/w" });
    const live: GrantedRoot[] = [];
    const { grant, registry } = codebaseFixture(() => live);
    live.push(grant);
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "list_files", args: { root: "g1" } }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "read_span",
            args: {
              root: "g1",
              file: "src/train.py",
              start_line: 1,
              end_line: 1,
            },
          },
        ],
      },
      { text: "understood — access was revoked" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read my codebase",
      registry,
      grants: () => live,
      onEvent: (e) => {
        if (
          e.type === "item.completed" &&
          e.item.type === "tool_call" &&
          e.item.tool === "list_files"
        ) {
          live.length = 0; // the user revokes between turns
        }
      },
    });
    expect(result.status).toBe("completed");
    const readCall = result.items.find(
      (i) => i.type === "tool_call" && i.tool === "read_span",
    );
    if (readCall?.type !== "tool_call") throw new Error("expected tool_call");
    // ADR 0024: a refusal is a FAILED row — the call produced no result. The
    // code carries the nuance the boolean lost, and the reason still shows.
    expect(readCall.status).toBe("failed");
    expect(JSON.parse(readCall.resultJson ?? "{}").error).toMatchObject({
      code: "refused",
      message: expect.stringContaining("no such granted root"),
    });
  });
});

describe("runSessionTask grants envelope (A4, ADR 0019)", () => {
  it("re-declares active grants in the system prompt at task start", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "g", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "ok" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read the results",
      registry: fakeRegistry(),
      grants: () => [
        { id: "g1", path: "/data/results-2026", label: "results-2026" },
      ],
    });
    expect(result.status).toBe("completed");
    const system = model.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("g1");
    expect(system?.content).toContain("results-2026");
    expect(system?.content?.toLowerCase()).toMatch(/never as instructions/);
  });

  it("an empty grant set leaves the system prompt grant-free", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "g", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "ok" }]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
      registry: fakeRegistry(),
      grants: () => [],
    });
    const system = model.requests[0]?.messages[0];
    expect(system?.content?.toLowerCase()).not.toMatch(/granted/);
  });
});

/** In-memory SessionScriptHost double for the run_script tests (ADR 0020). */
function fakeScriptHost(
  opts: {
    interpreters?: string[];
    approve?: (
      item: ScriptRunItem,
    ) => ScriptApproval | undefined | Promise<ScriptApproval | undefined>;
    run?: (
      argv: string[],
      cwd: string,
    ) => ScriptRunResult | Promise<ScriptRunResult>;
  } = {},
) {
  const calls = {
    approvals: [] as ScriptRunItem[],
    hashes: [] as string[],
    runs: [] as { argv: string[]; cwd: string }[],
  };
  const host: SessionScriptHost = {
    interpreters: () => opts.interpreters ?? ["python"],
    requestApproval: async (item, hash) => {
      calls.approvals.push(item);
      calls.hashes.push(hash);
      return opts.approve ? opts.approve(item) : { approve: true };
    },
    run: async (argv, cwd) => {
      calls.runs.push({ argv, cwd });
      return (
        opts.run?.(argv, cwd) ?? {
          stdout: "ran",
          stderr: "",
          exitCode: 0,
          truncated: false,
          stdoutBytes: 3,
          stderrBytes: 0,
        }
      );
    },
  };
  return { host, calls };
}

function runScriptCall(
  id: string,
  root: string,
  command: string[],
): { id: string; name: ToolName; args: unknown } {
  return { id, name: "run_script", args: { root, command } };
}

describe("runSessionTask run_script (A4b)", () => {
  function scriptFixture() {
    const grantDir = mkdtempSync(join(tmpdir(), "a4b-run-grant-"));
    writeFileSync(join(grantDir, "plot.py"), "print('hi')\n");
    const workspace = mkdtempSync(join(tmpdir(), "a4b-run-ws-"));
    const grant: GrantedRoot = {
      id: "g1",
      path: canonicalizeGrantRoot(grantDir),
      label: "results",
    };
    return { grant, workspace };
  }

  it("approves, runs, and feeds captured output back as the tool result", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "done" },
    ]);
    const { host, calls } = fakeScriptHost({
      run: () => ({
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        truncated: false,
        stdoutBytes: 3,
        stderrBytes: 0,
      }),
    });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run the plot",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    expect(result.status).toBe("completed");
    expect(calls.approvals.length).toBe(1);
    expect(calls.runs[0]?.cwd).toBe(grant.path);
    expect(calls.runs[0]?.argv[1]).toBe(join(grant.path, "plot.py"));
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("hi");
    const runItem = result.items.find((i) => i.type === "script_run");
    expect(runItem?.type === "script_run" && runItem.status).toBe("completed");
  });

  it("denial returns the user's note as steering, runs nothing", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "ok, skipping" },
    ]);
    const { host, calls } = fakeScriptHost({
      approve: () => ({ approve: false, note: "not now" }),
    });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    expect(calls.runs.length).toBe(0);
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("not now");
    const runItem = result.items.find((i) => i.type === "script_run");
    expect(runItem?.type === "script_run" && runItem.status).toBe("denied");
  });

  it("refuses a non-allowlisted interpreter WITHOUT asking for approval", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["bash", "plot.py"])] },
      { text: "noted" },
    ]);
    const { host, calls } = fakeScriptHost({ interpreters: ["python"] });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    expect(calls.approvals.length).toBe(0);
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toMatch(/interpreter/i);
    expect(result.status).toBe("completed");
  });

  it("refuses an unknown/revoked grant as data", async () => {
    const { workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "gX", ["python", "plot.py"])] },
      { text: "noted" },
    ]);
    const { host } = fakeScriptHost();
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [],
      scriptHost: host,
    });
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toMatch(/granted|revoked/i);
    expect(result.status).toBe("completed");
  });

  it("interrupt during a wedged approval ends the task interrupted, runs nothing", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "unreached" },
    ]);
    const ctrl = new AbortController();
    const { host, calls } = fakeScriptHost({
      approve: () => new Promise(() => {}),
    });
    const p = runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 50);
    const result = await p;
    expect(result.status).toBe("interrupted");
    expect(calls.runs.length).toBe(0);
  });

  it("run_script is not offered when the interpreter allowlist is empty", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([{ text: "hi" }]);
    const { host } = fakeScriptHost({ interpreters: [] });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hi",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    const tools = model.requests[0]?.tools ?? [];
    expect(tools.some((t) => t.name === "run_script")).toBe(false);
  });

  it("run_script counts toward the tool-call budget", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { toolCalls: [runScriptCall("c2", "g1", ["python", "plot.py"])] },
      { text: "unreached" },
    ]);
    const { host } = fakeScriptHost();
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run twice",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
      budget: { maxToolCalls: 1 },
    });
    const notices = result.items.filter(
      (i) => i.type === "notice" && i.code === "budget.tool_calls",
    );
    expect(notices.length).toBe(1);
  });

  it("the pending item carries the script source so the card can show it (review #2)", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "done" },
    ]);
    const { host } = fakeScriptHost();
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    const runItem = result.items.find((i) => i.type === "script_run");
    expect(runItem?.type === "script_run" && runItem.scriptPreview).toContain(
      "print('hi')",
    );
  });

  it("the always-allow hash binds the granted root, not just the command (review #1)", async () => {
    // Two grants, same script name + content, same command → the hashes the
    // host caches an always-allow on must DIFFER, so approving g1 never
    // silently runs the g2 copy in the g2 folder's cwd.
    const a = scriptFixture();
    const b = scriptFixture();
    const grantA = a.grant;
    const grantB: GrantedRoot = { ...b.grant, id: "g2" };
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: a.workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { toolCalls: [runScriptCall("c2", "g2", ["python", "plot.py"])] },
      { text: "done" },
    ]);
    const { host, calls } = fakeScriptHost();
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run both",
      registry: fakeRegistry(),
      grants: () => [grantA, grantB],
      scriptHost: host,
    });
    expect(calls.hashes.length).toBe(2);
    expect(calls.hashes[0]).not.toBe(calls.hashes[1]);
  });

  it("a grant revoked during the approval pause fails the run — nothing spawns (review #6)", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "noted" },
    ]);
    let live: GrantedRoot[] = [grant];
    const { host, calls } = fakeScriptHost({
      // Revoke the grant at approval time, then approve.
      approve: () => {
        live = [];
        return { approve: true };
      },
    });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => live,
      scriptHost: host,
    });
    expect(calls.runs.length).toBe(0);
    const runItem = result.items.find((i) => i.type === "script_run");
    expect(runItem?.type === "script_run" && runItem.status).toBe("failed");
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toMatch(/revoked/i);
  });

  it("refuses to run when the script bytes change during the approval pause (TOCTOU)", async () => {
    const { grant, workspace } = scriptFixture();
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace });
    const model = new ScriptedModelAdapter([
      { toolCalls: [runScriptCall("c1", "g1", ["python", "plot.py"])] },
      { text: "noted" },
    ]);
    const { host, calls } = fakeScriptHost({
      // Swap the approved file for different content before the run spawns.
      approve: () => {
        writeFileSync(join(grant.path, "plot.py"), "print('SWAPPED')\n");
        return { approve: true };
      },
    });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "run it",
      registry: fakeRegistry(),
      grants: () => [grant],
      scriptHost: host,
    });
    expect(calls.runs.length).toBe(0);
    const runItem = result.items.find((i) => i.type === "script_run");
    expect(runItem?.type === "script_run" && runItem.status).toBe("failed");
    const toolMsg = model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toMatch(/chang/i);
  });
});

describe("runSessionTask — A2 compaction and resume (ADR 0021)", () => {
  /** Occupancy past 90% of the 200k `claude` window. */
  const overLimit = { inputTokens: 185_000, outputTokens: 1000 };

  it("sends the compacted history when the transcript carries a checkpoint", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    for (const item of [
      { id: "u1", type: "user_message" as const, text: "write the methods" },
      { id: "a1", type: "agent_message" as const, text: "a very long draft" },
      {
        id: "c1",
        type: "compaction" as const,
        summary: "Methods drafted; user prefers 'we'.",
        trigger: "auto" as const,
        retainedItemIds: ["u1"],
        tokensBefore: 100,
      },
    ])
      await store.append(session.id, { type: "item.completed", item });

    const model = new ScriptedModelAdapter([{ text: "ok" }]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "now the results",
    });

    const sent = model.requests.at(-1)?.messages ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent.slice(1).map((m) => m.content)).toEqual([
      "write the methods",
      `${SUMMARY_PREFIX}Methods drafted; user prefers 'we'.`,
      "now the results",
    ]);
    // The long agent draft is gone from what the model sees…
    expect(sent.some((m) => m.content.includes("a very long draft"))).toBe(
      false,
    );
    // …but the transcript still has it (the user's record is never edited).
    expect((await store.load(session.id)).items.map((i) => i.type)).toContain(
      "agent_message",
    );
  });

  it("compacts mid-task instead of stopping, and continues", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      // turn 1 asks for a tool and reports an over-threshold window
      {
        toolCalls: [{ id: "t1", name: "read_span", args: { section: "3" } }],
        usage: overLimit,
      },
      // the compaction request
      { text: "HANDOFF: drafted §3, next write §4." },
      // turn 2 answers within a fresh window
      { text: "done", usage: { inputTokens: 900, outputTokens: 20 } },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "write §3 then §4",
      registry: fakeRegistry(),
    });

    expect(result.status).toBe("completed");
    const checkpoint = result.items.find((i) => i.type === "compaction");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.type === "compaction" && checkpoint.trigger).toBe(
      "auto",
    );
    expect(checkpoint?.type === "compaction" && checkpoint.summary).toBe(
      "HANDOFF: drafted §3, next write §4.",
    );
    // NOT the A1a dead end.
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);

    // The turn AFTER the checkpoint was sent the compacted history.
    const last = model.requests.at(-1)?.messages ?? [];
    expect(last.some((m) => m.content.startsWith(SUMMARY_PREFIX))).toBe(true);
    expect(last.some((m) => m.role === "tool")).toBe(false);
    // The checkpoint pinned the session brief.
    const brief = result.items.find((i) => i.type === "user_message");
    expect(
      checkpoint?.type === "compaction" && checkpoint.retainedItemIds,
    ).toEqual([brief?.id]);
  });

  it("falls back to the honest context.limit stop when summarization fails", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: { section: "3" } }],
        usage: overLimit,
      },
      // the compaction request throws every time
      { text: "never", failure: { message: "boom", times: 9 } },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "keep writing",
      registry: fakeRegistry(),
    });

    expect(result.status).toBe("completed");
    const codes = result.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : ""));
    expect(codes).toContain("compaction.failed");
    expect(codes).toContain("context.limit");
    expect(result.items.some((i) => i.type === "compaction")).toBe(false);
  });

  it("does not compact twice in a row — a still-full window stops honestly", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: { section: "3" } }],
        usage: overLimit,
      },
      { text: "HANDOFF" },
      // still over the threshold right after compacting (pathological input)
      {
        toolCalls: [{ id: "t2", name: "read_span", args: { section: "4" } }],
        usage: overLimit,
      },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "keep writing",
      registry: fakeRegistry(),
    });

    expect(result.items.filter((i) => i.type === "compaction")).toHaveLength(1);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(true);
  });

  it("compacts before the first turn when a continued session is already full", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "the paper brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    const model = new ScriptedModelAdapter([
      { text: "HANDOFF" },
      { text: "continuing" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "continue",
    });

    expect(result.status).toBe("completed");
    expect(result.items.some((i) => i.type === "compaction")).toBe(true);
    expect(result.items.some((i) => i.type === "agent_message")).toBe(true);
  });

  it("accrues the compaction request's tokens into the task usage", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    const model = new ScriptedModelAdapter([
      { text: "HANDOFF", usage: { inputTokens: 500, outputTokens: 40 } },
      { text: "continuing", usage: { inputTokens: 100, outputTokens: 10 } },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "continue",
    });
    // A compaction is a real, paid model call and is reported as one.
    expect(result.usage?.outputTokens).toBe(50);
  });

  it("an interrupt during compaction ends the task as interrupted, not context-limited (review)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const controller = new AbortController();
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: { section: "3" } }],
        usage: overLimit,
      },
      { text: "never — the signal aborts before the summary" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "write §3",
      registry: fakeRegistry(),
      signal: controller.signal,
      // Stop pressed while the turn is settling.
      onEvent: (e) => {
        if (e.type === "turn.completed") controller.abort();
      },
    });
    expect(result.status).toBe("interrupted");
    // The user pressed Stop: "context limit reached — start a new session"
    // would blame the window for their own interrupt.
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
    expect(result.items.some((i) => i.type === "interrupted")).toBe(true);
  });

  it("an abort WHILE the summary streams ends interrupted, not context-limited (review)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    const controller = new AbortController();
    // Stop pressed in the real window: the summarization request is in flight.
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: () => {
        throw new Error("unused");
      },
      generateStream: async function* (req) {
        const isCompaction = req.messages.some((m) =>
          m.content.includes("CONTEXT CHECKPOINT COMPACTION"),
        );
        if (isCompaction) {
          controller.abort();
          yield { type: "aborted" as const };
          return;
        }
        yield {
          type: "completed" as const,
          result: {
            text: "unreachable",
            toolCalls: [],
            stopReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
    };
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "continue",
      signal: controller.signal,
    });
    expect(result.status).toBe("interrupted");
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
    expect(result.items.some((i) => i.type === "interrupted")).toBe(true);
  });

  it("puts the user's new request AFTER the summary on a pre-task compaction (review)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "the paper brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    const model = new ScriptedModelAdapter([
      { text: "HANDOFF" },
      { text: "on it" },
    ]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "now write §4",
    });
    // The request the model must act on is the LAST message, not buried in
    // the retained block above a summary that ends "continue from this".
    const sent = model.requests.at(-1)?.messages ?? [];
    expect(sent.at(-1)?.content).toBe("now write §4");
    // …and the persisted transcript agrees, so a resume rebuilds the same
    // order: the checkpoint sits BEFORE the request, not after it.
    const rebuilt = buildConversationHistory(
      (await store.load(session.id)).items,
      binding.model,
    );
    const summaryAt = rebuilt.findIndex((m) =>
      m.content.startsWith(SUMMARY_PREFIX),
    );
    const requestAt = rebuilt.findIndex((m) => m.content === "now write §4");
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(requestAt).toBeGreaterThan(summaryAt);
  });

  it("never summarizes the pending request on a pre-task compaction (review — rewind safety)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u0", type: "user_message", text: "the paper brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    const model = new ScriptedModelAdapter([
      { text: "HANDOFF" }, // the summarization request (request 0)
      { text: "on it" }, // the turn after compaction (request 1)
    ]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "SENSITIVE NEW REQUEST",
    });
    // The summary is of the conversation SO FAR; the pending request must not
    // reach the summarizer, or a later rewind of it leaves it inside the
    // surviving summary.
    const summarized = model.requests[0]?.messages ?? [];
    expect(
      summarized.some((m) => m.content.includes("SENSITIVE NEW REQUEST")),
    ).toBe(false);
    // …and the request lands AFTER the summary in the turn that follows.
    const afterCompaction = model.requests[1]?.messages ?? [];
    const summaryAt = afterCompaction.findIndex((m) =>
      m.content.startsWith(SUMMARY_PREFIX),
    );
    const requestAt = afterCompaction.findIndex(
      (m) => m.content === "SENSITIVE NEW REQUEST",
    );
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(requestAt).toBeGreaterThan(summaryAt);
  });

  it("does not re-stop a session whose full turn precedes its checkpoint", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: { id: "u1", type: "user_message", text: "brief" },
    });
    await store.append(session.id, {
      type: "turn.completed",
      turn: 1,
      usage: overLimit,
    });
    await store.append(session.id, {
      type: "item.completed",
      item: {
        id: "c1",
        type: "compaction",
        summary: "summary",
        trigger: "auto",
        retainedItemIds: ["u1"],
        tokensBefore: 186_000,
      },
    });

    const model = new ScriptedModelAdapter([{ text: "carrying on" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "continue",
    });
    expect(result.items.some((i) => i.type === "agent_message")).toBe(true);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "context.limit",
      ),
    ).toBe(false);
  });
});

/** A read registry with two read tools, so narrowing can be observed. */
function twoToolRegistry(): Map<ToolName, ToolExecutor> {
  const r = fakeRegistry();
  r.set("grep_project", {
    name: "grep_project",
    category: "retrieval",
    spec: {
      name: "grep_project",
      description: "search the project",
      parameters: { type: "object" },
    },
    invoke: async () => ok({ matches: [] }),
  });
  return r;
}

const NO_REPORT = "(the subtask produced no report)";

describe("runSessionTask spawn_subtask (A3)", () => {
  it("fans out two read-only children and reports back in request order", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const model = scriptedByKey({
      "survey A": [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "child A" }, { goal: "child B" }] },
            },
          ],
        },
        { text: "synthesis of A+B" },
      ],
      "child A": [{ text: "A: two entry points" }],
      "child B": [{ text: "B: one entry point" }],
    });
    const events: SessionEvent[] = [];
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey A",
      registry: fakeRegistry(),
      onEvent: (e) => events.push(e),
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(subtask?.type === "subtask" && subtask.status).toBe("completed");
    expect(
      subtask?.type === "subtask" &&
        subtask.reports.map((r) => [r.goal, r.summary]),
    ).toEqual([
      ["child A", "A: two entry points"],
      ["child B", "B: one entry point"],
    ]);
    // Exactly one subtask item; no started/updated partials persisted.
    assertNoPartials(eventsOf(await store.load(session.id)));
    expect(res.items.filter((i) => i.type === "subtask")).toHaveLength(1);
    // The report-back reached the model on the synthesis turn.
    expect(res.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "synthesis of A+B",
    });
  });

  it("a child cannot exceed its narrowed allowlist", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: {
                children: [{ goal: "explore", allowed_tools: ["read_span"] }],
              },
            },
          ],
        },
        { text: "done" },
      ],
      // the child tries grep_project — available to the PARENT but not to this
      // narrowed child; it must be refused, and the child still finishes.
      explore: [
        { toolCalls: [{ id: "g0", name: "grep_project", args: { q: "x" } }] },
        { text: "gave up on grep" },
      ],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: twoToolRegistry(),
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(
      subtask?.type === "subtask" && subtask.reports[0]?.allowedTools,
    ).toEqual(["read_span"]);
    expect(subtask?.type === "subtask" && subtask.reports[0]?.status).toBe(
      "completed",
    );
    expect(subtask?.type === "subtask" && subtask.reports[0]?.summary).toBe(
      "gave up on grep",
    );
  });

  it("carves each child's OUTPUT-TOKEN budget from the parent's remaining ceiling", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    // The carve is proven on the output-token field (the cost/runaway guard),
    // the only field divided across children. parent maxOutputTokens 20 → after
    // the spawn turn (5 tokens) 15 remain → floor(15/2) = 7 per child. Each turn
    // reports 5 output tokens, so a child stops after 2 turns (both read tools)
    // before ever reaching its text turn → NO_REPORT. A default token budget
    // (16 000) would let it reach the text, so NO_REPORT proves the carve applied.
    // Turns are NOT carved (per-agent), so the default 12-turn budget is intact.
    const loopThenText: ScriptedTurn[] = [
      { toolCalls: [{ id: "a", name: "read_span", args: { section: "1" } }] },
      { toolCalls: [{ id: "b", name: "read_span", args: { section: "2" } }] },
      { toolCalls: [{ id: "c", name: "read_span", args: { section: "3" } }] },
      { text: "reached the end" },
    ];
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "loop A" }, { goal: "loop B" }] },
            },
          ],
        },
        { text: "done" },
      ],
      "loop A": loopThenText,
      "loop B": loopThenText,
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: fakeRegistry(),
      budget: { maxOutputTokens: 20 },
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(
      subtask?.type === "subtask" &&
        subtask.reports.every((r) => r.summary === NO_REPORT),
    ).toBe(true);
    expect(subtask?.type === "subtask" && subtask.status).toBe("completed");
  });

  it("a wide fan-out gives every child room to explore AND report (regression: divided-turn starvation)", async () => {
    // The production defect: 8 folders → 8 children under the default budget.
    // Dividing maxTurns (12) by 8 left each child 1 turn — enough to call a read
    // tool, never enough to then write its summary — so every child reported
    // NO_REPORT. Turns are now per-agent, so each child completes explore→report.
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const folders = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
    const exploreThenSummarize = (n: string): ScriptedTurn[] => [
      { toolCalls: [{ id: "r", name: "read_span", args: { section: n } }] },
      { text: `summary of ${n}` },
    ];
    const scripts: Record<string, ScriptedTurn[]> = {
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: folders.map((f) => ({ goal: f })) },
            },
          ],
        },
        { text: "synthesis" },
      ],
    };
    for (const f of folders) scripts[f] = exploreThenSummarize(f);
    const res = await runSessionTask({
      store,
      session,
      model: scriptedByKey(scripts),
      binding,
      text: "survey",
      registry: fakeRegistry(),
      maxFanOut: 8,
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(
      subtask?.type === "subtask" && subtask.reports.map((r) => r.summary),
    ).toEqual(folders.map((f) => `summary of ${f}`));
  });

  it("maxFanOut is a CONCURRENCY limit, not a per-call cap: all children run (queued) at maxFanOut=1", async () => {
    // The reported bug: maxFanOut=1 silently sliced 8 requested children to 1, so
    // only the first folder was ever summarized. It must instead run all 8, one
    // at a time (concurrency 1), and report every one in request order.
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const folders = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
    const scripts: Record<string, ScriptedTurn[]> = {
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: folders.map((f) => ({ goal: f })) },
            },
          ],
        },
        { text: "synthesis" },
      ],
    };
    for (const f of folders)
      scripts[f] = [
        { toolCalls: [{ id: "r", name: "read_span", args: { section: f } }] },
        { text: `summary of ${f}` },
      ];
    const res = await runSessionTask({
      store,
      session,
      model: scriptedByKey(scripts),
      binding,
      text: "survey",
      registry: fakeRegistry(),
      maxFanOut: 1, // one at a time — but still ALL of them
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(
      subtask?.type === "subtask" && subtask.reports.map((r) => r.summary),
    ).toEqual(folders.map((f) => `summary of ${f}`));
  });

  it("rejects an over-large request honestly instead of silently dropping children", async () => {
    // Beyond the hard per-call ceiling the model is told the limit (Codex
    // AgentLimitReached shape) so it can re-spawn the rest — no subtask item is
    // emitted, and the parent continues.
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const tooMany = Array.from({ length: 17 }, (_, i) => ({ goal: `g${i}` }));
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            { id: "s0", name: "spawn_subtask", args: { children: tooMany } },
          ],
        },
        { text: "will spawn in batches" },
      ],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: fakeRegistry(),
    });
    // No subtask item, and the spawn tool call is reported failed with a message
    // that names the limit; the parent still reaches its next agent message.
    expect(res.items.some((i) => i.type === "subtask")).toBe(false);
    const call = res.items.find(
      (i) => i.type === "tool_call" && i.tool === "spawn_subtask",
    );
    expect(call?.type === "tool_call" && call.status).toBe("failed");
    expect(call?.type === "tool_call" && call.resultJson).toMatch(/16/);
    expect(res.items.at(-1)).toMatchObject({
      type: "agent_message",
      text: "will spawn in batches",
    });
  });

  it("streams per-child progress as each subtask settles, not one final dump", async () => {
    // The whole child set is visible immediately (all `running`), and each flips
    // to terminal via a live item.updated the moment it settles — so a serial
    // (maxFanOut=1) fan-out shows steady progress instead of a long blank wait.
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const kids = ["k1", "k2", "k3"];
    const scripts: Record<string, ScriptedTurn[]> = {
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: kids.map((k) => ({ goal: k })) },
            },
          ],
        },
        { text: "done" },
      ],
    };
    for (const k of kids) scripts[k] = [{ text: `report ${k}` }];
    const events: SessionEvent[] = [];
    await runSessionTask({
      store,
      session,
      model: scriptedByKey(scripts),
      binding,
      text: "survey",
      registry: fakeRegistry(),
      maxFanOut: 1,
      onEvent: (e) => events.push(e),
    });
    const subtaskEvents = events.filter(
      (e) =>
        (e.type === "item.started" ||
          e.type === "item.updated" ||
          e.type === "item.completed") &&
        e.item.type === "subtask",
    );
    // item.started: the whole set present and running (nothing dropped, nothing
    // hidden until the end).
    const started = subtaskEvents.find((e) => e.type === "item.started");
    expect(
      started?.type === "item.started" &&
        started.item.type === "subtask" &&
        started.item.reports.map((r) => r.status),
    ).toEqual(["running", "running", "running"]);
    // item.updated: the count of settled (non-running) reports strictly grows.
    const settledCounts = subtaskEvents
      .filter((e) => e.type === "item.updated")
      .map((e) =>
        e.type === "item.updated" && e.item.type === "subtask"
          ? e.item.reports.filter((r) => r.status !== "running").length
          : -1,
      );
    expect(settledCounts).toEqual([1, 2, 3]);
    // item.completed: every report terminal.
    const completed = subtaskEvents.find((e) => e.type === "item.completed");
    expect(
      completed?.type === "item.completed" &&
        completed.item.type === "subtask" &&
        completed.item.reports.map((r) => [r.status, r.summary]),
    ).toEqual([
      ["completed", "report k1"],
      ["completed", "report k2"],
      ["completed", "report k3"],
    ]);
  });

  it("never offers spawn_subtask to a child (depth bounded to 1)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "deep" }] },
            },
          ],
        },
        { text: "done" },
      ],
      // the child tries to recurse; spawn_subtask must be refused for it.
      deep: [
        {
          toolCalls: [
            {
              id: "s1",
              name: "spawn_subtask",
              args: { children: [{ goal: "deeper" }] },
            },
          ],
        },
        { text: "cannot recurse" },
      ],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: fakeRegistry(),
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(subtask?.type === "subtask" && subtask.reports[0]?.summary).toBe(
      "cannot recurse",
    );
    // No nested subtask leaked into the parent transcript.
    expect(res.items.filter((i) => i.type === "subtask")).toHaveLength(1);
  });

  it("never offers update_plan to a child (read-only by construction, review #1)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const requests: GenerateRequest[] = [];
    const base = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "explore" }] },
            },
          ],
        },
        { text: "done" },
      ],
      explore: [{ text: "explored" }],
    });
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: (req) => base.generate(req),
      async *generateStream(req) {
        requests.push(req);
        yield* base.generateStream(req);
      },
    } as ModelAdapter;
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: fakeRegistry(),
    });
    const sysText = (r?: GenerateRequest): string => {
      const sys = r?.messages.find((m) => m.role === "system");
      return typeof sys?.content === "string" ? sys.content : "";
    };
    const lastUser = (r: GenerateRequest): string => {
      const u = [...r.messages].reverse().find((m) => m.role === "user");
      return typeof u?.content === "string" ? u.content : "";
    };
    // The parent gets the plan tool; the child never does.
    const parentReq = requests.find((r) => lastUser(r) === "survey");
    const childReq = requests.find((r) => lastUser(r) === "explore");
    expect(sysText(parentReq)).toContain("update_plan");
    expect(sysText(childReq)).not.toContain("update_plan");
  });

  it("does not charge a child's tool calls against the parent's own budget (fan-out amplifies capacity)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const invoked: string[] = [];
    const registry = fakeRegistry((n) => invoked.push(n));
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "explore" }] },
            },
          ],
        },
        // the parent's OWN read — a fan-out is one parent tool call, so the
        // child's two reads must NOT have eaten the parent's small budget.
        {
          toolCalls: [{ id: "p1", name: "read_span", args: { section: "P" } }],
        },
        { text: "done" },
      ],
      explore: [
        {
          toolCalls: [{ id: "e1", name: "read_span", args: { section: "A" } }],
        },
        {
          toolCalls: [{ id: "e2", name: "read_span", args: { section: "B" } }],
        },
        { text: "explored A,B" },
      ],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry,
      budget: { maxToolCalls: 3, maxTurns: 5 },
    });
    expect(res.status).toBe("completed");
    // No tool-call budget stop — the child's reads did not deplete the parent.
    expect(
      res.items.some(
        (i) => i.type === "notice" && i.code === "budget.tool_calls",
      ),
    ).toBe(false);
    // Both child reads AND the parent's own read ran (2 + 1).
    expect(invoked.filter((n) => n === "read_span")).toHaveLength(3);
  });

  it("counts a fan-out as one tool call and accrues the children's usage", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "one" }, { goal: "two" }] },
            },
          ],
        },
        { text: "done" },
      ],
      one: [{ text: "1" }],
      two: [{ text: "2" }],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry: fakeRegistry(),
      budget: { maxToolCalls: 1 }, // one call total; the fan-out is that call
    });
    // The task completed (the single tool-call budget was not exceeded by the
    // fan-out itself), and both children's usage rolled into the parent total.
    expect(res.status).toBe("completed");
    const subtask = res.items.find((i) => i.type === "subtask");
    expect(subtask?.type === "subtask" && subtask.reports).toHaveLength(2);
    expect(res.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("carves a child's budget from consumption INCLUDING earlier calls in the same batch (B3 review, invariant 5)", async () => {
    // The regression B3's review caught. `carveChildBudget` reads the parent's
    // REMAINING tool-call allowance at `spawn_subtask` invoke time; if the
    // batch's earlier calls have not been counted yet, the child is carved
    // against a stale figure and over-allocated. Two reads precede the spawn
    // in ONE batch, so the count must already include them.
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    // A child that keeps calling read_span: it stops when ITS carved
    // maxToolCalls runs out, so the number of calls it makes IS the carve.
    const childCalls: unknown[] = [];
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "read_span",
        {
          name: "read_span",
          category: "retrieval",
          executionMode: "parallel",
          spec: {
            name: "read_span",
            description: "read",
            parameters: { type: "object" },
          },
          invoke: async (args) => {
            childCalls.push(args);
            return ok({ content: "x" });
          },
        },
      ],
    ]);
    const greedy: ScriptedTurn[] = Array.from({ length: 12 }, (_, i) => ({
      toolCalls: [
        { id: `k${i}`, name: "read_span", args: { section: `${i}` } },
      ],
    }));
    const model = scriptedByKey({
      survey: [
        {
          toolCalls: [
            { id: "p1", name: "read_span", args: { section: "a" } },
            { id: "p2", name: "read_span", args: { section: "b" } },
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "greedy" }] },
            },
          ],
        },
        { text: "done" },
      ],
      greedy,
    });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "survey",
      registry,
      budget: { maxToolCalls: 10 },
    });
    // 2 parent reads + the child's own reads.
    const childReads = childCalls.length - 2;
    // 10 total, minus the two reads that ran before the spawn in the same
    // batch, leaves the child 8. (The `spawn_subtask` call itself is charged
    // when it RETURNS, so it is legitimately not in the figure its own carve
    // reads — that is unchanged from before B3.) The number to watch is 10:
    // that is what a batch whose earlier calls had not been counted yet would
    // hand the child, and it is the regression this pins.
    expect(childReads).toBeLessThanOrEqual(8);
    expect(childReads).toBeGreaterThan(0);
  });
});

describe("runSessionTask model floor (A6, ADR 0023)", () => {
  /** A binding on a model Lemmaria has not verified for the L2 loop. */
  const unverified: ModelBinding = { ...binding, model: "llama3.1:8b" };

  it("says once, up front, that the model is unverified", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "done" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding: unverified,
      text: "hello",
    });

    const notices = result.items.filter(
      (i) => i.type === "notice" && i.code === "model.unverified",
    );
    expect(notices).toHaveLength(1);
    // It must name the floor, so the message is actionable rather than vague.
    const notice = notices[0];
    expect(notice?.type === "notice" && notice.message).toContain(
      "claude-haiku-4-5",
    );
    // ...and it must arrive BEFORE the model is ever called, so the user is
    // warned ahead of the failure it is warning about — not after it.
    const events = eventsOf(await store.load(session.id));
    const noticeAt = events.findIndex(
      (e) => e.type === "item.completed" && e.item.type === "notice",
    );
    const firstTurnAt = events.findIndex((e) => e.type === "turn.started");
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeLessThan(firstTurnAt);
  });

  it("stays silent for a verified model", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "done" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "hello",
    });
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "model.unverified",
      ),
    ).toBe(false);
  });

  it("never repeats itself across a fan-out (children stay silent)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/w" });
    // A parent that spawns two children, all on the same unverified model.
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "c1",
            name: "spawn_subtask",
            args: {
              children: [{ goal: "explore a" }, { goal: "explore b" }],
            },
          },
        ],
      },
      { text: "synthesized" },
      // the two children's turns
      { text: "report a" },
      { text: "report b" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding: unverified,
      text: "survey the repo",
      registry: fakeRegistry(),
      maxFanOut: 2,
    });

    // Non-vacuous: the children must actually have RUN, or "no duplicate
    // notice" would be true for the boring reason that no child existed.
    const subtask = result.items.find((i) => i.type === "subtask");
    expect(subtask?.type === "subtask" && subtask.reports).toHaveLength(2);

    const notices = result.items.filter(
      (i) => i.type === "notice" && i.code === "model.unverified",
    );
    expect(notices).toHaveLength(1);
  });
});

describe("runSessionTask tool-result capping (A6)", () => {
  it("caps a huge tool result before it reaches the model AND the transcript", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/w" });
    // A `run_script`-shaped flood: 500 kB of captured stdout.
    const flood = "y".repeat(500_000);
    const registry = new Map<ToolName, ToolExecutor>();
    registry.set("read_span", {
      name: "read_span",
      category: "retrieval",
      spec: { name: "read_span", description: "d", parameters: {} },
      invoke: async () => ok({ text: flood }),
    });
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "read_span", args: {} }] },
      { text: "done" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read it",
      registry,
    });

    // What the MODEL saw, read off the recorded request — not off the tool.
    const secondRequest = model.requests[1];
    const toolMessage = (secondRequest?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolMessage).toBeDefined();
    const seen = toolMessage?.content ?? "";
    expect(seen.length).toBeLessThan(flood.length);
    const parsed = JSON.parse(seen) as {
      truncated: boolean;
      originalChars: number;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.originalChars).toBeGreaterThan(500_000);

    // The transcript must show the SAME bytes — never more than the model saw.
    const toolItem = result.items.find((i) => i.type === "tool_call");
    expect(toolItem?.type === "tool_call" && toolItem.resultJson).toBe(seen);
  });

  it("leaves an ordinary tool result untouched", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "read_span", args: {} }] },
      { text: "done" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read it",
      registry: fakeRegistry(),
    });
    const toolItem = result.items.find((i) => i.type === "tool_call");
    // fakeRegistry's read_span returns a small object; it must be verbatim.
    expect(
      toolItem?.type === "tool_call" &&
        toolItem.resultJson.includes("truncated"),
    ).toBe(false);
  });
});

describe("runSessionTask parallel tool batch (B3, ADR 0025)", () => {
  /** A read registry whose tools declare `parallel` and record their overlap. */
  function overlapRegistry(delayMs: number) {
    let active = 0;
    let peak = 0;
    const registry = new Map<ToolName, ToolExecutor>();
    registry.set("read_span", {
      name: "read_span",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "read_span",
        description: "read a section",
        parameters: { type: "object" },
      },
      invoke: async (args) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, delayMs));
        active -= 1;
        return ok({
          content: `content of ${(args as { section?: string }).section ?? "?"}`,
        });
      },
    });
    return { registry, peak: () => peak };
  }

  it("overlaps a turn's three reads and carries their results forward in call order", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/ws" });
    const { registry, peak } = overlapRegistry(25);
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "r1", name: "read_span", args: { section: "one" } },
          { id: "r2", name: "read_span", args: { section: "two" } },
          { id: "r3", name: "read_span", args: { section: "three" } },
        ],
      },
      { text: "drafted from all three" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read three sections",
      registry,
    });

    // The reads genuinely overlapped — this is the milestone's whole point.
    expect(peak()).toBeGreaterThan(1);

    // …and the loop carried on normally: three tool rows in call order,
    // then the answer.
    const rows = result.items.filter((i) => i.type === "tool_call");
    expect(rows).toHaveLength(3);
    expect(
      rows.map((r) => (r.type === "tool_call" ? r.resultJson : "")),
    ).toEqual([
      expect.stringContaining("content of one"),
      expect.stringContaining("content of two"),
      expect.stringContaining("content of three"),
    ]);
    expect(
      rows.every((r) => r.type === "tool_call" && r.status === "completed"),
    ).toBe(true);
    expect(result.status).toBe("completed");
    expect(
      result.items.some(
        (i) =>
          i.type === "agent_message" && i.text === "drafted from all three",
      ),
    ).toBe(true);
  });

  it("keeps a turn that also proposes an edit strictly sequential (invariant 3)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "s", workspace: "/ws" });
    const { registry, peak } = overlapRegistry(25);
    const { host, files } = fakeEditHost(
      { "a.tex": "teh wrold" },
      { policy: "auto_apply" },
    );
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "r1", name: "read_span", args: { section: "one" } },
          proposeCall("e1", [
            { file: "a.tex", anchor: "teh", replacement: "the" },
          ]),
          { id: "r2", name: "read_span", args: { section: "two" } },
        ],
      },
      { text: "done" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "read and edit",
      registry,
      editHost: host,
    });
    // One write in the batch makes the WHOLE batch serial: the two reads that
    // would otherwise have overlapped do not.
    expect(peak()).toBe(1);
    expect(result.status).toBe("completed");
    // …and the edit still landed, in its place in the batch.
    expect(files["a.tex"]).toBe("the wrold");
  });
});

/**
 * R1 (ADR 0059), end to end: what an equipped child actually receives, and
 * what the record says it received.
 *
 * These are the rows the unit tests cannot reach. `loop-tools/subtask.test.ts`
 * proves the resolution and the record; this proves the resolved set survives
 * `runChild` into a real child task and shapes that child's own surface.
 */
describe("runSessionTask spawn_subtask skills (R1)", () => {
  const LEDGER: Skill = {
    name: "concern-ledger",
    description: "How to write a reviewer's concern ledger.",
    body: "Prefix every concern id with CL-.",
    source: "project",
    path: ".lemmaria/skills/concern-ledger/SKILL.md",
    references: [],
  };
  const TONE: Skill = {
    name: "tone",
    description: "Voice rules for this paper.",
    body: "ALWAYS use active voice.",
    source: "project",
    path: ".lemmaria/skills/tone/SKILL.md",
    references: [],
  };

  /**
   * `scriptedByKey`, plus every request it saw, keyed the same way — so a test
   * can read the child's OWN first request rather than inferring it.
   */
  function recordingByKey(scripts: Record<string, ScriptedTurn[]>): {
    model: ModelAdapter;
    seen: Map<string, GenerateRequest[]>;
  } {
    const seen = new Map<string, GenerateRequest[]>();
    const inner = scriptedByKey(scripts);
    const record = (req: GenerateRequest): void => {
      const lastUser = [...req.messages]
        .reverse()
        .find((m) => m.role === "user");
      const key = typeof lastUser?.content === "string" ? lastUser.content : "";
      seen.set(key, [...(seen.get(key) ?? []), req]);
    };
    return {
      seen,
      model: {
        protocol: "anthropic",
        async generate(req: GenerateRequest) {
          record(req);
          return inner.generate(req);
        },
        async *generateStream(req: GenerateRequest) {
          record(req);
          yield* inner.generateStream(req);
        },
      } as ModelAdapter,
    };
  }

  const spawn = (children: unknown[]): ScriptedTurn[] => [
    { toolCalls: [{ id: "s0", name: "spawn_subtask", args: { children } }] },
    { text: "synthesised" },
  ];

  const systemOf = (req: GenerateRequest | undefined): string => {
    const m = req?.messages.find((x) => x.role === "system");
    return typeof m?.content === "string" ? m.content : "";
  };

  it("an equipped child's surface carries the block and load_skill; its sibling's does not", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const { model, seen } = recordingByKey({
      review: spawn([
        { goal: "review abstract", skills: ["concern-ledger"] },
        { goal: "survey figures" },
      ]),
      "review abstract": [{ text: "CL-1 noted" }],
      "survey figures": [{ text: "three figures" }],
    });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });

    const equipped = seen.get("review abstract")?.[0];
    const plain = seen.get("survey figures")?.[0];

    // The equipped child sees EXACTLY what it was equipped with — the parent's
    // other skill is not in its catalogue, which is the whole restriction.
    const sys = systemOf(equipped);
    expect(sys).toContain("<available_skills>");
    expect(sys).toContain("<name>concern-ledger</name>");
    expect(sys).not.toContain("<name>tone</name>");
    // …and not the body: the second hop is still the child's to take.
    expect(JSON.stringify(equipped?.messages)).not.toContain(
      "Prefix every concern id",
    );

    const equippedTools = (equipped?.tools ?? []).map((t) => t.name);
    expect(equippedTools).toContain("load_skill");
    // Depth and the plan tool are still withheld — ADR 0059 moves the skills
    // term only.
    expect(equippedTools).not.toContain("spawn_subtask");
    expect(equippedTools).not.toContain("update_plan");

    // The unequipped sibling is exactly a pre-R1 child.
    expect(systemOf(plain)).not.toContain("available_skills");
    expect((plain?.tools ?? []).map((t) => t.name)).not.toContain("load_skill");
  });

  it("the child's load_skill is restricted to its own set, and it survives the refusal", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const model = scriptedByKey({
      review: spawn([{ goal: "review abstract", skills: ["concern-ledger"] }]),
      "review abstract": [
        // A name the PARENT holds but this child was not given.
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "tone" } }],
        },
        {
          toolCalls: [
            { id: "c2", name: "load_skill", args: { name: "concern-ledger" } },
          ],
        },
        { text: "done" },
      ],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });

    const subtask = res.items.find((i) => i.type === "subtask");
    if (subtask?.type !== "subtask") throw new Error("no subtask item");
    // The refusal and the success both happen inside the child, whose
    // transcript never reaches the parent — so what is observable here is that
    // the child completed after being refused, and that the record names the
    // one skill it really held. `loop-tools/skill.test.ts` pins the payloads.
    expect(subtask.reports[0]?.status).toBe("completed");
    expect(subtask.reports[0]?.skills).toEqual(["concern-ledger"]);
  });

  it("the child's load_skill payloads name only its set — refusal, then body (row 8)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const { model, seen } = recordingByKey({
      review: spawn([{ goal: "review abstract", skills: ["concern-ledger"] }]),
      "review abstract": [
        // A name the PARENT holds but this child was not given.
        {
          toolCalls: [{ id: "c1", name: "load_skill", args: { name: "tone" } }],
        },
        {
          toolCalls: [
            { id: "c2", name: "load_skill", args: { name: "concern-ledger" } },
          ],
        },
        { text: "done" },
      ],
    });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });

    // The child's own transcript never reaches the parent, so the only place
    // these payloads are observable is the child's LATER requests — each one
    // carries the previous turn's tool result.
    const requests = seen.get("review abstract") ?? [];
    const afterRefusal = JSON.stringify(requests[1]?.messages);
    const afterLoad = JSON.stringify(requests[2]?.messages);

    // `createLoadSkillTool` resolves only against the array it was given, so a
    // child handed a restricted array IS a restricted catalogue — including in
    // what its `not_found` offers as the alternatives.
    expect(afterRefusal).toContain("not_found");
    expect(afterRefusal).toContain("concern-ledger");
    // The refusal must not advertise the parent's other skill as available.
    expect(afterRefusal).not.toContain("ALWAYS use active voice.");
    expect(afterRefusal).not.toMatch(/Available:[^"]*tone/);

    // And the name it WAS given returns the body.
    expect(afterLoad).toContain("Prefix every concern id");
  });

  it("the report's allowedTools is what the child's first request actually carried", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const { model, seen } = recordingByKey({
      review: spawn([
        { goal: "review abstract", skills: ["concern-ledger"] },
        { goal: "survey figures" },
      ]),
      "review abstract": [{ text: "CL-1" }],
      "survey figures": [{ text: "figures" }],
    });
    const res = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });
    const subtask = res.items.find((i) => i.type === "subtask");
    if (subtask?.type !== "subtask") throw new Error("no subtask item");

    // `allowedTools` is a PREDICTION, written before the child runs. Parity
    // with the child's real surface is the thing worth pinning: fix the
    // prediction to match the surface, never the surface to match it.
    for (const [i, key] of ["review abstract", "survey figures"].entries()) {
      const actual = (seen.get(key)?.[0]?.tools ?? []).map((t) => t.name);
      expect([...(subtask.reports[i]?.allowedTools ?? [])].sort()).toEqual(
        [...actual].sort(),
      );
    }
    expect(subtask.reports[0]?.allowedTools).toContain("load_skill");
    expect(subtask.reports[1]?.allowedTools).not.toContain("load_skill");
  });

  it("an equipped child stays isolated — no parent prompt, no parent transcript, no sibling goal", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const { model, seen } = recordingByKey({
      "review the whole paper carefully": spawn([
        { goal: "review abstract", skills: ["concern-ledger"] },
        { goal: "survey figures" },
      ]),
      "review abstract": [{ text: "CL-1" }],
      "survey figures": [{ text: "figures" }],
    });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review the whole paper carefully",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });

    // R1's down payment on the stage's isolation claim — not the claim itself,
    // which R3 owns end to end.
    const child = JSON.stringify(seen.get("review abstract")?.[0]?.messages);
    expect(child).toContain("review abstract");
    expect(child).not.toContain("review the whole paper carefully");
    expect(child).not.toContain("survey figures");
    // The child's system prompt is the CHILD's: no fan-out paragraph, so it is
    // never told to do something its surface forbids.
    expect(systemOf(seen.get("review abstract")?.[0])).not.toContain(
      "spawn_subtask",
    );
  });

  it("/skill: in an equipped child's goal loads the body before its first turn (D5)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "parent", workspace: "/ws" });
    const { model, seen } = recordingByKey({
      review: spawn([
        {
          goal: "/skill:concern-ledger review abstract",
          skills: ["concern-ledger"],
        },
      ]),
      "/skill:concern-ledger review abstract": [{ text: "CL-1" }],
    });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "review",
      registry: twoToolRegistry(),
      skills: [LEDGER, TONE],
    });
    const first = seen.get("/skill:concern-ledger review abstract")?.[0];
    // ADR 0047's synthetic exchange, in a child, because its surface offers
    // skills. The mechanism is untouched; only what the gate lets through moved.
    expect(JSON.stringify(first?.messages)).toContain(
      "Prefix every concern id",
    );
    expect((first?.messages ?? []).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });
});
