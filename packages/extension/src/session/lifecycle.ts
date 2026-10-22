import {
  type SessionEntry,
  type SessionEvent,
  type SessionItem,
  type SessionListing,
  type SessionMeta,
  type SessionUsageTotal,
  activeGrants,
  contextWindowFor,
  lastMeasuredOccupancy,
  runSessionCompaction,
  sumSessionUsage,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentLocale, resolvedLocale } from "../i18n";
import { getModel, modelStore } from "../model";
import { clearReviews } from "../review-ui";
import * as edits from "./edit-host";
import * as grants from "./grants-host";
import {
  type ContextUsage,
  clearMeasuredContextUsage,
  measuredContextUsage,
  pushContextUsage,
  pushTurnUsage,
} from "./notifications";
import { resetStickyPaper } from "./registry";
import * as scripts from "./script-host";
import {
  abortIfRunning,
  clearRecordedEvents,
  currentSession,
  currentStore,
  isTaskInFlight,
  rememberActiveSession,
  resetSessionState,
  sessionStoreFor,
  setCurrentSession,
  setHostContext,
  steeringQueue,
  storedActiveSessionId,
} from "./session-state";

/**
 * Session lifecycle (B1 split of `session-host.ts`): new · resume · reload
 * survival · list · manual compaction · the handshake snapshot.
 *
 * This is the one module allowed to reach into every seam, because starting a
 * fresh thread means resetting all of them — in the order the single
 * `startNewSession` used to, so the two read the same.
 */

/**
 * A5 (reload survival): reopen the session this window was talking to before
 * the host restarted. Started at activation; the webview handshake awaits it
 * (`activeSessionReady`) so a view that loads first still gets the transcript.
 *
 * Deliberately routed through `resumeSession` — THE resume operation — so a
 * reload restores exactly what picking the session from the Sessions view
 * would: the transcript and its grants, with the edit policy back at `review`
 * and the always-allow cache empty (re-consent, not loss). Branch points DO
 * come back, in full: ADR 0031 derives them from the session log, so a reload
 * is no longer able to lose them the way it lost B6's in-memory ref map.
 *
 * No events are posted here — the webview pulls the transcript itself on
 * `ready`, which is the one path that knows whether a view exists yet.
 */
let activeSessionRestore: Promise<boolean> | undefined;

export function restoreActiveSession(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  setHostContext(context);
  activeSessionRestore = (async () => {
    const id = storedActiveSessionId(context);
    if (id === undefined || id === "") return false;
    const meta = await resumeSession(context, id);
    // A pointer to a session that no longer loads (deleted store, corrupt
    // JSONL) is stale bookkeeping — drop it rather than retrying every launch.
    if (!meta) {
      rememberActiveSession(context);
      return false;
    }
    return true;
  })();
  return activeSessionRestore;
}

/**
 * A5: resolves once the activation-time restore has settled. The webview's
 * `ready` replay awaits this — the two race on every reload, and a replay that
 * ran first would read `activeSession` as undefined and render the welcome
 * state over a session that was about to come back.
 */
export function activeSessionReady(): Promise<unknown> {
  return activeSessionRestore ?? Promise.resolve(false);
}

/**
 * A5 (review 2): there is deliberately NO hand-kept usage accumulator here.
 *
 * One was tried and removed: a turn's usage reaches this host through the event
 * sink, but the same turn has ALREADY been appended to the JSONL by then — so a
 * buffer that adds deltas on top of a fold double-counts every turn appended
 * before the read, while a buffer that only fills after seeding drops every
 * turn appended during it. Both failures are silent and one-directional, which
 * is precisely what a spend readout must never be.
 *
 * The persisted event stream is the single source of truth, so the readout
 * folds it (a small local file, read once per turn boundary — the same turn
 * that just cost a network round-trip).
 */
export async function activeSessionUsage(): Promise<SessionUsageTotal> {
  const nothing: SessionUsageTotal = {
    inputTokens: 0,
    outputTokens: 0,
    unpricedCalls: 0,
  };
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return nothing;
  try {
    // `entries`, not `branch`: spend is the one fold ADR 0027 leaves
    // whole-session. Tokens paid for on a branch the user rewound past were
    // still paid for, and scoping this would make rewinding look free.
    return sumSessionUsage((await store.load(session.id)).entries);
  } catch {
    return nothing;
  }
}

