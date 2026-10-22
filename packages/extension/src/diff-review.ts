import type { EditProposal } from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

export const PROPOSAL_SCHEME = "lemmaria-proposal";

interface PendingProposal {
  realUri: vscode.Uri;
  proposal: EditProposal;
  proposedContent: string;
  /** Pre-edit full document text: builds `proposedContent` here, and rides the
   *  accept event as `preEditText` for its one consumer — sidebar-ui.ts, which
   *  resolves the edit's line for the history row's jump. Nothing compiles it;
   *  compiling is a report the user asks for (ADR 0013). */
  documentText: string;
  onRetry: (note: string) => Promise<unknown>;
  /** Bilingual name of the originating action, for the U5 sidebar record. */
  actionName?: { en?: string; zh?: string };
}

const pending = new Map<string, PendingProposal>();
const contentChanged = new vscode.EventEmitter<vscode.Uri>();

/**
 * Fires after a proposal is accepted and written. Its five listeners react to
 * the write itself — verify-ui.ts records it for rollback, sidebar-ui.ts logs
 * it, review-ui.ts / compile-ui.ts correlate it back to the finding it came
 * from, and webview-view.ts re-checks an adopted citation key — but none of
 * them compiles. Compiling is a report the user asks for, not something an
 * accepted edit triggers (ADR 0013).
 */
export const onProposalAccepted = new vscode.EventEmitter<{
  realUri: vscode.Uri;
  proposal: EditProposal;
  preEditText: string;
  /** Bilingual name of the originating action (U5 sidebar attribution). */
  actionName?: { en?: string; zh?: string };
}>();

function virtualUriFor(realUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({
    scheme: PROPOSAL_SCHEME,
    path: realUri.path,
    query: realUri.toString(),
  });
}

function updateContextKey(): void {
  void vscode.commands.executeCommand(
    "setContext",
    "lemmaria.hasPendingProposal",
    pending.size > 0,
  );
}

/** Resolve which proposal a command targets: explicit arg, else the active diff tab. */
function resolveVirtualUri(arg?: vscode.Uri): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri && arg.scheme === PROPOSAL_SCHEME) return arg;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    input instanceof vscode.TabInputTextDiff &&
    input.modified.scheme === PROPOSAL_SCHEME
  ) {
    return input.modified;
  }
  return undefined;
}

async function closeDiffTab(virtualUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === virtualUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}

/**
 * Show an EditProposal as a side-by-side diff: real file ⟷ read-only virtual
 * doc with the proposal spliced in. The user's document — buffer and disk —
 * is untouched until Accept (invariant 3; S1 spike outcome). Re-running on the
 * same file replaces the pending proposal and refreshes the same diff tab.
 */
export async function openProposalDiff(opts: {
  realUri: vscode.Uri;
  documentText: string;
  proposal: EditProposal;
  onRetry: (note: string) => Promise<unknown>;
  actionName?: { en?: string; zh?: string };
}): Promise<vscode.Uri> {
  const { realUri, documentText, proposal } = opts;
  const proposedContent =
    documentText.slice(0, proposal.span.startOffset) +
    proposal.replacement +
    documentText.slice(proposal.span.endOffset);
  const virtualUri = virtualUriFor(realUri);
  pending.set(virtualUri.toString(), {
    realUri,
    proposal,
    proposedContent,
    documentText,
    onRetry: opts.onRetry,
    ...(opts.actionName !== undefined ? { actionName: opts.actionName } : {}),
  });
  contentChanged.fire(virtualUri);
  updateContextKey();
  await vscode.commands.executeCommand(
    "vscode.diff",
    realUri,
    virtualUri,
    "Lemmaria: proposed edit (Accept / Reject / Retry)",
    { preview: false },
  );
  return virtualUri;
}

