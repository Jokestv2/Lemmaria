/**
 * Writing Skills loader (ADR 0028) — pure: parse, validate, merge, diagnose.
 *
 * Structurally the action loader (`actions/loader.ts`): the HOST reads the
 * files and passes strings, so every rule here is testable without a disk and
 * the harness never decides where the user's home or workspace is (the
 * `engine/memory.ts` convention). The filesystem half is `skills/library.ts`.
 *
 * Adapted from Pi's `harness/skills.ts` (survey §2.10). Two of ADR 0028's four
 * recorded divergences still stand:
 *
 *   - **One-level discovery** instead of a recursive, ignore-file-aware walk.
 *     Pi's roots include npm-package trees of unknown shape; Lemmaria's are
 *     fixed and small, so recursion buys nothing and costs an ignore engine
 *     (§D1). Verified correct against a real pack: all 19 of its directories
 *     are `<root>/<name>/SKILL.md`.
 *   - **A per-locale FILE** rather than one body per skill, because a `{en, zh}`
 *     body inside YAML is unreadable to the human who authors it (§D2). It
 *     governs the skills **Lemmaria** ships; a third party's description passes
 *     through as authored, whatever scripts it mixes (invariant 6's boundary).
 *
 * Two of ADR 0028's four divergences are **withdrawn by E1 (ADR 0045)**, which
 * is why they are no longer in the list above. §D4's *reject an over-long
 * description* and §D5's *hard capacity cap* between them loaded **3 of 19**
 * directories of a real third-party pack; both are replaced by the catalogue
 * budget in `skills/budget.ts`, which degrades and names every rung instead of
 * refusing. §D4's reasoning survives — see that module's header for why a
 * truncation that says so is the remedy §D4 itself asked for.
 */

import { parse as parseYaml } from "yaml";
import type { SessionLocale } from "../contracts/sessions.js";
import type { Skill, SkillSelector, SkillSource } from "../contracts/skills.js";
import { defaultSkillCatalogueBudget, fitCatalogue } from "./budget.js";
import { routesOutsideReferences } from "./routes.js";

/**
 * The hard rejection ceiling for a description — the Agent Skills standard's
 * number, which Pi enforces and Codex truncates at.
 *
 * **It is not what bounds the prompt.** `defaultSkillCatalogueBudget` is — 2 %
 * of the bound model's context window (ADR 0048) — and a description well
 * under this cap can still arrive truncated because the
 * catalogue as a whole did not fit. Past 1,024 the author has not written a
 * description at all, and no amount of budget makes that useful — so this stays
 * a rejection, and it is the ONLY description rejection left.
 */
export const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
export const MAX_SKILL_NAME_CHARS = 64;

/** Lowercase, digits, single hyphens — typed by the user in `/skill:<name>`. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `SKILL.md` or `SKILL.<locale>.md`, and nothing else in the directory. */
const SKILL_FILE_RE = /^SKILL(?:\.([a-z-]+))?\.md$/;

export type SkillDiagnosticCode =
  | "parse_failed"
  | "invalid_name"
  | "missing_description"
  | "description_too_long"
  | "empty_body"
  /** E1 (ADR 0045): the catalogue budget's two rungs. */
  | "description_truncated"
  | "over_budget"
  /**
   * E1 (ADR 0046): the body points at a directory `load_skill` will not
   * follow. **Info-level, and never a load rejection** — see `routes.ts`.
   */
  | "routes_outside_references"
  /**
   * E1 (ADR 0046): the skill's `references/` is a symlink, so it was not read.
   * **Info-level**, and it must exist: refusing to follow the link is right,
   * but refusing SILENTLY leaves a router with nothing behind it and no way
   * for the user to find out — the exact failure this subsystem exists to
   * remove (found by the second review round).
   */
  | "references_not_followed";

/**
 * What a diagnostic MEANS: `failure` — this skill is not in the loaded set —
 * or `info` — it loaded, with something the user should know.
 */
export type SkillDiagnosticLevel = "failure" | "info";