/**
 * A1a: `Lemmaria: New Session` — a fresh thread (the Codex `/new` /
 * Claude Code `/clear` convention): aborts any live task, drops the active
 * session and queued steering; configuration carries over, no summary does
 * (that is A2's compaction, a different operation).
 */
export function startNewSession(): void {
  abortIfRunning();
  // ADR 0031: nothing to free here. B6 deleted the outgoing session's git refs
  // at this point so hidden refs could not accumulate in the user's repo;
  // snapshots are blobs in Lemmaria's own storage now, and Task 7's sweep is
  // what bounds them — deleting them on New Session would strand the very
  // sessions the Sessions view still lists.
  setCurrentSession(undefined);
  // A5: a fresh thread is what a reload should come back to now — leaving the
  // pointer set would resurrect the conversation the user just left.
  rememberActiveSession();
  clearRecordedEvents();
  steeringQueue.length = 0;
  edits.resetForNewSession();
  scripts.resetForNewSession();
  grants.resetForNewSession();
  // ADR 0065 §1 supersedes ADR 0062 §1's lifetime: the review history belongs
  // to the WORKSPACE, so a fresh thread does not clear it. This line used to
  // read `clearReviews()`, and it is the whole of the operator's report —
  // starting a new chat emptied the picker and restarted the version sequence
  // at v1, for reviews of a manuscript the new chat had not changed.
  // A2: a fresh thread has measured nothing yet — the ring resets to unknown.
  pushContextUsage({ window: 0 });
}

/**
 * B6: where this workspace's session files live. The activation blob sweep
 * reads from here rather than `listSessions`, because `list()` silently drops
 * a session whose JSONL fails to load and a sweep that believed it would free
 * a live branch's snapshots (ADR 0030 §9, carried into ADR 0031's §9 sweep).
 */
export function sessionStoreDir(context: vscode.ExtensionContext): string {
  return sessionStoreFor(context).rootDir;
}

/**
 * A2: the persisted sessions for this workspace, newest first — each with the
 * leaf file manifest the index now carries (ADR 0058 §3), so a caller can ask
 * whether a row's work is still on disk without opening one log.
 */
export async function listSessions(
  context: vscode.ExtensionContext,
): Promise<SessionListing[]> {
  try {
    return await sessionStoreFor(context).list();
  } catch {
    // An unreadable store home is "no sessions", never a thrown command.
    return [];
  }
}

/**
 * A2 (ADR 0021): resume a persisted session — sessions are durable, in-flight
 * tasks are not. Restores the conversation and its grants and replays the
 * transcript into the webview; the next message starts a FRESH task on the
 * loaded history (compaction state included, via buildConversationHistory).
 * Host state that is not a session event is deliberately NOT restored: the
 * edit policy resets to `review`, the literature budget refills, and the
 * run_script always-allow cache starts empty — each a re-consent, not a loss.
 */
export async function resumeSession(
  context: vscode.ExtensionContext,
  id: string,
  postEvent?: (event: SessionEvent) => void,
): Promise<SessionMeta | undefined> {
  const s = sessionStoreFor(context);
  let loaded: Awaited<ReturnType<typeof s.load>>;
  try {
    loaded = await s.load(id);
  } catch {
    return undefined;
  }
  // Reuse the fresh-thread reset so the OUTGOING session's approvals and
  // always-allow cache are dropped exactly as on New Session — but NOT when
  // the picked session IS the active one (review). Re-picking the current
  // session is just a transcript reload.
  if (currentSession()?.id !== id) startNewSession();
  setCurrentSession(loaded.meta);
  // A5: whichever way a session became active, a reload comes back to it.
  rememberActiveSession(context);
  // ADR 0031: nothing is rehydrated here. B6 had to read git refs back into an
  // in-memory map at this point, because that map was the only record of which
  // turn each snapshot belonged to and it died with the window. The session log
  // is that record now, and it was on disk all along — so a resumed session's
  // branch points and its siblings' file states need no rebuilding step that
  // could silently fail.
  grants.adoptResumedGrants(activeGrants(loaded.items), loaded.items);
  if (postEvent)
    for (const item of loaded.items)
      postEvent({ type: "item.completed", item });
  edits.pushRestorePoints();
  return loaded.meta;
}

