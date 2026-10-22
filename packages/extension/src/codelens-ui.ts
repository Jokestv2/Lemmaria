/**
 * U6 — the CodeLens action bar over the live selection (mockup:
 * Lemmaria.dc.html:135-146, "native command-link row anchored above the
 * block").
 *
 * A thin trigger over the existing quick-action commands (the S1 finding):
 * nothing here runs an action itself. S1's "CodeLens needs diffEditor.codeLens"
 * caveat is specific to the DIFF editor — this provider is over the normal
 * editor, where lenses always render, so it is a primary surface.
 */
import type { LoadedAction } from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentLocale, localeLabel } from "./i18n";
import { ACTION_COMMAND_BY_ID } from "./polish-command";
import { QUICK_ACTION_ORDER } from "./quick-actions";

/** Shell actions have no definition to read a name from (U1's SHELLS table), so
 *  their bilingual names live here — invariant 6 applies to them too.
 *
 *  EMPTY since A5: `expand` was the last entry and now ships as a real action
 *  (expand.yaml). Kept as the mechanism, not deleted, because the row order
 *  above may again name an action before it exists — a shell entry is how that
 *  stays honest. */
const SHELL_NAME: Record<string, { en: string; zh: string } | undefined> = {};

const PAPER = /\.(tex|md)$/i;

const onDidChangeEmitter = new vscode.EventEmitter<void>();
let debounce: NodeJS.Timeout | undefined;

/** Re-fire the lens pull (debounced — selection changes are chatty). */
function scheduleRefresh(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => onDidChangeEmitter.fire(), 120);
}

class SelectionActionBar implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = onDidChangeEmitter.event;

  constructor(private readonly actions: LoadedAction[]) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
      return [];
    }
    if (document.uri.scheme !== "file" || !PAPER.test(document.uri.fsPath)) {
      return [];
    }
    // D4: the bar is a selection affordance (U1's tiles enable the same way).
    if (editor.selection.isEmpty) return [];

    const line = editor.selection.start.line;
    const range = new vscode.Range(line, 0, line, 0);
    const lens = (command: vscode.Command): vscode.CodeLens =>
      new vscode.CodeLens(range, command);

    // A lens with an empty `command` renders as plain, non-clickable text —
    // the mockup's brand mark is a span, not a button.
    const lenses: vscode.CodeLens[] = [
      lens({ title: "Lemmaria", command: "" }),
    ];

    for (const id of QUICK_ACTION_ORDER) {
      const def = this.actions.find((a) => a.definition.id === id)?.definition;
      const commandId = ACTION_COMMAND_BY_ID[id];
      if (def && commandId) {
        lenses.push(
          lens({
            title: localeLabel(def.name, id),
            command: commandId,
            tooltip: localeLabel(def.description, id),
          }),
        );
        continue;
      }
      // No definition — an honest shell, the CodeLens analogue of U1's disabled
      // tile + its "not available yet" tooltip. (No id is a shell today.)
      //
      // Only for ids KNOWN to be shells: falling back to a shell label for any
      // unresolved id would label a real shipping action (e.g. a polish.yaml
      // that failed to load) as an unbuilt feature. An unknown id renders
      // nothing at all.
      const shell = SHELL_NAME[id];
      if (!shell) continue;
      const label = localeLabel(shell, id);
      lenses.push(
        lens({
          title: label,
          command: "lemmaria.comingSoon",
          tooltip:
            currentLocale() === "zh"
              ? "该功能尚未推出。"
              : "Not available yet.",
          arguments: [label],
        }),
      );
    }

    lenses.push(
      lens({
        title: currentLocale() === "zh" ? "更多…" : "More…",
        command: "lemmaria.moreActions",
      }),
    );
    return lenses;
  }
}

export function registerCodeLens(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      // Match by PATH, not language id: the built-in latex language pack can be
      // absent (e.g. --disable-extensions in the test runner) — the M4 lesson.
      [
        { scheme: "file", pattern: "**/*.tex" },
        { scheme: "file", pattern: "**/*.md" },
      ],
      new SelectionActionBar(actions),
    ),
    onDidChangeEmitter,
    vscode.window.onDidChangeTextEditorSelection(scheduleRefresh),
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.commands.registerCommand("lemmaria.comingSoon", (label?: string) => {
      const zh = currentLocale() === "zh";
      void vscode.window.showInformationMessage(
        zh
          ? `${label ?? "该功能"}——尚未推出。`
          : `${label ?? "This action"} — not available yet.`,
      );
    }),
    vscode.commands.registerCommand("lemmaria.moreActions", () => {
      void vscode.commands.executeCommand(
        "workbench.action.quickOpen",
        ">Lemmaria: ",
      );
    }),
  );
}
