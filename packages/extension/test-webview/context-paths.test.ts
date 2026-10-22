import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWorkspaceRelative,
  canonicalizeGrantRoot,
  resolveGrantedPath,
} from "@lemmaria/harness";
import { afterAll, describe, expect, it } from "vitest";
import type { InsertCandidate } from "../src/webview/parts/completion.js";
import {
  type ContextPaths,
  type WalkedRoot,
  contextNote,
  pathCandidates,
  pathExclusions,
} from "../src/webview/parts/context-paths.js";

const noExclusions = {
  truncated: false,
  byDefault: 0,
  byGitignore: 0,
  bySkipDir: 0,
} as const;

function root(over: Partial<WalkedRoot> = {}): WalkedRoot {
  return { files: [], excluded: noExclusions, ...over };
}

function paths(over: Partial<ContextPaths> = {}): ContextPaths {
  return { grants: [], ...over };
}

const names = (rows: readonly InsertCandidate[]): string[] =>
  rows.map((r) => r.name);

describe("pathCandidates — the workspace half (D1)", () => {
  it("makes one row per file, and none at all with no workspace", () => {
    expect(
      names(
        pathCandidates(
          paths({ workspace: root({ files: ["a.tex", "b.tex"] }) }),
        ),
      ),
    ).toEqual(["a.tex", "b.tex"]);
    // No paper in context ⇒ the session's registry has no `workspace` at all
    // and `list_files` refuses outright. The menu mirrors that rather than
    // falling back to `workspaceFolders[0]`, which is a root the session is
    // not reading — offering it would be the one thing invariant 2 forbids.
    expect(pathCandidates(paths())).toEqual([]);
  });

  it("puts the discovered paper entry first, then shallowest-alphabetical", () => {
    // Design §2's stated order, using the harness's own `byShallowest` (T2) so
    // the menu and `discoverPaperEntry` cannot order the same tree differently.
    const rows = pathCandidates(
      paths({
        workspace: root({
          entry: "main.tex",
          files: ["sections/intro.tex", "zz.bib", "main.tex"],
        }),
      }),
    );
    expect(names(rows)).toEqual([
      "main.tex",
      "zz.bib",
      "sections/",
      "sections/intro.tex",
    ]);
  });

  it("orders a folder immediately before what is under it", () => {
    const rows = pathCandidates(
      paths({ workspace: root({ files: ["b/y.tex", "a/x.tex"] }) }),
    );
    expect(names(rows)).toEqual(["a/", "a/x.tex", "b/", "b/y.tex"]);
  });
});

describe("pathCandidates — folders are DERIVED, never walked (D2)", () => {
  it("offers every ancestor directory of a file, once", () => {
    const rows = pathCandidates(
      paths({
        workspace: root({ files: ["a/b/c/one.tex", "a/b/two.tex"] }),
      }),
    );
    expect(names(rows)).toEqual([
      "a/",
      "a/b/",
      "a/b/two.tex",
      "a/b/c/",
      "a/b/c/one.tex",
    ]);
  });

  it("EVERY folder candidate is a prefix of some file candidate", () => {
    // This is invariant 2 stated as a property of the output rather than as an
    // argument about walks: a folder exists only because a readable file lives
    // under it, so the menu cannot name a directory the model could not already
    // reach by listing. It also means every exclusion is inherited for free —
    // an ignored directory contributes no files, so it contributes no folder.
    const rows = pathCandidates(
      paths({
        workspace: root({ files: ["a/b/c/one.tex", "d/two.bib"] }),
        grants: [root({ qualifier: "code", files: ["src/deep/three.py"] })],
      }),
    );
    const all = names(rows);
    const files = all.filter((n) => !n.endsWith("/"));
    const folders = all.filter((n) => n.endsWith("/"));
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(
        files.some((f) => f.startsWith(folder) && f.length > folder.length),
      ).toBe(true);
    }
  });

  it("marks a folder with a trailing slash, which is what makes that literal", () => {
    // The slash is not decoration. It says "directory" in the row with no
    // chrome, it reads right in prose ("look in results/"), and it turns the
    // prefix property above into `file.startsWith(folder)` rather than a rule
    // about inserting a separator — which is one fewer place to get it wrong.
    const rows = pathCandidates(
      paths({ workspace: root({ files: ["results/final.csv"] }) }),
    );
    expect(names(rows)).toEqual(["results/", "results/final.csv"]);
  });

  it("gives an excluded directory neither files nor a folder row", () => {
    // The host's walks drop what they refuse BEFORE this module sees it, so
    // there is nothing here to filter — which is the point of deriving rather
    // than walking again. A tree whose only entry under `node_modules/` was
    // skipped arrives with no such file, and so yields no such folder.
    const rows = pathCandidates(
      paths({ workspace: root({ files: ["src/a.ts"] }) }),
    );
    expect(names(rows)).not.toContain("node_modules/");
  });

  it("never invents a folder for a bare root-level file", () => {
    expect(
      names(pathCandidates(paths({ workspace: root({ files: ["a.tex"] }) }))),
    ).toEqual(["a.tex"]);
  });
});

