/**
 * U6 — the enriched status bar (mockup: Lemmaria.dc.html:787-803).
 *
 * This module owns the items U6 adds: the EN / CN counts (and, from Task 3, the
 * tier badge, git branch, engine and Lemmaria mark). The verify item stays
 * verify-ui.ts's and the cost item stays cost-ui.ts's (including its
 * lemmaria.cost.display gating) — U6 adds to the bar, it does not re-home what
 * is already there.
 *
 * Priorities render left->right as the mockup does: verify 100 | branch 99 ...
 * EN 104 | CN 103 | cost 99 | engine 95 | mark 90.
 *
 * The mockup's `L0 routed` badge is deliberately absent (D4, CHROME-2): the
 * routing tier is an internal detail a user has no decision to make with.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { loadAdapterFor } from "@lemmaria/adapters";
import {
  type SemanticUnit,
  freezeUnit,
  spansToFreeze,
  stripTokens,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentLocale, localeLabel } from "./i18n";
import { VscodeWorkspace } from "./workspace";

export interface ChromeCounts {
  en: number;
  zh: number;
}

const PAPER = /\.(tex|md)$/i;

let enItem: vscode.StatusBarItem | undefined;
let zhItem: vscode.StatusBarItem | undefined;
let branchItem: vscode.StatusBarItem | undefined;
let engineItem: vscode.StatusBarItem | undefined;
let markItem: vscode.StatusBarItem | undefined;

const branchCache = new Map<string, string | undefined>();

/** The branch via `git`, not the vscode.git API: the ext-host test runner
 *  launches with --disable-extensions, so that API is unavailable there
 *  (spawnSync precedent: verify-ui.ts's binaryExists). */
export function gitBranchFor(root: string): string | undefined {
  if (branchCache.has(root)) return branchCache.get(root);
  let branch: string | undefined;
  try {
    const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
    });
    const out = res.status === 0 ? res.stdout.trim() : "";
    branch = out.length > 0 && out !== "HEAD" ? out : undefined;
  } catch {
    branch = undefined; // no git binary — hide, never fabricate
  }
  branchCache.set(root, branch);
  return branch;
}

/** The parsed project, cached per document VERSION: dragging a selection must
 *  never re-parse; a keystroke bumps the version and invalidates. */
let parseCache:
  | { key: string; adapter: Awaited<ReturnType<typeof loadAdapterFor>> }
  | undefined;

function locate(uri: vscode.Uri): { root: string; entry: string } {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
  const entry = path.relative(root, uri.fsPath).replaceAll("\\", "/");
  return { root, entry };
}

/**
 * The counts for the current SELECTION, on the ENGINE's prose basis: protected
 * spans (math, citations, macros, comments) are frozen to tokens and stripped
 * before counting, exactly as buildContext does (context.ts:76-101). A raw
 * count would score `\citep{foo}` as two words.
 *
 * Selection-only by design. The mockup shows a whole-document total, but there
 * is no honest way to compute one today: `resolveSelection`'s "document" scope
 * returns the whole FILE (selection.ts:83) and plain environment delimiters are
 * not protected spans (the M6 limit), so the preamble and the words
 * begin/document/end/document score as prose — a 3-word paper totals 7. An
 * accurate total needs an adapter primitive (a contract addition); until then
 * the items hide rather than show a wrong number.
 */
