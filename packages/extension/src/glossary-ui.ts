/**
 * U6 — the Glossary bottom panel (mockup: Lemmaria.dc.html:256-273).
 *
 * Read-only. It renders the SAME glossary the prompt injection and the
 * `glossary_consistent` validator use (resolveMemory over the
 * global/project/directory PAPER.md layers, nearest wins) — and names, from the
 * loaded definitions, exactly which actions that validator really guards.
 */
import * as path from "node:path";
import type { LoadedAction } from "@lemmaria/harness";
import { resolveMemory } from "@lemmaria/harness";
import * as vscode from "vscode";
import { loadMemoryInput } from "./action-run";
import { currentLocale, localeLabel } from "./i18n";
import { VscodeWorkspace } from "./workspace";

export interface GlossaryRow {
  term: string;
  zh: string;
  abbrev: string;
}

const PAPER = /\.(tex|md)$/i;

let rows: GlossaryRow[] = [];
let view: vscode.TreeView<GlossaryRow> | undefined;
const changed = new vscode.EventEmitter<void>();

/** The actions that actually declare the `glossary_consistent` validator —
 *  DERIVED from the loaded definitions, never a hardcoded list (the same
 *  invariant the tier badge follows). Today that is Translate alone. */
let enforcingActions: string[] = [];

/**
 * The banner, stating only what is true right now.
 *
 * The mockup (and product-design) say the glossary is "enforced by the
 * glossary_consistent validator … not just a hint" — but only the actions that
 * DECLARE that validator get the retry; for the others the glossary is exactly
 * the hint that wording denies. So name them. See progress.md -> Design deltas.
 */
function bannerFor(zh: boolean): string {
  if (enforcingActions.length === 0) {
    return zh
      ? "双语术语表——注入到提示词中作为上下文。"
      : "Bilingual glossary — injected into the prompt as context.";
  }
  const names = enforcingActions.join(zh ? "、" : ", ");
  return zh
    ? `双语术语表——${names}由 glossary_consistent 校验器强制执行（偏离即触发重试）；其他操作将其作为提示词上下文。`
    : `Bilingual glossary — the glossary_consistent validator enforces it on ${names} (drives a retry on deviation); other actions receive it as prompt context.`;
}

/** The merged glossary for the paper `uri` belongs to (empty when there is
 *  none — a missing `## Glossary` section is normal, not an error). */
export async function computeGlossary(
  uri: vscode.Uri | undefined,
): Promise<GlossaryRow[]> {
  if (!uri || uri.scheme !== "file" || !PAPER.test(uri.fsPath)) return [];
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
  const entry = path.relative(root, uri.fsPath).replaceAll("\\", "/");
  try {
    const workspace = new VscodeWorkspace(root, entry);
    const memory = await loadMemoryInput(workspace, entry);
    // Source order is the spec (the mockup's data is authored order, not
    // sorted); resolveMemory's nearest-wins merge order is preserved as-is.
    return resolveMemory(memory).glossary.map((g) => ({
      term: g.term,
      zh: g.zh,
      abbrev: g.abbrev,
    }));
  } catch {
    return [];
  }
}

class GlossaryTree implements vscode.TreeDataProvider<GlossaryRow> {
  readonly onDidChangeTreeData = changed.event;

  getChildren(element?: GlossaryRow): GlossaryRow[] {
    // Elements are ROW OBJECTS, never indices: the ext host truthiness-filters
    // getChildren results, so an index element 0 is dropped (the U5 round-1
    // bug that silently hid every view's first row).
    return element ? [] : rows;
  }

  getTreeItem(row: GlossaryRow): vscode.TreeItem {
    const zh = currentLocale() === "zh";
    const item = new vscode.TreeItem(
      row.term,
      vscode.TreeItemCollapsibleState.None,
    );
    // A TreeView cannot render the mockup's 3 columns — the two secondary
    // fields ride the description, all three the tooltip.
    const abbrev = row.abbrev.trim() === "" ? "—" : row.abbrev;
    item.description = `${row.zh} · ${abbrev}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${row.term}**`,
        "",
        `${zh ? "中文" : "Chinese"}: ${row.zh || "—"}`,
        "",
        `${zh ? "缩写" : "Abbrev"}: ${abbrev}`,
      ].join("\n"),
    );
    item.command = {
      title: zh ? "跳转到用例" : "Reveal use",
      command: "lemmaria.revealGlossaryTerm",
      arguments: [row],
    };
    return item;
  }
}

/** Generation guard: `computeGlossary` awaits fs reads of the PAPER.md layers,
 *  so a slow refresh for A.tex can resolve after a fast one for B.tex and list
 *  A's terms while B is active. Only the newest refresh may write. */
let refreshSeq = 0;

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  const next = await computeGlossary(
    vscode.window.activeTextEditor?.document.uri,
  );
  if (seq !== refreshSeq) return; // superseded mid-read
  rows = next;
  changed.fire();
  if (!view) return;
  const zh = currentLocale() === "zh";
  view.message = rows.length > 0 ? bannerFor(zh) : undefined;
  view.badge =
    rows.length > 0
      ? {
          value: rows.length,
          tooltip: zh ? `${rows.length} 条术语` : `${rows.length} terms`,
        }
      : undefined;
}

/** Test seam: refresh synchronously (no editor-change event needed). */
export async function refreshGlossaryForTests(): Promise<void> {
  await refresh();
}

/** Test seam: what the REAL provider hands out and renders (the U5 lesson —
 *  a correct model proves nothing about what the tree pulled). */
export function glossaryTreeForTests(): {
  children: GlossaryRow[];
  items: { label: string; description: string }[];
  message: string | undefined;
  badge: number | undefined;
} {
  const provider = new GlossaryTree();
  const children = provider.getChildren();
  return {
    children,
    items: children.map((row) => {
      const item = provider.getTreeItem(row);
      return {
        label: String(item.label ?? ""),
        description: String(item.description ?? ""),
      };
    }),
    message: view?.message,
    badge: view?.badge?.value,
  };
}

export function registerGlossary(
  context: vscode.ExtensionContext,
  actions: LoadedAction[] = [],
): void {
  enforcingActions = actions
    .filter((a) =>
      (a.definition.output?.validators ?? []).some(
        (v) => v.type === "glossary_consistent",
      ),
    )
    .map((a) => localeLabel(a.definition.name, a.definition.id));

  view = vscode.window.createTreeView("lemmariaGlossary", {
    treeDataProvider: new GlossaryTree(),
  });

  context.subscriptions.push(
    view,
    changed,
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const base = path.basename(doc.uri.fsPath).toUpperCase();
      if (base === "PAPER.MD" || base === "MEMORY.MD") void refresh();
    }),
    vscode.commands.registerCommand(
      "lemmaria.revealGlossaryTerm",
      async (row: GlossaryRow) => {
        const editor = vscode.window.activeTextEditor;
        if (
          !editor ||
          editor.document.uri.scheme !== "file" ||
          !PAPER.test(editor.document.uri.fsPath)
        ) {
          return;
        }
        const at = editor.document
          .getText()
          .toLowerCase()
          .indexOf(row.term.toLowerCase());
        if (at < 0) {
          void vscode.window.showInformationMessage(
            currentLocale() === "zh"
              ? `“${row.term}”未在本文件中出现。`
              : `"${row.term}" does not appear in this file.`,
          );
          return;
        }
        const start = editor.document.positionAt(at);
        const end = editor.document.positionAt(at + row.term.length);
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(
          new vscode.Range(start, end),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      },
    ),
  );
  void refresh();
}
