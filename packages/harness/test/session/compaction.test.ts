import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ModelAdapter,
  ModelBinding,
  SessionEvent,
  SessionItem,
  ToolName,
} from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import { ScriptedModelAdapter } from "../../src/model/scripted.js";
import {
  SUMMARY_PREFIX,
  buildConversationHistory,
  estimateTokens,
  liveTurnUsage,
  retainBudgetFor,
  runSessionCompaction,
  sanitizeForSummarization,
  selectRetainedMessageIds,
  summarizeForCompaction,
  truncateToTokens,
} from "../../src/session/compaction.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";
import { sumSessionUsage } from "../../src/session/usage.js";
import { linearEntries } from "../support/entries.js";

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
/** The `tool_call` item a `/skill:` invocation now emits (E1, ADR 0047). */
const skillExchange = (
  id: string,
  name: string,
  body: string,
): SessionItem => ({
  id,
  type: "tool_call",
  tool: "load_skill",
  argsJson: JSON.stringify({ name }),
  status: "completed",
  resultJson: JSON.stringify({ name, source: "project", text: body }),
});
const compaction = (
  id: string,
  summary: string,
  retainedItemIds: string[],
): SessionItem => ({
  id,
  type: "compaction",
  summary,
  trigger: "auto",
  retainedItemIds,
  tokensBefore: 100,
});

