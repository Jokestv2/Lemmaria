/**
 * A5 — what a tool call actually asked for, and how big the answer was.
 *
 * A transcript row reading `✓ read_span` tells a reader nothing; "which file,
 * which lines?" is the whole question when you are watching an agent work on
 * your paper. These summarizers turn the persisted `argsJson`/`resultJson` into
 * a small STRUCTURED shape; the UI formats and localizes it (invariant 6 — this
 * module holds no user-facing prose and no locale).
 *
 * It lives here, beside the tool definitions in `engine/tools.ts` and the
 * loop-injected tools in `session/loop-tools/`, on purpose: it mirrors their exact
 * argument names, so a rename breaks a test in this package rather than
 * silently blanking a transcript row in the extension.
 */

import type { ToolError } from "../contracts/results.js";
import { ALL_TOOL_ERROR_CODES } from "../contracts/results.js";

/** A one-line description of a call's arguments. All fields optional: a tool
 *  with nothing worth saying (count_words) summarizes to `{}`. */
export interface ToolArgSummary {
  /** A path, query, section or argv — already human-readable. */
  text?: string;
  /** A cardinality (children spawned, edits proposed, plan steps). */
  count?: number;
  /** What `count` counts — a token the UI localizes, never shown raw. */
  unit?: "children" | "edits" | "steps";
  /** How many distinct files an edit batch touches. */
  files?: number;
}

/** How big the answer was — the second half of "what did it just do?". */
export interface ToolResultSummary {
  matches?: number;
  results?: number;
  files?: number;
  chars?: number;
  truncated?: boolean;
  /**
   * The call produced no result (ADR 0024). `code` is what the UI localizes —
   * a bare ✗ hides the reason, and an English sentence hides it from half the
   * users (invariant 6); `message` is model-facing detail shown beside it.
   * Replaces the former `refused` / `error` pair: a refusal is `refused`.
   */
  error?: ToolError;
  /**
   * Literature sources that did NOT answer (rate-limited, timed out, failed).
   * A6: `searchLiterature` has always reported per-source status as data, but
   * nothing read it — so a search where three of four providers were rate
   * limited rendered exactly like a healthy one, and "2 results" read as "only
   * 2 papers exist". Named sources let the row say otherwise.
   */
  degradedSources?: string[];
  /** R4: the subset of `degradedSources` that ran WITHOUT an API key, so the
   *  reader can be pointed at the command that stores one. By exception: a
   *  keyed source that failed anyway, and an anonymous source that answered,
   *  are both absent. */
  anonymousSources?: string[];
  /**
   * How many entries a listing/search refused to show — deny-listed, hidden by
   * `.gitignore`, or inside a skipped directory (A6). An empty-looking listing
   * of a gitignored results folder is the Experiments flagship's quiet failure.
   */
  excluded?: number;
}

/** How much raw JSON an unknown tool may put on one line before it is a wall. */
const RAW_CAP = 120;

function parseObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // a malformed blob is data, not a crash
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function len(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

export function summarizeToolArgs(
  tool: string,
  argsJson: string | undefined,
): ToolArgSummary {
  const args = parseObject(argsJson);
  switch (tool) {
    case "read_span": {
      // Paper-workspace reads address a section; granted-root reads address a
      // file (+ start_line/end_line). Both spellings are the tool's own.
      const section = str(args.section);
      if (section !== undefined) return { text: `§${section}` };
      // `file` is optional (it defaults to the paper's current file), so a
      // bare range is a legal call — show it rather than a blank row.
      const file = str(args.file);
      const from = int(args.start_line);
      const to = int(args.end_line);
      const range = from === undefined ? undefined : `${from}–${to ?? from}`;
      if (file === undefined) return range === undefined ? {} : { text: range };
      return { text: range === undefined ? file : `${file}:${range}` };
    }
    case "grep_project":
    case "literature_search": {
      const query = str(args.query);
      return query === undefined ? {} : { text: query };
    }
    case "list_files": {
      // The declared args are `root` (a grant id) and `glob` — the glob is the
      // discriminating one, so show both when present.
      const root = str(args.root);
      const glob = str(args.glob);
      const text = [root, glob].filter((p) => p !== undefined).join(" · ");
      return text === "" ? {} : { text };
    }
    case "glossary_lookup": {
      const term = str(args.term);
      return term === undefined ? {} : { text: term };
    }
    case "load_skill": {
      const name = str(args.name);
      return name === undefined ? {} : { text: name };
    }
    case "view_pdf_pages": {
      // The page numbers, which is the whole argument a reader cares about —
      // "pages 3, 4" reads as what it is at a glance (V3, ADR 0080 §7).
      const pages = Array.isArray(args.pages)
        ? args.pages.filter((p): p is number => typeof p === "number")
        : [];
      if (pages.length === 0) return {};
      const zoom = str(args.zoom);
      const text = `pages ${pages.join(", ")}`;
      return { text: zoom === undefined ? text : `${text} (${zoom})` };
    }
    case "spawn_subtask": {
      const count = len(args.children);
      return count === undefined ? {} : { count, unit: "children" };
    }
    case "run_script": {
      const command = Array.isArray(args.command)
        ? args.command.map(String)
        : [];
      return command.length === 0 ? {} : { text: command.join(" ") };
    }
    case "propose_edit": {
      // NEVER the batch itself: it carries whole rewritten passages, and the
      // edit_proposal card below the row already renders them properly.
      const edits = Array.isArray(args.edits) ? args.edits : undefined;
      if (!edits) return {};
      const files = new Set(
        edits.map((e) =>
          e && typeof e === "object"
            ? str((e as Record<string, unknown>).file)
            : undefined,
        ),
      );
      files.delete(undefined);
      return { count: edits.length, unit: "edits", files: files.size };
    }
    case "update_plan": {
      const count = len(args.items);
      return count === undefined ? {} : { count, unit: "steps" };
    }
    case "count_words":
    case "verify":
      return {};
    default: {
      // A tool this build does not know: show its arguments rather than
      // nothing, but capped — the expandable raw JSON carries the full text.
      const raw = (argsJson ?? "").trim();
      if (raw === "" || raw === "{}") return {};
      return {
        text: raw.length > RAW_CAP ? `${raw.slice(0, RAW_CAP - 1)}…` : raw,
      };
    }
  }
}

export function summarizeToolResult(
  resultJson: string | undefined,
): ToolResultSummary {
  const result = parseObject(resultJson);
  const summary: ToolResultSummary = {};
  const error = toolErrorOf(result.error);
  if (error !== undefined) return { error };
  const matches = len(result.matches);
  if (matches !== undefined) summary.matches = matches;
  const results = len(result.results);
  if (results !== undefined) summary.results = results;
  const files = len(result.files);
  if (files !== undefined) summary.files = files;
  const text = str(result.text);
  if (text !== undefined) summary.chars = text.length;
  if (result.truncated === true || result.filesTruncated === true)
    summary.truncated = true;

  // A6 — a partial answer must not read like a complete one.
  const degraded = degradedSourceNames(result.sources);
  if (degraded.length > 0) summary.degradedSources = degraded;
  const anonymous = anonymousSourceNames(result.sources);
  if (anonymous.length > 0) summary.anonymousSources = anonymous;
  const excluded =
    num(result.excludedByDefault) +
    num(result.excludedByGitignore) +
    num(result.excludedBySkipDir);
  if (excluded > 0) summary.excluded = excluded;
  return summary;
}

/**
 * The persisted `{error: {code, message}}` envelope (ADR 0024), or undefined.
 *
 * An unrecognized code is kept and shown as `unavailable` rather than dropped:
 * a code added by a later build must degrade to a visible row, never to a
 * silently blank one. A non-conforming `error` (a bare string from an older
 * record) is not a summary this build can render honestly, so it is ignored.
 */
function toolErrorOf(value: unknown): ToolError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { code, message } = value as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return {
    code: (ALL_TOOL_ERROR_CODES as readonly string[]).includes(code)
      ? (code as ToolError["code"])
      : "unavailable",
    message,
  };
}

/** Non-negative number, or 0 — a missing/odd field must never poison a sum. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** The `sources[]` entries whose status is anything other than `ok`. */
function degradedSourceNames(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const names: string[] = [];
  for (const entry of sources) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, status } = entry as { name?: unknown; status?: unknown };
    if (typeof name !== "string" || typeof status !== "string") continue;
    if (status !== "ok") names.push(name);
  }
  return names;
}

/** R4: the degraded entries that also ran anonymously — the only ones worth
 *  pointing at the key command for. */
function anonymousSourceNames(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const names: string[] = [];
  for (const entry of sources) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, status, anonymous } = entry as {
      name?: unknown;
      status?: unknown;
      anonymous?: unknown;
    };
    if (typeof name !== "string" || typeof status !== "string") continue;
    if (status !== "ok" && anonymous === true) names.push(name);
  }
  return names;
}