async function acceptProposal(arg?: vscode.Uri): Promise<boolean> {
  const virtualUri = resolveVirtualUri(arg);
  const entry = virtualUri && pending.get(virtualUri.toString());
  if (!virtualUri || !entry) {
    void vscode.window.showWarningMessage(chrome("noProposalToAccept"));
    return false;
  }
  const { realUri, proposal } = entry;
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(realUri);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Lemmaria: cannot open the target file — ${(error as Error).message}`,
    );
    return false;
  }
  const range = new vscode.Range(
    doc.positionAt(proposal.span.startOffset),
    doc.positionAt(proposal.span.endOffset),
  );
  // Content anchor re-check (ADR 0002): never splice blindly by offset.
  if (doc.getText(range) !== proposal.expectedOriginal) {
    void vscode.window.showErrorMessage(chrome("proposalStale"));
    return false;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(realUri, range, proposal.replacement);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(chrome("applyFailed"));
    return false;
  }
  if (!(await doc.save())) {
    // Buffer holds the accepted edit but disk does not (read-only file, disk
    // error). Keep the proposal and the tab so Accept can be retried; undo the
    // buffer edit so "accepted = written" stays true (invariant 3's contract).
    const revert = new vscode.WorkspaceEdit();
    revert.replace(
      realUri,
      new vscode.Range(
        doc.positionAt(proposal.span.startOffset),
        doc.positionAt(proposal.span.startOffset + proposal.replacement.length),
      ),
      proposal.expectedOriginal,
    );
    await vscode.workspace.applyEdit(revert);
    void vscode.window.showErrorMessage(chrome("saveFailed"));
    return false;
  }
  pending.delete(virtualUri.toString());
  updateContextKey();
  await closeDiffTab(virtualUri);
  onProposalAccepted.fire({
    realUri,
    proposal,
    preEditText: entry.documentText,
    ...(entry.actionName !== undefined ? { actionName: entry.actionName } : {}),
  });
  return true;
}

async function retryProposal(arg?: vscode.Uri, note?: unknown): Promise<void> {
  const virtualUri = resolveVirtualUri(arg);
  const entry = virtualUri && pending.get(virtualUri.toString());
  if (!virtualUri || !entry) return;
  // The title-bar "Retry with Note" button invokes this command with the
  // editor URI as the second positional arg, not a string — coerce it away so
  // we fall through to prompting for the note (the button's intended behavior)
  // instead of forwarding a URI as the feedback.
  const preset = typeof note === "string" ? note : undefined;
  const collected =
    preset ??
    (await vscode.window.showInputBox({
      prompt: chrome("retryNotePrompt"),
      ignoreFocusOut: true,
    }));
  if (collected === undefined) return; // user cancelled
  await entry.onRetry(collected);
}

export function registerDiffReview(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Closing the diff tab with the X abandons the proposal — otherwise the
    // pending entry (and the palette's Accept/Reject) would outlive its UI.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.scheme === PROPOSAL_SCHEME
        ) {
          pending.delete(tab.input.modified.toString());
          updateContextKey();
        }
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, {
      onDidChange: contentChanged.event,
      provideTextDocumentContent: (uri) =>
        pending.get(uri.toString())?.proposedContent ?? "",
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: PROPOSAL_SCHEME },
      {
        // Renders only when the user enables diffEditor.codeLens (S1 finding);
        // title-bar buttons + palette are the primary surfaces.
        provideCodeLenses(document) {
          if (!pending.has(document.uri.toString())) return [];
          const top = new vscode.Range(0, 0, 0, 0);
          return [
            new vscode.CodeLens(top, {
              title: `$(check) ${chrome("diffAccept")}`,
              command: "lemmaria.acceptProposal",
              arguments: [document.uri],
            }),
            new vscode.CodeLens(top, {
              title: `$(close) ${chrome("diffReject")}`,
              command: "lemmaria.rejectProposal",
              arguments: [document.uri],
            }),
            new vscode.CodeLens(top, {
              title: `$(refresh) ${chrome("diffRetry")}`,
              command: "lemmaria.retryProposal",
              arguments: [document.uri],
            }),
          ];
        },
      },
    ),
    vscode.commands.registerCommand(
      "lemmaria.acceptProposal",
      (arg?: vscode.Uri): Promise<boolean> => acceptProposal(arg),
    ),
    vscode.commands.registerCommand(
      "lemmaria.rejectProposal",
      async (arg?: vscode.Uri): Promise<void> => {
        const virtualUri = resolveVirtualUri(arg);
        if (!virtualUri) {
          void vscode.window.showWarningMessage(chrome("noProposalToReject"));
          return;
        }
        pending.delete(virtualUri.toString());
        updateContextKey();
        await closeDiffTab(virtualUri);
      },
    ),
    vscode.commands.registerCommand(
      "lemmaria.retryProposal",
      (arg?: vscode.Uri, note?: unknown): Promise<void> =>
        retryProposal(arg, note),
    ),
  );
}
