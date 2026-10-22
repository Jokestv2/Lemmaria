import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRelative,
  byShallowest,
  discoverPaperEntry,
  matchesFileGlob,
  paperEntryCandidates,
  shouldSkipDir,
} from "../../src/engine/workspace-utils.js";

/** A Workspace stand-in over a flat path→content map. */
function fakeWorkspace(files: Record<string, string>) {
  return {
    listFiles: async (glob?: string) =>
      Object.keys(files)
        .filter((f) => matchesFileGlob(f, glob))
        .sort(),
    readFile: async (rel: string) => {
      const hit = files[rel];
      if (hit === undefined) throw new Error(`no such file: ${rel}`);
      return hit;
    },
  };
}

describe("shouldSkipDir", () => {
  it("skips vcs/artifact directories and dot-dirs", () => {
    expect(shouldSkipDir(".git")).toBe(true);
    expect(shouldSkipDir("node_modules")).toBe(true);
    expect(shouldSkipDir(".vscode-test")).toBe(true);
    expect(shouldSkipDir("dist")).toBe(true);
    expect(shouldSkipDir("out")).toBe(true);
    expect(shouldSkipDir(".cache")).toBe(true);
  });

  it("keeps ordinary content directories", () => {
    expect(shouldSkipDir("chapters")).toBe(false);
    expect(shouldSkipDir("figures")).toBe(false);
  });
});

// Model-supplied `file` arguments (read_span, replace_anchor) reach
// Workspace.readFile — the port is root-contained, so an escaping path must be
// rejected BEFORE it touches the filesystem (invariant 2: the allowlist is the
// capability boundary; it must not leak through path arguments).
describe("assertWorkspaceRelative", () => {
  it("accepts ordinary workspace-relative paths", () => {
    expect(assertWorkspaceRelative("main.tex")).toBe("main.tex");
    expect(assertWorkspaceRelative("chapters/intro.tex")).toBe(
      "chapters/intro.tex",
    );
    expect(assertWorkspaceRelative("./main.tex")).toBe("./main.tex");
    // interior .. that stays inside the root is fine once normalized
    expect(assertWorkspaceRelative("chapters/../main.tex")).toBe(
      "chapters/../main.tex",
    );
  });

  it("rejects parent-directory escapes", () => {
    expect(() => assertWorkspaceRelative("..")).toThrow(/escapes/);
    expect(() => assertWorkspaceRelative("../outside.txt")).toThrow(/escapes/);
    expect(() => assertWorkspaceRelative("..\\outside.txt")).toThrow(/escapes/);
    expect(() => assertWorkspaceRelative("a/../../outside.txt")).toThrow(
      /escapes/,
    );
  });

  it("rejects absolute paths (posix, windows drive, UNC)", () => {
    expect(() => assertWorkspaceRelative("/etc/passwd")).toThrow(/escapes/);
    expect(() =>
      assertWorkspaceRelative("C:\\Users\\me\\.ssh\\id_rsa"),
    ).toThrow(/escapes/);
    expect(() => assertWorkspaceRelative("C:/Users/me/.ssh/id_rsa")).toThrow(
      /escapes/,
    );
    expect(() => assertWorkspaceRelative("\\\\server\\share\\x")).toThrow(
      /escapes/,
    );
  });
});

// The session's read tools used to exist only when the user had a .tex/.md
// editor FOCUSED, while the write root already fell back to the workspace
// folder — so an agent asked to read a file it was allowed to edit had no read
// tool at all and reached for propose_edit instead (D4 manual round).
describe("discoverPaperEntry", () => {
  it("picks the LaTeX root by \\documentclass, not by filename", async () => {
    const ws = fakeWorkspace({
      "abstract.tex": "This paper studies\n",
      "thesis.tex": "\\documentclass[11pt]{article}\n\\begin{document}\n",
      "sections/intro.tex": "\\section{Introduction}\n",
    });
    expect(await discoverPaperEntry(ws)).toBe("thesis.tex");
  });

  it("prefers the shallowest \\documentclass when a template ships one too", async () => {
    const ws = fakeWorkspace({
      "main.tex": "\\documentclass{article}\n",
      "styles/sample/demo.tex": "\\documentclass{article}\n",
    });
    expect(await discoverPaperEntry(ws)).toBe("main.tex");
  });

  it("falls back to the shallowest .tex when nothing declares a class", async () => {
    const ws = fakeWorkspace({
      "sections/intro.tex": "\\section{Introduction}\n",
      "notes.tex": "scratch\n",
    });
    expect(await discoverPaperEntry(ws)).toBe("notes.tex");
  });

  it("uses Markdown when the folder has no LaTeX, deprioritizing README", async () => {
    const ws = fakeWorkspace({
      "README.md": "# How to build\n",
      "paper.md": "# A study of things\n",
    });
    expect(await discoverPaperEntry(ws)).toBe("paper.md");
  });

  it("still answers when README is the only Markdown", async () => {
    expect(
      await discoverPaperEntry(fakeWorkspace({ "README.md": "# x\n" })),
    ).toBe("README.md");
  });

  it("returns undefined for a folder with no paper at all", async () => {
    const ws = fakeWorkspace({ "train.py": "print(1)\n", "data.csv": "a,b\n" });
    expect(await discoverPaperEntry(ws)).toBeUndefined();
  });

  it("survives an unreadable candidate rather than failing the session", async () => {
    const ws = {
      listFiles: async (glob?: string) =>
        ["broken.tex", "main.tex"].filter((f) => matchesFileGlob(f, glob)),
      readFile: async (rel: string) => {
        if (rel === "broken.tex") throw new Error("EACCES");
        return "\\documentclass{article}\n";
      },
    };
    expect(await discoverPaperEntry(ws)).toBe("main.tex");
  });
});

