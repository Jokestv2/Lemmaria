/**
 * Root-scoped external read grants — path logic (ADR 0019).
 *
 * Containment is enforcement here, not policy: these functions are what the
 * read tools call, so realpath-before-read genuinely bounds the read path
 * (unlike Codex, whose lexical checks lean on a kernel sandbox). The paper
 * workspace's own tools keep the M8 lexical guard unchanged — everything in
 * this module applies to GRANTED roots only.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolErrorCode } from "../contracts/results.js";
import type { GrantedRoot } from "../contracts/sessions.js";
import { IgnoreStack } from "./gitignore.js";
import {
  assertWorkspaceRelative,
  matchesFileGlob,
  shouldSkipDir,
} from "./workspace-utils.js";

/**
 * The default deny-read list (ADR 0019) — deliberately stronger than either
 * prior art's default: papers never need these. Matched case-insensitively
 * against every path segment; `*` is a within-segment wildcard.
 */
export const DENY_READ_PATTERNS: readonly string[] = [
  ".git",
  ".hg",
  ".svn", // VCS internals
  ".env",
  ".env.*", // env files
  "id_*", // ssh private keys
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx", // key material
  "credentials*",
  "*credentials.json", // credential stores
  ".netrc",
  "_netrc",
  ".htpasswd",
  ".npmrc",
  ".pypirc",
];

const DENY_REGEXES: { pattern: string; regex: RegExp }[] =
  DENY_READ_PATTERNS.map((pattern) => ({
    pattern,
    regex: new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      "i",
    ),
  }));

/**
 * The honest "excluded by default" reason for a deny-listed path, or
 * undefined when readable. Checked against every path segment, so a file
 * inside `.git/` is denied even when addressed directly.
 */
export function deniedReason(relPath: string): string | undefined {
  for (const segment of relPath.split(/[/\\]/)) {
    for (const { pattern, regex } of DENY_REGEXES) {
      if (regex.test(segment)) {
        return `excluded by default: matches ${pattern}`;
      }
    }
  }
  return undefined;
}

/**
 * Realpath-canonicalize a grant root at grant time (ADR 0019). Throws an
 * honest error when the path does not exist or is not a directory — the
 * host surfaces the message to the user.
 */
