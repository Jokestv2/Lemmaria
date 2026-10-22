/**
 * `@` context references — the candidate set, built from what the session may
 * already read (E3, ADR 0052; design §5).
 *
 * **This module performs no I/O, and that is the whole of its design.** The
 * host does both walks — `VscodeWorkspace.listFiles` for the paper workspace
 * and `walkGrantedRoot` for each active grant, the *identical* calls
 * `list_files` itself makes — and posts the results. What is left here is
 * ordering, folder derivation and root qualification, which is exactly the part
 * that can be wrong in a way a user would notice, and exactly the part jsdom can
 * pin (ADR 0037). Nothing in this file knows what a filesystem is.
 *
 * **Invariant 2 is held by construction rather than by inspection.** The two
 * walks are the tools' own, so every exclusion they apply is already applied;
 * and a folder exists here only because a readable file was found under it, so
 * the menu cannot name a directory the model could not already reach. The
 * property is stated as a test — *every folder candidate is a prefix of some
 * file candidate* — rather than as a comment, because a comment cannot fail.
 *
 * Prior art: Codex's `file_search_popup.rs` and `insert_selected_path`, whose
 * path-insert (rather than content-attach) and whitespace-quoting rules this
 * follows. Codex has one root; the qualification below is what Lemmaria's
 * several roots make necessary.
 */
// The NARROW subpath, never the barrel: this module is bundled for a browser,
// and `@lemmaria/harness` re-exports the model adapters and through them
// `node:fs`. `parts/strings.ts` reaches `model-floor` the same way, for the
// same reason. Type-only imports from the barrel are fine — they are erased.
import type { SessionLocale } from "@lemmaria/harness";
import { byShallowest } from "@lemmaria/harness/path-order";
import { type InsertCandidate, SIGIL_AT } from "./completion.js";
import { tr } from "./strings.js";

/**
 * What one walk refused to show, counted.
 *
 * B4/A6's rule, which design §5 cites by name: an exclusion is **counted, never
 * silently dropped**. A granted results folder is routinely gitignored in full,
 * and a listing that showed it as empty-and-clean is the honesty hole A6 closed
 * in the tool. The menu is the same listing with a different face, so it owes
 * the same honesty.
 */
export interface ExclusionCounts {
  /** The walk stopped at its cap — there is more, and how much is unknown. */
  readonly truncated: boolean;
  /**
   * **An absent count means NOT COUNTED, and zero means none — they are not the
   * same thing.** This is `list_files`' own distinction, carried verbatim: its
   * workspace branch reports `excludedByDefault: 0` because that walk applies
   * no deny-list, and deliberately OMITS the gitignore and skip-dir figures
   * because `VscodeWorkspace.listFiles` does skip `node_modules` and friends
   * but never counts them. Reporting `0` there would be the invented count A6
   * added these counters to eliminate. The menu is that listing with a
   * different face, so it owes the same distinction.
   */
  readonly byDefault?: number;
  readonly byGitignore?: number;
  readonly bySkipDir?: number;
}

/** One root, as the host walked it. */
export interface WalkedRoot {
  /**
   * How a path under this root is qualified when inserted — the grant's own
   * `label`, or **absent** for the paper workspace.
   *
   * The asymmetry is the engine's, not a convenience: the capability envelope
   * says in as many words that *"the paper workspace stays the default when
   * root is omitted"*, so an unqualified insert mirrors an unqualified call.
   */
  readonly qualifier?: string;
  /** Root-relative, `/`-separated file paths, in the walk's own order. */
  readonly files: readonly string[];
  /**
   * The discovered paper entry, root-relative — it sorts first (design §2).
   * Workspace only; a grant has no paper.
   */
  readonly entry?: string;
  readonly excluded: ExclusionCounts;
}

/**
 * Every root the session may read.
 *
 * `workspace` is **absent** when there is no paper in context, because the
 * session's registry then has no workspace at all and `list_files` refuses
 * outright. Falling back to `workspaceFolders[0]` would offer paths from a root
 * the session is not reading, which is the one thing invariant 2 forbids.
 */
