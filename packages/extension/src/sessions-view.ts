/**
 * A5 — the Sessions view, backed by the real session store.
 *
 * U5 shipped an honest *shell* here: no session backend existed, so the tree
 * showed the active editor dressed as a session plus an explicit "history
 * arrives in v0.2" placeholder. A0–A2 built the backend (JSONL per session in
 * globalStorage, `SessionStore.list()`, `resumeSession`), so the shell is
 * replaced by the thing itself.
 *
 * What a row may show is bounded by what `SessionMeta` actually holds — id,
 * title, workspace, createdAt, updatedAt (contracts/sessions.ts). The mockup's
 * `intro.tex · 6 verified edits` is therefore NOT reproduced: there is no count
 * field, and the count it shows is a quick-action edit count, which the binding
 * v0.2 direction forbids in Sessions history. Inventing either would be a
 * fabricated field (invariant 7 + the honesty rule), so a row shows its title
 * and a relative timestamp, and nothing else.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SessionMeta } from "@lemmaria/harness";
import * as vscode from "vscode";
import { tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import { activeSessionId, listSessions } from "./session-host";
import {
  forkedFromTooltip,
  relativeTimeLabel,
  sessionRowDescription,
  sessionRowLabel,
  sessionRowTooltip,
} from "./session-labels";
import { openDocumentFor, readThroughBuffer } from "./session/buffer-io";
import { sessionEditRoot } from "./session/registry";
import { sha256 } from "./session/snapshot-host";
import { recordPull, viewPullsForTests } from "./sidebar-ui";

export interface SessionViewRow {
  kind: "session";
  id: string;
  title: string;
  /**
   * Which of the parent's messages this fork was cut before, 1-based (ADR
   * 0058 §2). Absent on a session that was created, and on a `/fork` child,
   * which cut before nothing. The row's LABEL is composed from it per display
   * language — the number is what is stored, never the rendered prefix.
   */
  atMessage?: number;
  /** "just now" / "12m" / "3h" / "yesterday" / a locale date beyond a week. */
  relative: string;
  /** The session this window is currently talking to. */
  active: boolean;
  updatedAt: string;
  /**
   * Sessions forked FROM this one (ADR 0057 §6), in the order `list()` gave
   * them. Empty for a leaf — and empty is what makes a row non-collapsible,
   * which is how ADR 0030 §8's empty twisty goes away.
   */
  children: SessionViewRow[];
  /** How deep this row sits; 0 for a root. Rendering reads it, nothing else. */
  depth: number;
  /**
   * At least one file this session wrote no longer holds what it wrote (ADR
   * 0058 §7). Recomputed against the workspace on every refresh and never
   * persisted: it is a fact about disk right now, not about the session. (The
   * per-file shas behind it ARE cached, on `(mtime, size)` — see
   * `outOfSyncSessions` for what that cache does and does not trust.)
   */
  outOfSync?: boolean;
}

export type SessionsTreeRow = SessionViewRow;

/*
 * ADR 0057 DELETED `BranchViewRow`, `branchViewRows`, `branchRowLabel` and
 * `BRANCH_LABEL_MAX` from here, with `SessionsProvider.branchItem` below.
 *
 * They were B6/ADR 0030 §7-§8's branch rows: a session expanded to its
 * branches, each labelled from its last user message and each clicking through
 * to `lemmaria.switchBranch`. A session file has no branches now — an
 * abandoned tail is another session — so what nests under a row is a forked
 * SESSION, computed at list time from `SessionMeta.forkedFrom` and needing no
 * `load()` at all. ADR 0030 §8's shape survives; its mechanism does not.
 */

let extContext: vscode.ExtensionContext | undefined;
const changed = new vscode.EventEmitter<void>();

/** Minutes/hours/days since `iso`, or undefined when it is not a real date. */
function agoParts(iso: string, now: number): { minutes: number } | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return { minutes: Math.max(0, Math.floor((now - then) / 60000)) };
}

