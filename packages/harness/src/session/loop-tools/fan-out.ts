import type { ChildModel } from "../../contracts/adapters.js";
import type {
  SessionItem,
  SessionTaskBudget,
  Usage,
} from "../../contracts/index.js";
import type { Skill } from "../../contracts/skills.js";
import type { ToolName } from "../../contracts/tools.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { type ChildAllowance, withChildAllowance } from "../budget.js";
import { mapWithConcurrency } from "../concurrency.js";
import { lastAgentSummary, sumUsage } from "../subtasks.js";
import type { FinalAnswerCheck } from "../task-hooks.js";
import type { SubtaskChildResult } from "./subtask.js";

/**
 * The fan-out CORE (R3, ADR 0061 §3) — running N already-validated children
 * concurrently, in isolation from one another, and rolling their cost up into
 * the parent.
 *
 * Extracted from `createSpawnSubtaskTool`, whose body this was, because R3's
 * review panel issues a fan-out that no model turn asked for and must not
 * emit a `subtask` item. What differs between the two callers is only what
 * they emit as progress, so that is the seam: the caller supplies `hooks`, and
 * everything else — the concurrency width, the abort check on a queued child,
 * the per-child settle, the usage sum — is shared.
 *
 * **The tool path is byte-identical after the extraction.** Its own tests are
 * the pin: a fan-out test that had to be edited to pass would have meant the
 * extraction changed behaviour.
 */

/** One child to run, already validated by whoever assembled the fan-out. */
export interface FanOutChild {
  goal: string;
  /** The read-only set this child gets — already narrowed within the parent's. */
  allowedTools: ToolName[];
  /** R1 (ADR 0059): the equipped set, already resolved against the parent's. */
  skills: Skill[];
  /**
   * R3 (ADR 0061 §6): a dry run of the interpreter over this child's would-be
   * final answer, fed back once inside its own loop when it fails. Only the
   * review driver sets it — `parseSpawnSubtaskArgs` produces none, so a
   * `spawn_subtask` child's check is always unset.
   */
  finalAnswerCheck?: FinalAnswerCheck;
  /**
   * R9 (ADR 0069 §D3): the model this child runs on, instead of the parent's.
   *
   * Set only by the review panel, whose reviewers are each bound to a model
   * the user picked. `parseSpawnSubtaskArgs` produces none, exactly as with
   * `finalAnswerCheck` above, so a `spawn_subtask` child's options object is
   * byte-identical to pre-R9 — which is what the untouched tool-path suite
   * pins. Everything else a child inherits (retry, sleep, grants, signal,
   * locale, protected spans) is unchanged: a reviewer on a different model
   * still inherits the parent's POLICY.
   */
  model?: ChildModel;
  /**
   * V4 (ADR 0081 §6): executors THIS child holds and no other does — merged
   * into its own per-task registry clone, never into the host registry. Set
   * only by the review driver, for the one seat that views the compiled PDF;
   * `parseSpawnSubtaskArgs` produces none, so a `spawn_subtask` child is
   * byte-identical.
   */
  tools?: ReadonlyMap<ToolName, ToolExecutor>;
  /**
   * ADR 0082 §1: turns and tool calls THIS child gets on top of the carved
   * slice its siblings share. Set only by the review driver, for the seat
   * whose protocol spends one of each per page it views; a `spawn_subtask`
   * child never carries it, so its ceilings are byte-identical.
   */
  allowance?: ChildAllowance;
}

/** What one child settled as — the shape the caller turns into its own record. */
export interface FanOutOutcome {
  status: "completed" | "failed" | "interrupted";
  /** The child's last agent message, or the honest no-report note. */
  summary: string;
  /**
   * The child's own transcript, **transient**. The `spawn_subtask` tool
   * discards it (ADR 0022's rule: only the summary returns to the parent), and
   * R3's driver reads it once for the honesty record — did the seat load the
   * protocol, did a literature source fail under it — and then discards it too.
   * Neither caller persists a child item, which is what keeps a fan-out from
   * flooding the parent's transcript.
   */
  items: SessionItem[];
  usage?: Usage;
}

export interface FanOutDeps {
  /** Concurrency width, already clamped against MAX_FAN_OUT by the caller. */
  fanOutConcurrency: number;
  /** A child slice carved from the parent's REMAINING budget (invariant 5). */
  carveCeiling: (childCount: number) => Partial<SessionTaskBudget>;
  /** Roll the fan-out's usage into the parent's budget + total. */
  accrue: (usage: Usage) => void;
  /** `runSessionTask`, injected so loop-tools never imports run.ts. */
  runChild: (
    goal: string,
    allowedTools: ToolName[],
    ceilings: Partial<SessionTaskBudget>,
    skills: Skill[],
    finalAnswerCheck?: FinalAnswerCheck,
    model?: ChildModel,
    /** V4 (ADR 0081 §6): per-child executors — see `FanOutChild.tools`. */
    childTools?: ReadonlyMap<ToolName, ToolExecutor>,
  ) => Promise<SubtaskChildResult>;
  signal?: AbortSignal;
}

/** What the caller does with the fan-out's progress — its own item's shape. */
export interface FanOutHooks {
  /** Every child is running; the caller emits its `started` record. */
  onStarted: () => Promise<void>;
  /** One child settled, at its request index. The caller updates and streams. */
  onChildSettled: (index: number, outcome: FanOutOutcome) => Promise<void>;
}

export interface FanOutResult {
  outcomes: FanOutOutcome[];
  /** Summed over the children; `undefined` when no child reported any. */
  usage?: Usage;
}

/**
 * Run `children` concurrently and return their settled outcomes in REQUEST
 * order (`mapWithConcurrency` preserves the index), having accrued their summed
 * usage into the parent.
 *
 * Subagent COST rolls up to the parent — output tokens ⇒ the parent's budget
 * and usage, the real runaway guard — but subagent tool-call/turn THROUGHPUT
 * does not: a fan-out amplifies read capacity in isolated contexts, so each
 * child's own carved slice bounds it (ADR 0022 §3).
 */
export async function runFanOut(
  deps: FanOutDeps,
  children: readonly FanOutChild[],
  hooks: FanOutHooks,
): Promise<FanOutResult> {
  const outcomes: FanOutOutcome[] = children.map(() => ({
    status: "completed",
    summary: "",
    items: [],
  }));
  await hooks.onStarted();
  const childCeiling = deps.carveCeiling(children.length);
  await mapWithConcurrency(
    [...children],
    deps.fanOutConcurrency,
    async (child, i): Promise<void> => {
      // A child queued behind others may find the task already aborted; don't
      // start it — report it interrupted (the running ones abort through the
      // shared signal).
      let outcome: FanOutOutcome;
      if (deps.signal?.aborted) {
        outcome = {
          status: "interrupted",
          summary: lastAgentSummary([]),
          items: [],
        };
      } else {
        const res = await deps.runChild(
          child.goal,
          child.allowedTools,
          child.allowance === undefined
            ? childCeiling
            : withChildAllowance(childCeiling, child.allowance),
          child.skills,
          child.finalAnswerCheck,
          child.model,
          child.tools,
        );
        outcome = {
          status: res.status,
          summary: lastAgentSummary(res.items),
          items: res.items,
          ...(res.usage ? { usage: res.usage } : {}),
        };
      }
      outcomes[i] = outcome;
      await hooks.onChildSettled(i, outcome);
    },
  );
  const usage = sumUsage(outcomes.map((o) => o.usage));
  if (usage) deps.accrue(usage);
  return { outcomes, ...(usage ? { usage } : {}) };
}
