/**
 * The filesystem half of the skills module (ADR 0028) — a thin walk over four
 * absolute roots that hands strings to the pure `loadSkillSet`.
 *
 * `node:fs` is fine here: invariant 1 forbids `vscode`, not Node, and
 * `venue/library.ts` is the precedent. The HOST supplies the directories, so
 * the harness still never decides where the user's home or workspace is — and
 * that is also why the DISABLED selection arrives as an option rather than
 * being read from a config file here.
 *
 * Discovery is deliberately ONE LEVEL — `<root>/<skill-name>/SKILL.md` — where
 * Pi walks recursively with an ignore-file engine (ADR 0028 §D1). Its roots
 * include npm-package trees of unknown shape; these four are fixed and small.
 * Verified correct against a real third-party pack: every one of its 19
 * directories is exactly `<root>/<name>/SKILL.md`.
 *
 * **The one place the walk goes deeper is `references/`** (E1, ADR 0046), and
 * it goes exactly one level further, for the same reason §D1 chose one level in
 * the first place. What it collects are NAMES, never paths — see
 * `Skill.references` for why that distinction is the whole design.
 */

import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionLocale } from "../contracts/sessions.js";
import type { Skill, SkillSelector, SkillSource } from "../contracts/skills.js";
import {
  type SkillDiagnostic,
  type SkillFile,
  loadSkillSet,
} from "./loader.js";

export interface SkillLibraryOptions {
  /** The curated set shipped with the extension (`dist/skills`). */
  bundledDir?: string;
  /** `<resolved venue dir>/skills`, when a venue matched the paper's documentclass. */
  venueDir?: string;
  /**
   * `~/.lemmaria/skills` — the user's own, and where a third-party Agent Skills
   * pack gets dropped (E1, ADR 0045). The HOST resolves the home directory;
   * `~/.lemmaria/` already hosts the global `MEMORY.md` and the venue cache.
   */
  userDir?: string;
  /** `<workspace>/.lemmaria/skills`. */
  projectDir?: string;
  /** Chooses `SKILL.<locale>.md` over `SKILL.md`; defaults to `en`. */
  locale?: SessionLocale;
  /**
   * The user's disabled selection (E1, ADR 0045), persisted by the extension
   * and passed straight through. Applied before the precedence merge, so a
   * path selector can silence one copy of a name that resolves twice.
   */
  disabled?: readonly SkillSelector[];
  /**
   * The bound model's context window in tokens, which the catalogue budget is
   * 2 % of (ADR 0048). Absent ⇒ no model bound ⇒ Codex's character fallback.
   */
  contextWindowTokens?: number;
}

/**
 * How many `references/*.md` names one skill may publish.
 *
 * A skill cannot make its own manifest unbounded: the list rides in every
 * `load_skill` result, so an author with 400 reference files would spend the
 * model's tool-result budget on a directory listing. 32 is well past what the
 * largest directory in the surveyed pack carries (20).
 */
export const MAX_SKILL_REFERENCES = 32;

const SKILL_FILE_RE = /^SKILL(?:\.[a-z-]+)?\.md$/;

/**
 * The `.md` file NAMES under `<skillDir>/references/`, sorted and capped.
 *
 * A missing directory is an empty manifest, never an error — the same shape
 * `readLayer` already uses for a missing root, and for the same reason: most
 * skills have no references, so a diagnostic per skill would be noise rather
 * than news (the venue library's *only a claimed thing can be malformed*).
 *
 * `.md` only, one level, files only. `scripts/`, `assets/` and `templates/`
 * are deliberately NOT exposed and neither are nested directories: those are
 * executable or binary, and invariant 2 says capability arrives as a named,
 * bounded tool, never as a file a skill smuggled in.
 *
 * **`references` must be a REAL directory, and the check is `lstat`, not
 * `readdir`** (found by review). `readdir` follows a symlink on the final path
 * component, so a pack carrying `references -> ../..` or
 * `references -> /home/you/Documents` would publish a manifest of `.md` files
 * from anywhere on disk — and `load_skill` would then serve them, because the
 * manifest is the gate and the manifest would say they belong. Entry-level
 * `isFile()` already rejects symlinked *files*; this is the directory hole
 * beneath it. It is not hypothetical: a third-party pack cloned from git can
 * carry a symlink, and the whole point of the `user` source is that users drop
 * such packs in.
 *
 * **And the refusal is REPORTED, not swallowed** (second review round). A
 * silently-empty manifest leaves the model holding a router with nothing behind
 * it — STRAT-1's *"router with nothing to route to does not fail, it
 * summarises"* — which is the precise failure this subsystem exists to remove.
 * `refused` is what lets the loader say so.
 */
