import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GrantedRoot } from "../../src/contracts/index.js";
import {
  DENY_READ_PATTERNS,
  GRANT_WALK_MAX_FILES,
  canonicalizeGrantRoot,
  deniedReason,
  isWithinRoot,
  resolveGrantedPath,
  walkGrantedRoot,
} from "../../src/engine/grants.js";

const temps: string[] = [];
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

function mkTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "lemmaria-grant-"));
  temps.push(d);
  return d;
}

/** A granted root over a real temp dir (already canonical via the API). */
function grant(dir: string): GrantedRoot {
  return { id: "g1", path: canonicalizeGrantRoot(dir), label: "fixture" };
}

describe("canonicalizeGrantRoot", () => {
  it("resolves to an absolute realpath for a directory", () => {
    const dir = mkTemp();
    const canon = canonicalizeGrantRoot(dir);
    expect(canon).toBe(canonicalizeGrantRoot(canon)); // idempotent
    expect(isWithinRoot(canon, join(canon, "x"))).toBe(true);
  });

  it("throws an honest error for a missing path and for a file", () => {
    const dir = mkTemp();
    writeFileSync(join(dir, "f.txt"), "x");
    expect(() => canonicalizeGrantRoot(join(dir, "nope"))).toThrow(/grant/i);
    expect(() => canonicalizeGrantRoot(join(dir, "f.txt"))).toThrow(
      /not a (directory|folder)/i,
    );
  });
});

describe("resolveGrantedPath (realpath containment, ADR 0019)", () => {
  it("accepts both slash styles for a nested file", () => {
    const dir = mkTemp();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "x.txt"), "hello");
    const g = grant(dir);
    const fwd = resolveGrantedPath(g, "sub/x.txt");
    const back = resolveGrantedPath(g, "sub\\x.txt");
    expect(fwd.refused).toBeUndefined();
    expect(back.refused).toBeUndefined();
    expect(fwd.abs).toBe(back.abs);
  });

  it("refuses lexical escapes: .., absolute, drive, UNC", () => {
    const dir = mkTemp();
    const g = grant(dir);
    for (const bad of [
      "../out.txt",
      "..\\out.txt",
      "/etc/passwd",
      "C:\\Windows\\system.ini",
      "C:/x",
      "\\\\server\\share\\f",
    ]) {
      const r = resolveGrantedPath(g, bad);
      expect(r.refused, bad).toMatch(/escape|granted root/i);
    }
  });

  it("refuses a junction/symlink that escapes the root (realpath re-check)", () => {
    const outside = mkTemp();
    writeFileSync(join(outside, "secret.txt"), "s3cret");
    const dir = mkTemp();
    symlinkSync(outside, join(dir, "leak"), "junction");
    const g = grant(dir);
    const r = resolveGrantedPath(g, "leak/secret.txt");
    expect(r.refused).toMatch(/escape/i);
  });

  it("reports a missing file honestly", () => {
    const dir = mkTemp();
    const g = grant(dir);
    expect(resolveGrantedPath(g, "nope.txt").refused).toMatch(/no such file/i);
  });

  it("refuses a deny-listed file reached through an in-root symlink (realpath re-check)", () => {
    const dir = mkTemp();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
    // A link INSIDE the root that resolves to the root's own .git — the string
    // "docs/config" is not deny-listed, but its realpath is.
    symlinkSync(join(dir, ".git"), join(dir, "docs"), "junction");
    const g = grant(dir);
    const r = resolveGrantedPath(g, "docs/config");
    expect(r.refused).toMatch(/excluded by default/i);
  });

  it("refuses an NTFS alternate-data-stream spelling of a denied file (win32)", () => {
    if (process.platform !== "win32") return;
    const dir = mkTemp();
    writeFileSync(join(dir, ".env"), "SECRET=1");
    const g = grant(dir);
    // ".env::$DATA" reads the same bytes as ".env" but dodges a naive segment
    // match; a colon is not a legal NTFS filename char, so refuse it outright.
    const r = resolveGrantedPath(g, ".env::$DATA");
    expect(r.refused).toBeDefined();
  });

  it("refuses any path segment containing a colon on win32 (ADS / drive-relative)", () => {
    if (process.platform !== "win32") return;
    const dir = mkTemp();
    writeFileSync(join(dir, "notes.txt"), "x");
    const g = grant(dir);
    expect(resolveGrantedPath(g, "notes.txt:stream").refused).toBeDefined();
  });
});

describe("deniedReason (the default deny-read list)", () => {
  it("denies the pinned classes wherever they sit in the path", () => {
    for (const rel of [
      ".env",
      ".env.local",
      "conf/.env.production",
      "sub/.git/config",
      "id_rsa",
      "keys/id_ed25519",
      "cert.pem",
      "server.key",
      "credentials.json",
      "gcp-credentials.json",
      "credentials",
      ".netrc",
      ".npmrc",
    ]) {
      expect(deniedReason(rel), rel).toMatch(/excluded by default/i);
    }
  });

  it("passes ordinary research files", () => {
    for (const rel of [
      "main.py",
      "results.csv",
      "environment.yml",
      "README.md",
      "src/train.py",
      "envelope.txt", // not .env*
      "identify.ts", // not id_*? (id_ prefix required)
    ]) {
      expect(deniedReason(rel), rel).toBeUndefined();
    }
  });

  it("exports the pattern list for the ADR/UI to cite", () => {
    expect(DENY_READ_PATTERNS).toContain(".env");
    expect(DENY_READ_PATTERNS).toContain("*.pem");
  });
});

