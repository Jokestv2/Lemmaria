import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ImagePart,
  SessionItem,
  ToolCall,
  ToolErrorCode,
} from "../contracts/index.js";
import type { ToolExecutionMode, ToolName } from "../contracts/tools.js";
import type { ToolExecutor } from "../engine/tools.js";
import { capToolResult } from "../text/tool-result.js";
import { mapWithConcurrency } from "./concurrency.js";

/**
 * One turn's tool batch (B3, ADR 0025): parallel when every call in it is a
 * declared-parallel read, strictly sequential otherwise.
 *
 * Adapted from Pi's `executeToolCalls` → sequential/parallel split keyed on
 * `AgentTool.executionMode` (`pi/packages/agent/src/agent-loop.ts:411`), with
 * three deliberate divergences recorded in ADR 0025:
 *
 *  - the **default is sequential**, as in Codex (`supports_parallel_tool_calls`
 *    → `false`) rather than Pi's parallel: a serial read is slow, a parallel
 *    write is invariant 3;
 *  - `mutation` is sequential regardless of what a tool declares — the
 *    category is the guard, the field is only an optimisation;
 *  - concurrency is **bounded** (`MAX_PARALLEL_TOOLS`) through the same
 *    `mapWithConcurrency` A3 uses, rather than an unbounded `Promise.all`.
 */

/**
 * How many parallel-eligible calls may be in flight at once. A constant, not a
 * setting: what a user could tune with it is a few hundred milliseconds.
 *
 * Four rather than "all of them" because the eligible set includes
 * `literature_search`, which fans out to four scholarly endpoints per call
 * under ADR 0019's polite-pool contract — an unbounded batch of ten searches
 * is forty concurrent outbound requests from a desktop extension.
 */
export const MAX_PARALLEL_TOOLS = 4;

/**
 * May this tool's call overlap with its siblings? **Mutation never can**
 * (invariant 3), whatever it declares — a `propose_edit` raising two approval
 * cards at once, or two writes landing in an order the user did not see, is
 * the breach this milestone exists not to cause. Everything else takes its
 * declaration, defaulting to sequential.
 */
export function resolveExecutionMode(tool: ToolExecutor): ToolExecutionMode {
  if (tool.category === "mutation") return "sequential";
  return tool.executionMode ?? "sequential";
}

/**
 * Pick the path for one turn's batch: **parallel only if every call resolves to
 * a declared-parallel tool** (Pi's `hasSequentialToolCall` rule, inverted to
 * deny-by-default).
 *
 * A call naming a tool outside the allowlist, or one with no executor, does not
 * resolve — so it makes the batch sequential. Those calls never execute (they
 * short-circuit to `denied` / `unavailable`), so this costs nothing but a rule
 * with no exceptions, in a case that is already a model error.
 */
export function planBatchExecution(
  calls: readonly ToolCall[],
  registry: Map<ToolName, ToolExecutor>,
  allowedTools: readonly ToolName[],
): ToolExecutionMode {
  const everyCallIsParallel = calls.every((call) => {
    if (!allowedTools.includes(call.name)) return false;
    const tool = registry.get(call.name);
    return tool !== undefined && resolveExecutionMode(tool) === "parallel";
  });
  return everyCallIsParallel ? "parallel" : "sequential";
}