export interface ContextPaths {
  readonly workspace?: WalkedRoot;
  readonly grants: readonly WalkedRoot[];
}

/** What the menu says about what it could not show. */
export interface ExclusionSummary {
  readonly truncated: boolean;
  /**
   * Entries a filter refused, summed across roots.
   *
   * Zero with `truncated` set is a real state and not a bug: a walk that
   * stopped at its cap hid an unknown number of files, and reporting a figure
   * for it would be the invented count A6 removed. The flag says *there is
   * more*; it does not pretend to know how much.
   */
  readonly hidden: number;
}

/**
 * The ancestor directories of a file, shallowest first — `a/b/c.tex` yields
 * `a/` and `a/b/`.
 *
 * The trailing slash is load-bearing rather than decorative. It says
 * *directory* in the row with no chrome to say it; it reads correctly in prose
 * (*"look in results/"*); and it makes the containment property literal —
 * `file.startsWith(folder)` — instead of a rule about inserting a separator,
 * which is one fewer place to get it wrong.
 */
function ancestorsOf(file: string): string[] {
  const parts = file.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(`${parts.slice(0, i).join("/")}/`);
  }
  return out;
}

/**
 * Wrap a path in double quotes when it contains whitespace — Codex's rule
 * (`chat_composer.rs`, `insert_selected_path`), including its escape.
 *
 * Codex quotes so its local prompt-arg parser treats the path as one argument;
 * Lemmaria has no such parser and quotes so a **model reading prose** does. The
 * effect is the one that matters in both: the path reads as one thing rather
 * than as two. A path that already contains a quote is left alone, for Codex's
 * own reason — quoting a quoted string is worse than not quoting, and an
 * escaping scheme is machinery nothing else in this product has.
 */
function quoteIfNeeded(path: string): string {
  if (!/\s/.test(path)) return path;
  if (path.includes('"')) return path;
  return `"${path}"`;
}

/**
 * True when this root's paths cannot be written so they name it (D3).
 *
 * A grant's label is `basename(realpath(dir))`, which is **empty** for a drive
 * or filesystem root — and `${""}/${rel}` reads as an ABSOLUTE path, the one
 * shape D3 says may never be inserted. Such a root contributes no rows at all
 * rather than rows nothing can resolve; the host avoids the case by falling
 * back to the grant's id, and this is the second layer, where jsdom can see it.
 * The workspace is exempt because its paths are deliberately unqualified.
 */
function unqualifiable(root: WalkedRoot): boolean {
  return root.qualifier !== undefined && root.qualifier.trim() === "";
}

/** The rows one root contributes, in the order design §2 asks for. */
function rowsForRoot(root: WalkedRoot): InsertCandidate[] {
  if (unqualifiable(root)) return [];

  // The entry joins the FILE set rather than being prepended to the finished
  // list, so its ancestors are derived like any other file's. `listFiles` can
  // return more than the cap and be sliced, leaving an entry that is not in
  // `files` — and a candidate whose parent folders were never derived would
  // break D2's containment property for no reason (E3 code review).
  const entry = root.entry;
  const files = new Set(root.files);
  if (entry !== undefined) files.add(entry);

  const folders = new Set<string>();
  for (const file of files) {
    for (const dir of ancestorsOf(file)) folders.add(dir);
  }

  const rest = [...files, ...folders]
    .filter((p) => p !== entry)
    .sort(byShallowest);
  const ordered = entry !== undefined ? [entry, ...rest] : rest;

  return ordered.map((rel) => {
    const qualified =
      root.qualifier === undefined ? rel : `${root.qualifier}/${rel}`;
    return {
      // What is matched and what is displayed. The qualifier is INSIDE the
      // path rather than a prefix bolted onto it, which is the second reason
      // D3 chose the label over the grant id: `rank` warns that candidates
      // sharing a long prefix rank badly, and `g1:` on every granted row is
      // exactly that prefix. `codebase/results/…` is just a path.
      name: qualified,
      // A path has no description (D5), and inventing one would restate what
      // the first segment already says while competing for the width the path
      // itself needs.
      description: "",
      kind: "insert" as const,
      group: "paths" as const,
      // **The sigil stays** (ADR 0053, superseding ADR 0052 D4). It was
      // dropped through E3's gate round on the reasoning that `@` summons the
      // menu where `/skill:` IS the harness's grammar. The operator's round
      // settled that `@` is grammar too: a reference the reader can see in the
      // message they sent, and one that survives a copy-paste into and out of
      // plain text, which a bare path does not. The quoting rule below is
      // applied to the path and the sigil goes in FRONT of the quotes, so an
      // insertion always begins with the sigil and a path with a space in it is
      // still one run — the two properties a parser would read it back by.
      insertion: `${SIGIL_AT.sigil}${quoteIfNeeded(qualified)}`,
    };
  });
}

