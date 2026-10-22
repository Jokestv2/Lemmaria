import {
  type SessionEvent,
  type SessionTaskResult,
  contextWindowFor,
  parsePdfReviewCommand,
  parseReviewCommand,
  runSessionTask,
  sessionTitle,
  tokensInWindow,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentLocale } from "./i18n";
import { getModel } from "./model";
import { startReviewRun } from "./review-host";
import {
  buildSessionEditHost,
  pushRestorePoints,
  recordProposal,
} from "./session/edit-host";
import { activeSessionGrants, flushGrantItems } from "./session/grants-host";
import {
  chargeReviewItem,
  pushContextUsage,
  pushTurnUsage,
} from "./session/notifications";
import { sessionEditRoot } from "./session/registry";
import {
  beginTask,
  clearRecordedEvents,
  currentSession,
  endTask,
  isTaskInFlight,
  recordEvent,
  rememberActiveSession,
  sessionStoreFor,
  setCurrentSession,
  snapshotStore,
  steeringQueue,
  workspaceRootPath,
} from "./session/session-state";
import { sharedTaskOptions } from "./session/task-options";

/**
 * The composer's session entry point, and the public surface of the session
 * host.
 *
 * B1 split this file (1461 lines) into one module per seam under `session/`;
 * what stays here is the orchestration that spans them — one composer send
 * becomes one or more `runSessionTask` calls — plus the re-exports that keep
 * this module the single import site every consumer already uses.
 */

export type ComposerSendOutcome =
  | SessionTaskResult
  | { status: "no-model" }
  | { status: "steered" }
  /** ADR 0065 §4: the message was `/review`, so it started a detached panel
   *  and this conversation was not touched. */
  | { status: "review" };