describe("pathCandidates — an insert NAMES its root (D3)", () => {
  it("inserts a bare relative path for the workspace", () => {
    const [row] = pathCandidates(
      paths({ workspace: root({ files: ["sections/intro.tex"] }) }),
    ).filter((r) => r.name.endsWith(".tex"));
    expect(row?.name).toBe("sections/intro.tex");
    expect(row?.insertion).toBe("@sections/intro.tex");
  });

  it("qualifies a granted path with the grant's own label", () => {
    // The capability envelope already declares `g1: <label> (<abs path>)` and
    // says the paper workspace is the default when `root` is omitted, so the
    // qualified and unqualified forms mirror the qualified and unqualified
    // calls. Nothing new has to be taught, and E3 writes no prompt.
    const rows = pathCandidates(
      paths({
        grants: [root({ qualifier: "codebase", files: ["results/final.csv"] })],
      }),
    );
    expect(names(rows)).toEqual([
      "codebase/results/",
      "codebase/results/final.csv",
    ]);
    for (const r of rows) expect(r.insertion).toBe(`@${r.name}`);
  });

  it("puts the workspace before the grants, and grants in their order", () => {
    const rows = pathCandidates(
      paths({
        workspace: root({ files: ["w.tex"] }),
        grants: [
          root({ qualifier: "one", files: ["a.py"] }),
          root({ qualifier: "two", files: ["b.py"] }),
        ],
      }),
    );
    expect(names(rows)).toEqual(["w.tex", "one/a.py", "two/b.py"]);
  });

  it("never emits an absolute path, which both guards refuse outright", () => {
    const rows = pathCandidates(
      paths({
        workspace: root({ files: ["a.tex"] }),
        grants: [root({ qualifier: "c", files: ["b.py"] })],
      }),
    );
    for (const r of rows) {
      const path = referenced(r.insertion);
      expect(path.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:/.test(path)).toBe(false);
    }
  });
});

describe("pathCandidates — whitespace is quoted, Codex's rule (D3)", () => {
  it("wraps a path containing a space in double quotes", () => {
    const [, row] = pathCandidates(
      paths({ workspace: root({ files: ["my notes/final draft.tex"] }) }),
    );
    // The row shows the path; the composer receives it quoted, so it reads as
    // one thing rather than as two. Codex quotes for its prompt-arg parser;
    // Lemmaria quotes for a model reading prose, and the effect is the same.
    expect(row?.name).toBe("my notes/final draft.tex");
    expect(row?.insertion).toBe('@"my notes/final draft.tex"');
  });

  it("quotes on the QUALIFIED string, since a grant label can hold a space", () => {
    const rows = pathCandidates(
      paths({ grants: [root({ qualifier: "my code", files: ["a.py"] })] }),
    );
    expect(rows[0]?.insertion).toBe('@"my code/a.py"');
  });

  it("leaves a path that already contains a quote alone", () => {
    // Codex's own escape, carried for its reason: quoting a quoted string is
    // worse than not quoting, and a filename with a quote in it is rare enough
    // that a simple rule beats an escaping scheme nothing else in the product
    // has.
    const rows = pathCandidates(
      paths({ workspace: root({ files: ['od"d name.tex'] }) }),
    );
    expect(rows[0]?.insertion).toBe('@od"d name.tex');
  });
});

