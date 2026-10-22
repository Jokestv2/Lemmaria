/**
 * The shared Workspace.listFiles spec (M8): both hosts (FsWorkspace,
 * VscodeWorkspace) walk the project with these filters so grep_project and the
 * list_* tools never wade through VCS internals or build artifacts. The glob
 * support is a deliberate M8 subset — `*.ext` / `**​/*.ext` suffix filters, not
 * a glob engine (recorded in progress.md).
 */

import { isAbsolute, normalize } from "node:path";
import type { Workspace } from "../contracts/adapters.js";

/**
 * Root containment for the Workspace port. Model-supplied `file` arguments
 * (read_span, replace_anchor's `file` field) reach `Workspace.readFile`, so
 * the port must refuse any path that resolves outside the workspace root —
 * otherwise the named-tool allowlist (invariant 2) leaks through path
 * arguments (e.g. a prompt-injected "read ../../.ssh/id_rsa"). Every host
 * implementation calls this before touching its filesystem; the harness also
 * calls it where model-controlled paths enter (tools.ts).
 */
export function assertWorkspaceRelative(relPath: string): string {
  const norm = normalize(relPath);
  if (
    isAbsolute(norm) ||
    /^[a-zA-Z]:/.test(norm) || // windows drive path, even on a posix host
    norm.startsWith("\\") || // UNC/rooted windows path, even on a posix host
    norm === ".." ||
    norm.startsWith("../") ||
    norm.startsWith("..\\")
  ) {
    throw new Error(`path escapes the workspace root: ${relPath}`);
  }
  return relPath;
}

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".vscode-test",
  "dist",
  "out",
  "build",
]);

/** Directories the project walk never descends into (artifacts + any dot-dir). */
export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/** How many candidates `discoverPaperEntry` will open before giving up. */
const ENTRY_PROBE_LIMIT = 25;

// The comparator lives in its own zero-import module so the webview can reach
// it through a narrow subpath export without dragging the package barrel — and
// therefore the model adapters and `node:fs` — into a browser bundle. Re-exported
// here so the barrel still carries it and `discoverPaperEntry` below uses the
// same function the `@` menu does, rather than a copy kept in step by hand.
export { byShallowest } from "./path-order.js";
import { byShallowest } from "./path-order.js";

/**
 * The paper a session should read when the user has not focused one.
 *
 * The session's read tools used to be built ONLY from the active `.tex`/`.md`
 * editor, while the write root already fell back to the workspace folder
 * (ADR 0018) — so a window where no paper had been focused yet gave the agent
 * a write path and no read path, and it reached for `propose_edit` to do a
 * read (D4 manual round). This closes that asymmetry: reads and writes now
 * resolve to the same folder.
 *
 * LaTeX first and by `\documentclass`, not by filename: only the main document
 * declares the class, which is what `detectDocumentClass` already relies on. A
 * plain source-text scan is deliberate — the same choice, for the same reason,
 * as `detectBibliographyStyle`: discovery must not depend on the adapters
 * package, which sits above the harness. Shallowest wins, so a vendored
 * template's sample file never beats the project's own root, and the probe is
 * bounded so a huge repository cannot make task start slow.
 *
 * Returns a workspace-relative path, or `undefined` for a folder with no paper
 * in it — the caller then degrades honestly rather than inventing an entry.
 */
export async function discoverPaperEntry(
  workspace: Pick<Workspace, "listFiles" | "readFile">,
): Promise<string | undefined> {
  const tex = (await workspace.listFiles("*.tex")).sort(byShallowest);
  for (const file of tex.slice(0, ENTRY_PROBE_LIMIT)) {
    let source: string;
    try {
      source = await workspace.readFile(file);
    } catch {
      continue; // unreadable candidate — never fail discovery over one file
    }
    if (/^[^%\n]*\\documentclass/m.test(source)) return file;
  }
  if (tex[0] !== undefined) return tex[0];
  // No LaTeX: Markdown, with README and PAPER.md last — the first documents
  // the project and the second is Lemmaria's OWN CM1 memory file, so neither is
  // the paper being written, but either may be the only Markdown there is.
  const md = (await workspace.listFiles("*.md")).sort(byShallowest);
  const papers = md.filter((f) => !/(^|\/)(readme|paper)\.md$/i.test(f));
  return papers[0] ?? md[0];
}

/**
 * Every file that could be a main entry, shallowest first (ADR 0062 §2).
 *
 * A LaTeX project routinely holds more than one standalone document — the
 * paper, its supplementary, a rebuttal — and `discoverPaperEntry` above picks
 * exactly one of them. This is the SET it picked from, so a user asked to
 * choose is offered what discovery was choosing between, never a different
 * list kept in step by hand: same probe (`\documentclass` over `*.tex`), same
 * ordering, same Markdown fallback — except that the fallback here keeps
 * README and PAPER.md, for the reason given at it below.
 *
 * Unbounded, unlike `discoverPaperEntry`: the probe limit exists so task START
 * cannot be slow, and this runs only when a human opened a picker.
 */
export async function paperEntryCandidates(
  workspace: Pick<Workspace, "listFiles" | "readFile">,
): Promise<string[]> {
  const tex = (await workspace.listFiles("*.tex")).sort(byShallowest);
  const out: string[] = [];
  for (const file of tex) {
    let source: string;
    try {
      source = await workspace.readFile(file);
    } catch {
      continue; // unreadable candidate — never fail the list over one file
    }
    if (/^[^%\n]*\\documentclass/m.test(source)) out.push(file);
  }
  if (out.length > 0) return out;
  // EVERY Markdown file, README and PAPER.md included. Discovery drops those
  // two because it has to guess and they are usually not the paper; a picker
  // is not guessing, and refusing to offer a file the user is telling us is
  // their paper would be the heuristic overruling the human.
  return (await workspace.listFiles("*.md")).sort(byShallowest);
}

/** No glob ⇒ match all; otherwise a case-insensitive suffix filter on the
 *  segment after the last `*` (covers `*.ext` and `**​/*.ext`). */
export function matchesFileGlob(relPath: string, glob?: string): boolean {
  if (glob === undefined || glob === "") return true;
  const star = glob.lastIndexOf("*");
  const suffix = star >= 0 ? glob.slice(star + 1) : glob;
  return relPath.toLowerCase().endsWith(suffix.toLowerCase());
}