/** The composer's session entry point (supersedes U1's composerEdit routing). */
export async function handleComposerSend(
  context: vscode.ExtensionContext,
  text: string,
  postEvent: (event: SessionEvent) => void,
): Promise<ComposerSendOutcome> {
  // ADR 0065 §4: `/review` is intercepted HERE, before the steering rule and
  // before any session exists.
  //
  // A review is not a message to this conversation any more (§2), so it must
  // not become one — not a `user_message` item, not a turn, and not steering
  // for a task that happens to be running. Typing it and clicking the Review
  // tab's Run are the same event again, as ADR 0064 §2 made them, except that
  // the shared thing is now the detached run rather than this function.
  //
  // `parseReviewCommand` is the harness's own parser, so the grammar still has
  // exactly one home and `/review <focus>` keeps its verbatim argument
  // (invariant 6 rule 1). Text that merely CONTAINS `/review` is prose and is
  // not matched — the parser anchors both ends.
  //
  // This also closes what ADR 0064 §3 left OPEN: a typed `/review` during a
  // task used to be swallowed as steering prose. It now starts a panel, which
  // runs beside the task (§3).
  const review = parseReviewCommand(text);
  if (review !== null) {
    await startReviewRun(context, review.focus);
    return { status: "review" };
  }
  // V4 (ADR 0081 §7): the third verb, intercepted the same way and for the
  // same reasons — a review of the compiled PDF alone, detached, never a
  // message and never steering.
  const pdfReview = parsePdfReviewCommand(text);
  if (pdfReview !== null) {
    await startReviewRun(context, pdfReview.focus, { pdfOnly: true });
    return { status: "review" };
  }
  // Checked/set before the first await. A send while a task runs becomes
  // steering (ADR 0015, superseding A0's busy refusal): it joins the live
  // task at the next turn boundary, or runs as a follow-up task if the task
  // ends first.
  if (isTaskInFlight()) {
    steeringQueue.push(text);
    return { status: "steered" };
  }
  const abort = beginTask();
  try {
    const resolved = await getModel(context.secrets);
    if (!resolved) {
      void vscode.window.showWarningMessage(
        currentLocale() === "zh"
          ? "Lemmaria：请先在 Models 标签页配置一个模型。"
          : "Lemmaria: configure a model in the Models tab first.",
      );
      return { status: "no-model" };
    }
    const s = sessionStoreFor(context);
    // Review #1: if New Session resets the thread while this task is dying,
    // its remaining events (interrupted, task.completed) must not haunt the
    // fresh transcript — drop them once the session identity changed. Bound
    // here rather than re-read later, so it is non-optional by construction.
    const existing = currentSession();
    const sessionAtStart =
      existing ??
      (await s.create({ title: text, workspace: workspaceRootPath() }));
    if (!existing) {
      setCurrentSession(sessionAtStart);
      // A5: from this moment a reload can land back in this conversation.
      rememberActiveSession(context);
    } else if (existing.title === "") {
      // A rewind fork is born untitled (ADR 0058 §2), and this is the send
      // that names it — the same rule a fresh session's `create` applies, one
      // step later, because at fork time there was no message to name it with.
      // `setTitle` caps through `sessionTitle` and corrects the index entry, so
      // the Sessions view shows the new name without opening a log.
      await s.setTitle(existing.id, text);
      setCurrentSession({ ...existing, title: sessionTitle(text) });
    }
    // A4: grants added before the session existed persist now, in add order —
    // the JSONL replays to the same active set the live getter serves.
    await flushGrantItems(s, sessionAtStart.id);
    clearRecordedEvents();
    // The write root is the WORKSPACE, not the focused editor (round 2).
    const writeRoot = sessionEditRoot();
    // ADR 0065 §2: the options a chat task and a detached review share, in
    // one place, so the two can never be briefed off different read surfaces.
    // `paper` is `undefined` deliberately: the composer can no longer run a
    // panel (§4 intercepts `/review` above), so resolving the manuscript on
    // every send would be a workspace walk for a code path that is gone.
    const shared = await sharedTaskOptions(context, undefined);
    const runOnce = async (taskText: string): Promise<SessionTaskResult> =>
      runSessionTask({
        ...shared,
        store: s,
        session: sessionAtStart,
        model: resolved.adapter,
        binding: resolved.binding,
        text: taskText,
        // The write path (A1b): offered whenever we have a workspace root —
        // any file in the project, the Codex/Claude Code model. External
        // roots stay an A4 capability-grant question. NOT in the shared set:
        // a review never writes, and the capability being absent there is
        // invariant 3 holding by construction (ADR 0065 §2).
        ...(writeRoot
          ? { editHost: buildSessionEditHost(writeRoot, sessionAtStart.id) }
          : {}),
        // ADR 0031: every applied write is content-addressed into this
        // workspace's blob store, so `fileStates` populates for real and a
        // later branch switch has something to restore from.
        snapshots: snapshotStore(context),
        signal: abort.signal,
        takeSteering: () => steeringQueue.shift(),
        onEvent: (event) => {
          if (currentSession() !== sessionAtStart) return;
          // Keep the diff-on-demand source current for every proposal the
          // task emits (pending pause records and terminal ones alike).
          if (
            writeRoot &&
            (event.type === "item.completed" ||
              event.type === "item.updated") &&
            event.item.type === "edit_proposal"
          ) {
            recordProposal(event.item, writeRoot);
          }
          recordEvent(event);
          // A2: the composer's context ring — measured occupancy after each
          // turn; a compaction resets it to unknown until the next turn
          // reports (the ring shows "—" rather than a stale percentage).
          if (event.type === "turn.completed") {
            pushContextUsage({
              occupied: tokensInWindow(event.usage),
              window: contextWindowFor(resolved.binding.model),
            });
            // A5: charge the turn, not the task — an interrupted task still
            // spent what its completed turns spent.
            if (event.usage) pushTurnUsage(event.usage, resolved.binding.model);
          }
          // A5 (review): a fan-out's children never reach a turn event — their
          // usage rides the subtask item — so charge it here too, or every
          // subagent session under-reports its real spend everywhere. A
          // subtask's children run on the PARENT's model (R9 §D3 binds only
          // the panel), so its usage is still charged whole.
          if (
            event.type === "item.completed" &&
            event.item.type === "subtask" &&
            event.item.usage
          )
            pushTurnUsage(event.item.usage, resolved.binding.model);
          // R9 (§D5): a review is charged per reviewer. It cannot reach this
          // sink today (see the note below), and it is handled correctly here
          // anyway — a charge that is right only because the path is dead is
          // a bug waiting for the path to come back.
          if (event.type === "item.completed" && event.item.type === "review")
            chargeReviewItem(event.item, resolved.binding.model);
          // ADR 0065 §2: a `review` item can no longer reach this sink. The
          // panel runs detached, on its own scratch store, and presents itself
          // from `review-host.ts`; R3's presentation here is gone with the
          // path that produced it. Left as a note rather than deleted silently
          // because "the review tab is fed from the session's events" was true
          // for three rounds and is the kind of thing a reader assumes.
          if (
            event.type === "item.completed" &&
            event.item.type === "compaction"
          ) {
            // A5: summarizing is a paid call outside any turn — charge it, or
            // the one operation that reads the WHOLE conversation is the one
            // operation that costs nothing on screen.
            if (event.item.usage)
              pushTurnUsage(event.item.usage, resolved.binding.model);
            pushContextUsage({
              window: contextWindowFor(resolved.binding.model),
            });
          }
          postEvent(event);
        },
      });
    let outcome = await runOnce(text);
    // Steering that arrived after the task's last turn boundary becomes the
    // next task on the same session — queued input is never silently lost:
    // it either runs as a follow-up (below) or is discarded VISIBLY when the
    // task was interrupted or failed (review #2; ADR 0015).
    while (
      steeringQueue.length > 0 &&
      outcome.status === "completed" &&
      !abort.signal.aborted
    ) {
      const next = steeringQueue.shift();
      if (next === undefined) break;
      outcome = await runOnce(next);
    }
    if (steeringQueue.length > 0) {
      const dropped = steeringQueue.splice(0).join(" · ");
      void vscode.window.showWarningMessage(
        currentLocale() === "zh"
          ? `Lemmaria：任务已停止，排队的消息未发送：${dropped}`
          : `Lemmaria: the task stopped — queued message(s) not sent: ${dropped}`,
      );
    }
    return outcome;
  } catch (err) {
    // runSessionTask never throws on model failure, but store I/O can (disk
    // full, storage dir gone). Surface it instead of leaving the UI thinking.
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      currentLocale() === "zh"
        ? `Lemmaria：会话出错——${message}`
        : `Lemmaria: session error — ${message}`,
    );
    return { status: "failed", items: [], error: message };
  } finally {
    endTask();
    // The task is over: the branch may move again (see `branchPointsOf`).
    pushRestorePoints();
  }
}

