import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ChatMessage,
  SessionItem,
  ToolName,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import { AnthropicModelAdapter } from "../../src/model/anthropic.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";
import { ScriptedModelAdapter } from "../../src/model/scripted.js";
import {
  buildConversationHistory,
  toolTrafficBudgetFor,
} from "../../src/session/compaction.js";
import { replayEntries } from "../../src/session/replay.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";
import { fakeFetch } from "../model/fake-fetch.js";

/**
 * B4 (ADR 0029) — tool traffic survives across tasks.
 *
 * Before B4, `plainHistory` mapped user and agent messages and dropped
 * everything else, so the SECOND message in a session began from prose alone:
 * "now continue the Methods section" reached a model with no record that the
 * granted codebase had ever been read (survey 2.6).
 *
 * The rule that makes it safe is turn-atomicity: a `tool_call` with no
 * matching `tool_result` is a history Anthropic rejects outright. Lemmaria is
 * structurally immune to the boundary version of that hazard — both halves
 * come from ONE persisted item — so the rule to enforce is narrower: any cap
 * drops a whole exchange, never one half.
 */

const dirs: string[] = [];
async function storeIn(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "lemmaria-b4-xtask-"));
  dirs.push(dir);
  return new SessionStore(dir);
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const user = (id: string, text: string): SessionItem => ({
  id,
  type: "user_message",
  text,
});
const agent = (id: string, text: string): SessionItem => ({
  id,
  type: "agent_message",
  text,
});
const call = (
  id: string,
  tool: ToolName,
  args: unknown,
  result: unknown,
  status: "completed" | "failed" = "completed",
): SessionItem => ({
  id,
  type: "tool_call",
  tool,
  argsJson: JSON.stringify(args),
  status,
  resultJson: JSON.stringify(result),
});

/**
 * The property the provider actually enforces: every call is answered, every
 * answer answers a call, and the answer follows its call.
 */
function assertNoOrphans(history: readonly ChatMessage[]): void {
  const answered = new Set<string>();
  const announced = new Set<string>();
  for (const [i, m] of history.entries()) {
    for (const c of m.toolCalls ?? []) {
      announced.add(c.id);
      const results = history
        .slice(i + 1)
        .filter((later) => later.role === "tool")
        .map((later) => later.toolCallId);
      expect(results, `call ${c.id} has no result after it`).toContain(c.id);
    }
    if (m.role === "tool") {
      expect(m.toolCallId, "a tool result with no call id").toBeDefined();
      expect(
        announced.has(m.toolCallId as string),
        `result ${m.toolCallId} answers no preceding call`,
      ).toBe(true);
      answered.add(m.toolCallId as string);
    }
  }
  expect([...announced].sort()).toEqual([...answered].sort());
}

