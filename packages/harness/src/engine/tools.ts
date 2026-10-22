/**
 * The L1 tool registry — the executable subset of the harness tool allowlist an
 * L1/L2 tool loop can invoke mid-task (architecture lifecycle step 7). Each entry
 * carries a `ToolSpec` (sent to the model so it knows how to call the tool) and an
 * `invoke` closure bound to the built context.
 *
 * M6 implements two tools: `count_words` (analysis — the self-check behind
 * shrink-to-target; does NOT consume `retrieval_budget`) and `glossary_lookup`
 * (retrieval — consumes `retrieval_budget`; translate's glossary constraint).
 * The remaining CM3 retrieval tools (get_outline/read_span/grep_project/
 * list_labels/list_citations) land at M8 and slot in here.
 *
 * Runtime capability boundary (invariant 2): the registry only ever contains
 * tools the action declared in `routing.tools`; the tier loop additionally
 * refuses any model-requested tool that is not present here.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DocumentAdapter,
  ImagePart,
  ProtectedSpan,
  ProtectedSpanReader,
  SpanKind,
  ToolSpec,
  Workspace,
} from "../contracts/adapters.js";
import type { Result, ToolError } from "../contracts/results.js";
import { ok, toolFail } from "../contracts/results.js";
import type { GrantedRoot } from "../contracts/sessions.js";
import type {
  OutlineNode,
  ToolCategory,
  ToolExecutionMode,
  ToolName,
} from "../contracts/tools.js";
import { truncateKeepingHead, truncateLineTo } from "../text/truncate.js";
import type { CitationSource } from "./citation-lookup.js";
import { checkCitationMetadata } from "./citation-metadata.js";
import { type CitationRecord, checkCitationConsistency } from "./citations.js";
import { deniedReason, resolveGrantedPath, walkGrantedRoot } from "./grants.js";
import { type LiteratureProvider, searchLiterature } from "./literature.js";
import { flattenOutline, serializeOutline } from "./outline.js";
import type { GlossaryEntry } from "./paper.js";
import { assertWorkspaceRelative } from "./workspace-utils.js";

/** read_span caps — keep one tool result well inside an L1 budget. */
export const READ_SPAN_MAX_LINES = 300;
/**
 * B4 (ADR 0029): the second limit is estimated TOKENS, replacing A-stage's
 * 12 000 CHARACTERS. 3 000 tokens ≈ 12 000 ASCII characters, so English
 * behaviour is unchanged; Chinese source now costs the same as English rather
 * than roughly four times as much (invariant 6).
 */
export const READ_SPAN_MAX_TOKENS = 3_000;

/** grep_project caps + the text-file extensions it searches. */
export const GREP_MAX_MATCHES = 50;
export const GREP_MAX_LINE_CHARS = 200;
const GREP_TEXT_EXTS = [
  ".tex",
  ".bib",
  ".md",
  ".txt",
  ".sty",
  ".cls",
  ".yaml",
  ".yml",
  ".json",
];

/** list_files cap (honest truncated flag past it). */
export const LIST_FILES_MAX = 500;
/** Largest granted file read_span will open (refused honestly above it). */
export const GRANT_READ_MAX_BYTES = 5_000_000;
/** Text extensions searched in granted roots — code + data superset (ADR 0019). */
export const GRANT_TEXT_EXTS: readonly string[] = [
  ...GREP_TEXT_EXTS,
  ".py",
  ".r",
  ".jl",
  ".m",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".sh",
  ".ps1",
  ".csv",
  ".tsv",
  ".toml",
  ".cfg",
  ".ini",
  ".log",
];

/**
 * B4 (ADR 0029): what a truncated tool result adds to its payload. Absent
 * entirely when nothing was cut — a result that fits stays byte-identical, the
 * rule `capToolResult` already follows one layer up.
 */
interface TruncationReport {
  truncated: true;
  truncated_by: "lines" | "tokens";
  total_lines: number;
  shown_lines: number;
  total_bytes: number;
  /** Present only when a single line alone exceeded the budget. */
  partial_line?: true;
}

/**
 * The shared `read_span` slice, for the workspace and granted-root variants
 * alike (they diverge only in how they get their lines).
 *
 * `end_line` names the last line actually RETURNED, so it never claims a line
 * the token budget cut; `total_lines` is what the model asked for, so it can
 * tell how much it is missing. Before B4 the only signal was a `"\n… [truncated]"`
 * suffix glued onto the file content — which the granted variant computed and
 * then never returned at all, and which polluted text a `propose_edit` anchor
 * may be quoted from.
 */