describe("estimateTokens", () => {
  it("counts CJK characters as one token each", () => {
    // Bilingual first-class (invariant 6): a flat /4 heuristic under-counts
    // Chinese roughly fourfold and would let a CN session blow the window.
    expect(estimateTokens("中文摘要")).toBe(4);
  });

  it("counts non-CJK text at roughly four characters per token", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("adds the two bases for mixed text", () => {
    expect(estimateTokens("中文abcd")).toBe(3);
  });

  it("is zero for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts CJK punctuation and fullwidth forms as CJK too (review)", () => {
    // A punctuation-dense Chinese message would otherwise bill at ~4 chars
    // per token — exactly the under-count the CJK handling exists to prevent.
    expect(estimateTokens("，。《》")).toBe(4);
    expect(estimateTokens("？！：")).toBe(3);
  });
});

describe("truncateToTokens", () => {
  it("returns short text unchanged", () => {
    expect(truncateToTokens("hello", 100)).toBe("hello");
  });

  it("cuts to the cap and marks the cut in ONE language (ADR 0034)", () => {
    // English: the mark is spliced into history the MODEL reads, never
    // rendered to a reader, and no SessionLocale is in scope at the splice.
    const out = truncateToTokens("a".repeat(400), 10);
    expect(out.endsWith(" …[truncated]")).toBe(true);
    expect(out).not.toMatch(/[一-鿿]/);
    expect(out.length).toBeLessThan(400);
  });

  it("cuts CJK text by characters, not by bytes", () => {
    const out = truncateToTokens("中".repeat(100), 5);
    expect(out.startsWith("中中中中中 ")).toBe(true);
  });
});

describe("retainBudgetFor", () => {
  it("is a tenth of the model's context window", () => {
    expect(retainBudgetFor("claude-sonnet-5")).toBe(20_000);
  });

  it("falls back to a tenth of the default window for unknown models", () => {
    expect(retainBudgetFor("some-local-model")).toBe(12_800);
  });
});

describe("selectRetainedMessageIds", () => {
  it("keeps only user messages, in transcript order", () => {
    const items = [
      user("u1", "brief"),
      agent("a1", "x".repeat(4000)),
      user("u2", "second"),
      user("u3", "third"),
    ];
    expect(selectRetainedMessageIds(items, 1000)).toEqual(["u1", "u2", "u3"]);
  });

  it("pins the session's first user message even when the budget is spent", () => {
    const items = [
      user("u1", "the paper brief"),
      user("u2", "x".repeat(4000)),
      user("u3", "y".repeat(4000)),
    ];
    const kept = selectRetainedMessageIds(items, 1200);
    expect(kept[0]).toBe("u1");
    expect(kept).not.toContain("u2");
    expect(kept).toContain("u3");
  });

  it("is empty when there are no user messages", () => {
    expect(selectRetainedMessageIds([agent("a1", "hi")], 1000)).toEqual([]);
  });

  it("never returns the same id twice when the session has one message", () => {
    expect(selectRetainedMessageIds([user("u1", "only")], 1000)).toEqual([
      "u1",
    ]);
  });
});

describe("buildConversationHistory", () => {
  it("maps user and agent messages when nothing was compacted (A1a behaviour)", () => {
    const history = buildConversationHistory(
      [user("u1", "hello"), agent("a1", "hi"), user("u2", "more")],
      "claude-sonnet-5",
    );
    expect(history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "more" },
    ]);
  });

  it("drops every item before the checkpoint except the retained user messages", () => {
    const items = [
      user("u1", "write the methods section"),
      agent("a1", "long draft that no longer fits"),
      user("u2", "shorter, please"),
      compaction("c1", "Drafted methods; user wants it shorter.", ["u1"]),
      user("u3", "now do results"),
      agent("a2", "results draft"),
    ];
    expect(buildConversationHistory(items, "claude-sonnet-5")).toEqual([
      { role: "user", content: "write the methods section" },
      {
        role: "user",
        content: `${SUMMARY_PREFIX}Drafted methods; user wants it shorter.`,
      },
      { role: "user", content: "now do results" },
      { role: "assistant", content: "results draft" },
    ]);
  });

  it("honours only the NEWEST checkpoint when a session compacted twice", () => {
    const items = [
      user("u1", "brief"),
      compaction("c1", "first summary", ["u1"]),
      user("u2", "keep going"),
      compaction("c2", "second summary", ["u2"]),
      user("u3", "and again"),
    ];
    expect(
      buildConversationHistory(items, "claude-sonnet-5").map((m) => m.content),
    ).toEqual(["keep going", `${SUMMARY_PREFIX}second summary`, "and again"]);
  });

  it("a /skill: exchange AFTER the checkpoint keeps its body (E1)", () => {
    // E1 (ADR 0047) puts the `/skill:` body in a `tool_call` item, so it now
    // rides ADR 0021's retention like any other tool traffic. After the
    // checkpoint it is ordinary post-checkpoint history and survives whole.
    const items = [
      user("u1", "brief"),
      compaction("c1", "earlier work", ["u1"]),
      user("u2", "/skill:tone fix it"),
      skillExchange("t1", "tone", "ALWAYS use active voice."),
      user("u3", "fix it"),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-5");
    expect(JSON.stringify(history)).toContain("ALWAYS use active voice.");
    expect(
      history.some((m) => m.role === "assistant" && m.toolCalls?.length === 1),
    ).toBe(true);
  });

  it("a /skill: exchange BEFORE the checkpoint is carried by the summary, not the body (E1)", () => {
    // The honest behaviour, asserted rather than assumed. This is strictly
    // better than what ADR 0028 §D6 did — where the body was lost on the FIRST
    // resume — but it is not permanence, and ADR 0047 records that rather than
    // letting a user discover it: the model still has the catalogue in every
    // envelope and can re-load.
    const items = [
      user("u1", "/skill:tone fix it"),
      skillExchange("t1", "tone", "ALWAYS use active voice."),
      agent("a1", "done"),
      compaction("c1", "applied the tone skill", ["u1"]),
      user("u2", "now the results"),
    ];
    const history = buildConversationHistory(items, "claude-sonnet-5");
    expect(JSON.stringify(history)).not.toContain("ALWAYS use active voice.");
    expect(JSON.stringify(history)).toContain("applied the tone skill");
    // The user's typed text is retained, so the summary is not the only trace.
    expect(history.some((m) => m.content === "/skill:tone fix it")).toBe(true);
  });

  it("skips retained ids whose items are gone (a rewind removed them)", () => {
    const items = [compaction("c1", "s", ["u-missing"]), user("u9", "next")];
    expect(buildConversationHistory(items, "claude-sonnet-5")).toEqual([
      { role: "user", content: `${SUMMARY_PREFIX}s` },
      { role: "user", content: "next" },
    ]);
  });
});

