/**
 * Live end-to-end Compile Check integration (env-gated). Drives the REAL chain
 * — FsWorkspace → compileProject (spawns latexmk) → LatexAdapter.verify →
 * parseCompileLog — over clean / warn / fail fixtures, asserting the reported
 * findings. Skipped unless LEMMARIA_COMPILE_TESTS=1 (CI has no TeX toolchain);
 * the parser has full TeX-free coverage elsewhere.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLatexAdapter } from "@lemmaria/adapters";
import { afterAll, describe, expect, it } from "vitest";
import { FsWorkspace } from "../src/run-action.js";

const LIVE = process.env.LEMMARIA_COMPILE_TESTS === "1";
const suite = LIVE ? describe : describe.skip;

const CLEAN =
  "\\documentclass{article}\n\\begin{document}\nA clean paragraph with enough words to typeset.\n\\end{document}\n";
const WARN =
  "\\documentclass{article}\n\\begin{document}\nSee \\ref{fig:missing} for details.\n\\end{document}\n";
const FAIL =
  "\\documentclass{article}\n\\begin{document}\n\\thismacrodoesnotexist\n\\end{document}\n";

suite("adapter.verify (live latexmk)", () => {
  const temps: string[] = [];
  afterAll(async () => {
    await Promise.all(
      temps.map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  const project = async (tex: string): Promise<FsWorkspace> => {
    const root = await mkdtemp(join(tmpdir(), "lemmaria-verify-"));
    temps.push(root);
    await writeFile(join(root, "main.tex"), tex, "utf8");
    return new FsWorkspace(root, "main.tex");
  };
  const adapterFor = async (ws: FsWorkspace) =>
    loadLatexAdapter(ws, "main.tex", { workspace: ws, engine: "pdflatex" });

  it("clean project → ok, no warnings", async () => {
    const ws = await project(CLEAN);
    const adapter = await adapterFor(ws);
    const res = await adapter.verify();
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  }, 60_000);

  it("warn project → ok with an undefined-ref reported", async () => {
    const ws = await project(WARN);
    const adapter = await adapterFor(ws);
    const res = await adapter.verify();
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain("undefined-ref");
  }, 60_000);

  it("fail project → ok:false", async () => {
    const ws = await project(FAIL);
    const adapter = await adapterFor(ws);
    const res = await adapter.verify();
    expect(res.ok).toBe(false);
  }, 60_000);
});