/** The one failure shape a tool result can carry (ADR 0024). */
function failureResult(code: ToolErrorCode, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

export interface ToolBatchOutcome {
  /** True ⇒ the signal aborted; the caller ends the task as interrupted. */
  interrupted: boolean;
}

/**
 * The model-facing text of a truncated call's failure (B2, ADR 0026). Adapted
 * from Pi's `failToolCallsFromTruncatedMessage` — an instruction, not a
 * diagnosis, because the model is the only party that knows what the arguments
 * were going to be.
 */
export function truncatedCallMessage(tool: string): string {
  return `tool call "${tool}" was NOT executed: the answer hit this turn's output-token limit, so its arguments may be truncated. Re-issue the call with complete arguments — and keep it small enough to finish.`;
}

/**
 * Fail every tool call in a turn that stopped for `max_tokens` (B2, ADR 0026),
 * instead of executing any of them.
 *
 * **All** of them, not just the last: a streamed argument buffer is JSON-parsed
 * at the end, so a truncated message can yield earlier calls that parse and
 * validate and are still part of a request the model never finished composing.
 * The invariant-3 case is the whole reason this is unconditional — a
 * `propose_edit` whose anchor was cut in half must never reach a user's file.
 *
 * One result per call id, because that pairing is what keeps the conversation
 * legal for the provider and is therefore what makes CONTINUING possible at
 * all. **No budget is charged**: nothing ran (invariant 5).
 */
export async function failTruncatedToolBatch(args: {
  calls: readonly ToolCall[];
  callItemIds: readonly (string | undefined)[];
  emitItem: (item: SessionItem) => Promise<void>;
  pushMessage: (message: ChatMessage) => void;
}): Promise<ToolBatchOutcome> {
  for (const [callIndex, call] of args.calls.entries()) {
    const resultJson = capToolResult(
      failureResult("invalid", truncatedCallMessage(call.name)),
    );
    await args.emitItem({
      id: args.callItemIds[callIndex] ?? randomUUID(),
      type: "tool_call",
      tool: call.name,
      argsJson: JSON.stringify(call.args ?? {}),
      status: "failed",
      resultJson,
    });
    args.pushMessage({
      role: "tool",
      content: resultJson,
      toolCallId: call.id,
    });
  }
  return { interrupted: false };
}

/** What one call produced, before it reaches the transcript or the model. */
interface CallOutcome {
  resultJson: string;
  failed: boolean;
  /**
   * Images the executor returned beside its JSON (V3, ADR 0080 §4). They reach
   * the `tool` MESSAGE only; `emitItem` never sees them, which is what keeps a
   * persisted transcript free of pixels by construction.
   */
  images?: readonly ImagePart[];
}

/**
 * The model-facing text of a call the interrupt reached first (B3, ADR 0025).
 * Shaped like `truncatedCallMessage`: an instruction, not a diagnosis.
 */
export function unrunCallMessage(tool: string): string {
  return `tool call "${tool}" was NOT executed: the turn was interrupted before it ran. Re-issue it if you still need it.`;
}

/**
 * A call the abort reached before it started. `unavailable` and deliberately
 * NOT `refused`: `refused` means a live precondition failed or the human
 * declined *this call*, which would tell a resumed model it was policy-denied.
 * It was not — it simply never ran. No eighth code is minted (ADR 0026
 * decision 10's precedent: precision with no consumer).
 */
const unrunOutcome = (call: ToolCall): CallOutcome => ({
  resultJson: failureResult("unavailable", unrunCallMessage(call.name)),
  failed: true,
});

/**
 * Run ONE call and return its result. **Total by construction** — it never
 * throws, so `mapWithConcurrency`'s `Promise.all` can never reject and lose a
 * sibling's finished result (ADR 0025 decision 8). ADR 0024's `unavailable`
 * backstop for a tool that throws lives here, inside the worker.
 */
async function invokeOne(
  call: ToolCall,
  registry: Map<ToolName, ToolExecutor>,
  allowedTools: readonly ToolName[],
): Promise<CallOutcome> {
  if (!allowedTools.includes(call.name)) {
    return {
      resultJson: failureResult(
        "denied",
        `tool "${call.name}" is not permitted in this session`,
      ),
      failed: true,
    };
  }
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      resultJson: failureResult(
        "unavailable",
        `tool "${call.name}" is not available`,
      ),
      failed: true,
    };
  }
  try {
    const outcome = await tool.invoke(call.args);
    const images = outcome.images?.length ? outcome.images : undefined;
    return outcome.ok
      ? { resultJson: JSON.stringify(outcome.value), failed: false, images }
      : {
          resultJson: JSON.stringify({ error: outcome.error }),
          failed: true,
          images,
        };
  } catch (error) {
    // ADR 0024: a tool that throws is a defect. Report it; do not let
    // one bad tool kill a session the user is mid-way through.
    //
    // `instanceof` rather than a cast (review, minor): a tool that throws a
    // non-Error — a string, or a rejected promise with no reason — would
    // otherwise produce a failure with `message: undefined`, i.e. a failed row
    // with nothing in it. `loop.ts` already narrows its errors this way.
    return {
      resultJson: failureResult(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      ),
      failed: true,
    };
  }
}

