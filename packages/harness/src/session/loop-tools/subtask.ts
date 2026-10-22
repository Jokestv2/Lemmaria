import { randomUUID } from "node:crypto";
import type {
  SessionEvent,
  SessionItem,
  SessionTaskBudget,
  SubtaskItem,
  SubtaskReport,
  Usage,
} from "../../contracts/index.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { Skill } from "../../contracts/skills.js";
import type { ToolName } from "../../contracts/tools.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { narrowChildTools, parseSpawnSubtaskArgs } from "../subtasks.js";
import type { FinalAnswerCheck } from "../task-hooks.js";
import { type FanOutChild, runFanOut } from "./fan-out.js";

/**
 * `spawn_subtask` — bounded read-only subagent fan-out (A3, ADR 0022).
 *
 * A loop-injected tool, offered only when the host gave a non-empty read
 * registry AND this task is not itself a child (depth bounded to one level).
 * Extracted from `run.ts` at B1 with the recursion INVERTED: the factory takes
 * a `runChild` callback rather than importing `runSessionTask`, so
 * `loop-tools/` never depends on the module that assembles it.
 */

/**
 * Harness hard cap on subagent fan-out CONCURRENCY (A3, ADR 0022) — the most
 * children a single fan-out runs in parallel at once, bounding concurrent model
 * calls (rate-limit/cost spikes). The host's `lemmaria.budget.maxFanOut` setting
 * clamps down further. This is a *concurrency* limit, not a cap on how many
 * children may be requested: over the concurrency limit, children queue and run
 * as slots free (see `mapWithConcurrency`) — never silently dropped.
 */
export const MAX_FAN_OUT = 8;

/**
 * Harness hard cap on the number of children a single `spawn_subtask` call may
 * request (A3, ADR 0022). Above this the call is rejected with an honest error
 * that names the limit (adapted from Codex's `AgentLimitReached`) so the model
 * spawns the rest in a follow-up call, rather than the request being silently
 * truncated. Generous enough for realistic fan-outs (one child per folder/paper)
 * while still bounding a pathological request's input-token cost.
 */
export const MAX_SUBTASK_CHILDREN = 16;

/**
 * The spec a parent with NO Writing Skills sees — and the spec every session
 * written before R1 saw, byte for byte.
 *
 * R1 (ADR 0059) made the spec per-instance so an equipped parent can be told
 * about `skills`, but `prompt.ts`'s standing rule applies to the tool spec too:
 * never advertise what the surface withheld. `buildSpawnSubtaskSpec([])`
 * returns exactly this object.
 */
export const SPAWN_SUBTASK_SPEC = {
  name: "spawn_subtask" as const,
  description:
    "Fan out bounded READ-ONLY exploration to isolated child agents. Each child runs its own retrieval loop in a fresh context and returns ONLY a short report — use this to survey large material (a codebase, a literature set, a results directory) without flooding this conversation with source text. Children cannot edit files, run scripts, or spawn further children; they share your read grants. Provide 1–N children (up to 16 per call) as { goal, allowed_tools? }; allowed_tools narrows a child to a subset of your own read tools. Children run in parallel up to a configured concurrency limit; any beyond it queue and run as slots free — so request one child per unit of work (e.g. one per folder) in a single call, don't pre-batch.",
  parameters: {
    type: "object",
    properties: {
      children: {
        type: "array",
        items: {
          type: "object",
          properties: {
            goal: { type: "string" },
            allowed_tools: { type: "array", items: { type: "string" } },
          },
          required: ["goal"],
        },
      },
    },
    required: ["children"],
  } as Record<string, unknown>,
};

/**
 * R1 (ADR 0059): the spec this instance advertises. With no parent skills it
 * IS `SPAWN_SUBTASK_SPEC`; with skills it gains the `skills` property and one
 * clause naming what the argument does — including S5's finding, stated to the
 * model that made it (*never paraphrase a skill into a goal*).
 */
function buildSpawnSubtaskSpec(
  parentSkills: Skill[],
): typeof SPAWN_SUBTASK_SPEC {
  if (parentSkills.length === 0) return SPAWN_SUBTASK_SPEC;
  const base = SPAWN_SUBTASK_SPEC.parameters as {
    type: string;
    properties: {
      children: {
        type: string;
        items: {
          type: string;
          properties: Record<string, unknown>;
          required: string[];
        };
      };
    };
    required: string[];
  };
  return {
    name: SPAWN_SUBTASK_SPEC.name,
    description: `${SPAWN_SUBTASK_SPEC.description.replace(
      "as { goal, allowed_tools? }",
      "as { goal, allowed_tools?, skills? }",
    )} skills names which of your loaded Writing Skills that child may load (exactly as listed in available_skills): it then gets load_skill and a catalogue of exactly those skills; a child with no skills gets neither. Equip a child whenever its task is one a skill's description covers — the body reaches the child byte-exact, where a paraphrase in the goal would not.`,
    parameters: {
      ...base,
      properties: {
        ...base.properties,
        children: {
          ...base.properties.children,
          items: {
            ...base.properties.children.items,
            properties: {
              ...base.properties.children.items.properties,
              skills: {
                type: "array",
                items: { type: "string" },
                description:
                  "Names from available_skills this child may load; omit for none.",
              },
            },
          },
        },
      },
    } as Record<string, unknown>,
  };
}