function readSpanSlice(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): { text: string; endLine: number; report: Partial<TruncationReport> } {
  // A file ending in a newline splits into a phantom trailing element. It is
  // not a line, and the truncation primitive deliberately does not count it —
  // so comparing the two line models made the ORDINARY read-to-end-of-file
  // report `truncated: true` with nothing cut, and under-report `end_line` by
  // one (review, Critical 1). Normalize once, here, and count one way.
  const body =
    lines.length > 1 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;
  const last = Math.min(endLine, Math.max(body.length, 1));
  const requested = Math.max(0, last - startLine + 1);
  const capped = Math.min(requested, READ_SPAN_MAX_LINES);
  const slice = body.slice(startLine - 1, startLine - 1 + capped).join("\n");
  const cut = truncateKeepingHead(slice, {
    maxLines: READ_SPAN_MAX_LINES,
    maxTokens: READ_SPAN_MAX_TOKENS,
  });
  if (!cut.truncated && capped >= requested)
    return { text: cut.text, endLine: last, report: {} };
  // How far the kept text reached in the ORIGINAL numbering: count its line
  // separators rather than re-splitting, so a kept blank last line still
  // advances `end_line`.
  const consumed = cut.partialLine ? 0 : (cut.text.match(/\n/g)?.length ?? 0);
  const whole = body.slice(startLine - 1, last).join("\n");
  return {
    text: cut.text,
    endLine: startLine + consumed,
    report: {
      truncated: true,
      truncated_by: cut.truncatedBy ?? "lines",
      total_lines: requested,
      shown_lines: cut.text === "" ? 0 : consumed + 1,
      total_bytes: Buffer.byteLength(whole, "utf8"),
      ...(cut.partialLine ? { partial_line: true as const } : {}),
    },
  };
}

/**
 * How many protected regions one `read_span` result names (D1, ADR 0032).
 *
 * A dense LaTeX page can hold a hundred frozen macros. Listing them all costs
 * tokens the model does not need — it already has the text; what the list buys
 * is the IDENTITY of what must survive. Capped, with an honest total, on B4's
 * rule that a truncation says what it cut.
 */
export const READ_SPAN_MAX_PROTECTED = 40;

/**
 * What a `read_span` result adds when the slice holds protected content.
 * Absent entirely when it holds none, or when no reader is wired — the same
 * byte-identical rule `TruncationReport` follows.
 */
interface ProtectedReport {
  protected: Array<{ kind: SpanKind; text: string }>;
  /** Present only when the list was capped; the real number found. */
  protected_total?: number;
}

/**
 * The protected regions inside one returned slice, deduplicated by kind+text
 * and capped (D1, ADR 0032). Marking is a COURTESY: a reader that rejects, or
 * that cannot analyse the file, costs the read nothing — a failed parse must
 * never turn a working read into a failed tool call.
 *
 * **The paper workspace only, deliberately.** A granted root is read-only by
 * construction (invariant 2, ADR 0019) and writes are workspace-rooted (ADR
 * 0018), so there is no edit for a mark over granted text to constrain. Naming
 * protected regions the model could not change either way would be noise
 * dressed as a rule.
 */
async function markProtected(
  reader: ProtectedSpanReader | undefined,
  file: string,
  text: string,
): Promise<Partial<ProtectedReport>> {
  if (!reader || text === "") return {};
  let spans: ProtectedSpan[] | undefined;
  try {
    spans = await reader(file, text);
  } catch {
    return {};
  }
  if (!spans || spans.length === 0) return {};
  const seen = new Map<string, { kind: SpanKind; text: string }>();
  for (const span of spans) {
    const key = `${span.kind}\0${span.raw}`;
    if (!seen.has(key)) seen.set(key, { kind: span.kind, text: span.raw });
  }
  const all = [...seen.values()];
  if (all.length <= READ_SPAN_MAX_PROTECTED) return { protected: all };
  return {
    protected: all.slice(0, READ_SPAN_MAX_PROTECTED),
    protected_total: all.length,
  };
}

/** Default per-SESSION literature_search budget (ADR 0019). */
export const LITERATURE_SESSION_BUDGET = 25;
/** literature_search max_results clamp + default. */
export const LITERATURE_MAX_RESULTS = 20;
export const LITERATURE_DEFAULT_RESULTS = 8;

