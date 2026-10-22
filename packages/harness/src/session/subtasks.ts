import type {
  Result,
  SessionItem,
  SessionLocale,
  ToolError,
  ToolName,
  Usage,
} from "../contracts/index.js";
import { ok, toolFail } from "../contracts/index.js";
import { messagesFor } from "./messages.js";

/**
 * The tools a subagent child may be handed (A3, ADR 0022): read-only only. This
 * is the complement of the session-scoped mutating tools (`propose_edit`,
 * `run_script`, `update_plan`, `spawn_subtask`) and the quick-action surface
 * (`apply_edit`, `verify`) — a child can explore, never act.
 */
export const READ_ONLY_CHILD_TOOLS = [
  "count_words",
  "glossary_lookup",
  "get_outline",
  "read_span",
  "grep_project",
  "list_files",
  "literature_search",
  "list_labels",
  "citation_check",
  "list_citations",
  // V3 (ADR 0080 §7): read-only and child-safe by design — it renders bytes
  // the harness already chose and cannot name a file. V4 (ADR 0081 §6): only
  // the PDF reviewer's child holds an executor for it, handed in per child;
  // a child without one is offered nothing by this name.
  "view_pdf_pages",
] as const satisfies readonly ToolName[];

/** read-only ∩ parent ∩ requested — the result can only ever be ⊆ the parent's. */
export function narrowChildTools(
  parentAllowed: ToolName[],
  requested?: string[],
): ToolName[] {
  const readOnly = parentAllowed.filter((t) =>
    (READ_ONLY_CHILD_TOOLS as readonly string[]).includes(t),
  );
  if (!requested) return readOnly;
  const req = new Set(requested);
  return readOnly.filter((t) => req.has(t));
}

export interface ParsedChild {
  goal: string;
  allowedTools?: string[];
  /**
   * R1 (ADR 0059): the skills this child may load, named exactly as they appear
   * in the parent's `<available_skills>` block. De-duplicated, in the order the
   * model gave them; **absent or empty means unequipped**, which is the pre-R1
   * child byte for byte. Resolution against the parent's OFFERED set — and the
   * rejection of a name that is not in it — happens in `loop-tools/subtask.ts`,
   * which is the only place that knows what the parent holds.
   */
  skills?: string[];
}

/** Validate the spawn_subtask args (ADR 0024: a bad shape is `invalid`). */
export function parseSpawnSubtaskArgs(
  args: unknown,
): Result<ParsedChild[], ToolError> {
  const children = (args as { children?: unknown } | undefined)?.children;
  if (!Array.isArray(children) || children.length === 0) {
    return toolFail(
      "invalid",
      "spawn_subtask: args must be { children: [{ goal, allowed_tools? }, …] } with at least one child",
    );
  }
  const parsed: ParsedChild[] = [];
  for (const raw of children) {
    const goal = (raw as { goal?: unknown } | undefined)?.goal;
    if (typeof goal !== "string" || goal.trim() === "") {
      return toolFail(
        "invalid",
        "spawn_subtask: every child needs a non-empty goal",
      );
    }
    const at = (raw as { allowed_tools?: unknown }).allowed_tools;
    // Present-but-malformed must be rejected, not silently treated as absent —
    // otherwise a bad narrowing request WIDENS the child to every read tool.
    if (
      at !== undefined &&
      (!Array.isArray(at) || !at.every((s) => typeof s === "string"))
    ) {
      return toolFail(
        "invalid",
        "spawn_subtask: allowed_tools must be an array of tool-name strings",
      );
    }

    // R1 (ADR 0059), the same rule for the mirror-image reason: silently
    // treating a bad `skills` as absent would silently UN-equip the child, and
    // guidance lost with the harness unable to see it is the exact failure this
    // milestone exists to remove.
    const sk = (raw as { skills?: unknown }).skills;
    if (
      sk !== undefined &&
      (!Array.isArray(sk) || !sk.every((s) => typeof s === "string"))
    ) {
      return toolFail(
        "invalid",
        "spawn_subtask: skills must be an array of skill-name strings",
      );
    }

    parsed.push({
      goal,
      // absent → default (all read tools)
      ...(at !== undefined ? { allowedTools: at as string[] } : {}),
      // De-duplicated here rather than downstream: naming a skill twice is a
      // typo, not a request to load it twice (the ADR 0050 rule).
      ...(sk !== undefined ? { skills: [...new Set(sk as string[])] } : {}),
    });
  }
  return ok(parsed);
}

/**
 * The child's last agent message = its report-back, or an honest note in the
 * reader's language (X2, ADR 0034 — it used to carry both at once).
 */
export function lastAgentSummary(
  items: SessionItem[],
  locale?: SessionLocale,
): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "agent_message" && item.text.trim() !== "") {
      return item.text;
    }
  }
  return messagesFor(locale).subtaskNoReport;
}

/**
 * Sum the children's usage into the parent's total. `costUsd` is optional
 * (ADR 0002 — omitted for unknown-pricing models); the sum carries it only when
 * at least one child reported one, never fabricating a zero cost.
 */
export function sumUsage(usages: (Usage | undefined)[]): Usage | undefined {
  const present = usages.filter((u): u is Usage => u !== undefined);
  if (present.length === 0) return undefined;
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  let anyCost = false;
  let costUsd = 0;
  for (const u of present) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    if (u.costUsd !== undefined) {
      anyCost = true;
      costUsd += u.costUsd;
    }
  }
  if (anyCost) total.costUsd = costUsd;
  return total;
}
