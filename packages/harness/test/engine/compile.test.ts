import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compileProject,
  shouldCopyIntoShadow,
} from "../../src/engine/compile.js";

const LIVE = process.env.LEMMARIA_COMPILE_TESTS === "1";
// `shouldCopyIntoShadow` relativises with the host's `node:path`, so a path
// written with backslashes is only a path on Windows — on POSIX `\` is a
// filename character and those cases describe input that cannot occur.
const WINDOWS = process.platform === "win32";

describe("compileProject", () => {
  const temps: string[] = [];
  afterAll(async () => {
    await Promise.all(
      temps.map((d) => rm(d, { recursive: true, force: true })),
    );
  });
  const mkRoot = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "lemmaria-compile-test-"));
    temps.push(d);
    return d;
  };

  it("returns ok:false without throwing when the engine binary is missing", async () => {
    const root = await mkRoot();
    await writeFile(join(root, "main.tex"), "\\documentclass{article}", "utf8");
    const res = await compileProject({
      root,
      entry: "main.tex",
      engine: "lemmaria-no-such-engine-binary",
      workingCopies: new Map(),
    });
    expect(res.ok).toBe(false);
    expect(typeof res.log).toBe("string");
  });

  // 20s: spawning the (possibly missing) engine binary can take seconds under
  // full-suite parallel load on Windows; the default 5s flaked the gate run.
  it(
    "compiles the staged working copy, not the on-disk file (overlay)",
    { timeout: 20_000 },
    async () => {
      const root = await mkRoot();
      // On-disk file is BROKEN; the staged working copy is clean. The overlay must win.
      await writeFile(join(root, "main.tex"), "\\undefinedmacro", "utf8");
      const staged = new Map([
        [
          "main.tex",
          "\\documentclass{article}\\begin{document}Hello overlay.\\end{document}",
        ],
      ]);
      const res = await compileProject({
        root,
        entry: "main.tex",
        engine: "pdflatex",
        workingCopies: staged,
      });
      if (!LIVE) {
        // Without a TeX toolchain we only assert the no-throw contract + shape.
        expect(typeof res.ok).toBe("boolean");
        return;
      }
      expect(res.ok).toBe(true);
      expect(res.log).toMatch(/Output written on/);
    },
  );
});

describe("shouldCopyIntoShadow — the filter is relative to the root (V3, ADR 0080 §10)", () => {
  // The shipped bug: SKIP_DIR was tested against `src`, the FULL absolute
  // path, so a project whose OWN path contained a directory named `out`,
  // `dist`, `node_modules`, `.git` or `.vscode-test` had its own sources
  // filtered out and could not compile at all (S6's finding).
  const root = "/home/ana/papers/out/neurips";
  /** Every case below reviews `main.tex`: the filter learned the entry at V4
   *  round 4, and no expected value here moved with it. */
  const copies = (r: string, src: string): boolean =>
    shouldCopyIntoShadow(r, src, "main.tex");

  it("keeps the project's own files under a root whose path contains out/ or dist/", () => {
    expect(copies(root, `${root}/main.tex`)).toBe(true);
    expect(copies(root, `${root}/sections/intro.tex`)).toBe(true);
    const distRoot = "/w/dist/paper";
    expect(copies(distRoot, `${distRoot}/main.tex`)).toBe(true);
    const gitRoot = "/w/.git-backups/paper";
    expect(copies(gitRoot, `${gitRoot}/main.tex`)).toBe(true);
  });

  it("keeps the root itself", () => {
    expect(copies(root, root)).toBe(true);
  });

  it("keeps a root whose OWN name ends in an artifact suffix", () => {
    // The same bug as above, one line further down: `SKIP_ARTIFACT` is
    // `$`-anchored against the path, so a workspace directory named
    // `thesis.out` matched it, `cp`'s filter rejected the root, and the
    // shadow came out empty with the identical "could not find file
    // 'main.tex'" symptom. Found by V3's code review, 2026-09-22.
    for (const name of ["thesis.out", "draft.log", "paper.toc", "notes.aux"]) {
      const odd = `/home/ana/${name}`;
      expect(copies(odd, odd)).toBe(true);
      expect(copies(odd, `${odd}/main.tex`)).toBe(true);
      // And its own artifacts are still dropped, by their own names.
      expect(copies(odd, `${odd}/main.log`)).toBe(false);
    }
  });

  it("still drops the skipped directories INSIDE the root", () => {
    for (const dir of ["out", "dist", "node_modules", ".git", ".vscode-test"]) {
      expect(copies(root, `${root}/${dir}`)).toBe(false);
      expect(copies(root, `${root}/${dir}/main.tex`)).toBe(false);
      expect(copies(root, `${root}/a/${dir}/b.tex`)).toBe(false);
    }
  });

  it("`build` is still COPIED — SKIP_DIR's set did not change, only its matching", () => {
    expect(copies(root, `${root}/build/main.tex`)).toBe(true);
  });

  it("still drops every SKIP_ARTIFACT suffix, including a pre-built pdf", () => {
    for (const ext of ["log", "aux", "fdb_latexmk", "fls", "pdf", "toc"]) {
      expect(copies(root, `${root}/main.${ext}`)).toBe(false);
    }
    expect(copies(root, `${root}/main.synctex.gz`)).toBe(false);
  });

  it.skipIf(!WINDOWS)("works with Windows separators", () => {
    const sep = String.fromCharCode(92); // a literal backslash
    const win = ["C:", "Users", "ana", "out", "paper"].join(sep);
    expect(copies(win, [win, "main.tex"].join(sep))).toBe(true);
    expect(copies(win, [win, "out", "main.tex"].join(sep))).toBe(false);
    // A root under a Windows `out\` directory still copies its own sources —
    // the whole point of the fix, on the platform the build machine runs.
    expect(copies(win, [win, "sections", "a.tex"].join(sep))).toBe(true);
  });
});

