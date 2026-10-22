import * as path from "node:path";
import { loadAdapterFor } from "@lemmaria/adapters";
import { draftPaperMd } from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import { VscodeWorkspace } from "./workspace";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * CM1 auto-draft (M8): "Lemmaria: Create PAPER.md" scans the active document's
 * structure and writes a draft PAPER.md at the project root for the user to
 * refine. It NEVER overwrites an existing PAPER.md (opens it instead), and only
 * writes on this explicit command / the first-use offer button (invariant 3 —
 * PAPER.md is a new harness-owned file, but user edits to it are sacred).
 */

export interface PaperMdOutcome {
  status: "created" | "opened_existing" | "no_editor" | "error";
  message?: string;
  path?: string;
}

const OFFERED_KEY = "lemmaria.paperMdOffered";

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function createPaperMd(): Promise<PaperMdOutcome> {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    editor.document.uri.scheme !== "file" ||
    !/\.(tex|md)$/i.test(editor.document.fileName)
  ) {
    const message = chrome("paperMdNeedsProseFile");
    void vscode.window.showWarningMessage(message);
    return { status: "no_editor", message };
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const root = folder
    ? folder.uri.fsPath
    : path.dirname(editor.document.uri.fsPath);
  const paperUri = vscode.Uri.file(path.join(root, "PAPER.md"));

  if (await exists(paperUri)) {
    const doc = await vscode.workspace.openTextDocument(paperUri);
    await vscode.window.showTextDocument(doc);
    return { status: "opened_existing", path: paperUri.fsPath };
  }

  try {
    const entry = path
      .relative(root, editor.document.uri.fsPath)
      .replaceAll("\\", "/");
    const workspace = new VscodeWorkspace(root, entry);
    // Adapter picked by extension (M8): a .md paper drafts from its heading
    // tree, a .tex paper from its sectioning structure.
    const adapter = await loadAdapterFor(workspace, entry);
    const outline = await adapter.parseStructure();
    const draft = draftPaperMd({
      title: path.basename(root),
      outline,
      // The template is written into the USER'S repository, so it follows the
      // locale at scaffold time (ADR 0034 Consequences 3) and is theirs from
      // that moment. Without this the zh template is unreachable in production.
      locale: currentLocale(),
    });
    await vscode.workspace.fs.writeFile(paperUri, Buffer.from(draft, "utf8"));
    const doc = await vscode.workspace.openTextDocument(paperUri);
    await vscode.window.showTextDocument(doc);
    return { status: "created", path: paperUri.fsPath };
  } catch (error) {
    const message = `${chrome("paperMdDraftFailed")} — ${(error as Error).message}`;
    void vscode.window.showErrorMessage(message);
    return { status: "error", message };
  }
}

/**
 * First-use offer: after a quick action ran in a project without a PAPER.md,
 * offer (once per workspace) to auto-draft one. Fire-and-forget.
 */
export function offerPaperMdOnce(context: vscode.ExtensionContext): void {
  if (context.workspaceState.get<boolean>(OFFERED_KEY)) return;
  void context.workspaceState.update(OFFERED_KEY, true);
  void vscode.window
    .showInformationMessage(chrome("paperMdOffer"), chrome("paperMdCreate"))
    .then((pick) => {
      if (pick) void vscode.commands.executeCommand("lemmaria.createPaperMd");
    });
}

export function registerPaperMd(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("lemmaria.createPaperMd", createPaperMd),
  );
}