/**
 * ADR 0065 §1: a resumed session no longer touches the Review tab.
 *
 * R3's `represent` lived here: a resume cleared the tab and re-presented that
 * session's `review` items, because the reviews WERE the session's. Both
 * halves are wrong now — the reviews are the workspace's, they were already
 * loaded at activation, and a resume that cleared them would reintroduce the
 * defect this milestone fixes by another door. A session's own `review` items
 * are no longer produced at all (§2); any left on disk from before are simply
 * not rendered, which is the no-backward-compatibility rule applied.
 */

/**
 * A2: `Lemmaria: Compact Session` — summarize the conversation now (the
 * Claude Code `/compact` convention). Returns false when there is no active
 * session, a task is running, no model is configured, or the summarization
 * failed — each says so honestly rather than pretending to have compacted.
 */
export async function compactActiveSession(
  context: vscode.ExtensionContext,
  postEvent?: (event: SessionEvent) => void,
): Promise<boolean> {
  const zh = currentLocale() === "zh";
  const session = currentSession();
  if (!session) {
    void vscode.window.showInformationMessage(
      zh ? "Lemmaria：当前没有进行中的会话。" : "Lemmaria: no active session.",
    );
    return false;
  }
  if (isTaskInFlight()) {
    void vscode.window.showWarningMessage(
      zh
        ? "Lemmaria：任务进行中，请先停止（◼）再压缩。"
        : "Lemmaria: stop the running task (◼) before compacting.",
    );
    return false;
  }
  const resolved = await getModel(context.secrets);
  if (!resolved) {
    void vscode.window.showWarningMessage(
      zh
        ? "Lemmaria：请先在 Models 标签页配置一个模型。"
        : "Lemmaria: configure a model in the Models tab first.",
    );
    return false;
  }
  const out = await runSessionCompaction({
    store: sessionStoreFor(context),
    sessionId: session.id,
    model: resolved.adapter,
    binding: resolved.binding,
    // ADR 0031: the handoff summary's language is a host decision.
    locale: resolvedLocale(),
    ...(postEvent ? { onEvent: postEvent } : {}),
  });
  if (!out.ok) {
    void vscode.window.showWarningMessage(
      zh
        ? `Lemmaria：压缩失败：${out.error ?? "未知错误"}`
        : `Lemmaria: compaction failed: ${out.error ?? "unknown error"}`,
    );
    return false;
  }
  // A5: the manual path does not run through a task's event sink, so charge
  // the summarization here — `Lemmaria: Compact Session` spends real money.
  if (out.item?.usage) pushTurnUsage(out.item.usage, resolved.binding.model);
  // Occupancy is unknown again until the next turn reports (honest ring).
  pushContextUsage({ window: contextWindowFor(resolved.binding.model) });
  return true;
}

/*
 * ADR 0057 DELETED `sessionBranches`, `BranchSwitchOutcome` and
 * `switchToBranch` from here, and `sessionLeafId` below.
 *
 * They were B6/ADR 0030's branch rows and the switch behind them: enumerate a
 * session's branches, move its leaf to one, and restore that branch's files on
 * the way (ADR 0031 §5). ADR 0057 supersedes §5 — **a session switch moves no
 * files** — and there are no branch rows left to switch between, because an
 * abandoned tail is now a session of its own. Removed rather than left unread,
 * per the no-backward-compatibility-burden convention.
 *
 * What the user could do with them they still can: the abandoned session is in
 * the Sessions list, nested under its parent, and clicking it resumes it. What
 * they can no longer do is have its FILES come back with it — the cost ADR
 * 0057 §5 states plainly, with its revisit trigger.
 */

/**
 * The session this window is currently talking to, or undefined for a fresh
 * thread. Read by the A5 Sessions view to mark its active row.
 */
export const activeSessionId = (): string | undefined => currentSession()?.id;

/** Test seam (A2): the active session's id, or undefined for a fresh thread. */
export const activeSessionIdForTests = activeSessionId;

/** Test seam (A5): this session's folded spend. */
export const sessionCostForTests = activeSessionUsage;

/** Test seam (A1b round 2): the persisted transcript, rewinds folded in. */
export async function sessionItems(): Promise<SessionItem[]> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return [];
  return (await store.load(session.id)).items;
}

/**
 * A5: everything a freshly-loaded webview needs to show the session that is
 * ALREADY live in this host — the transcript it lost when its bundle
 * re-executed (window reload, view moved between containers), plus the last
 * measured context occupancy, which was only ever pushed on a turn boundary.
 *
 * This is not "resume": no session is opened, nothing is reset, and with no
 * active session it returns undefined — re-opening an OLD session stays an
 * explicit gesture (the stage's resume-default-is-a-fresh-composer pin).
 *
 * Never throws: a store read failure degrades to "nothing to replay" rather
 * than wedging the handshake (the A0 P1 discipline).
 */