/**
 * A compact relative stamp. Beyond a week the absolute date is more useful than
 * "43d", so the row switches to the locale date — the Codex/Claude Code session
 * list convention.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const parts = agoParts(iso, now);
  if (!parts) return ""; // an unparseable stamp is shown as nothing, never "NaN"
  // The clock is this module's; the WORDS are `session-labels.ts`'s, where
  // both renderings are asserted per locale (D13).
  return relativeTimeLabel(iso, parts.minutes, currentLocale());
}

/**
 * How many sessions the tree lists. Sessions are never deleted, so a working
 * writer accumulates them indefinitely; a tree of a thousand rows is not a
 * history, it is a wall. The newest N are the reachable-by-glance ones, and
 * `Lemmaria: Resume Session` (the ⟲ quick-pick) still offers the FULL list with
 * type-to-filter — the Codex/Claude Code split between a recent list and a
 * searchable one.
 */
export const SESSION_LIST_LIMIT = 50;

/**
 * The out-of-sync glyph (ADR 0058 §7).
 *
 * Script-neutral on purpose: it is appended to a row description that is
 * otherwise wholly in the reader's language, and a word — "changed" / "已改动"
 * — would have to be localized twice to say what one character says once. The
 * sentence that explains it IS localized, in the tooltip.
 */
export const OUT_OF_SYNC_MARKER = " ≠";

/**
 * Files read while answering the marker's question, since activation. A test
 * seam and nothing else: D6's cost bound — one read per PATH per row-set
 * BUILD, not one per row — is a claim about I/O, so it is counted rather than
 * reasoned about.
 *
 * **Per build and not per refresh**, stated precisely (E6 code review): a
 * refresh fires `changed`, which drives `getChildren()` and `syncMessage()`,
 * and each builds the row set. The `seen` memo below is local to one build, so
 * the second build asks again — and for a file on disk the cross-refresh
 * `(mtime, size)` cache answers without a read, which is why the counter still
 * lands on 1. What genuinely costs twice is an OPEN DIRTY BUFFER, which that
 * cache must not serve; that is an in-memory `getText()` and a hash, and it is
 * the price of the marker being right about unsaved work.
 */
let contentReads = 0;
export const contentReadsForTests = (): number => contentReads;

/** abs path → the sha of the bytes seen at that `(mtimeMs, size)`. */
const diskShas = new Map<
  string,
  { mtimeMs: number; size: number; sha: string }
>();

/**
 * One file's content identity, buffer-first and cached on disk metadata.
 *
 * `undefined` = the file is not there, which the marker reads as *out of
 * sync*: a session's manifest never records a deletion (nothing it can
 * persist means one — ADR 0058 §3), so a file it wrote and that is now gone
 * is a divergence, not a state the session asked for.
 */
async function shaOnDisk(abs: string): Promise<string | undefined> {
  const uri = vscode.Uri.file(abs);
  const open = openDocumentFor(uri);
  if (open) {
    // No cache: an unsaved edit moves neither mtime nor size.
    contentReads += 1;
    return sha256(open.getText());
  }
  let stamp: { mtimeMs: number; size: number };
  try {
    const s = await stat(abs);
    stamp = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    diskShas.delete(abs);
    return undefined; // gone
  }
  const hit = diskShas.get(abs);
  if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size)
    return hit.sha;
  contentReads += 1;
  const current = await readThroughBuffer(uri);
  if (current === undefined) {
    diskShas.delete(abs);
    return undefined;
  }
  const sha = sha256(current);
  diskShas.set(abs, { ...stamp, sha });
  return sha;
}

