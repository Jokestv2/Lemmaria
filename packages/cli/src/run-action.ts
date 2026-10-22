/**
 * CLI wiring for the action engine: a disk-backed Workspace port, the real
 * LatexAdapter, and the built-in action set — the "CLI runs Polish end to end"
 * M3 acceptance path (and the CI integration-test entry the architecture's
 * Testing Strategy calls for).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadLatexAdapter } from "@lemmaria/adapters";
import {
  ActionEngineError,
  type BudgetCeilings,
  type CompileResult,
  type MemoryInput,
  type ModelAdapter,
  type ModelBinding,
  type RunActionResult,
  type Workspace,
  assertWorkspaceRelative,
  compileProject,
  directoryPaperCandidates,
  matchesFileGlob,
  runAction,
  shouldSkipDir,
} from "@lemmaria/harness";
// Node-ESM-only loader (uses import.meta.url); kept out of the barrel so it
// never enters the CJS extension bundle. See harness/src/index.ts.
import { loadBuiltinActions } from "@lemmaria/harness/builtin-actions";

export class FsWorkspace implements Workspace {
  /** Staged working copies (apply_edit writes land here, never on disk). */
  readonly workingCopies = new Map<string, string>();

  /** `entry` (the project's main .tex) is required for compile/verify (M5). */
  constructor(
    readonly root: string,
    readonly entry?: string,
  ) {}

  readFile(relPath: string): Promise<string> {
    // Root containment (M8): model-supplied `file` args reach this port.
    try {
      assertWorkspaceRelative(relPath);
    } catch (error) {
      return Promise.reject(error);
    }
    const staged = this.workingCopies.get(relPath);
    if (staged !== undefined) return Promise.resolve(staged);
    return readFile(resolve(this.root, relPath), "utf8");
  }

  writeWorkingCopy(relPath: string, content: string): Promise<void> {
    try {
      assertWorkspaceRelative(relPath);
    } catch (error) {
      return Promise.reject(error);
    }
    this.workingCopies.set(relPath, content);
    return Promise.resolve();
  }

  async listFiles(glob?: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) await walk(full);
        } else {
          const rel = relative(this.root, full).replaceAll("\\", "/");
          if (matchesFileGlob(rel, glob)) out.push(rel);
        }
      }
    };
    await walk(this.root);
    return out.sort();
  }

  compile(
    engine: string,
    opts?: { wantPdf?: boolean },
  ): Promise<CompileResult> {
    if (!this.entry) {
      return Promise.reject(
        new Error(
          "FsWorkspace.compile: no entry file bound (construct with one)",
        ),
      );
    }
    return compileProject({
      root: this.root,
      entry: this.entry,
      engine,
      workingCopies: this.workingCopies,
      ...(opts?.wantPdf ? { wantPdf: true } : {}),
    });
  }

  /**
   * The file's size and mtime, or `undefined` when it does not exist (V3, ADR
   * 0080 §8). Root-contained through the same guard `readFile` uses, because
   * the path can reach here from a setting the user typed.
   */
  async stat(
    relPath: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    assertWorkspaceRelative(relPath);
    try {
      const s = await stat(resolve(this.root, relPath));
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return undefined;
    }
  }

  /** The file's raw bytes — for the compiled PDF, which is not text. */
  async readBinary(relPath: string): Promise<Uint8Array> {
    assertWorkspaceRelative(relPath);
    return new Uint8Array(await readFile(resolve(this.root, relPath)));
  }
}

export const STUB_BINDING: ModelBinding = {
  protocol: "anthropic",
  endpoint: "stub://",
  model: "stub",
  apiKey: "",
};

export interface CliRunOptions {
  root: string;
  entry: string;
  actionId: string;
  selection: { file?: string; start: number; end: number };
  params?: Record<string, unknown>;
  model: ModelAdapter;
  binding?: ModelBinding;
  ceilings?: Partial<BudgetCeilings>;
}

export async function runCliAction(
  opts: CliRunOptions,
): Promise<RunActionResult> {
  const workspace = new FsWorkspace(opts.root, opts.entry);
  // FileReader is a structural subset of Workspace, so the workspace doubles as
  // the adapter's reader — both see the same three-layer content resolution.
  const adapter = await loadLatexAdapter(workspace, opts.entry);

  const { actions, errors } = await loadBuiltinActions();
  const loaded = actions.find((a) => a.definition.id === opts.actionId);
  if (!loaded) {
    const available = actions.map((a) => a.definition.id).join(", ");
    const failures = errors
      .map((e) => `${e.filePath}: ${e.message}`)
      .join("; ");
    throw new ActionEngineError(
      "unknown_action",
      `unknown action "${opts.actionId}"; available: ${available}${
        failures ? `; load errors: ${failures}` : ""
      }`,
    );
  }

  const memory = await loadMemoryInput(opts.root, opts.entry);

  return runAction({
    action: loaded.definition,
    adapter,
    workspace,
    model: opts.model,
    binding: opts.binding ?? STUB_BINDING,
    selection: {
      file: opts.selection.file ?? opts.entry,
      startOffset: opts.selection.start,
      endOffset: opts.selection.end,
    },
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    ...(opts.ceilings !== undefined ? { ceilings: opts.ceilings } : {}),
    memory,
  });
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * CM1 layer loading (M8): the user-global `~/.lemmaria/MEMORY.md`
 * (`LEMMARIA_MEMORY_DIR` overrides the `.lemmaria` dir for hermetic tests),
 * the project `PAPER.md` at the root, and the nearest directory-level
 * `PAPER.md` between the entry file and the root.
 */
export async function loadMemoryInput(
  root: string,
  entry: string,
): Promise<MemoryInput> {
  const memoryDir =
    process.env.LEMMARIA_MEMORY_DIR ?? join(homedir(), ".lemmaria");
  const global = await tryRead(join(memoryDir, "MEMORY.md"));
  const project = await tryRead(resolve(root, "PAPER.md"));
  let directory: string | undefined;
  for (const candidate of directoryPaperCandidates(entry)) {
    directory = await tryRead(resolve(root, candidate));
    if (directory !== undefined) break;
  }
  return {
    ...(global !== undefined ? { global } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(directory !== undefined ? { directory } : {}),
  };
}