describe("liveTurnUsage", () => {
  const turn = (n: number, inputTokens: number): SessionEvent => ({
    type: "turn.completed",
    turn: n,
    usage: { inputTokens, outputTokens: 0 },
  });

  const usageOf = (events: readonly SessionEvent[]) =>
    liveTurnUsage(linearEntries(events));

  it("returns the last completed turn's usage", () => {
    expect(usageOf([turn(1, 10), turn(2, 20)])?.inputTokens).toBe(20);
  });

  it("ignores a huge turn the user rewound past (ADR 0018, now ADR 0057)", () => {
    // Same outcome, different mechanism: there is no `rewound` event any more,
    // and since ADR 0057 no branch either. The 190k turn is in the SESSION the
    // user left, so the fold over the one they are in never sees it — which is
    // what keeps rewinding a full window an actual remedy.
    const root = linearEntries([turn(1, 1)]);
    const abandoned = { id: "x", event: turn(2, 190_000) };
    const kept = { id: "y", event: turn(3, 500) };
    expect(liveTurnUsage([...root, kept])?.inputTokens).toBe(500);
    // ...and the abandoned session really does carry the huge turn.
    expect(liveTurnUsage([...root, abandoned])?.inputTokens).toBe(190_000);
  });

  it("ignores turns before a compaction checkpoint (A2)", () => {
    // Nothing has been measured since the checkpoint: occupancy is UNKNOWN,
    // not "still 190k" — otherwise every later task would re-compact.
    expect(
      usageOf([
        turn(1, 190_000),
        { type: "item.completed", item: compaction("c1", "summary", ["u1"]) },
      ]),
    ).toBeUndefined();
  });

  it("is undefined for a session that has never completed a turn", () => {
    expect(usageOf([{ type: "task.started" }])).toBeUndefined();
  });
});

describe("summarizeForCompaction", () => {
  const binding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://example.invalid",
    model: "claude-sonnet-5",
    apiKey: "k",
  };

  it("asks the model with the compaction prompt appended and returns the summary", async () => {
    const model = new ScriptedModelAdapter([{ text: "HANDOFF" }]);
    const out = await summarizeForCompaction({
      messages: [
        { role: "system", content: "envelope" },
        { role: "user", content: "write §3" },
      ],
      model,
      binding,
    });
    expect(out.summary).toBe("HANDOFF");
    expect(out.error).toBeUndefined();
    expect(out.usage?.outputTokens).toBe(5);
    const sent = model.requests.at(-1);
    expect(sent?.messages.at(-1)?.role).toBe("user");
    expect(sent?.messages.at(-1)?.content).toContain("handoff summary");
    expect(sent?.messages.at(0)?.content).toBe("envelope");
    // No tools: compaction is a plain summarization round-trip.
    expect(sent?.tools ?? []).toEqual([]);
    expect(sent?.maxTokens).toBe(1024);
  });

  it("reports a stream failure as data instead of throwing", async () => {
    const model = new ScriptedModelAdapter([
      { text: "never", failure: { message: "boom", times: 9 } },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
    });
    expect(out.summary).toBeUndefined();
    expect(out.error).toContain("boom");
  });

  it("treats an empty summary as a failure", async () => {
    const model = new ScriptedModelAdapter([{ text: "   " }]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
    });
    expect(out.summary).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  it("treats a summary cut off at the output cap as a failure", async () => {
    // A checkpoint is PERSISTED and every later reader derives the model's
    // history from it, so half a sentence must never become one.
    const model = new ScriptedModelAdapter([
      {
        text: "So far §1 and §2 are drafted, and the user asked that the",
        stopReason: "max_tokens",
      },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
    });
    expect(out.summary).toBeUndefined();
    expect(out.error).toBeDefined();
    // The usage is still reported: the attempt was paid for either way.
    expect(out.usage).toBeDefined();
  });

  it("reports an aborted request as data", async () => {
    const model = new ScriptedModelAdapter([{ text: "later" }]);
    const controller = new AbortController();
    controller.abort();
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
      signal: controller.signal,
    });
    expect(out.summary).toBeUndefined();
    expect(out.error).toBeDefined();
  });
});

