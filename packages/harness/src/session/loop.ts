import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  NoticeItem,
  SessionEvent,
  SessionItem,
  ToolSpec,
  Usage,
} from "../contracts/index.js";
import type { ToolName } from "../contracts/tools.js";
import { abortableSleep } from "./retry.js";

/**
 * The agentic turn loop (ADR 0015) — and nothing else.
 *
 * Every policy decision (budgets, retry, compaction, the tool batch) is a hook.
 * Adapted from Pi's `AgentLoopConfig` (`pi/packages/agent/src/agent-loop.ts`),
 * with three deliberate divergences:
 *
 *  - Pi's `shouldStopAfterTurn` returns a boolean; Lemmaria's returns a
 *    `LoopStop`, because every Lemmaria stop owes the user a REASON — the
 *    notice code and the resulting task status are the honesty contract.
 *  - Pi's per-request `transformContext` and `prepareNextTurn` mid-task model
 *    switch are NOT ported: nothing in Lemmaria needs them yet, and a seam with
 *    no implementation is a guess about the next milestone, not a seam.
 *  - Pi's `getFollowUpMessages` is not a harness concern: Lemmaria's follow-up
 *    task is the extension's queued-steering loop over `runSessionTask`.
 *
 * What lives here is loop MECHANICS: turn numbering, the streamed deltas and
 * their item identity, the interrupt, and the assistant message that carries a
 * turn's tool calls into history. The hooks themselves are `session/task-hooks.ts`
 * (policy), assembled with everything else by `session/run.ts`.
 */

/**
 * How a turn loop stops. The caller emits `notice` (with its `n`) and, when
 * asked, the designed `interrupted` item, then finishes the task with `status`.
 * `undefined` from `runTurnLoop` means "ran out of turns" — the TURN budget is
 * the caller's fact, not the loop's.
 */
export interface LoopStop {
  status: "completed" | "failed" | "interrupted";
  /**
   * The notices the caller emits, in order, before finishing.
   *
   * A LIST, not one notice (B2 review): a turn can owe the user two separate
   * facts at once — "the answer was cut off and the tool calls it was writing
   * were discarded" AND "the task's output budget is spent". Reporting only
   * the second is the A6 failure mode (a notice naming a limit while a
   * different one did the damage), and reporting only the first would lose the
   * reason the task ended.
   */
  notices?: readonly { code: NoticeItem["code"]; n: number }[];
  error?: string;
}

/**
 * What the loop does about a failed stream (B2, ADR 0026). The POLICY behind it
 * — classification, backoff, the attempt budget — is `session/retry.ts`, read
 * by `session/task-hooks.ts`; the loop only waits and reports.
 *
 * `fail` carries an optional notice so the *reason* reaches the user in their
 * own language: "we gave up after N attempts" and "your account is out of
 * quota" are different facts, and the provider's English sentence is detail,
 * never the whole message (invariant 6).
 */
export type StreamFailureAction =
  | { kind: "retry"; delayMs: number }
  | { kind: "fail"; notice?: { code: NoticeItem["code"]; n: number } };

/**
 * Wait `ms`, resolving `false` if `signal` aborted first. Injected so a test
 * asserts the delays the policy computed without a fake clock; `run.ts` passes
 * `abortableSleep`.
 */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<boolean>;

export interface SessionLoopHooks {
  /** Checked before a turn starts; a stop here never calls the model. Pure. */
  beforeTurn(turn: number): LoopStop | undefined;
  /** This turn is going ahead: charge it against the task's turn consumption. */
  countTurn(): void;
  /** The per-request output cap for this turn. */
  turnMaxTokens(): number;
  /** `attempt` is 1 for the first failure of a turn, 2 for the next, … */
  onStreamFailure(error: unknown, attempt: number): StreamFailureAction;
  /**
   * A stream that ended with NO terminal event — the adapter broke its
   * contract (ADR 0015). Deliberately its own hook rather than a synthetic
   * error passed to `onStreamFailure`: there is no error to classify, so this
   * is an attempt-budget decision alone, and routing it through the failure
   * classifier would silently never retry. Shares the attempt counter with
   * `onStreamFailure`, so one turn's retry budget covers both causes.
   */
  onMissingTerminal(attempt: number): StreamFailureAction;
  /** Budget/termination policy after a completed turn, in the caller's order. */
  shouldStopAfterTurn(result: GenerateResult): LoopStop | undefined;
  /** Execute this turn's tool calls (the B3 seam lives behind this). */
  runToolCalls(
    result: GenerateResult,
    callItemIds: readonly (string | undefined)[],
  ): Promise<{ interrupted: boolean }>;
  /** After the batch: the auto-apply `changed_files` summary. */
  afterToolBatch(): Promise<void>;
  /** Queued user input, drained at the turn boundary; undefined = empty. */
  takeSteering(): string | undefined;
  /** The turn-boundary compaction trigger. A `LoopStop` ends the task. */
  afterTurn(result: GenerateResult): Promise<LoopStop | undefined>;
}

