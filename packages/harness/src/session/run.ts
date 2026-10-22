import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChildModel,
  GrantedRoot,
  ManuscriptGraphReader,
  ModelAdapter,
  ModelBinding,
  ProtectedSpanReader,
  ReviewPdfDeps,
  SessionEditHost,
  SessionEvent,
  SessionItem,
  SessionLocale,
  SessionMeta,
  SessionScriptHost,
  SessionTaskBudget,
  Skill,
  ToolCall,
  Usage,
} from "../contracts/index.js";
import type { ToolName } from "../contracts/tools.js";
import type { LiteratureWithhold, ToolExecutor } from "../engine/tools.js";
import { classifyModelForSession } from "../model/floor.js";
import { capToolResult } from "../text/tool-result.js";
import { resolveTaskBudget } from "./budget.js";
import { createInMemorySessionStore } from "./child-store.js";
import type { TaskSessionStore } from "./child-store.js";
import {
  buildConversationHistory,
  liveTurnUsage,
  retainBudgetFor,
  selectRetainedMessageIds,
  summarizeForCompaction,
} from "./compaction.js";
import { contextLimitReached, windowOccupancy } from "./context.js";
import { createSessionEmitter } from "./emitter.js";
import { assembleTaskToolSurface } from "./loop-tools/registry.js";
import { MAX_FAN_OUT } from "./loop-tools/subtask.js";
import { type LoopStop, type SleepFn, runTurnLoop } from "./loop.js";
import { buildSessionSystemPrompt } from "./prompt.js";
import { replayEntries } from "./replay.js";
import { type RetryPolicy, resolveRetryPolicy } from "./retry.js";
import {
  type ManuscriptWorkspace,
  type ReviewerSpec,
  parseReviewCommand,
  runReviewPanel,
} from "./review-panel.js";
import { parsePdfReviewCommand } from "./review-pdf-seat.js";
import { parseSkillInvocations } from "./skill-invocation.js";
import type { SnapshotStore } from "./snapshot-store.js";
import {
  type FinalAnswerCheck,
  type TaskCounters,
  createTaskHooks,
} from "./task-hooks.js";