export function canonicalizeGrantRoot(dirPath: string): string {
  let real: string;
  try {
    real = realpathSync(dirPath);
  } catch {
    throw new Error(`grant root does not exist: ${dirPath}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`grant root is not a directory: ${dirPath}`);
  }
  return real;
}

/** True when abs is the root itself or beneath it (case-insensitive on win32). */
export function isWithinRoot(root: string, abs: string): boolean {
  const a = process.platform === "win32" ? root.toLowerCase() : root;
  const b = process.platform === "win32" ? abs.toLowerCase() : abs;
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a model-supplied path inside a granted root, or refuse honestly.
 * Lexical escape check first (the M8 rules), then realpath the target and
 * re-check containment — a symlink/junction escaping the root is refused
 * (ADR 0019). Refusals are data (the tool result), never throws.
 */
/**
 * ADR 0024 decision 5: this module keeps its internal `{refused}` shape (it has
 * several callers), but it states the CODE the tool boundary should use rather
 * than leaving the boundary to re-parse English prose. Re-wording a message
 * below must never silently turn a `not_found` into a `denied` — `denied` is
 * the code that tells the model never to retry.
 */
export interface GrantedPathHit {
  abs: string;
  refused?: undefined;
  code?: undefined;
}
export interface GrantedPathRefusal {
  refused: string;
  code: ToolErrorCode;
  abs?: undefined;
}

export function resolveGrantedPath(
  root: GrantedRoot,
  relPath: string,
): GrantedPathHit | GrantedPathRefusal {
  // The model spells a nested path with whichever separator it happens to
  // pick, and it does not know the host's. The rest of this boundary already
  // reads "\" as a separator on EVERY platform — `deniedReason` splits on
  // `[/\\]`, `assertWorkspaceRelative` rejects `..\` and `\`-rooted paths
  // "even on a posix host" — but `resolve()` does not: on posix a backslash
  // is an ordinary filename character, so `sub\x.txt` resolved to a single
  // literal segment and reported `no such file`. That made the boundary
  // disagree with itself by host. Normalize once, up front, so every check
  // below reads the same separators the deny list does.
  //
  // The trade is deliberate and is the one `deniedReason` already made: a
  // posix file literally named `sub\x.txt` is unaddressable through a grant.
  // Refusals keep the caller's ORIGINAL spelling, so the message echoes what
  // the model actually asked for.
  const rel = relPath.replace(/\\/g, "/");
  try {
    assertWorkspaceRelative(rel);
  } catch {
    return {
      code: "denied",
      refused: `path escapes the granted root: ${relPath}`,
    };
  }
  // A colon in a segment is an NTFS alternate-data-stream / drive-relative
  // spelling (`.env::$DATA`, `notes.txt:stream`) that dodges a segment-name
  // deny match but reads the underlying file. No legitimate filename needs it.
  if (
    process.platform === "win32" &&
    /:/.test(relPath.replace(/^[a-z]:/i, ""))
  ) {
    return {
      code: "denied",
      refused: `path escapes the granted root: ${relPath}`,
    };
  }
  const denied = deniedReason(rel);
  if (denied !== undefined) return { code: "denied", refused: denied };
  const abs = resolve(root.path, rel);
  if (!isWithinRoot(root.path, abs)) {
    return {
      code: "denied",
      refused: `path escapes the granted root: ${relPath}`,
    };
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { code: "not_found", refused: `no such file: ${relPath}` };
  }
  if (!isWithinRoot(root.path, real)) {
    return {
      code: "denied",
      refused: `path escapes the granted root (symlink target outside): ${relPath}`,
    };
  }
  // Re-check the deny list against the REALPATH: an in-root symlink/junction
  // (e.g. docs → .git) or an 8.3 short name resolves to a denied file whose
  // spelling the request string hid. This is where the deny list is enforced,
  // so every caller inherits it (ADR 0019 §4).
  const realDenied = deniedReason(relative(root.path, real));
  if (realDenied !== undefined) return { code: "denied", refused: realDenied };
  return { abs: real };
}

export const GRANT_WALK_MAX_FILES = 500;

/** What a granted-root walk found, and what it refused to show (A6). */
export interface GrantWalkResult {
  files: string[];
  truncated: boolean;
  /** Deny-listed files (credentials, keys, VCS internals) — counted, never listed. */
  excludedByDefault: number;
  /**
   * Entries hidden by a `.gitignore` layer (A6). Counted at the boundary: an
   * ignored *directory* counts once, not once per file inside it — an honest
   * count of what was refused, never an invented estimate of what it contained.
   */
  excludedByGitignore: number;
  /** Directories refused by `shouldSkipDir` (node_modules, build, dot-dirs). */
  excludedBySkipDir: number;
}

/**
 * Walk a granted root: skips SKIP_DIRS + dot-dirs (shouldSkipDir), applies
 * nested .gitignore layers, counts (never lists) deny-listed files, and
 * never follows symlinked entries (a symlink escaping the root must not
 * leak into listings; direct reads re-check realpath anyway). Results are
 * "/"-separated root-relative paths, capped with an honest truncated flag.
 *
 * **A6: every exclusion is now counted.** Deny-listed files always were, but
 * `.gitignore` matches and skipped directories were dropped with no counter and
 * no flag — so a granted *results* folder (whose contents are routinely
 * gitignored) listed as empty-and-clean, which is precisely the honesty hole
 * the Experiments flagship walks into. The counts let a caller say "6 files
 * listed; 2 groups hidden by .gitignore" instead of showing an empty listing.
 */
export function walkGrantedRoot(
  root: GrantedRoot,
  opts?: { maxFiles?: number; glob?: string },
): GrantWalkResult {
  const maxFiles = opts?.maxFiles ?? GRANT_WALK_MAX_FILES;
  const files: string[] = [];
  let truncated = false;
  let excludedByDefault = 0;
  let excludedByGitignore = 0;
  let excludedBySkipDir = 0;
  const ignore = new IgnoreStack();

  const visit = (dirAbs: string, dirRel: string): void => {
    if (truncated) return;
    const ignoreFile = join(dirAbs, ".gitignore");
    try {
      ignore.push(dirRel, readFileSync(ignoreFile, "utf8"));
    } catch {
      // no .gitignore here — nothing to layer
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never throw into the loop
    }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue; // never follow links in walks
      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          excludedBySkipDir += 1;
          continue;
        }
        if (deniedReason(rel) !== undefined) {
          excludedByDefault += 1;
          continue;
        }
        if (ignore.ignores(rel, true)) {
          excludedByGitignore += 1;
          continue;
        }
        visit(join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        if (ignore.ignores(rel, false)) {
          excludedByGitignore += 1;
          continue;
        }
        if (deniedReason(rel) !== undefined) {
          excludedByDefault += 1;
          continue;
        }
        if (!matchesFileGlob(rel, opts?.glob)) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  };

  visit(root.path, "");
  return {
    files,
    truncated,
    excludedByDefault,
    excludedByGitignore,
    excludedBySkipDir,
  };
}