describe("buildConversationHistory — tool traffic (B4)", () => {
  it("replays a completed tool call as an assistant call plus its result", () => {
    const items = [
      user("u1", "read the method"),
      agent("a1", "Reading."),
      call("t1", "read_span", { file: "m.tex" }, { text: "the method" }),
      agent("a2", "It uses X."),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    const withCalls = history.filter((m) => (m.toolCalls ?? []).length > 0);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0]?.toolCalls?.[0]).toMatchObject({
      name: "read_span",
      args: { file: "m.tex" },
    });
    const result = history.find((m) => m.role === "tool");
    expect(result?.content).toContain("the method");
    // The pairing id is the item's own — the provider's call id is not
    // persisted, and the pairing only has to be consistent within the request.
    expect(result?.toolCallId).toBe("t1");
    expect(withCalls[0]?.toolCalls?.[0]?.id).toBe("t1");
  });

  it("groups a run of consecutive calls into ONE assistant message (a B3 batch)", () => {
    const items = [
      user("u1", "read three sections"),
      call("t1", "read_span", { file: "a.tex" }, { text: "A" }),
      call("t2", "read_span", { file: "b.tex" }, { text: "B" }),
      call("t3", "read_span", { file: "c.tex" }, { text: "C" }),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    const withCalls = history.filter((m) => (m.toolCalls ?? []).length > 0);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0]?.toolCalls).toHaveLength(3);
    // Results follow in call order, the shape the batch actually had.
    expect(
      history.filter((m) => m.role === "tool").map((m) => m.toolCallId),
    ).toEqual(["t1", "t2", "t3"]);
  });

  it("replays a FAILED call too — the model must not re-issue what already failed", () => {
    const items = [
      user("u1", "read it"),
      call(
        "t1",
        "read_span",
        { file: "nope.tex" },
        { error: { code: "not_found", message: "no such file" } },
        "failed",
      ),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    expect(history.find((m) => m.role === "tool")?.content).toContain(
      "not_found",
    );
  });

  it("drops a call with no result, and a torn one, WHOLE — never half an exchange", () => {
    const items: SessionItem[] = [
      user("u1", "go"),
      // Interrupted mid-flight: announced, never answered.
      {
        id: "t1",
        type: "tool_call",
        tool: "read_span",
        argsJson: "{}",
        status: "in_progress",
      },
      // Terminal but resultless (a torn JSONL line replayed).
      {
        id: "t2",
        type: "tool_call",
        tool: "read_span",
        argsJson: "{}",
        status: "completed",
      },
      // Unparseable arguments.
      {
        id: "t3",
        type: "tool_call",
        tool: "read_span",
        argsJson: "{not json",
        status: "completed",
        resultJson: '{"text":"x"}',
      },
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    expect(history.some((m) => m.role === "tool")).toBe(false);
    expect(history.some((m) => (m.toolCalls ?? []).length > 0)).toBe(false);
  });

  it("keeps the NEWEST exchanges when the budget runs out, and drops whole ones", () => {
    const budget = toolTrafficBudgetFor("claude-sonnet-4-5");
    // Each result costs about a tenth of the budget, so most of 30 cannot fit.
    const fat = "x".repeat(budget * 4 * 0.1);
    const items: SessionItem[] = [user("u1", "go")];
    for (let i = 0; i < 30; i++)
      items.push(call(`t${i}`, "read_span", { i }, { text: fat }));
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    const kept = history
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId as string);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(30);
    // Newest-first: the last exchange always survives, the first does not.
    expect(kept).toContain("t29");
    expect(kept).not.toContain("t0");
    // ...and what survives is still in transcript order.
    expect(kept).toEqual(
      [...kept].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );
    // A contiguous SUFFIX, not a greedy fill (review, Important 3): a gap
    // would hand the model exchange 3 and exchange 30 with the middle
    // silently missing.
    const numbers = kept.map((id) => Number(id.slice(1)));
    expect(numbers).toEqual(
      Array.from(
        { length: numbers.length },
        (_, i) => 29 - numbers.length + 1 + i,
      ),
    );
  });

  it("prefers the newest exchange when only one of two can fit", () => {
    const budget = toolTrafficBudgetFor("claude-sonnet-4-5");
    // Two exchanges at ~60 % of the budget each: exactly one can be afforded.
    const big = "x".repeat(budget * 4 * 0.6);
    const items: SessionItem[] = [
      user("u1", "go"),
      call("old", "read_span", {}, { text: big }),
      call("newest", "read_span", {}, { text: big }),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    // Newest-first means the newest is never the one sacrificed for an older,
    // cheaper exchange — it is the one most likely to matter now.
    expect(
      history.filter((m) => m.role === "tool").map((m) => m.toolCallId),
    ).toEqual(["newest"]);
  });

  it("keeps tool traffic AFTER a compaction checkpoint and none before it", () => {
    const items: SessionItem[] = [
      user("u1", "the brief"),
      call("t1", "read_span", { file: "old.tex" }, { text: "old" }),
      {
        id: "c1",
        type: "compaction",
        summary: "we read old.tex",
        trigger: "auto",
        retainedItemIds: ["u1"],
        tokensBefore: 100,
      },
      user("u2", "carry on"),
      call("t2", "read_span", { file: "new.tex" }, { text: "new" }),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    const ids = history
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId);
    expect(ids).toEqual(["t2"]);
  });
});