export interface RunSessionTaskOptions {
  store: TaskSessionStore;
  session: SessionMeta;
  model: ModelAdapter;
  binding: ModelBinding;
  /** The user's composer message that starts this task. */
  text: string;
  /** Host-built read-tool registry; `update_plan` is added by the loop itself. */
  registry?: Map<ToolName, ToolExecutor>;
  /** Defaults to every registry tool; a requested tool outside it is refused. */
  allowedTools?: ToolName[];
  budget?: Partial<SessionTaskBudget>;
  /**
   * Provider-failure retry (B2, ADR 0026). Defaults to `DEFAULT_RETRY_POLICY`
   * and is inherited by compaction and by every `spawn_subtask` child, so one
   * session never has two ideas about how hard to try. Deliberately NOT a VS
   * Code setting: see the plan's decision 12.
   */
  retry?: Partial<RetryPolicy>;
  /**
   * The retry backoff's wait (B2). Injected so a test asserts the delays the
   * policy computed without spending them; production leaves it unset and gets
   * a real, abortable timer.
   */
  sleep?: SleepFn;
  /**
   * The authoritative per-field ceiling (the user's `lemmaria.budget.*` setting),
   * falling back to `DEFAULT_TASK_BUDGET` per field when absent — so it can raise
   * OR lower the default. `budget` (an action's request) then clamps down from it
   * (invariant 5).
   */
  ceilings?: Partial<SessionTaskBudget>;
  signal?: AbortSignal;
  /**
   * ADR 0031: the language model output is rendered in — the system prompt's
   * reply-language line and every compaction handoff this task triggers.
   * Absent = `"en"`; the extension passes `resolvedLocale()`, and every
   * harness test harness and the CLI eval runner, which call this with no
   * locale, are unaffected by the default.
   */
  locale?: SessionLocale;
  /**
   * Writing Skills this task may load (ADR 0028). When non-empty, `load_skill`
   * is offered and the envelope prompt declares each skill's name and
   * description. Bodies never reach the prompt; they arrive through the tool, or
   * through a `/skill:<name>` token anywhere in `text` (ADR 0050) — one per
   * skill named.
   *
   * For a **child** this is the set its parent equipped it with (R1, ADR 0059),
   * and `runChild` is the only caller that passes one — so a child the parent
   * named no skills for arrives here with the key absent and gets neither the
   * tool nor the block, which is ADR 0028 §D7's default, now enforced by the
   * caller rather than by a term in the surface rule.
   */
  skills?: Skill[];
  /**
   * The write path (ADR 0016). When present, `propose_edit` is offered and
   * the loop pauses/applies per the host's edit policy; absent → the session
   * stays read-only and the envelope prompt says so.
   */
  editHost?: SessionEditHost;
  /**
   * The script-execution path (A4b, ADR 0020). When present (with a non-empty
   * interpreter allowlist and a grants getter), `run_script` is offered and the
   * loop resolves + approves + runs each invocation; absent → no run_script.
   */
  scriptHost?: SessionScriptHost;
  /**
   * ADR 0031: when present, `propose_edit` content-addresses every applied
   * write into this store and attaches the batch's `fileStates` manifest to
   * the terminal item. Optional so the CLI and the harness's own test
   * harnesses, which construct tasks without a snapshot store, are unaffected.
   */
  snapshots?: SnapshotStore;
  /**
   * D1 (ADR 0032): the stateless protected-span detector, injected by the host
   * (the harness cannot import `@lemmaria/adapters`). Wire the SAME reader into
   * `buildToolRegistry` — `read_span` marks with it and `propose_edit` refuses
   * with it, and a rule shown but not enforced (or enforced but not shown) is
   * the divergence this milestone closed. Absent ⇒ neither happens.
   */
  protectedSpans?: ProtectedSpanReader;
  /**
   * X5 (ADR 0074 §4): resolves the review panel's manuscript — the entry's
   * include graph — injected by the host for the same reason
   * `protectedSpans` is, and in the same shape. Absent ⇒ the panel falls back
   * to a suffix glob over the folder and emits
   * `review.manuscript_unresolved`, so the fallback is recorded, not silent.
   */
  manuscriptGraph?: ManuscriptGraphReader;
  /**
   * V2 (ADR 0078 §5): the host's literature-withholding holder — **the same
   * object its tool registry closes over**, which is the whole point of
   * threading it rather than making one here.
   *
   * The review driver fills it with the manuscript's own title for the span of
   * one panel and empties it on every exit. Absent ⇒ the panel records
   * `own_title_unguarded / unavailable`: deny-by-default, exactly as
   * `manuscriptGraph` above records its own absence rather than passing over
   * it in silence.
   */
  literatureWithhold?: LiteratureWithhold;
  /**
   * Live external read-grant set (A4, ADR 0019). Read at task start for the
   * envelope re-declaration; the host registry's executors hold the same
   * getter, so a mid-task revocation bites at the next tool call.
   */
  grants?: () => GrantedRoot[];
  /** Drained at each turn boundary; queued user input joins as a user message. */
  takeSteering?: () => string | undefined;
  /**
   * R3 (ADR 0061 §6): a dry run of whatever will parse this task's final
   * answer. Called on the turn that would COMPLETE the task; a returned string
   * is fed back into the task's own loop as one steered user message, once,
   * and the task runs another turn. A second failure completes normally, so
   * this can never keep a task alive.
   *
   * Set only by the review panel's driver, which hands each seat a dry run of
   * `interpretLedger` against the same files the real parse will use — so the
   * feedback is the interpreter's own English rather than a second phrasing of
   * a rule that could drift from the one enforced. Every other caller, the
   * `spawn_subtask` tool included, leaves it unset and is unaffected.
   */
  finalAnswerCheck?: FinalAnswerCheck;
  /**
   * V4 (ADR 0081 §6): executors this task holds beyond the host registry's —
   * merged into THIS task's own clone of it, never into `registry` itself.
   *
   * Set only by `runChild`, for a child the review driver issued: the PDF
   * reviewer's `view_pdf_pages`, which the parent's surface does not offer.
   * ADR 0022 §3's *a child can never hold a tool the parent lacks* governs
   * `spawn_subtask` children, which never set this.
   */
  extraTools?: ReadonlyMap<ToolName, ToolExecutor>;
  /**
   * True when this task is itself a `spawn_subtask` child (A3, ADR 0022):
   * `spawn_subtask` is not offered, bounding fan-out to one level. Children are
   * read-only (no editHost/scriptHost) by construction.
   */
  isChild?: boolean;
  /**
   * Max children a single `spawn_subtask` call runs CONCURRENTLY (A3). Clamped
   * down against the harness `MAX_FAN_OUT` ceiling (invariant 5); the extension
   * sets it from `lemmaria.budget.maxFanOut`. Not a cap on how many children may
   * be requested — extra children queue and run as slots free (up to
   * `MAX_SUBTASK_CHILDREN` total, above which the call is rejected honestly).
   */
  maxFanOut?: number;
  /**
   * R9 (ADR 0069 §D2): the review panel the HOST configured — how many
   * reviewers, and which model each one and the cross-review run on.
   *
   * Read **only** by the `/review` branch below, and deliberately NOT threaded
   * into `runChild`: a child's `/review` is prose (ADR 0061 §2) and stays so,
   * so a reviewer cannot configure a panel of its own. Absent ⇒ the harness's
   * own default, `DEFAULT_REVIEWER_COUNT` reviewers on this task's model, which
   * is what the CLI and every test get.
   */
  reviewPanel?: {
    reviewers: ReviewerSpec[];
    synthesis?: ChildModel;
    /** V1 (ADR 0076 §5): the verifier's model, or `"off"`. Absent ⇒ the
     *  cross-review's. */
    verifier?: ChildModel | "off";
    /** V4 (ADR 0081 §3): the PDF reviewer's model, or `"off"`. Absent ⇒ this
     *  task's own model (the Writing model). */
    pdfReviewer?: ChildModel | "off";
  };
  /**
   * V4 (ADR 0081 §2): what a `/review` or `/review-pdf` needs to see the
   * compiled paper — a renderer, and optionally a compile, a log reader and
   * the venue the host matched. Read only by those two branches. Absent ⇒
   * no PDF reviewer can run, which the record states as a limit.
   */
  reviewPdf?: ReviewPdfDeps;
  /**
   * R3 (ADR 0061): the manuscript port a `/review` panel reads through.
   *
   * The task itself has never needed one — the host bakes the workspace into
   * the tool registry it hands over — but the review driver locates every
   * anchor in the manuscript's own bytes ITSELF, so it needs the same reader
   * the seats read through. The extension passes the very `VscodeWorkspace` it
   * built for the registry, so the driver locates over the dirty-buffer bytes
   * the seats saw rather than what is on disk. Absent ⇒ `/review` refuses with
   * `review.no_manuscript`; nothing else in a task uses it.
   */
  workspace?: ManuscriptWorkspace;
  /** R3: the host's chosen manuscript entry. Absent ⇒ discovered from the
   *  workspace, and a folder with no paper in it refuses honestly. */
  paperEntry?: string;
  /**
   * `lemmaria.paperPdf` — a compiled PDF the user named, root-relative (V3,
   * ADR 0080 §8). Forwarded to the review driver and **read by nothing in
   * V3**: no seat wants a PDF yet, and resolving one costs up to a 15-second
   * compile per panel. V4 adds the seat and the wiring together.
   */
  paperPdf?: string;
  /**
   * The version number a `/review` panel in THIS task takes (ADR 0065 §1).
   *
   * Absent — every caller before ADR 0065, the CLI eval driver included — and
   * the ordinal is counted from this session's own transcript, which is ADR
   * 0062 §1's rule and is still right for a review that lives in a session.
   *
   * The extension now runs the panel on a SCRATCH store whose transcript is
   * empty by construction, so counting there would answer `1` forever. It
   * passes the count its persisted review store holds instead: the sequence
   * belongs to the workspace's manuscript, not to whatever conversation
   * happened to start the panel.
   */
  reviewOrdinal?: number;
  /** Live event sink (the UI stream); completed items and turn/task events are
   *  also persisted — `item.started`/`item.updated` deltas are not (ADR 0015). */
  onEvent?: (event: SessionEvent) => void;
}