export async function runToolBatch(args: {
  calls: readonly ToolCall[];
  registry: Map<ToolName, ToolExecutor>;
  allowedTools: readonly ToolName[];
  /** Streamed item ids by call ordinal, so the row completes the one the
   *  stream started; a missing id mints a fresh one. */
  callItemIds: readonly (string | undefined)[];
  emitItem: (item: SessionItem) => Promise<void>;
  /** Push the `tool` message the model reads next turn. */
  pushMessage: (message: ChatMessage) => void;
  /** Count one consumed tool call against the task budget. */
  countCall: () => void;
  /** Record the designed `interrupted` item (the S4 interrupt). */
  emitInterrupted: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<ToolBatchOutcome> {
  /**
   * Complete one call's transcript row and push the message the model reads
   * next turn. Always in CALL order, whatever order the work finished in — the
   * transcript is a persisted record, and a row order that depended on which
   * file happened to be in page cache would make two replays of one session
   * disagree (ADR 0025 decision 5).
   */
  const report = async (
    call: ToolCall,
    callIndex: number,
    outcome: CallOutcome,
  ): Promise<void> => {
    // A6: the ONE bound on what a tool injects into the conversation, and
    // deliberately above both consumers below — the transcript row and the
    // model's message must carry the same bytes, or the transcript would
    // show the user more than the model actually saw.
    const resultJson = capToolResult(outcome.resultJson);
    await args.emitItem({
      id: args.callItemIds[callIndex] ?? randomUUID(),
      type: "tool_call",
      tool: call.name,
      argsJson: JSON.stringify(call.args ?? {}),
      status: outcome.failed ? "failed" : "completed",
      resultJson,
    });
    args.pushMessage({
      role: "tool",
      content: resultJson,
      toolCallId: call.id,
      // Copied part by part, not just the array: eviction mutates `data` in
      // place, and it must never reach back into a tool's own state.
      ...(outcome.images
        ? { images: outcome.images.map((p) => ({ ...p })) }
        : {}),
    });
  };

  /** One call that ran: charge it, then record it. */
  const reportRan = async (
    call: ToolCall,
    callIndex: number,
    outcome: CallOutcome,
  ): Promise<void> => {
    args.countCall();
    await report(call, callIndex, outcome);
  };

  /**
   * Report the calls an abort reached before they ran (ADR 0025 decision 6):
   * every one gets a row and a `tool` message, in call order, and **none is
   * charged** — invariant 5 counts what was spent, never what was refused.
   *
   * Codex's shape, not Pi's: Pi drops them and repairs the history at the
   * provider boundary. Lemmaria has no such pass, and a `tool_call` with no
   * matching `tool_result` is a history the provider rejects outright.
   */
  const reportUnrunFrom = async (from: number): Promise<void> => {
    for (let i = from; i < args.calls.length; i++) {
      const call = args.calls[i];
      if (call !== undefined) await report(call, i, unrunOutcome(call));
    }
  };

  const mode = planBatchExecution(args.calls, args.registry, args.allowedTools);

  if (mode === "parallel") {
    // Every call is a declared-parallel read here, so none of them emits
    // events of its own mid-invocation: the tools that do — propose_edit's
    // approval cards, run_script's process events, spawn_subtask's live child
    // progress — are exactly the ones the planner keeps sequential. That is
    // what makes it safe to defer emission until the pool has drained, which
    // in turn is what keeps the transcript in CALL order (decision 5).
    const outcomes = await mapWithConcurrency(
      [...args.calls],
      MAX_PARALLEL_TOOLS,
      // An abort stops the pool from STARTING anything else — the queued
      // calls behind the width never run. It cannot cancel a read already in
      // flight: `ToolExecutor.invoke` takes no signal (ADR 0024's boundary).
      async (call): Promise<CallOutcome | undefined> =>
        args.signal?.aborted
          ? undefined
          : invokeOne(call, args.registry, args.allowedTools),
    );
    const ran: boolean[] = [];
    for (const [callIndex, call] of args.calls.entries()) {
      const outcome = outcomes[callIndex];
      ran[callIndex] = outcome !== undefined;
      if (outcome !== undefined) await reportRan(call, callIndex, outcome);
      else await report(call, callIndex, unrunOutcome(call));
    }
    if (ran.includes(false)) {
      await args.emitInterrupted();
      return { interrupted: true };
    }
    return { interrupted: false };
  }

  // The sequential path reports INLINE, exactly as it did before B3. Deferring
  // it here would be the one thing decision 5's rationale argues against: this
  // is the path that carries the tools which emit while they run, so grouping
  // their rows would leave a `propose_edit` approval card on screen while the
  // previous call's row still read as running. It also keeps `countCall`
  // ahead of the next call, which `spawn_subtask` depends on — its budget
  // carve reads the parent's REMAINING consumption at invoke time
  // (invariant 5), and a deferred count would hand the child a stale
  // allowance.
  for (const [callIndex, call] of args.calls.entries()) {
    if (args.signal?.aborted) {
      await reportUnrunFrom(callIndex);
      await args.emitInterrupted();
      return { interrupted: true };
    }
    await reportRan(
      call,
      callIndex,
      await invokeOne(call, args.registry, args.allowedTools),
    );
  }
  return { interrupted: false };
}

/**
 * View, then evict (V3, ADR 0080 §5): strip the PIXELS from every image part in
 * a message before `index`, keeping the part itself — its `mimeType` and its
 * `label` — so the wire can still say what was shown.
 *
 * **No message's `content` is touched.** That is the whole point: the rule
 * `session/run.ts` states above its first `messages.push` is that the LIVE
 * history must be the same shape as the REBUILT one, byte-identical in text,
 * and rewriting `content` to a placeholder would put the two permanently out of
 * step. The placeholder is synthesised by each protocol adapter instead.
 *
 * Returns how many parts lost their data, so the caller can tell whether
 * anything happened. Idempotent: a second call over the same range evicts none.
 *
 * S6 measured this saving 44.5 % and 48.5 % of input tokens over three turns
 * while losing nothing the model had already written down — which is why the
 * tool's own description tells it to write down what it saw.
 */
export function evictImagesBefore(
  messages: ChatMessage[],
  index: number,
): number {
  let evicted = 0;
  for (let i = 0; i < Math.min(index, messages.length); i++) {
    const images = messages[i]?.images;
    if (!images) continue;
    for (const part of images) {
      if (part.data === undefined) continue;
      part.data = undefined;
      evicted++;
    }
  }
  return evicted;
}

/** True when any message from `from` onward still carries a live image. */
export function hasLiveImagesFrom(
  messages: readonly ChatMessage[],
  from: number,
): boolean {
  for (let i = Math.max(0, from); i < messages.length; i++) {
    if (messages[i]?.images?.some((p) => p.data !== undefined)) return true;
  }
  return false;
}
