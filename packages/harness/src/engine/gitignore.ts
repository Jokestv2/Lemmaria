/**
 * Minimal nested .gitignore matcher for granted-root walks (ADR 0019).
 *
 * Documented subset (the ADR's contract): blank/`#` lines, `*` `?` `**`
 * globs, trailing-`/` directory rules, leading-`/` (or embedded-slash)
 * anchoring, `!` negation with last-match-wins, and nested .gitignore files
 * layering as the walk descends. NOT supported: core.excludesFile,
 * `.git/info/exclude`, character-class corner cases (passed through
 * escaped), escaped trailing spaces. Hand-rolled — no new dependency
 * (ADR 0001 holds); ripgrep-style fidelity is deliberately out of scope.
 */

/** One parsed .gitignore rule, relative to the .gitignore's own directory. */
export interface IgnoreRule {
  /** Tested against the "/"-separated path relative to the rule's dir. */
  regex: RegExp;
  /** Leading `!` — a match un-ignores (last match wins). */
  negated: boolean;
  /** Trailing `/` — matches directories only (descendants still covered). */
  dirOnly: boolean;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

function translate(pattern: string, anchored: boolean): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i) && (i === 0 || pattern[i - 1] === "/")) {
      out += "(?:.*/)?"; // zero or more whole directories
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += (pattern[i] as string).replace(REGEX_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}$`);
}

export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    // Anchored when the pattern names a path (leading or embedded slash);
    // a bare name matches at any depth (git semantics).
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern === "") continue;
    rules.push({ regex: translate(pattern, anchored), negated, dirOnly });
  }
  return rules;
}

interface IgnoreLayer {
  dirRel: string; // "" = the walk root
  rules: IgnoreRule[];
}

/** Does the rule govern this path — directly, or via an ignored ancestor dir? */
function ruleMatches(rule: IgnoreRule, sub: string, isDir: boolean): boolean {
  if (rule.regex.test(sub) && (!rule.dirOnly || isDir)) return true;
  // A matched ancestor directory ignores everything beneath it.
  const parts = sub.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (rule.regex.test(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

/**
 * Layered matcher: push one .gitignore per directory as a walk descends
 * (root first). Later layers/rules win — git's last-match-wins, with a
 * deeper file's rules more specific than an ancestor's.
 */
export class IgnoreStack {
  private readonly layers: IgnoreLayer[] = [];

  push(dirRel: string, content: string): void {
    this.layers.push({
      dirRel: dirRel.replace(/\\/g, "/"),
      rules: parseGitignore(content),
    });
  }

  ignores(relPath: string, isDir: boolean): boolean {
    const norm = relPath.replace(/\\/g, "/");
    let ignored = false;
    for (const layer of this.layers) {
      let sub: string;
      if (layer.dirRel === "") {
        sub = norm;
      } else if (norm.startsWith(`${layer.dirRel}/`)) {
        sub = norm.slice(layer.dirRel.length + 1);
      } else {
        continue; // a layer only governs paths beneath its directory
      }
      for (const rule of layer.rules) {
        if (ruleMatches(rule, sub, isDir)) ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
