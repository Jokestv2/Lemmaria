import { dirname, join } from "node:path";
import type { CompileResult } from "../contracts/adapters.js";
import type { ReviewPdfSource } from "../contracts/data.js";

/**
 * Which PDF a review reads (V3, ADR 0080 §8).
 *
 * A **pure policy** over injected reads: it stats and reads through functions
 * the caller supplies, and compiles through one too, so it is testable without
 * a file system and carries no host dependency. Nothing here writes.
 *
 * The order is deliberate, and each rule exists because the one above it
 * cannot serve the case below:
 *
 *  1. a PDF the **user named** wins as it is — they said so, and a Markdown
 *     project has no other route to one;
 *  2. otherwise the first **fresh** candidate beside the entry or under the
 *     two conventional output directories;
 *  3. otherwise **compile** one, when the caller gave us a way to;
 *  4. otherwise say honestly which of the two kinds of nothing it was.
 */

/** The output directories LaTeX-Workshop's two conventions use (S6). */
export const PDF_OUTPUT_DIRS = ["out", "build"] as const;

/**
 * How much older than the newest manuscript file a PDF may be and still count
 * as fresh.
 *
 * Two seconds, because a build that finishes a moment before an editor
 * autosaves an untouched buffer would otherwise read as stale and force a
 * 15-second recompile for nothing. The cost of the slack is the opposite
 * error — a PDF built just before a real edit reading fresh — which is
 * recorded as a deliberate limit rather than engineered away.
 */
export const PDF_FRESHNESS_SLACK_MS = 2_000;

export type ReviewPdfOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      source: ReviewPdfSource;
      path?: string;
      /** The user's named PDF, older than the manuscript. Used anyway, flagged. */
      stale?: true;
    }
  | {
      ok: false;
      /**
       * `none` — no candidate existed at all.
       * `stale` — one existed but was older than the manuscript, and this run
       *           had no way to compile a fresh one.
       * `compile_failed` — we tried; `detail` carries the log's tail.
       *
       * `render_failed` is the CALLER's to record, because it happens after
       * this policy has handed over bytes: it is the renderer refusing them.
       */
      reason: "none" | "stale" | "compile_failed" | "render_failed";
      detail?: string;
    };

export interface ReviewPdfInput {
  /** Root-relative entry file of the review. */
  entry: string;
  /** The manuscript's files; their newest mtime is the freshness bar. */
  files: Iterable<string>;
  /** `lemmaria.paperPdf`, root-relative, when the user set one. */
  namedPdf?: string;
  stat: (relPath: string) => Promise<{ mtimeMs: number } | undefined>;
  readBinary: (relPath: string) => Promise<Uint8Array>;
  /** Absent ⇒ this run cannot compile, and rule 3 is skipped. */
  compile?: () => Promise<CompileResult>;
}

/** How many lines of a failed compile's log the outcome carries. */
const COMPILE_DETAIL_LINES = 20;

/** Normalise to forward slashes so a joined path reads the same everywhere. */
const rel = (...parts: string[]): string => join(...parts).replace(/\\/g, "/");

/**
 * The candidates, in preference order: beside the entry first (the common
 * case, and the one a user would point at), then the two output directories
 * relative to the entry, then the same two at the ROOT for a nested entry.
 *
 * Both `out/` and `build/` are searched whatever `SKIP_DIR` names, so the
 * shadow-copy filter's asymmetry is not inherited by the one place it would
 * matter (ADR 0080 §10).
 */
function candidatesFor(entry: string): string[] {
  const dir = dirname(entry);
  const base = entry.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const here = dir === "." || dir === "" ? "" : dir;
  const out: string[] = [];
  const push = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  push(here ? rel(here, `${base}.pdf`) : `${base}.pdf`);
  for (const d of PDF_OUTPUT_DIRS) {
    push(here ? rel(here, d, `${base}.pdf`) : rel(d, `${base}.pdf`));
  }
  // A nested entry's project may still put its output at the root.
  if (here) for (const d of PDF_OUTPUT_DIRS) push(rel(d, `${base}.pdf`));
  return out;
}