export async function computeCounts(
  editor: vscode.TextEditor,
): Promise<ChromeCounts | undefined> {
  const doc = editor.document;
  if (doc.uri.scheme !== "file" || !PAPER.test(doc.uri.fsPath))
    return undefined;
  if (editor.selection.isEmpty) return undefined;

  const { root, entry } = locate(doc.uri);
  const key = `${doc.uri.fsPath}@${doc.version}`;
  let adapter = parseCache?.key === key ? parseCache.adapter : undefined;
  if (!adapter) {
    try {
      adapter = await loadAdapterFor(new VscodeWorkspace(root, entry), entry);
    } catch {
      return undefined; // unparseable mid-edit: render nothing, never a guess
    }
    parseCache = { key, adapter };
  }

  let unit: SemanticUnit;
  try {
    unit = adapter.resolveSelection(
      {
        file: entry,
        startOffset: doc.offsetAt(editor.selection.start),
        endOffset: doc.offsetAt(editor.selection.end),
      },
      "selection",
    );
  } catch {
    return undefined;
  }

  const frozen = freezeUnit(
    unit,
    spansToFreeze(adapter.protectedSpans(unit), "freeze"),
  );
  const prose = stripTokens(frozen.text, frozen.tokens);
  // No fall back to `unit.text` when the prose is empty. buildContext does that
  // (context.ts:101) because an ACTION needs something to work on — but here an
  // all-frozen selection (`\citep{x}`, `$x^2$`) genuinely contains zero prose
  // words, and counting the raw source instead would report `EN 2 w` for it.
  // countWords("") is an honest 0.
  const wc = adapter.countWords(prose);

  // `segments` is populated only for `mixed` — derive both numbers honestly.
  if (wc.language === "mixed") {
    const sum = (lang: "en" | "zh"): number =>
      (wc.segments ?? [])
        .filter((s) => s.language === lang)
        .reduce((n, s) => n + s.count, 0);
    return { en: sum("en"), zh: sum("zh") };
  }
  if (wc.language === "zh") return { en: 0, zh: wc.count };
  return { en: wc.count, zh: 0 };
}

/** Hide an item and clear its text (see renderCounts). */
function hideItem(item: vscode.StatusBarItem | undefined): void {
  if (!item) return;
  item.text = "";
  item.tooltip = undefined;
  item.hide();
}

/** Generation guard: `computeCounts` awaits a parse, so a slow render for a big
 *  .tex can resolve AFTER a newer one for a different file and overwrite it
 *  with that file's numbers. Only the newest render may write. */
let renderSeq = 0;

async function renderCounts(): Promise<void> {
  const seq = ++renderSeq;
  const editor = vscode.window.activeTextEditor;
  const counts = editor ? await computeCounts(editor) : undefined;
  if (seq !== renderSeq) return; // superseded mid-parse
  if (editor && vscode.window.activeTextEditor !== editor) return;
  if (!counts || !enItem || !zhItem) {
    // `hide()` leaves `.text` set, so clear it too: the text IS the item's
    // state, and a stale string would outlive the selection it described.
    hideItem(enItem);
    hideItem(zhItem);
    return;
  }
  const zh = currentLocale() === "zh";

  enItem.text = `EN ${counts.en.toLocaleString("en-US")} w`;
  enItem.tooltip = zh
    ? "英文按词计数 · 所选内容（不含公式、引用与命令）"
    : "English counted by word · selection (math, citations and macros excluded)";
  enItem.show();

  zhItem.text = `中文 ${counts.zh.toLocaleString("en-US")} 字`;
  zhItem.tooltip = zh
    ? "中文按字符计数 · 所选内容（不含公式、引用与命令）"
    : "Chinese counted by character · selection (math, citations and macros excluded)";
  zhItem.show();
}

function renderBranch(): void {
  if (!branchItem) return;
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    hideItem(branchItem);
    return;
  }
  const branch = gitBranchFor(locate(uri).root);
  if (!branch) {
    hideItem(branchItem);
    return;
  }
  const zh = currentLocale() === "zh";
  branchItem.text = `$(git-branch) ${branch}`;
  branchItem.tooltip = zh
    ? `当前 Git 分支：${branch}`
    : `Git branch: ${branch}`;
  branchItem.show();
}

