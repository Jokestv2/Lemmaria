/**
 * The Compile tab (X1): the findings of a user-invoked Compile Check, triaged
 * by the user. Modeled on review-ui.ts — same shape, same triage.
 *
 * Compiling is verify-ui.ts's job and happens ONLY when the user asks (ADR
 * 0013). This module never compiles: it renders what a Compile Check found and
 * routes a fix through the ordinary Accept-gated diff (invariant 3). Accepting
 * a fix does NOT re-run anything — the user re-runs Compile Check when they
 * choose to. That termination is the whole point of the milestone.
 */

import * as path from "node:path";
import { loadLatexAdapter } from "@lemmaria/adapters";
import type { EditProposal, LoadedAction, Warning } from "@lemmaria/harness";
import {
  MAX_FIX_WARNINGS,
  formatWarningsForFix,
  runAction,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { recordUsage } from "./cost-ui";
import { onProposalAccepted, openProposalDiff } from "./diff-review";
import { currentLocale } from "./i18n";
import { getModel } from "./model";
import type {
  CompileFindingInfo,
  CompileFindingStatus,
  CompileTabState,
} from "./webview-protocol.js";
import { VscodeWorkspace } from "./workspace";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/** The originating-action name stamped on a fix proposal — the signal that lets
 *  the accept correlation tell fixes from Polish/other edits. */
const FIX_ACTION_NAME = {
  en: "Fix Compile Error",
  zh: "修复编译错误",
} as const;

interface CompileState {
  findings: Warning[];
  /** The checked document, for finding jumps and fixes. */
  uri: vscode.Uri;
  /** Per-finding triage state, parallel to `findings`. */
  statuses: CompileFindingStatus[];
  /** The compile's own verdict — distinct from `findings.length === 0`. */
  ok: boolean;
  guidance?: string;
}
let state: CompileState | undefined;

/**
 * A fix-in-flight: the exact rows actually sent to the model. Keyed by real-
 * file uri (only one proposal can be pending per file). Held so an Accept flips
 * EXACTLY those findings — not a same-code sibling, not a finding the fix
 * prompt truncated away (MAX_FIX_WARNINGS), and not a finding in a Compile
 * Check that has since been re-run (pinned by identity). Cleared on the
 * matching Accept; a stale entry is fail-safe. This is review-ui.ts's
 * pendingAdoptions lesson — do not simplify it away.
 */
interface PendingFix {
  compile: CompileState;
  /** The rows to flip on Accept: one for Fix, every PENDING row up to
   *  MAX_FIX_WARNINGS for Fix all — never more than the model was shown. */
  indices: number[];
}
const pendingFixes = new Map<string, PendingFix>();

/** Listeners notified when a Compile Check completes (the webview's reveal
 *  trigger). Process-lifetime: no unsubscribe — register once from activation. */
const compileListeners: Array<() => void> = [];
export function onCompileCompleted(listener: () => void): void {
  compileListeners.push(listener);
}

/** Listeners notified when a finding's triage status changes (fix/ignore), so
 *  the host re-pushes the tab WITHOUT re-revealing it. */
const compileChangedListeners: Array<() => void> = [];
export function onCompileChanged(listener: () => void): void {
  compileChangedListeners.push(listener);
}
function notifyCompileChanged(): void {
  for (const l of compileChangedListeners) l();
}

/**
 * Record what a Compile Check found — the ONE edge from the compile to this
 * tab (there is deliberately no edge back). The newest run replaces the last
 * wholesale: every row starts `pending` again, because the findings are new
 * facts about the document as it now stands.
 */
export function setCompileFindings(
  uri: vscode.Uri,
  findings: Warning[],
  ok: boolean,
  guidance?: string,
): void {
  state = {
    findings,
    uri,
    statuses: findings.map(() => "pending"),
    ok,
    ...(guidance !== undefined ? { guidance } : {}),
  };
  // The webview (registered at activation) reveals its Compile tab on this.
  for (const l of compileListeners) l();
}

/** Move a finding to `ignored`. No-op on a bad index / no compile. */
export function ignoreFinding(index: number): void {
  if (state === undefined) return;
  if (index < 0 || index >= state.statuses.length) return;
  if (state.statuses[index] === "ignored") return;
  state.statuses[index] = "ignored";
  notifyCompileChanged();
}

/** The Compile tab's display state, built from the last completed run. */
export function computeCompileTabState(): CompileTabState {
  if (state === undefined)
    return { available: false, file: "", ok: true, findings: [] };
  const current = state;
  return {
    available: true,
    file: path.basename(current.uri.fsPath),
    ok: current.ok,
    findings: current.findings.map(
      (w, index): CompileFindingInfo => ({
        index,
        severity: w.severity,
        code: w.code,
        message: w.message,
        status: current.statuses[index] ?? "pending",
        ...(w.line !== undefined ? { line: w.line } : {}),
      }),
    ),
    ...(current.guidance !== undefined ? { guidance: current.guidance } : {}),
  };
}

/**
 * When a fix's diff is Accepted, flip EXACTLY the rows the user routed into it.
 * Correlated by the fix-in-flight record, not by text: gated on the fix action
 * name (so a Polish/other edit is ignored), the same compile generation (so a
 * Compile Check re-run since Fixing never mis-flips a fresh finding), and the
 * row still being pending.
 *
 * Unlike review-ui's version this does NOT gate on the proposal's span:
 * `fix-compile-error` emits `replace_anchor` and navigates to the real defect
 * itself (ADR 0007), so the span it returns is not one the caller chose and
 * cannot be predicted. The generation + action-name guards carry correctness.
 */
function markFixedFromProposal(e: {
  realUri: vscode.Uri;
  proposal: EditProposal;
  actionName?: { en?: string; zh?: string };
}): void {
  if (e.actionName?.en !== FIX_ACTION_NAME.en) return;
  const key = e.realUri.toString();
  const pend = pendingFixes.get(key);
  if (pend === undefined) return;
  pendingFixes.delete(key);
  if (pend.compile !== state) return; // re-compiled since Fixing → not ours
  let flipped = false;
  for (const index of pend.indices) {
    if (state.statuses[index] !== "pending") continue;
    state.statuses[index] = "fixed";
    flipped = true;
  }
  if (flipped) notifyCompileChanged();
}

export interface FixOutcome {
  status:
    | "proposed"
    | "no_compile"
    | "nothing_pending"
    | "not_configured"
    | "no_fix"
    | "error";
  message?: string;
  virtualUri?: vscode.Uri;
}

let extContext: vscode.ExtensionContext | undefined;
let loadedActions: LoadedAction[] = [];

function locate(uri: vscode.Uri): { root: string; entry: string } {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
  const entry = path.relative(root, uri.fsPath).replaceAll("\\", "/");
  return { root, entry };
}

/**
 * Ask `fix-compile-error` for a repair of `indices` and route it through the
 * ordinary Accept-gated diff (invariant 3). One finding (a row's Fix) or many
 * (Fix all) — the action reads the findings as free text either way and picks
 * its own anchor, because the compiler's reported line is routinely NOT where
 * the fix belongs (ADR 0007).
 */
async function proposeFix(indices: number[]): Promise<FixOutcome> {
  if (state === undefined || extContext === undefined) {
    return {
      status: "no_compile",
      message: "run Lemmaria: Compile Check first",
    };
  }
  const current = state;
  const context = extContext;
  // Sliced to the SAME cap `formatWarningsForFix` truncates to (MAX_FIX_WARNINGS,
  // exported by the harness for exactly this): `targets` is what gets flipped on
  // Accept (see PendingFix.indices below), so it must be exactly what the model
  // was shown — not a superset that includes rows the fix prompt dropped.
  const targets = indices
    .filter((i) => current.statuses[i] === "pending")
    .slice(0, MAX_FIX_WARNINGS);
  if (targets.length === 0) {
    return { status: "nothing_pending" };
  }
  const fixAction = loadedActions.find(
    (a) => a.definition.id === "fix-compile-error",
  )?.definition;
  if (!fixAction) {
    return {
      status: "error",
      message: "built-in action fix-compile-error missing",
    };
  }
  const bound = await getModel(context.secrets);
  if (!bound) {
    const message = chrome("needsModelForFix");
    void vscode.window.showWarningMessage(message);
    return { status: "not_configured", message };
  }

  const realUri = current.uri;
  const { root, entry } = locate(realUri);
  const workspace = new VscodeWorkspace(root, entry);
  const documentText = await workspace.readFile(entry);
  try {
    // No verify binding: fixing never compiles (ADR 0013) — the action reads the
    // document with the retrieval tools and answers with an anchored edit.
    const adapter = await loadLatexAdapter(workspace, entry);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: chrome("fixingCompileError"),
      },
      () =>
        runAction({
          action: fixAction,
          adapter,
          workspace,
          model: bound.adapter,
          binding: bound.binding,
          selection: { file: entry, startOffset: 0, endOffset: 0 },
          params: {
            warnings: formatWarningsForFix(
              targets.map((i) => current.findings[i] as Warning),
            ),
          },
        }),
    );
    recordUsage({ ...result.usage, model: bound.binding.model });
    const proposal = result.proposals?.[0];
    if (!proposal) {
      const message = chrome("noFixProduced");
      void vscode.window.showWarningMessage(message);
      return { status: "no_fix", message };
    }
    const virtualUri = await openProposalDiff({
      realUri,
      documentText,
      proposal,
      onRetry: () => {
        void vscode.window.showInformationMessage(
          chrome("retryUnavailableCompileFix"),
        );
        return Promise.resolve();
      },
      actionName: FIX_ACTION_NAME,
    });
    // Remember exactly what we routed into the diff, so the Accept event flips
    // these findings (this compile generation) and nothing else.
    pendingFixes.set(realUri.toString(), {
      compile: current,
      indices: targets,
    });
    return { status: "proposed", virtualUri };
  } catch (error) {
    const message = `Lemmaria: the fix failed — ${(error as Error).message}`;
    void vscode.window.showErrorMessage(message);
    return { status: "error", message };
  }
}

