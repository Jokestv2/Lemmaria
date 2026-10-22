/**
 * Host-agnostic compile helper for Compile Check (X1; built at M5). A `Workspace.compile`
 * implementation delegates here: it materializes the three-layer overlay (staged
 * working copies over the on-disk project) into a throwaway shadow directory,
 * spawns the resolved engine there, and returns the child exit status + the
 * pdfTeX `.log` transcript for the adapter to parse (S3 outcome).
 *
 * Node `child_process`/`fs` only — allowed in the harness (the invariant forbids
 * `vscode`, not Node); this is the same code Phase 2 runs server-side. The
 * harness's own orchestration never calls this directly — it always goes through
 * the injected `Workspace.compile`; hosts share this so the spawn logic is
 * written and tested once.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { CompileResult } from "../contracts/adapters.js";

export interface CompileProjectOptions {
  /** Project root on disk. */
  root: string;
  /** Entry `.tex` relative to root (M5: the active file). */
  entry: string;
  /** Resolved engine (see harness `resolveEngine`). */
  engine: string;
  /** Staged working-copy overlay (relPath → content) applied over the disk tree. */
  workingCopies: Map<string, string>;
  /** Whole-compile timeout; default 120s. */
  timeoutMs?: number;
  /**
   * Hand back the PDF the run produced, in memory (V3, ADR 0080 §8).
   *
   * Absent ⇒ the result is byte-identical to before this option existed, so
   * Compile Check and the `verify` tool are unchanged. Bytes rather than a
   * path, deliberately: the one consumer loads the document into memory
   * anyway, and a path would leave a temp file someone must delete.
   */
  wantPdf?: boolean;
}

const SKIP_DIR = /[\\/](\.git|node_modules|out|dist|\.vscode-test)([\\/]|$)/;
const SKIP_ARTIFACT = /\.(log|aux|fdb_latexmk|fls|pdf|synctex\.gz|out|toc)$/;

/** A path's last component, whichever separator it was written with. */
const lastPart = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * Should this path be copied into the shadow directory (V3, ADR 0080 §10)?
 *
 * **Tested RELATIVE to the root, which is the correction.** `cp`'s filter
 * receives `src`, the full absolute path, and the shipped code tested
 * `SKIP_DIR` against it — so a project living under a directory named `out`,
 * `dist`, `node_modules`, `.git` or `.vscode-test` had its OWN sources
 * filtered out and could not compile at all. S6 found it; this is a correction
 * of the filter's matching, not of the rule it encodes.
 *
 * `SKIP_DIR`'s set is unchanged: `build` is still copied, `out` still dropped.
 * Only where the pattern is anchored moved.
 *
 * **Only the ENTRY's own build artifacts are dropped** (V4 round 4, ADR 0085
 * §1). `SKIP_ARTIFACT` used to drop every file with one of its suffixes, and
 * `.pdf` is one — so a paper's `figures/*.pdf` never reached the shadow and
 * every paper with a PDF figure failed to compile. What the filter keeps out
 * is a previous build of THIS document — its PDF, its `.aux`, latexmk's
 * database, which would let latexmk call a stale build current — and those
 * are named after the entry (`main.pdf` for `main.tex`) and sit where this
 * compile writes them and reads them back: the root, latexmk's cwd, and the
 * entry's own directory. A file of the same name anywhere else — a
 * supplement's `supplement/main.pdf` that the paper `\includepdf`s, a stale
 * `build/main.pdf` nothing reads — is material, and is copied.
 */
export function shouldCopyIntoShadow(
  root: string,
  src: string,
  entry: string,
): boolean {
  const rel = relative(root, src);
  // The root itself relativises to "", and is ALWAYS copied — this has to be
  // decided before any pattern runs, or the same class of bug D11 fixed comes
  // back through the other test: `SKIP_ARTIFACT` is `$`-anchored against the
  // path, so a workspace whose own directory is named `thesis.out` matched it,
  // `cp`'s filter rejected the root, and the shadow directory came out empty —
  // the identical "could not find file 'main.tex'" symptom, from one line up.
  // (Found by V3's code review, 2026-09-22.)
  if (rel === "") return true;
  if (isEntryArtifact(rel, entry)) return false;
  // A leading separator, so SKIP_DIR's own leading-separator term applies
  // unchanged — adjusting the input is safer than loosening the pattern.
  return !SKIP_DIR.test(`/${rel}`);
}

/** A root-relative path's directory, `""` at the root, `/`-separated. */
const dirOf = (path: string): string =>
  path.split(/[\\/]/).slice(0, -1).join("/");

