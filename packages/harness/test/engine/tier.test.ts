import { describe, expect, it, vi } from "vitest";
import type { ResolvedBudget } from "../../src/contracts/actions.js";
import type { ModelBinding } from "../../src/contracts/adapters.js";
import { ok } from "../../src/contracts/results.js";
import type { ToolName } from "../../src/contracts/tools.js";
import { runL1Tier } from "../../src/engine/tier.js";
import {
  type ToolExecutor,
  buildToolRegistry,
} from "../../src/engine/tools.js";
import { ScriptedModelAdapter } from "../../src/model/scripted.js";
import { TOOL_RESULT_MAX_CHARS } from "../../src/text/tool-result.js";

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "http://stub",
  model: "stub",
  apiKey: "k",
};

function budget(overrides: Partial<ResolvedBudget> = {}): ResolvedBudget {
  return {
    maxIterations: 3,
    maxTokens: 4000,
    timeoutMs: 60_000,
    retrievalBudget: 3,
    fanOut: 0,
    ...overrides,
  };
}

/** A test tool that succeeds. ADR 0024: the executor returns a `Result`, so
 *  the fake wraps its payload — the tier is what unwraps it. */
function fakeTool(
  name: ToolName,
  category: ToolExecutor["category"],
  invoke: (args: unknown) => Promise<unknown>,
): ToolExecutor {
  return {
    name,
    category,
    spec: { name, description: `${name} tool`, parameters: { type: "object" } },
    invoke: async (args) => ok(await invoke(args)),
  };
}

const userMsg = [{ role: "user" as const, content: "Shrink this." }];

