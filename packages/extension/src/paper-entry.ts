/**
 * Which file is the paper's main entry (R3 gate-review round; ADR 0062 §2).
 *
 * A LaTeX project routinely holds MORE THAN ONE standalone document — the
 * paper, its supplementary, a rebuttal — each with its own `\documentclass`
 * and its own `\input`s. `discoverPaperEntry` picks the shallowest one that
 * declares a class, which is a good guess and only a guess; and a blind panel
 * briefed on the wrong one reviews the wrong document.
 *
 * So the guess becomes overridable: `lemmaria.paperEntry` names the entry, and
 * `lemmaria.selectPaperEntry` fills it in from the candidates actually present.
 * With the setting empty NOTHING changes — every path below falls through to
 * exactly what it did before.
 */

import * as path from "node:path";
import { discoverPaperEntry, paperEntryCandidates } from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import { paperInContext, sessionEditRoot } from "./session/registry";
import { VscodeWorkspace } from "./workspace";

const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * The root every path in this file is relative to: `sessionEditRoot()`.
 *
 * NOT `workspaceFolders[0]`. In a multi-root workspace — `thesis/` beside
 * `notes/` — folder[0] is not necessarily the folder holding the paper, and
 * rooting discovery there would brief the panel on the wrong project's
 * document. `sessionEditRoot()` is already this codebase's answer to that
 * question (the focused paper's own folder, falling back to folder[0] only
 * when there is no paper at all), and it is the answer for the same recorded
 * reason: registry.ts's round-2 review C1 found that taking folder[0] first
 * made the write root diverge from the read root.
 *
 * Note what this does and does not follow. The *folder* comes from focus; the
 * *entry within it* deliberately does not — see `reviewPaperEntry` below.
 */
function entryRoot(): string | undefined {
  return sessionEditRoot();
}

/** Normalize a user-typed path the way every workspace-relative path in this
 *  codebase is normalized: forward slashes, no leading `./`, trimmed. */
function normalize(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * The entry the user CHOSE, when they chose one that is still there.
 *
 * Verified against the disk on every read rather than cached: a setting that
 * names a file which has since been renamed must degrade to discovery, not
 * make `/review` refuse with `review.no_manuscript` over a stale string.
 */
export async function configuredPaperEntry(): Promise<
  { root: string; entry: string } | undefined
> {
  const raw = vscode.workspace
    .getConfiguration("lemmaria")
    .get<string>("paperEntry", "");
  const entry = normalize(raw ?? "");
  if (entry === "") return undefined;
  const root = entryRoot();
  if (root === undefined) return undefined;
  // Containment: a configured entry names a file INSIDE the workspace. `..`
  // is not a paper the user opened this folder to write.
  const resolved = path.resolve(root, entry);
  const rel = path.relative(root, resolved).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel))
    return undefined;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
  } catch {
    return undefined; // renamed, deleted, or never existed
  }
  return { root, entry: rel };
}

/**
 * The compiled PDF the user NAMED, when they named one that is still there
 * (V3, ADR 0080 §8).
 *
 * `configuredPaperEntry`'s rule, applied to a second setting: normalised,
 * root-contained, and verified against the disk on every read rather than
 * cached — a setting naming a PDF that has since been renamed must degrade to
 * discovery, not send the review after a path that is not there.
 *
 * Returns the ROOT-RELATIVE path, which is what the policy takes. With the
 * setting empty nothing changes at all.
 */
export async function configuredPaperPdf(): Promise<string | undefined> {
  const raw = vscode.workspace
    .getConfiguration("lemmaria")
    .get<string>("paperPdf", "");
  const pdf = normalize(raw ?? "");
  if (pdf === "") return undefined;
  const root = entryRoot();
  if (root === undefined) return undefined;
  const resolved = path.resolve(root, pdf);
  const rel = path.relative(root, resolved).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel))
    return undefined;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
  } catch {
    return undefined; // renamed, deleted, or never existed
  }
  return rel;
}

/**
 * The manuscript a `/review` panel reads.
 *
 * **Discovery outranks focus here, and only here** — which is the whole point.
 * `paperInContext()` treats the focused `.tex` as the paper, and for the
 * session's read/write registry that is right: the user is working in the file
 * they are looking at. But a panel reviews the WHOLE manuscript, and the entry
 * it is briefed with is what tells the seats where the document begins — so
 * having `sections/intro.tex` open must not make three reviewers believe the
 * paper starts there.
 *
 * What follows focus is the FOLDER, not the file: discovery runs under
 * `entryRoot()`, so a multi-root workspace looks in the project the user is
 * actually in rather than in `workspaceFolders[0]`. Within that folder the
 * focused file carries no weight at all.
 *
 * Order: the user's own choice, then the project's own entry, then whatever
 * `paperInContext()` can offer — which is now only the window with no folder
 * AND no focused paper, since `entryRoot()` gives a focused file's own
 * directory something to discover within.
 */
export async function reviewPaperEntry(): Promise<
  { root: string; entry: string } | undefined
> {
  const chosen = await configuredPaperEntry();
  if (chosen) return chosen;
  const root = entryRoot();
  if (root !== undefined) {
    try {
      const entry = await discoverPaperEntry(new VscodeWorkspace(root));
      if (entry !== undefined) return { root, entry };
    } catch {
      // An unreadable folder is not a crash — fall through to the context.
    }
  }
  return paperInContext();
}

/**
 * `Lemmaria: Select Paper Entry` — pick which document `/review` reads.
 *
 * Writes the WORKSPACE setting, not the user one: which file is the paper is a
 * fact about this project, and carrying it to the next folder would be wrong.
 * The first row clears the setting and returns to detection, so the choice is
 * always reversible from the same place it was made.
 */
async function selectPaperEntry(): Promise<string | undefined> {
  // The gate is a real workspace folder, not `entryRoot()`: the choice is
  // written at `ConfigurationTarget.Workspace`, which throws when none is
  // open. Where to LOOK is still the entry root.
  const root =
    (vscode.workspace.workspaceFolders?.length ?? 0) === 0
      ? undefined
      : entryRoot();
  if (root === undefined) {
    void vscode.window.showWarningMessage(chrome("entryNeedsFolder"));
    return undefined;
  }
  const candidates = await paperEntryCandidates(new VscodeWorkspace(root));
  const current = normalize(
    vscode.workspace
      .getConfiguration("lemmaria")
      .get<string>("paperEntry", "") ?? "",
  );
  const detected = await discoverPaperEntry(new VscodeWorkspace(root)).catch(
    () => undefined,
  );
  const auto: vscode.QuickPickItem = {
    label: chrome("entryAuto"),
    description:
      detected === undefined ? chrome("entryNoneFound") : `→ ${detected}`,
    picked: current === "",
  };
  const rows: vscode.QuickPickItem[] = [
    auto,
    ...candidates.map((file) => ({
      label: file,
      ...(file === current ? { description: chrome("entryCurrent") } : {}),
    })),
  ];
  const choice = await vscode.window.showQuickPick(rows, {
    title: chrome("entryPickTitle"),
    placeHolder: chrome("entryPickPlaceholder"),
  });
  if (choice === undefined) return undefined; // dismissed — change nothing
  const next = choice === rows[0] ? "" : choice.label;
  await vscode.workspace
    .getConfiguration("lemmaria")
    .update("paperEntry", next, vscode.ConfigurationTarget.Workspace);
  return next;
}

export function registerPaperEntry(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("lemmaria.selectPaperEntry", () =>
      selectPaperEntry(),
    ),
  );
}