describe("shouldCopyIntoShadow — only the ENTRY's build artifacts are dropped (V4 round 4)", () => {
  // Round 4's finding 1: SKIP_ARTIFACT dropped every `.pdf` in the tree, so
  // `figures/teaser.pdf` never reached the shadow directory and any paper with
  // a PDF figure failed with `pdftex.def Error: File 'figures/teaser.pdf' not
  // found`. What the filter exists to keep out is a previous build of the
  // document being compiled — its PDF, its `.aux`, latexmk's database — and
  // those are all named after the entry.
  const root = "/home/ana/paper";

  it("copies a figure, an included PDF and data files that share an artifact suffix", () => {
    for (const path of [
      "figures/teaser.pdf",
      "figures/pipeline.pdf",
      "supplement.pdf",
      "data/train.log",
      "results/table.out",
      "chapters/intro.aux",
    ]) {
      expect(shouldCopyIntoShadow(root, `${root}/${path}`, "main.tex")).toBe(
        true,
      );
    }
  });

  it("drops the entry's own artifacts beside it — where the compile writes and reads them", () => {
    const suffixes = [
      "pdf",
      "aux",
      "log",
      "fdb_latexmk",
      "fls",
      "synctex.gz",
      "out",
      "toc",
    ];
    for (const ext of suffixes) {
      expect(
        shouldCopyIntoShadow(root, `${root}/main.${ext}`, "main.tex"),
      ).toBe(false);
    }
  });

  it("copies a file named like the entry's artifact elsewhere in the tree (the code review)", () => {
    // `\includepdf{supplement/main.pdf}` — a supplement compiled from its
    // own `main.tex` — is material. So is a stale `build/main.pdf`: the
    // compile writes to the shadow's root and never reads `build/` back.
    for (const path of [
      "supplement/main.pdf",
      "figures/main.pdf",
      "build/main.pdf",
      "build/main.fdb_latexmk",
    ]) {
      expect(shouldCopyIntoShadow(root, `${root}/${path}`, "main.tex")).toBe(
        true,
      );
    }
  });

  it("names the artifacts after THIS entry, and a nested entry by its own base name", () => {
    expect(shouldCopyIntoShadow(root, `${root}/paper.pdf`, "paper.tex")).toBe(
      false,
    );
    // Another document's PDF is material, not this build's output.
    expect(shouldCopyIntoShadow(root, `${root}/main.pdf`, "paper.tex")).toBe(
      true,
    );
    // A nested entry's build lands at the shadow's root (latexmk's cwd) or
    // beside it — the two places the compile reads a PDF back from.
    expect(
      shouldCopyIntoShadow(root, `${root}/doc/main.pdf`, "doc/main.tex"),
    ).toBe(false);
    expect(shouldCopyIntoShadow(root, `${root}/main.pdf`, "doc/main.tex")).toBe(
      false,
    );
    expect(
      shouldCopyIntoShadow(root, `${root}/doc/figures/a.pdf`, "doc/main.tex"),
    ).toBe(true);
    expect(
      shouldCopyIntoShadow(
        root,
        `${root}/doc/figures/main.pdf`,
        "doc/main.tex",
      ),
    ).toBe(true);
  });

  it.skipIf(!WINDOWS)(
    "works with Windows separators in the path and the entry",
    () => {
      const sep = String.fromCharCode(92); // a literal backslash
      const win = ["C:", "Users", "ana", "paper"].join(sep);
      const entry = ["doc", "main.tex"].join(sep);
      expect(
        shouldCopyIntoShadow(win, [win, "doc", "main.pdf"].join(sep), entry),
      ).toBe(false);
      expect(
        shouldCopyIntoShadow(
          win,
          [win, "figures", "teaser.pdf"].join(sep),
          entry,
        ),
      ).toBe(true);
    },
  );
});

