import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { loadLatexAdapter } from "@lemmaria/adapters";
import type { EditProposal, Warning } from "@lemmaria/harness";
import {
  compileStatusLabel,
  planRollback,
  resolveEngine,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { setCompileFindings } from "./compile-ui";
import { onProposalAccepted } from "./diff-review";
import { currentLocale } from "./i18n";
import { VscodeWorkspace, isCompileOverridden } from "./workspace";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * Compile Check (X1, supersedes M5's Verified Edits): the user-invoked compile,
 * its status bar, and its jump-to-source diagnostics. It compiles ONLY when
 * asked — never after an Accept, never on a timer (ADR 0013: compilation is a
 * report the user asks for, not a gate on an edit). The findings list and the
 * Accept-gated per-finding fix live in `compile-ui.ts`. Content-anchored
 * rollback stays here. All heavy lifting is in the harness; this is the thin
 * VS Code adapter over it.
 */

/** Fires after a successful content-anchored rollback — feeds the U5 sidebar. */
export const onEditRolledBack = new vscode.EventEmitter<{ fsPath: string }>();

function locate(uri: vscode.Uri): { root: string; entry: string } {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
  const entry = path.relative(root, uri.fsPath).replaceAll("\\", "/");
  return { root, entry };
}

/** Engine-availability probe override — ext-host tests inject a compile, which
 *  makes the PATH probe moot (see `resolveEngineFor`), so this is the only way
 *  to drive resolveEngine's engine-absent path (its guidance) under test. */
type EngineProbe = (engine: string) => boolean;
let engineProbeOverride: EngineProbe | undefined;
export function setEngineProbeForTests(fn?: EngineProbe): void {
  engineProbeOverride = fn;
}
export function clearEngineProbeForTests(): void {
  engineProbeOverride = undefined;
}

/**
 * The engine Compile Check would use for an entry whose adapter prefers
 * `preferred` — `lemmaria.verify.engine`, probed on PATH (or not, under an
 * injected compile). `guidance` is set exactly when that engine is NOT
 * available. Exported for V4 (ADR 0081 §2): the review's compile resolves the
 * engine the same way, so the PDF a review compiles is the PDF Compile Check
 * would have.
 */
export function resolveCompileEngine(preferred: string[]): {
  engine: string;
  guidance?: string;
} {
  const configEngine = vscode.workspace
    .getConfiguration("lemmaria.verify")
    .get<string>("engine", "auto");
  const available =
    engineProbeOverride ??
    (isCompileOverridden() ? (): boolean => true : binaryExists);
  return resolveEngine({
    configEngine,
    preferred,
    available,
    locale: currentLocale(),
  });
}

/** Does the engine's driver binary exist on PATH? (latexmk drives pdf/xe/lua.)
 *  Shared with venue-ui's baseline compile (M10). */
export function binaryExists(engine: string): boolean {
  const bin = engine === "tectonic" ? "tectonic" : "latexmk";
  try {
    return (
      spawnSync(bin, ["--version"], { stdio: "ignore" }).error === undefined
    );
  } catch {
    return false;
  }
}

/**
 * Locate a content anchor for rollback: prefer the accepted edit's own offset
 * (fast path when nothing shifted), else a single unambiguous occurrence.
 * Returns the start offset, or `{ ambiguous }` / null so the caller can refuse
 * rather than revert the wrong hunk (a repeated phrase) or an empty match.
 */
function locateAnchor(
  text: string,
  anchor: string,
  preferredOffset: number,
): { offset: number } | { ambiguous: true } | null {
  if (anchor.length === 0) return null; // an empty edit has no content to anchor to
  if (text.slice(preferredOffset, preferredOffset + anchor.length) === anchor) {
    return { offset: preferredOffset };
  }
  const first = text.indexOf(anchor);
  if (first < 0) return null;
  if (text.indexOf(anchor, first + 1) !== -1) return { ambiguous: true };
  return { offset: first };
}

function severityOf(w: Warning): vscode.DiagnosticSeverity {
  if (w.severity === "error") return vscode.DiagnosticSeverity.Error;
  if (w.severity === "info") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

/** How a long operation is shown. Real `withProgress` in production; the seam
 *  exists so a test can assert HOW Compile Check is wrapped rather than that a
 *  mock was called — the same shape as `setCompileForTests` in `workspace.ts`. */
export type ProgressRunner = <T>(
  options: vscode.ProgressOptions,
  task: () => Promise<T>,
) => Promise<T>;

const defaultProgressRunner: ProgressRunner = async (options, task) =>
  await vscode.window.withProgress(options, task);

let progressRunnerOverride: ProgressRunner | undefined;

/** Test seam (D4 / CHROME-4). Pass undefined to restore the real runner. */
export function setProgressRunnerForTests(runner?: ProgressRunner): void {
  progressRunnerOverride = runner;
}

class VerifyController {
  private readonly status: vscode.StatusBarItem;
  private readonly diagnostics: vscode.DiagnosticCollection;
  /** Last accepted edit per file, for one-click rollback (content-anchored). */
  private readonly lastAccepted = new Map<string, EditProposal>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    // The mockup's verified item is clickable (onClick=openProblems).
    this.status.command = "workbench.actions.view.problems";
    this.diagnostics = vscode.languages.createDiagnosticCollection("lemmaria");
    context.subscriptions.push(this.status, this.diagnostics);
  }

  private setStatus(
    icon: string,
    text: string,
    tooltip: string,
    background?: vscode.ThemeColor,
  ): void {
    this.status.text = `${icon} ${text}`;
    this.status.tooltip = tooltip;
    // A ThemeColor named `statusBarItem.errorBackground` is a BACKGROUND id;
    // assigning it to `color` (a foreground property) rendered nothing like the
    // red pill it intends. Found by D4's code review.
    this.status.backgroundColor = background;
    this.status.show();
  }

  private resolveEngineFor(preferred: string[]): {
    engine: string;
    guidance?: string;
  } {
    return resolveCompileEngine(preferred);
  }

  async runVerify(realUri: vscode.Uri): Promise<void> {
    const runInProgress = progressRunnerOverride ?? defaultProgressRunner;
    const { root, entry } = locate(realUri);
    this.setStatus(
      "$(sync~spin)",
      chrome("compilingShort"),
      chrome("compiling"),
    );

    const probeWs = new VscodeWorkspace(root, entry);
    const probeAdapter = await loadLatexAdapter(probeWs, entry);
    const { engine, guidance } = this.resolveEngineFor(
      probeAdapter.preferredEngines(),
    );

    const workspace = new VscodeWorkspace(root, entry);
    const adapter = await loadLatexAdapter(workspace, entry, {
      workspace,
      engine,
    });
    // CHROME-4: a full LaTeX compile can run for tens of seconds. The
    // status-bar spinner is the ambient signal; this is the foreground one,
    // matching every comparable long operation in the extension.
    //
    // `cancellable: false` is deliberate, not an omission. A cancel is not
    // plumbable without new code at three layers — `LatexAdapter.verify()`
    // takes no arguments, `Workspace.compile(engine)` is a CONTRACT, and the
    // child-process handle lives only inside `runEngine`, whose sole kill path
    // is its 120 s timeout. A button that abandoned the await while latexmk
    // kept burning would say it stopped something it did not, which is the
    // exact defect this milestone removes elsewhere. Recorded in
    // open-questions.md with its real cost.
    const result = await runInProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: chrome("compiling"),
      },
      () => adapter.verify(),
    );
    this.render(realUri, result, guidance);
  }

  private render(
    realUri: vscode.Uri,
    result: { ok: boolean; warnings: Warning[] },
    guidance?: string,
  ): void {
    const findings = result.warnings;
    this.diagnostics.set(
      realUri,
      findings.map((w) => {
        const line = Math.max(0, (w.line ?? 1) - 1);
        const d = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          `${w.code}: ${w.message}`,
          severityOf(w),
        );
        d.source = "Lemmaria";
        return d;
      }),
    );
    // The ONE edge from a compile to the Compile tab (ADR 0013) — the tab lists
    // what this run found and lets the user triage it. There is deliberately no
    // edge back: nothing the tab does re-enters this method.
    setCompileFindings(realUri, findings, result.ok, guidance);
    // CHROME-3: the count is shown on BOTH branches, and the label is a pure
    // harness function so the arithmetic and the locale are asserted offline.
    const label = compileStatusLabel({
      ok: result.ok,
      findingCount: findings.length,
      locale: currentLocale(),
    });
    this.setStatus(
      label.icon,
      label.text,
      label.tooltip,
      result.ok
        ? undefined
        : new vscode.ThemeColor("statusBarItem.errorBackground"),
    );
    if (guidance) {
      void vscode.window.showInformationMessage(`Lemmaria: ${guidance}`);
    }
  }

  recordAccepted(realUri: vscode.Uri, proposal: EditProposal): void {
    this.lastAccepted.set(realUri.fsPath, proposal);
    void vscode.commands.executeCommand(
      "setContext",
      "lemmaria.canRollback",
      true,
    );
  }

  /** Revert the last accepted edit, located by its content anchor (preserves later edits). */
  async rollback(realUri?: vscode.Uri): Promise<boolean> {
    const uri = realUri ?? vscode.window.activeTextEditor?.document.uri;
    const proposal = uri && this.lastAccepted.get(uri.fsPath);
    if (!uri || !proposal) {
      void vscode.window.showWarningMessage(chrome("nothingToRollBack"));
      return false;
    }
    const plan = planRollback(proposal);
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const found = locateAnchor(
      text,
      plan.expectedOriginal,
      proposal.span.startOffset,
    );
    if (found === null) {
      void vscode.window.showWarningMessage(chrome("rollbackTextGone"));
      return false;
    }
    if ("ambiguous" in found) {
      void vscode.window.showWarningMessage(chrome("rollbackTextAmbiguous"));
      return false;
    }
    const idx = found.offset;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        doc.positionAt(idx),
        doc.positionAt(idx + plan.expectedOriginal.length),
      ),
      plan.replacement,
    );
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
      void vscode.window.showErrorMessage(chrome("rollbackSaveFailed"));
      return false;
    }
    this.lastAccepted.delete(uri.fsPath);
    onEditRolledBack.fire({ fsPath: uri.fsPath });
    void vscode.commands.executeCommand(
      "setContext",
      "lemmaria.canRollback",
      false,
    );
    return true;
  }
}

export function registerVerify(context: vscode.ExtensionContext): void {
  const controller = new VerifyController(context);
  context.subscriptions.push(
    onProposalAccepted.event(({ realUri, proposal }) => {
      controller.recordAccepted(realUri, proposal);
    }),
    vscode.commands.registerCommand("lemmaria.verifyNow", (): Promise<void> => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      return uri ? controller.runVerify(uri) : Promise.resolve();
    }),
    vscode.commands.registerCommand(
      "lemmaria.rollbackEdit",
      (arg?: vscode.Uri): Promise<boolean> => controller.rollback(arg),
    ),
  );
}
