/**
 * The composer's completion logic — one module, parameterised by sigil (E2,
 * ADR 0049; design §1).
 *
 * **DOM-free and message-free, deliberately.** It answers three questions and
 * performs no effect: *is there a token under the caret*, *which candidates
 * match it and which of their characters did*, and *what does the text look
 * like once one is taken*. `main.ts` owns the textarea and the `postMessage`;
 * `parts/menu.ts` owns the element. That split is what makes every rule below
 * assertable under jsdom (ADR 0037) instead of arriving at the gate as an
 * *eyes* item.
 *
 * **The load-bearing rule is that the UI must not be able to produce a string
 * the engine ignores** — and it still is. What changed at
 * [ADR 0050](../../../../Lemmaria-design-doc/docs/adr/0050-skills-anywhere-in-a-message.md)
 * is which grammar the two agreed ON. E2 shipped with `/` anchored at position
 * 0 because `session/skill-invocation.ts`'s regex was anchored, and narrowing
 * the menu to the engine was the right move given that engine. The operator
 * then drove Codex's **VS Code extension** and found it invokes skills
 * mid-input, several to a message; the evidence this build had for the anchor
 * came from Codex's **TUI**, a different surface, and generalising from it was
 * the error. So BOTH sides moved to the same whitespace-delimited rule, in one
 * commit, and the invariant is unchanged: the menu and the regex agree, and
 * neither is loosened alone.
 *
 * Prior art: Codex's `bottom_pane/` — one `current_prefixed_token` serving
 * every sigil, one `selection_popup_common.rs` row shape, `MAX_POPUP_ROWS = 8`,
 * and the `fuzzy_match` whose scoring and Unicode index mapping this adapts.
 */
import type { SessionLocale } from "@lemmaria/harness";
// §8: the menu's own chrome is Lemmaria's text, so it is locale-keyed in the
// one table that holds every such string. A skill's description is NOT — see
// `skillCandidates`.
import { tr } from "./strings.js";

/**
 * How many rows the menu shows at once — Codex's `MAX_POPUP_ROWS`, and Codex's
 * reason: one height across every popup, so the surface feels like one thing.
 *
 * Pi makes it a setting (`getAutocompleteMaxVisible()`). Rejected on YAGNI: a
 * setting nobody has asked for costs a locale-keyed label, a persistence
 * question and a test, where a constant costs nothing.
 */
export const MAX_ROWS = 8;

/** Where a sigil is allowed to begin a token. */
export type SigilAnchor = "start" | "boundary";

export interface SigilRule {
  readonly sigil: string;
  readonly anchor: SigilAnchor;
}

/**
 * `/` may begin any whitespace-delimited word (ADR 0050).
 *
 * It was `"start"` through E2. The asymmetry with {@link SIGIL_AT} is therefore
 * **gone**, and that is a simplification rather than a loss: one anchoring rule
 * now serves both sigils, and E3 inherits a `boundary` that two engines agree
 * on instead of one that only `@` used.
 */
export const SIGIL_SLASH: SigilRule = { sigil: "/", anchor: "boundary" };

/**
 * `@` may begin any whitespace-delimited word (E3's sigil, anchored here so
 * that E3 inherits the rule proven rather than re-deriving it).
 */
export const SIGIL_AT: SigilRule = { sigil: "@", anchor: "boundary" };

/** The sigil-prefixed word the caret is inside. */
export interface ActiveToken {
  /** Index of the sigil in the text. */
  readonly start: number;
  /** One past the token's last character — the first whitespace, or the end. */
  readonly end: number;
  /** Everything between the sigil and `end`. May be empty. */
  readonly query: string;
}

/** What accepting a row does (design §3). Exactly two kinds, and no third. */
export type CompletionKind = "insert" | "command";

/**
 * The menu's groups, in the order they render (E2 D3).
 *
 * `commands` and `skills` are `/`'s; `paths` is `@`'s (E3). They never mix in
 * one menu — the candidate source is chosen by sigil, which is what the design's
 * *Alternatives rejected* means by "shared module, separate sources".
 */