describe.skipIf(!LIVE)(
  "compileProject hands back the PDF when asked (V3, ADR 0080 §8)",
  () => {
    const temps: string[] = [];
    afterAll(async () => {
      await Promise.all(
        temps.map((d) => rm(d, { recursive: true, force: true })),
      );
    });
    const mkRoot = async (): Promise<string> => {
      const d = await mkdtemp(join(tmpdir(), "lemmaria-compile-pdf-"));
      temps.push(d);
      return d;
    };
    const tex = String.fromCharCode(92); // a literal LaTeX backslash
    const DOC = [
      `${tex}documentclass{article}`,
      `${tex}begin{document}`,
      "Hello from V3.",
      `${tex}end{document}`,
    ].join("\n");

    it(
      "a FLAT entry comes back with %PDF- bytes",
      { timeout: 120_000 },
      async () => {
        const root = await mkRoot();
        await writeFile(join(root, "main.tex"), DOC, "utf8");
        const res = await compileProject({
          root,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(res.ok).toBe(true);
        expect(res.pdf).toBeInstanceOf(Uint8Array);
        expect(
          Buffer.from(res.pdf as Uint8Array)
            .subarray(0, 5)
            .toString(),
        ).toBe("%PDF-");
      },
    );

    it(
      "the .aux the same run wrote comes back beside the PDF (ADR 0084)",
      { timeout: 120_000 },
      async () => {
        const root = await mkRoot();
        const labelled = DOC.replace(
          "Hello from V3.",
          `Hello from V3.${tex}label{sec:hello}`,
        );
        await writeFile(join(root, "main.tex"), labelled, "utf8");
        const res = await compileProject({
          root,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(res.ok).toBe(true);
        expect(res.aux).toContain(`${tex}newlabel{sec:hello}`);
      },
    );

    it(
      "a NESTED entry comes back too — the two candidate locations",
      { timeout: 120_000 },
      async () => {
        const root = await mkRoot();
        await mkdir(join(root, "paper"), { recursive: true });
        await writeFile(join(root, "paper", "main.tex"), DOC, "utf8");
        const res = await compileProject({
          root,
          entry: "paper/main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(res.ok).toBe(true);
        expect(
          Buffer.from(res.pdf as Uint8Array)
            .subarray(0, 5)
            .toString(),
        ).toBe("%PDF-");
      },
    );

    it(
      "WITHOUT the option the result is byte-identical to today's {ok, log}",
      { timeout: 120_000 },
      async () => {
        const root = await mkRoot();
        await writeFile(join(root, "main.tex"), DOC, "utf8");
        const res = await compileProject({
          root,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
        });
        expect(res.pdf).toBeUndefined();
        expect(Object.keys(res).sort()).toEqual(["log", "ok"]);
      },
    );

    it(
      "a paper whose figure is a .pdf COMPILES — V4 round 4's finding 1, end to end",
      { timeout: 120_000 },
      async () => {
        // The figure is a real PDF: the bytes of a first compile, written
        // where a paper keeps its figures. Before round 4 the shadow copy
        // dropped it and pdfTeX stopped on `File 'figures/teaser.pdf' not
        // found`.
        const figureRoot = await mkRoot();
        await writeFile(join(figureRoot, "main.tex"), DOC, "utf8");
        const figure = await compileProject({
          root: figureRoot,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(figure.pdf).toBeDefined();

        const root = await mkRoot();
        await mkdir(join(root, "figures"), { recursive: true });
        await writeFile(
          join(root, "figures", "teaser.pdf"),
          figure.pdf as Uint8Array,
        );
        const withFigure = [
          `${tex}documentclass{article}`,
          `${tex}usepackage{graphicx}`,
          `${tex}begin{document}`,
          `${tex}includegraphics[width=0.5${tex}linewidth]{figures/teaser.pdf}`,
          `${tex}end{document}`,
        ].join("\n");
        await writeFile(join(root, "main.tex"), withFigure, "utf8");
        const res = await compileProject({
          root,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(res.log).not.toMatch(/not found/);
        expect(res.ok).toBe(true);
        expect(res.pdf).toBeDefined();
      },
    );

    it(
      "a paper under a directory named out/ COMPILES — the fix, end to end",
      { timeout: 120_000 },
      async () => {
        const base = await mkRoot();
        const root = join(base, "out", "neurips");
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "main.tex"), DOC, "utf8");
        const res = await compileProject({
          root,
          entry: "main.tex",
          engine: "pdflatex",
          workingCopies: new Map(),
          wantPdf: true,
        });
        expect(res.ok).toBe(true);
        expect(res.pdf).toBeDefined();
      },
    );
  },
);