/**
 * The level of every code, beside the union rather than in the view.
 *
 * **Why it lives here** (found cold at E1's gate record): `skills-ui.ts` kept
 * its own set of Info codes, and the second review round added
 * `references_not_followed` to the union three rungs after that set was
 * written. The set never learned about it, so the note was rendered as a load
 * FAILURE — top of the tree, `warning` icon, counted in the banner's *"N could
 * not be loaded"* — printed directly above the row for the skill that had in
 * fact loaded, and whose own message says *"The skill still loads"*. Three
 * surfaces stated one thing and the fourth stated its opposite.
 *
 * The instance was one missing string; the CLASS is that the view got to
 * decide a level the loader already knew. `Record<SkillDiagnosticCode, …>` is
 * the fix: a code added to the union without a level here fails `pnpm
 * typecheck`, which is the same exhaustiveness proof `ALL_TOOL_NAMES` carries
 * in `contracts/tools.ts` — and cheaper, because a total `Record` proves both
 * directions on its own.
 */
export const SKILL_DIAGNOSTIC_LEVEL: Record<
  SkillDiagnosticCode,
  SkillDiagnosticLevel
> = {
  parse_failed: "failure",
  invalid_name: "failure",
  missing_description: "failure",
  description_too_long: "failure",
  empty_body: "failure",
  // The skill loaded; only its description was shortened to fit the catalogue.
  description_truncated: "info",
  // The ONE note about a skill genuinely absent from the loaded set — the
  // budget's omission rung dropped it — so it is a failure, not a note.
  over_budget: "failure",
  // Both ADR 0046 notes: the body points somewhere Lemmaria will not follow,
  // and the skill's prose half is still worth having.
  routes_outside_references: "info",
  references_not_followed: "info",
};

/**
 * Why a skill the user CLAIMED did not load. Every rejection produces one —
 * the brief's "diagnostics rather than silent drops", read strictly. A
 * directory that never claimed to be a skill produces nothing (see
 * `library.ts`), on the venue library's rule: only a claimed thing can be
 * malformed.
 */
export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  path: string;
  source: SkillSource;
}

export interface SkillFile {
  /** Ends in `SKILL.md` or `SKILL.<locale>.md`; its parent directory names the skill. */
  path: string;
  content: string;
  /**
   * The `references/*.md` NAMES the host found beside this file (E1, ADR 0046).
   * Absent means the same as empty; the loader normalizes it so every `Skill`
   * carries the array. The HOST reads the directory — this module stays pure.
   */
  references?: string[];
  /**
   * True when the host found a `references` entry it refused to follow — a
   * symlink rather than a real directory. Distinguishes *"this skill has no
   * references"* from *"this skill has references Lemmaria would not read"*,
   * which are the same empty array but very different things to tell a user.
   */
  referencesRefused?: boolean;
}

/**
 * `bundled < venue < user < project` (E1, ADR 0045), mirroring the action
 * loader's `built-in < user < project`. The order is also what the budget's
 * omission rung walks from the bottom of, so it decides whose skill is dropped
 * when a catalogue will not fit — which is why it is one table, not two.
 */
const PRECEDENCE: Record<SkillSource, number> = {
  bundled: 0,
  venue: 1,
  user: 2,
  project: 3,
};

const SOURCES = ["bundled", "venue", "user", "project"] as const;

interface FileParts {
  /** POSIX-normalized directory holding the file. */
  dir: string;
  /** That directory's own name — the default skill name. */
  base: string;
  /** The locale tag from `SKILL.<locale>.md`, absent for the plain `SKILL.md`. */
  locale?: string;
  /** False when the filename is not a SKILL file at all. */
  isSkillFile: boolean;
}

function describeFile(path: string): FileParts {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dir = slash === -1 ? "" : norm.slice(0, slash);
  const file = norm.slice(slash + 1);
  const match = SKILL_FILE_RE.exec(file);
  const locale = match?.[1];
  return {
    dir,
    base: dir.slice(dir.lastIndexOf("/") + 1),
    ...(locale !== undefined ? { locale } : {}),
    isSkillFile: match !== null,
  };
}

/**
 * Split the YAML frontmatter from the body. Hand-rolled like Pi's, because the
 * `yaml` package parses a document, not a delimited prefix. A file with no
 * leading `---` (or an unterminated one) is all body — it then fails on the
 * missing description, which is the honest thing to tell its author.
 */