describe("runSessionCompaction (manual)", () => {
  const binding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://example.invalid",
    model: "claude-sonnet-5",
    apiKey: "k",
  };
  const temps: string[] = [];
  const mkStore = async (): Promise<SessionStore> => {
    const d = await mkdtemp(join(tmpdir(), "lemmaria-compaction-"));
    temps.push(d);
    return new SessionStore(join(d, "sessions"));
  };
  afterAll(async () => {
    for (const d of temps) await rm(d, { recursive: true, force: true });
  });

  it("appends a manual checkpoint and streams it to the sink", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    for (const item of [user("u1", "write §3"), agent("a1", "long draft")])
      await store.append(session.id, { type: "item.completed", item });

    const events: SessionEvent[] = [];
    const model = new ScriptedModelAdapter([{ text: "SUMMARY" }]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
      onEvent: (e) => events.push(e),
    });

    expect(out.ok).toBe(true);
    expect(out.item).toMatchObject({
      trigger: "manual",
      summary: "SUMMARY",
      tokensBefore: 0,
    });
    expect(
      events.some(
        (e) => e.type === "item.completed" && e.item.type === "compaction",
      ),
    ).toBe(true);
    const items = (await store.load(session.id)).items;
    expect(items.at(-1)?.type).toBe("compaction");
    // The next task would now see the summary, not the long draft.
    expect(
      buildConversationHistory(items, binding.model).some((m) =>
        m.content.includes("long draft"),
      ),
    ).toBe(false);
  });

  // Summarization reads the whole conversation, so it is the slowest single
  // call in the app — and until the D4 manual round the transcript said
  // nothing at all until it returned, so the user could not tell work from a
  // hang. The progress row is live-only and is replaced in place, by id.
  it("announces that it started, live-only, before the model call", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "write §3"),
    });
    const events: SessionEvent[] = [];
    const model = new ScriptedModelAdapter([{ text: "SUMMARY" }]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
      onEvent: (e) => events.push(e),
    });
    expect(out.ok).toBe(true);

    const started = events.find(
      (e) => e.type === "item.started" && e.item.type === "compaction",
    );
    const completed = events.find(
      (e) => e.type === "item.completed" && e.item.type === "compaction",
    );
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    // Progress first, then the checkpoint — and the SAME id, so the finished
    // card replaces the progress row rather than stacking under it.
    expect(events.indexOf(started as SessionEvent)).toBeLessThan(
      events.indexOf(completed as SessionEvent),
    );
    const startedItem = (started as { item: SessionItem }).item;
    const completedItem = (completed as { item: SessionItem }).item;
    expect(startedItem.id).toBe(completedItem.id);
    expect(startedItem.type === "compaction" && startedItem.status).toBe(
      "running",
    );
    expect(completedItem.type === "compaction" && completedItem.status).toBe(
      undefined,
    );
    // Live-only: nothing transient reached the JSONL.
    const persisted = (await store.load(session.id)).items.filter(
      (i) => i.type === "compaction",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type === "compaction" && persisted[0].status).toBe(
      undefined,
    );
  });

  it("clears the progress row when summarization fails", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "hi"),
    });
    const events: SessionEvent[] = [];
    const model = new ScriptedModelAdapter([
      { text: "never", failure: { message: "nope", times: 9 } },
    ]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
      onEvent: (e) => events.push(e),
    });
    expect(out.ok).toBe(false);
    const last = events.filter(
      (e) =>
        (e.type === "item.started" || e.type === "item.updated") &&
        e.item.type === "compaction",
    );
    expect(last).toHaveLength(2);
    const final = (last[1] as { item: SessionItem }).item;
    expect(final.type === "compaction" && final.status).toBe("failed");
    // A failed compaction is not a checkpoint: nothing persisted, so a resumed
    // session cannot find a summary that was never written.
    expect(
      (await store.load(session.id)).items.some((i) => i.type === "compaction"),
    ).toBe(false);
  });

  it("persists what the summarization cost, so the session fold sees it", async () => {
    // The summarization is a real, paid model call — and one that reads the
    // whole conversation, so rarely a cheap one. Discarding `outcome.usage`
    // made `Lemmaria: Compact Session` the one way to spend money in this app
    // that no cost surface ever reported.
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "write §3"),
    });
    const model = new ScriptedModelAdapter([
      { text: "SUMMARY", usage: { inputTokens: 900, outputTokens: 40 } },
    ]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
    });
    expect(out.ok).toBe(true);
    expect(out.item?.usage).toEqual({ inputTokens: 900, outputTokens: 40 });
    const persisted = (await store.load(session.id)).items.at(-1);
    expect(persisted?.type === "compaction" && persisted.usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
    });
    expect(
      sumSessionUsage((await store.load(session.id)).entries),
    ).toMatchObject({ inputTokens: 900, outputTokens: 40 });
  });

  it("reports a failure as data and writes nothing", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "hi"),
    });
    const model = new ScriptedModelAdapter([
      { text: "never", failure: { message: "nope", times: 9 } },
    ]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("nope");
    expect(
      (await store.load(session.id)).items.some((i) => i.type === "compaction"),
    ).toBe(false);
  });

  it("refuses to append when the transcript changed during the model call (review — concurrency)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "write §3"),
    });
    await store.append(session.id, {
      type: "item.completed",
      item: agent("a1", "draft"),
    });
    // A model that lets a concurrent turn land WHILE it is "thinking".
    const model: ModelAdapter = {
      protocol: "anthropic",
      generate: () => {
        throw new Error("unused");
      },
      generateStream: async function* () {
        await store.append(session.id, {
          type: "item.completed",
          item: user("u2", "actually, change the title"),
        });
        await store.append(session.id, {
          type: "item.completed",
          item: agent("a2", "retitled"),
        });
        yield {
          type: "completed" as const,
          result: {
            text: "SUMMARY",
            toolCalls: [],
            stopReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
    };
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/changed/);
    // No checkpoint was written, so the concurrent turn survives model history.
    const items = (await store.load(session.id)).items;
    expect(items.some((i) => i.type === "compaction")).toBe(false);
    expect(
      buildConversationHistory(items, binding.model).some(
        (m) => m.content === "retitled",
      ),
    ).toBe(true);
  });

  it("refuses to compact an empty conversation", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "S" }]);
    const out = await runSessionCompaction({
      store,
      sessionId: session.id,
      model,
      binding,
    });
    expect(out.ok).toBe(false);
    expect(model.requests).toHaveLength(0);
  });
});

