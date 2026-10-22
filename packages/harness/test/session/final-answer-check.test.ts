import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelBinding, SessionItem } from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import type { ToolName } from "../../src/contracts/tools.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import { ScriptedModelAdapter } from "../../src/model/scripted.js";
import { runSessionTask } from "../../src/session/run.js";
import { SessionStore } from "../../src/session/store.js";

/**
 * R3 (ADR 0061 §6): a task whose final answer fails a shape check is handed
 * the check's own words back INSIDE its own loop, once.
 *
 * The mechanism is deliberately not a new loop branch: the check runs on
 * `shouldStopAfterTurn`'s would-complete branch, and its feedback drains
 * through the steering seam the loop already has — so it is a real, persisted
 * `user_message {steered: true}` that a resumed session replays, rather than a
 * message that exists only in one live request. These tests assert that from
 * the outside: the transcript, the model's own view, and the bound.
 */

const temps: string[] = [];
async function mkStore(): Promise<SessionStore> {
  const d = await mkdtemp(join(tmpdir(), "lemmaria-final-answer-"));
  temps.push(d);
  return new SessionStore(join(d, "sessions"));
}
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};

/** A check that refuses anything that is not the literal `"ok"`. */
const wantsOk = (text: string): string | undefined =>
  text.trim() === "ok"
    ? undefined
    : `expected "ok", got ${JSON.stringify(text)}`;

const steered = (items: SessionItem[]): string[] =>
  items
    .filter((i) => i.type === "user_message" && i.steered === true)
    .map((i) => (i as { text: string }).text);

const agentText = (items: SessionItem[]): string[] =>
  items
    .filter((i) => i.type === "agent_message")
    .map((i) => (i as { text: string }).text);

describe("finalAnswerCheck (R3, ADR 0061 §6)", () => {
  it("feeds a failing final answer back once, and accepts the next one", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "nope" }, { text: "ok" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
    });

    expect(result.status).toBe("completed");
    // The feedback is the check's own string, verbatim — never a second
    // phrasing of the rule the check enforces.
    expect(steered(result.items)).toEqual(['expected "ok", got "nope"']);
    expect(agentText(result.items)).toEqual(["nope", "ok"]);
    // It is a real persisted item, so a reload sees it too.
    const reloaded = await store.load(session.id);
    expect(steered([...reloaded.items])).toEqual(['expected "ok", got "nope"']);
  });

  it("the model's next request carries the feedback as a user message", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "nope" }, { text: "ok" }]);
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
    });
    const second = model.requests[1];
    expect(second).toBeDefined();
    const last = [...(second?.messages ?? [])].pop();
    expect(last?.role).toBe("user");
    expect(last?.content).toBe('expected "ok", got "nope"');
  });

  it("a second failure completes: the retry is bounded at one", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { text: "nope" },
      { text: "still nope" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
    });

    expect(result.status).toBe("completed");
    expect(steered(result.items)).toHaveLength(1);
    // Exactly two turns: the check never gets a third chance, so an
    // always-failing model cannot burn the task's whole turn budget on it.
    expect(model.requests).toHaveLength(2);
    expect(agentText(result.items)).toEqual(["nope", "still nope"]);
  });

  it("an unset check leaves the task byte-identical: one turn, no steering", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "nope" }, { text: "ok" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
    });

    expect(result.status).toBe("completed");
    expect(steered(result.items)).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it("a passing first answer never consumes the retry and never steers", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "ok" }]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
    });

    expect(result.status).toBe("completed");
    expect(steered(result.items)).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it("the host's queued steering still drains, after the feedback", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([{ text: "nope" }, { text: "ok" }]);
    const queued = ["also look at section 3"];
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
      takeSteering: () => queued.shift(),
    });

    expect(result.status).toBe("completed");
    // Feedback FIRST — it corrects the turn the loop has just declined to stop
    // on — then whatever the user typed meanwhile. The loop drains until the
    // hook returns undefined, so neither is lost.
    expect(steered(result.items)).toEqual([
      'expected "ok", got "nope"',
      "also look at section 3",
    ]);
  });

  it("a truncated turn is not a shape failure and does not spend the retry", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    // `max_tokens` with no tool calls: the task ends with the truncation
    // notice. Feeding an interpreter's complaint back about half a sentence
    // would spend the one retry on the wrong problem.
    const model = new ScriptedModelAdapter([
      { text: "half a sen", stopReason: "max_tokens" },
    ]);
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: wantsOk,
    });

    expect(result.status).toBe("completed");
    expect(steered(result.items)).toEqual([]);
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "turn.truncated",
      ),
    ).toBe(true);
    expect(model.requests).toHaveLength(1);
  });
});

/**
 * V2 (ADR 0078 §4, O7): the check is handed the task's transcript so far.
 *
 * The review driver validates a cited paper against what THAT seat's own
 * searches returned, and the check fires inside the child — before the driver
 * has seen a single item of it. So the transcript has to reach the check
 * itself, at the moment it runs.
 */
describe("finalAnswerCheck receives the task's items (V2, ADR 0078 §4)", () => {
  /** A tool the child can call, so there is a completed call to see. */
  const registry = () =>
    new Map<ToolName, ToolExecutor>([
      [
        "read_span",
        {
          name: "read_span",
          category: "retrieval",
          spec: {
            name: "read_span",
            description: "read a section",
            parameters: { type: "object" },
          },
          invoke: async () => ok({ content: "seven words here" }),
        },
      ],
    ]);

  it("sees the completed tool calls of earlier turns, with their results", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "read_span", args: {} }] },
      { text: "done" },
    ]);
    const seen: Array<{ tool: string; result: string | undefined }> = [];
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "count them",
      registry: registry(),
      allowedTools: ["read_span"],
      finalAnswerCheck: (_text, items) => {
        for (const i of items) {
          if (i.type === "tool_call") {
            seen.push({ tool: i.tool, result: i.resultJson });
          }
        }
        return undefined;
      },
    });

    // The call the child made on its FIRST turn is visible to the check that
    // runs on its second — carrying the result the executor produced, which is
    // the half the ledger actually reads.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe("read_span");
    expect(seen[0]?.result).toContain("seven words here");
  });

  it("still takes a one-argument check, and still fires exactly once", async () => {
    // V1's verifier passes a `(text) => …`; every pre-V2 caller does. The
    // widening must not have made any of them a type error or a behaviour
    // change — `MAX_FINAL_ANSWER_RETRIES` did not move.
    const store = await mkStore();
    const session = await store.create({ title: "t", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { text: "nope" },
      { text: "still nope" },
    ]);
    let calls = 0;
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "answer me",
      finalAnswerCheck: (text: string) => {
        calls += 1;
        return wantsOk(text);
      },
    });
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
  });
});
