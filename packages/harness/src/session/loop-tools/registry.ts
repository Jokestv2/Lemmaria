import type {
  ChildModel,
  GrantedRoot,
  NoticeItem,
  ProtectedSpanReader,
  SessionEditHost,
  SessionEvent,
  SessionItem,
  SessionLocale,
  SessionScriptHost,
  SessionTaskBudget,
  ToolSpec,
  Usage,
} from "../../contracts/index.js";
import type { Skill, SkillSummary } from "../../contracts/skills.js";
import type { ToolName } from "../../contracts/tools.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { carveChildBudget } from "../budget.js";
import type { SnapshotStore } from "../snapshot-store.js";
import type { FinalAnswerCheck } from "../task-hooks.js";
import type { AppliedLedger } from "./edit.js";
import { createProposeEditTool } from "./edit.js";
import { createUpdatePlanTool } from "./plan.js";
import { createRunScriptTool } from "./script.js";
import { createLoadSkillTool } from "./skill.js";
import {
  MAX_FAN_OUT,
  type SubtaskChildResult,
  createSpawnSubtaskTool,
} from "./subtask.js";

/**
 * The task's tool surface: the host's read registry plus whichever
 * loop-injected tools this task's configuration offers, and the allowlist and
 * specs that follow from it.
 *
 * Extracted from `run.ts` at B1. The gating rules here (a child gets no plan
 * tool and no fan-out; `run_script` needs interpreters AND grants; the
 * allowlist is de-duplicated) are the ones that decide what the model is told
 * it can do — one place, so B7's `load_skill` has an obvious home and so a
 * reader can see the whole capability surface at once (invariant 2).
 */
export interface TaskToolSurface {
  registry: Map<ToolName, ToolExecutor>;
  /** What the loop enforces AND what the envelope prompt declares. */
  allowedTools: ToolName[];
  toolSpecs: ToolSpec[];
  /** Present only with an edit host — the auto-apply `changed_files` source. */
  appliedLedger?: AppliedLedger;
  /** True when `run_script` is offered; the prompt declares interpreters then. */
  offerRunScript: boolean;
  /**
   * The skills the envelope prompt may declare (ADR 0028) — empty when
   * `load_skill` was not offered, so the prompt can never advertise a
   * capability this surface withheld. Summaries, never bodies.
   */
  skills: SkillSummary[];
}