/** What a child run reports back — the shape `runSessionTask` returns. */
export interface SubtaskChildResult {
  status: "completed" | "failed" | "interrupted";
  items: SessionItem[];
  usage?: Usage;
}

export function createSpawnSubtaskTool(deps: {
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  /** The parent's own allowlist — a child can only be narrowed within it. */
  parentAllowed: ToolName[];
  /** Concurrency width, already clamped against MAX_FAN_OUT by the caller. */
  fanOutConcurrency: number;
  /** A child slice carved from the parent's REMAINING budget (invariant 5). */
  carveCeiling: (childCount: number) => Partial<SessionTaskBudget>;
  /** Roll the fan-out's usage into the parent's budget + total. */
  accrue: (usage: Usage) => void;
  /**
   * R1 (ADR 0059): the parent's OFFERED skills — the set a child's `skills`
   * names are resolved against. Defaults to `[]`, so a caller that offers none
   * (and every pre-R1 caller) behaves exactly as before.
   */
  parentSkills?: Skill[];
  /** `runSessionTask`, injected so loop-tools never imports run.ts. */
  runChild: (
    goal: string,
    allowedTools: ToolName[],
    ceilings: Partial<SessionTaskBudget>,
    /** R1 (ADR 0059): the resolved equipped set; `[]` for an unequipped child. */
    skills: Skill[],
    /** R3 (ADR 0061 §6): unset for every `spawn_subtask` child, by design. */
    finalAnswerCheck?: FinalAnswerCheck,
  ) => Promise<SubtaskChildResult>;
  signal?: AbortSignal;
}): ToolExecutor {
  const { emit, emitItem } = deps;
  const parentSkills = deps.parentSkills ?? [];
  return {
    name: "spawn_subtask",
    category: "analysis",
    // B3 (ADR 0025): explicit, and it is INVARIANT 5 that requires it —
    // `carveCeiling` reads the parent's REMAINING budget at call time, so two
    // overlapping carves would each see the same remainder and hand out more
    // than the parent has left. (It is also its own concurrency pool; nesting
    // one inside another would multiply the widths.)
    executionMode: "sequential",
    spec: buildSpawnSubtaskSpec(parentSkills),
    invoke: async (args) => {
      const parsedChildren = parseSpawnSubtaskArgs(args);
      if (!parsedChildren.ok) return parsedChildren;
      const children = parsedChildren.value;
      // Reject an over-large request honestly (Codex AgentLimitReached shape)
      // BEFORE emitting the item, so the model can re-spawn the rest rather
      // than silently losing children. Concurrency (fanOutConcurrency) only
      // bounds how many run at once — it never truncates the request.
      if (children.length > MAX_SUBTASK_CHILDREN) {
        return toolFail(
          "too_large",
          `spawn_subtask: ${children.length} children requested but at most ${MAX_SUBTASK_CHILDREN} may be spawned in one call — spawn the remaining children in a follow-up call.`,
        );
      }
      // R1 (ADR 0059): validate and resolve the equipped sets, PRE-FLIGHT.
      //
      // Both failures below are `invalid` — the ADR 0024 code whose gloss is
      // "fix the arguments and re-issue", which is exactly what the parent
      // should do — and both are checked here, beside the MAX_SUBTASK_CHILDREN
      // cap and BEFORE `item.started`, so a bad request emits no item and runs
      // no child. Silently dropping an unknown name was rejected: guidance lost
      // with the harness unable to see it is the failure R1 exists to remove.
      // Each child's read allowlist is derived HERE too, once, so the report's
      // prediction and the set handed to `runChild` come from one place. They
      // used to be two expressions — one indexed, one captured — that agreed
      // only because `mapWithConcurrency` preserves the index, and the indexed
      // one degraded to `narrowChildTools(parentAllowed, undefined)` = EVERY
      // read tool if it were ever wrong. That is a widening failure mode hidden
      // behind a plausible default, which is the worst kind to leave standing.
      const narrowedOf: ToolName[][] = children.map((child) =>
        narrowChildTools(deps.parentAllowed, child.allowedTools),
      );
      const equipped: Skill[][] = [];
      for (const [i, child] of children.entries()) {
        // An explicitly EMPTY list means unequipped, and is checked BEFORE the
        // skill-free-parent rejection below: D1 says "absent, or `[]`, means
        // unequipped", so `[]` is not `skills` *given* in D2's sense. Pinned in
        // `subtask.test.ts`, because the two decisions can be read to disagree.
        if (child.skills === undefined || child.skills.length === 0) {
          equipped.push([]);
          continue;
        }
        if (parentSkills.length === 0) {
          return toolFail(
            "invalid",
            "spawn_subtask: skills was given but no Writing Skills are loaded in this session — omit skills.",
          );
        }
        const available = parentSkills.map((s) => s.name);
        const unknown = child.skills.find((n) => !available.includes(n));
        if (unknown !== undefined) {
          // Names only, never a path (ADR 0028 §D3), and names what IS there so
          // the next call can self-correct (the ADR 0024 guidance rule).
          return toolFail(
            "invalid",
            `spawn_subtask: child ${i + 1} names a skill that is not loaded: "${unknown}". Available: ${available.join(", ")}.`,
          );
        }
        // Resolved IN THE PARENT'S CATALOGUE ORDER — a filter over the parent's
        // set, not a map over the request, so a child's block order is stable
        // and independent of how the model happened to list them.
        equipped.push(
          parentSkills.filter((s) => child.skills?.includes(s.name)),
        );
      }

      const itemId = randomUUID();
      // Stream progress (review: don't make the user watch a spinner with no
      // detail while children run — especially serially at maxFanOut=1). Every
      // child starts as a `running` placeholder so the whole set is visible at
      // once, and each flips to its terminal report the moment it settles, via
      // live-only `item.updated` events. Only the final `item.completed` (all
      // terminal) is persisted (ADR 0015).
      // R1 (ADR 0059): what the record says about a child's equipment. Both
      // fields are computed HERE, beside `narrowChildTools`, because both are
      // predictions of the child's surface made before it runs.
      //
      // `allowedTools` names `load_skill` iff equipped, because that is the
      // tool set the child's surface really holds (`registry.ts` unions it in)
      // — the A3 review's rule is that the report must not UNDERSTATE the
      // child's allowlist. `runChild` still receives the narrowed READ set
      // only: `load_skill` is not a host-registry tool, so passing it there
      // would name a tool the child's registry does not hold.
      const equipmentOf = (
        i: number,
      ): Pick<SubtaskReport, "allowedTools" | "skills"> => {
        const narrowed = narrowedOf[i] ?? [];
        const set = equipped[i] ?? [];
        return set.length === 0
          ? { allowedTools: narrowed }
          : {
              // `narrowChildTools` intersects with READ_ONLY_CHILD_TOOLS, which
              // has never contained `load_skill`, so this cannot duplicate.
              allowedTools: [...narrowed, "load_skill"],
              skills: set.map((s) => s.name),
            };
      };
      const reports: SubtaskReport[] = children.map((child, i) => ({
        goal: child.goal,
        status: "running",
        summary: "",
        ...equipmentOf(i),
      }));
      const snapshot = (): SubtaskReport[] => reports.map((r) => ({ ...r }));
      const emitProgress = (type: "item.started" | "item.updated") =>
        emit({
          type,
          item: {
            id: itemId,
            type: "subtask",
            status: "running",
            reports: snapshot(),
          },
        });
      // R3 (ADR 0061 §3): the running is `runFanOut`'s, and what stays here is
      // exactly what is this TOOL's — the `subtask` item and its report set.
      // A `spawn_subtask` child never gets a `finalAnswerCheck`: its report is
      // prose, and `parseSpawnSubtaskArgs` produces no such field.
      const fanOutChildren: FanOutChild[] = children.map((child, i) => ({
        goal: child.goal,
        allowedTools: narrowedOf[i] ?? [],
        skills: equipped[i] ?? [],
      }));
      const { usage } = await runFanOut(deps, fanOutChildren, {
        onStarted: () => emitProgress("item.started"),
        onChildSettled: async (i, outcome) => {
          // What the RECORD says (may name `load_skill`, R1) vs. what the
          // child's host registry was actually narrowed to. They are different
          // sets on purpose — see `equipmentOf`.
          reports[i] = {
            goal: children[i]?.goal ?? "",
            status: outcome.status,
            summary: outcome.summary,
            ...equipmentOf(i),
            ...(outcome.usage ? { usage: outcome.usage } : {}),
          };
          // This child settled — stream the growing report set to the UI.
          await emitProgress("item.updated");
        },
      });
      const status: SubtaskItem["status"] = deps.signal?.aborted
        ? "interrupted"
        : "completed";
      await emitItem({
        id: itemId,
        type: "subtask",
        status,
        reports,
        ...(usage ? { usage } : {}),
      });
      // The report-back the parent's model sees: ordered summaries only.
      return ok({
        reports: reports.map((r) => ({
          goal: r.goal,
          status: r.status,
          summary: r.summary,
        })),
      });
    },
  };
}