describe("cross-task memory end to end (B4)", () => {
  const binding = {
    protocol: "anthropic" as const,
    endpoint: "https://anthropic.test",
    model: "claude-sonnet-4-5",
    apiKey: "k",
  };

  function readTool(): ToolExecutor {
    return {
      name: "read_span" as ToolName,
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "read_span" as ToolName,
        description: "read",
        parameters: { type: "object", properties: {} },
      },
      invoke: async () => ok({ file: "method.tex", text: "we train with SGD" }),
    };
  }

  const registry = (): Map<ToolName, ToolExecutor> =>
    new Map<ToolName, ToolExecutor>([["read_span" as ToolName, readTool()]]);
  const allowedTools = ["read_span" as ToolName];

  it("task 2's FIRST request carries task 1's tool result", async () => {
    const store = await storeIn();
    const session = await store.create({ title: "s", workspace: "/w" });

    const first = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "c1",
            name: "read_span" as ToolName,
            args: { file: "method.tex" },
          },
        ],
      },
      { text: "It trains with SGD." },
    ]);
    await runSessionTask({
      store,
      session,
      text: "what optimiser does the method use?",
      model: first,
      binding,
      registry: registry(),
      allowedTools,
    });

    const second = new ScriptedModelAdapter([{ text: "Continuing." }]);
    await runSessionTask({
      store,
      session,
      text: "now draft the Methods section",
      model: second,
      binding,
      registry: registry(),
      allowedTools,
    });

    // The whole point of the milestone, asserted on what the model RECEIVED.
    const sent = second.requests[0]?.messages ?? [];
    assertNoOrphans(sent);
    const results = sent.filter((m) => m.role === "tool");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("SGD");
    expect(
      sent.some((m) => (m.toolCalls ?? []).some((c) => c.name === "read_span")),
    ).toBe(true);
  });

  it("the rebuilt history is legal for both protocols", async () => {
    // The orphan rule is enforced by the provider, so assert it where the
    // provider would: on the payload the adapter actually posts.
    const store = await storeIn();
    const session = await store.create({ title: "s", workspace: "/w" });
    const first = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "c1", name: "read_span" as ToolName, args: { file: "a.tex" } },
          { id: "c2", name: "read_span" as ToolName, args: { file: "b.tex" } },
        ],
      },
      { text: "done" },
    ]);
    await runSessionTask({
      store,
      session,
      text: "read both",
      model: first,
      binding,
      registry: registry(),
      allowedTools,
    });
    const second = new ScriptedModelAdapter([{ text: "ok" }]);
    await runSessionTask({
      store,
      session,
      text: "continue",
      model: second,
      binding,
      registry: registry(),
      allowedTools,
    });

    const sent = second.requests[0]?.messages ?? [];

    // Anthropic: every tool_use block must be answered by a tool_result block
    // carrying its id, and the conversion throws outright on a tool message
    // with no call id.
    const anth = fakeFetch({
      id: "m",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicModelAdapter({ fetch: anth.fetchImpl }).generate({
      binding,
      messages: sent,
      maxTokens: 16,
    });
    const uses = new Set<string>();
    const answers = new Set<string>();
    for (const m of anth.captured[0]?.body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>) {
      for (const block of m.content) {
        if (block.type === "tool_use") uses.add(block.id as string);
        if (block.type === "tool_result")
          answers.add(block.tool_use_id as string);
      }
    }
    expect(uses.size).toBe(2);
    expect([...uses].sort()).toEqual([...answers].sort());

    // OpenAI-compatible: the same property, as tool_calls / tool_call_id.
    const oai = fakeFetch({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await new OpenAICompatibleModelAdapter({ fetch: oai.fetchImpl }).generate({
      binding: {
        protocol: "openai",
        endpoint: "https://openai.test",
        model: "gpt-test",
        apiKey: "k",
      },
      messages: sent,
      maxTokens: 16,
    });
    const calls = new Set<string>();
    const replies = new Set<string>();
    for (const m of oai.captured[0]?.body.messages as Array<
      Record<string, unknown>
    >) {
      for (const c of (m.tool_calls ?? []) as Array<{ id: string }>)
        calls.add(c.id);
      if (m.role === "tool") replies.add(m.tool_call_id as string);
    }
    expect(calls.size).toBe(2);
    expect([...calls].sort()).toEqual([...replies].sort());
  });
});

describe("B4's turn-atomicity survives the tree (B5, ADR 0027)", () => {
  it("a rebuilt BRANCH history still orphans no tool call", async () => {
    // B4's invariant is that no boundary may separate a `tool_call` from its
    // result. ADR 0027 introduced a new kind of boundary — the branch walk —
    // so the property is re-asserted over a history rebuilt from a session
    // that was actually rewound, not just from a flat log.
    const store = await storeIn();
    const session = await store.create({ title: "t", workspace: "/w" });
    const append = (item: SessionItem) =>
      store.append(session.id, { type: "item.completed", item });

    await append(user("u1", "read the method"));
    await append(call("t1", "read_span", { section: "Method" }, "…method…"));
    await append(agent("a1", "Read it."));
    // A second exchange the user will rewind away.
    await append(user("u2", "now the experiments"));
    await append(call("t2", "read_span", { section: "Experiments" }, "…exp…"));
    await append(agent("a2", "Read that too."));

    const child = await store.fork(session.id, { cutBeforeItemId: "u2" });
    const appendChild = (item: SessionItem) =>
      store.append(child.id, { type: "item.completed", item });
    await appendChild(user("u3", "actually, the related work"));
    await appendChild(
      call("t3", "grep_project", { query: "cite" }, "3 matches"),
    );

    const loaded = await store.load(child.id);
    const history = buildConversationHistory(loaded.items, "claude-sonnet-4-5");
    assertNoOrphans(history);
    // The conversation really did diverge — otherwise this passes vacuously.
    const toolResults = history
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId);
    expect(toolResults).toContain("t1");
    expect(toolResults).toContain("t3");
    expect(toolResults).not.toContain("t2");

    // ...and the abandoned SESSION's own history is well-formed too, which is
    // what the Sessions view renders when the user goes back to it.
    assertNoOrphans(
      buildConversationHistory(
        replayEntries((await store.load(session.id)).entries),
        "claude-sonnet-4-5",
      ),
    );
  });
});