export type CandidateGroup = "commands" | "skills" | "paths";

/**
 * The message a `command` row posts.
 *
 * It is the `WebviewToHost` type name itself, so the row and the button it
 * duplicates cannot drift apart: `/new` and the ＋ button post the same string
 * because it is written once.
 */
export type CommandVerb = "newSession" | "compactSession" | "resumeSession";

interface CandidateBase {
  /**
   * The name WITHOUT its sigil — `"new"`, `"skill:tone"`,
   * `"codebase/results/final.csv"`. **This is what is matched and what is
   * displayed**, and from E3 on it is NOT necessarily what is written: see
   * {@link InsertCandidate.insertion}.
   */
  readonly name: string;
  /**
   * Shown beside the name. For a skill this is **the author's own text**,
   * whatever scripts it mixes — invariant 6's stated boundary (ADR 0045).
   * Lemmaria localizes what it writes as its own, never what it displays as
   * someone else's. A path row carries `""`: a path has no description, and
   * synthesising one would restate what the path already says (E3, D5).
   */
  readonly description: string;
  readonly group: CandidateGroup;
}

/** A row that posts a message and clears its token — `/new`, `/compact`, … */
export interface CommandCandidate extends CandidateBase {
  readonly kind: "command";
  readonly command: CommandVerb;
}

/** A row that writes text into the composer — `/skill:<name>`, `@path`. */
export interface InsertCandidate extends CandidateBase {
  readonly kind: "insert";
  /**
   * **Exactly what replaces the token**, sigil and all where there is one.
   *
   * Carried rather than derived from {@link label}, which is what E2 did. For
   * `/skill:` the two are the same string, because there the sigil IS the
   * engine's grammar. For `@` they are not: the row shows `@codebase/x.csv`
   * and writes `codebase/x.csv`, because nothing downstream parses `@` and a
   * sigil left standing in prose is a token something may later parse — the
   * cost [ADR 0050](../../../../Lemmaria-design-doc/docs/adr/0050-skills-anywhere-in-a-message.md)
   * §5 has already paid once. Codex's `insert_selected_path` drops it for the
   * same reason its own token rule does not need it, and Pi follows.
   */
  readonly insertion: string;
}

/**
 * A row the menu can offer.
 *
 * **A union on `kind`, not one shape with optional fields.** E2 carried
 * `command?: CommandVerb` on every candidate and paid for it with a branch in
 * `acceptCompletion` its own comment called unreachable — a defensive test that
 * existed only because the type could not say what was true. The union deletes
 * the branch and, more usefully, gives an `insert` row somewhere to say what it
 * writes, which is what lets `@` write something other than its label.
 */
export type Candidate = CommandCandidate | InsertCandidate;

export interface Ranked {
  readonly candidate: Candidate;
  /** Smaller is better. Codex's convention, and Codex's arithmetic. */
  readonly score: number;
  /**
   * Which characters matched, as **code-point** offsets into the DISPLAYED
   * label — the sigil included, so a renderer bolds them directly without
   * re-deriving an offset. Codex shifts by one for the same reason.
   */
  readonly matchIndices: readonly number[];
}

/** Horizontal or vertical — a token ends at either. */
function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/**
 * The sigil-prefixed token the caret is inside, or nothing.
 *
 * **The caret must be inside the token** (`start < caret <= end`), which is a
 * deliberate divergence from Codex: its command popup stays open over
 * `/clear something`, filtering on the first token so the popup doubles as help
 * for a verb that takes arguments. Lemmaria's `/skill:<name> <request>` is free
 * text after the slug, so a menu that stayed open over the request would be one
 * the user cannot dismiss by typing what they came to type. {@link
 * applyCompletion}'s trailing space is what moves the caret out.
 */
