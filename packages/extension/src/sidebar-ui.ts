import * as path from "node:path";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { onProposalAccepted } from "./diff-review";
import { currentLocale, localeLabel } from "./i18n";
import { onSessionEditApplied } from "./session/edit-host";
import { onEditRolledBack } from "./verify-ui";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * Primary-sidebar UI (U5/X1): a session-scoped record of accepted edits,
 * rendered as the Edits + Sessions TreeViews. Compiling is a report the user
 * asks for (ADR 0013), not a gate on an edit, so no compile status is ever
 * stamped here — the list is an honest session log, not a verification
 * ledger. In-memory only — persisting history is the v0.2 Sessions backend
 * (deliberately not built; the list honestly resets with the window).
 */

export interface EditEntry {
  fsPath: string;
  /** Basename, for the row label. */
  file: string;
  /** Locale-resolved action label ("Polish" / "润色"). */
  action: string;
  /** 1-based line of the edit's start in the pre-edit text (for jump). */
  line: number;
  acceptedAt: number;
  /** Set by `onEditRolledBack` — the only state this session log still tracks. */
  rolledBack: boolean;
  /**
   * Which write path produced it, because they are undone differently and the
   * row must not offer an affordance that cannot work. `action` = the M4
   * quick-action Accept, which the M5 backend can roll back one edit at a time.
   * `agent` = a `propose_edit` write, whose undo is the ⟲ control on the user
   * bubble in the transcript (ADR 0031, and since ADR 0057 that control forks
   * rather than branching) — the M5 backend never saw it, so an inline ↺ here
   * would fail every time it was clicked.
   */
  source: "action" | "agent";
}

/** Newest first; capped so a marathon session can't grow unbounded. */
const MAX_ENTRIES = 200;
const entries: EditEntry[] = [];
const storeChanged = new vscode.EventEmitter<void>();

function pickLocale(name: { en?: string; zh?: string } | undefined): string {
  return localeLabel(name, currentLocale() === "zh" ? "编辑" : "Edit");
}

/** 1-based line of `offset` within `text`. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** The newest entry for a file that has not been rolled back. */
function newestActive(fsPath: string): EditEntry | undefined {
  return entries.find((e) => e.fsPath === fsPath && !e.rolledBack);
}

/**
 * The newest entry for a file, rolled back or not. The M5 backend keeps ONE
 * `lastAccepted` per file and DELETES it on rollback — so only this entry (and
 * only while not rolled back) can honestly offer the rollback affordance; an
 * older entry never can, even after the newest was rolled back.
 */
function newestFor(fsPath: string): EditEntry | undefined {
  return entries.find((e) => e.fsPath === fsPath);
}

/**
 * Can this row honestly offer the inline ↺? Only a quick-action edit: the M5
 * backend is the thing `lemmaria.rollbackEdit` asks, and it only ever saw
 * those. An agentic write is undone with ⟲ at its message in the transcript
 * instead (ADR 0031; ADR 0057 made that a fork) — offering a button here that
 * returns false every time would be exactly the faked affordance the U5 round
 * removed.
 */
function isRollbackable(e: EditEntry): boolean {
  return e.source === "action" && !e.rolledBack && newestFor(e.fsPath) === e;
}

/** Test seam: the session's recorded edits, newest first. */
export function getEditsForTests(): EditEntry[] {
  return entries.map((e) => ({ ...e }));
}

function relativeTime(then: number, zh: boolean): string {
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return zh ? "刚刚" : "just now";
  const m = Math.round(s / 60);
  if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
  const d = Math.round(h / 24);
  return zh ? `${d} 天前` : `${d}d ago`;
}

/** Test seam: what VS Code actually pulled from the LIVE tree views — proves
 *  rows really render (the store seams sit below the ext-host's rendering). */
export const viewPullsForTests = {
  getChildren: 0,
  getTreeItem: 0,
  /** Labels of Edits rows the live view rendered. */
  labels: [] as string[],
  /** Labels of Sessions rows the live view rendered. */
  sessionsLabels: [] as string[],
};

/** Capped like the store — the seam must never become a production leak. */
const MAX_PULL_LABELS = 200;
export function recordPull(arr: string[], label: string): void {
  arr.push(label);
  if (arr.length > MAX_PULL_LABELS) arr.splice(0, arr.length - MAX_PULL_LABELS);
}

