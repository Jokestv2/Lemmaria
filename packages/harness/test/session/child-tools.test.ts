/**
 * V4 (ADR 0081 §6, O12): a harness-issued child may hold one bounded tool its
 * parent's surface does not offer — `extraTools`, merged into THAT child's
 * per-task clone of the host registry and nowhere else.
 *
 * Asserted under a real `runSessionTask` against `ScriptedModelAdapter`, which
 * records every request, so "offered the spec" and "can call it" are read off
 * the wire rather than off an internal list.
 */
import { describe, expect, it } from "vitest";
import type {
  ModelBinding,
  PdfDocument,
  ToolName,
} from "../../src/contracts/index.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  ScriptedModelAdapter,
  type ScriptedTurn,
} from "../../src/model/scripted.js";
import { createInMemorySessionStore } from "../../src/session/child-store.js";
import { createViewPdfPagesTool } from "../../src/session/loop-tools/pdf-pages.js";
import { runSessionTask } from "../../src/session/run.js";

const seeing: ModelBinding = {
  protocol: "openai-compatible",
  endpoint: "https://openai.test/v1",
  model: "gpt-5.6-luna",
  apiKey: "k",
};

function onePage(): PdfDocument {
  return {
    pageCount: 1,
    pageSize: () => ({ width: 612, height: 792 }),
    renderPage: async (_p, opts) => ({
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      width: opts.width,
      height: opts.width,
    }),
    pageText: async () => "",
    pageTextSizes: async () => [],
    metadata: async () => ({}),
    close: () => {},
  };
}

const CALLS_THE_TOOL: ScriptedTurn[] = [
  {
    text: "",
    toolCalls: [{ id: "c1", name: "view_pdf_pages", args: { pages: [1] } }],
    stopReason: "tool_use",
  },
  { text: "done", stopReason: "stop" },
];

async function runChildTask(opts: {
  hostRegistry: Map<ToolName, ToolExecutor>;
  allowedTools: ToolName[];
  extraTools?: ReadonlyMap<ToolName, ToolExecutor>;
}) {
  const model = new ScriptedModelAdapter(CALLS_THE_TOOL);
  const now = new Date().toISOString();
  const result = await runSessionTask({
    store: createInMemorySessionStore(),
    session: {
      id: "child",
      title: "child",
      workspace: "/w",
      createdAt: now,
      updatedAt: now,
    },
    model,
    binding: seeing,
    registry: opts.hostRegistry,
    allowedTools: opts.allowedTools,
    text: "look at page 1",
    isChild: true,
    ...(opts.extraTools ? { extraTools: opts.extraTools } : {}),
  });
  return { model, result };
}

const specNames = (model: ScriptedModelAdapter): string[] =>
  (model.requests[0]?.tools ?? []).map((t) => t.name);

const toolResult = (
  result: Awaited<ReturnType<typeof runSessionTask>>,
): string | undefined => {
  const call = result.items.find(
    (i) => i.type === "tool_call" && i.tool === "view_pdf_pages",
  );
  return call?.type === "tool_call" ? call.resultJson : undefined;
};

describe("extraTools — per-child executors (V4, ADR 0081 §6, O12)", () => {
  it("offers the spec and runs the call for the child that holds the executor", async () => {
    const host = new Map<ToolName, ToolExecutor>();
    const { executor } = createViewPdfPagesTool({ document: onePage() });
    const { model, result } = await runChildTask({
      hostRegistry: host,
      allowedTools: ["view_pdf_pages"],
      extraTools: new Map([["view_pdf_pages", executor]]),
    });
    expect(specNames(model)).toContain("view_pdf_pages");
    expect(toolResult(result)).toContain('"viewsRemaining":59');
    // The host registry was never written: the executor lived in the child's
    // own clone only.
    expect(host.has("view_pdf_pages")).toBe(false);
  });

  it("a sibling whose allowlist names the tool but holds no executor is offered nothing and cannot run it", async () => {
    const host = new Map<ToolName, ToolExecutor>();
    const { model, result } = await runChildTask({
      hostRegistry: host,
      allowedTools: ["view_pdf_pages"],
    });
    expect(specNames(model)).not.toContain("view_pdf_pages");
    expect(toolResult(result)).toContain('"code":"unavailable"');
  });

  it("an executor without the name in the allowlist is not offered either — two locks", async () => {
    const { executor } = createViewPdfPagesTool({ document: onePage() });
    const { model, result } = await runChildTask({
      hostRegistry: new Map(),
      allowedTools: [],
      extraTools: new Map([["view_pdf_pages", executor]]),
    });
    expect(specNames(model)).not.toContain("view_pdf_pages");
    expect(toolResult(result)).toContain('"code":"denied"');
  });
});