describe("walkGrantedRoot", () => {
  it("lists nested files; skips node_modules, dot-dirs, gitignored and denied files", () => {
    const dir = mkTemp();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".venv"));
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "src", "train.py"), "print('hi')");
    writeFileSync(join(dir, "run.log"), "noise");
    writeFileSync(join(dir, "node_modules", "pkg", "x.js"), "x");
    writeFileSync(join(dir, ".venv", "pyvenv.cfg"), "x");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, "results.csv"), "a,b");
    const { files, truncated, excludedByDefault } = walkGrantedRoot(grant(dir));
    expect(truncated).toBe(false);
    expect(files).toContain("src/train.py");
    expect(files).toContain("results.csv");
    // .gitignore itself is listable; the denied/.ignored ones are not.
    expect(files.some((f) => f.endsWith("run.log"))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".venv"))).toBe(false);
    expect(files.some((f) => f.endsWith(".env"))).toBe(false);
    expect(excludedByDefault).toBe(1);
  });

  it("counts what .gitignore and the skip-dirs hid, instead of hiding it too (A6)", () => {
    // The Experiments flagship reads a RESULTS folder, and results are
    // routinely gitignored — so a silent drop made `list_files` return an
    // empty-but-clean-looking listing of exactly the artifacts the task needs.
    const dir = mkTemp();
    mkdirSync(join(dir, "results"));
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, ".gitignore"), "results/\n*.png\n");
    writeFileSync(join(dir, "results", "run1.csv"), "a,b");
    writeFileSync(join(dir, "results", "run2.csv"), "a,b");
    writeFileSync(join(dir, "plot.png"), "x");
    writeFileSync(join(dir, "main.py"), "x");
    writeFileSync(join(dir, "node_modules", "pkg", "x.js"), "x");
    writeFileSync(join(dir, "build", "out.o"), "x");

    const walked = walkGrantedRoot(grant(dir));

    // Still lists what it should.
    expect(walked.files).toContain("main.py");
    expect(walked.files.some((f) => f.startsWith("results/"))).toBe(false);
    // ...and now SAYS that it hid things, rather than looking clean.
    //
    // EXACT counts, because the counting rule is the deliverable: these are
    // BOUNDARY counts. One ignored directory (results/) counts ONCE — not
    // once per file inside it — plus one ignored file (plot.png) ⇒ 2. If the
    // walk ever recursed into an ignored directory to count its contents,
    // this would read 3 and fail, which is the point.
    expect(walked.excludedByGitignore).toBe(2);
    // node_modules + build, refused at the boundary by shouldSkipDir.
    expect(walked.excludedBySkipDir).toBe(2);
  });

  it("reports zero exclusions for a clean root (A6)", () => {
    const dir = mkTemp();
    writeFileSync(join(dir, "a.py"), "x");
    const walked = walkGrantedRoot(grant(dir));
    expect(walked.excludedByGitignore).toBe(0);
    expect(walked.excludedBySkipDir).toBe(0);
    expect(walked.excludedByDefault).toBe(0);
  });

  it("applies a nested .gitignore negation", () => {
    const dir = mkTemp();
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, ".gitignore"), "*.csv\n");
    writeFileSync(join(dir, "data", ".gitignore"), "!small.csv\n");
    writeFileSync(join(dir, "big.csv"), "x");
    writeFileSync(join(dir, "data", "big.csv"), "x");
    writeFileSync(join(dir, "data", "small.csv"), "x");
    const { files } = walkGrantedRoot(grant(dir));
    expect(files).toContain("data/small.csv");
    expect(files.some((f) => f.endsWith("big.csv"))).toBe(false);
  });

  it("does not follow directory junctions/symlinks", () => {
    const outside = mkTemp();
    writeFileSync(join(outside, "leaked.txt"), "x");
    const dir = mkTemp();
    symlinkSync(outside, join(dir, "linked"), "junction");
    writeFileSync(join(dir, "own.txt"), "x");
    const { files } = walkGrantedRoot(grant(dir));
    expect(files).toEqual(["own.txt"]);
  });

  it("truncates honestly at maxFiles and filters by glob", () => {
    const dir = mkTemp();
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.py`), "x");
    writeFileSync(join(dir, "notes.md"), "x");
    const capped = walkGrantedRoot(grant(dir), { maxFiles: 3 });
    expect(capped.files).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    const globbed = walkGrantedRoot(grant(dir), { glob: "*.py" });
    expect(globbed.files).toHaveLength(5);
    expect(globbed.truncated).toBe(false);
    expect(GRANT_WALK_MAX_FILES).toBeGreaterThan(0);
  });
});