export function activeToken(
  text: string,
  caret: number,
  rule: SigilRule,
): ActiveToken | undefined {
  const at = Math.max(0, Math.min(caret, text.length));

  let start: number;
  if (rule.anchor === "start") {
    if (text[0] !== rule.sigil) return undefined;
    start = 0;
  } else {
    // The start of the whitespace-delimited word the caret is in. Asking
    // whether THAT begins with the sigil is what makes `a@b` an email address
    // rather than a reference, with no second rule about what precedes it.
    let word = at;
    while (word > 0 && !isSpace(text[word - 1])) word--;
    if (text[word] !== rule.sigil) return undefined;
    start = word;
  }

  let end = start + 1;
  while (end < text.length && !isSpace(text[end])) end++;

  if (at <= start || at > end) return undefined;
  return { start, end, query: text.slice(start + 1, end) };
}

interface Match {
  readonly score: number;
  readonly indices: number[];
}

/**
 * One greedy-leftmost pass over a code-point array, with the reported indices
 * shifted by `from` so they address the ORIGINAL name — which is what the
 * highlight renders against, whichever pass won.
 */
function scan(
  points: readonly string[],
  from: number,
  want: readonly string[],
): Match | undefined {
  const chars: string[] = [];
  const origin: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (const lc of (points[i] as string).toLowerCase()) {
      chars.push(lc);
      origin.push(i + from);
    }
  }

  const indices: number[] = [];
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const ch of want) {
    let found = -1;
    while (cursor < chars.length) {
      if (chars[cursor] === ch) {
        found = cursor;
        cursor++;
        break;
      }
      cursor++;
    }
    if (found < 0) return undefined;
    if (first < 0) first = found;
    last = found;
    indices.push(origin[found] as number);
  }

  const span = last - first + 1 - want.length;
  let score = Math.max(span, 0);
  if (first === 0) score -= 100;

  indices.sort((a, b) => a - b);
  return { score, indices: [...new Set(indices)] };
}

/**
 * Where a name's LAST path segment begins, or `-1` if it has none.
 *
 * A trailing `/` is stepped over first, so a folder candidate (`a/b/`) is
 * matched on `b` rather than on the empty string after its own separator.
 */
function lastSegmentStart(points: readonly string[]): number {
  const end =
    points[points.length - 1] === "/" ? points.length - 1 : points.length;
  for (let i = end - 1; i >= 0; i--) if (points[i] === "/") return i + 1;
  return -1;
}

/**
 * A case-insensitive subsequence match, scored by contiguity and earliness.
 *
 * Adapted from Codex's `fuzzy_match`: the score is the span the match occupies
 * beyond the needle's own length — 0 when contiguous — with a large bonus for
 * starting at the first character. Smaller is better. Fuzzy-score tuning and
 * MRU ranking were weighed and rejected: this is a list tens of items long, not
 * thousands.
 *
 * **The pass is tried twice: over the whole name, and over its LAST PATH
 * SEGMENT — the better score wins** (E3, [ADR 0052]). A name with no `/` gets
 * one attempt and is scored exactly as before, which is every `/` row, since a
 * skill's name is `skill:<slug>`; E2's ranking tests pass unmodified.
 *
 * The second attempt exists because {@link scan} is complete for EXISTENCE and
 * only a heuristic for SPAN, and over paths that heuristic inverted the answer.
 * `@final` matched `…/another-quite-long-segment/` and
 * `…/another-quite-long-segment/final-results-table.csv` **at the same
 * scattered positions** — the folder's path is a prefix of the file's, so the
 * leftmost characters are literally the same ones — so the contiguous `final`
 * at the tail was never reached, the two scored identically, and the
 * alphabetical tie-break put the folder above the file whose name the user had
 * just typed. Found by the real-webview test rather than by reasoning; the old
 * text of this comment predicted it (*"a consumer whose names share a LONGER
 * prefix — a path, say — would want to strip it before ranking"*), and
 * [ADR 0049] decision 8 named paths as where it would bite.
 *
 * Ranking on the last segment is also what every file picker does — VS Code's
 * Quick Open, Codex's file popup — so it is the convention users arrive with.
 *
 * **One inherited behaviour worth knowing before reusing this**: within a
 * single pass the match is **greedy-leftmost, so the score is not optimal**.
 * Each needle character takes the first haystack character that satisfies it
 * and the cursor never backtracks, so a later, tighter run is not found. Pinned
 * by *"matches leftmost, so `skill:` can participate"* in the tests. Trying the
 * last segment narrows where this bites; it does not remove it. It also means a
 * candidate is still matched against its whole `name`, prefix included: a
 * skill's name is `skill:<slug>`, so `/s` prefix-bonuses every skill equally
 * (all score -100) and the tie-break alphabetises them — the right answer for a
 * group rendered under its own heading.
 */
