import type { SessionItem } from "../contracts/sessions.js";

/**
 * B4 (ADR 0029) — the set of files a session's work has touched.
 *
 * Compaction is lossy by design (ADR 0021): tool traffic before a checkpoint
 * leaves the model's view, and describing it is the summary's job. But a
 * summary is a model artifact and can omit a file it read three turns ago,
 * and *which files the work touched* is a fact — facts should not be left to
 * a summariser. Threaded into the compacted history, this is what stops a
 * resumed or compacted session from re-reading what it already read.
 *
 * Adapted from Pi's `FileOperations` / `computeFileLists`
 * (`harness/compaction/utils.ts`, MIT), with one deliberate divergence: Pi
 * persists the set on the compaction entry's `details` and re-seeds it from
 * the previous entry each round. Lemmaria DERIVES it, because Lemmaria's
 * transcript is never edited — the pre-checkpoint items are all still there —
 * so a derivation has one home (no snapshot to drift) and stays correct after
 * an ADR 0018 rewind, where a persisted snapshot would still be claiming
 * files that no longer happened.
 *
 * Pi keys its extraction on tool NAME plus an `args.path` convention.
 * Lemmaria reads the tool's RESULT instead, because `read_span` accepts a
 * section title rather than a file and only the result knows what that
 * resolved to.
 */
export interface FileOperations {
  /** Files read and not since modified, sorted. */
  read: string[];
  /** Files created by an applied edit, sorted. */
  written: string[];
  /** Existing files changed by an applied edit, sorted. */
  edited: string[];
}

/** A granted-root path is qualified, so it is never read as a workspace one. */
function qualify(file: string, root: unknown): string {
  return typeof root === "string" && root !== "" ? `${root}:${file}` : file;
}

function readFileFrom(item: SessionItem): string | undefined {
  if (item.type !== "tool_call") return undefined;
  if (item.tool !== "read_span") return undefined;
  if (item.status !== "completed" || item.resultJson === undefined)
    return undefined;
  try {
    const payload = JSON.parse(item.resultJson) as Record<string, unknown>;
    const file = payload.file;
    if (typeof file !== "string" || file === "") return undefined;
    return qualify(file, payload.root);
  } catch {
    return undefined;
  }
}

/** Fold a transcript into the files it read, created and changed. */
export function fileOperations(items: readonly SessionItem[]): FileOperations {
  const read = new Set<string>();
  const written = new Set<string>();
  const edited = new Set<string>();
  for (const item of items) {
    const readFile = readFileFrom(item);
    if (readFile !== undefined) read.add(readFile);
    if (item.type === "edit_proposal") {
      for (const edit of item.edits) {
        // Only an APPLIED edit touched the file. A rejected or stale proposal
        // is a thing that did not happen, and invariant 3 is why.
        if (edit.status !== "applied") continue;
        (edit.kind === "create" ? written : edited).add(edit.file);
      }
    }
    if (item.type === "changed_files") {
      for (const f of item.files) (f.created ? written : edited).add(f.file);
    }
  }
  // A file that was modified is never also listed as read (Pi's rule): the
  // stronger fact wins, and a file cannot be both in one list.
  const modified = new Set([...written, ...edited]);
  return {
    read: [...read].filter((f) => !modified.has(f)).sort(),
    written: [...written].sort(),
    edited: [...edited].sort(),
  };
}

/**
 * Render the set **for the model**, or "" when there is nothing to say.
 *
 * **English** (ADR 0034 consequence 2), like `SUMMARY_PREFIX`. It used to
 * carry both languages on the reasoning that "a Chinese session's handoff must
 * not carry an English-only block" — but no reader ever sees this string, and
 * its own siblings (`<files-read>`, `<files-modified>`) were English all
 * along. A model that can write a Chinese paper can read an English header.
 */
export function formatFileOperations(ops: FileOperations): string {
  const modified = [...ops.written, ...ops.edited].sort();
  if (ops.read.length === 0 && modified.length === 0) return "";
  const parts = ["\n\n[Files this work has touched so far]"];
  if (ops.read.length > 0)
    parts.push(`<files-read>\n${ops.read.join("\n")}\n</files-read>`);
  if (modified.length > 0)
    parts.push(`<files-modified>\n${modified.join("\n")}\n</files-modified>`);
  return parts.join("\n");
}