export async function resolveReviewPdf(
  input: ReviewPdfInput,
): Promise<ReviewPdfOutcome> {
  // The injected ports are the HOST's, and every real one can throw where this
  // module's own contract says *degrade*: `assertWorkspaceRelative` sits
  // outside the `try` in both `stat` implementations, neither `readBinary` has
  // one at all, and `FsWorkspace.compile` rejects outright with no entry bound.
  // A throw out of here would reach the caller as an exception, past all four
  // of the honest refusal reasons this function exists to return.
  //
  // So a throw is read as **absence**, which is what every one of them means
  // here: a file that cannot be stat-ed or read is a file this resolution
  // cannot use, and the next rule down is the answer. That is already how a
  // missing file is treated three lines below — the guard only stops the
  // *manner* of the absence from changing the outcome.
  // The return types are DERIVED from the port rather than restated, so a
  // change to `ReviewPdfInput` cannot leave a copy of its shape here to drift.
  const statOf = async (
    path: string,
  ): Promise<Awaited<ReturnType<ReviewPdfInput["stat"]>>> => {
    try {
      return await input.stat(path);
    } catch {
      return undefined;
    }
  };
  const readOf = async (path: string): Promise<Uint8Array | undefined> => {
    try {
      return await input.readBinary(path);
    } catch {
      return undefined;
    }
  };

  /** The newest manuscript file's mtime — the bar a candidate must clear. */
  let newest = 0;
  for (const file of input.files) {
    // A file we cannot stat is IGNORED rather than treated as infinitely new:
    // one unreadable `\input` should not condemn every PDF as stale.
    const s = await statOf(file);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  const isFresh = (mtimeMs: number): boolean =>
    mtimeMs + PDF_FRESHNESS_SLACK_MS >= newest;

  // 1 — the user named one.
  if (input.namedPdf) {
    const named = await statOf(input.namedPdf);
    const bytes = named ? await readOf(input.namedPdf) : undefined;
    if (named && bytes) {
      return {
        ok: true,
        bytes,
        source: "named",
        path: input.namedPdf,
        // Used ANYWAY when stale: the user said which file, and a Markdown
        // project has no compile to fall back to. Flagged, never overridden.
        ...(isFresh(named.mtimeMs) ? {} : { stale: true as const }),
      };
    }
    // A named PDF that does not exist falls through to discovery rather than
    // failing: a path typed once and since moved should not blind the review.
  }

  // 2 — the first fresh candidate.
  let sawStaleCandidate = false;
  const candidates = candidatesFor(input.entry);
  for (const [index, path] of candidates.entries()) {
    const s = await statOf(path);
    if (!s) continue;
    if (!isFresh(s.mtimeMs)) {
      sawStaleCandidate = true;
      continue;
    }
    // A candidate that stats but will not read is not a candidate. Falling to
    // the next one is right: the alternative is failing the whole resolution
    // on a file the next rule might have replaced anyway.
    const bytes = await readOf(path);
    if (!bytes) continue;
    return {
      ok: true,
      bytes,
      source: index === 0 ? "beside_entry" : "output_dir",
      path,
    };
  }

  // 3 — compile one, if this run can.
  if (input.compile) {
    let result: CompileResult;
    try {
      result = await input.compile();
    } catch (error) {
      // A compile that THREW and a compile that reported failure are the same
      // finding for a reader — there is no PDF and here is why — so they take
      // the same reason, and the message becomes the detail the log would be.
      return {
        ok: false,
        reason: "compile_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok && result.pdf) {
      return { ok: true, bytes: result.pdf, source: "compiled" };
    }
    return {
      ok: false,
      reason: "compile_failed",
      detail: result.log.split("\n").slice(-COMPILE_DETAIL_LINES).join("\n"),
    };
  }

  // 4 — say which kind of nothing it was. `stale` and `none` are different
  // findings: one means recompile, the other means there is no PDF at all.
  return { ok: false, reason: sawStaleCandidate ? "stale" : "none" };
}