/**
 * `main.pdf`, `main.aux`, `main.fdb_latexmk`, … for the entry `main.tex`, at
 * the root or beside the entry — the two places `readArtifact` looks. `rel` is
 * root-relative.
 */
function isEntryArtifact(rel: string, entry: string): boolean {
  const name = lastPart(rel);
  const suffix = SKIP_ARTIFACT.exec(name);
  if (suffix === null) return false;
  const base = lastPart(entry).replace(/\.tex$/i, "");
  if (name.slice(0, suffix.index) !== base) return false;
  const dir = dirOf(rel);
  return dir === "" || dir === dirOf(entry);
}

/** Engine → [command, args]. Unknown engines are spawned directly (surfaces a clear miss). */
function engineCommand(engine: string, entry: string): [string, string[]] {
  switch (engine) {
    case "pdflatex":
    case "latexmk":
      return ["latexmk", ["-pdf", "-interaction=nonstopmode", entry]];
    case "xelatex":
      return ["latexmk", ["-pdfxe", "-interaction=nonstopmode", entry]];
    case "lualatex":
      return ["latexmk", ["-pdflua", "-interaction=nonstopmode", entry]];
    case "tectonic":
      return ["tectonic", ["--keep-logs", "--chatter", "minimal", entry]];
    default:
      return [engine, [entry]];
  }
}

interface SpawnOutcome {
  code: number | null;
  output: string;
  spawnError?: string;
}

function runEngine(
  cwd: string,
  engine: string,
  entry: string,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  const [command, args] = engineCommand(engine, entry);
  return new Promise<SpawnOutcome>((resolvePromise) => {
    // No shell: Windows CreateProcess auto-resolves `.exe` (latexmk.exe), so we
    // avoid the shell-injection surface and the shell+args deprecation warning.
    const child = spawn(command, args, { cwd });
    let output = "";
    const collect = (b: Buffer): void => {
      output += b.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

async function readLog(shadow: string, entry: string): Promise<string> {
  const base = basename(entry).replace(/\.tex$/i, "");
  const candidates = [
    join(shadow, `${base}.log`),
    join(shadow, dirname(entry), `${base}.log`),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // try next candidate
    }
  }
  return "";
}

/**
 * The PDF the run wrote, from the two places the engines put it (V3, ADR 0080
 * §8): `latexmk` writes beside its `cwd`, which is the shadow root, and
 * `tectonic` writes beside its input. The same two candidates `readLog` hedges
 * across, and for the same reason.
 */
async function readPdf(
  shadow: string,
  entry: string,
): Promise<Uint8Array | undefined> {
  const found = await readArtifact(shadow, entry, "pdf");
  return found === undefined ? undefined : new Uint8Array(found);
}

/** The run's `.aux`, from the same two places as its PDF (ADR 0084). */
async function readAux(
  shadow: string,
  entry: string,
): Promise<string | undefined> {
  return (await readArtifact(shadow, entry, "aux"))?.toString("utf8");
}

async function readArtifact(
  shadow: string,
  entry: string,
  ext: "pdf" | "aux",
): Promise<Buffer | undefined> {
  const base = basename(entry).replace(/\.tex$/i, "");
  const candidates = [
    join(shadow, `${base}.${ext}`),
    join(shadow, dirname(entry), `${base}.${ext}`),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

export async function compileProject(
  opts: CompileProjectOptions,
): Promise<CompileResult> {
  const { root, entry, engine, workingCopies, timeoutMs = 120_000 } = opts;
  const shadow = await mkdtemp(join(tmpdir(), "lemmaria-compile-"));
  try {
    await cp(root, shadow, {
      recursive: true,
      filter: (src) => shouldCopyIntoShadow(root, src, entry),
    });
    for (const [rel, content] of workingCopies) {
      const dest = join(shadow, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    const { code, output, spawnError } = await runEngine(
      shadow,
      engine,
      entry,
      timeoutMs,
    );
    const log = (await readLog(shadow, entry)) || spawnError || output;
    // Read BEFORE the `finally` destroys the shadow. A missing PDF leaves
    // `pdf` undefined with `ok` whatever the engine said — the report is still
    // a report (ADR 0013), it simply carries no artifact.
    const pdf = opts.wantPdf ? await readPdf(shadow, entry) : undefined;
    // The aux travels only with a PDF: without one it describes nothing.
    const aux = pdf ? await readAux(shadow, entry) : undefined;
    return {
      ok: code === 0,
      log,
      ...(pdf ? { pdf } : {}),
      ...(aux !== undefined ? { aux } : {}),
    };
  } finally {
    await rm(shadow, { recursive: true, force: true }).catch(() => {});
  }
}