/**
 * Titles this session's literature searches must not return (V2, ADR 0078 §5).
 *
 * A **host-owned mutable holder**, exactly like `budget` below and for the
 * same reason: the executor closes over it once, and the driver fills and
 * empties it for the span of one run. There is no way to pass per-call state
 * into a tool — `ToolExecutor.invoke(args)` takes no context, and `runChild`
 * hands every child the same executors by reference — so a run-scoped fact
 * reaches the tool through a holder or not at all.
 */
export interface LiteratureWithhold {
  titles: string[];
}

/** Providers + budget for `literature_search`; absent ⇒ the tool is omitted (A4). */
export interface LiteratureToolData {
  providers: LiteratureProvider[];
  /**
   * Host-owned per-SESSION counter ({ remaining }); the executor decrements.
   * Exhausted → honest refusal result, never a throw.
   */
  budget?: { remaining: number };
  /** Per-provider deadline; defaults to LITERATURE_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * V2 (ADR 0078 §5): host-owned, read at CALL time. Empty or absent changes
   * nothing at all, which is what keeps every non-review search byte-identical
   * to what it was before V2.
   */
  withhold?: LiteratureWithhold;
}

/** Citation data + optional C2 sources supplied to the citation tools (M7). */
export interface CitationToolData {
  citedKeys: string[];
  entries: CitationRecord[];
  entryFile: string;
  /** Present ⇒ C2 online metadata verification is enabled for `citation_check`. */
  sources?: CitationSource[];
  timeoutMs?: number;
}

/**
 * What one tool call produced (V3, ADR 0080 §4).
 *
 * An intersection rather than a new union, so a plain `Result` — which is what
 * every tool but one returns — is assignable to it and every existing executor
 * and test compiles unedited.
 *
 * `images` ride BESIDE the JSON, never inside it: `capToolResult` caps the JSON
 * and nothing else, and the batch attaches the images to the `ChatMessage` it
 * pushes and to nothing it emits. That is what makes "no pixel reaches a
 * persisted session" a property of the code path rather than a filter someone
 * has to remember.
 */
export type ToolOutcome = Result<unknown, ToolError> & {
  readonly images?: readonly ImagePart[];
};

export interface ToolExecutor {
  name: ToolName;
  category: ToolCategory;
  /** Advertised to the model each turn so it can form valid tool calls. */
  spec: ToolSpec;
  /**
   * May this call overlap with its siblings in one turn's batch (B3, ADR 0025)?
   * **Absent ⇒ sequential.** A `mutation` tool is sequential whatever it says
   * here — the category is the invariant-3 guard, this field is only an
   * optimisation. Resolved by `session/tool-batch.ts`.
   */
  executionMode?: ToolExecutionMode;
  /**
   * Args are model-supplied JSON (`unknown`). **Never throws** (ADR 0024):
   * every failure comes back as a `ToolError` carrying a code the loop, the
   * transcript and the model can each branch on. The loop keeps an
   * `unavailable` backstop for a tool that violates this anyway, so one bad
   * tool cannot kill a session — but that path is a defect, not a design.
   */
  invoke(args: unknown): Promise<ToolOutcome>;
}

export interface BuildToolRegistryOptions {
  /** The action's `routing.tools` (already validated ⊆ ALL_TOOL_NAMES at load). */
  tools: ToolName[];
  adapter: Pick<DocumentAdapter, "countWords">;
  glossary: GlossaryEntry[];
  /** Bib data for the citation tools; absent ⇒ `citation_check`/`list_citations` omitted. */
  citations?: CitationToolData;
  /** CM2 structure tree; absent ⇒ `get_outline`/`read_span`/`list_labels` omitted (M8). */
  outline?: OutlineNode[];
  /** Project I/O for `read_span`/`grep_project`; absent ⇒ those tools omitted (M8). */
  workspace?: Pick<Workspace, "readFile" | "listFiles">;
  /** The file `read_span` line ranges default to (the unit's file). */
  defaultFile?: string;
  /**
   * Session-scoped external read grants (A4, ADR 0019). Present ⇒
   * `list_files`/`read_span`/`grep_project` accept a `root` grant-id
   * argument. A getter so mid-task revocation is honored at the next tool
   * call. Only the session host wires this — quick actions never see grants.
   */
  grants?: () => GrantedRoot[];
  /** Literature search (A4, ADR 0019); absent ⇒ `literature_search` omitted. */
  literature?: LiteratureToolData;
  /**
   * D1 (ADR 0032): the stateless protected-span detector `read_span` marks its
   * slices with. Absent ⇒ no marking at all, and results stay byte-identical
   * to their pre-D1 shape. The session host wires the SAME reader into
   * `propose_edit`, so what the model is told and what it is judged by cannot
   * drift apart.
   */
  protectedSpans?: ProtectedSpanReader;
}

