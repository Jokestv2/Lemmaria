import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  GenerateResult,
  NoticeItem,
  SessionItem,
  SessionTaskBudget,
  ToolCall,
  Usage,
} from "../contracts/index.js";
import type { ToolName } from "../contracts/tools.js";
import type { ToolExecutor } from "../engine/tools.js";
import { TURN_MAX_TOKENS } from "./budget.js";
import { contextLimitReached, windowOccupancy } from "./context.js";
import type { AppliedLedger } from "./loop-tools/edit.js";
import type {
  LoopStop,
  SessionLoopHooks,
  StreamFailureAction,
} from "./loop.js";
import {
  type RetryPolicy,
  decideRetryOnBudget,
  decideStreamRetry,
} from "./retry.js";
import {
  evictImagesBefore,
  failTruncatedToolBatch,
  hasLiveImagesFrom,
  runToolBatch,
} from "./tool-batch.js";

/**
 * A dry run of whatever will parse a child's final answer (R3, ADR 0061 §6),
 * widened at V2 (ADR 0078 §4) to see what that child has already done.
 *
 * `items` is the task's transcript so far — every completed tool call of its
 * earlier turns, each with its recorded result. The review driver reads its
 * seat's own `literature_search` calls out of it, so a cited paper is checked
 * against what THAT reviewer was actually shown.
 *
 * **Still once per child.** `MAX_FINAL_ANSWER_RETRIES` does not move; what
 * changed is what the check can see, not how often it is asked. A
 * one-argument function stays assignable, which is why V1's verifier check
 * and every existing caller compile unedited.
 */
export type FinalAnswerCheck = (
  text: string,
  items: readonly SessionItem[],
) => string | undefined;

/**
 * The task's POLICY (B1) — budgets, retry, and the compaction trigger — as the
 * hooks `session/loop.ts` calls. `run.ts` owns assembly, `loop.ts` owns
 * mechanism, this owns what the loop is allowed to do next.
 *
 * Each hook here is a verbatim move of an inline decision the turn loop used to
 * make. B2 (ADR 0026, retry policy) and B4 (retention) change this file rather
 * than the loop.
 */

/** A policy decision becomes the loop's instruction, with its honest notice. */
function actionFor(
  decision: ReturnType<typeof decideStreamRetry>,
): StreamFailureAction {
  switch (decision.kind) {
    case "retry":
      return { kind: "retry", delayMs: decision.delayMs };
    case "exhausted":
      return {
        kind: "fail",
        notice: { code: "stream.retry_failed", n: decision.attempts },
      };
    case "quota":
      return { kind: "fail", notice: { code: "provider.quota", n: 0 } };
    default:
      // A fatal failure's own message is the whole story; the loop already
      // shows it as an error item, and a notice would only repeat it.
      return { kind: "fail" };
  }
}

/**
 * How many times a failing final answer is handed back inside the task's own
 * loop (R3, ADR 0061 §6). ONE, deliberately: a shape failure is a
 * one-round-trip mistake — the model wrote prose around its JSON, or set a
 * field the interpreter refuses — and a model that gets the same feedback
 * twice and still fails is not going to get it on the third. The record then
 * says the report was unparseable, which is the honest outcome.
 */
export const MAX_FINAL_ANSWER_RETRIES = 1;

/** The task's live consumption, mutated in place as the task runs. */
export interface TaskCounters {
  total: Usage;
  toolCallsUsed: number;
  turnsUsed: number;
  /**
   * A2: one compaction per consecutive threshold crossing — compacting a
   * summary again would just decay it, so a still-full next turn stops.
   */
  justCompacted: boolean;
}