function extractFrontmatter(content: string): {
  yaml: string | null;
  body: string;
} {
  const text = content.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { yaml: null, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { yaml: null, body: text };
  return { yaml: text.slice(4, end), body: text.slice(end + 4).trim() };
}

/** Does this selector name that skill? Codex's `SkillConfig` matching. */
function isDisabled(skill: Skill, disabled: readonly SkillSelector[]): boolean {
  return disabled.some((selector) =>
    "name" in selector
      ? selector.name === skill.name
      : // Path comparison is separator-insensitive: the extension persists
        // whatever the platform handed it, and a selection that stopped
        // matching after a reload would look like the toggle silently failing.
        selector.path.replace(/\\/g, "/") === skill.path.replace(/\\/g, "/"),
  );
}

/**
 * Merge the source layers into the loaded set.
 *
 * `locale` selects between `SKILL.md` and `SKILL.<locale>.md` within one skill
 * directory (§D2); a directory carrying only one of them yields that one,
 * whatever the locale, because it is the only text that exists. It is also the
 * language every diagnostic renders in — one language per reader, invariant 6.
 */
export function loadSkillSet(
  sources: Partial<Record<SkillSource, SkillFile[]>> & {
    /**
     * The user's disabled selection (E1, ADR 0045). Filtered out **before** the
     * budget runs, which is what makes the toggle a real relief valve rather
     * than cosmetic — see `budget.ts`, rung 1.
     */
    disabled?: readonly SkillSelector[];
    /**
     * The bound model's context window, in tokens — the input the catalogue
     * budget is 2 % of (ADR 0048). **Absent means genuinely absent**: no model
     * bound, no window to take a percentage of, and the budget falls back to
     * Codex's character one. The HOST decides this, like every other thing the
     * harness is not allowed to know (invariant 1).
     */
    contextWindowTokens?: number;
  },
  locale: SessionLocale = "en",
): { skills: Skill[]; diagnostics: SkillDiagnostic[]; disabled: Skill[] } {
  const byName = new Map<string, Skill>();
  const diagnostics: SkillDiagnostic[] = [];
  const disabled = sources.disabled ?? [];
  /**
   * The skills the user switched off, kept rather than dropped (E1 gate-review
   * round). The view renders a row from each, because a switch you can turn off
   * and then cannot find again is not a switch — and they are collected HERE,
   * before the merge, so both copies of a twice-resolving name come back
   * separately and a `path` selector has a row to act on.
   */
  const disabledSkills: Skill[] = [];

  for (const source of SOURCES) {
    // Group a source's files by skill directory, then pick one file per group:
    // the locale variant when it exists, else the plain SKILL.md.
    const groups = new Map<string, SkillFile[]>();
    for (const file of sources[source] ?? []) {
      const parts = describeFile(file.path);
      if (!parts.isSkillFile) continue;
      groups.set(parts.dir, [...(groups.get(parts.dir) ?? []), file]);
    }

    for (const files of groups.values()) {
      const chosen =
        files.find((f) => describeFile(f.path).locale === locale) ??
        files.find((f) => describeFile(f.path).locale === undefined) ??
        files[0];
      if (chosen === undefined) continue;
      const parsed = parseSkillFile(chosen, source);
      if ("code" in parsed) {
        diagnostics.push(parsed);
        continue;
      }
      // E1 (ADR 0046), Info-level: the host refused to follow a symlinked
      // `references/`. Refusing is correct; refusing silently is not — the
      // skill would load as a router with nothing behind it, which is the
      // failure this whole subsystem exists to make visible.
      if (chosen.referencesRefused === true) {
        diagnostics.push({
          code: "references_not_followed",
          message:
            locale === "zh"
              ? `“${parsed.name}”的 references 是一个符号链接，因此未被读取——Lemmaria 只会读取技能目录内真实存在的 references/ 文件夹。这项技能仍会加载，但其中依赖这些参考文件的部分无法执行。`
              : `"${parsed.name}" has a references symlink rather than a real directory, so it was not read — Lemmaria only follows a real references/ folder inside the skill. The skill still loads, but the parts of it that depend on those files cannot be followed.`,
          path: parsed.path,
          source,
        });
      }
      // E1 (ADR 0046), Info-level: the body routes somewhere Lemmaria does not
      // expose. Attached WITHOUT failing the parse — the skill's prose half is
      // still worth having, and a note that silently dropped the skill would be
      // the opposite of what this exists to do.
      const routes = routesOutsideReferences(parsed.body);
      if (routes.length > 0) {
        diagnostics.push({
          code: "routes_outside_references",
          message:
            locale === "zh"
              ? `“${parsed.name}”的正文指向了 ${routes.map((d) => `${d}/`).join("、")} 目录，而 Lemmaria 只提供 references/ 中的文件（不变量 2）。这项技能仍会加载，但其中依赖这些目录的部分无法执行。`
              : `"${parsed.name}" routes to ${routes.map((d) => `${d}/`).join(", ")}, which Lemmaria does not expose — only references/ is reachable (invariant 2). The skill still loads, but the parts of it that depend on those directories cannot be followed.`,
          path: parsed.path,
          source,
        });
      }
      // E1 (ADR 0045): the disabled filter runs BEFORE the precedence merge,
      // not merely before the budget.
      //
      // Before the budget is what rung 1 needs — disabling has to be able to
      // buy back the room it is advertised as buying. Before the MERGE is what
      // a **path** selector needs, and it is the stronger requirement: a path
      // selector's whole reason to exist is to silence one copy when the same
      // name resolves from two sources, and after the merge only the winner is
      // left, so the loser could never be selected and disabling the winner
      // would take the name away entirely rather than falling back. Filtering
      // here gives both selectors their stated meaning and satisfies rung 1 as
      // a side effect.
      if (isDisabled(parsed, disabled)) {
        disabledSkills.push(parsed);
        continue;
      }
      const existing = byName.get(parsed.name);
      if (!existing || PRECEDENCE[source] >= PRECEDENCE[existing.source]) {
        byName.set(parsed.name, parsed);
      }
    }
  }

  const fitted = fitCatalogue([...byName.values()], {
    budget: defaultSkillCatalogueBudget(sources.contextWindowTokens),
    locale,
  });
  // Parse-time diagnostics first: a skill that did not load at all is a bigger
  // thing to tell the user than one that loaded with a shortened description.
  return {
    skills: fitted.kept,
    diagnostics: [...diagnostics, ...fitted.diagnostics],
    disabled: disabledSkills,
  };
}

function parseSkillFile(
  file: SkillFile,
  source: SkillSource,
): Skill | SkillDiagnostic {
  const fail = (
    code: SkillDiagnosticCode,
    message: string,
  ): SkillDiagnostic => ({ code, message, path: file.path, source });

  const { yaml, body } = extractFrontmatter(file.content);
  let front: Record<string, unknown> = {};
  if (yaml !== null) {
    try {
      front = (parseYaml(yaml) as Record<string, unknown> | null) ?? {};
    } catch (error) {
      return fail(
        "parse_failed",
        `frontmatter is not valid YAML: ${(error as Error).message}`,
      );
    }
  }

  const name =
    typeof front.name === "string" && front.name.length > 0
      ? front.name
      : describeFile(file.path).base;
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return fail(
      "invalid_name",
      `name "${name}" is ${name.length} characters; the limit is ${MAX_SKILL_NAME_CHARS}`,
    );
  }
  if (!SKILL_NAME_RE.test(name)) {
    return fail(
      "invalid_name",
      `name "${name}" must be lowercase letters, digits and single hyphens (e.g. house-style) — it is what you type after /skill:`,
    );
  }

  const description =
    typeof front.description === "string" ? front.description.trim() : "";
  if (description === "") {
    return fail(
      "missing_description",
      "a skill needs a description — it is the only thing the assistant sees until it loads the body, so it is how the skill gets used at all",
    );
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    // The ONE remaining description rejection (E1, ADR 0045). The message says
    // "the standard's limit" rather than "every description sits in every
    // prompt", because the second is now the CATALOGUE BUDGET's job and saying
    // it here would send an author shortening a description that would have
    // loaded fine.
    return fail(
      "description_too_long",
      `description is ${description.length} characters; the limit is ${MAX_SKILL_DESCRIPTION_CHARS}, the Agent Skills standard's maximum — past it a description is no longer the one line that says when to reach for the skill`,
    );
  }

  const trimmedBody = body.trim();
  if (trimmedBody === "") {
    return fail(
      "empty_body",
      "a skill needs a body — the guidance the assistant reads when it loads the skill",
    );
  }

  return {
    name,
    description,
    body: trimmedBody,
    source,
    path: file.path,
    // Defence in depth (second review round). `library.ts`'s `readdir` cannot
    // produce a name with a separator, so this filter should never remove
    // anything — but the containment property in `loop-tools/skill.ts` rests
    // ENTIRELY on this list, and "the host would never" is exactly the kind of
    // assumption that stops being true when a second host appears. Three lines
    // to make the guarantee unconditional rather than inherited.
    references: (file.references ?? []).filter(
      (n) => !n.includes("/") && !n.includes("\\") && n !== ".." && n !== ".",
    ),
  };
}
