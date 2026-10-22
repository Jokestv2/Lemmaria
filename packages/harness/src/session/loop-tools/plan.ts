import type { Result, SessionItem, ToolError } from "../../contracts/index.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { ToolExecutor } from "../../engine/tools.js";

/**
 * `update_plan` — the task's todo plan (ADR 0015).
 *
 * A loop-injected tool: it is not in the host's registry, the loop adds it when
 * the task is not a subagent child. One file per loop-injected tool (B1), the
 * shape Pi's `harness/tools/` uses — each tool is independently constructible
 * and therefore independently testable, without running a task.
 */

interface TodoEntry {
  text: string;
  completed: boolean;
}

/** Validate update_plan args (ADR 0024: a bad shape is `invalid`, not a throw). */
function parseTodoItems(args: unknown): Result<TodoEntry[], ToolError> {
  const items = (args as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return toolFail(
      "invalid",
      "update_plan: args must be { items: [{ text, completed? }, …] } with at least one item",
    );
  }
  const parsed: TodoEntry[] = [];
  for (const raw of items) {
    const text = (raw as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || text.length === 0) {
      return toolFail(
        "invalid",
        "update_plan: every item needs a non-empty text",
      );
    }
    parsed.push({
      text,
      completed: (raw as { completed?: unknown }).completed === true,
    });
  }
  return ok(parsed);
}

export const UPDATE_PLAN_SPEC = {
  name: "update_plan" as const,
  description:
    "Maintain this task's todo plan. Send the FULL current plan each time (not a delta); mark finished steps completed: true.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            completed: { type: "boolean" },
          },
          required: ["text"],
        },
      },
    },
    required: ["items"],
  } as Record<string, unknown>,
};

export function createUpdatePlanTool(deps: {
  emitItem: (item: SessionItem) => Promise<void>;
  /** The ONE stable todo item id per task — successive plans upsert in place. */
  itemId: string;
}): ToolExecutor {
  return {
    name: "update_plan",
    category: "analysis",
    // B3 (ADR 0025): explicit, not merely defaulted — every call upserts the
    // SAME `itemId`, so two overlapping calls would race to be the todo list
    // the user ends up looking at. `analysis` would otherwise be the category
    // most likely to be marked parallel by someone skimming.
    executionMode: "sequential",
    spec: UPDATE_PLAN_SPEC,
    invoke: async (args) => {
      const items = parseTodoItems(args);
      if (!items.ok) return items;
      await deps.emitItem({
        id: deps.itemId,
        type: "todo_list",
        items: items.value,
      });
      return ok({ updated: true });
    },
  };
}
