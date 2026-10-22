import * as path from "node:path";
import { parseOutputPages } from "@lemmaria/adapters";
import {
  type CompileProjectOptions,
  type CompileResult,
  type Workspace,
  assertWorkspaceRelative,
  compileProject,
  matchesFileGlob,
  shouldSkipDir,
} from "@lemmaria/harness";
import * as vscode from "vscode";

/** Compile implementation — swapped in ext-host tests (no TeX toolchain there). */
type CompileImpl = (opts: CompileProjectOptions) => Promise<CompileResult>;
let compileImpl: CompileImpl = compileProject;
export function setCompileForTests(fn?: CompileImpl): void {
  compileImpl = fn ?? compileProject;
}
export function clearCompileForTests(): void {
  compileImpl = compileProject;
}
/** True when a test compile is injected — verify-ui then skips the PATH probe. */
export function isCompileOverridden(): boolean {
  return compileImpl !== compileProject;
}
/** The active compile impl (test override honored) — venue-ui's baseline compile. */
export function currentCompileImpl(): CompileImpl {
  return compileImpl;
}

/** Page counts from the most recent compile, keyed by absolute entry path (U4 Venue tab). */
const lastPagesByEntry = new Map<string, number | undefined>();

function entryKey(fsPath: string): string {
  const n = path.normalize(fsPath);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export function lastCompilePages(entryFsPath: string): number | undefined {
  return lastPagesByEntry.get(entryKey(entryFsPath));
}

function pathsEqual(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === "win32"
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * The Workspace port over the VS Code API. readFile resolves the three layers
 * of truth nearest-first (ADR 0002): staged working copy → open editor buffer
 * (dirty or not) → disk.
 */
export class VscodeWorkspace implements Workspace {
  readonly workingCopies = new Map<string, string>();

  /** `entry` (project main .tex) is required for compile/verify (M5). */
  constructor(
    readonly root: string,
    readonly entry?: string,
  ) {}

  private absUri(relPath: string): vscode.Uri {
    return vscode.Uri.file(path.resolve(this.root, relPath));
  }

  async readFile(relPath: string): Promise<string> {
    // Root containment (M8): model-supplied `file` args reach this port.
    assertWorkspaceRelative(relPath);
    const staged = this.workingCopies.get(relPath);
    if (staged !== undefined) return staged;
    const target = this.absUri(relPath);
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && pathsEqual(d.uri.fsPath, target.fsPath),
    );
    if (open) return open.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(target)).toString(
      "utf8",
    );
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
    // Shared M8 walk spec (harness workspace-utils): skip vcs/artifact dirs,
    // honor the *.ext glob subset — same behavior as FsWorkspace.
    const out: string[] = [];
    const walk = async (dir: vscode.Uri, rel: string): Promise<void> => {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
        const childRel = rel === "" ? name : `${rel}/${name}`;
        if (type === vscode.FileType.Directory) {
          if (!shouldSkipDir(name)) {
            await walk(vscode.Uri.joinPath(dir, name), childRel);
          }
        } else if (matchesFileGlob(childRel, glob)) {
          out.push(childRel);
        }
      }
    };
    await walk(vscode.Uri.file(this.root), "");
    return out.sort();
  }

  /**
   * Compile the three-layer overlay (staged working copies → dirty editor
   * buffers → disk, ADR 0002) via the host-agnostic harness helper, which
   * materializes it into a shadow dir before spawning the engine (M5).
   */
  async compile(
    engine: string,
    opts?: { wantPdf?: boolean },
  ): Promise<CompileResult> {
    if (!this.entry) {
      throw new Error("VscodeWorkspace.compile: no entry file bound");
    }
    const overlay = new Map(this.workingCopies);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file" || !doc.isDirty) continue;
      const rel = path
        .relative(this.root, doc.uri.fsPath)
        .replaceAll("\\", "/");
      if (rel.startsWith("..")) continue;
      if (!overlay.has(rel)) overlay.set(rel, doc.getText());
    }
    const result = await compileImpl({
      root: this.root,
      entry: this.entry,
      engine,
      workingCopies: overlay,
      ...(opts?.wantPdf ? { wantPdf: true } : {}),
    });
    // Every host compile flows through here (Compile Check, venue baseline) —
    // the one choke-point where the raw log is visible for the page-count record.
    lastPagesByEntry.set(
      entryKey(path.join(this.root, this.entry)),
      parseOutputPages(result.log),
    );
    return result;
  }

  /**
   * The file's size and mtime, or `undefined` when it does not exist (V3, ADR
   * 0080 §8). Root-contained through the same guard the reads use.
   *
   * `vscode.workspace.fs.stat` reports `mtime` in MILLISECONDS, which is what
   * the policy compares against.
   */
  async stat(
    relPath: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    assertWorkspaceRelative(relPath);
    try {
      const s = await vscode.workspace.fs.stat(this.absUri(relPath));
      return { mtimeMs: s.mtime, size: s.size };
    } catch {
      return undefined;
    }
  }

  /** The file's raw bytes — for the compiled PDF, which is not text. */
  async readBinary(relPath: string): Promise<Uint8Array> {
    assertWorkspaceRelative(relPath);
    return await vscode.workspace.fs.readFile(this.absUri(relPath));
  }
}