export function createTaskHooks(deps: {
  counters: TaskCounters;
  budget: SessionTaskBudget;
  model: string;
  registry: Map<ToolName, ToolExecutor>;
  allowedTools: ToolName[];
  /** The live conversation the loop appends to. */
  messages: ChatMessage[];
  emitItem: (item: SessionItem) => Promise<void>;
  /** B2: the truncated-turn recovery's own notice, emitted from `runToolCalls`. */
  emitNotice: (code: NoticeItem["code"], n: number) => Promise<void>;
  /**
   * B2 (ADR 0026): already resolved by `run.ts`; shared with children.
   *
   * The jitter source is deliberately NOT injected here: `retryDelayMs` takes
   * one for its own unit test, and a second seam with no supplier in either
   * production or test would be the speculative-seam B1 ruled out. Loop and
   * task tests assert the delay's band, or set `baseDelayMs` to 0.
   */
  retry: RetryPolicy;
  appliedLedger?: AppliedLedger;
  takeSteering?: () => string | undefined;
  /**
   * R3 (ADR 0061 §6): a dry run of whatever will parse this task's final
   * answer. Consulted on the turn that would COMPLETE the task; a returned
   * string is stashed and drained by `takeSteering` as one steered user
   * message, and the task runs another turn instead of stopping.
   *
   * Bounded by `MAX_FINAL_ANSWER_RETRIES`, so it can never keep a task alive:
   * a second failing answer completes normally and the CALLER decides what an
   * unparseable report means. Unset for every caller but the review driver.
   *
   * **One argument here, deliberately, while the outer declarations take two**
   * (V2, ADR 0078 §4). The hooks know nothing about the task's items — the
   * emitter that holds them lives in `run.ts`, which is what binds them in.
   * Widening this signature would make every hook caller reach for a
   * transcript it has no business reading.
   */
  finalAnswerCheck?: (text: string) => string | undefined;
  /** A2: summarize + persist the checkpoint; false = it did NOT happen. */
  compact: (
    trigger: "auto" | "manual",
    tokensBefore: number,
  ) => Promise<boolean>;
  /** How the task ends when compaction did not happen. */
  failedCompactionStop: () => Promise<LoopStop>;
  signal?: AbortSignal;
}): SessionLoopHooks {
  const { counters, budget, emitItem, messages } = deps;
  /**
   * Is this turn's reported occupancy over the compaction threshold? A pure
   * function of the turn's own usage, deliberately NOT latched between hooks:
   * a value carried from `shouldStopAfterTurn` to `afterTurn` would compact on
   * the previous turn's measurement the moment the loop's call order changed.
   */
  const overContextLimit = (result: GenerateResult): boolean =>
    contextLimitReached(occupancyAfter(result), deps.model);
  /**
   * ADR 0051: this turn's measured occupancy, or an estimate over the live
   * request when the provider reported none. Shared by the check and the
   * checkpoint it writes, so the number tested and the number recorded are the
   * same one.
   */
  const occupancyAfter = (result: GenerateResult): number =>
    windowOccupancy(result.usage, messages);

  /**
   * R3 (ADR 0061 §6): the feedback a failing final answer earned, waiting for
   * the steering drain. Held here rather than pushed straight onto `messages`
   * because the loop's own drain is what makes it a persisted, visible
   * `user_message` — the seat's transcript shows what it was told, and a
   * resumed session replays it.
   */
  let pendingFeedback: string | undefined;
  let finalAnswerRetriesLeft = MAX_FINAL_ANSWER_RETRIES;

  return {
    beforeTurn: () => {
      if (counters.total.outputTokens >= budget.maxOutputTokens) {
        // No output budget left before this turn even starts — a fully-carved
        // child slice (0 tokens) must NOT spend the forced 1-token minimum on a
        // model call (review). The post-turn check handles mid-task exhaustion.
        return {
          status: "completed",
          notices: [
            { code: "budget.output_tokens", n: budget.maxOutputTokens },
          ],
        };
      }
      return undefined;
    },
    countTurn: () => {
      counters.turnsUsed += 1;
    },
    turnMaxTokens: () =>
      Math.max(
        1,
        Math.min(
          TURN_MAX_TOKENS,
          budget.maxOutputTokens - counters.total.outputTokens,
        ),
      ),
    // B2 (ADR 0026): classify, then consult the policy. Replaces A1a's single
    // immediate retry at every one of its sites, children included.
    onStreamFailure: (error, attempt) =>
      actionFor(decideStreamRetry(error, attempt, deps.retry)),
    // A1a: a bare stream end is retried REGARDLESS of classification — there is
    // no error to classify (B1's reasoning, unchanged), so it takes the
    // budget-only decision rather than being routed through the classifier
    // with a stand-in error. B2 gives it the same attempt budget and the same
    // backoff, still on the shared counter, so one turn covers both causes.
    onMissingTerminal: (attempt) =>
      actionFor(decideRetryOnBudget(attempt, deps.retry)),
    shouldStopAfterTurn: (result: GenerateResult) => {
      const truncated = result.stopReason === "max_tokens";
      /**
       * A truncated turn that stops for some OTHER reason still owes the user
       * the truncation fact (B2 review). With `TURN_MAX_TOKENS` 8192 against a
       * 16 000-token default task budget, a truncated second turn lands on the
       * output-budget check almost by arithmetic — and reporting only the
       * budget would leave the discarded tool calls unexplained, which is
       * exactly the A6 failure mode this notice was written to end. The
       * truncation is named FIRST because it happened first.
       */
      const alsoTruncated = (notice: {
        code: NoticeItem["code"];
        n: number;
      }) => ({
        status: "completed" as const,
        notices: truncated
          ? ([{ code: "turn.truncated" as const, n: 0 }, notice] as const)
          : ([notice] as const),
      });

      if (truncated && result.toolCalls.length === 0) {
        // The answer was truncated by the PER-TURN cap — a silent mid-sentence
        // cut-off with status "completed" would be dishonest (A1a review #3).
        //
        // A6: it used to report `budget.output_tokens`, i.e. "Task stopped:
        // output-token budget (16000) reached" — a limit that had NOT been
        // reached, since the cause is `TURN_MAX_TOKENS` and the task may have
        // spent a fraction of its budget. The notice now names the real limit.
        //
        // B2: this branch is now the case where the turn carried NO tool call,
        // so there is nothing to re-issue and the task genuinely ends. A
        // truncated turn that DID carry calls falls through to the recovery in
        // `runToolCalls` (ADR 0026).
        return {
          status: "completed",
          notices: [{ code: "turn.truncated", n: 0 }],
        };
      }
      if (
        !truncated &&
        (result.stopReason !== "tool_use" || result.toolCalls.length === 0)
      ) {
        // Guarded on `!truncated` because `max_tokens` is not `tool_use`: an
        // unguarded check here would swallow the very turn being recovered.
        //
        // R3 (ADR 0061 §6): this is the WOULD-COMPLETE branch, and the only
        // place a final answer exists to check. A check that fails while a
        // retry is left stashes its feedback and returns `undefined`, so the
        // loop pushes the assistant message, runs an empty tool batch, and
        // reaches the steering drain — where `takeSteering` yields the
        // feedback as a real, persisted user message. Deliberately AFTER the
        // truncation branch above: a cut-off answer is not a shape failure,
        // and feeding an interpreter's complaint back about half a sentence
        // would spend the one retry on the wrong problem.
        if (deps.finalAnswerCheck !== undefined && finalAnswerRetriesLeft > 0) {
          const feedback = deps.finalAnswerCheck(result.text);
          if (feedback !== undefined) {
            finalAnswerRetriesLeft -= 1;
            pendingFeedback = feedback;
            return undefined;
          }
        }
        return { status: "completed" };
      }
      if (overContextLimit(result) && counters.justCompacted) {
        // Compacting again would only summarize a summary: stop honestly.
        return alsoTruncated({ code: "context.limit", n: 0 });
      }
      if (counters.total.outputTokens >= budget.maxOutputTokens) {
        return alsoTruncated({
          code: "budget.output_tokens",
          n: budget.maxOutputTokens,
        });
      }
      if (
        !truncated &&
        counters.toolCallsUsed + result.toolCalls.length > budget.maxToolCalls
      ) {
        // Skipped for a truncated turn: the calls it would charge for are
        // precisely the calls that will not run (invariant 5 — budgets count
        // what was spent, never what was refused).
        // No partial batch: refusing some-but-not-all of a batch would hand
        // the model a misleading world state.
        return {
          status: "completed",
          notices: [{ code: "budget.tool_calls", n: budget.maxToolCalls }],
        };
      }
      return undefined;
    },
    runToolCalls: async (result, callItemIds) => {
      if (result.stopReason === "max_tokens") {
        // B2 (ADR 0026): the truncated-turn recovery. Structurally separate
        // from the retry policy — no attempt, no backoff, no budget: a
        // truncated turn is not a request that might work again, it is a
        // message the model needs another round-trip to finish.
        await deps.emitNotice(
          "turn.truncated_recovered",
          result.toolCalls.length,
        );
        return failTruncatedToolBatch({
          calls: result.toolCalls as readonly ToolCall[],
          callItemIds,
          emitItem,
          pushMessage: (message) => messages.push(message),
        });
      }
      // View, then evict (V3, ADR 0080 §5). `messages.length` before the batch
      // is this batch's start index; the loop does not splice the array mid-
      // batch, so it stays valid across the await.
      const batchStart = messages.length;
      const outcome = await runToolBatch({
        calls: result.toolCalls,
        registry: deps.registry,
        allowedTools: deps.allowedTools,
        callItemIds,
        emitItem,
        pushMessage: (message) => messages.push(message),
        countCall: () => {
          counters.toolCallsUsed += 1;
        },
        emitInterrupted: () =>
          emitItem({ id: randomUUID(), type: "interrupted" }),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      // Only a batch that actually showed something evicts — so a `read_span`
      // after viewing pages lets the reviewer read a passage while STILL
      // seeing the page, which is the whole point of doing it per batch.
      if (hasLiveImagesFrom(messages, batchStart)) {
        evictImagesBefore(messages, batchStart);
      }
      return outcome;
    },
    // Auto-apply's per-turn summary (ADR 0016): every turn that applied
    // edits ends with a changed_files item; review turns emit none (the
    // user saw each edit).
    afterToolBatch: async () => {
      const changedFiles = deps.appliedLedger?.drain() ?? [];
      if (changedFiles.length > 0) {
        await emitItem({
          id: randomUUID(),
          type: "changed_files",
          files: changedFiles,
        });
      }
    },
    // R3 (ADR 0061 §6): the stashed shape feedback drains FIRST, then the
    // host's queued input as before. First because it is a correction of the
    // turn the loop has just decided not to stop on — a user's steering typed
    // meanwhile is about what comes after that, and the loop drains until this
    // returns `undefined`, so nothing is lost either way.
    takeSteering: () => {
      if (pendingFeedback !== undefined) {
        const feedback = pendingFeedback;
        pendingFeedback = undefined;
        return feedback;
      }
      return deps.takeSteering?.();
    },
    // A2 (ADR 0021): compact at the TURN BOUNDARY, after this turn's tool
    // results and steering are in the history, so the summary sees the
    // whole turn — then the next request goes out on the fresh window.
    afterTurn: async (result) => {
      if (!overContextLimit(result)) {
        counters.justCompacted = false;
        return undefined;
      }
      if (await deps.compact("auto", occupancyAfter(result))) {
        counters.justCompacted = true;
        return undefined;
      }
      return deps.failedCompactionStop();
    },
  };
}
