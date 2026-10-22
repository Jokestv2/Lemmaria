import { describe, expect, it } from "vitest";
import type {
  GenerateResult,
  ModelBinding,
  SessionEvent,
  SessionItem,
} from "../../src/contracts/index.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
} from "../../src/model/scripted.js";
import { type SessionLoopHooks, runTurnLoop } from "../../src/session/loop.js";

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};

/**
 * The minimum hook set a loop needs to terminate. Note `shouldStopAfterTurn`:
 * "a turn with no tool calls ends the task" is a CALLER decision in this
 * design, not the loop's — a loop with a hook that never stops would keep
 * requesting turns until the turn budget ran out.
 */
const baseHooks = (): SessionLoopHooks => ({
  beforeTurn: () => undefined,
  countTurn: () => {},
  turnMaxTokens: () => 1024,
  onStreamFailure: () => ({ kind: "fail" }),
  onMissingTerminal: () => ({ kind: "fail" }),
  shouldStopAfterTurn: (result) =>
    result.toolCalls.length === 0 ? { status: "completed" } : undefined,
  runToolCalls: async () => ({ interrupted: false }),
  afterToolBatch: async () => {},
  takeSteering: () => undefined,
  afterTurn: async () => undefined,
});

function bed(
  turns: ScriptedTurn[],
  hooks: SessionLoopHooks,
  maxTurns = 4,
  opts: {
    signal?: AbortSignal;
    onSleep?: (ms: number) => void;
    onNotice?: (code: string) => void;
  } = {},
) {
  const events: SessionEvent[] = [];
  const items: SessionItem[] = [];
  const model = new ScriptedModelAdapter(turns);
  const usage: number[] = [];
  /** Every `emitNotice(code, n)` the loop made, in order. */
  const notices: { code: string; n: number }[] = [];
  /** Every backoff the loop asked for, in ms — asserted instead of waited. */
  const slept: number[] = [];
  return {
    events,
    items,
    usage,
    notices,
    slept,
    model,
    run: () =>
      runTurnLoop({
        generateStream: (req) => model.generateStream(req),
        binding,
        messages: [{ role: "user", content: "hi" }],
        toolSpecs: [],
        maxTurns,
        startTurnNumber: 0,
        emit: async (e) => void events.push(e),
        emitItem: async (i) => void items.push(i),
        emitNotice: async (code, n) => {
          notices.push({ code, n });
          opts.onNotice?.(code);
        },
        onTurnUsage: (u) => void usage.push(u.outputTokens),
        hooks,
        // The delays are ASSERTED, not waited: the policy computed them, and a
        // test that actually slept would be testing setTimeout.
        sleep: async (ms) => {
          slept.push(ms);
          opts.onSleep?.(ms);
          return !opts.signal?.aborted;
        },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
  };
}

const aToolCall = { id: "c1", name: "read_span" as const, args: {} };

describe("runTurnLoop (B1)", () => {
  it("stops before a turn when beforeTurn says so, without calling the model", async () => {
    const b = bed([{ text: "must not be reached" }], {
      ...baseHooks(),
      beforeTurn: () => ({
        status: "completed",
        notices: [{ code: "budget.output_tokens", n: 16000 }],
      }),
    });
    await expect(b.run()).resolves.toMatchObject({
      status: "completed",
      notices: [{ code: "budget.output_tokens", n: 16000 }],
    });
    expect(b.events.some((e) => e.type === "turn.started")).toBe(false);
  });

  it("runs one turn, emits the agent message, and stops on a plain stop", async () => {
    const b = bed([{ text: "done" }], baseHooks());
    await expect(b.run()).resolves.toMatchObject({ status: "completed" });
    expect(b.items.filter((i) => i.type === "agent_message")).toHaveLength(1);
    expect(b.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("numbers turns from the transcript's existing count", async () => {
    const events: SessionEvent[] = [];
    const model = new ScriptedModelAdapter([{ text: "done" }]);
    await runTurnLoop({
      generateStream: (req) => model.generateStream(req),
      binding,
      messages: [{ role: "user", content: "hi" }],
      toolSpecs: [],
      maxTurns: 2,
      startTurnNumber: 3,
      emit: async (e) => void events.push(e),
      emitItem: async () => {},
      emitNotice: async () => {},
      onTurnUsage: () => {},
      hooks: baseHooks(),
    });
    const started = events.find((e) => e.type === "turn.started");
    expect(started).toMatchObject({ turn: 4 });
  });

  it("honours a retry action once, then completes", async () => {
    const attempts: number[] = [];
    const b = bed(
      [
        {
          failure: { message: "overloaded", status: 503, times: 1 },
          text: "recovered",
        },
      ],
      {
        ...baseHooks(),
        onStreamFailure: (_error, attempt) => {
          attempts.push(attempt);
          return attempt === 1
            ? { kind: "retry", delayMs: 0 }
            : { kind: "fail" };
        },
      },
    );
    await expect(b.run()).resolves.toMatchObject({ status: "completed" });
    expect(attempts).toEqual([1]);
  });

  it("a stream failure the hook refuses to retry fails the turn and the task", async () => {
    const b = bed(
      [{ failure: { message: "provider exploded", status: 500, times: 3 } }],
      baseHooks(),
    );
    const stop = await b.run();
    expect(stop).toMatchObject({ status: "failed" });
    expect(b.events.some((e) => e.type === "turn.failed")).toBe(true);
    expect(b.items.some((i) => i.type === "error")).toBe(true);
  });

  it("a hook-supplied stop after a tool turn ends the loop with that status", async () => {
    let seen: GenerateResult | undefined;
    const b = bed([{ toolCalls: [aToolCall] }], {
      ...baseHooks(),
      shouldStopAfterTurn: (result) => {
        seen = result;
        return {
          status: "completed",
          notices: [{ code: "budget.tool_calls", n: 3 }],
        };
      },
    });
    await expect(b.run()).resolves.toMatchObject({
      notices: [{ code: "budget.tool_calls", n: 3 }],
    });
    expect(seen?.toolCalls).toHaveLength(1);
  });

  it("an interrupted tool batch ends the task without a further turn", async () => {
    const b = bed([{ toolCalls: [aToolCall] }, { text: "unreached" }], {
      ...baseHooks(),
      runToolCalls: async () => ({ interrupted: true }),
    });
    await expect(b.run()).resolves.toMatchObject({ status: "interrupted" });
    expect(b.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("drains steering into the conversation at the turn boundary", async () => {
    const queued = ["also cite Smith", "and keep it short"];
    const b = bed([{ toolCalls: [aToolCall] }, { text: "ok" }], {
      ...baseHooks(),
      takeSteering: () => queued.shift(),
    });
    await b.run();
    const steered = b.items.filter(
      (i) => i.type === "user_message" && i.steered === true,
    );
    expect(steered).toHaveLength(2);
    expect(queued).toEqual([]);
  });

  it("afterTurn can end the task between turns", async () => {
    const b = bed([{ toolCalls: [aToolCall] }, { text: "unreached" }], {
      ...baseHooks(),
      afterTurn: async () => ({
        status: "completed",
        notices: [{ code: "context.limit", n: 0 }],
      }),
    });
    await expect(b.run()).resolves.toMatchObject({
      notices: [{ code: "context.limit", n: 0 }],
    });
    expect(b.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("exhausting maxTurns returns no stop of its own — the caller owns that notice", async () => {
    const b = bed(
      Array.from({ length: 4 }, () => ({ toolCalls: [aToolCall] })),
      baseHooks(),
      4,
    );
    await expect(b.run()).resolves.toBeUndefined();
    expect(b.events.filter((e) => e.type === "turn.started")).toHaveLength(4);
  });

  it("counts a turn only once it is actually going ahead", async () => {
    const counted: number[] = [];
    const b = bed([{ text: "one" }], {
      ...baseHooks(),
      countTurn: () => counted.push(1),
    });
    await b.run();
    expect(counted).toHaveLength(1);

    const skipped: number[] = [];
    const s = bed([{ text: "unreached" }], {
      ...baseHooks(),
      beforeTurn: () => ({ status: "completed" }),
      countTurn: () => skipped.push(1),
    });
    await s.run();
    expect(skipped).toEqual([]);
  });

  it("retries a stream that ends with NO terminal event, once", async () => {
    // The adapter contract guarantees a terminal event (ADR 0015); a bare end
    // is a broken adapter, and is retried on attempt count alone — there is no
    // error object to classify as transient.
    const attempts: number[] = [];
    let call = 0;
    const events: SessionEvent[] = [];
    const stop = await runTurnLoop({
      generateStream: async function* () {
        call += 1;
        yield { type: "text_delta" as const, text: "partial" };
        if (call === 1) return; // no terminal event
        yield {
          type: "completed" as const,
          result: {
            text: "recovered",
            toolCalls: [],
            stopReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
      binding,
      messages: [{ role: "user", content: "hi" }],
      toolSpecs: [],
      maxTurns: 2,
      startTurnNumber: 0,
      emit: async (e) => void events.push(e),
      emitItem: async () => {},
      emitNotice: async () => {},
      onTurnUsage: () => {},
      hooks: {
        ...baseHooks(),
        onMissingTerminal: (attempt) => {
          attempts.push(attempt);
          return attempt === 1
            ? { kind: "retry", delayMs: 0 }
            : { kind: "fail" };
        },
      },
    });
    expect(attempts).toEqual([1]);
    expect(call).toBe(2);
    expect(stop).toMatchObject({ status: "completed" });
    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
  });

  it("one turn gets ONE retry across both failure causes", async () => {
    // A transient error consumes the turn's single retry, so a bare end on the
    // next attempt fails the turn — the shared-counter rule.
    const seen: string[] = [];
    let call = 0;
    const events: SessionEvent[] = [];
    const stop = await runTurnLoop({
      generateStream: async function* () {
        call += 1;
        if (call === 1) throw new Error("socket hang up");
        yield { type: "text_delta" as const, text: "partial" };
        return; // no terminal event, on attempt 2
      },
      binding,
      messages: [{ role: "user", content: "hi" }],
      toolSpecs: [],
      maxTurns: 2,
      startTurnNumber: 0,
      emit: async (e) => void events.push(e),
      emitItem: async () => {},
      emitNotice: async () => {},
      onTurnUsage: () => {},
      hooks: {
        ...baseHooks(),
        onStreamFailure: (_error, attempt) => {
          seen.push(`stream:${attempt}`);
          return attempt === 1
            ? { kind: "retry", delayMs: 0 }
            : { kind: "fail" };
        },
        onMissingTerminal: (attempt) => {
          seen.push(`bare:${attempt}`);
          return attempt === 1
            ? { kind: "retry", delayMs: 0 }
            : { kind: "fail" };
        },
      },
    });
    expect(seen).toEqual(["stream:1", "bare:2"]);
    expect(stop).toMatchObject({ status: "failed" });
    expect(events.some((e) => e.type === "turn.failed")).toBe(true);
  });

  it("waits the delay the retry action asked for, and names it in the notice", async () => {
    const b = bed(
      [
        {
          failure: { message: "overloaded", status: 503, times: 1 },
          text: "recovered",
        },
      ],
      {
        ...baseHooks(),
        onStreamFailure: (_e, attempt) =>
          attempt === 1 ? { kind: "retry", delayMs: 2400 } : { kind: "fail" },
      },
    );
    await expect(b.run()).resolves.toMatchObject({ status: "completed" });
    expect(b.slept).toEqual([2400]);
    // Whole seconds, rounded UP: a notice promising 2s before a 2.4s wait
    // would be a small lie in the one direction the user notices.
    expect(b.notices).toEqual([{ code: "stream.retried", n: 3 }]);
  });

  it("announces the wait BEFORE waiting it", async () => {
    // Otherwise the composer sits silent for the length of the backoff, which
    // is the frozen-spinner symptom the policy exists to remove.
    const order: string[] = [];
    const b = bed(
      [
        {
          failure: { message: "overloaded", status: 503, times: 1 },
          text: "recovered",
        },
      ],
      {
        ...baseHooks(),
        onStreamFailure: (_e, attempt) =>
          attempt === 1 ? { kind: "retry", delayMs: 500 } : { kind: "fail" },
      },
      4,
      {
        onSleep: () => order.push("slept"),
        onNotice: (code) => order.push(`notice:${code}`),
      },
    );
    await b.run();
    expect(order).toEqual(["notice:stream.retried", "slept"]);
  });

  it("an interrupt DURING the backoff ends the task, rather than retrying", async () => {
    // ◼ Stop must not be dead for the length of a delay.
    const controller = new AbortController();
    const b = bed(
      [{ failure: { message: "overloaded", status: 503, times: 9 } }],
      {
        ...baseHooks(),
        onStreamFailure: () => ({ kind: "retry", delayMs: 1000 }),
      },
      4,
      { signal: controller.signal, onSleep: () => controller.abort() },
    );
    await expect(b.run()).resolves.toMatchObject({ status: "interrupted" });
    expect(b.items.some((i) => i.type === "interrupted")).toBe(true);
    expect(b.events.some((e) => e.type === "turn.failed")).toBe(false);
    // One wait, then the abort — never a second attempt.
    expect(b.slept).toEqual([1000]);
  });

  it("emits a fail action's notice BEFORE the error item", async () => {
    const b = bed(
      [{ failure: { message: "insufficient_quota", status: 429, times: 9 } }],
      {
        ...baseHooks(),
        onStreamFailure: () => ({
          kind: "fail",
          notice: { code: "provider.quota", n: 0 },
        }),
      },
    );
    await expect(b.run()).resolves.toMatchObject({ status: "failed" });
    expect(b.notices).toEqual([{ code: "provider.quota", n: 0 }]);
    expect(b.items.some((i) => i.type === "error")).toBe(true);
    expect(b.slept).toEqual([]);
  });

  it("a missing terminal event can also carry a fail notice", async () => {
    const notices: { code: string; n: number }[] = [];
    let call = 0;
    const stop = await runTurnLoop({
      generateStream: async function* () {
        call += 1;
        yield { type: "text_delta" as const, text: "partial" };
      },
      binding,
      messages: [{ role: "user", content: "hi" }],
      toolSpecs: [],
      maxTurns: 2,
      startTurnNumber: 0,
      emit: async () => {},
      emitItem: async () => {},
      emitNotice: async (code, n) => void notices.push({ code, n }),
      onTurnUsage: () => {},
      hooks: {
        ...baseHooks(),
        onMissingTerminal: (attempt) => ({
          kind: "fail",
          notice: { code: "stream.retry_failed", n: attempt },
        }),
      },
    });
    expect(call).toBe(1);
    expect(stop).toMatchObject({ status: "failed" });
    expect(notices).toEqual([{ code: "stream.retry_failed", n: 1 }]);
  });

  it("reports each turn's usage to the caller", async () => {
    const b = bed(
      [{ toolCalls: [aToolCall], usage: { inputTokens: 1, outputTokens: 7 } }],
      { ...baseHooks(), shouldStopAfterTurn: () => ({ status: "completed" }) },
    );
    await b.run();
    expect(b.usage).toEqual([7]);
  });
});