/**
 * The reserved root id for the paper workspace — the value `list_files` has
 * always ANSWERED with for a workspace listing.
 *
 * That echo was the whole defect the D4 manual round caught: a model that
 * listed files and then read one passed `root: "workspace"` straight back, and
 * was refused for a grant that never existed ("it may have been revoked" — of
 * something never granted). A tool's own output must be valid input to the
 * next call, so the id is now accepted as well as reported. A live grant of
 * the same id still wins below, so the reservation can never shadow a real
 * capability (invariant 2); ids are machine-minted `g1`, `g2`, … so no grant
 * claims it in practice.
 */
export const WORKSPACE_ROOT_ID = "workspace";

/**
 * The granted root a `root` argument names, or `undefined` for the paper
 * workspace — which is what an omitted argument and the reserved id above both
 * mean. Shared by the three root-taking tools so they cannot disagree.
 */
function resolveRootArg(
  grants: (() => GrantedRoot[]) | undefined,
  args: unknown,
): string | undefined {
  if (!grants) return undefined;
  const id = optString(args, "root");
  if (id === undefined) return undefined;
  if (id === WORKSPACE_ROOT_ID && !grants().some((g) => g.id === id))
    return undefined;
  return id;
}

/** Look up a live grant id, or the honest refusal the model self-corrects from. */
function grantById(
  grants: () => GrantedRoot[],
  id: string,
): { grant: GrantedRoot } | { refused: string } {
  const grant = grants().find((g) => g.id === id);
  return grant
    ? { grant }
    : {
        // Name the way out, not just the failure: a model that guessed a root
        // id has no other way to learn that the paper is the default.
        refused: `no such granted root: ${id} — it may have been revoked. Omit "root" (or pass "${WORKSPACE_ROOT_ID}") to read the paper workspace.`,
      };
}

/**
 * The shared `root` spec property, advertised only when a grant is actually
 * live — its description points at a system-prompt block that only exists
 * then, so advertising it in a grant-free session documented nothing.
 */
const ROOT_PARAM = {
  root: {
    type: "string",
    description:
      "Optional granted-root id (see the system prompt's granted-folders list). Omit for the paper workspace.",
  },
} as const;

/** A required string argument, or the `invalid` failure the model re-issues from. */
function asString(args: unknown, key: string): Result<string, ToolError> {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string") {
    return toolFail("invalid", `missing or non-string "${key}" argument`);
  }
  return ok(value);
}

function optString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function optInt(args: unknown, key: string): number | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

/**
 * read_span over a granted root (ADR 0019): explicit file (+ lines), deny +
 * realpath containment, size cap. Refusals are data the model self-corrects
 * from — never throws.
 */
async function readGrantedSpan(
  grants: () => GrantedRoot[],
  rootId: string,
  args: unknown,
): Promise<Result<unknown, ToolError>> {
  const hit = grantById(grants, rootId);
  if ("refused" in hit) return toolFail("refused", hit.refused);
  if (optString(args, "section") !== undefined) {
    return toolFail(
      "invalid",
      "sections are paper-workspace only; pass file (+ start_line/end_line) for a granted root",
    );
  }
  const file = optString(args, "file");
  if (file === undefined || file === "") {
    return toolFail("invalid", 'read_span on a granted root needs a "file"');
  }
  const denied = deniedReason(file);
  if (denied !== undefined) return toolFail("denied", denied);
  const resolved = resolveGrantedPath(hit.grant, file);
  // ADR 0024 decision 5: `grants.ts` states the code beside its message, so the
  // boundary is a lookup, never a regex over English.
  if (resolved.refused !== undefined)
    return toolFail(resolved.code, resolved.refused);
  let size: number;
  try {
    size = statSync(resolved.abs).size;
  } catch {
    return toolFail("not_found", `no such file: ${file}`);
  }
  if (size > GRANT_READ_MAX_BYTES) {
    return toolFail(
      "too_large",
      `file too large (${size} bytes; read_span opens at most ${GRANT_READ_MAX_BYTES})`,
    );
  }
  const lines = (await readFile(resolved.abs, "utf8")).split("\n");
  let startLine = Math.max(1, optInt(args, "start_line") ?? 1);
  let endLine = optInt(args, "end_line") ?? startLine + READ_SPAN_MAX_LINES - 1;
  if (startLine > endLine)
    return toolFail("invalid", "invalid range: start > end");
  startLine = Math.min(startLine, lines.length);
  endLine = Math.min(endLine, lines.length);
  const span = readSpanSlice(lines, startLine, endLine);
  return ok({
    root: rootId,
    file,
    start_line: startLine,
    end_line: span.endLine,
    text: span.text,
    ...span.report,
  });
}