/**
 * ADR 0062 §2 — the R3 gate-review round. A project can hold several
 * standalone documents (the paper, its supplementary, a rebuttal), and
 * `discoverPaperEntry` picks exactly one. This is the set it picked FROM.
 */
describe("paperEntryCandidates", () => {
  it("offers every \\documentclass file, shallowest first", async () => {
    const ws = fakeWorkspace({
      "supplementary.tex": "\\documentclass{article}\n",
      "main.tex": "\\documentclass{article}\n",
      "sections/intro.tex": "\\section{Introduction}\n",
      "rebuttal/rebuttal.tex": "\\documentclass{article}\n",
    });
    const files = await paperEntryCandidates(ws);
    // Every entry discovery would consider — and nothing that is only an
    // \input'd fragment, which is not a document a panel can be pointed at.
    expect(files).toContain("main.tex");
    expect(files).toContain("supplementary.tex");
    expect(files).toContain("rebuttal/rebuttal.tex");
    expect(files).not.toContain("sections/intro.tex");
    // Shallowest first, so a nested one never heads the list.
    expect(files[files.length - 1]).toBe("rebuttal/rebuttal.tex");
    // And the list always contains what discovery would have chosen, because
    // it is the same probe over the same ordering.
    expect(files).toContain(await discoverPaperEntry(ws));
  });

  it("ignores a \\documentclass that is commented out", async () => {
    const ws = fakeWorkspace({
      "main.tex": "\\documentclass{article}\n",
      "old.tex": "% \\documentclass{article}\n",
    });
    expect(await paperEntryCandidates(ws)).toEqual(["main.tex"]);
  });

  it("falls back to Markdown, offering README and PAPER.md too", async () => {
    // Discovery drops those two because it is guessing and they usually are
    // not the paper. A picker is not guessing: refusing to offer the file the
    // user is telling us IS their paper would be the heuristic overruling the
    // human — and in a Markdown-only project it could leave the list empty.
    expect(
      await paperEntryCandidates(
        fakeWorkspace({ "README.md": "# build\n", "paper.md": "# study\n" }),
      ),
    ).toEqual(["paper.md", "README.md"]);
    expect(await paperEntryCandidates(fakeWorkspace({}))).toEqual([]);
  });

  it("survives an unreadable candidate, exactly as discovery does", async () => {
    const ws = {
      listFiles: async (glob?: string) =>
        ["broken.tex", "main.tex"].filter((f) => matchesFileGlob(f, glob)),
      readFile: async (rel: string) => {
        if (rel === "broken.tex") throw new Error("EACCES");
        return "\\documentclass{article}\n";
      },
    };
    expect(await paperEntryCandidates(ws)).toEqual(["main.tex"]);
  });
});

describe("byShallowest", () => {
  // Exported at E3 so the composer's `@` menu orders its candidates by the
  // rule `discoverPaperEntry` already applies, rather than by a second copy of
  // it in the extension. One home for one ordering.

  it("puts a shallower path first whatever the alphabet says", () => {
    expect(["styles/a.tex", "z.tex"].sort(byShallowest)).toEqual([
      "z.tex",
      "styles/a.tex",
    ]);
  });

  it("breaks a depth tie alphabetically, and stably", () => {
    expect(["b/y.tex", "a/x.tex", "b/x.tex"].sort(byShallowest)).toEqual([
      "a/x.tex",
      "b/x.tex",
      "b/y.tex",
    ]);
  });

  it("is the ordering `discoverPaperEntry` itself probes in", async () => {
    // Not a restatement of the two above: it pins that the exported comparator
    // is the one the discovery path uses, so a later edit to either cannot
    // silently give the menu a different order from the paper probe. The root
    // file wins over the deeper one even though it sorts later.
    const ws = fakeWorkspace({
      "styles/demo.tex": "documentclass{article}",
      "zz.tex": "documentclass{article}",
    });
    expect(await discoverPaperEntry(ws)).toBe("zz.tex");
  });
});

describe("matchesFileGlob", () => {
  it("matches everything without a glob", () => {
    expect(matchesFileGlob("a/b.tex")).toBe(true);
  });

  it("supports *.ext and **/*.ext as case-insensitive suffix filters", () => {
    expect(matchesFileGlob("a/b.tex", "*.tex")).toBe(true);
    expect(matchesFileGlob("a/b.TEX", "**/*.tex")).toBe(true);
    expect(matchesFileGlob("a/b.bib", "*.tex")).toBe(false);
  });
});
