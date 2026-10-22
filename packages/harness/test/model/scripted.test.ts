import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ModelAdapterFactory,
  ModelBinding,
  ModelStreamEvent,
} from "../../src/index.js";
import {
  ScriptExhaustedError,
  ScriptedModelAdapter,
} from "../../src/model/scripted.js";
import { classifyStreamFailure } from "../../src/session/stream-errors.js";

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://model.invalid",
  model: "stub-model",
  apiKey: "stub-key",
};

describe("ScriptedModelAdapter", () => {
  it("returns scripted turns in order and records requests", async () => {
    const model = new ScriptedModelAdapter([
      { text: "first" },
      { text: "second" },
    ]);
    const req = {
      binding,
      messages: [{ role: "user", content: "hi" } as ChatMessage],
      maxTokens: 64,
    };
    expect((await model.generate(req)).text).toBe("first");
    expect((await model.generate(req)).text).toBe("second");
    expect(model.requests).toHaveLength(2);
    await expect(model.generate(req)).rejects.toThrow(/script ran out/);
  });

  it("drives a fake tool-use loop deterministically", async () => {
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "call-1", name: "count_words", args: { text: "hello world" } },
        ],
      },
      { text: "Two words." },
    ]);
    const messages: ChatMessage[] = [
      { role: "user", content: "How many words?" },
    ];
    let result = await model.generate({ binding, messages, maxTokens: 64 });
    while (result.stopReason === "tool_use") {
      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        messages.push({
          role: "tool",
          content: '{"unit":"words","count":2}',
          toolCallId: call.id,
        });
      }
      result = await model.generate({ binding, messages, maxTokens: 64 });
    }
    expect(result.text).toBe("Two words.");
    expect(result.stopReason).toBe("stop");
    expect(model.requests).toHaveLength(2);
    const secondTurnMessages = model.requests[1]?.messages ?? [];
    expect(secondTurnMessages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
    expect(secondTurnMessages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call-1" }],
    });
  });

  it("satisfies the ModelAdapterFactory seam", () => {
    const model = new ScriptedModelAdapter([]);
    const factory: ModelAdapterFactory = () => model;
    expect(factory("anthropic").protocol).toBe("anthropic");
  });

  it("streams a scripted turn as deltas plus a terminal completed result", async () => {
    const model = new ScriptedModelAdapter([
      {
        text: "final answer",
        toolCalls: [
          { id: "call-1", name: "read_span", args: { section: "Intro" } },
        ],
      },
    ]);
    const events: ModelStreamEvent[] = [];
    for await (const ev of model.generateStream({
      binding,
      messages: [{ role: "user", content: "go" }],
      maxTokens: 64,
    })) {
      events.push(ev);
    }
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(2);
    expect(textDeltas.map((e) => e.text).join("")).toBe("final answer");
    const callDeltas = events.filter((e) => e.type === "tool_call_delta");
    expect(callDeltas.length).toBeGreaterThanOrEqual(2);
    expect(callDeltas[0]).toMatchObject({
      index: 0,
      id: "call-1",
      name: "read_span",
    });
    expect(callDeltas[1]?.id).toBeUndefined();
    expect(callDeltas.map((e) => e.argsDelta).join("")).toBe(
      JSON.stringify({ section: "Intro" }),
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type === "completed") {
      expect(terminal.result.text).toBe("final answer");
      expect(terminal.result.toolCalls).toEqual([
        { id: "call-1", name: "read_span", args: { section: "Intro" } },
      ]);
      expect(terminal.result.stopReason).toBe("tool_use");
    }
    expect(model.requests).toHaveLength(1);
  });

  it("yields aborted (and nothing after) when the signal fires mid-stream", async () => {
    const model = new ScriptedModelAdapter([{ text: "long streamed answer" }]);
    const ctrl = new AbortController();
    const events: ModelStreamEvent[] = [];
    for await (const ev of model.generateStream({
      binding,
      messages: [{ role: "user", content: "go" }],
      maxTokens: 64,
      signal: ctrl.signal,
    })) {
      events.push(ev);
      ctrl.abort();
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "aborted"]);
  });

  it("throws a scripted STREAM failure after the first delta, once", async () => {
    const model = new ScriptedModelAdapter([
      { text: "answer", failure: { message: "boom", status: 503 } },
    ]);
    const req = {
      binding,
      messages: [{ role: "user", content: "go" } as ChatMessage],
      maxTokens: 64,
    };
    const first: ModelStreamEvent[] = [];
    await expect(async () => {
      for await (const ev of model.generateStream(req)) first.push(ev);
    }).rejects.toMatchObject({ message: "boom", status: 503 });
    expect(first.map((e) => e.type)).toEqual(["text_delta"]);
    // The retry consumes the same scripted turn and succeeds.
    const second: ModelStreamEvent[] = [];
    for await (const ev of model.generateStream(req)) second.push(ev);
    expect(second.at(-1)?.type).toBe("completed");
    expect(model.requests).toHaveLength(2);
  });

  // ── B0 additions over the former stub ────────────────────────────────────
  it("fails a UNARY call too, then serves the same turn on retry", async () => {
    // `streamError` was streamed-path only, so `runL0Tier`/`runL1Tier` (which
    // call `generate`) had no adapter-driven failure path at all.
    const model = new ScriptedModelAdapter([
      { text: "ok", failure: { message: "boom", status: 429 } },
    ]);
    const req = {
      binding,
      messages: [{ role: "user", content: "go" } as ChatMessage],
      maxTokens: 64,
    };
    await expect(model.generate(req)).rejects.toThrow("boom");
    expect((await model.generate(req)).text).toBe("ok");
  });

  it("carries the scripted status onto the thrown error, so retry classification works", async () => {
    const model = new ScriptedModelAdapter([
      { text: "ok", failure: { message: "boom", status: 503 } },
    ]);
    const req = {
      binding,
      messages: [{ role: "user", content: "go" } as ChatMessage],
      maxTokens: 64,
    };
    await expect(model.generate(req)).rejects.toMatchObject({ status: 503 });
  });

  it("aborts mid-stream after the scripted number of deltas", async () => {
    // Previously only an ALREADY-aborted signal could be scripted; a test that
    // wanted a mid-turn abort had to race an event handler by hand.
    const model = new ScriptedModelAdapter([
      { text: "hello world", abortAfterDeltas: 1 },
    ]);
    const events: ModelStreamEvent[] = [];
    for await (const ev of model.generateStream({
      binding,
      messages: [{ role: "user", content: "go" }],
      maxTokens: 64,
    })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "aborted"]);
  });

  it("running past the last scripted turn fails LOUDLY, not as a provider blip", async () => {
    const model = new ScriptedModelAdapter([{ text: "one" }]);
    const req = {
      binding,
      messages: [{ role: "user", content: "go" } as ChatMessage],
      maxTokens: 64,
    };
    await model.generate(req);
    await expect(model.generate(req)).rejects.toBeInstanceOf(
      ScriptExhaustedError,
    );
    // The retry classifier must not mistake a broken test for a transient
    // failure — that is how an over-run script reads green. Assert against the
    // REAL thrown error, so a future re-wording that happens to contain
    // "connection"/"network" is caught here (review, Minor).
    const thrown = await model.generate(req).catch((e: unknown) => e);
    expect((thrown as Error).message).toMatch(/turn 2 of 1/);
    // B2: `isTransientStreamError` became `classifyStreamFailure`; the
    // assertion is unchanged in meaning — an exhausted script is never retried.
    expect(classifyStreamFailure(thrown)).toBe("fatal");
  });

  it("exposes the request log for assertions", async () => {
    const model = new ScriptedModelAdapter([{ text: "a" }, { text: "b" }]);
    const req = {
      binding,
      messages: [{ role: "user", content: "go" } as ChatMessage],
      maxTokens: 64,
    };
    await model.generate(req);
    await model.generate(req);
    expect(model.requestCount).toBe(2);
    expect(model.lastRequest()?.maxTokens).toBe(64);
  });
});