/** grep over a granted root: the walk already applies gitignore + deny + skips. */
async function grepGrantedRoot(
  grants: () => GrantedRoot[],
  rootId: string,
  needle: string,
  glob: string | undefined,
): Promise<Result<unknown, ToolError>> {
  const hit = grantById(grants, rootId);
  if ("refused" in hit) return toolFail("refused", hit.refused);
  const {
    files,
    truncated: filesTruncated,
    excludedByDefault,
    excludedByGitignore,
    excludedBySkipDir,
  } = walkGrantedRoot(hit.grant, {
    ...(glob !== undefined ? { glob } : {}),
  });
  const candidates = files.filter((f) =>
    GRANT_TEXT_EXTS.some((ext) => f.toLowerCase().endsWith(ext)),
  );
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let total = 0;
  for (const file of candidates) {
    let content: string;
    try {
      content = await readFile(join(hit.grant.path, file), "utf8");
    } catch {
      continue; // vanished/unreadable file — skip, never fail the search
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.toLowerCase().includes(needle)) continue;
      total += 1;
      if (matches.length >= GREP_MAX_MATCHES) continue;
      matches.push({
        file,
        line: i + 1,
        text: truncateLineTo(line.trim(), GREP_MAX_LINE_CHARS).text,
      });
    }
  }
  const truncated = total > matches.length;
  // `truncated` = the match cap was hit; `filesTruncated` = the walk stopped
  // before seeing every file (the granted tree exceeds the walk cap), so a
  // "no match" is not a whole-tree fact (ADR 0019 honesty). A6 adds the two
  // exclusion counts for the same reason: a search over a folder whose
  // contents are gitignored must not report "no matches" as if it had looked.
  return ok({
    root: rootId,
    matches,
    truncated,
    // B4: the real count. The scan used to `break outer` on the 50th hit, so
    // nothing knew — and could not tell the model — whether it had passed over
    // one more match or ten thousand. Collection still stops at the cap; only
    // the counting continues, and the walk is bounded either way.
    total_matches: total,
    filesTruncated,
    // All three, so grep and list_files never disagree about the same tree
    // (review, Important 7): a "no matches" over a root whose material was
    // deny-listed must disclose that too, not only the gitignored part.
    excludedByDefault,
    excludedByGitignore,
    excludedBySkipDir,
  });
}

/**
 * Build the executable tool registry for one action invocation. Only tools this
 * function knows how to run are included; an allowlisted-but-unimplemented tool
 * (e.g. `read_span` before M8) is omitted, and the tier loop refuses it at runtime.
 */