function fuzzy(haystack: string, needle: string): Match | undefined {
  if (needle === "") return { score: 0, indices: [] };

  const points = [...haystack];
  const want = [...needle.toLowerCase()];
  const whole = scan(points, 0, want);

  const cut = lastSegmentStart(points);
  if (cut < 0) return whole;
  const tail = scan(points.slice(cut), cut, want);
  if (!whole) return tail;
  if (!tail) return whole;
  return tail.score <= whole.score ? tail : whole;
}

/**
 * The candidates the query matches, best first.
 *
 * **An empty query keeps everything, in source order** — a bare `/` lists the
 * verbs in the order the product names them, and lists them the same way every
 * time. A non-empty query sorts by score, breaking ties alphabetically so the
 * answer does not depend on the order the catalogue happened to load in.
 */
export function rank(
  candidates: readonly Candidate[],
  query: string,
): Ranked[] {
  if (query === "") {
    return candidates.map((candidate) => ({
      candidate,
      score: 0,
      matchIndices: [],
    }));
  }

  const hits: Ranked[] = [];
  for (const candidate of candidates) {
    const m = fuzzy(candidate.name, query);
    if (!m) continue;
    hits.push({
      candidate,
      score: m.score,
      // +1 for the sigil the label carries and the name does not.
      matchIndices: m.indices.map((i) => i + 1),
    });
  }
  hits.sort(
    (a, b) =>
      a.score - b.score || a.candidate.name.localeCompare(b.candidate.name),
  );
  return hits;
}

/** Text plus where the caret ends up in it, and the run that was written. */
export interface Completed {
  readonly text: string;
  readonly caret: number;
  /**
   * Exactly what replaces the token — `insertion` plus whatever gap was added.
   *
   * The caller needs it to make the splice an **undoable** edit: selecting the
   * token and running `insertText` over it is the only insertion Chromium
   * records on the undo stack, and that call takes the written run rather than
   * the finished text. Returning it here keeps the gap rule in one place
   * instead of leaving the caller to re-derive it and get it wrong.
   */
  readonly written: string;
}

/**
 * Replaces the token with `insertion`, separates it from what follows by
 * exactly one space, and reports where the caret goes (design §3).
 *
 * The trailing space is not cosmetic: it is what puts the caret past the token,
 * which is what closes the menu under {@link activeToken}'s caret rule.
 *
 * **A literal space already there is reused rather than doubled** — and only a
 * literal space. A tab or a newline also ends the token, and both get a space
 * inserted before them, which is deliberate: `/skill:tone	more` reads as one
 * run to a token rule that stops at any whitespace but not to a person. Pinned
 * by *"reuses a space that is already there"* and its tab sibling in
 * `test-webview/completion.test.ts`.
 */
export function applyCompletion(
  text: string,
  token: ActiveToken,
  insertion: string,
): Completed {
  const rest = text.slice(token.end);
  const gap = rest.startsWith(" ") ? "" : " ";
  return {
    text: text.slice(0, token.start) + insertion + gap + rest,
    caret: token.start + insertion.length + 1,
    written: insertion + gap,
  };
}