function renderEngine(): void {
  if (!engineItem) return;
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== "file" || !PAPER.test(doc.uri.fsPath)) {
    hideItem(engineItem);
    return;
  }
  // The FORMAT is Lemmaria's own adapter resolution (which adapter will run —
  // loadAdapterFor's rule), not the editor's language mode.
  const format = /\.(md|markdown)$/i.test(doc.uri.fsPath)
    ? "Markdown"
    : "LaTeX";
  const raw = String(
    vscode.workspace
      .getConfiguration("files", doc.uri)
      .get<string>("encoding") ?? "utf8",
  );
  // `files.encoding` ids are lowercase and hyphen-less ("utf8"); render the
  // canonical spelling the mockup shows.
  const encoding = raw.toLowerCase() === "utf8" ? "UTF-8" : raw.toUpperCase();
  const zh = currentLocale() === "zh";
  engineItem.text = `${format} · ${encoding}`;
  engineItem.tooltip = zh
    ? `Lemmaria 将使用 ${format} 适配器 · 文件编码 ${encoding}（files.encoding）`
    : `Lemmaria will use the ${format} adapter · file encoding ${encoding} (files.encoding)`;
  engineItem.show();
}

async function renderChrome(): Promise<void> {
  renderBranch();
  renderEngine();
  await renderCounts();
}

let countsDebounce: NodeJS.Timeout | undefined;
function scheduleCounts(): void {
  if (countsDebounce) clearTimeout(countsDebounce);
  countsDebounce = setTimeout(() => void renderCounts(), 150);
}

/** Test seam: skip the debounce and await the render. */
export async function refreshStatusBarForTests(): Promise<void> {
  if (countsDebounce) clearTimeout(countsDebounce);
  await renderChrome();
}

/** Test seam: what each item currently renders (undefined = hidden). */
export function statusBarTextsForTests(): Record<string, string | undefined> {
  return {
    en: enItem?.text || undefined,
    zh: zhItem?.text || undefined,
    branch: branchItem?.text || undefined,
    engine: engineItem?.text || undefined,
    mark: markItem?.text || undefined,
  };
}

export function registerStatusBar(context: vscode.ExtensionContext): void {
  enItem = vscode.window.createStatusBarItem(
    "lemmaria.countEn",
    vscode.StatusBarAlignment.Right,
    104,
  );
  enItem.name = "Lemmaria EN Count";
  zhItem = vscode.window.createStatusBarItem(
    "lemmaria.countZh",
    vscode.StatusBarAlignment.Right,
    103,
  );
  zhItem.name = "Lemmaria CN Count";

  branchItem = vscode.window.createStatusBarItem(
    "lemmaria.branch",
    vscode.StatusBarAlignment.Left,
    99,
  );
  branchItem.name = "Lemmaria Git Branch";

  engineItem = vscode.window.createStatusBarItem(
    "lemmaria.engine",
    vscode.StatusBarAlignment.Right,
    95,
  );
  engineItem.name = "Lemmaria Engine";

  markItem = vscode.window.createStatusBarItem(
    "lemmaria.mark",
    vscode.StatusBarAlignment.Right,
    90,
  );
  markItem.name = "Lemmaria";
  markItem.text = "◆ Lemmaria";
  markItem.tooltip =
    currentLocale() === "zh"
      ? "打开 Lemmaria 助手"
      : "Open the Lemmaria Assistant";
  markItem.command = "lemmaria.openAssistant";
  markItem.show();

  const watcher = vscode.workspace.createFileSystemWatcher("**/.git/HEAD");
  const invalidateBranch = (): void => {
    branchCache.clear();
    renderBranch();
  };
  const watcherSubs = [
    watcher.onDidChange(invalidateBranch),
    watcher.onDidCreate(invalidateBranch),
    watcher.onDidDelete(invalidateBranch),
  ];

  context.subscriptions.push(
    enItem,
    zhItem,
    branchItem,
    engineItem,
    markItem,
    watcher,
    ...watcherSubs,
    // A debounced render firing after deactivate() would touch disposed items.
    { dispose: () => countsDebounce && clearTimeout(countsDebounce) },
    vscode.window.onDidChangeTextEditorSelection(scheduleCounts),
    vscode.window.onDidChangeActiveTextEditor(() => void renderChrome()),
    vscode.workspace.onDidChangeTextDocument(scheduleCounts),
  );
  void renderChrome();
}
