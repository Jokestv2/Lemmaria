/**
 * A4 (ADR 0019): the grant commands — the explicit folder picker that grants a
 * session read-only access to an external root, the revoke quickpick, and the
 * Semantic Scholar key command (SecretStorage, the model-key convention).
 * State lives in session-host; this file is the palette surface.
 */

import * as vscode from "vscode";
import { currentLocale } from "./i18n";
import {
  S2_KEY_SECRET,
  activeSessionGrants,
  addGrant,
  revokeGrant,
} from "./session-host";

export function registerGrants(context: vscode.ExtensionContext): void {
  const zh = (): boolean => currentLocale() === "zh";

  context.subscriptions.push(
    vscode.commands.registerCommand("lemmaria.grantFolder", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: zh() ? "授权只读访问" : "Grant read-only access",
        title: zh()
          ? "授权本会话只读访问一个文件夹（代码库、结果目录…）"
          : "Grant this session read-only access to a folder (codebase, results dir…)",
      });
      const folder = picked?.[0]?.fsPath;
      if (!folder) return;
      try {
        const grant = await addGrant(context, folder);
        void vscode.window.showInformationMessage(
          zh()
            ? `Lemmaria：已授予只读访问 ${grant.label}（${grant.id}）。随时可撤销。`
            : `Lemmaria: granted read-only access to ${grant.label} (${grant.id}). Revocable anytime.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          zh()
            ? `Lemmaria：无法授权该文件夹——${message}`
            : `Lemmaria: could not grant that folder — ${message}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "lemmaria.revokeGrantedFolder",
      async () => {
        const current = activeSessionGrants();
        if (current.length === 0) {
          void vscode.window.showInformationMessage(
            zh()
              ? "Lemmaria：本会话没有已授权的文件夹。"
              : "Lemmaria: this session has no granted folders.",
          );
          return;
        }
        const pick = await vscode.window.showQuickPick(
          current.map((g) => ({
            label: g.label,
            description: g.id,
            detail: g.path,
            id: g.id,
          })),
          {
            placeHolder: zh()
              ? "撤销哪个文件夹的访问权限？"
              : "Revoke access to which folder?",
          },
        );
        if (pick) await revokeGrant(context, pick.id);
      },
    ),

    vscode.commands.registerCommand(
      "lemmaria.setSemanticScholarKey",
      async () => {
        const key = await vscode.window.showInputBox({
          password: true,
          prompt: zh()
            ? "Semantic Scholar API key（可选，提高文献检索限额；留空以删除）"
            : "Semantic Scholar API key (optional — raises literature-search rate limits; leave empty to remove)",
          placeHolder: zh()
            ? "留空以删除已存的 key"
            : "Empty input removes the stored key",
        });
        if (key === undefined) return; // dismissed
        if (key.trim() === "") {
          await context.secrets.delete(S2_KEY_SECRET);
          void vscode.window.showInformationMessage(
            zh()
              ? "Lemmaria：已删除 Semantic Scholar key。"
              : "Lemmaria: Semantic Scholar key removed.",
          );
          return;
        }
        await context.secrets.store(S2_KEY_SECRET, key.trim());
        void vscode.window.showInformationMessage(
          zh()
            ? "Lemmaria：Semantic Scholar key 已存入 Secret Storage。"
            : "Lemmaria: Semantic Scholar key stored in Secret Storage.",
        );
      },
    ),
  );
}