export function assembleTaskToolSurface(args: {
  hostRegistry: Map<ToolName, ToolExecutor>;
  /** V4 (ADR 0081 §6): executors this task holds beyond the host's — set only
   *  on a child the review driver issued. */
  extraTools?: ReadonlyMap<ToolName, ToolExecutor>;
  /** The host's declared allowlist; defaults to every host registry tool. */
  allowedTools?: ToolName[];
  isChild?: boolean;
  editHost?: SessionEditHost;
  scriptHost?: SessionScriptHost;
  /** ADR 0031: threaded straight to `createProposeEditTool`'s optional dep. */
  snapshots?: SnapshotStore;
  /** D1 (ADR 0032): likewise — the protected-span detector `propose_edit` enforces with. */
  protectedSpans?: ProtectedSpanReader;
  /** X2 (ADR 0034): the language every tool note renders in. */
  locale?: SessionLocale;
  grants?: () => GrantedRoot[];
  /** Writing Skills the host loaded for this session (ADR 0028). */
  skills?: Skill[];
  workspaceRoot: string;
  /** The task's resolved budget — the source a child's slice is carved from. */
  budget: SessionTaskBudget;
  /** Live consumption, read at `spawn_subtask` call time (invariant 5). */
  usedSoFar: () => { turns: number; toolCalls: number; outputTokens: number };
  accrue: (usage: Usage) => void;
  runChild: (
    goal: string,
    allowedTools: ToolName[],
    ceilings: Partial<SessionTaskBudget>,
    /** R1 (ADR 0059): the equipped set, already resolved against the parent's. */
    skills: Skill[],
    /** R3 (ADR 0061 §6): a shape check fed back once inside the child's own
     *  loop. Set only by the review-panel driver, which reaches `runChild`
     *  directly; the `spawn_subtask` tool never passes one. */
    finalAnswerCheck?: FinalAnswerCheck,
    /** R9 (ADR 0069 §D3) and V4 (ADR 0081 §6): the review driver's two
     *  per-child extras. The `spawn_subtask` tool passes neither. */
    childModel?: ChildModel,
    childTools?: ReadonlyMap<ToolName, ToolExecutor>,
  ) => Promise<SubtaskChildResult>;
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  emitNotice: (code: NoticeItem["code"], n: number) => Promise<void>;
  /** The task's user_message id, threaded through to `propose_edit` (ADR 0017). */
  userMessageId: string;
  /** The one stable todo item id per task. */
  todoItemId: string;
  maxFanOut?: number;
  signal?: AbortSignal;
}): TaskToolSurface {
  const { hostRegistry, emit, emitItem, emitNotice } = args;
  const registry = new Map(hostRegistry);
  // V4 (ADR 0081 §6): a harness-issued child's own executors, merged into
  // THIS task's clone — never into `hostRegistry`, which the parent and every
  // sibling share. Before `toolSpecs` below, so the spec is offered iff the
  // name is also in this task's allowlist: two locks, at the surface.
  for (const [name, executor] of args.extraTools ?? []) {
    registry.set(name, executor);
  }

  // A3 review #1: a subagent child is read-only by construction — it gets no
  // plan tool either (a one-shot exploration has no use for a todo plan, and
  // offering it would understate the child's reported allowlist).
  const offerPlanTool = hostRegistry.size > 0 && args.isChild !== true;
  if (offerPlanTool) {
    registry.set(
      "update_plan",
      createUpdatePlanTool({ emitItem, itemId: args.todoItemId }),
    );
  }

  // --- the write path (ADR 0016): propose_edit is loop-provided, like
  // update_plan — offered only when the host configured an edit host. ---
  const editHost = args.editHost;
  let appliedLedger: AppliedLedger | undefined;
  if (editHost) {
    const { tool, applied } = createProposeEditTool({
      editHost,
      emit,
      emitItem,
      emitNotice,
      userMessageId: args.userMessageId,
      ...(args.snapshots ? { snapshots: args.snapshots } : {}),
      ...(args.protectedSpans ? { protectedSpans: args.protectedSpans } : {}),
      ...(args.locale ? { locale: args.locale } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    registry.set("propose_edit", tool);
    appliedLedger = applied;
  }

  // --- script execution (ADR 0020): run_script is loop-provided like
  // propose_edit — offered only when a script host with a non-empty
  // interpreter allowlist AND a grants getter (a script needs a granted-root
  // cwd) are configured. Refusals are data; the model self-corrects. ---
  const scriptHost = args.scriptHost;
  const offerRunScript =
    scriptHost !== undefined &&
    scriptHost.interpreters().length > 0 &&
    args.grants !== undefined;
  if (offerRunScript && scriptHost && args.grants) {
    registry.set(
      "run_script",
      createRunScriptTool({
        scriptHost,
        grants: args.grants,
        workspaceRoot: args.workspaceRoot,
        emit,
        emitItem,
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      }),
    );
  }

  // --- Writing Skills (B7, ADR 0028; R1, ADR 0059): load_skill is
  // loop-provided like the rest, offered whenever this task HAS skills.
  //
  // §D7's `isChild !== true` term is gone (R1). Its reasoning stands for the
  // DEFAULT — a child is bounded read-only exploration, so it gets nothing —
  // but the default is now enforced upstream, by what `runChild` forwards: a
  // child's `skills` is exactly the set its parent named for it, and `runChild`
  // is the only caller in the tree that sets `isChild: true`. So an unequipped
  // child arrives here with `[]` and is byte-identical to a pre-R1 one, while
  // an equipped one gets the tool and a catalogue restricted to its set.
  //
  // Placed ABOVE the subtask block so the resolved parent set can be handed to
  // `createSpawnSubtaskTool`. The Map's insertion order is not load-bearing —
  // the allowlist union and `toolSpecs` are built from an explicit list below.
  const skills = args.skills ?? [];
  const offerSkills = skills.length > 0;
  if (offerSkills) {
    registry.set("load_skill", createLoadSkillTool({ skills }));
  }

  // --- subagent fan-out (A3, ADR 0022): spawn_subtask is loop-provided like
  // propose_edit — offered only when the host gave a non-empty read registry
  // AND this task is not itself a child (depth bounded to one level). Children
  // are read-only (no editHost/scriptHost), get a narrowed allowlist, and a
  // budget slice carved from the parent's REMAINING budget (invariant 5). ---
  const offerSubtasks = hostRegistry.size > 0 && args.isChild !== true;
  if (offerSubtasks) {
    // The concurrency width: how many children run in PARALLEL at once. The rest
    // queue (mapWithConcurrency) — this is not a cap on how many may be requested.
    const fanOutConcurrency = Math.max(
      1,
      Math.min(MAX_FAN_OUT, args.maxFanOut ?? MAX_FAN_OUT),
    );
    const parentAllowed = args.allowedTools ?? [...hostRegistry.keys()];
    registry.set(
      "spawn_subtask",
      createSpawnSubtaskTool({
        emit,
        emitItem,
        parentAllowed,
        fanOutConcurrency,
        carveCeiling: (childCount) =>
          carveChildBudget(args.budget, args.usedSoFar(), childCount),
        accrue: args.accrue,
        runChild: args.runChild,
        // R1 (ADR 0059): the set a child's `skills` names are resolved
        // against is the parent's OFFERED skills — never a raw host list — so
        // a disabled or budget-omitted skill the parent cannot itself see can
        // never be handed to a child (ADR 0045 rungs 1 and 4, by construction).
        // `skills` IS that offered set here: `offerSkills` is exactly
        // `skills.length > 0`, and it is also what puts `load_skill` in the
        // parent's own allowlist below — which is why ADR 0022 §3's guarantee
        // that a child can never hold a tool its parent lacks still holds.
        parentSkills: skills,
        ...(args.signal ? { signal: args.signal } : {}),
      }),
    );
  }

  // De-duplicated: a caller already listing update_plan must not produce a
  // duplicate tool spec (some providers reject duplicate tool names).
  const allowedTools: ToolName[] = [
    ...new Set<ToolName>([
      ...(args.allowedTools ?? [...hostRegistry.keys()]),
      ...(offerPlanTool ? (["update_plan"] as const) : []),
      ...(editHost ? (["propose_edit"] as const) : []),
      ...(offerRunScript ? (["run_script"] as const) : []),
      ...(offerSubtasks ? (["spawn_subtask"] as const) : []),
      ...(offerSkills ? (["load_skill"] as const) : []),
    ]),
  ];
  const toolSpecs = allowedTools
    .map((name) => registry.get(name)?.spec)
    .filter((spec): spec is NonNullable<typeof spec> => spec !== undefined);

  return {
    registry,
    allowedTools,
    toolSpecs,
    ...(appliedLedger ? { appliedLedger } : {}),
    offerRunScript,
    // Summaries derived from the offered set, so the prompt's block and the
    // loop's allowlist cannot disagree about which skills exist.
    skills: offerSkills
      ? skills.map(({ name, description }) => ({ name, description }))
      : [],
  };
}
