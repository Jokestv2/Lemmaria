/**
 * The honesty note (E1, ADR 0046): does this skill body route somewhere
 * Lemmaria will not follow?
 *
 * **Why this exists.** `load_skill` exposes `references/` and deliberately
 * nothing else — not `scripts/`, not `assets/`, not `templates/`, because those
 * are executable or binary and invariant 2 says capability arrives as a named,
 * bounded tool rather than as a file a skill smuggled in. So a body that routes
 * to `scripts/fetch.py` cannot be honoured, and the surveyed pack has one
 * (`nature-downloader`) that routes to six.
 *
 * Refusing to honour it is the **correct** outcome. Refusing SILENTLY is not:
 * the failure mode STRAT-1 called the bad kind is a router with nothing to
 * route to, where the model answers from the router's own preamble as though it
 * had loaded the depth and neither the user nor the transcript can tell. This
 * module is what turns that into something a user can see, and it is the
 * concrete form of the positioning the survey stated — *they degrade by asking
 * for more, Lemmaria degrades by refusing honestly.*
 *
 * **Info-level, never a load rejection.** The skill's prose half is still worth
 * having; `nature-downloader` will not work, but a skill that loses one of six
 * routes should still load. The caller attaches the diagnostic without failing
 * the parse.
 *
 * **It matches path-like tokens ONLY, and that constraint is not fussiness.**
 * STRAT-1's own substring scan for tool names flagged six skills for `verify`
 * that all turned out to be the ordinary English word. A false positive here
 * would train the user to ignore the one signal that catches the silent
 * summary, which is worse than shipping no signal at all. So a match needs a
 * known sibling directory name, a `/`, and a filename character after it —
 * `scripts are provided elsewhere` and `and/or` and a bare `scripts/` all miss.
 */

/**
 * The sibling directories an Agent Skills pack conventionally uses and
 * Lemmaria does not expose. `references` is deliberately absent: it IS
 * reachable, so a body pointing at it is routing somewhere that works.
 */
const UNREACHABLE_DIRECTORIES = [
  "scripts",
  "assets",
  "templates",
  "agents",
  "static",
] as const;

/**
 * URLs are removed BEFORE matching rather than excluded by a lookbehind.
 *
 * **The lookbehind approach was wrong and the real pack proved it** (found by
 * review). Rejecting any `/` before the directory name does keep
 * `https://example.org/scripts/fetch.py` out — but it also kills the two
 * commonest ways a skill actually spells a local route: `./scripts/fetch.py`
 * and `SKILL_DIR/scripts/audit.py`. Measured against `nature-paper-card`,
 * which routes to **four** `SKILL_DIR/scripts/*.py` files: the old pattern
 * reported only `static`, so the user was told about one unreachable directory
 * and not about the four scripts the skill actually depends on — a partial
 * version of the silent failure this module exists to remove.
 *
 * Stripping first separates the two concerns cleanly: a URL is not a local
 * route whatever it contains, and everything left is prose about this skill's
 * own tree.
 *
 * **A "URL" here includes a bare host**, because the widened lookbehind that
 * admits `./scripts/x` also admits `github.com/openai/codex/scripts/build.sh`
 * — and an attribution line of exactly that shape is common in a third-party
 * `SKILL.md` (second review round). The discriminator is a **dot** in the
 * segment before the first slash, which `docs/scripts/x` and `SKILL_DIR/…`
 * do not have.
 */
const URL_RE = new RegExp(
  [
    // `https://host/...`, and any other scheme.
    String.raw`\b[a-z][a-z0-9+.-]*:\/\/\S+`,
    // `//cdn.example.org/assets/app.js` — protocol-relative.
    String.raw`(?<![\w.-])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+`,
    // `github.com/openai/codex/scripts/build.sh`, `www.example.com/assets/x` —
    // a bare HOST, which is how an attribution line in a third-party SKILL.md
    // is usually written and which no scheme-based pattern can see (second
    // review round). A dotted first segment is what distinguishes it from
    // `docs/scripts/x`, so the local relative forms are untouched.
    String.raw`(?<![\w.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\/\S+`,
  ].join("|"),
  "gi",
);

/**
 * `scripts/fetch.py`, `./scripts/fetch.py`, `SKILL_DIR/scripts/audit.py`,
 * `[the guide](templates/log.md)`, `assets/logo.png`.
 *
 * The leading `(?<![\w-])` rejects `my-scripts/x.md` and `notscripts/y.md`
 * while allowing a `/` or a `.` before the name, which is what admits the two
 * relative forms above. The trailing `[\w-]` requires a real filename
 * character, so a bare `scripts/` or `templates/.` — prose about where things
 * live rather than a route to one file — still does not match.
 *
 * Case-insensitive, because `Scripts/` is the same directory to every
 * filesystem a user is likely to be on.
 */
const ROUTE_RE = new RegExp(
  `(?<![\\w-])(${UNREACHABLE_DIRECTORIES.join("|")})/[\\w-]`,
  "gi",
);

/**
 * The distinct directories this body routes to that `load_skill` cannot reach,
 * sorted. Empty — the overwhelmingly common answer — when it routes nowhere or
 * only into `references/`.
 */
export function routesOutsideReferences(body: string): string[] {
  const prose = body.replace(URL_RE, " ");
  const found = new Set<string>();
  for (const match of prose.matchAll(ROUTE_RE)) {
    const dir = match[1];
    // Lowercased so `Scripts/` and `scripts/` are one entry, not two.
    if (dir !== undefined) found.add(dir.toLowerCase());
  }
  return [...found].sort();
}
