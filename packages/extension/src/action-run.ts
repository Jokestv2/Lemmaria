/**
 * Shared plumbing for commands that run harness actions on the active editor
 * (quick actions, review): target snapshot, workspace + working-copy staging,
 * CM1 memory layers, budget ceilings, parameter prompts. Extracted from
 * polish-command.ts at M9 so the review command reuses one tested path.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  ActionDefinition,
  BudgetCeilings,
  MemoryInput,
} from "@lemmaria/harness";
import { directoryPaperCandidates } from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale, localeLabel } from "./i18n";
import { VscodeWorkspace } from "./workspace";

/** Captured synchronously at invocation so Retry re-runs the same target even
 *  though the diff tab has stolen activeTextEditor by then, and so the engine,
 *  the preview splice, and the selection offsets all see ONE snapshot of the
 *  document even if the user types during the model run. */
export interface ActionTarget {
  doc: vscode.TextDocument;
  startOffset: number;
  endOffset: number;
  /** Full document text at capture time — the snapshot everything refers to. */
  text: string;
}

export function captureTarget(editor: vscode.TextEditor): ActionTarget {
  return {
    doc: editor.document,
    startOffset: editor.document.offsetAt(editor.selection.start),
    endOffset: editor.document.offsetAt(editor.selection.end),
    text: editor.document.getText(),
  };
}

export function ceilingsFromSettings(): Partial<BudgetCeilings> {
  const cfg = vscode.workspace.getConfiguration("lemmaria.budget");
  return {
    maxTokens: cfg.get<number>("maxTokens", 16000),
    maxIterations: cfg.get<number>("maxIterations", 8),
    maxRetrieval: cfg.get<number>("maxRetrieval", 10),
    maxFanOut: cfg.get<number>("maxFanOut", 3),
  };
}

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * An action's display name in the READER's language (D4).
 *
 * It used to be `def.name.en ?? def.name.zh ?? def.id` — English-only, so every
 * progress title and quick-action toast in a Chinese editor named the action in
 * English while the CodeLens row beside it named it in Chinese. `localeLabel`
 * is the same seam the lens and the tiles already use.
 */
export function actionLabel(def: ActionDefinition): string {
  return localeLabel(def.name, def.id);
}

/** A quick-pick row for one enum value: what the user reads, and what is sent. */
export interface EnumPickItem extends vscode.QuickPickItem {
  /** The raw enum VALUE. `engine/params.ts` validates against `enum`
   *  membership, so a label sent in its place would be rejected. */
  value: string;
}

/**
 * The rows an enum parameter's picker offers (D4 / QA-3, ADR 0041).
 *
 * `target_language: [en, zh]` made the user choose between the strings "en" and
 * "zh". `enum_labels` gives each value a display name per locale; a value with
 * no entry falls back to the value itself, so a partial map degrades the picker
 * rather than breaking the action. The raw value is kept in `description` as
 * well as in `value`, because it is what ends up in the prompt and a user
 * writing a local action benefits from seeing the binding.
 *
 * Pure and exported so the mapping is asserted without driving a quick pick.
 */
export function enumPickItems(
  param: NonNullable<ActionDefinition["parameters"]>[number],
  locale: "en" | "zh",
): EnumPickItem[] {
  return (param.enum ?? []).map((raw) => {
    const value = String(raw);
    const label = param.enum_labels?.[value];
    const display =
      (locale === "zh" ? (label?.zh ?? label?.en) : (label?.en ?? label?.zh)) ??
      value;
    return display === value
      ? { label: display, value }
      : { label: display, description: value, value };
  });
}

/**
 * Prompt for the action's `prompt_on_invoke` parameters (e.g. shrink's target,
 * translate's target language). Returns undefined if the user cancels any prompt.
 * Parameters without `prompt_on_invoke` keep their schema defaults (applied by
 * the engine), so they are not prompted here.
 */