describe("resume after a restart (A2)", () => {
  const binding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://example.invalid",
    model: "claude-sonnet-4-5",
    apiKey: "k",
  };
  /** Occupancy past 90% of the 200k `claude` window. */
  const overLimit = { inputTokens: 185_000, outputTokens: 1000 };
  const temps: string[] = [];
  const mkDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "lemmaria-resume-"));
    temps.push(d);
    return join(d, "sessions");
  };
  afterAll(async () => {
    for (const d of temps) await rm(d, { recursive: true, force: true });
  });

  const readSpanRegistry = (): Map<ToolName, ToolExecutor> => {
    const registry = new Map<ToolName, ToolExecutor>();
    registry.set("read_span", {
      name: "read_span",
      category: "retrieval",
      spec: {
        name: "read_span",
        description: "read a section",
        parameters: { type: "object" },
      },
      invoke: async () => ({ content: "section text" }),
    });
    return registry;
  };

  it("a compacted session resumes from a fresh store with identical state", async () => {
    const dir = await mkDir();
    const store = new SessionStore(dir);
    const session = await store.create({
      title: "long paper",
      workspace: "/w",
    });

    // --- window 1: a task that crosses the threshold and compacts ---
    const model1 = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: {} }],
        usage: overLimit,
      },
      { text: "HANDOFF: §3 drafted; next §4." },
      { text: "§3 is drafted.", usage: { inputTokens: 800, outputTokens: 20 } },
    ]);
    const first = await runSessionTask({
      store,
      session,
      model: model1,
      binding,
      text: "write §3",
      registry: readSpanRegistry(),
    });
    expect(first.items.some((i) => i.type === "compaction")).toBe(true);

    // --- simulated restart: a brand-new store over the same directory ---
    const reopened = new SessionStore(dir);
    expect((await reopened.list()).map((s) => s.meta.id)).toContain(session.id);
    const loaded = await reopened.load(session.id);
    expect(loaded.items).toEqual(first.items);

    // --- window 2: a fresh task on the resumed session ---
    const model2 = new ScriptedModelAdapter([
      { text: "§4 drafted.", usage: { inputTokens: 900, outputTokens: 30 } },
    ]);
    const second = await runSessionTask({
      store: reopened,
      session: loaded.meta,
      model: model2,
      binding,
      text: "now write §4",
    });

    expect(second.status).toBe("completed");
    const sent = model2.requests.at(-1)?.messages ?? [];
    // The resumed session carries its compaction state: the model sees the
    // summary, the pinned brief, and the post-checkpoint turns — never the
    // pre-checkpoint tool traffic, and never a SECOND compaction request.
    expect(
      sent.filter((m) => m.content.startsWith(SUMMARY_PREFIX)),
    ).toHaveLength(1);
    expect(sent.some((m) => m.content === "write §3")).toBe(true);
    expect(sent.at(-1)?.content).toBe("now write §4");
    expect(second.items.filter((i) => i.type === "compaction")).toHaveLength(1);
    expect(model2.requests).toHaveLength(1);
  });

  it("the automatic threshold crossing announces itself too", async () => {
    // The auto path is the more confusing of the two: it fires unprompted,
    // mid-task, while the user is already waiting on a turn — so a silent
    // pause there reads as a hang (D4 manual round).
    const dir = await mkDir();
    const store = new SessionStore(dir);
    const session = await store.create({ title: "p", workspace: "/w" });
    const events: SessionEvent[] = [];
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: {} }],
        usage: overLimit,
      },
      { text: "HANDOFF: §3 drafted." },
      { text: "§3 is drafted." },
    ]);
    const out = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "write §3",
      registry: readSpanRegistry(),
      onEvent: (e) => events.push(e),
    });
    expect(out.status).toBe("completed");

    const compactionEvents = events.filter(
      (e) =>
        (e.type === "item.started" ||
          e.type === "item.updated" ||
          e.type === "item.completed") &&
        e.item.type === "compaction",
    );
    expect(compactionEvents.map((e) => e.type)).toEqual([
      "item.started",
      "item.completed",
    ]);
    const [started, completed] = compactionEvents as Array<{
      item: SessionItem;
    }>;
    // Same id, so the checkpoint card replaces the progress row in place…
    expect(started?.item.id).toBe(completed?.item.id);
    expect(started?.item.type === "compaction" && started.item.status).toBe(
      "running",
    );
    expect(started?.item.type === "compaction" && started.item.trigger).toBe(
      "auto",
    );
    // …and only the checkpoint is a checkpoint: the progress row never
    // reached the JSONL, so `buildConversationHistory` cannot mistake it for
    // one and collapse the conversation against an empty summary.
    const persisted = (await store.load(session.id)).items.filter(
      (i) => i.type === "compaction",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type === "compaction" && persisted[0].status).toBe(
      undefined,
    );
  });

  it("a resumed, compacted session still knows which files the work touched (B4)", async () => {
    const dir = await mkDir();
    const store = new SessionStore(dir);
    const session = await store.create({ title: "paper", workspace: "/w" });

    const model1 = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "read_span", args: { file: "m.tex" } }],
        usage: overLimit,
      },
      { text: "HANDOFF: read the method." },
      { text: "done.", usage: { inputTokens: 800, outputTokens: 20 } },
    ]);
    const registry = new Map<ToolName, ToolExecutor>();
    registry.set("read_span" as ToolName, {
      name: "read_span" as ToolName,
      category: "retrieval",
      spec: {
        name: "read_span",
        description: "read a section",
        parameters: { type: "object" },
      },
      invoke: async () => ok({ file: "method.tex", text: "section text" }),
    });
    const first = await runSessionTask({
      store,
      session,
      model: model1,
      binding,
      text: "summarise the method",
      registry,
      allowedTools: ["read_span" as ToolName],
    });
    expect(first.items.some((i) => i.type === "compaction")).toBe(true);

    // Restart, then a fresh task on the resumed session.
    const reopened = new SessionStore(dir);
    const loaded = await reopened.load(session.id);
    const model2 = new ScriptedModelAdapter([{ text: "ok" }]);
    await runSessionTask({
      store: reopened,
      session: loaded.meta,
      model: model2,
      binding,
      text: "carry on",
    });

    // Compaction dropped the tool traffic (ADR 0021 §3), so WITHOUT this the
    // resumed model has no record of method.tex beyond whatever the summary
    // happened to say — and a summary is a model artifact, not a fact.
    const summary = (model2.requests.at(-1)?.messages ?? []).find((m) =>
      m.content.startsWith(SUMMARY_PREFIX),
    );
    expect(summary?.content).toContain("method.tex");
    expect(summary?.content).toContain("<files-read>");
  });

  it("a resumed session starts a fresh task, never a mid-task loop", async () => {
    const dir = await mkDir();
    const store = new SessionStore(dir);
    const session = await store.create({ title: "t", workspace: "/w" });
    // A window that died mid-task: task.started with no task.completed.
    await store.append(session.id, { type: "task.started" });
    await store.append(session.id, {
      type: "item.completed",
      item: user("u1", "half-finished"),
    });

    const reopened = new SessionStore(dir);
    const loaded = await reopened.load(session.id);
    const model = new ScriptedModelAdapter([{ text: "fresh" }]);
    const out = await runSessionTask({
      store: reopened,
      session: loaded.meta,
      model,
      binding,
      text: "carry on",
    });
    expect(out.status).toBe("completed");
    expect(out.items.map((i) => i.type)).toEqual([
      "user_message",
      "user_message",
      "agent_message",
    ]);
  });
});