// Tree elements are the row OBJECTS themselves — never array indices. The
// ext host truthiness-filters (coalesce) every getChildren result, so a 0
// element is silently dropped and its row never renders (U5 manual-test bug).
class EditsProvider implements vscode.TreeDataProvider<EditEntry> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void {
    this.emitter.fire();
  }
  getChildren(element?: EditEntry): EditEntry[] {
    viewPullsForTests.getChildren += 1;
    if (element !== undefined) return [];
    return [...entries];
  }
  getTreeItem(e: EditEntry): vscode.TreeItem {
    viewPullsForTests.getTreeItem += 1;
    recordPull(viewPullsForTests.labels, `${e.action} · ${e.file}`);
    return this.buildItem(e);
  }
  /** Item construction, shared with the test seam (which must not register
   *  as a live-view pull — the seam's counters would lie otherwise). */
  buildItem(e: EditEntry): vscode.TreeItem {
    const zh = currentLocale() === "zh";
    const item = new vscode.TreeItem(
      `${e.action} · ${e.file}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = e.rolledBack
      ? new vscode.ThemeIcon("discard")
      : new vscode.ThemeIcon("edit");
    const when = relativeTime(e.acceptedAt, zh);
    const rolledBackText = zh ? "已回滚" : "rolled back";
    item.description = e.rolledBack ? `${rolledBackText} · ${when}` : when;
    // An agent row says where its undo lives, since it has no ↺ of its own.
    // It pointed at "branching" until ADR 0057; the control is ⟲ and what it
    // does is go back, so the hint now names the control the reader will look
    // for rather than an operation the product no longer has — and it moved
    // into the string table, where both renderings are assertable data (D4).
    const undoHint =
      e.source === "agent" ? `\n\n${chrome("editsAgentUndoHint")}` : "";
    item.tooltip = new vscode.MarkdownString(
      `**${e.action}** — \`${e.file}\` L${e.line}\n\n${
        e.rolledBack ? `${rolledBackText} · ` : ""
      }${new Date(e.acceptedAt).toLocaleTimeString()}${undoHint}`,
    );
    item.command = {
      command: "vscode.open",
      title: chrome("editsOpen"),
      arguments: [
        vscode.Uri.file(e.fsPath),
        {
          selection: new vscode.Range(
            Math.max(0, e.line - 1),
            0,
            Math.max(0, e.line - 1),
            0,
          ),
        },
      ],
    };
    if (isRollbackable(e)) {
      item.contextValue = "rollbackable";
    }
    return item;
  }
}

const editsProvider = new EditsProvider();

/** Test seam: the rendered tree item for the entry at `index`. */
export function editsItemForTests(index: number): vscode.TreeItem | undefined {
  const e = entries[index];
  return e === undefined ? undefined : editsProvider.buildItem(e);
}

/**
 * A5: the Sessions tree moved to `sessions-view.ts`, backed by the real session
 * store. U5's model lived here — the active editor dressed as a session plus an
 * explicit "history arrives in v0.2" placeholder — and was honest only while no
 * session backend existed. It does now (A0–A2), so this file keeps only the
 * Verified Edits tree. (Its `sessionRowsForTests` seam went with it: a seam
 * that can only return [] is a test that passes no matter what the view does.)
 */

/** Newest-first insert, capped. Shared by the two write paths below. */
function record(entry: EditEntry): void {
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  storeChanged.fire();
}

/**
 * The agentic write path's label. A `propose_edit` batch is not a named quick
 * action, so there is no action name to localize — it is the assistant, which
 * is what the composer tab is called in both languages.
 */
const AGENT_ACTION = { en: "Assistant", zh: "助手" };

export function registerSidebar(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    onProposalAccepted.event(
      ({ realUri, proposal, preEditText, actionName }) => {
        record({
          fsPath: realUri.fsPath,
          file: path.basename(realUri.fsPath),
          action: pickLocale(actionName),
          line: lineOfOffset(preEditText, proposal.span.startOffset),
          acceptedAt: Date.now(),
          rolledBack: false,
          source: "action",
        });
      },
    ),
    // A1b's write path reported to nothing: this view listened only to the M4
    // quick-action Accept, so every agentic edit — the whole v0.2 write path,
    // under BOTH policies — was missing from the one place that lists what
    // Lemmaria changed (D4 manual round, checklist item 7).
    onSessionEditApplied.event(({ fsPath, file, line }) => {
      record({
        fsPath,
        file: path.basename(file),
        action: pickLocale(AGENT_ACTION),
        line,
        acceptedAt: Date.now(),
        rolledBack: false,
        source: "agent",
      });
    }),
    onEditRolledBack.event(({ fsPath }) => {
      const entry = newestActive(fsPath);
      if (!entry) return;
      entry.rolledBack = true;
      storeChanged.fire();
    }),
    storeChanged,
  );

  const editsView = vscode.window.createTreeView("lemmariaVerifiedEdits", {
    treeDataProvider: editsProvider,
  });
  // Invariant 3 as ADR 0016/0031 actually implement it: approval OR a one-step
  // undo. The old wording ("every change passed your Accept") predates the
  // auto-apply policy and was false under it — found while wiring the agentic
  // path into this view (D4 manual round). ADR 0031 makes the second half true
  // everywhere: the undo no longer needs the workspace to be a git repository.
  editsView.message =
    currentLocale() === "zh"
      ? "无静默写入——每处修改要么经您确认，要么可在对话中一步撤销。"
      : "No silent edits — every change passed your Accept, or can be undone in one step from the transcript.";
  context.subscriptions.push(
    editsView,
    storeChanged.event(() => editsProvider.refresh()),
    vscode.commands.registerCommand(
      "lemmaria.rollbackVerifiedEdit",
      // The inline ↺ passes the tree element (the live entry object); tests
      // may address an entry by its store index.
      async (arg: number | EditEntry): Promise<boolean> => {
        const e = typeof arg === "number" ? entries[arg] : arg;
        if (!e || !isRollbackable(e)) return false;
        const ok = await vscode.commands.executeCommand<boolean>(
          "lemmaria.rollbackEdit",
          vscode.Uri.file(e.fsPath),
        );
        // onEditRolledBack marks the entry; nothing more to do on success.
        return ok === true;
      },
    ),
  );
}
