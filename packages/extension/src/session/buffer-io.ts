import { dirname } from "node:path";
import * as vscode from "vscode";
import { pathsEqual } from "./session-state";

/**
 * The ONE place that knows an open editor buffer beats the file on disk
 * (the ADR 0002 layering).
 *
 * Extracted at the ADR 0031 fix round because there were two places and only
 * one of them knew it. `buildSessionEditHost` has always routed reads and
 * writes through the open document; `applyRestorePlan` went straight to
 * `node:fs`, so restoring a file the user had open with unsaved changes
 * rewrote the disk correctly and left the stale buffer on screen — over a
 * modal that had just promised the file was restored — with the next save
 * putting the stale text back over it. The comparison is subtle enough
 * (`file` scheme, case-insensitive on win32) that duplicating it is how the
 * two would drift apart again.
 */

/** The open document for a file uri, if VS Code is holding one. */
export function openDocumentFor(
  uri: vscode.Uri,
): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && pathsEqual(d.uri.fsPath, uri.fsPath),
  );
}

/**
 * The file's content as the USER sees it: the open buffer when there is one —
 * unsaved edits included — else the bytes on disk. undefined = no such file.
 *
 * Reading the buffer is what lets a restore's drift check notice a hand edit
 * the user has typed but not yet saved, capture it into the snapshot store,
 * and say so. A disk read sees the pre-edit bytes and reports nothing.
 */
export async function readThroughBuffer(
  uri: vscode.Uri,
): Promise<string | undefined> {
  const open = openDocumentFor(uri);
  if (open) return open.getText();
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
      "utf8",
    );
  } catch {
    return undefined;
  }
}

/**
 * Write content to a file, through its open buffer when it has one.
 *
 * The diff-review write discipline: full-range replace + save, so "written"
 * means on disk (invariant 3) AND the editor shows what was written; a save
 * failure throws rather than reporting a write that did not land.
 */
export async function writeThroughBuffer(
  uri: vscode.Uri,
  content: string,
): Promise<void> {
  const open = openDocumentFor(uri);
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    const whole = new vscode.Range(
      open.positionAt(0),
      open.positionAt(open.getText().length),
    );
    edit.replace(uri, whole, content);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`could not apply edit to ${uri.fsPath}`);
    }
    if (!(await open.save())) {
      throw new Error(`could not save ${uri.fsPath} (read-only?)`);
    }
    return;
  }
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.file(dirname(uri.fsPath)),
  );
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

/**
 * Delete a file, taking its open buffer with it.
 *
 * `WorkspaceEdit.deleteFile` rather than an unlink, precisely because of the
 * open-buffer case: VS Code's own file operation reverts and closes the
 * working copy, where unlinking underneath a dirty editor leaves a buffer that
 * re-creates the file on its next save — the deletion undone by the editor
 * that outlived it.
 *
 * **The fallback is gated on there being NO open document, and that gate is
 * the whole point.** An earlier cut fell back whenever `applyEdit` returned
 * false, which reintroduced the very bug above: `applyEdit` is most likely to
 * fail exactly when a document IS open, so the unlink then ran in the one case
 * `deleteFile` existed to handle. With an open document a failed edit THROWS,
 * so `guardedRestore` reports it and the user is told the file did not go —
 * half a restore is worse than none, and silently doing the wrong thing is
 * worse than both.
 */
export async function deleteThroughBuffer(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri, { ignoreIfNotExists: true });
  if (await vscode.workspace.applyEdit(edit)) return;
  if (openDocumentFor(uri) !== undefined)
    throw new Error(
      `could not delete ${uri.fsPath}: it is open in an editor and the workspace edit was rejected`,
    );
  await vscode.workspace.fs.delete(uri, { useTrash: false });
}