/**
 * Removes the token and reports where the caret goes — the `command` kind's
 * splice, and the mirror image of {@link applyCompletion}.
 *
 * **Why a command does not simply clear the composer.** Design §3 says
 * "clear it", written when the composer was assumed to hold nothing but the
 * verb. It can hold more: `/nw please help me here`, where the user went back
 * to fix a typo in the verb, is a token with a whole draft behind it — and
 * clearing that is a silent data loss of exactly the kind the Esc rule (D6)
 * already refuses to commit. So the token goes and the draft stays; when the
 * token IS the whole text, which is the ordinary case, the result is the empty
 * composer §3 asked for.
 *
 * The single space {@link applyCompletion} would have inserted is removed with
 * it, so `/new draft` leaves `draft` rather than ` draft`.
 */
export function removeToken(text: string, token: ActiveToken): Completed {
  const rest = text.slice(token.end);
  const kept = rest.startsWith(" ") ? rest.slice(1) : rest;
  return {
    text: text.slice(0, token.start) + kept,
    caret: token.start,
    written: "",
  };
}

/** The label a row displays for a candidate — the sigil plus its name. */
export function label(rule: SigilRule, candidate: Candidate): string {
  return rule.sigil + candidate.name;
}

/**
 * The three verbs, in the order the product names them.
 *
 * Each carries the `WebviewToHost` type its command-palette twin already posts,
 * so accepting the row and pressing the button reach the same host function by
 * construction (design §3). No row carries an opinion about *when* a verb is
 * allowed — compaction already refuses, with a localized message, when there is
 * no session, when a task is in flight and when no model is resolved, and a
 * second opinion in the menu would be two homes for one rule.
 */
export function commandCandidates(locale: SessionLocale): CommandCandidate[] {
  return [
    {
      name: "new",
      description: tr(locale, "menuNewDesc"),
      kind: "command",
      group: "commands",
      command: "newSession",
    },
    {
      name: "compact",
      description: tr(locale, "menuCompactDesc"),
      kind: "command",
      group: "commands",
      command: "compactSession",
    },
    {
      name: "history",
      description: tr(locale, "menuHistoryDesc"),
      kind: "command",
      group: "commands",
      command: "resumeSession",
    },
  ];
}

/**
 * `/fork [name]` over a WHOLE message (E6, D10; ADR 0058 §6).
 *
 * The extension's first slash parse, and deliberately its narrowest: the
 * pattern is anchored, so *"we should /fork the repo here"* stays a message to
 * the model and a `/skill:` invocation is untouched. ADR 0050 lets a `/`
 * anywhere open the MENU; that is discovery. This is grammar, and grammar that
 * ate a mid-sentence slash would silently drop a request.
 *
 * `{}` = fork with no name, which inherits the parent's title (D10). `null` =
 * this is not the command, send it as it is.
 *
 * **The trailing-space case is the common one, not an edge.** The `/fork` row
 * is insert-kind, so accepting it leaves exactly `"/fork "` in the composer —
 * a user who presses Enter without typing a name is on this branch, and a
 * pattern that failed there would send their command to the model as prose.
 */
export function parseForkCommand(text: string): { name?: string } | null {
  const m = /^\s*\/fork(?:[ \t]+(\S.*?))?[ \t]*$/.exec(text);
  if (m === null) return null;
  const name = m[1];
  return name === undefined ? {} : { name };
}

/**
 * The `/fork` row — offered only where the command could actually run (D10).
 *
 * **Insert-kind, not command-kind**, because it takes an argument: a command
 * row posts immediately and argument-less, which would make `/fork my name`
 * unreachable from the menu. Accepting this one writes `/fork ` and leaves the
 * caret after the space, and {@link parseForkCommand} reads what follows.
 *
 * **`token.start === 0`, and only that.** The parser is anchored to the whole
 * message, so a `/fork` typed after prose is prose — offering the row there
 * would be the menu promising something the grammar refuses. The parser is the
 * more permissive of the two, tolerating leading whitespace a paste can carry;
 * that asymmetry is the standing rule that the menu is discovery rather than
 * validation, so a command reachable by typing is never made unreachable by
 * the absence of a row.
 */