/** Fix one finding (a Compile tab row's Fix button). */
function fixFinding(index: number): Promise<FixOutcome> {
  return proposeFix([index]);
}

/** Fix every finding still pending (the tab's Fix all button) — ONE proposal
 *  carrying every pending finding up to MAX_FIX_WARNINGS, so the user reviews
 *  one diff and only rows the model actually saw can flip to fixed. */
function fixAllFindings(): Promise<FixOutcome> {
  if (state === undefined) {
    return Promise.resolve({
      status: "no_compile",
      message: "run Lemmaria: Compile Check first",
    });
  }
  return proposeFix(state.findings.map((_w, i) => i));
}

async function revealFinding(index: number): Promise<void> {
  if (state === undefined) return;
  const w = state.findings[index];
  if (!w) return;
  const doc = await vscode.workspace.openTextDocument(state.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  // A finding the compiler gave no line for reveals line 0 rather than throwing.
  const line = Math.min(Math.max((w.line ?? 1) - 1, 0), doc.lineCount - 1);
  const range = doc.lineAt(line).range;
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

export function registerCompile(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): void {
  extContext = context;
  loadedActions = actions;
  context.subscriptions.push(
    // All four commands address a finding by its index in the last Compile
    // Check — the Compile tab's rows (and tests) pass CompileFindingInfo.index.
    vscode.commands.registerCommand("lemmaria.revealFinding", (index) =>
      revealFinding(typeof index === "number" ? index : -1),
    ),
    vscode.commands.registerCommand("lemmaria.fixFinding", (index) =>
      fixFinding(typeof index === "number" ? index : -1),
    ),
    vscode.commands.registerCommand("lemmaria.fixAllFindings", () =>
      fixAllFindings(),
    ),
    vscode.commands.registerCommand("lemmaria.ignoreFinding", (index) =>
      ignoreFinding(typeof index === "number" ? index : -1),
    ),
    // When a fix's diff is Accepted, flip its rows to fixed (folded away). This
    // is the LAST step: nothing re-compiles — the user asks when they choose to.
    onProposalAccepted.event((e) => markFixedFromProposal(e)),
  );
}