describe("pathCandidates — the row shape (D5)", () => {
  it("carries no description, and the paths group", () => {
    const rows = pathCandidates(
      paths({ workspace: root({ files: ["a.tex"] }) }),
    );
    for (const r of rows) {
      expect(r.kind).toBe("insert");
      expect(r.group).toBe("paths");
      // A path has no description. Synthesising one ("in codebase") would
      // restate what the first segment already says, and it would compete for
      // the width the path itself needs.
      expect(r.description).toBe("");
    }
  });
});

describe("pathExclusions — counted, never silently dropped (B4 / A6)", () => {
  it("reports nothing when nothing was cut", () => {
    expect(
      pathExclusions(paths({ workspace: root({ files: ["a.tex"] }) })),
    ).toBeUndefined();
  });

  it("sums every root's counts and carries the truncated flag", () => {
    const summary = pathExclusions(
      paths({
        workspace: root({
          files: ["a.tex"],
          excluded: { ...noExclusions, bySkipDir: 2 },
        }),
        grants: [
          root({
            qualifier: "c",
            files: ["b.py"],
            excluded: {
              truncated: true,
              byDefault: 1,
              byGitignore: 3,
              bySkipDir: 4,
            },
          }),
        ],
      }),
    );
    expect(summary).toEqual({ truncated: true, hidden: 10 });
  });

  it("counts an ABSENT figure as unknown, never as zero", () => {
    // `list_files`' own distinction, carried: its workspace branch reports
    // `excludedByDefault: 0` (a fact — that walk applies no deny-list) and
    // OMITS the gitignore and skip-dir figures, because `VscodeWorkspace`
    // skips `node_modules` without counting it. A note that added those
    // absences in as zeroes would be asserting a total nobody measured.
    expect(
      pathExclusions(
        paths({
          workspace: root({
            files: ["a.tex"],
            excluded: { truncated: false, byDefault: 0 },
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("reports a truncated walk even when it hid nothing else", () => {
    // A6's failure in miniature: a walk that stopped at its cap has hidden an
    // unknown number of files, and reporting `hidden: 0` would be the invented
    // count that milestone added the counters to eliminate. The flag says
    // "there is more" without pretending to know how much.
    expect(
      pathExclusions(
        paths({
          workspace: root({
            files: ["a.tex"],
            excluded: { ...noExclusions, truncated: true },
          }),
        }),
      ),
    ).toEqual({ truncated: true, hidden: 0 });
  });
});

/**
 * Read the path back out of an insertion — the inverse of what the builder
 * writes, and the reason ADR 0053 keeps the sigil.
 *
 * Deliberately written HERE and not shipped as production code: nothing in the
 * product parses a message for references yet, and an exported parser with no
 * caller is a claim maintained by hand. What the round trip has to survive is
 * asserted below over every candidate the builder can produce, so the day a
 * parser is wired in it has a specification and a passing test to start from.
 */
function referenced(insertion: string): string {
  const body = insertion.startsWith("@") ? insertion.slice(1) : insertion;
  return body.startsWith('"') && body.endsWith('"') && body.length >= 2
    ? body.slice(1, -1)
    : body;
}

describe("every insertion is one the ENGINE's own guards accept (D3)", () => {
  // E2's row-10 shape in E3's vocabulary: the claim is checked against the
  // harness's real containment guards, imported, rather than against a copy of
  // their rules. A future tightening of either fails here instead of shipping a
  // row whose path the model will be refused for.
  const dir = mkdtempSync(join(tmpdir(), "lemmaria-e3-"));
  mkdirSync(join(dir, "results"), { recursive: true });
  writeFileSync(join(dir, "results", "final.csv"), "x\n", "utf8");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const grant = {
    id: "g1",
    path: canonicalizeGrantRoot(dir),
    label: "codebase",
  };

  const built = pathCandidates(
    paths({
      workspace: root({ entry: "main.tex", files: ["main.tex", "sec/a.tex"] }),
      grants: [root({ qualifier: grant.label, files: ["results/final.csv"] })],
    }),
  );

  it("resolves a granted insertion INSIDE the granted root", () => {
    const row = built.find((r) => r.name.endsWith("final.csv"));
    if (!row) throw new Error("no granted row");
    const rel = referenced(row.insertion).slice(`${grant.label}/`.length);
    const hit = resolveGrantedPath(grant, rel);
    expect(hit.refused).toBeUndefined();
    expect(hit.abs).toBe(join(grant.path, "results", "final.csv"));
  });

  it("passes every workspace insertion through `assertWorkspaceRelative`", () => {
    for (const row of built) {
      if (row.name.startsWith(`${grant.label}/`)) continue;
      expect(() =>
        assertWorkspaceRelative(referenced(row.insertion)),
      ).not.toThrow();
    }
  });

  it("round-trips: every insertion parses back to exactly its own name", () => {
    // ADR 0053's whole claim. The sigil is grammar, so a message carrying
    // `@${path}` can be read back for the paths it names — including the
    // quoted ones, which is where a naive split on whitespace would lose a
    // path with a space in it. Asserted over every row the builder emits
    // rather than over an example, because the property is what is being
    // claimed, not the case.
    expect(built.length).toBeGreaterThan(0);
    for (const row of built) {
      expect(row.insertion.startsWith("@")).toBe(true);
      expect(referenced(row.insertion)).toBe(row.name);
    }
  });

  it("round-trips a path whose name contains a space", () => {
    const spaced = pathCandidates(
      paths({ workspace: root({ files: ["my notes/final draft.tex"] }) }),
    );
    expect(spaced.length).toBeGreaterThan(0);
    for (const row of spaced) {
      expect(referenced(row.insertion)).toBe(row.name);
      expect(() =>
        assertWorkspaceRelative(referenced(row.insertion)),
      ).not.toThrow();
    }
  });

  it("is why the qualifier is a LABEL and not the grant id", () => {
    // `g1:results/final.csv` is not merely less readable than
    // `codebase/results/final.csv` — on Windows it is REFUSED, and refused with
    // `denied`, the code that tells the model never to retry. A colon in a
    // relative segment is an NTFS alternate-data-stream spelling, and
    // `resolveGrantedPath` denies it before resolving anything. A model that
    // did not split the id off would be told it had attempted an escape.
    const asId = resolveGrantedPath(grant, "g1:results/final.csv");
    if (process.platform === "win32") {
      expect(asId.code).toBe("denied");
    } else {
      // Elsewhere it merely misses, which is the softer half of the same
      // problem: `g1:` is a notation nothing downstream is taught.
      expect(asId.abs).toBeUndefined();
    }
    const asLabel = built.find((r) => r.name.endsWith("final.csv"));
    expect(asLabel?.insertion).toBe("@codebase/results/final.csv");
  });
});

describe("contextNote — three silences, told apart (E3 code review)", () => {
  const cut = (over: Record<string, number | boolean>) => ({
    truncated: false,
    byDefault: 0,
    byGitignore: 0,
    bySkipDir: 0,
    ...over,
  });

  it("names both ways out ONLY when there is no root at all", () => {
    expect(contextNote(paths(), "en")).toContain("Grant Folder Access");
  });

  it("does NOT tell a user to grant a folder they have already granted", () => {
    // The plan's own worked example: a granted results folder gitignored in
    // full. Zero rows — but the actionable advice is one the user has taken,
    // and the true answer is that something was excluded. Checked by the ROOTS
    // and not by the row count, which is what the first version got wrong.
    const granted = paths({
      grants: [
        root({
          qualifier: "results",
          files: [],
          excluded: cut({ byGitignore: 40 }),
        }),
      ],
    });
    expect(pathCandidates(granted)).toEqual([]);
    const note = contextNote(granted, "en");
    expect(note).not.toContain("Grant Folder Access");
    expect(note).toContain("40");
  });

  it("reports the count AND the cap when both are true", () => {
    // B4/A6: a precise number standing alone where an UNKNOWN remainder also
    // exists is the invented count the tool's counters removed. The first
    // version returned the hidden line and dropped the truncation entirely.
    const both = paths({
      workspace: root({
        files: ["a.tex"],
        excluded: cut({ truncated: true, bySkipDir: 12 }),
      }),
    });
    const note = contextNote(both, "en") ?? "";
    expect(note).toContain("12");
    expect(note).toMatch(/limit/);
  });

  it("says nothing at all when a real root is simply empty", () => {
    // Not a silence to explain: the menu's own empty state covers it.
    expect(contextNote(paths({ workspace: root() }), "en")).toBeUndefined();
  });

  it("renders in ONE language per reader, in both locales", () => {
    const both = paths({
      workspace: root({ files: ["a.tex"], excluded: cut({ bySkipDir: 3 }) }),
    });
    const en = contextNote(both, "en") ?? "";
    const zh = contextNote(both, "zh") ?? "";
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);
    expect(zh).toMatch(/[\u4e00-\u9fff]/);
    // Invariant 6: a string carrying both languages is a defect. The zh line
    // may carry the count's DIGITS and nothing else Latin.
    expect(zh.replace(/[0-9]/g, "")).not.toMatch(/[A-Za-z]/);
  });
});

describe("an unqualifiable root offers nothing (E3 code review)", () => {
  it("drops a grant whose label is empty rather than inserting `/path`", () => {
    // `basename(realpath(dir))` is "" for a drive or filesystem root, and
    // `${""}/${rel}` reads as an ABSOLUTE path — the one shape D3 forbids.
    const rows = pathCandidates(
      paths({
        grants: [root({ qualifier: "", files: ["results/final.csv"] })],
      }),
    );
    expect(rows).toEqual([]);
  });

  it("still offers a grant whose label is a normal basename", () => {
    // The guard must not catch the ordinary case it sits next to.
    const rows = pathCandidates(
      paths({ grants: [root({ qualifier: "codebase", files: ["a.csv"] })] }),
    );
    expect(names(rows)).toContain("codebase/a.csv");
  });

  it("does not mistake the WORKSPACE for an unqualifiable root", () => {
    // The workspace's qualifier is ABSENT, not empty — its paths are
    // deliberately unqualified, which is the engine's own default.
    const rows = pathCandidates(
      paths({ workspace: root({ files: ["a.tex"] }) }),
    );
    expect(names(rows)).toEqual(["a.tex"]);
  });
});

describe("the paper entry is a FILE, not a prepended string (E3 code review)", () => {
  it("derives the entry's ancestor folders even when it is not in `files`", () => {
    // `listFiles` can exceed LIST_FILES_MAX and be sliced, leaving an entry
    // outside the posted list. A candidate whose parent folders were never
    // derived breaks D2's containment property for no reason.
    const rows = names(
      pathCandidates(
        paths({
          workspace: root({ files: ["other.tex"], entry: "paper/main.tex" }),
        }),
      ),
    );
    expect(rows[0]).toBe("paper/main.tex");
    expect(rows).toContain("paper/");
    // And the property itself still holds over the whole set.
    for (const row of rows.filter((r) => r.endsWith("/"))) {
      expect(rows.some((f) => f !== row && f.startsWith(row))).toBe(true);
    }
  });

  it("does not duplicate the entry when it IS in `files`", () => {
    const rows = names(
      pathCandidates(
        paths({
          workspace: root({ files: ["main.tex", "b.tex"], entry: "main.tex" }),
        }),
      ),
    );
    expect(rows.filter((r) => r === "main.tex")).toHaveLength(1);
    expect(rows[0]).toBe("main.tex");
  });
});

describe("the webview may not reach the harness BARREL at runtime", () => {
  it("imports values only through a narrow subpath export", () => {
    // Found by the build, stated here so the next person gets a sentence
    // instead of 46 esbuild errors about the Anthropic SDK. `parts/` is bundled
    // for a browser; `@lemmaria/harness` re-exports the model adapters and
    // through them `node:fs`, so a value import from the barrel makes the
    // bundle unbuildable. TYPE imports are fine — they are erased — which is
    // why this looks at the import form and not merely at the specifier.
    // Resolved from this file, for the reason `styles.test.ts` records: under
    // jsdom `import.meta.url` is an http URL and `readdirSync` refuses it.
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "webview",
      "parts",
    );
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      // Comments are stripped first: a doc comment above an import routinely
      // contains the word "from", and a scanner that did not strip them would
      // report the prose rather than the binding.
      const src = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");
      for (const m of src.matchAll(
        /import\s+([^;]*?)from\s+"@lemmaria\/harness"/g,
      )) {
        const clause = m[1] ?? "";
        if (/^\s*type\s/.test(clause)) continue; // `import type { … }` — erased
        const bare = clause
          .replace(/[{}]/g, "")
          .split(",")
          .map((b) => b.trim())
          .filter((b) => b !== "" && !b.startsWith("type "));
        if (bare.length > 0) offenders.push(`${file}: ${bare.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