async function readReferences(
  skillDir: string,
): Promise<{ names: string[]; refused: boolean }> {
  const dir = join(skillDir, "references");
  try {
    // `lstat`, so a symlink reports as one instead of as its target. A Windows
    // directory junction reports `isSymbolicLink()` too.
    const stats = await lstat(dir);
    // A symlink is REFUSED and said so; anything else that is not a directory
    // (a stray `references` file) is simply absent, like no entry at all.
    if (stats.isSymbolicLink()) return { names: [], refused: true };
    if (!stats.isDirectory()) return { names: [], refused: false };
  } catch {
    return { names: [], refused: false };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { names: [], refused: false };
  }
  return {
    names: entries
      // `isFile()` is false for a symlink, so a symlinked FILE inside a real
      // `references/` is excluded for the same reason.
      .filter((entry) => entry.isFile() && /\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_SKILL_REFERENCES),
    refused: false,
  };
}

async function readLayer(dir: string | undefined): Promise<SkillFile[]> {
  if (dir === undefined) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing layer dir is an empty layer, never an error — the venue
    // library's rule (`library.ts:54`). Most users have no `.lemmaria/skills`.
    return [];
  }
  const files: SkillFile[] = [];
  // Sorted so the loaded set is deterministic across platforms; readdir order
  // is not guaranteed and the budget's omission rung makes order observable.
  for (const entry of [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    let inner: Dirent[];
    try {
      inner = await readdir(skillDir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Read once per skill DIRECTORY, not once per SKILL.md: a directory
    // carrying both `SKILL.md` and `SKILL.zh.md` has one `references/` between
    // them, and reading it twice would be one wasted syscall per locale.
    let refs: { names: string[]; refused: boolean } | undefined;
    for (const file of [...inner].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!file.isFile() || !SKILL_FILE_RE.test(file.name)) continue;
      const path = join(skillDir, file.name);
      refs ??= await readReferences(skillDir);
      try {
        files.push({
          path,
          content: await readFile(path, "utf8"),
          references: refs.names,
          // Carried so the loader can SAY the link was not followed. Refusing
          // silently would leave a router with nothing behind it and no way
          // for the user to find out (second review round).
          ...(refs.refused ? { referencesRefused: true as const } : {}),
        });
      } catch {
        // Unreadable after listing (a race, a permission): there is nothing
        // here the user could act on that the absence does not already say.
      }
    }
  }
  return files;
}

export async function listSkills(opts: SkillLibraryOptions): Promise<{
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
  disabled: Skill[];
}> {
  const sources: Partial<Record<SkillSource, SkillFile[]>> = {
    bundled: await readLayer(opts.bundledDir),
    venue: await readLayer(opts.venueDir),
    user: await readLayer(opts.userDir),
    project: await readLayer(opts.projectDir),
  };
  return loadSkillSet(
    {
      ...sources,
      ...(opts.disabled ? { disabled: opts.disabled } : {}),
      ...(opts.contextWindowTokens !== undefined
        ? { contextWindowTokens: opts.contextWindowTokens }
        : {}),
    },
    opts.locale ?? "en",
  );
}