export function forkCandidates(
  locale: SessionLocale,
  token: ActiveToken,
): InsertCandidate[] {
  if (token.start !== 0) return [];
  return [
    {
      name: "fork",
      description: tr(locale, "menuForkDesc"),
      kind: "insert" as const,
      group: "commands" as const,
      // No trailing space here: `applyCompletion` adds the separator, and a
      // second one would leave `"/fork  "` and a caret past both.
      insertion: `${SIGIL_SLASH.sigil}fork`,
    },
  ];
}

/**
 * The `/review` row — the second harness-parsed composer verb (R3, ADR 0061
 * §2; ADR 0049).
 *
 * **Insert-kind, like `/fork` and for the same reason**: `/review <focus>`
 * takes an optional argument, and a command row posts immediately and
 * argument-less, which would make the focus unreachable from the menu.
 * Accepting this row writes `"/review "` and leaves the caret after the space.
 *
 * `token.start === 0`, and only that: the harness's `parseReviewCommand` is
 * anchored to the whole message, so a `/review` typed after prose is prose.
 * Offering the row there would be the menu promising something the grammar
 * refuses — E6's rule, applied to the verb that came after it.
 *
 * The verb itself is NOT parsed here. `/fork` is the extension's own command
 * and its parser lives beside this; `/review` is the harness's, so the one
 * source of truth is `parseReviewCommand` in `session/review-panel.ts` and the
 * webview only offers the row.
 */
export function reviewCandidates(
  locale: SessionLocale,
  token: ActiveToken,
): InsertCandidate[] {
  if (token.start !== 0) return [];
  return [
    {
      name: "review",
      description: tr(locale, "menuReviewDesc"),
      kind: "insert" as const,
      group: "commands" as const,
      // No trailing space: `applyCompletion` adds the separator.
      insertion: `${SIGIL_SLASH.sigil}review`,
    },
  ];
}

/**
 * The `/review-pdf` row — the third harness-parsed composer verb (V4, ADR 0081
 * §8), offered under `/review`'s rule and for its reasons.
 *
 * Insert-kind, because `/review-pdf <focus>` takes an optional focus that a
 * command row could not reach; `token.start === 0` only, because the
 * harness's `parsePdfReviewCommand` is anchored to the whole message. The
 * verb is parsed there and nowhere else — this only offers the row.
 */
export function reviewPdfCandidates(
  locale: SessionLocale,
  token: ActiveToken,
): InsertCandidate[] {
  if (token.start !== 0) return [];
  return [
    {
      name: "review-pdf",
      description: tr(locale, "menuReviewPdfDesc"),
      kind: "insert" as const,
      group: "commands" as const,
      // No trailing space: `applyCompletion` adds the separator.
      insertion: `${SIGIL_SLASH.sigil}review-pdf`,
    },
  ];
}

/** The one field of a loaded skill the menu needs, plus the one it shows. */
export interface SkillRowSource {
  readonly name: string;
  readonly description: string;
}

/**
 * One `/skill:<name>` insert row per loaded skill.
 *
 * The description is passed through **untouched**. Every loaded skill's `name`
 * already satisfies the invocation regex's slug grammar — the loader rejects
 * any other with an `invalid_name` diagnostic — so the menu cannot emit a slug
 * the engine would treat as prose.
 */
export function skillCandidates(
  skills: readonly SkillRowSource[],
): InsertCandidate[] {
  return skills.map((s) => ({
    name: `skill:${s.name}`,
    description: s.description,
    kind: "insert" as const,
    group: "skills" as const,
    // The sigil is kept here, and only here: `/skill:` is the harness's own
    // grammar (ADR 0047 as amended by ADR 0050), so the row's label and the
    // text it writes are the same string. `@` is the case where they differ.
    insertion: `${SIGIL_SLASH.sigil}skill:${s.name}`,
  }));
}