export interface SessionTaskResult {
  status: "completed" | "failed" | "interrupted";
  /** The full transcript after this task (replayed from persisted events). */
  items: SessionItem[];
  /** Summed over the task's turns (a spawn_subtask parent rolls its children's usage in). */
  usage?: Usage;
  error?: string;
}

/**
 * Run one agentic task (ADR 0015): plan → act (read-only allowlisted tools)
 * → report, streamed, over as many turns as the budget allows. Persistence is
 * best-effort once the task is running (the A0 P1 rule); DELIVERY is not —
 * every event, including the terminal `task.completed`, always reaches
 * `onEvent`. `item.started`/`item.updated` deltas reach the live sink only
 * and are never persisted, so an interrupted partial turn replays clean by
 * construction. The only throw path is the initial `load`, before any event.
 */
export async function runSessionTask(
  opts: RunSessionTaskOptions,
): Promise<SessionTaskResult> {
  const prior = await opts.store.load(opts.session.id);
  // ADR 0027 had to scope this to the active branch, or an abandoned branch's
  // turns would be counted too and the number would jump after a rewind. A
  // session file holds one conversation again (ADR 0057), so the whole file IS
  // the scope: a rewind's abandoned turns are in a different file entirely.
  const turnNumber = prior.entries.filter(
    (e) => e.event.type === "turn.started",
  ).length;
  const emitter = createSessionEmitter({
    store: opts.store,
    sessionId: opts.session.id,
    prior: prior.entries,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  const { emit, emitItem, emitNotice } = emitter;

  const budget = resolveTaskBudget(opts.budget, opts.ceilings);
  // B2 (ADR 0026): resolved ONCE, here, and handed to every party that talks to
  // the provider — the turn loop, compaction, and each child.
  const retry = resolveRetryPolicy(opts.retry);
  // Budget-consumption state, hoisted so the loop-injected spawn_subtask tool
  // (A3) can carve a child slice from the parent's REMAINING budget at call time.
  const counters: TaskCounters = {
    total: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    toolCallsUsed: 0,
    turnsUsed: 0,
    justCompacted: false,
  };
  const total = counters.total;
  const accrue = (delta: Usage): void => {
    total.inputTokens += delta.inputTokens;
    total.outputTokens += delta.outputTokens;
    total.costUsd =
      total.costUsd === undefined || delta.costUsd === undefined
        ? undefined
        : total.costUsd + delta.costUsd;
  };
  const hostRegistry = opts.registry ?? new Map<ToolName, ToolExecutor>();
  const editHost = opts.editHost;
  const scriptHost = opts.scriptHost;
  /**
   * The id of the user_message that starts this task. Minted here, ahead of
   * the emit below, because `assembleTaskToolSurface` needs it before the item
   * exists (ADR 0017) — the same id lands on the emitted item further down.
   */
  const userMessageId = randomUUID();
  /**
   * Run one child task in its own ephemeral session (A3, ADR 0022).
   *
   * **Hoisted out of `assembleTaskToolSurface`'s argument list at R3** (ADR
   * 0061 §3), where it was an inline closure. The review panel issues a fan-out
   * that no model turn asked for, and it must run its seats through the SAME
   * function `spawn_subtask` runs its children through — otherwise "a seat is
   * just a child" would be a claim in a doc rather than a property of the code.
   */
  const runChild = (
    goal: string,
    allowedChildTools: ToolName[],
    ceilings: Partial<SessionTaskBudget>,
    childSkills: Skill[],
    finalAnswerCheck?: FinalAnswerCheck,
    childModel?: ChildModel,
    // V4 (ADR 0081 §6): executors THIS child holds and no sibling does — the
    // PDF reviewer's `view_pdf_pages`, built per review from an opened PDF.
    // The `spawn_subtask` tool never passes it.
    childTools?: ReadonlyMap<ToolName, ToolExecutor>,
  ): Promise<SessionTaskResult> => {
    const now = new Date().toISOString();
    return runSessionTask({
      store: createInMemorySessionStore(),
      session: {
        id: randomUUID(),
        title: goal,
        workspace: opts.session.workspace,
        createdAt: now,
        updatedAt: now,
      },
      // R9 (ADR 0069 §D3): a reviewer may run on a model the user picked for
      // it, rather than the parent's. Listed here explicitly for the reason
      // the B2 comment below gives — this object is enumerated, not spread, so
      // an unlisted option is silently dropped, and a reviewer bound to a
      // model that never reached its child would have failed INVISIBLY, as a
      // panel that simply ran three copies of the writing model.
      model: childModel?.adapter ?? opts.model,
      binding: childModel?.binding ?? opts.binding,
      text: goal,
      // The host read registry only — the mutating tools live on the
      // parent's cloned registry, never here.
      registry: hostRegistry,
      allowedTools: allowedChildTools,
      ceilings,
      // B2: children inherit the parent's policy. This options object is
      // enumerated, not spread, so a new option that is not listed here is
      // silently dropped — which is how children came to be described as
      // having no retry at all (the plan's correction 1), and which is why
      // R1 (ADR 0059) had to thread `skills` here explicitly: an equipped
      // child that never received its set would have failed silently, as a
      // child that simply chose not to load anything.
      retry,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.grants ? { grants: opts.grants } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
      // D1: threaded for the reason the comment above gives, even though a
      // child gets no editHost today and so no propose_edit to enforce on.
      ...(opts.protectedSpans ? { protectedSpans: opts.protectedSpans } : {}),
      // R1 (ADR 0059): the equipped set, and ONLY when the parent named one.
      // Omitting the key for an unequipped child is what keeps its surface,
      // its prompt and its persisted report byte-identical to pre-R1.
      ...(childSkills.length > 0 ? { skills: childSkills } : {}),
      // R3 (ADR 0061 §6): likewise omitted unless the caller set one, so a
      // `spawn_subtask` child's options object is byte-identical to pre-R3.
      ...(finalAnswerCheck ? { finalAnswerCheck } : {}),
      // V4 (ADR 0081 §6): likewise omitted unless set — listed because this
      // object is enumerated, and an unlisted option is silently dropped.
      ...(childTools ? { extraTools: childTools } : {}),
      isChild: true,
    });
  };
  const {
    registry,
    allowedTools,
    toolSpecs,
    appliedLedger,
    offerRunScript,
    skills: offeredSkills,
  } = assembleTaskToolSurface({
    hostRegistry,
    ...(opts.extraTools ? { extraTools: opts.extraTools } : {}),
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.isChild !== undefined ? { isChild: opts.isChild } : {}),
    ...(editHost ? { editHost } : {}),
    ...(scriptHost ? { scriptHost } : {}),
    ...(opts.snapshots ? { snapshots: opts.snapshots } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.protectedSpans ? { protectedSpans: opts.protectedSpans } : {}),
    ...(opts.grants ? { grants: opts.grants } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    workspaceRoot: opts.session.workspace,
    budget,
    usedSoFar: () => ({
      turns: counters.turnsUsed,
      toolCalls: counters.toolCallsUsed,
      outputTokens: counters.total.outputTokens,
    }),
    accrue,
    runChild,
    emit,
    emitItem,
    emitNotice,
    userMessageId,
    todoItemId: randomUUID(),
    ...(opts.maxFanOut !== undefined ? { maxFanOut: opts.maxFanOut } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // A2 (ADR 0021): the model-visible history is derived from the transcript
  // by the ONE shared function, so a compaction checkpoint is honoured
  // identically here, in the next task, and after a restart.
  const history = buildConversationHistory(prior.items, opts.binding.model);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSessionSystemPrompt(
        {
          tools: allowedTools,
          budget,
          // The policy is re-read at each propose_edit call; the prompt states
          // the policy in force when the task started.
          ...(editHost ? { editPolicy: editHost.policy() } : {}),
          // Active grants re-declared at each task start (ADR 0019).
          ...(opts.grants ? { grants: opts.grants() } : {}),
          // The interpreter allowlist when run_script is offered (ADR 0020).
          ...(offerRunScript && scriptHost
            ? { scriptInterpreters: scriptHost.interpreters() }
            : {}),
          // ADR 0028: derived from the surface, so the block and the allowlist
          // cannot disagree. An UNEQUIPPED child is offered no load_skill, so
          // it gets an empty list here and therefore no block; an equipped one
          // (R1, ADR 0059) gets exactly the set its parent named.
          ...(offeredSkills.length > 0 ? { skills: offeredSkills } : {}),
          // D1 (ADR 0032): say the protected-content rule only where the host
          // wired the reader that enforces it. Same discipline as every block
          // above — the prompt never advertises what the surface withheld.
          ...(opts.protectedSpans && editHost ? { protectedSpans: true } : {}),
        },
        opts.locale ?? "en",
      ),
    },
    ...history,
    // The pending request is NOT added here (review): a pre-task compaction
    // must summarize the conversation SO FAR, never the message it is about to
    // act on — otherwise the summary embeds the request, and a later rewind of
    // that request leaves it stranded inside the surviving summary. It is
    // pushed after the pre-task gate, so it always lands after any summary.
  ];

  const finish = async (
    status: SessionTaskResult["status"],
    error?: string,
  ): Promise<SessionTaskResult> => {
    let finalStatus = status;
    let finalError = error;
    const storeError = emitter.storeError();
    if (storeError !== undefined) {
      // The task ran, but part of it never reached disk — say so honestly in
      // the stream and report the task as failed (the A0 P1 rule).
      await emitItem({
        id: randomUUID(),
        type: "error",
        message: `session not saved: ${storeError}`,
      });
      if (finalStatus !== "failed") finalStatus = "failed";
      finalError = finalError ?? storeError;
    }
    await emit({ type: "task.completed", status: finalStatus });
    return {
      status: finalStatus,
      items: replayEntries(emitter.entries()),
      ...(total.inputTokens + total.outputTokens > 0 ? { usage: total } : {}),
      ...(finalError !== undefined ? { error: finalError } : {}),
    };
  };

  /**
   * A2 (ADR 0021): summarize the conversation, persist the checkpoint, and
   * rebuild the model-visible history from it. Returns false when compaction
   * did NOT happen — the caller then takes A1a's honest stop, never a silent
   * continue and never a faked summary.
   */
  const compact = async (
    trigger: "auto" | "manual",
    tokensBefore: number,
  ): Promise<boolean> => {
    // The progress row (D4 manual round). The automatic crossing is the more
    // confusing of the two paths — it fires unprompted, mid-task, and the user
    // is already waiting on a turn — so silence here reads as a hang. Id minted
    // up front and reused by the checkpoint below, so the finished card
    // replaces the row; `item.started`/`item.updated` are live-only, so a
    // compaction that fails leaves the transcript exactly as it found it.
    const progressId = randomUUID();
    const progress = (status: "running" | "failed"): SessionItem => ({
      id: progressId,
      type: "compaction",
      summary: "",
      trigger,
      retainedItemIds: [],
      tokensBefore,
      status,
    });
    await emit({ type: "item.started", item: progress("running") });
    const outcome = await summarizeForCompaction({
      messages: [...messages],
      model: opts.model,
      binding: opts.binding,
      // B2: the same policy the turns get (ADR 0026). A transient drop at the
      // threshold crossing used to end a long session on one immediate retry.
      retry,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
    });
    // A compaction is a real, paid model call: account for it even on failure.
    if (outcome.usage) accrue(outcome.usage);
    if (!outcome.summary) {
      await emit({ type: "item.updated", item: progress("failed") });
      await emitNotice("compaction.failed", 0);
      return false;
    }
    await emitItem({
      id: progressId,
      type: "compaction",
      summary: outcome.summary,
      trigger,
      retainedItemIds: selectRetainedMessageIds(
        replayEntries(emitter.entries()),
        retainBudgetFor(opts.binding.model),
      ),
      tokensBefore,
      // PERSIST what the summarization cost, not just accrue it: `total` is a
      // budget counter that dies with the task, so a compaction charged only
      // there was invisible to every cost surface (sumSessionUsage folds the
      // stream). Cheap here, and the same carrier the manual path writes.
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
    // Rebuild from the persisted transcript (which now ends with the
    // checkpoint) so the live history and a resumed one cannot diverge.
    // Index 0 is the system envelope and is never compacted away.
    messages.splice(
      1,
      messages.length - 1,
      ...buildConversationHistory(
        replayEntries(emitter.entries()),
        opts.binding.model,
      ),
    );
    return true;
  };

  /**
   * How a task ends when compaction did not happen: an aborted signal means
   * the USER stopped it, and blaming the context window for their own
   * interrupt would be dishonest (review) — the A1a stop is only for a window
   * that really is full.
   */
  const failedCompactionStop = async (): Promise<LoopStop> => {
    if (opts.signal?.aborted) {
      await emitItem({ id: randomUUID(), type: "interrupted" });
      return { status: "interrupted" };
    }
    return { status: "completed", notices: [{ code: "context.limit", n: 0 }] };
  };

  /** Emit a stop's notices in order, then end the task with its status. */
  const finishFromStop = async (stop: LoopStop): Promise<SessionTaskResult> => {
    for (const notice of stop.notices ?? []) {
      await emitNotice(notice.code, notice.n);
    }
    return finish(stop.status, stop.error);
  };

  await emit({ type: "task.started" });

  if (!opts.model.generateStream) {
    await emitItem({
      id: randomUUID(),
      type: "error",
      message:
        "This model adapter does not support streamed generation (ADR 0015).",
    });
    return finish(
      "failed",
      "model adapter does not support streamed generation",
    );
  }
  const generateStream = opts.model.generateStream.bind(opts.model);

  // Pre-task context check (the Codex-style reactive measure): the last
  // turn's reported usage is the live occupancy.
  // Only turns after the newest boundary that invalidated the window describe
  // it — a rewind (ADR 0018) or a compaction checkpoint (A2). Reading the raw
  // log would let one huge, rewound-away turn strand the session forever: the
  // user does the natural thing, rewinds it, and is still told to start a new
  // session (round-2 review). Cost history is untouched — this is a gate on
  // continuing, not an accounting record.
  // ADR 0051: measured when the provider reported one, estimated over the
  // assembled request when it reported none — which reaches us as ZEROS, not
  // as absent usage, and so used to pass a `priorUsage &&` guard and be
  // compared as a real measurement of zero. `messages` is the same input the
  // provider would have billed, so the two sources measure the same thing.
  const priorOccupancy = windowOccupancy(
    liveTurnUsage(prior.entries),
    messages,
  );
  if (contextLimitReached(priorOccupancy, opts.binding.model)) {
    // `messages` does not yet include the pending request, so the summary is
    // of the prior conversation only. The checkpoint is written before this
    // task's user_message item (below), so the request lands AFTER the summary
    // in the live request and in every later rebuild (review).
    if (await compact("auto", priorOccupancy)) {
      counters.justCompacted = true;
    } else {
      await emitItem({
        id: userMessageId,
        type: "user_message",
        text: opts.text,
      });
      return finishFromStop(await failedCompactionStop());
    }
  }
  // Now add the request — after any summary, in the live history and the item.
  //
  // ADR 0028 §D6, mechanism superseded by E1 (ADR 0047) and widened by ADR
  // 0050: an explicit `/skill:<name>` token — anywhere in the message, and
  // more than one — becomes a real `load_skill` EXCHANGE at the head of
  // the task — the same `tool_call` item + assistant/tool message pair a
  // model-initiated `load_skill` produces, and the same pair `plainHistory`
  // reconstructs when it rebuilds a history. So the body survives a resume,
  // which under §D6's model-visible-only expansion it did not.
  //
  // The `user_message` item still carries exactly the typed text, so §D6's
  // transcript-honesty property is untouched: the transcript records the
  // message the user actually sent, never a block they never wrote.
  //
  // Gated on the SURFACE, not on `opts.skills`. R1 (ADR 0059) leaves this line
  // alone and narrows only what the gate lets through: an UNEQUIPPED child is
  // offered no skills, so `/skill:` in its goal stays prose exactly as in a
  // task where the host loaded none — while an equipped child's surface does
  // offer skills, so its parent can force a body in before its first turn.
  const invocableSkills = offeredSkills.length > 0 ? (opts.skills ?? []) : [];
  const invoked = parseSkillInvocations(opts.text, invocableSkills);
  await emitItem({ id: userMessageId, type: "user_message", text: opts.text });

  // R3 (ADR 0061 §2): `/review` runs a blind panel instead of a model turn.
  //
  // **Here, and not earlier or later.** After the user message, so the
  // transcript records what was typed before anything acts on it and a rewind
  // has the same branch point it has for any task. Before the synthetic
  // `/skill:` exchanges below, so a `/skill:` inside the FOCUS stays focus text
  // — the driver equips its own seats, and a user's skill name is a sentence
  // about the paper. Guarded on `isChild`, so a child's `/review` is prose,
  // exactly as a child is never offered fan-out.
  //
  // V4 (ADR 0081 §7): `/review-pdf` is the third such verb — the same driver,
  // in its PDF-only mode. `/review pdf` is not a form of it: that is `/review`
  // with the focus "pdf", and `parseReviewCommand` never matches the hyphen.
  const panelReview =
    opts.isChild !== true ? parseReviewCommand(opts.text) : null;
  const pdfReview =
    opts.isChild !== true && panelReview === null
      ? parsePdfReviewCommand(opts.text)
      : null;
  const review = panelReview ?? pdfReview;
  if (review !== null) {
    const status = await runReviewPanel({
      // V2 (ADR 0078 §5): the host's own holder, by reference — the panel
      // fills it and its `finally` empties it.
      ...(opts.literatureWithhold !== undefined
        ? { literatureWithhold: opts.literatureWithhold }
        : {}),
      emit,
      emitItem,
      emitNotice,
      runChild,
      parentAllowed: allowedTools,
      // The OFFERED set, not the raw host list — the same gate `/skill:` goes
      // through. A skill the user disabled is one the panel must refuse over,
      // not one it can quietly equip a seat with.
      offeredSkills: invocableSkills,
      budget,
      usedSoFar: () => ({
        turns: counters.turnsUsed,
        toolCalls: counters.toolCallsUsed,
        outputTokens: counters.total.outputTokens,
      }),
      accrue,
      fanOutConcurrency: Math.max(
        1,
        Math.min(MAX_FAN_OUT, opts.maxFanOut ?? MAX_FAN_OUT),
      ),
      // R9 (ADR 0069 §D2): the panel the host configured, and the model id
      // every reviewer that inherited this task's model is stamped with.
      ...(opts.reviewPanel
        ? {
            reviewers: opts.reviewPanel.reviewers,
            ...(opts.reviewPanel.synthesis
              ? { synthesis: opts.reviewPanel.synthesis }
              : {}),
            ...(opts.reviewPanel.verifier !== undefined
              ? { verifier: opts.reviewPanel.verifier }
              : {}),
            // V4 (ADR 0081 §3): listed, because this object is enumerated.
            ...(opts.reviewPanel.pdfReviewer !== undefined
              ? { pdfReviewer: opts.reviewPanel.pdfReviewer }
              : {}),
          }
        : {}),
      ...(opts.reviewPdf ? { pdf: opts.reviewPdf } : {}),
      parentModel: opts.binding.model,
      // X5 (ADR 0074 §6): the parent's OWN adapter and binding, which is what
      // a seat that named no model of its own inherits — and therefore what
      // the pre-run check has to ask before anything is spent.
      parent: { adapter: opts.model, binding: opts.binding },
      // ADR 0062 §1: the next version number, counted from the session's own
      // transcript rather than held anywhere. Only panels that actually RAN
      // are versioned, so a refused one leaves no hole in the sequence.
      //
      // ADR 0065 §1: unless the CALLER numbers it. A detached panel runs on a
      // scratch store, so its `prior.items` is empty and the count below would
      // answer `1` for every review ever run — the defect the operator
      // reported. The caller passing a number is the caller saying the
      // sequence lives somewhere else; nothing here validates it, because the
      // only thing that could is the store the caller is reading.
      reviewOrdinal:
        opts.reviewOrdinal ??
        prior.items.filter(
          (i) => i.type === "review" && i.version !== undefined,
        ).length + 1,
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      ...(opts.paperEntry ? { paperEntry: opts.paperEntry } : {}),
      ...(opts.paperPdf ? { paperPdf: opts.paperPdf } : {}),
      ...(opts.manuscriptGraph
        ? { manuscriptGraph: opts.manuscriptGraph }
        : {}),
      ...(review.focus !== undefined ? { focus: review.focus } : {}),
      ...(pdfReview !== null ? { pdfOnly: true as const } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return finish(status);
  }

  // **The user message goes FIRST, and the order is not cosmetic** (review).
  //
  // `plainHistory` rebuilds a transcript in item order, so a persisted
  // `[user_message, tool_call]` replays as `[user, assistant(toolCalls),
  // tool]`. Pushing the exchange ahead of the user message would make the LIVE
  // history a different shape from the REBUILT one — the opposite of what this
  // design is for — and on the first task of a session it would put an
  // `assistant` turn first in the request, which the Anthropic Messages API
  // does not accept. Emitting the same text the item carries (rather than the
  // prefix-stripped request) is what makes the two byte-identical, and it also
  // means the model sees the same thing on the first turn as it will after a
  // resume.
  messages.push({ role: "user", content: opts.text });

  // ADR 0050: one CALL per skill named, in the order they were named — a
  // message can now ask for a house style AND a venue's rules, which is the
  // case the operator raised. The loop replaced an `if` when `/skill:` stopped
  // being a leading prefix.
  //
  // **One BATCH, not one exchange each**, and the difference is load-bearing:
  // `plainHistory` collapses a run of consecutive `tool_call` items into a
  // single assistant message carrying every call, followed by the results in
  // call order. Pushing an assistant turn per skill inside the loop made the
  // LIVE history a different shape from the REBUILT one as soon as a message
  // named two — the exact property the test below this one pins, and it was
  // green only because until now a message could name at most one. So the
  // calls are collected here and pushed once, after the loop.
  const invokedCalls: ToolCall[] = [];
  const invokedResults: { id: string; resultJson: string }[] = [];
  for (const named of invoked.skills) {
    const executor = registry.get("load_skill");
    // Present whenever `offeredSkills` is non-empty — the same condition that
    // built `invocableSkills` — but read rather than asserted: a missing tool
    // degrades to the typed text alone reaching the model, never a throw.
    if (executor) {
      const callId = randomUUID();
      const args = { name: named.name };
      // Wrapped for the same reason `tool-batch.ts` wraps every `invoke`
      // (ADR 0024): a throwing tool must not kill the session. Unreachable
      // today — the body is already in memory — but the asymmetry is the kind
      // that survives a refactor.
      let resultJson: string;
      let ok: boolean;
      try {
        const outcome = await executor.invoke(args);
        ok = outcome.ok;
        resultJson = capToolResult(
          outcome.ok
            ? JSON.stringify(outcome.value)
            : JSON.stringify({ error: outcome.error }),
        );
      } catch (error) {
        ok = false;
        // Capped like the success path above: the transcript row and the
        // model's message must carry the same bytes, and a bound that applied
        // to only one of two branches is the asymmetry, not the rule.
        resultJson = capToolResult(
          JSON.stringify({
            error: {
              code: "unavailable",
              message: `load_skill: ${(error as Error).message}`,
            },
          }),
        );
      }
      await emitItem({
        id: callId,
        type: "tool_call",
        tool: "load_skill",
        argsJson: JSON.stringify(args),
        status: ok ? "completed" : "failed",
        resultJson,
      });
      invokedCalls.push({ id: callId, name: "load_skill", args });
      invokedResults.push({ id: callId, resultJson });
    }
  }

  // The assistant/tool batch, in exactly the shape `plainHistory` synthesises
  // for a run of rebuilt tool calls — so a provider cannot tell a resumed
  // session from a fresh one, however many skills the message named.
  if (invokedCalls.length > 0) {
    messages.push({ role: "assistant", content: "", toolCalls: invokedCalls });
    for (const { id, resultJson } of invokedResults)
      messages.push({ role: "tool", content: resultJson, toolCallId: id });
  }

  // A6 (ADR 0023): say once, up front, when the configured model is outside the
  // tier Lemmaria has actually verified for this loop — resolved Q4's honest
  // degradation. Never on a child: a fan-out of 8 must not stamp 8 copies into
  // the parent's transcript for a model the user was already told about.
  if (
    opts.isChild !== true &&
    classifyModelForSession(opts.binding.model) === "unverified"
  ) {
    await emitNotice("model.unverified", 0);
  }

  const hooks = createTaskHooks({
    counters,
    budget,
    model: opts.binding.model,
    registry,
    allowedTools,
    messages,
    emitItem,
    emitNotice,
    retry,
    ...(appliedLedger ? { appliedLedger } : {}),
    ...(opts.takeSteering ? { takeSteering: opts.takeSteering } : {}),
    // V2 (ADR 0078 §4): the task's own transcript is bound in HERE, where the
    // emitter that holds it lives. The hooks are handed a one-argument check
    // and never learn that items exist.
    ...(opts.finalAnswerCheck
      ? {
          finalAnswerCheck: (text: string) =>
            opts.finalAnswerCheck?.(text, replayEntries(emitter.entries())),
        }
      : {}),
    compact,
    failedCompactionStop,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const stop = await runTurnLoop({
    generateStream,
    binding: opts.binding,
    messages,
    toolSpecs,
    maxTurns: budget.maxTurns,
    startTurnNumber: turnNumber,
    emit,
    emitItem,
    emitNotice,
    // The loop's usage seam IS the budget counter's feed (review): keeping the
    // accrual in `shouldStopAfterTurn` would make output-token accounting a
    // side effect of a stop decision, so a future early return there would
    // silently stop charging (invariant 5).
    onTurnUsage: accrue,
    hooks,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!stop) {
    await emitNotice("budget.turns", budget.maxTurns);
    return finish("completed");
  }
  return finishFromStop(stop);
}