/**
 * Which of these sessions' files no longer match what they wrote (ADR 0058 §7).
 *
 * A row is out of sync when at least one entry of its leaf manifest differs
 * from the workspace: the file's current content — read THROUGH an open
 * buffer, so an unsaved hand edit counts, exactly as `guardedRestore`'s
 * expected-check reads it — hashes to something other than the recorded sha,
 * or the file is missing where content is expected. A session that wrote no
 * files is never marked, which is what keeps the signal precise rather than
 * noisy: only a session whose OWN work has been overwritten lights up.
 *
 * **The active session is checked like any other.** After a code-only rewind
 * the row the writer is in lights up, because its transcript's leaf no longer
 * matches disk — the deliberate honesty the marker exists for.
 *
 * **Two caches, and they answer different questions.** Within one row-set
 * build the answer is memoized by path, because sessions routinely share
 * files: eight rows naming one paper must read that paper once. A refresh
 * builds the set twice — see `contentReads` for what that second build costs,
 * and what it does not. Across refreshes — and the view refreshes
 * on every session create, resume and reset — a file whose `(mtime, size)` has
 * not moved is not re-read at all. That trusts the filesystem's own metadata,
 * which is the trust every incremental build makes, and it is recorded as a
 * deliberate limit rather than hidden.
 *
 * **An open buffer is never served from the cross-refresh cache**, because
 * `(mtime, size)` describes DISK: an unsaved edit moves neither, and a cached
 * answer would go on saying *in sync* while the writer looks at their own
 * divergence.
 */
export async function outOfSyncSessions(
  root: string,
  listings: readonly { meta: { id: string }; files: Record<string, string> }[],
): Promise<Set<string>> {
  const rootAbs = resolve(root);
  /** path → its current sha, or `undefined` when the file is not there. */
  const seen = new Map<string, string | undefined>();
  const shaOf = async (file: string): Promise<string | undefined> => {
    const cached = seen.get(file);
    if (cached !== undefined || seen.has(file)) return cached;
    const abs = resolve(rootAbs, file);
    const rel = relative(rootAbs, abs);
    // The containment rule `applyRestorePlan` uses: a manifest entry outside
    // the root is not this workspace's file to have an opinion about.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      seen.set(file, undefined);
      return undefined;
    }
    const sha = await shaOnDisk(abs);
    seen.set(file, sha);
    return sha;
  };

  const marked = new Set<string>();
  for (const { meta, files } of listings)
    for (const [file, written] of Object.entries(files))
      if ((await shaOf(file)) !== written) {
        marked.add(meta.id);
        break;
      }
  return marked;
}

/**
 * The rows, newest-updated first (SessionStore.list's own order), capped at
 * SESSION_LIST_LIMIT. No session is ever synthesized: an empty store yields
 * zero rows, and the view's welcome message carries the empty state.
 */
export async function sessionViewRows(): Promise<SessionViewRow[]> {
  if (!extContext) return [];
  const listed = (await listSessions(extContext)).slice(0, SESSION_LIST_LIMIT);
  const root = sessionEditRoot();
  // One computation for the whole refresh (ADR 0058 §7's cost bound), not one
  // per row and not one per row-build pass. With no workspace folder open
  // there is nothing to compare against, so nothing is marked.
  const stale =
    root === undefined
      ? new Set<string>()
      : await outOfSyncSessions(root, listed);
  return nestSessionRows(
    listed.map((s) => s.meta),
    activeSessionId(),
    Date.now(),
    stale,
  );
}

/**
 * ADR 0057 §6: nest each session under the one it was forked from, at any
 * depth, and return the ROOTS.
 *
 * Computed here, at list time, from `SessionMeta.forkedFrom` — which `list()`
 * carries, so this costs no `load()` at all. B6's branch rows needed one per
 * expansion (ADR 0030 §8), which is why they were derived lazily and why every
 * session showed a twisty whether or not anything was under it.
 *
 * **Nesting happens AFTER the `SESSION_LIST_LIMIT` slice**, so the constant
 * keeps meaning what it always meant: how many rows this view considers. A
 * parent outside that window — deleted, or simply older than the newest 50 —
 * therefore has no row to hang its children on, and they are **promoted to
 * roots** in their own list positions rather than vanishing (Pi's degradation).
 * Nesting first and capping roots afterwards would silently redefine 50 as
 * *families*, and one deep lineage could then pull hundreds of rows into a
 * view whose whole reason for a cap is that sessions are never deleted.
 *
 * Order is `list()`'s at every level — newest-updated first for roots and for
 * siblings alike. One rule and no second sort, so the session a writer just
 * forked into sorts to the top of its parent's children, which is the one they
 * are looking for.
 */
