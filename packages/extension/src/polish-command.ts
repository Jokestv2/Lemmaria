import { loadAdapterFor } from "@lemmaria/adapters";
import type { LoadedAction } from "@lemmaria/harness";
import { runAction } from "@lemmaria/harness";
import * as vscode from "vscode";
import {
  type ActionTarget,
  actionLabel,
  captureTarget,
  ceilingsFromSettings,
  loadMemoryInput,
  prepareWorkspace,
  promptParameters,
} from "./action-run";
import { type ChromeKey, tr } from "./chrome-strings";
import { recordUsage } from "./cost-ui";
import { openProposalDiff } from "./diff-review";
import { currentLocale } from "./i18n";
import { getModel } from "./model";
import { offerPaperMdOnce } from "./paper-md";
import { QUICK_ACTION_COMMAND, QUICK_ACTION_ORDER } from "./quick-actions";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

export interface ActionOutcome {
  status:
    | "proposed"
    | "no_proposal"
    | "not_latex"
    | "not_configured"
    | "cancelled"
    | "error";
  message?: string;
  virtualUri?: vscode.Uri;
}

/**
 * The built-in edit actions surfaced as editor commands, IN DISPLAY ORDER.
 *
 * Derived from `quick-actions.ts`, which is the one home for that order (D4 /
 * QA-2). `computeInitState` iterates these keys to build the tiles, so the
 * insertion order below is the tile order — which is why it is built from the
 * list rather than written out again.
 */
export const ACTION_COMMAND_BY_ID: Record<string, string> = Object.fromEntries(
  QUICK_ACTION_ORDER.map((id) => [id, QUICK_ACTION_COMMAND[id]]),
);

export function registerQuickActionCommands(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): void {
  for (const [actionId, command] of Object.entries(ACTION_COMMAND_BY_ID)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        command,
        async (): Promise<ActionOutcome> => {
          const editor = vscode.window.activeTextEditor;
          if (
            !editor ||
            editor.document.uri.scheme !== "file" ||
            !/\.(tex|md)$/i.test(editor.document.fileName)
          ) {
            const message = chrome("needsProseFile");
            void vscode.window.showWarningMessage(message);
            return { status: "not_latex", message };
          }
          const loaded = actions.find((a) => a.definition.id === actionId);
          if (!loaded) {
            return {
              status: "error",
              message: `built-in action ${actionId} missing`,
            };
          }
          // Prompt parameters BEFORE snapshotting the target (the input boxes
          // steal focus, but the selection is captured right after).
          const params = await promptParameters(loaded.definition);
          if (params === undefined) return { status: "cancelled" };
          const target = captureTarget(editor);
          return runEditAction(context, loaded, target, params);
        },
      ),
    );
  }
}

// U1's runComposerEdit (composer → polish + userFeedback) was removed at A0:
// the composer now enters a conversational session (ADR 0014, session-host.ts).
// The Retry-with-note path below still carries userFeedback for quick actions.

async function runEditAction(
  context: vscode.ExtensionContext,
  loaded: LoadedAction,
  target: ActionTarget,
  params: Record<string, unknown>,
  userFeedback?: string,
): Promise<ActionOutcome> {
  const def = loaded.definition;
  const bound = await getModel(context.secrets);
  if (!bound) {
    const message = chrome("needsModel");
    void vscode.window.showWarningMessage(message);
    return { status: "not_configured", message };
  }

  const { doc } = target;

  // Retry staleness guard: if the captured span no longer matches the live
  // buffer, re-running on the old snapshot would produce a proposal the anchor
  // check can never accept — refuse early with a clear message instead.
  if (userFeedback !== undefined) {
    const liveSpan = doc.getText(
      new vscode.Range(
        doc.positionAt(target.startOffset),
        doc.positionAt(target.endOffset),
      ),
    );
    if (liveSpan !== target.text.slice(target.startOffset, target.endOffset)) {
      const message = chrome("staleForAction");
      void vscode.window.showWarningMessage(message);
      return { status: "error", message };
    }
  }

  const { entry, workspace } = await prepareWorkspace(doc, target.text);

  const memory = await loadMemoryInput(workspace, entry);
  // CM1 first-use offer: no project PAPER.md yet → offer to draft one, once.
  if (memory.project === undefined) offerPaperMdOnce(context);

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Lemmaria: ${actionLabel(def)}…`,
      },
      async () => {
        const adapter = await loadAdapterFor(workspace, entry);
        return runAction({
          action: def,
          adapter,
          workspace,
          model: bound.adapter,
          binding: bound.binding,
          selection: {
            file: entry,
            startOffset: target.startOffset,
            endOffset: target.endOffset,
          },
          params,
          ceilings: ceilingsFromSettings(),
          memory,
          ...(userFeedback !== undefined ? { userFeedback } : {}),
        });
      },
    );
    recordUsage({ ...result.usage, model: bound.binding.model });

    const proposal = result.proposals?.[0];
    if (!proposal) {
      const reasons = result.validators
        .filter((v) => !v.pass)
        .map((v) => `${v.type}: ${v.reason ?? "failed"}`)
        .join("; ");
      const message = `Lemmaria: no usable proposal (stopped by ${
        result.stoppedBy ?? "?"
      }${reasons ? `; ${reasons}` : ""}).`;
      void vscode.window.showWarningMessage(message);
      return { status: "no_proposal", message };
    }

    // A soft validator (e.g. shrink's word_count) may have missed even though a
    // proposal was emitted — the closest attempt. Surface it as a note, not an
    // error, so the user can Accept it or Retry with guidance.
    const notes = result.validators
      .filter((v) => !v.pass)
      .map((v) => v.reason ?? v.type);
    if (notes.length > 0) {
      void vscode.window.showInformationMessage(
        `Lemmaria: ${actionLabel(def)} — ${chrome("closestAttempt")} (${notes.join("; ")})`,
      );
    }

    const virtualUri = await openProposalDiff({
      realUri: doc.uri,
      documentText: target.text,
      proposal,
      onRetry: (note) => runEditAction(context, loaded, target, params, note),
      actionName: def.name,
    });
    return { status: "proposed", virtualUri };
  } catch (error) {
    const message = `Lemmaria: ${actionLabel(def)} failed — ${(error as Error).message}`;
    void vscode.window.showErrorMessage(message);
    return { status: "error", message };
  }
}