describe("summarizeForCompaction — request hygiene and resilience (review)", () => {
  const binding: ModelBinding = {
    protocol: "anthropic",
    endpoint: "https://example.invalid",
    model: "claude-sonnet-5",
    apiKey: "k",
  };

  it("never sends tool_use / tool_result traffic to the summarizer", async () => {
    // A summarization request carries no `tools`, so a provider that requires
    // tool blocks to be accompanied by a tools definition (Anthropic) would
    // reject the whole request — killing the mid-loop compaction path.
    const model = new ScriptedModelAdapter([{ text: "S" }]);
    await summarizeForCompaction({
      messages: [
        { role: "system", content: "envelope" },
        { role: "user", content: "write §3" },
        {
          role: "assistant",
          content: "reading the file",
          toolCalls: [{ id: "c1", name: "read_span", args: {} }],
          reasoning: { signed: "block" },
        },
        { role: "tool", content: '{"content":"…"}', toolCallId: "c1" },
        { role: "assistant", content: "drafted" },
      ],
      model,
      binding,
    });
    const sent = model.requests.at(-1)?.messages ?? [];
    expect(sent.some((m) => m.role === "tool")).toBe(false);
    expect(sent.some((m) => m.toolCalls !== undefined)).toBe(false);
    expect(sent.some((m) => m.reasoning !== undefined)).toBe(false);
    // The narration survives — it is what the summary is built from.
    expect(sent.some((m) => m.content === "reading the file")).toBe(true);
    expect(sent.some((m) => m.content === "drafted")).toBe(true);
  });

  it("stays tool-free on a history BUILT by buildConversationHistory (B4)", async () => {
    // Before B4 this guard was belt-and-braces: buildConversationHistory could
    // not produce tool traffic, so the summarizer could not receive any. Now
    // it can, and sanitizeForSummarization is the only thing standing between
    // a compaction and a provider rejecting the request outright.
    const history = buildConversationHistory(
      [
        user("u1", "write §3"),
        agent("a1", "reading"),
        {
          id: "t1",
          type: "tool_call",
          tool: "read_span" as ToolName,
          argsJson: '{"file":"m.tex"}',
          status: "completed",
          resultJson: '{"text":"body"}',
        },
        agent("a2", "drafted"),
      ],
      "claude-sonnet-5",
    );
    expect(history.some((m) => m.role === "tool")).toBe(true);
    const model = new ScriptedModelAdapter([{ text: "S" }]);
    await summarizeForCompaction({ messages: history, model, binding });
    const sent = model.requests.at(-1)?.messages ?? [];
    expect(sent.some((m) => m.role === "tool")).toBe(false);
    expect(sent.some((m) => m.toolCalls !== undefined)).toBe(false);
  });

  it("drops an assistant turn that was only a tool call (no empty content blocks)", async () => {
    const model = new ScriptedModelAdapter([{ text: "S" }]);
    await summarizeForCompaction({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_span", args: {} }],
        },
      ],
      model,
      binding,
    });
    const sent = model.requests.at(-1)?.messages ?? [];
    expect(sent.some((m) => m.role === "assistant")).toBe(false);
  });

  it("retries after a transient stream failure", async () => {
    // A network blip at the threshold crossing must not end a long session
    // with the honest stop the loop's own turns would have retried past.
    const model = new ScriptedModelAdapter([
      { text: "SUMMARY", failure: { message: "socket hang up", times: 1 } },
    ]);
    const slept: number[] = [];
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
      sleep: async (ms) => {
        slept.push(ms);
        return true;
      },
    });
    expect(out.summary).toBe("SUMMARY");
    // B2: it backs off now, on the same default policy the turn loop uses.
    expect(slept).toHaveLength(1);
  });

  it("keeps retrying to the policy's limit before giving up (B2)", async () => {
    // Before B2 compaction had ONE immediate retry, hand-rolled beside the
    // loop's. Both now read the same RetryPolicy, so they cannot drift.
    const model = new ScriptedModelAdapter([
      { text: "SUMMARY", failure: { message: "terminated", times: 2 } },
    ]);
    const slept: number[] = [];
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
      sleep: async (ms) => {
        slept.push(ms);
        return true;
      },
    });
    expect(out.summary).toBe("SUMMARY");
    expect(model.requests).toHaveLength(3);
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0] ?? 0);
  });

  it("honours a caller-supplied policy, including one that disables retry (B2)", async () => {
    const model = new ScriptedModelAdapter([
      { text: "never", failure: { message: "socket hang up", times: 9 } },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
      retry: {
        enabled: false,
        maxRetries: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });
    expect(out.summary).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("does not retry a non-transient failure", async () => {
    const model = new ScriptedModelAdapter([
      {
        text: "never",
        failure: { message: "bad request", status: 400, times: 9 },
      },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
    });
    expect(out.summary).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("does not retry a quota refusal, however transient it looks (B2)", async () => {
    const model = new ScriptedModelAdapter([
      {
        text: "never",
        failure: {
          message: "rate_limit_error: insufficient_quota",
          status: 429,
          times: 9,
        },
      },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
    });
    expect(out.summary).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("stops backing off when the user interrupts mid-wait (B2)", async () => {
    const model = new ScriptedModelAdapter([
      { text: "SUMMARY", failure: { message: "socket hang up", times: 9 } },
    ]);
    const out = await summarizeForCompaction({
      messages: [{ role: "user", content: "x" }],
      model,
      binding,
      // An aborted wait resolves false; compaction must give up rather than
      // loop straight into the next attempt.
      sleep: async () => false,
    });
    expect(out.summary).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });
});

describe("selectRetainedMessageIds — checkpoint scoping (review)", () => {
  it("never resurrects user messages an earlier checkpoint already dropped", () => {
    const items = [
      user("u1", "the original brief"),
      user("u2", "dropped by the first checkpoint"),
      compaction("c1", "first summary", ["u1"]),
      user("u3", "after the first checkpoint"),
    ];
    // Forgetting must be monotone: the summary was written from a history
    // that no longer contained u2, so a later checkpoint cannot re-inject it.
    const kept = selectRetainedMessageIds(items, 20_000);
    expect(kept).not.toContain("u2");
    expect(kept).toContain("u3");
  });
});

describe("compaction never carries an image (V3, ADR 0080 §5)", () => {
  it("sanitizeForSummarization drops every tool message, so its output has no images at all", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "look",
        images: [{ mimeType: "image/png", data: "AAA=", label: "page 1" }],
      },
      { role: "assistant", content: "seen" },
      {
        role: "tool",
        content: '{"pages":[1]}',
        toolCallId: "c1",
        images: [{ mimeType: "image/png", data: "BBB=", label: "page 1" }],
      },
    ];
    const sanitized = sanitizeForSummarization(messages);
    // It rebuilds each message as {role, content} — images cannot survive,
    // by construction rather than by a filter someone must remember.
    expect(sanitized.every((m) => m.images === undefined)).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("AAA=");
    expect(sanitized.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("a history REBUILT from items carries no images, which is the same thing as everything evicted", () => {
    const items: SessionItem[] = [
      { id: "i1", type: "user_message", text: "look at page 1" },
      {
        id: "i2",
        type: "tool_call",
        tool: "view_pdf_pages",
        argsJson: '{"pages":[1]}',
        status: "completed",
        resultJson: '{"pages":[{"page":1}],"pageCount":1,"viewsRemaining":59}',
      },
      { id: "i3", type: "agent_message", text: "I see the marker." },
    ];
    const rebuilt = buildConversationHistory(items, "gpt-5.6-luna");
    expect(rebuilt.every((m) => m.images === undefined)).toBe(true);
    // And the JSON the tool returned is still there, so the model can still
    // read which pages it was shown — that is what makes the rebuild honest.
    expect(JSON.stringify(rebuilt)).toContain("viewsRemaining");
  });
});
