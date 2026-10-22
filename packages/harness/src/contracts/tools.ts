/**
 * The harness named-tool allowlist — the product's capability/security boundary.
 *
 * Every capability an action (built-in or local) can invoke comes from this fixed
 * list. There is NO shell access and NO arbitrary network access. An action declares
 * the subset it needs in `requires.tools` / `routing.tools`; the harness clamps to
 * this list and rejects anything outside it.
 *
 * Canonical mirror of architecture-design-EN.md#harness-tool-allowlist.
 */

import type { CitationResult, Warning } from "./data.js";

export type ToolName =
  | "get_outline" // retrieval — structure tree / Repo Map (CM2)
  | "read_span" // retrieval — read a section or line range (CM3)
  | "grep_project" // retrieval — ripgrep full-project text search
  | "glossary_lookup" // retrieval — query the 3-column glossary
  | "list_labels" // retrieval — all \label keys in the project
  | "list_citations" // retrieval — all citation keys + .bib metadata
  | "count_words" // analysis — char/word count (CN by char, EN by word)
  | "citation_check" // analysis — C1 offline; C2 online when enabled (metadata only)
  | "apply_edit" // mutation — structure-safe replacement, ALWAYS via inline diff
  | "verify" // verification — compiler/parser run; returns Warning[]
  | "update_plan" // analysis — the session loop's todo/plan tool (ADR 0015); session-scoped, never in buildToolRegistry
  | "propose_edit" // mutation — the session write tool (ADR 0016): anchored multi-edit batches under the two-policy approval model; session-scoped (injected when a SessionEditHost is configured), never in buildToolRegistry
  | "list_files" // retrieval — root-scoped file listing (ADR 0019): the paper workspace or a granted root; walks respect .gitignore + the deny-read defaults
  | "literature_search" // retrieval — scholarly endpoints ONLY (Crossref/DBLP/Semantic Scholar/arXiv, ADR 0019): metadata + abstracts, honest rate_limited results, per-session budget; offered only when the session host supplies providers
  | "run_script" // mutation — approval-gated script execution (ADR 0020): argv-only [interpreter, script, ...args], interpreter allowlist, granted-root cwd, no shell, no OS sandbox; session-scoped (injected when a SessionScriptHost is configured), never in buildToolRegistry
  | "spawn_subtask" // analysis — bounded read-only fan-out (ADR 0022): each child runs its own retrieval loop in an isolated context with a narrowed read-only allowlist + a carved budget slice, returning only a short report; session-scoped (loop-injected, depth-bounded to 1), never in buildToolRegistry
  | "load_skill" // retrieval — the body of one loaded Writing Skill (ADR 0028), addressed by NAME and never by path, so a skill can never widen the read surface; the system prompt carries only names + descriptions, which is what bounds the per-turn cost of having skills installed; session-scoped (loop-injected when the host supplies skills), never in buildToolRegistry
  | "view_pdf_pages"; // retrieval — rendered pages of the paper's compiled PDF (V3, ADR 0080): addressed by 1-based PAGE NUMBER and never by path, so it can never widen the read surface; six pages a call and sixty a task, and only the latest batch's pixels stay in context; offered only to a model that declares image input; session-scoped (built per review from an opened PdfDocument), never in buildToolRegistry

/** Runtime mirror of ToolName — the loader checks requested tools ⊆ this list (invariant 2). */
export const ALL_TOOL_NAMES = [
  "get_outline",
  "read_span",
  "grep_project",
  "glossary_lookup",
  "list_labels",
  "list_citations",
  "count_words",
  "citation_check",
  "apply_edit",
  "verify",
  "update_plan",
  "propose_edit",
  "list_files",
  "literature_search",
  "run_script",
  "spawn_subtask",
  "load_skill",
  "view_pdf_pages",
] as const satisfies readonly ToolName[];

/**
 * `satisfies` above proves only elements ⊆ union. This proves union ⊆ elements,
 * so a name added to `ToolName` without being listed fails the build — where it
 * used to compile clean while being invisible to the runtime allowlist, which
 * is the list invariant 2's clamp actually enforces (`actions/loader.ts:64`).
 * The same proof `ToolErrorCode` carries in `results.ts`.
 */
type _EveryToolNameIsListed = ToolName extends (typeof ALL_TOOL_NAMES)[number]
  ? true
  : never;
const _toolNamesAreExhaustive: _EveryToolNameIsListed = true;
void _toolNamesAreExhaustive;

export type ToolCategory =
  | "retrieval"
  | "analysis"
  | "mutation"
  | "verification";

/**
 * Whether a tool's call may overlap with its siblings in one turn's batch
 * (B3, ADR 0025). The runtime field is `ToolExecutor.executionMode` in
 * `engine/tools.ts`; the type lives here because this file is the capability
 * vocabulary. It is deliberately NOT on `Tool` below: how the loop schedules a
 * call is not a capability, and one fact gets one home.
 *
 * **Absent means `sequential`** — the opposite of Pi's default and the same as
 * Codex's, because a read tool that stays serial is merely slow while a write
 * tool that goes parallel is an invariant-3 breach. `mutation` is forced
 * sequential regardless of what it declares; see ADR 0025.
 */
export type ToolExecutionMode = "parallel" | "sequential";

/**
 * A tool the L1/L2 loop can invoke mid-task. `count_words` and `verify` are
 * deliberately ALSO callable tools, distinct from the `word_count` validator and
 * the action-level `verify.run` setting (which run the same computation
 * programmatically, post-generation / post-Accept). Shared impl, distinct concepts.
 */
export interface Tool<Args = unknown, Res = unknown> {
  name: ToolName;
  category: ToolCategory;
  /** retrieval/analysis/verification are read-only; mutation writes via diff. */
  readonly: boolean;
  /**
   * Never throws (ADR 0024): every failure is a `ToolError` in the returned
   * `Result`. The runtime's executor shape lives in `engine/tools.ts`
   * (`ToolExecutor`, which adds the model-facing `spec`); this is the
   * capability-level declaration the allowlist doc mirrors.
   */
  invoke(
    args: Args,
    ctx: ToolContext,
  ): Promise<import("./results.js").Result<Res>>;
}

/** Ambient capabilities a tool needs, supplied by the harness — never the editor. */
export interface ToolContext {
  /** File I/O + compile via the host-provided Workspace port (keeps tools vscode-free). */
  workspace: import("./adapters.js").Workspace;
}

// Well-known tool result shapes (illustrative subset; full set finalized at impl time).
export interface OutlineNode {
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  wordCount: number;
  labels: string[];
  citations: string[];
  children: OutlineNode[];
}
export type GetOutlineResult = OutlineNode[];
export interface CountWordsResult {
  unit: "字" | "words";
  count: number;
}
export type CitationCheckResult = CitationResult[];
export interface VerifyResult {
  ok: boolean;
  warnings: Warning[];
}
