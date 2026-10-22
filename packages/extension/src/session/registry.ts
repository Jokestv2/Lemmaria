import { dirname, relative } from "node:path";
import { loadAdapterFor, protectedSpansForFile } from "@lemmaria/adapters";
import {
  type LiteratureWithhold,
  type SessionTaskBudget,
  type ToolName,
  buildToolRegistry,
  discoverPaperEntry,
  resolveMemory,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { loadMemoryInput } from "../action-run";
import { VscodeWorkspace } from "../workspace";
import {
  activeSessionGrants,
  literatureProviders,
  sessionLiteratureBudget,
} from "./grants-host";

/**
 * What a task can see and how much it may spend (B1 split of
 * `session-host.ts`): the paper in context, the per-task tool registry built
 * over it, and the user's budget ceilings.
 */

const PAPER = /\.(tex|md)$/i;

/**
 * The last paper the user actually looked at, remembered across focus changes
 * (A1b round 2). VS Code has no "active text editor" while a DIFF, a webview,
 * or a settings tab is focused — and our own "View diff" affordance puts a
 * diff there — so reading `activeTextEditor` at task start made the paper
 * (and with it the whole write path) vanish. Focus is not capability.
 */
let stickyPaper: { root: string; entry: string } | undefined;

function paperOf(
  uri: vscode.Uri | undefined,
): { root: string; entry: string } | undefined {
  if (!uri || uri.scheme !== "file" || !PAPER.test(uri.fsPath))
    return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder ? folder.uri.fsPath : dirname(uri.fsPath);
  const entry = relative(root, uri.fsPath).replaceAll("\\", "/");
  return { root, entry };
}

/** Called from the editor-change listener; also seeds lazily on first use. */
export function noteActivePaper(): void {
  const current = paperOf(vscode.window.activeTextEditor?.document.uri);
  if (current) stickyPaper = current;
}

/** The paper in context: the focused one, else the last one focused. */
function activePaperRoot(): { root: string; entry: string } | undefined {
  noteActivePaper();
  return stickyPaper;
}

/**
 * The root the write path operates over (A1b round 2 — the Codex/Claude Code
 * model): the **workspace folder**, so the agent can edit and create anywhere
 * in the project, not only in whichever file happens to be focused. Falls back
 * to the sticky paper's folder for a single-file window. The open editor is
 * *context*, never the boundary. (Roots OUTSIDE the workspace stay an A4
 * capability-grant question.)
 */
export function sessionEditRoot(): string | undefined {
  // The paper in context wins: its own workspace folder (or its directory in
  // a single-file window). Only with NO paper at all do we fall back to the
  // first workspace folder. Round-2 review C1: taking folder[0] first made
  // the write root diverge from the READ root in a multi-root workspace, so
  // a create proposed against `notes/` landed in `thesis/`.
  return (
    activePaperRoot()?.root ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
}

/**
 * The paper a task reads: the focused one, else the last one focused, else the
 * best candidate in the workspace folder the write path already targets.
 *
 * That last clause is the D4 manual-round fix. `sessionEditRoot()` has always
 * fallen back to `workspaceFolders[0]`, but the READ registry keyed entirely
 * off the active editor — so a window where the user had opened a folder and
 * typed straight into the composer, without ever focusing a `.tex`, got the
 * write path and NO read tools. The agent then used `propose_edit` to attempt
 * a read. Opening a folder is the user asking Lemmaria to work on it; focus is
 * not capability (the same principle `stickyPaper` above already encodes).
 *
 * The discovered entry is never made sticky: it is a guess for this task, and
 * the moment the user focuses a real paper that wins.
 */
export async function paperInContext(): Promise<
  { root: string; entry: string } | undefined
> {
  const focused = activePaperRoot();
  if (focused) return focused;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root === undefined) return undefined;
  try {
    const entry = await discoverPaperEntry(new VscodeWorkspace(root));
    return entry === undefined ? undefined : { root, entry };
  } catch {
    return undefined; // an unreadable folder is not a crash
  }
}

/**
 * The per-task tool registry (A1a + A4): the quick-action assembly over the
 * paper in context — adapter, outline, memory glossary, workspace — plus the A4
 * session capabilities: `list_files`, granted-root reads (a live getter, so
 * mid-task revocation bites), and `literature_search` over the scholarly
 * providers. No paper at all (or an unparseable one) degrades to the
 * grants + literature registry — never a crash.
 */
export async function buildSessionRegistry(
  context: vscode.ExtensionContext,
  /**
   * V2 (ADR 0078 §5): the task's withholding holder, passed in rather than
   * made here — the review driver has to be able to fill **this same object**,
   * and a holder the registry minted privately would be unreachable.
   *
   * Absent for every caller that is not a review, which is what keeps an
   * ordinary chat's searches exactly as they were.
   */
  withhold?: LiteratureWithhold,
  /**
   * V6's E1 round: the search budget this task decrements, passed in for the
   * same reason as `withhold` — a review mints its own per run, so a detached
   * panel never spends the conversation's. Absent ⇒ the session's (ADR 0019).
   */
  budget?: { remaining: number },
): Promise<ReturnType<typeof buildToolRegistry>> {
  const base = {
    grants: () => activeSessionGrants(),
    literature: {
      providers: await literatureProviders(context),
      budget: budget ?? sessionLiteratureBudget(),
      ...(withhold !== undefined ? { withhold } : {}),
    },
  };
  const active = await paperInContext();
  if (active) {
    try {
      const workspace = new VscodeWorkspace(active.root, active.entry);
      const adapter = await loadAdapterFor(workspace, active.entry);
      const outline = await adapter.parseStructure();
      const memory = await loadMemoryInput(workspace, active.entry);
      const tools: ToolName[] = [
        "get_outline",
        "read_span",
        "grep_project",
        "list_files",
        "list_labels",
        "count_words",
        "glossary_lookup",
        "literature_search",
      ];
      return buildToolRegistry({
        tools,
        adapter,
        glossary: resolveMemory(memory).glossary,
        outline,
        workspace,
        defaultFile: active.entry,
        protectedSpans: protectedSpansForFile,
        ...base,
      });
    } catch {
      // Fall through to the paper-less registry below.
    }
  }
  // No paper Lemmaria can parse. An open FOLDER is still readable, though —
  // it is the same root the write path targets, so withholding the read tools
  // here would recreate the write-without-read asymmetry one level down. The
  // folder-less case (a bare window) keeps the A4 grants + literature registry.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const tools: ToolName[] =
    folder !== undefined || activeSessionGrants().length > 0
      ? ["list_files", "read_span", "grep_project", "literature_search"]
      : ["literature_search"];
  return buildToolRegistry({
    tools,
    // count_words is not offered here; the adapter slot is a required stub.
    adapter: {
      countWords: () => ({ language: "en", unit: "words", count: 0 }),
    },
    glossary: [],
    // No entry means no structure to offer, so `get_outline` stays absent and
    // `read_span` takes explicit line ranges only — an empty outline, not an
    // invented one. `defaultFile` is likewise omitted: a read must name its file.
    ...(folder !== undefined
      ? { workspace: new VscodeWorkspace(folder), outline: [] }
      : {}),
    // D1: marking does not need a parsed paper — the detector is stateless.
    protectedSpans: protectedSpansForFile,
    ...base,
  });
}

/** Invariant 5: the user's budget setting caps the task's output tokens. */
export function sessionCeilings(): Partial<SessionTaskBudget> {
  const cfg = vscode.workspace.getConfiguration("lemmaria");
  const ceilings: Partial<SessionTaskBudget> = {};
  // Each is the user's authoritative ceiling (can raise or lower the built-in
  // default); the harness clamps an action's request down from it (invariant 5).
  const maxTokens = cfg.get<number>("budget.maxTokens");
  if (typeof maxTokens === "number" && maxTokens > 0)
    ceilings.maxOutputTokens = maxTokens;
  const maxToolCalls = cfg.get<number>("budget.maxToolCalls");
  if (typeof maxToolCalls === "number" && maxToolCalls > 0)
    ceilings.maxToolCalls = maxToolCalls;
  const maxTurns = cfg.get<number>("budget.maxTurns");
  if (typeof maxTurns === "number" && maxTurns > 0)
    ceilings.maxTurns = maxTurns;
  return ceilings;
}

/** A3: the subagent fan-out CONCURRENCY ceiling (clamped down again in the harness). */
export function sessionMaxFanOut(): number | undefined {
  const n = vscode.workspace
    .getConfiguration("lemmaria")
    .get<number>("budget.maxFanOut");
  return typeof n === "number" && n > 0 ? n : undefined;
}

/** Test seam: forget the sticky paper (hermetic suites). */
export function resetStickyPaper(): void {
  stickyPaper = undefined;
}