export function buildToolRegistry(
  opts: BuildToolRegistryOptions,
): Map<ToolName, ToolExecutor> {
  const {
    adapter,
    glossary,
    citations,
    outline,
    workspace,
    defaultFile,
    grants,
    literature,
    protectedSpans,
  } = opts;
  const registry = new Map<ToolName, ToolExecutor>();
  // Read once, here: the registry is rebuilt per task (and the prompt
  // re-declares grants at the same moment), so the advertised parameter and
  // the prompt block that documents it are decided together and cannot drift.
  // The `invoke` paths keep consulting the LIVE getter, so a mid-task grant
  // still resolves and a mid-task revocation still bites (ADR 0019).
  const hasLiveGrant = grants !== undefined && grants().length > 0;

  const factories: Partial<Record<ToolName, () => ToolExecutor>> = {
    count_words: () => ({
      name: "count_words",
      category: "analysis",
      executionMode: "parallel",
      spec: {
        name: "count_words",
        description:
          "Count the length of a piece of text — English by word, Chinese by character. Use it to self-check a draft against a target length.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to measure." },
          },
          required: ["text"],
        },
      },
      invoke: async (args) => {
        const text = asString(args, "text");
        if (!text.ok) return text;
        const wc = adapter.countWords(text.value);
        return ok({ unit: wc.unit, count: wc.count });
      },
    }),
    glossary_lookup: () => ({
      name: "glossary_lookup",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "glossary_lookup",
        description:
          "Look up the project glossary for a term; returns the canonical spelling, Chinese translation, and abbreviation to keep terminology consistent.",
        parameters: {
          type: "object",
          properties: {
            term: { type: "string", description: "The term to look up." },
          },
          required: ["term"],
        },
      },
      invoke: async (args) => {
        const term = asString(args, "term");
        if (!term.ok) return term;
        const needle = term.value.toLowerCase();
        return ok(
          glossary.filter((e) => e.term.toLowerCase().includes(needle)),
        );
      },
    }),
  };

  if (outline) {
    factories.get_outline = () => ({
      name: "get_outline",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "get_outline",
        description:
          "Get the document's structure tree (the repo map): every section with its file, line range, word count, labels, and cite keys. Use it to orient before reading specific spans.",
        parameters: { type: "object", properties: {} },
      },
      invoke: async () => ok({ outline: serializeOutline(outline) }),
    });
  }

  if (outline) {
    factories.list_labels = () => ({
      name: "list_labels",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "list_labels",
        description:
          "List every \\label key defined in the project, with the file and section it belongs to. Use it before adding or checking a \\ref.",
        parameters: { type: "object", properties: {} },
      },
      invoke: async () =>
        ok(
          flattenOutline(outline).flatMap((n) =>
            n.labels.map((label) => ({
              label,
              file: n.file,
              section: n.title,
            })),
          ),
        ),
    });
  }

  if ((outline && workspace) || grants) {
    factories.read_span = () => ({
      name: "read_span",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "read_span",
        description:
          "Read a slice of the project source: either a section by its title (from get_outline) or an explicit 1-based line range. Long results are truncated.",
        parameters: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "A section title from the outline.",
            },
            file: {
              type: "string",
              description: "File to read (defaults to the current file).",
            },
            start_line: { type: "number", description: "1-based, inclusive." },
            end_line: { type: "number", description: "1-based, inclusive." },
            ...(hasLiveGrant ? ROOT_PARAM : {}),
          },
        },
      },
      invoke: async (args) => {
        const rootId = resolveRootArg(grants, args);
        if (rootId !== undefined && grants) {
          return readGrantedSpan(grants, rootId, args);
        }
        // A grants-only session (no paper open) has no workspace to read —
        // refuse as data so the model reaches for a granted root instead.
        if (!outline || !workspace) {
          return toolFail(
            "refused",
            "no paper workspace in this session — pass a granted root id",
          );
        }
        const section = optString(args, "section");
        let file: string;
        let startLine: number;
        let endLine: number;
        if (section !== undefined) {
          const hit = flattenOutline(outline).find(
            (n) => n.title.toLowerCase() === section.toLowerCase(),
          );
          if (!hit) {
            return toolFail(
              "not_found",
              `unknown section "${section}" — call get_outline for the exact titles`,
            );
          }
          ({ file, startLine, endLine } = hit);
        } else {
          const start = optInt(args, "start_line");
          const end = optInt(args, "end_line");
          if (start === undefined || end === undefined) {
            return toolFail(
              "invalid",
              'read_span needs either a "section" or both "start_line" and "end_line"',
            );
          }
          if (start > end)
            return toolFail("invalid", "invalid range: start > end");
          // The model controls this arg — contain it to the workspace root
          // (invariant 2) before it reaches the host's readFile. The guard is
          // shared with the M8 edit path and still throws; ADR 0024 maps it to
          // a code here, at the boundary.
          try {
            file = assertWorkspaceRelative(
              optString(args, "file") ?? defaultFile ?? "",
            );
          } catch (error) {
            return toolFail("denied", (error as Error).message);
          }
          startLine = Math.max(1, start);
          endLine = end;
        }
        const lines = (await workspace.readFile(file)).split("\n");
        startLine = Math.min(startLine, lines.length);
        endLine = Math.min(endLine, lines.length);
        const span = readSpanSlice(lines, startLine, endLine);
        return ok({
          file,
          start_line: startLine,
          end_line: span.endLine,
          text: span.text,
          ...span.report,
          // D1: over the text actually RETURNED, so what the model is told is
          // protected is exactly what it can see.
          ...(await markProtected(protectedSpans, file, span.text)),
        });
      },
    });
  }

  if (workspace || grants) {
    factories.grep_project = () => ({
      name: "grep_project",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "grep_project",
        description:
          "Search every project text file for a literal string (case-insensitive; NOT a regex). Returns matching lines with file and line number. Use it to locate where something is defined or mentioned.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Literal text to find (at least 2 characters).",
            },
            glob: {
              type: "string",
              description: 'Optional filename filter, e.g. "*.bib".',
            },
            ...(hasLiveGrant ? ROOT_PARAM : {}),
          },
          required: ["query"],
        },
      },
      invoke: async (args) => {
        const query = asString(args, "query");
        if (!query.ok) return query;
        if (query.value.length < 2) {
          return toolFail("invalid", '"query" must be at least 2 characters');
        }
        const needle = query.value.toLowerCase();
        const glob = optString(args, "glob");
        const rootId = resolveRootArg(grants, args);
        if (rootId !== undefined && grants) {
          return grepGrantedRoot(grants, rootId, needle, glob);
        }
        if (!workspace) {
          return toolFail(
            "refused",
            "no paper workspace in this session — pass a granted root id",
          );
        }
        const files = (await workspace.listFiles(glob)).filter((f) =>
          GREP_TEXT_EXTS.some((ext) => f.toLowerCase().endsWith(ext)),
        );
        const matches: Array<{ file: string; line: number; text: string }> = [];
        let total = 0;
        for (const file of files) {
          let content: string;
          try {
            content = await workspace.readFile(file);
          } catch {
            continue; // unreadable file — skip, never fail the search
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (!line.toLowerCase().includes(needle)) continue;
            total += 1;
            // B4: keep counting past the cap so `total_matches` is a fact, and
            // mark a line the per-line cap cut instead of cutting it silently.
            if (matches.length >= GREP_MAX_MATCHES) continue;
            matches.push({
              file,
              line: i + 1,
              text: truncateLineTo(line.trim(), GREP_MAX_LINE_CHARS).text,
            });
          }
        }
        return ok({
          matches,
          truncated: total > matches.length,
          total_matches: total,
        });
      },
    });
  }

  if (workspace || grants) {
    factories.list_files = () => ({
      name: "list_files",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "list_files",
        description:
          "List readable files under a root — the paper workspace by default, or a granted folder by its root id. Granted-root walks respect .gitignore and the default deny-read list.",
        parameters: {
          type: "object",
          properties: {
            glob: {
              type: "string",
              description: 'Optional filename filter, e.g. "*.py".',
            },
            ...(hasLiveGrant ? ROOT_PARAM : {}),
          },
        },
      },
      invoke: async (args) => {
        const glob = optString(args, "glob");
        const rootId = resolveRootArg(grants, args);
        if (rootId !== undefined && grants) {
          const hit = grantById(grants, rootId);
          if ("refused" in hit) return toolFail("refused", hit.refused);
          const walked = walkGrantedRoot(hit.grant, {
            maxFiles: LIST_FILES_MAX,
            ...(glob !== undefined ? { glob } : {}),
          });
          return ok({ root: rootId, ...walked });
        }
        if (!workspace) {
          return toolFail(
            "refused",
            "no paper workspace in this session — pass a granted root id",
          );
        }
        const all = await workspace.listFiles(glob);
        const files = all.slice(0, LIST_FILES_MAX);
        return ok({
          root: "workspace",
          files,
          truncated: all.length > files.length,
          // B4: the total the walk already knew and threw away. A bare
          // `truncated: true` cannot tell the model whether it is missing ten
          // files or ten thousand — the difference between narrowing the glob
          // and giving up on the listing. (The granted-root branch has no
          // honest equivalent: that walk ABORTS at the cap, so it never learns
          // the total, and inventing one is the invented count A6 removed.)
          total_files: all.length,
          // The workspace walk applies no deny-list (ADR 0019), so this zero
          // is a fact. The gitignore/skip-dir counts are deliberately ABSENT
          // rather than zero: the host's listFiles DOES skip node_modules,
          // build/, out/ and dot-dirs (`shouldSkipDir`) but does not count
          // them, and reporting 0 would be exactly the invented count this
          // milestone added the counters to eliminate (review, Critical 2).
          excludedByDefault: 0,
        });
      },
    });
  }

  if (literature) {
    factories.literature_search = () => ({
      name: "literature_search",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "literature_search",
        description:
          "Search the scholarly literature (Crossref/DBLP/Semantic Scholar/arXiv; metadata + abstracts only). Results are candidate papers, merged by taking turns across the sources that answered; a result whose title or DOI is exactly your query comes first. They are never verified matches for existing bib entries; add a reference to the bibliography only via propose_edit. Every source is paced per host and retried with backoff when it asks to be; rate-limited or failed sources are reported per source. During a review, results that are the reviewed manuscript itself are withheld, and `withheld` says how many.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Title words, topic, or author keywords; an exact title or a DOI returns that paper first when any source has it.",
            },
            max_results: {
              type: "number",
              description: `1–${LITERATURE_MAX_RESULTS}; default ${LITERATURE_DEFAULT_RESULTS}.`,
            },
          },
          required: ["query"],
        },
      },
      invoke: async (args) => {
        const query = optString(args, "query")?.trim();
        if (query === undefined || query === "") {
          return toolFail(
            "invalid",
            'literature_search needs a non-empty "query"',
          );
        }
        const budget = literature.budget;
        if (budget && budget.remaining <= 0) {
          return toolFail(
            "too_large",
            // B2: `too_large` covers both an oversized request and a spent
            // budget, so the message must say WHICH — narrowing the query
            // cannot refill a budget (ADR 0026, closing a B0 question).
            `literature search budget exhausted for this session (${LITERATURE_SESSION_BUDGET} per session); a narrower query will not help — answer from the results you already have`,
          );
        }
        if (budget) budget.remaining -= 1;
        const requested = optInt(args, "max_results");
        const maxResults = Math.min(
          LITERATURE_MAX_RESULTS,
          Math.max(1, requested ?? LITERATURE_DEFAULT_RESULTS),
        );
        // A search that answered is a SUCCESS carrying per-source status (A6):
        // a rate-limited provider is degraded data, not a ToolError. The
        // `rate_limited` code is for a call that returned nothing at all.
        return ok(
          await searchLiterature(
            { query, maxResults },
            {
              providers: literature.providers,
              ...(literature.timeoutMs !== undefined
                ? { timeoutMs: literature.timeoutMs }
                : {}),
              // V2 (ADR 0078 §5): read at CALL time, never captured at build
              // time — the holder is filled by the panel driver after the
              // registry already exists.
              ...(literature.withhold !== undefined
                ? { excludeTitles: [...literature.withhold.titles] }
                : {}),
            },
          ),
        );
      },
    });
  }

  if (citations) {
    factories.citation_check = () => ({
      name: "citation_check",
      category: "analysis",
      executionMode: "parallel",
      spec: {
        name: "citation_check",
        description:
          "Check the project's citations: C1 offline consistency (missing/orphan/duplicate keys) always, plus C2 online metadata verification against Crossref/DBLP/Semantic Scholar when enabled. Returns { consistency, metadata? }.",
        parameters: { type: "object", properties: {} },
      },
      invoke: async () => {
        const consistency = checkCitationConsistency({
          citedKeys: citations.citedKeys,
          entries: citations.entries,
          entryFile: citations.entryFile,
        });
        if (!citations.sources || citations.sources.length === 0) {
          return ok({ consistency });
        }
        const metadata = await checkCitationMetadata(
          citations.entries.map((e) => ({ key: e.key, fields: e.fields })),
          {
            sources: citations.sources,
            ...(citations.timeoutMs !== undefined
              ? { timeoutMs: citations.timeoutMs }
              : {}),
          },
        );
        return ok({ consistency, metadata });
      },
    });
    factories.list_citations = () => ({
      name: "list_citations",
      category: "retrieval",
      executionMode: "parallel",
      spec: {
        name: "list_citations",
        description:
          "List every citation key defined in the project's .bib files, with its bibliographic metadata.",
        parameters: { type: "object", properties: {} },
      },
      invoke: async () =>
        ok(citations.entries.map((e) => ({ key: e.key, fields: e.fields }))),
    });
  }

  for (const name of opts.tools) {
    const make = factories[name];
    if (make) registry.set(name, make());
  }
  return registry;
}