export async function runTurnLoop(args: {
  generateStream: NonNullable<ModelAdapter["generateStream"]>;
  binding: ModelBinding;
  /** The live conversation; the loop appends assistant/tool/steering messages. */
  messages: ChatMessage[];
  toolSpecs: ToolSpec[];
  maxTurns: number;
  /** Turns already in the transcript; the loop counts up from it. */
  startTurnNumber: number;
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  emitNotice: (code: NoticeItem["code"], n: number) => Promise<void>;
  /** A completed turn's usage, for the caller's budget accounting. */
  onTurnUsage: (usage: Usage) => void;
  hooks: SessionLoopHooks;
  /** The retry backoff's wait. Defaults to a real, abortable timer. */
  sleep?: SleepFn;
  signal?: AbortSignal;
}): Promise<LoopStop | undefined> {
  const { emit, emitItem, emitNotice, hooks, messages } = args;
  const sleep = args.sleep ?? abortableSleep;

  /**
   * Announce the wait, then wait it out. Returns false when the user
   * interrupted mid-backoff — ◼ Stop must not be dead for the length of a
   * retry delay, so an aborted sleep ends the task rather than proceeding.
   */
  const backOff = async (delayMs: number): Promise<boolean> => {
    // The notice names the delay the loop is ACTUALLY about to wait (the
    // jitter is already applied), so the number the user reads is true.
    await emitNotice("stream.retried", Math.ceil(delayMs / 1000));
    return sleep(delayMs, args.signal);
  };
  let turnNumber = args.startTurnNumber;

  for (let t = 0; t < args.maxTurns; t++) {
    const before = hooks.beforeTurn(turnNumber + 1);
    if (before) return before;
    hooks.countTurn();
    turnNumber += 1;
    await emit({ type: "turn.started", turn: turnNumber });

    // --- one streamed model turn, with the hook's retry policy ---
    // `streamAttempt` is the ONLY state that survives a retry: one turn's
    // budget covers both failure causes (B1). Everything an attempt produced
    // is re-declared per attempt, so a retry can never read the previous
    // attempt's partial result (B2 review: the retry window is now 2+ attempts
    // wide, and an adapter that yielded a terminal event and *then* threw
    // would otherwise leave a stale `result` behind).
    let streamAttempt = 0;
    for (;;) {
      let result: GenerateResult | undefined;
      let aborted = false;
      let agentItem: { id: string; text: string } | undefined;
      const callItems = new Map<
        number,
        { id: string; tool: string; args: string }
      >();
      const callItemIds: string[] = [];
      try {
        const stream = args.generateStream({
          binding: args.binding,
          messages: [...messages],
          ...(args.toolSpecs.length > 0 ? { tools: args.toolSpecs } : {}),
          maxTokens: hooks.turnMaxTokens(),
          signal: args.signal,
        });
        for await (const ev of stream) {
          if (ev.type === "text_delta") {
            if (!agentItem) {
              agentItem = { id: randomUUID(), text: "" };
              await emit({
                type: "item.started",
                item: { id: agentItem.id, type: "agent_message", text: "" },
              });
            }
            agentItem.text += ev.text;
            await emit({
              type: "item.updated",
              item: {
                id: agentItem.id,
                type: "agent_message",
                text: agentItem.text,
              },
            });
          } else if (ev.type === "tool_call_delta") {
            let call = callItems.get(ev.index);
            if (!call) {
              call = {
                id: randomUUID(),
                tool: ev.name ?? "tool",
                args: "",
              };
              callItems.set(ev.index, call);
              callItemIds[ev.index] = call.id;
              await emit({
                type: "item.started",
                item: {
                  id: call.id,
                  type: "tool_call",
                  tool: call.tool as ToolName,
                  argsJson: "",
                  status: "in_progress",
                },
              });
            }
            call.args += ev.argsDelta;
            await emit({
              type: "item.updated",
              item: {
                id: call.id,
                type: "tool_call",
                tool: call.tool as ToolName,
                argsJson: call.args,
                status: "in_progress",
              },
            });
          } else if (ev.type === "completed") {
            result = ev.result;
          } else if (ev.type === "aborted") {
            aborted = true;
          }
        }
      } catch (error) {
        // A stream failure: the partial turn is discarded (deltas were never
        // persisted or pushed to history). The retry policy is the hook's.
        streamAttempt += 1;
        const action = hooks.onStreamFailure(error, streamAttempt);
        if (action.kind === "retry") {
          if (await backOff(action.delayMs)) continue;
          await emitItem({ id: randomUUID(), type: "interrupted" });
          return { status: "interrupted" };
        }
        if (action.notice)
          await emitNotice(action.notice.code, action.notice.n);
        const message = error instanceof Error ? error.message : String(error);
        await emitItem({ id: randomUUID(), type: "error", message });
        await emit({ type: "turn.failed", turn: turnNumber, error: message });
        return { status: "failed", error: message };
      }
      if (aborted || (!result && args.signal?.aborted)) {
        // The S4 interrupt: discard the partial turn, record the designed item.
        await emitItem({ id: randomUUID(), type: "interrupted" });
        return { status: "interrupted" };
      }
      if (!result) {
        // The adapter contract guarantees a terminal event; treat a bare end
        // as a stream failure (retryable on the same policy as any other).
        streamAttempt += 1;
        const action = hooks.onMissingTerminal(streamAttempt);
        if (action.kind === "retry") {
          if (await backOff(action.delayMs)) continue;
          await emitItem({ id: randomUUID(), type: "interrupted" });
          return { status: "interrupted" };
        }
        if (action.notice)
          await emitNotice(action.notice.code, action.notice.n);
        const message = "model stream ended without a terminal event";
        await emitItem({ id: randomUUID(), type: "error", message });
        await emit({ type: "turn.failed", turn: turnNumber, error: message });
        return { status: "failed", error: message };
      }

      // --- turn completed ---
      if (result.text) {
        await emitItem({
          id: agentItem?.id ?? randomUUID(),
          type: "agent_message",
          text: result.text,
        });
      }
      args.onTurnUsage(result.usage);
      await emit({
        type: "turn.completed",
        turn: turnNumber,
        usage: result.usage,
      });

      const stop = hooks.shouldStopAfterTurn(result);
      if (stop) return stop;

      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
        ...(result.reasoning !== undefined
          ? { reasoning: result.reasoning }
          : {}),
      });
      const batch = await hooks.runToolCalls(result, callItemIds);
      if (batch.interrupted) return { status: "interrupted" };

      await hooks.afterToolBatch();

      // An interrupt during the batch's last tool (e.g. while paused on an
      // approval) ends the task here — not with a ghost next turn.
      if (args.signal?.aborted) {
        await emitItem({ id: randomUUID(), type: "interrupted" });
        return { status: "interrupted" };
      }

      // Steering: queued user input joins at the turn boundary (S4-verified
      // on both protocols; supersedes A0's busy-refusal for the live task).
      for (;;) {
        const steer = hooks.takeSteering();
        if (steer === undefined) break;
        await emitItem({
          id: randomUUID(),
          type: "user_message",
          text: steer,
          // Not a task boundary, so not a branch point (ADR 0031).
          steered: true,
        });
        messages.push({ role: "user", content: steer });
      }

      const after = await hooks.afterTurn(result);
      if (after) return after;
      break; // next turn
    }
  }

  // Out of turns. The TURN BUDGET is the caller's fact — it owns that notice.
  return undefined;
}