/**
 * Every `@` candidate, workspace first and then each grant in order.
 *
 * The order within a root is design §2's: **the discovered paper entry first,
 * then shallowest-first alphabetical** — using the harness's own
 * {@link byShallowest} rather than a second copy of it, so the menu and
 * `discoverPaperEntry` can never order the same tree differently. Folders sort
 * into that same order, which puts a directory immediately before what is under
 * it.
 */
export function pathCandidates(paths: ContextPaths): InsertCandidate[] {
  const out: InsertCandidate[] = [];
  if (paths.workspace) out.push(...rowsForRoot(paths.workspace));
  for (const grant of paths.grants) out.push(...rowsForRoot(grant));
  return out;
}

/** What was refused, summed — or nothing at all when nothing was cut. */
export function pathExclusions(
  paths: ContextPaths,
): ExclusionSummary | undefined {
  const roots = [
    ...(paths.workspace ? [paths.workspace] : []),
    ...paths.grants,
  ];
  let truncated = false;
  let hidden = 0;
  for (const root of roots) {
    if (root.excluded.truncated) truncated = true;
    hidden +=
      (root.excluded.byDefault ?? 0) +
      (root.excluded.byGitignore ?? 0) +
      (root.excluded.bySkipDir ?? 0);
  }
  // Absent rather than zeroed: a summary that always exists is a note that
  // always renders, and "0 hidden" is chrome saying nothing.
  if (!truncated && hidden === 0) return undefined;
  return { truncated, hidden };
}

/**
 * The line the `@` menu shows about what it could NOT offer, or nothing.
 *
 * **Three distinguishable silences, and the order below is the whole point.**
 *
 * 1. **No root at all** — no paper folder open and no grant. That is a state the
 *    user can act on, so it names both ways out. It is checked FIRST and by the
 *    roots rather than by the row count, because a granted folder that is
 *    gitignored in full also yields zero rows, and telling that user to grant a
 *    folder they have already granted is advice they have already taken.
 * 2. **Entries a filter refused, or a walk that hit its cap** — B4/A6's
 *    counted-never-dropped rule. **Both are rendered when both are true**: a
 *    count shown alone where an unknown remainder also exists is a precise
 *    number standing in for an uncounted one, which is the invented count A6
 *    removed from the tool.
 * 3. **A root that is simply empty** — no note; the menu's own empty state says
 *    there is no match, and there is nothing further to explain.
 *
 * It lives here rather than in `main.ts` so that the mapping from
 * {@link pathExclusions} to a rendered line is asserted under jsdom. The first
 * version of it was in `main.ts`, untested, and had 1 and 2 the wrong way round.
 */
export function contextNote(
  paths: ContextPaths,
  locale: SessionLocale,
): string | undefined {
  if (!paths.workspace && paths.grants.length === 0) {
    return tr(locale, "menuNoContext");
  }
  const cut = pathExclusions(paths);
  if (!cut) return undefined;
  if (cut.hidden > 0 && cut.truncated) {
    return tr(locale, "menuPathsHiddenAndTruncated").replace(
      "{n}",
      String(cut.hidden),
    );
  }
  if (cut.hidden > 0) {
    return tr(locale, "menuPathsHidden").replace("{n}", String(cut.hidden));
  }
  return tr(locale, "menuPathsTruncated");
}