describe("runL1Tier", () => {
  it("executes a requested tool and feeds the result back", async () => {
    const invoke = vi.fn(async () => ({ unit: "words", count: 8 }));
    const registry = new Map<ToolName, ToolExecutor>([
      ["count_words", fakeTool("count_words", "analysis", invoke)],
    ]);
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "count_words", args: { text: "x" } }] },
      { text: "Final shrunk text." },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget(),
      registry,
      allowedTools: ["count_words"],
      signal: AbortSignal.timeout(60_000),
    });
    expect(invoke).toHaveBeenCalledWith({ text: "x" });
    expect(run.text).toBe("Final shrunk text.");
    expect(run.stoppedBy).toBe("complete");
    expect(run.usage.iterations).toBe(2);
    // The tool result travelled back as a role:"tool" message.
    const toolMsg = stub.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain('"count":8');
    expect(toolMsg?.toolCallId).toBe("t1");
  });

  it("caps an oversized tool result before it reaches the model (B4)", async () => {
    // The tier loop was the SECOND tool-result serialization path, and no
    // input to B4 named it: `capToolResult` had two call sites, both in the
    // session loop, so an L1 quick action could take an unbounded result
    // (a whole `list_citations`) straight into its context.
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "list_citations",
        fakeTool("list_citations", "retrieval", async () => ({
          entries: "y".repeat(500_000),
        })),
      ],
    ]);
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "list_citations", args: {} }] },
      { text: "Done." },
    ]);
    await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget(),
      registry,
      allowedTools: ["list_citations"],
      signal: AbortSignal.timeout(60_000),
    });
    const toolMsg = stub.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(
      (JSON.parse(toolMsg?.content ?? "{}") as { truncated?: boolean })
        .truncated,
    ).toBe(true);
  });

  it("refuses a tool outside the action's allowlist (invariant 2)", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      ["count_words", fakeTool("count_words", "analysis", async () => ({}))],
    ]);
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "read_span", args: {} }] },
      { text: "Answer anyway." },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget(),
      registry,
      allowedTools: ["count_words"],
      signal: AbortSignal.timeout(60_000),
    });
    const toolMsg = stub.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toMatch(/not permitted/);
    expect(run.text).toBe("Answer anyway.");
  });

  it("enforces retrieval_budget on retrieval-category tools", async () => {
    const invoke = vi.fn(async () => [{ term: "self-attention" }]);
    const registry = new Map<ToolName, ToolExecutor>([
      ["glossary_lookup", fakeTool("glossary_lookup", "retrieval", invoke)],
    ]);
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "glossary_lookup", args: { term: "a" } }],
      },
      {
        toolCalls: [{ id: "t2", name: "glossary_lookup", args: { term: "b" } }],
      },
      { text: "Translated." },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget({ retrievalBudget: 1, maxIterations: 5 }),
      registry,
      allowedTools: ["glossary_lookup"],
      signal: AbortSignal.timeout(60_000),
    });
    expect(invoke).toHaveBeenCalledTimes(1); // 2nd call refused, not executed
    const secondResult = stub.requests[2]?.messages.filter(
      (m) => m.role === "tool",
    );
    expect(secondResult?.at(-1)?.content).toMatch(/budget exhausted/);
    expect(run.text).toBe("Translated.");
  });

  it("caps model round-trips at max_iterations and forces a final no-tools answer", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      ["count_words", fakeTool("count_words", "analysis", async () => ({}))],
    ]);
    // Model keeps asking for tools; the cap must force a tools-off final call.
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "count_words", args: {} }] },
      { text: "Forced final.", toolCalls: [] },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget({ maxIterations: 2 }),
      registry,
      allowedTools: ["count_words"],
      signal: AbortSignal.timeout(60_000),
    });
    expect(run.usage.iterations).toBe(2);
    expect(run.stoppedBy).toBe("complete");
    // The last (2nd) request offered no tools.
    expect(stub.requests[1]?.tools ?? []).toHaveLength(0);
  });

  it("echoes assistant reasoning back into history (ADR 0006)", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      ["count_words", fakeTool("count_words", "analysis", async () => ({}))],
    ]);
    const reasoning = [{ type: "thinking", thinking: "…", signature: "s" }];
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [{ id: "t1", name: "count_words", args: {} }],
        reasoning,
      },
      { text: "Done." },
    ]);
    await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget(),
      registry,
      allowedTools: ["count_words"],
      signal: AbortSignal.timeout(60_000),
    });
    const assistant = stub.requests[1]?.messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.reasoning).toEqual(reasoning);
  });

  it("CM4: the new CM3 retrieval tools consume retrieval_budget and are refused past it", async () => {
    // The REAL registry with get_outline + read_span, budgeted to 2 retrievals.
    const registry = buildToolRegistry({
      tools: ["get_outline", "read_span"],
      adapter: {
        countWords: () => ({ language: "en", unit: "words", count: 0 }),
      },
      glossary: [],
      outline: [
        {
          title: "Intro",
          file: "main.tex",
          startLine: 1,
          endLine: 2,
          wordCount: 4,
          labels: [],
          citations: [],
          children: [],
        },
      ],
      workspace: {
        readFile: () => Promise.resolve("one\ntwo\n"),
        listFiles: () => Promise.resolve(["main.tex"]),
      },
      defaultFile: "main.tex",
    });
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "get_outline", args: {} }] },
      {
        toolCalls: [
          { id: "t2", name: "read_span", args: { start_line: 1, end_line: 2 } },
        ],
      },
      { toolCalls: [{ id: "t3", name: "get_outline", args: {} }] },
      { text: "Done with what I have." },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget({ retrievalBudget: 2, maxIterations: 6 }),
      registry,
      allowedTools: ["get_outline", "read_span"],
      signal: AbortSignal.timeout(60_000),
    });
    // First two retrievals succeeded, the third was refused, not executed.
    // (Look results up by toolCallId — the tier mutates one shared history.)
    const toolResult = (id: string) =>
      run.messages.find((m) => m.role === "tool" && m.toolCallId === id)
        ?.content;
    expect(toolResult("t1")).toContain("Intro");
    expect(toolResult("t2")).toContain("one\\ntwo"); // JSON-escaped tool result
    expect(toolResult("t3")).toMatch(/budget exhausted/);
    expect(run.text).toBe("Done with what I have.");
  });

  it("propagates a truncated tier stop (max_tokens) as budget", async () => {
    const registry = new Map<ToolName, ToolExecutor>();
    const stub = new ScriptedModelAdapter([
      { text: "cut off", stopReason: "max_tokens" },
    ]);
    const run = await runL1Tier({
      model: stub,
      binding,
      messages: userMsg,
      budget: budget(),
      registry,
      allowedTools: [],
      signal: AbortSignal.timeout(60_000),
    });
    expect(run.stoppedBy).toBe("budget");
  });

  it("every tier-level failure carries its ADR 0024 code", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "count_words",
        fakeTool("count_words", "analysis", async () => ({ count: 8 })),
      ],
      [
        "read_span",
        {
          name: "read_span" as const,
          category: "retrieval" as const,
          spec: {
            name: "read_span" as const,
            description: "x",
            parameters: { type: "object" },
          },
          invoke: async () => {
            throw new Error("contract violation");
          },
        },
      ],
    ]);
    const errorOf = async (
      allowedTools: ToolName[],
      call: { id: string; name: ToolName; args: unknown },
      retrievalBudget = 5,
    ) => {
      const model = new ScriptedModelAdapter([
        { toolCalls: [call] },
        { text: "done" },
      ]);
      await runL1Tier({
        model,
        binding,
        messages: userMsg,
        registry,
        allowedTools,
        budget: budget({ maxIterations: 3, retrievalBudget }),
      });
      const toolMsg = model.requests[1]?.messages.find(
        (m) => m.role === "tool",
      );
      return JSON.parse(toolMsg?.content ?? "{}").error as {
        code: string;
        message: string;
      };
    };

    // Not in the action's declared tools. (`allowedTools` must still contain a
    // registered tool, or the tier offers none and never reaches a tool call.)
    expect(
      (
        await errorOf(["count_words"], {
          id: "t1",
          name: "read_span",
          args: {},
        })
      ).code,
    ).toBe("denied");
    // Declared, but this build has no executor for it.
    expect(
      (
        await errorOf(["count_words", "verify"], {
          id: "t2",
          name: "verify",
          args: {},
        })
      ).code,
    ).toBe("unavailable");
    // Retrieval budget spent before the call.
    expect(
      (
        await errorOf(
          ["count_words", "read_span"],
          { id: "t3", name: "read_span", args: {} },
          0,
        )
      ).code,
    ).toBe("too_large");
    // ADR 0024 decision 6: a tool that throws anyway is a defect, reported —
    // never allowed to end the action.
    expect(
      await errorOf(["count_words", "read_span"], {
        id: "t4",
        name: "read_span",
        args: {},
      }),
    ).toEqual({ code: "unavailable", message: "contract violation" });
  });
});