/** A1a: abort the live task (the webview Stop affordance). No-op when idle. */
export { abortLiveTask as interruptSessionTask } from "./session/session-state";

// --- the public surface, one export block per seam (B1). Every name below was
// exported by this file before the split, so no consumer changed. ---

export {
  isTaskInFlight,
  sessionStoreFor,
  sessionStoreDirForTests,
  recordedEvents as sessionEventsForTests,
} from "./session/session-state";

export {
  type ContextUsage,
  lastContextUsageForTests,
  onContextUsage,
  onRunUsage,
  onTurnUsage,
} from "./session/notifications";

export {
  S2_KEY_SECRET,
  activeSessionGrants,
  addGrant,
  literatureBudgetForTests,
  onGrantsChanged,
  revokeGrant,
  setLiteratureProvidersForTests,
} from "./session/grants-host";

export {
  DEFAULT_SCRIPT_INTERPRETERS,
  setScriptInterpretersForTests,
  submitScriptDecision,
} from "./session/script-host";

export {
  type RewindPoint,
  branchPointsOf,
  currentEditPolicy,
  onRestorePointsChanged,
  proposalFileDiffFor,
  rewindConversation,
  rewindPointsOf,
  sessionCreatedFiles,
  setEditPolicy,
  submitEditDecisions,
} from "./session/edit-host";

export { noteActivePaper } from "./session/registry";

export {
  activeSessionId,
  activeSessionIdForTests,
  activeSessionReady,
  activeSessionSnapshot,
  activeSessionUsage,
  compactActiveSession,
  listSessions,
  resetSessionForTests,
  restoreActiveSession,
  resumeSession,
  sessionCostForTests,
  sessionStoreDir,
  sessionItems,
  simulateWindowReloadForTests,
  startNewSession,
} from "./session/lifecycle";