export function nestSessionRows(
  metas: readonly SessionMeta[],
  activeId?: string,
  now = Date.now(),
  /** Ids `outOfSyncSessions` marked; empty when there is nothing to compare. */
  stale: ReadonlySet<string> = new Set(),
): SessionViewRow[] {
  const rows = new Map<string, SessionViewRow>();
  for (const meta of metas)
    rows.set(meta.id, {
      kind: "session",
      id: meta.id,
      title: meta.title,
      ...(meta.forkedFrom?.atMessage === undefined
        ? {}
        : { atMessage: meta.forkedFrom.atMessage }),
      relative: relativeTime(meta.updatedAt, now),
      active: meta.id === activeId,
      updatedAt: meta.updatedAt,
      children: [],
      depth: 0,
      ...(stale.has(meta.id) ? { outOfSync: true } : {}),
    });
  const roots: SessionViewRow[] = [];
  for (const meta of metas) {
    const row = rows.get(meta.id);
    if (!row) continue;
    // `hasAncestor` guards a cycle, which nothing writes — `forkedFrom` is
    // stamped once, at birth, naming a session that already exists — but a
    // hand-edited or truncated store must degrade the way every other fold
    // here does: surface what it has, and never spin.
    const parent = meta.forkedFrom
      ? rows.get(meta.forkedFrom.sessionId)
      : undefined;
    if (
      parent &&
      parent !== row &&
      !hasAncestor(rows, metas, parent.id, row.id)
    )
      parent.children.push(row);
    else roots.push(row);
  }
  for (const root of roots) setDepth(root, 0);
  return roots;
}

/** Whether `startId` reaches `targetId` by walking `forkedFrom` upwards. */
function hasAncestor(
  rows: ReadonlyMap<string, SessionViewRow>,
  metas: readonly SessionMeta[],
  startId: string,
  targetId: string,
): boolean {
  const parentOf = new Map(
    metas.flatMap((m) =>
      m.forkedFrom ? [[m.id, m.forkedFrom.sessionId] as const] : [],
    ),
  );
  const seen = new Set<string>();
  let at: string | undefined = startId;
  while (at !== undefined && !seen.has(at)) {
    if (at === targetId) return true;
    seen.add(at);
    at = parentOf.get(at);
    if (at !== undefined && !rows.has(at)) return false;
  }
  return false;
}

function setDepth(row: SessionViewRow, depth: number): void {
  row.depth = depth;
  for (const child of row.children) setDepth(child, depth + 1);
}

class SessionsProvider implements vscode.TreeDataProvider<SessionsTreeRow> {
  readonly onDidChangeTreeData = changed.event;

  // Hands out row OBJECTS, never indices: the ext host truthiness-filters a `0`
  // element, which silently dropped the first row of all four U5 trees.
  async getChildren(element?: SessionsTreeRow): Promise<SessionsTreeRow[]> {
    // The whole tree is computed by the top-level call (ADR 0057 §6), so an
    // expansion reads what it already holds — no `load()`, no second listing.
    return element === undefined ? sessionViewRows() : element.children;
  }

  getTreeItem(row: SessionsTreeRow): vscode.TreeItem {
    return this.sessionItem(row);
  }