export async function promptParameters(
  def: ActionDefinition,
): Promise<Record<string, unknown> | undefined> {
  const params: Record<string, unknown> = {};
  for (const p of def.parameters ?? []) {
    if (!p.prompt_on_invoke) continue;
    const label = localeLabel(p.name, p.id);
    if (p.type === "enum" && Array.isArray(p.enum)) {
      const items = enumPickItems(p, currentLocale());
      const pick = await vscode.window.showQuickPick(items, {
        title: `Lemmaria: ${label}`,
        placeHolder: label,
      });
      if (pick === undefined) return undefined;
      params[p.id] = pick.value;
    } else if (p.type === "boolean") {
      const pick = await vscode.window.showQuickPick(["true", "false"], {
        title: `Lemmaria: ${label}`,
        placeHolder: label,
      });
      if (pick === undefined) return undefined;
      params[p.id] = pick === "true";
    } else if (p.type === "integer" || p.type === "number") {
      const input = await vscode.window.showInputBox({
        title: `Lemmaria: ${label}`,
        prompt: label,
        validateInput: (value) => {
          const n = Number(value);
          if (value.trim() === "" || Number.isNaN(n))
            return chrome("paramEnterNumber");
          if (p.type === "integer" && !Number.isInteger(n))
            return chrome("paramEnterWholeNumber");
          if (p.min !== undefined && n < p.min)
            return `${chrome("paramAtLeast")} ${p.min}`;
          if (p.max !== undefined && n > p.max)
            return `${chrome("paramAtMost")} ${p.max}`;
          return undefined;
        },
      });
      if (input === undefined) return undefined;
      params[p.id] = Number(input);
    } else {
      const input = await vscode.window.showInputBox({
        title: `Lemmaria: ${label}`,
        prompt: label,
      });
      if (input === undefined) return undefined;
      params[p.id] = input;
    }
  }
  return params;
}

/**
 * Resolve the project root + entry for a document and stage the captured
 * snapshot as the working copy, pinning the engine's view (ADR 0002 layer
 * order) so a user typing during the model run cannot skew offsets or the
 * preview. M4 simplification (recorded): the entry file is the active file.
 */
export async function prepareWorkspace(
  doc: vscode.TextDocument,
  targetText: string,
): Promise<{ root: string; entry: string; workspace: VscodeWorkspace }> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const root = folder ? folder.uri.fsPath : path.dirname(doc.uri.fsPath);
  const entry = path.relative(root, doc.uri.fsPath).replaceAll("\\", "/");
  const workspace = new VscodeWorkspace(root, entry);
  await workspace.writeWorkingCopy(entry, targetText);
  return { root, entry, workspace };
}

async function tryReadWorkspace(
  workspace: VscodeWorkspace,
  relPath: string,
): Promise<string | undefined> {
  try {
    return await workspace.readFile(relPath);
  } catch {
    return undefined;
  }
}

/**
 * CM1 layer loading (M8), mirroring the CLI's loadMemoryInput: the user-global
 * `~/.lemmaria/MEMORY.md` (Node fs — outside the workspace), the project
 * PAPER.md, and the nearest directory-level PAPER.md between the entry file
 * and the root (through the workspace, so staged working copies are honored).
 */
export async function loadMemoryInput(
  workspace: VscodeWorkspace,
  entry: string,
): Promise<MemoryInput> {
  let global: string | undefined;
  try {
    global = await readFile(
      path.join(
        process.env.LEMMARIA_MEMORY_DIR ?? path.join(homedir(), ".lemmaria"),
        "MEMORY.md",
      ),
      "utf8",
    );
  } catch {
    global = undefined;
  }
  const project = await tryReadWorkspace(workspace, "PAPER.md");
  let directory: string | undefined;
  for (const candidate of directoryPaperCandidates(entry)) {
    directory = await tryReadWorkspace(workspace, candidate);
    if (directory !== undefined) break;
  }
  return {
    ...(global !== undefined ? { global } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(directory !== undefined ? { directory } : {}),
  };
}
