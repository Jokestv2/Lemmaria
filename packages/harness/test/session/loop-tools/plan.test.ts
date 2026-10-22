import { describe, expect, it } from "vitest";
import type { SessionItem } from "../../../src/contracts/index.js";
import { createUpdatePlanTool } from "../../../src/session/loop-tools/plan.js";

function collector() {
  const items: SessionItem[] = [];
  return {
    items,
    emitItem: async (item: SessionItem) => void items.push(item),
  };
}

describe("createUpdatePlanTool (B1)", () => {
  it("declares itself SEQUENTIAL — `analysis` gives it no categorical backstop", async () => {
    // Every call upserts the SAME item id, so two overlapping calls would race
    // to be the todo list the user ends up looking at (ADR 0025 decision 1).
    const tool = createUpdatePlanTool({
      emitItem: async () => {},
      itemId: "todo-1",
    });
    expect(tool.executionMode).toBe("sequential");
  });

  it("emits one todo_list item and reports updated", async () => {
    const sink = collector();
    const tool = createUpdatePlanTool({
      emitItem: sink.emitItem,
      itemId: "todo-1",
    });
    const out = await tool.invoke({
      items: [{ text: "read the paper" }, { text: "draft", completed: true }],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ updated: true });
    expect(sink.items).toEqual([
      {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "read the paper", completed: false },
          { text: "draft", completed: true },
        ],
      },
    ]);
  });

  it("upserts in place: a second plan reuses the same item id", async () => {
    const sink = collector();
    const tool = createUpdatePlanTool({
      emitItem: sink.emitItem,
      itemId: "todo-1",
    });
    await tool.invoke({ items: [{ text: "a" }] });
    await tool.invoke({ items: [{ text: "a", completed: true }] });
    expect(sink.items.map((i) => i.id)).toEqual(["todo-1", "todo-1"]);
  });

  it("a bad shape is an `invalid` ToolError, never a throw", async () => {
    const sink = collector();
    const tool = createUpdatePlanTool({
      emitItem: sink.emitItem,
      itemId: "todo-1",
    });
    for (const args of [
      undefined,
      {},
      { items: [] },
      { items: "nope" },
      { items: [{ text: "" }] },
      { items: [{ completed: true }] },
    ]) {
      const out = await tool.invoke(args);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("invalid");
    }
    // An invalid plan emits nothing: the transcript must not show a plan the
    // model never successfully set.
    expect(sink.items).toEqual([]);
  });

  it("advertises the allowlisted name and the analysis category", () => {
    const tool = createUpdatePlanTool({
      emitItem: async () => {},
      itemId: "t",
    });
    expect(tool.name).toBe("update_plan");
    expect(tool.category).toBe("analysis");
    expect(tool.spec.name).toBe("update_plan");
  });
});