export async function activeSessionSnapshot(): Promise<
  | { sessionId: string; items: SessionItem[]; contextUsage?: ContextUsage }
  | undefined
> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return undefined;
  const id = session.id;
  try {
    // store.load → replayEntries: a rewind (ADR 0018 as superseded by ADR
    // 0027 and then ADR 0057 — the abandoned turns are in another session, not
    // gone) and undecided-proposal normalization are folded in exactly once,
    // here as everywhere else.
    const loaded = await store.load(id);
    const live = livePendingItems();
    const items = loaded.items.map((item) => live.get(item.id) ?? item);
    // A pause whose record never reached disk (an append failure — persistence
    // is best-effort, delivery is not) would otherwise leave the loop waiting
    // on a card the user cannot see. Its position is the end: it is the newest
    // thing that happened.
    for (const [itemId, item] of live) {
      if (!items.some((i) => i.id === itemId)) items.push(item);
    }
    // Gated on a MEASURED figure, not on the object: the reset inside a resume
    // pushes an occupancy-less `{window}` placeholder, and `??` would let that
    // truthy blank beat the persisted measurement — the ring stayed empty after
    // exactly the reload this fallback exists for.
    const measured = measuredContextUsage();
    const contextUsage =
      measured?.occupied !== undefined
        ? measured
        : // ADR 0027 needed `branch` here rather than `entries`, because a
          // whole-file scan would have reported whichever branch was written
          // last. A file is one conversation again (ADR 0057), so the entries
          // ARE the history being sent.
          replayedContextUsage(loaded.entries);
    return {
      sessionId: id,
      items,
      ...(contextUsage ? { contextUsage } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The items this host is CURRENTLY parked on, by id.
 *
 * `store.load` normalizes an undecided proposal to `stale` and an undecided
 * script_run to `failed` (ADR 0016 / ADR 0020). That is right for a transcript
 * read back after the process died — but the snapshot path also runs while this
 * host is alive and still holding the pause. Handing a re-created webview the
 * normalized copy is what made a view MOVE lose its Accept / Reject / View diff
 * buttons: the card came back read-only over a task that was still blocked on
 * the very decision the card no longer offered, and only ◼ could unwedge it.
 *
 * The live copy wins for exactly these ids and nothing else, so a genuine
 * reload (no live pause, because the loop died with the host) still replays
 * honestly stale.
 */
function livePendingItems(): Map<string, SessionItem> {
  const live = new Map<string, SessionItem>();
  const proposal = edits.livePendingProposal();
  if (proposal) live.set(proposal.id, proposal);
  const script = scripts.livePendingScript();
  if (script) live.set(script.itemId, script.item);
  return live;
}

/**
 * A5 (reload survival): occupancy folded back out of the persisted stream, for
 * a host that has not measured a turn itself yet. Only ever a fallback —
 * the live measurement always wins.
 */
function replayedContextUsage(
  branch: readonly SessionEntry[],
): ContextUsage | undefined {
  const occupied = lastMeasuredOccupancy(branch);
  if (occupied === undefined) return undefined;
  return {
    occupied,
    window: contextWindowFor(modelStore()?.active()?.model ?? ""),
  };
}

/**
 * Test seam (A5): everything a window reload actually destroys — this host's
 * in-memory session state — WITHOUT touching the workspaceState pointer that is
 * supposed to survive it, then the activation-time restore run again. The one
 * way to exercise reload survival from a test: a real reload would take the
 * test runner with it.
 */
export async function simulateWindowReloadForTests(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  resetSessionState();
  edits.resetQuiet();
  scripts.resetQuiet();
  grants.resetQuiet();
  clearMeasuredContextUsage();
  return restoreActiveSession(context);
}

/** Test seam (A0): drop the cached store + active session (hermetic suites). */
export function resetSessionForTests(): void {
  resetSessionState();
  // A5: and the reload pointer — a leftover id would have the NEXT suite's
  // activation restore a session this one was meant to forget.
  rememberActiveSession();
  activeSessionRestore = undefined;
  clearMeasuredContextUsage();
  edits.resetForTests();
  scripts.resetForNewSession();
  grants.resetQuiet();
  clearReviews();
  resetStickyPaper();
}
