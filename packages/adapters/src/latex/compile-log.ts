import { createHash } from "node:crypto";
import type { Severity, Warning } from "@lemmaria/harness";

/**
 * Parses a TeX compile-log transcript into the unified {@link Warning} shape
 * (S3 spike outcome, docs/plans/05-s3-compile-log-parsing-spike.md).
 *
 * The parse source is the pdfTeX `.log` transcript, which is identical whether
 * pdflatex is run directly or driven by latexmk — so `"latexmk"` and the
 * (deferred, same-seam) `"tectonic"` source share the LaTeX-warning matchers and
 * differ only in the `source` tag they stamp on each Warning. ok/fail is the
 * child exit code, NOT anything in here — this only extracts diagnostics.
 *
 * Deliberate limits (recorded): file attribution defaults to the entry file
 * (paren-tracking across \input deferred); pdfTeX's 79-column line-wrapping of
 * very long warning lines is not un-wrapped (short lines parse fine).
 */
export type CompileLogSource = "latexmk" | "tectonic";

interface ParseOpts {
  source: CompileLogSource;
  entryFile: string;
}

/** Strip the volatile bits so the same warning keeps one id across recompiles. */
function normalizeMessage(message: string): string {
  return message
    .replace(/on page \d+/g, "")
    .replace(/\([\d.]+pt too wide\)/g, "")
    .replace(/\(badness \d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable key for a finding: hash(code + file + normalizedMessage). */
export function warningId(w: Omit<Warning, "id">): string {
  return createHash("sha1")
    .update(`${w.code}|${w.file}|${normalizeMessage(w.message)}`)
    .digest("hex")
    .slice(0, 16);
}

type PartialWarning = Omit<Warning, "id" | "source" | "file">;

/** A `LaTeX Warning:` / `Overfull` / `Underfull` line → a partial Warning, or null. */
function matchWarningLine(line: string): PartialWarning | null {
  let m = line.match(
    /^LaTeX Warning: Reference `(.+?)' .*?on input line (\d+)/,
  );
  if (m) {
    return {
      severity: "warning",
      code: "undefined-ref",
      message: `Reference \`${m[1]}' undefined`,
      line: Number(m[2]),
    };
  }
  m = line.match(/^LaTeX Warning: Citation `(.+?)' .*?on input line (\d+)/);
  if (m) {
    return {
      severity: "warning",
      code: "undefined-citation",
      message: `Citation \`${m[1]}' undefined`,
      line: Number(m[2]),
    };
  }
  m = line.match(/^Overfull \\([hv])box \(.+?\) .*?at lines? (\d+)/);
  if (m) {
    return {
      severity: "warning",
      code: `overfull-${m[1]}box`,
      message: line.trim(),
      line: Number(m[2]),
    };
  }
  m = line.match(/^Underfull \\([hv])box \(.+?\) .*?at lines? (\d+)/);
  if (m) {
    return {
      severity: "info",
      code: `underfull-${m[1]}box`,
      message: line.trim(),
      line: Number(m[2]),
    };
  }
  // Generic LaTeX warning tied to a source line (summary lines like "There were
  // undefined references." lack "on input line" and are dropped by this guard).
  m = line.match(/^LaTeX Warning: (.+?) on input line (\d+)/);
  if (m) {
    return {
      severity: "warning",
      code: "latex-warning",
      message: (m[1] ?? "").trim(),
      line: Number(m[2]),
    };
  }
  return null;
}

/** Resolve an error `! ...` line's location: embedded `on input line N`, else the next `l.N`. */
function errorLine(lines: string[], i: number): number | undefined {
  const embedded = lines[i]?.match(/on input line (\d+)/);
  if (embedded) return Number(embedded[1]);
  for (let j = i + 1; j < lines.length && j < i + 40; j++) {
    const lj = lines[j];
    if (lj === undefined || lj.startsWith("! ")) break;
    const l = lj.match(/^l\.(\d+)/);
    if (l) return Number(l[1]);
  }
  return undefined;
}

function matchErrorLine(lines: string[], i: number): PartialWarning | null {
  const line = lines[i];
  if (line === undefined || !line.startsWith("! ")) return null;
  const at = errorLine(lines, i);
  const base = {
    severity: "error" as Severity,
    ...(at !== undefined ? { line: at } : {}),
  };
  if (/^! Undefined control sequence\./.test(line)) {
    return {
      ...base,
      code: "undefined-control-sequence",
      message: "Undefined control sequence",
    };
  }
  const latex = line.match(/^! LaTeX Error: (.+)$/);
  if (latex) {
    return {
      ...base,
      code: "latex-error",
      message: (latex[1] ?? "").replace(/\.$/, ""),
    };
  }
  return {
    ...base,
    code: "tex-error",
    message: line.replace(/^! /, "").replace(/\.$/, ""),
  };
}

export function parseCompileLog(log: string, opts: ParseOpts): Warning[] {
  const lines = log.split(/\r?\n/);
  const out: Warning[] = [];
  const seen = new Set<string>();
  const push = (p: PartialWarning | null): void => {
    if (!p) return;
    const w: Warning = {
      ...p,
      source: opts.source,
      file: opts.entryFile,
      id: warningId({ ...p, source: opts.source, file: opts.entryFile }),
    };
    if (seen.has(w.id)) return;
    seen.add(w.id);
    out.push(w);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("! ")) push(matchErrorLine(lines, i));
    else push(matchWarningLine(line));
  }
  return out;
}

/**
 * Final page count from a pdfTeX/latexmk transcript's
 * "Output written on main.pdf (7 pages, ...)" line; the LAST occurrence wins
 * (latexmk reruns log one per pass). Absent (e.g. a failed compile) → undefined.
 */
export function parseOutputPages(log: string): number | undefined {
  let pages: number | undefined;
  for (const m of log.matchAll(/Output written on .*?\((\d+) pages?[,)]/g)) {
    pages = Number(m[1]);
  }
  return pages;
}
