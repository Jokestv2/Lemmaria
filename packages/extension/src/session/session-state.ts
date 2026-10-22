import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type SessionEvent,
  type SessionMeta,
  SessionStore,
  SnapshotStore,
} from "@lemmaria/harness";
import * as vscode from "vscode";

/**
 * The window's session identity and task state (B1 split of `session-host.ts`).
 *
 * The leaf every other session seam imports: the store, which session this
 * window is talking to, and whether a task is in flight. Deliberately imports
 * NO other seam, so the dependency direction stays
 * `session-host → seams → session-state`.
 */

/** One store + one active session per window (A0 deliberate limit; A5 grows this). */
let store: SessionStore | undefined;
/** ADR 0031: this workspace's blob store, cached the same way as `store`. */
let blobs: SnapshotStore | undefined;
let activeSession: SessionMeta | undefined;
let lastEvents: SessionEvent[] = [];

/**
 * A5 (reload survival): the id of the session this window is talking to,
 * mirrored into workspaceState.
 *
 * `activeSession` is module memory, and a window reload restarts the whole
 * extension host — so without this pointer the A5 handshake replay had nothing
 * to replay and every reload dropped the user back on the welcome screen, even
 * though the transcript was safe on disk the entire time. workspaceState is the
 * right home: the session store is already keyed by workspace, so the pointer
 * and the sessions it points into share one scope.
 */
const ACTIVE_SESSION_KEY = "lemmaria.activeSessionId";
/** The context that owns the pointer above (set by `restoreActiveSession`). */
let hostContext: vscode.ExtensionContext | undefined;

export function setHostContext(context: vscode.ExtensionContext): void {
  hostContext = context;
}

export function storedActiveSessionId(
  context: vscode.ExtensionContext,
): string | undefined {
  return context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
}

/** Mirror (or clear) the active-session pointer. Best-effort, like every other
 *  persistence path here — a failed write costs a reload's transcript, never
 *  the transcript itself. */
export function rememberActiveSession(context?: vscode.ExtensionContext): void {
  const ctx = context ?? hostContext;
  if (context) hostContext = context;
  void ctx?.workspaceState.update(ACTIVE_SESSION_KEY, activeSession?.id);
}

export function workspaceRootPath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "no-workspace";
}

export function pathsEqual(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** The per-workspace key both `sessionStoreFor` and `snapshotStore` shard on. */
function workspaceKey(): string {
  return createHash("sha256")
    .update(workspaceRootPath())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Session home (ADR 0014, stage-plan resolved Q2): user-level globalStorage,
 * keyed by workspace — never inside the paper repo (papers get shared;
 * transcripts are private).
 */
export function sessionStoreFor(
  context: vscode.ExtensionContext,
): SessionStore {
  // Cached on first use, keyed by the workspace open at that moment: a
  // workspace-less window that later opens a folder keeps writing under the
  // "no-workspace" key until reload (A0 one-store-per-window limit).
  if (!store) {
    store = new SessionStore(
      join(context.globalStorageUri.fsPath, "sessions", workspaceKey()),
    );
  }
  return store;
}

/**
 * ADR 0031: this workspace's blob store, under globalStorage beside its
 * sessions — never the paper repo, for the same reason sessions are not there
 * (ADR 0014). Cached per window, keyed the same way `sessionStoreFor` is; the
 * directory is created lazily by `put`.
 */
export function snapshotStore(context: vscode.ExtensionContext): SnapshotStore {
  if (!blobs) {
    blobs = new SnapshotStore(
      join(context.globalStorageUri.fsPath, "snapshots", workspaceKey()),
    );
  }
  return blobs;
}

/**
 * ADR 0065 §1: this workspace's review history, beside its sessions and its
 * snapshots and sharded the same way.
 *
 * **Keyed by workspace, and that is the whole design.** A review is a reading
 * of a manuscript, so it belongs to the project the manuscript is in — not to
 * the conversation that happened to start it, which is what made a New Session
 * silently empty the picker and restart the version sequence at v1.
 */
export function reviewStoreDir(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, "reviews", workspaceKey());
}

/** The cached store, or undefined before the first `sessionStoreFor`. */
export const currentStore = (): SessionStore | undefined => store;
export const currentSession = (): SessionMeta | undefined => activeSession;

export function setCurrentSession(meta: SessionMeta | undefined): void {
  activeSession = meta;
}

/** Events emitted by the last composerSend (the A0 test seam's source). */
export const recordedEvents = (): SessionEvent[] => lastEvents;
export function recordEvent(event: SessionEvent): void {
  lastEvents.push(event);
}
export function clearRecordedEvents(): void {
  lastEvents = [];
}

/** ADR 0014: one live task at a time. A1a: a send during a live task steers it. */
let turnInFlight = false;
/** A1a: aborts the live task (the composer Stop affordance + New Session). */
let taskAbort: AbortController | undefined;
/** A1a: user input queued while a task runs; drained at turn boundaries, and
 *  leftovers become follow-up tasks (the Codex queued-input convention). */
export const steeringQueue: string[] = [];

/** True while a session task is running (the restore guard reads this). */
export function isTaskInFlight(): boolean {
  return turnInFlight;
}

/** Claim the single task slot and mint its abort controller. */
export function beginTask(): AbortController {
  turnInFlight = true;
  taskAbort = new AbortController();
  return taskAbort;
}

export function endTask(): void {
  turnInFlight = false;
  taskAbort = undefined;
}

/** A1a: abort the live task (the webview Stop affordance). No-op when idle. */
export function abortLiveTask(): boolean {
  if (!taskAbort) return false;
  taskAbort.abort();
  return true;
}

/** Fire-and-forget abort used by New Session, where "no task" is not an error. */
export function abortIfRunning(): void {
  taskAbort?.abort();
}

/** Test seam (A0): the resolved session directory (undefined before first use). */
export const sessionStoreDirForTests = (): string | undefined => store?.rootDir;

/** Drop the cached store + active session (hermetic suites, window reload). */
export function resetSessionState(): void {
  store = undefined;
  blobs = undefined;
  activeSession = undefined;
  lastEvents = [];
  steeringQueue.length = 0;
}