  private sessionItem(row: SessionViewRow): vscode.TreeItem {
    // Proves the LIVE view rendered this row, not just that the model produced
    // it — the U5 round-1 lesson (a provider can be correct and render nothing).
    // `currentLocale()`, not `resolvedLocale()`: this is CHROME, and the
    // `lemmaria.language` override governs model output, not what the reader
    // sees (invariant 6 rule 2; i18n.ts is the one home for that decision).
    const locale = currentLocale();
    const label = sessionRowLabel(
      {
        title: row.title,
        ...(row.atMessage === undefined
          ? {}
          : {
              forkedFrom: {
                sessionId: "",
                cutBeforeItemId: null,
                atMessage: row.atMessage,
              },
            }),
      },
      locale,
    );
    recordPull(viewPullsForTests.sessionsLabels, label);
    // Collapsible ONLY when something is under it. ADR 0030 §8 had to be
    // unconditional, because knowing cost a `load()` per row; `forkedFrom` is
    // in the listing, so the empty twisty it recorded as a cost is gone.
    const item = new vscode.TreeItem(
      label,
      row.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    // The marker ends the description (ADR 0058 §7) — see the formatter.
    item.description = sessionRowDescription(row, OUT_OF_SYNC_MARKER, locale);
    item.iconPath = new vscode.ThemeIcon(
      row.active ? "circle-filled" : "comment-discussion",
    );
    item.contextValue = row.active ? "activeSession" : "session";
    const when = new Date(row.updatedAt).toLocaleString();
    // B6's tooltip ended "expand to see its branches" on EVERY row, which was
    // already half-false then (a single-branch session expanded to nothing) and
    // is wholly false now: there are no branches, and a row without children
    // has no twisty to expand. A parent names its forks instead, because
    // otherwise the twisty is the only hint that this conversation was
    // continued somewhere else (ADR 0057 §6).
    const forks =
      row.children.length === 0
        ? ""
        : `\n${forkedFromTooltip(row.children.length, locale)}`;
    // One sentence, in the reader's language, saying what the glyph means —
    // the glyph itself is script-neutral and says nothing on its own.
    const stale = row.outOfSync ? `\n${tr(locale, "sessionOutOfSync")}` : "";
    item.tooltip = sessionRowTooltip({ label, when, forks, stale }, locale);
    item.command = {
      command: "lemmaria.resumeSessionById",
      title: tr(locale, "resumeSession"),
      arguments: [row.id],
    };
    return item;
  }
}

const provider = new SessionsProvider();

/** Re-pull the tree — called when a session is created, resumed, or reset. */
export function refreshSessionsView(): void {
  changed.fire();
}

export function registerSessionsView(context: vscode.ExtensionContext): void {
  extContext = context;
  const view = vscode.window.createTreeView("lemmariaSessions", {
    treeDataProvider: provider,
  });
  /**
   * A `view.message` SUPPRESSES `viewsWelcome` (VS Code shows the welcome only
   * when the message is empty), so an unconditional message would hide the
   * empty state this milestone contributes. Carry the "conversational only"
   * note when there ARE rows, and let the welcome speak when there are none.
   */
  const syncMessage = async (): Promise<void> => {
    const empty = (await sessionViewRows()).length === 0;
    view.message = empty
      ? undefined
      : currentLocale() === "zh"
        ? "仅记录对话式会话——快捷操作不会出现在这里。"
        : "Conversational sessions only — quick actions never appear here.";
  };
  void syncMessage();
  context.subscriptions.push(
    view,
    changed,
    changed.event(() => void syncMessage()),
    // The tree refreshes on session create/resume/new; a manual refresh also
    // picks up sessions another window created and re-ages the timestamps.
    vscode.commands.registerCommand("lemmaria.refreshSessions", () =>
      refreshSessionsView(),
    ),
  );
}

/** Test seam (A5): the rows as plain data — nested, roots first. */
export const sessionViewRowsForTests = sessionViewRows;

/** Test seam (E5): the nesting rule alone, over metas the caller supplies. */
export const nestSessionRowsForTests = nestSessionRows;

/** Test seam (A5): the rendered tree item for a row. */
export function sessionViewItemForTests(row: SessionViewRow): vscode.TreeItem {
  return provider.getTreeItem(row);
}

/** Test seam (E6, ADR 0058 §7): the marker's rule, over listings the caller
 *  supplies, against a root the caller owns. */
export const outOfSyncSetForTests = outOfSyncSessions;

/** Test seam (E6): the one-session shorthand the marker's rule answers. */
export async function outOfSyncForTests(
  root: string,
  listings: readonly {
    meta: { id: string };
    files: Record<string, string>;
  }[],
): Promise<boolean> {
  return (await outOfSyncSessions(root, listings)).size > 0;
}

/** Test seam (E6): the glyph, so no test hard-codes the character. */
export const outOfSyncMarkerForTests = (): string => OUT_OF_SYNC_MARKER;

/** Test seam (E6): the SAME content identity the marker compares with. */
export const shaForTests = sha256;
