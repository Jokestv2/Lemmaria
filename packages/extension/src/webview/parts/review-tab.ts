/**
 * The Review tab, for both kinds of review (R3, ADR 0061 §10; ADR 0037).
 *
 * It rendered inside `main.ts` until R3, which is why no locale claim about it
 * could be asserted offline. The panel adds seat groups, a synthesis, an
 * honesty record and three new per-row facts — too much to leave un-testable —
 * so the whole renderer moves here, and QUICK mode goes through it unchanged:
 * one path, or the mode the milestone did not touch is the one that rots.
 *
 * Pure in the sense ADR 0037 means: it reads its state from the argument, its
 * strings from `strings.ts`, and reaches the host only through the callbacks
 * it is given. No `acquireVsCodeApi`, no module-level state.
 */
import type {
  ModelFailureCause,
  ReviewLimit,
  SeatBudget,
  SessionLocale,
} from "@lemmaria/harness";
import type {
  ReviewAnnotationInfo,
  ReviewHistoryEntry,
  ReviewSeatInfo,
  ReviewTabState,
} from "../../webview-protocol.js";
import {
  type LimitRow,
  type LostEntries,
  type SetAsideLimit,
  type SourceStatus,
  type VerificationMark,
  isWithdrawn,
  limitRows,
  lostBySeat,
  movedFrom,
  panelFacts,
  setAsideLimits,
  sharedModel,
  verificationCompleted,
  verificationMark,
} from "./review-facts.js";
import { pdfFactsBlock } from "./review-pdf-facts.js";
import { type ReviewRunView, reviewProgress } from "./review-progress.js";
import {
  dimensionLabel,
  hasContributor,
  renderScorecard,
} from "./review-scorecard.js";
import { citeRow, el, foldedGroup } from "./rows.js";
import { type StringKey, dayStamp, tr, versionLabel } from "./strings.js";

const R_GLYPH: Record<string, string> = { info: "○", minor: "⚠", major: "✗" };
/** J1's round: each severity's word on the id line, per locale. */
const SEVERITY_KEY: Record<string, StringKey> = {
  info: "rSeverityInfo",
  minor: "rSeverityMinor",
  major: "rSeverityMajor",
};
const R_COLOR: Record<string, string> = {
  info: "is-faint",
  minor: "is-warning",
  major: "is-error",
};

/**
 * V6 (open-questions → *some Review-tab text a reader has to read is still
 * drawn in the disabled token*, trigger fired): an info concern's TITLE is
 * text a reader reads, so it takes the dim token like the four X6 moved.
 * `citeRow` colours the glyph, the title and an Adopt button with one class,
 * so the title alone is swapped here and the glyph keeps its faintness.
 */
function dimInfoTitle(row: HTMLElement, severity: string): void {
  if (R_COLOR[severity] !== "is-faint") return;
  row
    .querySelector(".lm-cite-row__title")
    ?.classList.replace("is-faint", "is-dim");
}

// V6 (ADR 0088): the one dimension table lives with the scorecard block,
// which labels every row; the tab imports it from there and re-exports it
// for the callers that always found it here.
export { dimensionLabel };

/** What the tab needs from its host: the postMessage sends, and the fold-open
 *  flags the transcript's re-render would otherwise reset.
 *
 *  The two flags became a keyed pair at the R3 gate-review round (ADR 0062 §4):
 *  every group here folds now, and a boolean per group is a boolean the caller
 *  would have to add a field for each time a seat is added to the table. */
export interface ReviewTabDeps {
  locale: SessionLocale;
  reveal: (index: number) => void;
  /** V1 (ADR 0076 §9): open the passage that answered a withdrawn concern.
   *  By index, like every other route — the index stays the handle. */
  revealCounter: (index: number) => void;
  ignore: (index: number) => void;
  adopt: (index: number) => void;
  /** ADR 0063 §3: hand a concern to the assistant — a prompt is composed from
   *  it, sent, and the concern moves to the archive as *with the assistant*.
   *  Takes the whole annotation, not an index, because the prompt is built
   *  from its message, location, evidence and suggested wording. */
  resolve: (a: ReviewAnnotationInfo) => void;
  /** ADR 0062 §6: take this concern to the Assistant tab, composer prefilled. */
  chat: (a: ReviewAnnotationInfo) => void;
  /** ADR 0062 §1: show another review of this window. */
  selectReview: (id: number) => void;
  /** ADR 0062 §2: run the paper-entry picker. */
  chooseEntry: () => void;
  /** ADR 0064 §2: start a blind panel — the launcher's verb, equivalent to
   *  typing `/review` in the composer. */
  runPanel: () => void;
  /** V4 (ADR 0081 §8): review the compiled PDF alone — the launcher's second
   *  verb, equivalent to typing `/review-pdf`. Optional, and the button is
   *  drawn only when it is given: a button with nothing behind it is a
   *  control that cannot be operated. `main.ts` always gives it. */
  runPdf?: () => void;
  /** ADR 0065 §3: stop the running one. */
  stopPanel: () => void;
  /** ADR 0065 §3: the panel in flight, if any — what the transcript card used
   *  to draw, now drawn in the launcher.
   *
   *  This REPLACES ADR 0064 §3's `busy`, and the replacement is the decision,
   *  not a rename: `busy` meant *a chat task is running*, because a panel was
   *  a chat task and starting one mid-task would have become steering. A panel
   *  is not a message any more, so a chat running beside it is no reason to
   *  refuse — the only thing that gates Run is another review. */
  run?: ReviewRunView;
  /** Is this group open? Unknown keys answer with the group's own default,
   *  which is why this is a function and not a set. */
  groupOpen: (key: string, fallback: boolean) => boolean;
  onGroupToggle: (key: string, open: boolean) => void;
  /** V6 (ADR 0088 §4): the dimension the concern list is narrowed to — view
   *  state `main.ts` holds beside the folds, never persisted. Ignored where
   *  the state carries no card (a quick review). */
  narrowed?: string;
  /** V6: narrow to a dimension, or clear (`undefined`); `reveal` names a
   *  concern to land on once the cleared list is drawn. Optional, like
   *  `runPdf`, and for its reason: without it a scorecard row is drawn as
   *  text, not as a control that cannot be operated. `main.ts` gives it. */
  onNarrow?: (dimension: string | undefined, reveal?: string) => void;
  /** V6: the concern this render lands on — a synthesis chip's target that
   *  a narrowing hid, handed back after the narrowing is cleared. The tab
   *  opens its fold and marks it; `main.ts` scrolls it into view. */
  target?: string;
}

/** Where a line is: `L<n>` when its file is the ENTRY (or unnamed), and
 *  `<file>:<n>` otherwise — a quick review never shows a file, and a panel
 *  shows one exactly where the reader would otherwise assume the entry.
 *
 *  `entry` is the state's WORKSPACE-RELATIVE entry, never its display `file`:
 *  quick mode's header is a basename, so comparing against that would print
 *  `sections/intro.tex:12` for the very file the header already names — and
 *  never `nextEntry`, which is the next run's (ADR 0064 §1).
 *
 *  ONE rule for the claim and its evidence (ADR 0075 §6). The evidence line
 *  used to print a bare `L<n>` whatever file its line was in, which is how two
 *  copies of one suppression rule drift apart. */
function whereOf(file: string, line: number, entry: string): string {
  return file === entry || file === "" ? `L${line}` : `${file}:${line}`;
}

/** V1 (ADR 0076 §9): each mark's words. A `Record`, so a mark the facts add
 *  is a compile error here rather than a row that says nothing. */
const MARK_KEY: Record<VerificationMark, StringKey> = {
  unchecked: "rConcernUnchecked",
  opinion: "rConcernOpinion",
  unsettled: "rConcernUnsettled",
};

/** ADR 0082 §2: each budget a seat can run out of — its heading's words, and
 *  the limits fold's sentence naming the setting to raise. `Record`s, so a
 *  budget the contract adds is a compile error here, not a silent reason. */
const SEAT_RAN_OUT_KEY: Record<SeatBudget, StringKey> = {
  turns: "rSeatRanOutTurns",
  tool_calls: "rSeatRanOutToolCalls",
  output_tokens: "rSeatRanOutOutput",
};
const LIMIT_RAN_OUT_KEY: Record<SeatBudget, StringKey> = {
  turns: "rLimitRanOutTurns",
  tool_calls: "rLimitRanOutToolCalls",
  output_tokens: "rLimitRanOutOutput",
};

/** The detail line under a concern's message: its id, severity, the blocking
 *  badge by exception, what the verifier could not settle (panel only, by
 *  exception), where it is, and the suggested wording if any.
 *
 *  `marks` is off in quick mode: a quick action has no verifier, and saying
 *  *not checked* there would describe a feature it never had. */
function detailOf(
  locale: SessionLocale,
  a: ReviewAnnotationInfo,
  entry: string,
  marks: boolean,
): string {
  // J1's round: the severity in the reader's language (invariant 6 rule 2) —
  // a record word the table does not know passes through as it came.
  const severity = SEVERITY_KEY[a.severity];
  const parts = [
    a.id,
    severity !== undefined ? tr(locale, severity) : a.severity,
  ];
  if (a.blocking === true) parts.push(tr(locale, "rBlocking"));
  const mark = marks ? verificationMark(a) : undefined;
  if (mark !== undefined) parts.push(tr(locale, MARK_KEY[mark]));
  parts.push(whereOf(a.file, a.line, entry));
  if (a.suggestion !== undefined) parts.push(`→ ${a.suggestion}`);
  return parts.join(" · ");
}

/** The evidence line: where the support sits, or that the reviewer looked and
 *  the manuscript offers none. Absent evidence renders NOTHING — a quick
 *  action's prompt never asks for it, and a blank line would read as a finding
 *  the review did not make.
 *
 *  V2 (ADR 0078 D12): a third kind. A `paper` is prior work rather than a
 *  passage, so it draws a TITLE instead of a location — and, when the host
 *  judged its URL openable, a link. */
function evidenceLine(
  locale: SessionLocale,
  a: ReviewAnnotationInfo,
  entry: string,
  cited?: number,
): HTMLElement | undefined {
  if (a.evidence === undefined) return undefined;
  const row = el("div", { class: "lm-cite-row__evidence" });
  if (a.evidence.kind === "missing") {
    row.append(tr(locale, "rNoEvidence"));
    return row;
  }
  if (a.evidence.kind === "span") {
    row.append(
      `${tr(locale, "rEvidence")} · ${whereOf(a.evidence.file, a.evidence.line, entry)}`,
    );
    return row;
  }
  // V4 (ADR 0081 §4): a page of the compiled PDF — text, never a link: the
  // tab holds no PDF to open, and the page is where the reviewer SAW it.
  if (a.evidence.kind === "page") {
    // ADR 0085 §4: a cite the harness moved (ADR 0084) says the page the
    // reviewer cited, here where the reader meets it — a concern whose message
    // still describes the old page is then read against both.
    const page =
      cited === undefined
        ? tr(locale, "rEvidencePage")
        : tr(locale, "rEvidencePageMoved").replace("{cited}", String(cited));
    row.append(
      `${tr(locale, "rEvidence")} · ${page.replace("{n}", String(a.evidence.page))}`,
    );
    return row;
  }
  // A paper: `prior work · Title (year)`, where the title is the openable part.
  const { title, year, href } = a.evidence;
  row.append(`${tr(locale, "rPriorWork")} · `);
  if (href === undefined) {
    // No openable URL is not an error and gets no affordance: plain text says
    // *this is the work*, and nothing promises it can be opened.
    row.append(el("span", { class: "lm-review-paper" }, title));
  } else {
    // NO click handler, deliberately — the transcript's own markdown links
    // (`parts/markdown.ts`) carry none either, and that is why they open.
    // VS Code opens a webview link from a bubble-phase listener on the frame's
    // window, so anything that stops the click here stops the link working:
    // the anchor's default runs instead and navigates the frame itself.
    // Keeping the row from ALSO revealing is `citeRow`'s job, where the
    // handler that would fire lives (`parts/rows.ts`).
    //
    // V2's gate review, issue 1: this line held `stopPropagation()` — taken
    // from the counter button's precedent, which does not transfer, because a
    // `<button>` has no default action to fall back to and an `<a href>` does.
    row.append(el("a", { class: "lm-review-paper", href }, title));
  }
  if (year !== undefined) row.append(` (${year})`);
  return row;
}

/**
 * Is this concern a COPYEDIT — a fix the author can take as a diff, without
 * anyone reading the argument (ADR 0063 §1)?
 *
 * Both halves are load-bearing. `language` is the dimension the protocol tells
 * every seat to file a typo or a grammatical slip under, and the quick action
 * has had the same word since ADR 0008 — which is why this one predicate
 * serves both review modes. `hasSuggestion` is what makes the button real: an
 * *Adopt fix* with no replacement text behind it is a control that cannot be
 * operated, so a `language` concern that arrived without one is not a copyedit
 * here — it goes to the assistant with everything else, which is the honest
 * place for a wording problem nobody wrote the wording for.
 */
export function isCopyedit(a: ReviewAnnotationInfo): boolean {
  return a.dimension === "language" && a.hasSuggestion;
}

/**
 * One pending concern.
 *
 * TWO shapes, and which one it takes is the whole of ADR 0063 (§§2–3). A
 * copyedit offers **Adopt fix**, because there is a replacement to splice and
 * a diff is the right review of it. Everything else offers **Resolve with
 * assistant**, because a concern about a claim is rarely a change to one
 * paragraph — it can touch the abstract, the discussion and every passage
 * that leans on it, and swapping one anchored run of text would leave the
 * paper contradicting itself. Ignore and Chat are on both: disagreeing with a
 * reviewer, and wanting to talk before acting, are unrelated to which kind of
 * fix a concern needs.
 */
function concernRow(
  a: ReviewAnnotationInfo,
  entry: string,
  deps: ReviewTabDeps,
  marks: boolean,
  cited?: number,
): HTMLElement {
  const { locale } = deps;
  const evidence = evidenceLine(locale, a, entry, cited);
  const row = citeRow(
    R_GLYPH[a.severity] ?? "○",
    R_COLOR[a.severity] ?? "is-faint",
    `${dimensionLabel(locale, a.dimension)}: ${a.message}`,
    detailOf(locale, a, entry, marks),
    {
      ...(evidence ? { extra: [evidence] } : {}),
      onClick: () => deps.reveal(a.index),
      ...(isCopyedit(a)
        ? {
            adopt: () => deps.adopt(a.index),
            adoptLabel: tr(locale, "rAdopt"),
          }
        : {
            resolve: () => deps.resolve(a),
            resolveLabel: tr(locale, "rResolve"),
          }),
      ignore: () => deps.ignore(a.index),
      ignoreLabel: tr(locale, "rIgnore"),
      chat: () => deps.chat(a),
      chatLabel: tr(locale, "rChat"),
    },
  );
  dimInfoTitle(row, a.severity);
  // ADR 0062 §5: each concern is a CARD of its own, and ADR 0062 §7 needs to
  // find one by the id a synthesis chip cites.
  row.classList.add("lm-review-card");
  row.setAttribute("data-concern", a.id);
  return row;
}

/**
 * Where the manuscript answers a withdrawn concern (V1, ADR 0076 §9): a button,
 * because it opens that passage, then the verifier's note as authored.
 *
 * Named by the claim's own rule (`whereOf` against the REVIEWED entry, never
 * the next run's — ADR 0075 §6). The click stops at the button, so the row's
 * own reveal — the claim — does not also fire.
 */
function counterLines(
  a: ReviewAnnotationInfo,
  entry: string,
  deps: ReviewTabDeps,
): HTMLElement[] {
  const counter = a.verification?.counter;
  if (counter === undefined) return [];
  const button = el("button", {
    class: "lm-review-counter",
  }) as HTMLButtonElement;
  button.append(
    ...withSlot(
      tr(deps.locale, "rCounterAt"),
      "{where}",
      document.createTextNode(whereOf(counter.file, counter.line, entry)),
    ),
  );
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    deps.revealCounter(a.index);
  });
  const note = a.verification?.note;
  return note !== undefined && note !== ""
    ? [button, el("div", { class: "lm-review-counter__note" }, note)]
    : [button];
}

/**
 * One withdrawn concern (V1, ADR 0076 §9): the concern as it was raised, the
 * passage that answered it, and **Chat and Ignore only**. Resolve would hand
 * the assistant a concern the manuscript already answers — a request to fix a
 * non-problem — and Adopt would apply a fix to it; an author who disagrees
 * with the verifier still has Chat.
 */
function withdrawnRow(
  a: ReviewAnnotationInfo,
  entry: string,
  deps: ReviewTabDeps,
  cited?: number,
): HTMLElement {
  const { locale } = deps;
  const evidence = evidenceLine(locale, a, entry, cited);
  const row = citeRow(
    R_GLYPH[a.severity] ?? "○",
    R_COLOR[a.severity] ?? "is-faint",
    `${dimensionLabel(locale, a.dimension)}: ${a.message}`,
    detailOf(locale, a, entry, true),
    {
      extra: [...(evidence ? [evidence] : []), ...counterLines(a, entry, deps)],
      onClick: () => deps.reveal(a.index),
      ignore: () => deps.ignore(a.index),
      ignoreLabel: tr(locale, "rIgnore"),
      chat: () => deps.chat(a),
      chatLabel: tr(locale, "rChat"),
    },
  );
  dimInfoTitle(row, a.severity);
  row.classList.add("lm-review-card");
  row.setAttribute("data-concern", a.id);
  return row;
}

/** The word for how a concern left the pending list (ADR 0062 §5) — the three
 *  are different claims and the archive says which one was made. */
const ARCHIVED_KEY: Record<string, StringKey> = {
  accepted: "rStatusAccepted",
  ignored: "rStatusIgnored",
  handed: "rStatusHanded",
};
const ARCHIVED_GLYPH: Record<string, string> = {
  accepted: "✓",
  ignored: "⊘",
  // Not a tick. ADR 0063 §3: the concern was handed over, not finished, and a
  // tick beside it would claim a verification nobody performed.
  handed: "→",
};

/** One archived concern — read-only, no action buttons. */
function archivedRow(
  a: ReviewAnnotationInfo,
  entry: string,
  deps: ReviewTabDeps,
  marks: boolean,
): HTMLElement {
  const key = ARCHIVED_KEY[a.status];
  const row = citeRow(
    ARCHIVED_GLYPH[a.status] ?? "⊘",
    a.status === "accepted" ? "is-ok" : "is-faint",
    `${dimensionLabel(deps.locale, a.dimension)}: ${a.message}`,
    `${key === undefined ? a.status : tr(deps.locale, key)} · ${detailOf(deps.locale, a, entry, marks)}`,
    { onClick: () => deps.reveal(a.index) },
  );
  row.classList.add("lm-review-card");
  row.setAttribute("data-concern", a.id);
  return row;
}

/**
 * ADR 0086: one set-aside rule, as its fold draws it — the rule's own
 * sentence, then what each concern it caught SAID, so a reader can check the
 * rule against it.
 *
 * Read-only, and no reveal: no Adopt, Resolve, Ignore or Chat. The review
 * decided the concern was not a finding, and a button on it would offer to act
 * on one. A reader who disagrees has the sentence, the words and the place —
 * enough to raise it with the Assistant themselves. The page is the one the
 * seat CITED: a set-aside concern is never moved (ADR 0084). A record stored
 * before ADR 0086 kept no concern, and draws the sentence alone, as it did.
 */
function asideBlock(
  locale: SessionLocale,
  limit: SetAsideLimit,
  entry: string,
  pdfReviewer?: string,
  /** V6 (ADR 0088 §4): which concerns a narrowing leaves in view. The rule's
   *  sentence stays the record's, whole — it counts what the RULE did. */
  inView: (dimension: string) => boolean = () => true,
): HTMLElement {
  const block = el(
    "div",
    { class: "lm-review-aside" },
    el(
      "div",
      { class: "lm-review-aside__rule" },
      limitSentence(locale, limit, pdfReviewer),
    ),
  );
  for (const { dimension, concern } of limit.entries) {
    if (concern === undefined || !inView(dimension)) continue;
    const severity = SEVERITY_KEY[concern.severity];
    const detail = [
      severity !== undefined ? tr(locale, severity) : concern.severity,
    ];
    if (concern.blocking === true) detail.push(tr(locale, "rBlocking"));
    detail.push(whereOf(concern.span.file, concern.span.line, entry));
    const page =
      concern.page === undefined
        ? undefined
        : el(
            "div",
            { class: "lm-cite-row__evidence" },
            `${tr(locale, "rEvidence")} · ${tr(locale, "rEvidencePage").replace("{n}", String(concern.page))}`,
          );
    const row = citeRow(
      R_GLYPH[concern.severity] ?? "○",
      "is-faint",
      `${dimensionLabel(locale, dimension)}: ${concern.message}`,
      detail.join(" · "),
      page !== undefined ? { extra: [page] } : {},
    );
    // NOT `lm-review-card`: that is the concern card a reader triages, and
    // the hook a synthesis chip lands on (ADR 0062 §5, §7). This is a record
    // of one, set in under its rule.
    row.classList.add("lm-review-aside__concern");
    block.append(row);
  }
  return block;
}

/** Parts of one line, as a node a heading or a mark can hold. */
function line(...parts: (Node | string)[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...parts);
  return fragment;
}

/** A model id, in a span of its own. The stylesheet keeps it whole — it
 *  moves to the next line rather than breaking at a hyphen (`gpt-` /
 *  `5.6-luna`) — and out of a heading's uppercase, because an id is
 *  case-sensitive (the X6 review round). */
function modelId(model: string): HTMLElement {
  return el("span", { class: "lm-review-model" }, model);
}

/** A sentence with a node in its one slot. Split, never `replace`d, so the
 *  slot's value is set as text whatever it contains — a `$&` in a user's
 *  model id stays a `$&`. */
function withSlot(
  sentence: string,
  slot: string,
  node: Node,
): (Node | string)[] {
  const at = sentence.indexOf(slot);
  if (at < 0) return [sentence];
  return [sentence.slice(0, at), node, sentence.slice(at + slot.length)];
}

/** ` · <model>` and the unverified mark, or nothing — the one spelling of a
 *  model in a heading, shared by the seats and the cross-review (ADR 0075 §5)
 *  so the two cannot disagree about when a model is worth naming.
 *
 *  R9 (ADR 0069 §D8): the model ID, not a friendly label — this module has no
 *  model list to resolve one against, and the running chip beside it says the
 *  same thing the same way. Omitted entirely for a row recorded before R9,
 *  whose replay normalizes it to `""` (A22): the heading simply says less. The
 *  unverified mark is by exception (ADR 0023: two verdicts, no `below`), and
 *  carries its own separator in each locale. It is ours, so it sits OUTSIDE
 *  the id's span. */
function modelSegment(
  locale: SessionLocale,
  model: string | undefined,
  unverified: true | undefined,
): (Node | string)[] {
  if (model === undefined || model === "") return [];
  return [
    " · ",
    modelId(model),
    ...(unverified === true ? [tr(locale, "rSeatModelUnverified")] : []),
  ];
}

/** A seat's heading: its name and its count, or why it reported nothing.
 *
 *  `shown` is what the group actually renders, which since ADR 0063 §2 is no
 *  longer the same as what the seat raised — its copyedits have moved to their
 *  own group. A heading reading `soundness · 5` over three rows sends the
 *  reader hunting for two concerns that are on screen somewhere else.
 *
 *  ADR 0075 §1: FIVE shapes, first match wins. The *raised nothing* line still
 *  keys off the seat's own count — a fact about the REVIEW that stays true
 *  however the rows are arranged — and now also off nothing having been LOST:
 *  a reviewer whose every entry the locator dropped, or whose every entry was
 *  rejected for its shape, recorded nothing too, and *raised no concern* was
 *  the opposite of what happened. `lost` comes from the limits alone. */
function seatHeading(
  locale: SessionLocale,
  seat: ReviewSeatInfo,
  shown: number,
  lost: LostEntries | undefined,
  /** V4 (ADR 0081 §3): the name to print, when it is not the seat's own —
   *  the PDF reviewer is the one seat the tab does not print raw. */
  name: string = seat.reviewer,
  /** V6 (ADR 0088 §4): under a narrowing, how many rows the group holds in
   *  all — the count then reads `shown of total`, so the heading still
   *  counts what its group shows (ADR 0063 §2) and says what the whole was. */
  total?: number,
): DocumentFragment {
  // R9 (ADR 0069 §D8): who reviewed, and on what. Two reviewers agreeing means
  // one thing when they are the same model and another when they are not, so
  // the model belongs on EVERY branch — knowing which model produced nothing,
  // or produced an unreadable report, is exactly what a mixed panel is for.
  const who = [name, ...modelSegment(locale, seat.model, seat.unverified)];
  if (seat.missing !== undefined) {
    // ADR 0082 §2: a budget the seat ran out of wins over the reason, which
    // for such a seat is `unparsed` only because there was nothing to parse.
    const ranOutOf = seat.missing.ranOutOf;
    const key: StringKey =
      ranOutOf !== undefined
        ? SEAT_RAN_OUT_KEY[ranOutOf]
        : seat.missing.reason === "interrupted"
          ? "rSeatInterrupted"
          : seat.missing.reason === "unparsed"
            ? "rSeatUnparsed"
            : "rSeatFailed";
    return line(...who, ` — ${tr(locale, key)}`);
  }
  if (seat.count === 0) {
    const dropped = lost?.dropped ?? 0;
    const rejected = lost?.rejected ?? 0;
    const n = dropped + rejected;
    if (n > 0) {
      // The count and the verdict; the split between the two ways stays in
      // the limits fold's two sentences, and no `reason` is ever printed.
      // Any rejection makes it *unrecorded*: an entry that never parsed was
      // not lost to the locator, and *could not be anchored* would say it was.
      const key: StringKey =
        rejected > 0
          ? n === 1
            ? "rSeatOneUnrecorded"
            : "rSeatAllUnrecorded"
          : n === 1
            ? "rSeatOneUnanchored"
            : "rSeatAllUnanchored";
      return line(...who, ` — ${tr(locale, key).replace("{n}", String(n))}`);
    }
    // ADR 0083 §2: a PDF reviewer whose every concern was about the argument
    // raised concerns — the panel set them aside, and the heading says so.
    // ADR 0085 §2: so is one whose concerns were review-mode furniture, and
    // one with both is told plainly rather than as either kind.
    const setAside = lost?.setAside ?? 0;
    const furniture = lost?.furniture ?? 0;
    const aside = setAside + furniture;
    if (aside > 0) {
      const key: StringKey =
        setAside > 0 && furniture > 0
          ? "rSeatAllSetAsideMixed"
          : furniture > 0
            ? aside === 1
              ? "rSeatOneFurniture"
              : "rSeatAllFurniture"
            : aside === 1
              ? "rSeatOneSetAside"
              : "rSeatAllSetAside";
      return line(
        ...who,
        ` — ${tr(locale, key).replace("{n}", String(aside))}`,
      );
    }
    // No quota (the stage's rule): a reviewer that found nothing SAYS so.
    return line(...who, ` — ${tr(locale, "rSeatNone")}`);
  }
  // The count and its unit in one span, which the stylesheet keeps together:
  // a narrow sidebar broke `· 9` from `条意见` onto the next line.
  return line(
    ...who,
    " · ",
    el(
      "span",
      { class: "lm-review-count" },
      total !== undefined && total > 0
        ? tr(locale, "scSeatConcernsOf")
            .replace("{shown}", String(shown))
            .replace("{total}", String(total))
        : `${shown} ${tr(locale, "rSeatConcerns")}`,
    ),
  );
}

/**
 * The results header's one line about the panel (ADR 0075 §3): how many
 * reviewers, on how many distinct models, and — by exception, in a fixed
 * order — how many did not report and why.
 *
 * A RESULTS line, rebuilt from the stored review on every render; ADR 0065
 * §3's removal of the in-flight card's counts is about a different moment.
 * The models segment is omitted when any reviewer's model is unknown
 * (`panelFacts`), so the line never claims a diversity it cannot count.
 */
function panelLine(
  locale: SessionLocale,
  seats: readonly ReviewSeatInfo[],
): string {
  const facts = panelFacts(seats);
  const count = (key: StringKey, n: number): string =>
    tr(locale, key).replace("{n}", String(n));
  const parts = [
    count(
      facts.reviewers === 1 ? "rHeadReviewersOne" : "rHeadReviewersMany",
      facts.reviewers,
    ),
  ];
  if (facts.models !== undefined)
    parts.push(
      count(
        facts.models === 1 ? "rHeadModelsOne" : "rHeadModelsMany",
        facts.models,
      ),
    );
  if (facts.failed > 0) parts.push(count("rHeadFailed", facts.failed));
  if (facts.interrupted > 0)
    parts.push(count("rHeadInterrupted", facts.interrupted));
  if (facts.unparsed > 0) parts.push(count("rHeadUnparsed", facts.unparsed));
  if (facts.outOfBudget > 0)
    parts.push(count("rHeadOutOfBudget", facts.outOfBudget));
  return parts.join(" · ");
}

/** Our sentence for each way a model request fails (ADR 0074 §7's classes). */
const CAUSE_KEY: Record<ModelFailureCause["class"], StringKey> = {
  // One home for the quota sentence: the transcript's notice says it already.
  quota: "noticeProviderQuota",
  retryable: "rCauseRetryable",
  fatal: "rCauseFatal",
};

/**
 * Why a reviewer — or the cross-review — failed (ADR 0075 §2): OUR sentence
 * for the cause's class in the reader's language, then, only when the
 * provider sent words, those words under a label saying whose they are.
 *
 * The provider's message is third-party text passing as authored (invariant
 * 6's E1 boundary; ADR 0074 §7): set as text, never parsed, never truncated,
 * never translated — and never in place of our sentence, because a reader
 * whose language the provider does not speak still has to be told what
 * happened. The stylesheet wraps it rather than this module clamping it.
 */
function causeLine(
  locale: SessionLocale,
  cause: ModelFailureCause,
): HTMLElement {
  const block = el(
    "div",
    { class: "lm-review-cause" },
    el(
      "div",
      { class: "lm-review-cause__ours" },
      tr(locale, CAUSE_KEY[cause.class]),
    ),
  );
  const message = cause.message;
  if (typeof message === "string" && message.trim() !== "") {
    block.append(
      el(
        "div",
        { class: "lm-review-cause__theirs" },
        // A replacer function, so a `$&` in the provider's text stays text.
        tr(locale, "rCauseProvider").replace("{message}", () => message),
      ),
    );
  }
  return block;
}

/**
 * One synthesis entry: its note, then the ids it is about, as chips you can
 * click (ADR 0062 §7).
 *
 * The chips always named real concerns — `interpretSynthesis` drops an entry
 * whose ids it cannot locate — and a reader who saw `soundness-2` had to scroll
 * three seat groups looking for it. `jump` is given the id and finds the row;
 * the chip stays a chip and gains a role, so nothing about the list changes.
 */
function synthesisEntry(
  note: string,
  ids: readonly string[],
  jump: (id: string) => void,
  jumpLabel: string,
  /** ADR 0075 §4: the same-model mark, already in the reader's language —
   *  drawn between the note and its chips, which stay the click target. */
  mark?: Node,
): HTMLElement {
  const wrap = el("div", { class: "lm-review-note" }, note);
  if (mark !== undefined)
    wrap.append(el("div", { class: "lm-review-note__mark" }, mark));
  const chips = el("div", { class: "lm-review-chips" });
  for (const id of ids) {
    const c = el(
      "button",
      { class: "lm-review-chip lm-review-chip--link", title: jumpLabel },
      id,
    );
    c.addEventListener("click", () => jump(id));
    chips.append(c);
  }
  wrap.append(chips);
  return wrap;
}

/** One row of the review picker (ADR 0062 §1) — a panel by its version, a
 *  quick review by the file it read; both by the day they ran and what they
 *  found. */
function historyLabel(
  locale: SessionLocale,
  entry: ReviewHistoryEntry,
): string {
  // V4 (ADR 0081 §7): a PDF review is versioned like a panel, and says which
  // kind it is — two versions a reader cannot tell apart are one too many.
  const who =
    entry.version !== undefined
      ? entry.mode === "pdf"
        ? `${versionLabel(locale, entry.version)} · ${tr(locale, "rPdfTitle")}`
        : versionLabel(locale, entry.version)
      : entry.mode === "quick"
        ? `${tr(locale, "rQuickReview")} · ${entry.file}`
        : entry.mode === "pdf"
          ? tr(locale, "rPdfTitle")
          : tr(locale, "rPanelTitle");
  return `${who} · ${dayStamp(entry.at)} · ${entry.concerns} ${tr(locale, "rSeatConcerns")}`;
}

/** A literature source's status word — one table for the single sentence and
 *  the merged row (ADR 0075 §7), so the two cannot word a status apart. */
const SOURCE_STATUS_KEY: Record<SourceStatus, StringKey> = {
  rate_limited: "rReasonRateLimited",
  timeout: "rReasonTimeout",
  failed: "rReasonFailed",
};

/**
 * One row of the limits fold, as one sentence (ADR 0075 §7).
 *
 * A `limit` row is `limitSentence`, untouched. A `source` row is the merged
 * sentence for every reviewer that source failed — reviewers, the source,
 * then its status words, then the key pointer if ANY folded limit ran without
 * one — in the same shape `limitSentence` gives a single failure, so a source
 * that failed for one reviewer with one status reads exactly as it always did.
 */
function limitRowText(
  locale: SessionLocale,
  row: LimitRow,
  pdfReviewer?: string,
): string {
  if (row.kind === "limit")
    return limitSentence(locale, row.limit, pdfReviewer);
  const sep = tr(locale, "rListSep");
  const statuses = row.statuses
    .map((s) => tr(locale, SOURCE_STATUS_KEY[s]))
    .join(sep);
  const name = seatName(locale, pdfReviewer);
  return `${row.reviewers.map(name).join(sep)}: ${row.source} — ${statuses}${
    row.anonymous ? tr(locale, "rReasonAnonymous") : ""
  }`;
}

/**
 * V4 (ADR 0081 §3): a seat's name as the reader sees it. The PDF reviewer is
 * the one seat the tab does not print raw — `pdf_reviewer` is the record's
 * word, and its heading says *PDF reviewer* — so every sentence that names a
 * seat names it the same way. Keyed on the review's own PDF seat, never on a
 * literal, so the record stays the one source of the name.
 */
/** The PDF reviewer's record name (`PDF_REVIEWER_NAME` in the harness). The
 *  webview takes only pure leaf subpaths of the harness (ADR 0011), and the
 *  seat module is not one, so the literal is named here once. */
const PDF_REVIEWER_RECORD_NAME = "pdf_reviewer";

function seatName(
  locale: SessionLocale,
  pdfReviewer: string | undefined,
): (reviewer: string) => string {
  return (reviewer) =>
    pdfReviewer !== undefined && reviewer === pdfReviewer
      ? tr(locale, "rSeatPdfReviewer")
      : reviewer;
}

/** One limit, as one sentence built from its own fields — never model prose
 *  (ADR 0060 D6: the record is structured so each host renders it in the
 *  reader's language, the way a `ToolErrorCode` is rendered).
 *
 *  `pdfReviewer` is the review's PDF seat's name, when it has one (V4): a
 *  limit about that seat names it *PDF reviewer*, as its heading does. */
export function limitSentence(
  locale: SessionLocale,
  limit: ReviewLimit,
  pdfReviewer?: string,
): string {
  const name = seatName(locale, pdfReviewer);
  switch (limit.kind) {
    case "anchors_dropped":
      return `${name(limit.reviewer)}: ${limit.anchors.length} ${tr(locale, "rLimitAnchorsDropped")}`;
    case "seat_missing": {
      // ADR 0082 §2: out of a budget ⇒ which one, and the setting to raise;
      // `detail` stays the harness's English and is never printed.
      if (limit.ranOutOf !== undefined)
        return `${name(limit.reviewer)}: ${tr(locale, LIMIT_RAN_OUT_KEY[limit.ranOutOf])}`;
      const key: StringKey =
        limit.reason === "interrupted"
          ? "rReasonInterrupted"
          : limit.reason === "unparsed"
            ? "rReasonUnparsed"
            : "rReasonFailed";
      return `${name(limit.reviewer)}: ${tr(locale, "rLimitSeatMissing")} (${tr(locale, key)})`;
    }
    case "entries_rejected":
      // X5: the COUNT, never the per-entry `reason` — those are the
      // interpreter's own model-facing English, written for the one re-ask
      // (invariant 6 rule 2). A reader is told how many findings the report
      // lost to its own shape, which is the part that is about their paper.
      //
      // The string carries its own separator and `{n}` slot rather than being
      // concatenated around them, because the two languages punctuate and
      // order this sentence differently — English appends a count, Chinese
      // puts it inside a clause. One locale, one whole sentence — and in
      // English, one per number (X6), since "1 entries … were" is not English.
      return `${name(limit.reviewer)}${tr(
        locale,
        limit.entries.length === 1
          ? "rLimitEntriesRejectedOne"
          : "rLimitEntriesRejected",
      ).replace("{n}", String(limit.entries.length))}`;
    case "concerns_set_aside":
      // ADR 0083 §2: the count, in rLimitEntriesRejected's shape — the string
      // owns its separator and slot, and English has one per number.
      return `${name(limit.reviewer)}${tr(
        locale,
        limit.entries.length === 1 ? "rLimitSetAsideOne" : "rLimitSetAside",
      ).replace("{n}", String(limit.entries.length))}`;
    case "pages_corrected":
      // ADR 0084: the count, in the same shape. Since ADR 0085 §4 the fold
      // draws no row for it (`limitRows`) — each moved concern's evidence
      // line says it — and the sentence stays the record's, whole.
      return `${name(limit.reviewer)}${tr(
        locale,
        limit.entries.length === 1
          ? "rLimitPagesCorrectedOne"
          : "rLimitPagesCorrected",
      ).replace("{n}", String(limit.entries.length))}`;
    case "furniture_set_aside":
      // ADR 0085 §2: the count, in rLimitSetAside's shape.
      return `${name(limit.reviewer)}${tr(
        locale,
        limit.entries.length === 1
          ? "rLimitFurnitureSetAsideOne"
          : "rLimitFurnitureSetAside",
      ).replace("{n}", String(limit.entries.length))}`;
    case "pages_unchecked":
      // ADR 0085 §3: the count, then why, so the reader knows the fix is a
      // compile rather than anything about the paper.
      return `${name(limit.reviewer)}${tr(
        locale,
        limit.entries.length === 1
          ? "rLimitPagesUncheckedOne"
          : "rLimitPagesUnchecked",
      ).replace("{n}", String(limit.entries.length))}${tr(
        locale,
        limit.reason === "aux_older_than_pdf"
          ? "rReasonAuxOlder"
          : "rReasonAuxOtherBuild",
      )}`;
    case "seat_unguided":
      // V4's code review: the driver records this for the PDF reviewer in two
      // cases — it ran without its addendum, or it was SKIPPED because the
      // addendum is not offered. The tab passes the seat's name only when the
      // seat has a row, so a PDF reviewer named with no row never ran, and is
      // said so rather than said to have reviewed.
      if (
        limit.reviewer === PDF_REVIEWER_RECORD_NAME &&
        pdfReviewer === undefined
      )
        return tr(locale, "rLimitPdfSeatSkipped");
      return `${name(limit.reviewer)}: ${tr(locale, "rLimitSeatUnguided")}`;
    case "source_unavailable":
      // R4: only a source that ran WITHOUT a key AND did not answer earns the
      // pointer — by exception, so a keyed source that failed anyway is
      // unchanged and a keyed reader is never nagged.
      return `${name(limit.reviewer)}: ${limit.source} — ${tr(locale, SOURCE_STATUS_KEY[limit.status])}${
        limit.anonymous === true ? tr(locale, "rReasonAnonymous") : ""
      }`;
    case "search_budget_spent":
      return `${name(limit.reviewer)}: ${tr(locale, "rLimitSearchBudget")}`;
    case "synthesis_missing": {
      const key: StringKey =
        limit.reason === "insufficient_seats"
          ? "rReasonInsufficientSeats"
          : limit.reason === "no_report"
            ? "rReasonNoReport"
            : limit.reason === "unparsed"
              ? "rReasonUnparsed"
              : limit.reason === "interrupted"
                ? "rReasonInterrupted"
                : "rReasonFailed";
      return `${tr(locale, "rLimitSynthesisMissing")} (${tr(locale, key)})`;
    }
    case "verification_missing": {
      // V1 (ADR 0076): through a Record, so a reason added to the contract is
      // a compile error here rather than a silent "failed".
      const shape = VERIFICATION_LIMIT[limit.reason];
      return "sentence" in shape
        ? tr(locale, shape.sentence)
        : `${tr(locale, "rLimitVerificationMissing")} (${tr(locale, shape.reason)})`;
    }
    case "own_title_unguarded":
      // V2 (ADR 0078 §D8): one whole sentence per reason, not a shared stem
      // with a reason word — the two say different things to an author (the
      // title could not be read at all, versus the guard was never wired) and
      // neither composes with the reason vocabulary the other limits share.
      return tr(
        locale,
        limit.reason === "no_title"
          ? "rLimitOwnTitleNoTitle"
          : "rLimitOwnTitleUnavailable",
      );
    // V4 (ADR 0081): one whole sentence per reason, for V2's reason above —
    // each tells the author something different to do.
    case "pdf_unavailable":
      return tr(locale, PDF_UNAVAILABLE_KEY[limit.reason]);
    case "visual_unavailable":
      return tr(
        locale,
        limit.reason === "model_has_no_image_input"
          ? "rLimitVisualNoImageInput"
          : "rLimitVisualNoRenderer",
      );
    case "pages_unviewed":
      return tr(locale, "rLimitPagesUnviewed")
        .replace("{viewed}", String(limit.viewed))
        .replace("{total}", String(limit.total));
    case "strengths_lost":
      // V5 (ADR 0087 §1): the count, dropped and rejected together — never
      // the quote, never a reason (the interpreter's model-facing English).
      return tr(locale, "rLimitStrengthsLost")
        .replace("{reviewer}", name(limit.reviewer))
        .replace("{n}", String(limit.dropped.length + limit.rejected.length));
  }
}

/** V4 (ADR 0081): each `pdf_unavailable` reason's sentence — through a Record,
 *  so a reason added to the contract is a compile error here. */
const PDF_UNAVAILABLE_KEY: Record<
  Extract<ReviewLimit, { kind: "pdf_unavailable" }>["reason"],
  StringKey
> = {
  none: "rLimitPdfNone",
  stale: "rLimitPdfStale",
  compile_failed: "rLimitPdfCompileFailed",
  render_failed: "rLimitPdfRenderFailed",
};

/**
 * How each `verification_missing` reason reads (V1, ADR 0076). Three are whole
 * sentences of their own; the four a child can end in compose with the reason
 * words `synthesis_missing` already uses, so the same failure reads the same
 * way wherever it happened.
 */
const VERIFICATION_LIMIT: Record<
  Extract<ReviewLimit, { kind: "verification_missing" }>["reason"],
  { sentence: StringKey } | { reason: StringKey }
> = {
  off: { sentence: "rLimitVerificationOff" },
  no_protocol: { sentence: "rLimitVerificationNoProtocol" },
  incomplete: { sentence: "rLimitVerificationIncomplete" },
  interrupted: { reason: "rReasonInterrupted" },
  failed: { reason: "rReasonFailed" },
  no_report: { reason: "rReasonNoReport" },
  unparsed: { reason: "rReasonUnparsed" },
};

/**
 * The launcher (ADR 0064 §1–§3): which file the paper starts at, a way to
 * change it, and a way to start a panel — drawn at the top of the tab in every
 * state, including before any review has run.
 *
 * It names `state.nextEntry`, never `state.entry`. The row describes what the
 * NEXT panel will read; the review below it describes what one already did,
 * and the two are the same string right up until the reader uses Change, which
 * is the only moment the distinction matters and the moment a single field
 * would quietly claim the review on screen had read the new file.
 */
function launcher(state: ReviewTabState, deps: ReviewTabDeps): HTMLElement {
  const { locale } = deps;
  const row = el(
    "div",
    { class: "lm-review-launch" },
    el(
      "div",
      { class: "lm-review-entry" },
      el(
        "span",
        { class: "lm-review-entry__label" },
        `${tr(locale, "rEntryLabel")}: `,
      ),
      el(
        "span",
        {
          class:
            state.nextEntry === ""
              ? "lm-review-entry__file is-faint"
              : "lm-review-entry__file",
        },
        state.nextEntry === "" ? tr(locale, "rEntryNone") : state.nextEntry,
      ),
    ),
  );
  const change = el(
    "button",
    { class: "lm-review-entry__change" },
    tr(locale, "rEntryChange"),
  ) as HTMLButtonElement;
  // NOT disabled when there is no folder to choose within. The command answers
  // that case with a warning that says why (`entryNeedsFolder`), and a dead
  // button says nothing at all — the same call ADR 0062 §2 made.
  change.addEventListener("click", () => deps.chooseEntry());
  (row.firstElementChild as HTMLElement).append(change);

  // ADR 0065 §3: the panel's progress, where the transcript card used to be.
  // Above the verb, so the row reads top-to-bottom as *this is what is
  // happening* then *this is what you can do about it*.
  if (deps.run !== undefined) {
    row.append(reviewProgress(deps.run, locale, () => deps.stopPanel()));
  }

  const busy = deps.run?.running === true;
  const run = el("button", {
    class: "lm-review-launch__run",
    ...(busy ? { disabled: "true", title: tr(locale, "rRunPanelBusy") } : {}),
  }) as HTMLButtonElement;
  run.textContent = tr(locale, "rRunPanel");
  // Disabled while a REVIEW runs — one panel at a time, because two would
  // spend twice and race for the version number. Not while a chat task runs:
  // ADR 0064 §3's reason for that (a send mid-task becomes steering) went away
  // with ADR 0065 §2, which stopped the panel being a send at all. The host
  // refuses the same click a second time.
  run.addEventListener("click", () => {
    if (busy) return;
    deps.runPanel();
  });
  row.append(run);

  // V4 (ADR 0081 §8): the second verb, *Review the PDF* — after the panel's,
  // under the same one-review-at-a-time rule and with the same busy title,
  // because it is a review like any other and races for the same version
  // number. It posts no payload (ADR 0064 §2): the host learns nothing about
  // what a review is from the tab.
  const runPdf = deps.runPdf;
  if (runPdf !== undefined) {
    const pdf = el("button", {
      class: "lm-review-launch__pdf",
      ...(busy ? { disabled: "true", title: tr(locale, "rRunPanelBusy") } : {}),
    }) as HTMLButtonElement;
    pdf.textContent = tr(locale, "rRunPdf");
    pdf.addEventListener("click", () => {
      if (busy) return;
      runPdf();
    });
    row.append(pdf);
  }
  return row;
}

/**
 * The whole tab. `undefined`/unavailable renders the empty hint under the
 * launcher, so a window that has run no review still has somewhere to start.
 */
export function renderReviewTab(
  state: ReviewTabState | undefined,
  deps: ReviewTabDeps,
): HTMLElement {
  const { locale } = deps;
  const panel = el("div", {
    // `lm-review-tab` scopes the R3-gate-round styling (ADR 0062 §5's outlined
    // cards, §4's larger headings) to THIS tab. `.lm-cite-row` is shared with
    // Citations and Compile, and giving every list in the product an outline
    // was not what was asked for.
    class: "lm-content lm-review-tab",
    role: "tabpanel",
    id: "lm-tabpanel",
  });
  // ADR 0064 §1: FIRST, and above the `available` gate. The launcher is what
  // the tab offers a reader who has run no review yet — which is precisely the
  // reader who needs to say which file the paper starts at. ADR 0062 §2 put
  // Change inside the results, where it could only be reached by first
  // reviewing the wrong document.
  if (state !== undefined) panel.append(launcher(state, deps));
  if (!state || !state.available) {
    panel.append(el("div", { class: "lm-cite-empty" }, tr(locale, "rEmpty")));
    return panel;
  }
  const allPending = state.annotations.filter((a) => a.status === "pending");
  // ADR 0063 §2: the copyedits come OUT of the seat groups and into one group
  // of their own. A seat's typo has nothing to do with its lens — grouping it
  // under `soundness` files a mechanical fix beside an argument, and the two
  // are cleared in completely different ways.
  //
  // PANEL ONLY, and the same call D9 made about the limits list. A quick review
  // is a pass over one unit of prose that routinely finds two or three wording
  // nits and nothing else; folding those into a group — a closed one — would
  // hide the entire result of the action the user just ran. The grouping
  // answers a problem a THREE-SEAT reading of a whole manuscript has. What
  // does apply in both modes is the button each row carries: that is about
  // what a concern IS, not about how many of them there are.
  //
  // V4 (ADR 0081 §7): a PDF review is grouped like a panel. It is a seat's
  // reading of the whole compiled paper, and a copyedit it raises is still a
  // copyedit — so it leaves the seat's group for Copyedit here too.
  const grouped = state.mode !== "quick";
  // V6 (ADR 0088 §4): a scorecard row narrows every concern list below to
  // its dimension. Only where there IS a card — a quick review has none, so a
  // narrowing left over from a panel is ignored there — and matched
  // case-insensitively: the card lowercases a dimension, the wire does not.
  // What is ABOUT the review (the header's count, the panel line, the
  // picker, the PDF's facts, the cross-review, the limits) is not narrowed.
  // A card no seat contributed to has no row and no banner, so a narrowing
  // carried onto it from another version would hide concerns with nothing on
  // screen to say so or to clear it.
  const narrowed =
    state.scorecard !== undefined &&
    hasContributor(state.scorecard) &&
    deps.narrowed !== undefined
      ? deps.narrowed.toLowerCase()
      : undefined;
  const inView = (dimension: string): boolean =>
    narrowed === undefined || dimension.toLowerCase() === narrowed;
  const shows = (a: ReviewAnnotationInfo): boolean => inView(a.dimension);
  // V4 (ADR 0081 §5): the PDF reviewer's concerns are never checked — the
  // verifier has no eyes — and the tab says so ONCE, under that seat's
  // heading. So no row of that seat carries the per-row *not checked* mark,
  // in whichever fold it lands (Copyedit and the archive included): by the
  // seat that raised it, not by where it is drawn.
  const pdfSeat = grouped ? state.pdfSeat : undefined;
  const pdfName = pdfSeat?.reviewer;
  const marked = (a: ReviewAnnotationInfo): boolean =>
    grouped && a.reviewer !== pdfName;
  // ADR 0085 §4: the page each moved concern cited, for its own row to say.
  const moved = movedFrom(state.limits);
  // V1 (ADR 0076 §9): what verification withdrew leaves its reviewer's group
  // AND the Copyedit group, for one fold of its own. Panel only — a quick
  // action has no verifier.
  const withdrawn = grouped ? allPending.filter(isWithdrawn).filter(shows) : [];
  const standing = grouped
    ? allPending.filter((a) => !isWithdrawn(a))
    : allPending;
  const copyedits = grouped ? standing.filter(isCopyedit).filter(shows) : [];
  // Unnarrowed: a seat's heading counts its group's rows OF all of them.
  const pending = grouped ? standing.filter((a) => !isCopyedit(a)) : allPending;
  // ADR 0062 §5: ONE archive, in the review's own order, each row saying which
  // way it went. Three folds for three verbs was three places to look for the
  // concern you triaged a minute ago.
  const archived = state.annotations.filter((a) => a.status !== "pending");
  const entry = state.entry;

  const header = el("div", { class: "lm-cite-header" });
  const headerText = el(
    "div",
    { class: "lm-cite-header__text" },
    el(
      "div",
      { class: "lm-cite-title" },
      // ADR 0062 §3. The header used to be `Blind panel · main.tex`, which
      // reads as *a review OF main.tex* — and the panel reads the whole
      // manuscript: every `.tex`/`.md`/`.bib` the workspace lists. The entry
      // is where the document BEGINS, so it is named below, labelled.
      state.mode === "panel"
        ? `${tr(locale, "rPanelTitle")} · ${tr(locale, "rPanelWhole")}`
        : // V4 (ADR 0081 §7): the PDF of this entry — compiled from it, or
          // found beside it — so here the entry IS what was reviewed.
          state.mode === "pdf"
          ? state.file === ""
            ? tr(locale, "rPdfTitle")
            : `${tr(locale, "rPdfTitle")} · ${state.file}`
          : state.file,
    ),
    el(
      "div",
      { class: "lm-cite-sub" },
      // ALL of them, copyedits included: the sub-line is how much is left to
      // deal with, and a typo folded away is still a typo (ADR 0063 §2).
      `${allPending.length} ${tr(locale, "rAnnotations")}`,
    ),
  );
  // ADR 0075 §3: beneath the title and the count, one line about the panel
  // itself. Panel only, and only with seat rows to count — a review stored
  // before R9 has none, and the line would count nothing.
  const seats = state.seats ?? [];
  if (state.mode === "panel" && seats.length > 0) {
    headerText.append(
      el("div", { class: "lm-review-panelline" }, panelLine(locale, seats)),
    );
  }
  header.append(headerText);
  panel.append(header);

  // ADR 0062 §1: which review is on screen, and a way to the others. Drawn
  // only when there IS another — a select with one option is a control that
  // cannot be operated.
  const history = state.history ?? [];
  if (history.length > 1) {
    const select = el("select", {
      class: "lm-review-picker",
      "aria-label": tr(locale, "rPickerLabel"),
    }) as HTMLSelectElement;
    // Newest first: the review a reader wants is almost always the last one.
    for (const item of [...history].reverse()) {
      const option = el(
        "option",
        { value: String(item.id) },
        historyLabel(locale, item),
      ) as HTMLOptionElement;
      if (item.id === state.selected) option.setAttribute("selected", "");
      select.append(option);
    }
    if (state.selected !== undefined) select.value = String(state.selected);
    select.addEventListener("change", () =>
      deps.selectReview(Number(select.value)),
    );
    panel.append(select);
  }

  // ADR 0062 §2/§3 drew the entry here, with Change on it. ADR 0064 §1 moved
  // both to the launcher above, and what is left is the honest remainder: when
  // the shown review read a DIFFERENT file from the one the launcher now
  // names, say so. Drawn only on that disagreement — the two agree in the
  // ordinary case, and printing the same path twice taught the reader nothing.
  // Panel only: a quick review is of a selection, and its entry is incidental
  // to it rather than the document it read. (A PDF review read its entry's
  // PDF, so it says the same.)
  if (grouped && entry !== "" && entry !== state.nextEntry) {
    panel.append(
      // V6 (the disabled-token entry): text a reader reads, so the entry
      // row's own dim colour, not the disabled token it used to carry.
      el(
        "div",
        { class: "lm-review-entry" },
        `${tr(locale, "rEntryWas")} ${entry}`,
      ),
    );
  }

  // V6 (ADR 0088 §3): the scorecard — the summary of the reading, so under
  // the header and above everything the reading produced, the PDF's facts
  // included. Drawn from the card the host derived; present for panel and
  // PDF reviews, never for a quick one.
  if (state.scorecard !== undefined) {
    const counted = state.annotations.filter((a) => !isWithdrawn(a));
    const onNarrow = deps.onNarrow;
    panel.append(
      renderScorecard(
        {
          card: state.scorecard,
          ...(state.previous !== undefined ? { previous: state.previous } : {}),
          ...(state.delta !== undefined ? { delta: state.delta } : {}),
          ...(pdfName !== undefined ? { pdfReviewer: pdfName } : {}),
          // No seat row at all: nothing ran (V6's E1 round).
          ...((state.seats ?? []).length === 0 && state.pdfSeat === undefined
            ? { noSeat: true as const }
            : {}),
          ...(narrowed !== undefined
            ? {
                narrowed,
                narrow: {
                  dimension: narrowed,
                  shown: counted.filter(shows).length,
                  total: counted.length,
                },
              }
            : {}),
        },
        locale,
        onNarrow !== undefined ? { onNarrow: (d) => onNarrow(d) } : {},
      ),
    );
  }

  // V4 (ADR 0081 §1): the facts about the compiled PDF — after the header and
  // its panel line, before any seat group, in both modes that read a PDF.
  // Facts, not findings: nothing in the block is a concern or invites one.
  if (grouped && state.pdf !== undefined) {
    panel.append(pdfFactsBlock(locale, state.pdf));
  }

  /** Every concern row this render built, by the id a synthesis chip cites,
   *  with the fold it sits in — §7's jump needs both. */
  const located = new Map<
    string,
    { row: HTMLElement; fold?: HTMLDetailsElement; key?: string }
  >();
  /** §7: open the fold the concern sits in, put it on screen, and flash it.
   *  The flash is a CSS animation restarted by removing the class and
   *  forcing a reflow — no timer left running. A synthesis chip lands here,
   *  and so, since V6, does the render that cleared a narrowing for one. */
  const land = (found: {
    row: HTMLElement;
    fold?: HTMLDetailsElement;
    key?: string;
  }): void => {
    if (found.fold !== undefined && !found.fold.open) {
      found.fold.open = true;
      if (found.key !== undefined) deps.onGroupToggle(found.key, true);
    }
    for (const other of located.values())
      other.row.classList.remove("is-target");
    // jsdom performs no layout: `scrollIntoView` is absent there and
    // `offsetWidth` is 0. Both are incidental to what the click DOES. (For a
    // V6 landing the row is not yet attached; `main.ts` scrolls it after.)
    found.row.scrollIntoView?.({ block: "center" });
    void found.row.offsetWidth;
    found.row.classList.add("is-target");
  };

  // The `length` test, not `!== undefined`: a review persisted before R9 has
  // no seat rows at all (`StoredReview.seats` is optional and nothing could
  // invent them), so `seatsOf` hands back `[]` — and a grouped branch taken on
  // presence alone would loop zero times and append no concern row while the
  // header above still counted every one of them. The honest degradation is
  // the FLAT list below, the same one quick mode uses: the record does not say
  // who raised what, so the tab does not group. It does not reconstruct the
  // groups from the annotations either — a reviewer that reported nothing
  // would be missing from that reconstruction, and an incomplete panel would
  // read as a complete one.
  //
  // V4 (ADR 0081 §7): a PDF review has no reviewers — its one group is the
  // PDF reviewer's.
  const reviewerSeats = state.mode === "panel" ? seats : [];
  if (reviewerSeats.length > 0 || pdfSeat !== undefined) {
    // Grouped by REVIEWER, in the panel's own order — its structure is N
    // independent readings, and a flat list would hide that. ADR 0062 §4
    // folds each group: a reader works one reviewer at a time, and three open
    // lists at a real sidebar width is the wall the operator saw.
    const lost = lostBySeat(state.limits);
    for (const seat of reviewerSeats) {
      const all = pending.filter((x) => x.reviewer === seat.reviewer);
      const rows = all.filter(shows);
      const key = `seat:${seat.reviewer}`;
      const built = new Map<string, HTMLElement>();
      const fold = foldedGroup(
        seat.reviewer,
        rows,
        // OPEN by default: the tab's job is to read at a glance, and a panel
        // that arrives collapsed hides the review it just paid for.
        deps.groupOpen(key, true),
        (open) => deps.onGroupToggle(key, open),
        (a) => {
          const row = concernRow(a, entry, deps, true, moved.get(a.id));
          built.set(a.id, row);
          return row;
        },
        {
          summary: seatHeading(
            locale,
            seat,
            rows.length,
            lost.get(seat.reviewer),
            undefined,
            narrowed !== undefined ? all.length : undefined,
          ),
          class: "lm-review-fold--group",
        },
      ) as HTMLDetailsElement;
      // ADR 0075 §2: a failed reviewer says why, directly under its heading
      // and before any row. The contract only ever puts a cause on
      // `reason: "failed"`, so stopped and unreadable reviewers get none.
      const cause = seat.missing?.cause;
      if (cause !== undefined) {
        fold.firstElementChild?.after(causeLine(locale, cause));
      }
      for (const [id, row] of built) located.set(id, { row, fold, key });
      panel.append(fold);
    }
    // V4 (ADR 0081 §3): the PDF reviewer, after the reviewers and before
    // Copyedit — one seat among the panel's, through the same five heading
    // shapes, OPEN on arrival for the reviewers' reason. Named *PDF reviewer*
    // rather than by its record word, and with no per-row mark: the sentence
    // under the heading says it once for the whole group.
    if (pdfSeat !== undefined) {
      const all = pending.filter((x) => x.reviewer === pdfSeat.reviewer);
      const rows = all.filter(shows);
      const key = `seat:${pdfSeat.reviewer}`;
      const built = new Map<string, HTMLElement>();
      const title = tr(locale, "rSeatPdfReviewer");
      const fold = foldedGroup(
        title,
        rows,
        deps.groupOpen(key, true),
        (open) => deps.onGroupToggle(key, open),
        (a) => {
          const row = concernRow(a, entry, deps, false, moved.get(a.id));
          built.set(a.id, row);
          return row;
        },
        {
          summary: seatHeading(
            locale,
            pdfSeat,
            rows.length,
            lost.get(pdfSeat.reviewer),
            title,
            narrowed !== undefined ? all.length : undefined,
          ),
          class: "lm-review-fold--group",
        },
      ) as HTMLDetailsElement;
      fold.setAttribute("data-seat", pdfSeat.reviewer);
      const under: HTMLElement[] = [];
      const cause = pdfSeat.missing?.cause;
      if (cause !== undefined) under.push(causeLine(locale, cause));
      // ADR 0081 §5: only when verification COMPLETED. When it did not, the
      // limits fold already says the concerns were not checked. And only over
      // rows: under a group that holds none — J1's seat, out of calls — the
      // sentence spoke of concerns that were never there.
      if (
        rows.length > 0 &&
        verificationCompleted(state.verifier, state.limits)
      ) {
        under.push(
          el(
            "div",
            { class: "lm-review-unchecked" },
            tr(locale, "rSeatPdfUnchecked"),
          ),
        );
      }
      fold.firstElementChild?.after(...under);
      for (const [id, row] of built) located.set(id, { row, fold, key });
      panel.append(fold);
    }
  } else {
    for (const a of pending.filter(shows)) {
      const row = concernRow(a, entry, deps, marked(a), moved.get(a.id));
      located.set(a.id, { row });
      panel.append(row);
    }
  }

  // ADR 0063 §2: the copyedits, in one group, wherever the seats put them.
  //
  // AFTER the substantive concerns and CLOSED by default — the two exceptions
  // to ADR 0062 §4's *open on arrival*, and for that rule's own reason. A
  // language pass on a real manuscript is long and each row is seconds of
  // work; opened on arrival it is precisely the wall §4 was written to
  // remove, and it would push the review the panel was actually asked for
  // below the fold. The heading carries the count, so nothing is hidden — it
  // is one click, and the click is the reader saying *now I am copy-editing*.
  if (copyedits.length > 0) {
    const key = "copyedit";
    const built = new Map<string, HTMLElement>();
    const fold = foldedGroup(
      tr(locale, "rCopyedit"),
      copyedits,
      deps.groupOpen(key, false),
      (open) => deps.onGroupToggle(key, open),
      (a) => {
        const row = concernRow(a, entry, deps, marked(a), moved.get(a.id));
        built.set(a.id, row);
        return row;
      },
      {
        summary: `${tr(locale, "rCopyedit")} · ${copyedits.length}`,
        class: "lm-review-fold--group",
      },
    ) as HTMLDetailsElement;
    // §7's chips cite copyedits too — a synthesis may agree about a typo — so
    // these rows are locatable exactly like the ones above.
    for (const [id, row] of built) located.set(id, { row, fold, key });
    panel.append(fold);
  }

  // V1 (ADR 0076 §9): what verification withdrew — after Copyedit, before the
  // cross-review, CLOSED on arrival for Copyedit's own reason: a reader is not
  // asked to read what the panel has already set aside, and the heading's
  // count says it is there. It is not the Archive: the archive holds what the
  // READER finished with; this holds what the PANEL withdrew (ADR 0062 §5).
  if (withdrawn.length > 0) {
    const key = "withdrawn";
    const built = new Map<string, HTMLElement>();
    const verifier = state.verifier;
    const fold = foldedGroup(
      tr(locale, "rWithdrawn"),
      withdrawn,
      deps.groupOpen(key, false),
      (open) => deps.onGroupToggle(key, open),
      (a) => {
        const row = withdrawnRow(a, entry, deps, moved.get(a.id));
        built.set(a.id, row);
        return row;
      },
      {
        summary: line(
          tr(locale, "rWithdrawn"),
          ...modelSegment(locale, verifier?.model, verifier?.unverified),
          ` · ${withdrawn.length}`,
        ),
        class: "lm-review-fold--group",
      },
    ) as HTMLDetailsElement;
    // A synthesis chip may cite a withdrawn concern — the cross-review never
    // saw it, but a panel stored with one can — so these rows are locatable.
    for (const [id, row] of built) located.set(id, { row, fold, key });
    panel.append(fold);
  }

  // A clean "everything is triaged" state once nothing is pending.
  if (allPending.length === 0 && archived.length > 0) {
    panel.append(
      el("div", { class: "lm-cite-empty" }, tr(locale, "rAllResolved")),
    );
  }

  // ADR 0075 §5: drawn whenever a synthesis EXISTS — empty included. Three
  // cases, three renderings: ran and found something → the notes; ran and
  // found nothing → this fold, its count 0, and a sentence saying so; did not
  // run or failed → no fold, and the `synthesis_missing` limit says why. Until
  // X6 the middle case was drawn like the last, so a cross-review that found
  // nothing was indistinguishable from one that never ran.
  if (state.synthesis !== undefined) {
    const s = state.synthesis;
    const jump = (id: string): void => {
      const found = located.get(id);
      if (found !== undefined) {
        land(found);
        return;
      }
      // V6 (ADR 0088 §4): a row the NARROWING hides is not a row that is not
      // there. Clear the narrowing and land on it in the render that follows,
      // rather than doing nothing silently. Anything else — an archived
      // concern, which no chip has ever landed on — is left as it was.
      const onNarrow = deps.onNarrow;
      if (
        narrowed !== undefined &&
        onNarrow !== undefined &&
        state.annotations.some(
          (a) => a.id === id && a.status === "pending" && !shows(a),
        )
      )
        onNarrow(undefined, id);
    };
    const jumpLabel = tr(locale, "rJumpToConcern");
    const notes: HTMLElement[] = [];
    for (const note of s.consensus) {
      // ADR 0075 §4: CONSENSUS only. Agreement between two reviewers on one
      // model is weaker evidence than agreement across models; two on one
      // model disagreeing claims no independence, so is never marked.
      const model = sharedModel(note, state.annotations, seats);
      notes.push(
        synthesisEntry(
          `${tr(locale, "rConsensus")}: ${note.note}`,
          note.ids,
          jump,
          jumpLabel,
          // The id in its own span, like a heading's: the marks wrapped as
          // `…均运行于 gpt-` / `5.6-luna` in a narrow 中文 sidebar.
          model === undefined
            ? undefined
            : line(
                ...withSlot(
                  tr(locale, "rSameModel"),
                  "{model}",
                  modelId(model),
                ),
              ),
        ),
      );
    }
    for (const note of s.disagreements)
      notes.push(
        synthesisEntry(
          `${tr(locale, "rDisagreements")}: ${note.note}`,
          note.ids,
          jump,
          jumpLabel,
        ),
      );
    // The heading names the model that wrote the cross-review, spelled
    // exactly as a seat's heading spells its own (ADR 0069 §8, extended).
    const cross = state.crossReview;
    const body =
      notes.length > 0
        ? notes
        : [
            el(
              "div",
              { class: "lm-cite-empty" },
              tr(locale, "rSynthesisEmpty"),
            ),
          ];
    panel.append(
      foldedGroup(
        tr(locale, "rSynthesis"),
        body,
        deps.groupOpen("synthesis", true),
        (open) => deps.onGroupToggle("synthesis", open),
        (n) => n,
        {
          summary: line(
            tr(locale, "rSynthesis"),
            ...modelSegment(locale, cross?.model, cross?.unverified),
            ` · ${notes.length}`,
          ),
          class: "lm-review-fold--group",
        },
      ),
    );
  }

  // ADR 0086: what a rule SET ASIDE, in a fold of its own and above the
  // limits — something the review did, not something it could not do. Closed:
  // a reader checks it by choice, and the fold's own summary carries the count
  // (the seat's heading says it only when nothing was kept). Counted in
  // concerns, as `lostBySeat` counts them.
  // V6: under a narrowing, only the rules that caught a concern in view, and
  // the count is of those concerns.
  const asides = grouped
    ? setAsideLimits(state.limits).filter(
        (l) =>
          narrowed === undefined || l.entries.some((e) => inView(e.dimension)),
      )
    : [];
  if (asides.length > 0) {
    const count = asides.reduce(
      (n, l) => n + l.entries.filter((e) => inView(e.dimension)).length,
      0,
    );
    panel.append(
      foldedGroup(
        tr(locale, "rSetAsideFold"),
        asides,
        deps.groupOpen("setAside", false),
        (open) => deps.onGroupToggle("setAside", open),
        (limit) => asideBlock(locale, limit, entry, pdfName, inView),
        {
          summary: `${tr(locale, "rSetAsideFold")} · ${count}`,
          class: "lm-review-fold--group",
        },
      ),
    );
  }

  // PANEL ONLY. The quick action has produced `anchors_dropped` limits since
  // R2 and has never rendered them, and D9 pins quick mode to what it renders
  // today. Whether it should show its own honesty record is a real question
  // and the operator's, not this milestone's — filed OPEN under R3. The state
  // carries the limits either way, so the answer is this condition.
  //
  // V4 (ADR 0081 §7): and a PDF review, whose record may hold nothing BUT a
  // limit — a run that could not see the page completes with the reason.
  // ADR 0075 §7: one row per failed literature SOURCE, as a view — the
  // record keeps one limit per (reviewer, source, status). The heading counts
  // the rows the reader sees, not the limits the record holds — and since ADR
  // 0085 §4 a record whose only limit is a page move draws no fold at all (nor,
  // since ADR 0086, one whose only limits are set-asides: they have the fold
  // above).
  const rows =
    grouped && state.limits !== undefined
      ? limitRows(state.limits, [
          ...reviewerSeats.map((s) => s.reviewer),
          ...(pdfName !== undefined ? [pdfName] : []),
        ])
      : [];
  if (rows.length > 0) {
    panel.append(
      foldedGroup(
        tr(locale, "rLimits"),
        rows,
        deps.groupOpen("limits", true),
        (open) => deps.onGroupToggle("limits", open),
        (item) => {
          const row = el(
            "div",
            { class: "lm-review-limit" },
            limitRowText(locale, item, pdfName),
          );
          // ADR 0075 §2: a failed cross-review has no heading of its own to
          // sit under, so its cause sits in its row. A `seat_missing` row
          // does NOT repeat its seat's — that is under the seat's heading.
          // V1 (ADR 0076): a failed verification likewise, for the same reason.
          if (
            item.kind === "limit" &&
            (item.limit.kind === "synthesis_missing" ||
              item.limit.kind === "verification_missing") &&
            item.limit.cause !== undefined
          )
            row.append(causeLine(locale, item.limit.cause));
          return row;
        },
        {
          summary: `${tr(locale, "rLimits")} · ${rows.length}`,
          class: "lm-review-fold--group",
        },
      ),
    );
  }

  // ADR 0062 §5: the archive, last and collapsed — it is what the reader is
  // finished with. V6: narrowed like every other list of concerns.
  const archivedShown = archived.filter(shows);
  if (archivedShown.length > 0) {
    panel.append(
      foldedGroup(
        tr(locale, "rArchived"),
        archivedShown,
        deps.groupOpen("archived", false),
        (open) => deps.onGroupToggle("archived", open),
        (a) => archivedRow(a, entry, deps, marked(a)),
        { class: "lm-review-fold--group" },
      ),
    );
  }

  // V6 (ADR 0088 §4): the concern a synthesis chip named while a narrowing
  // hid it — land on it now that it is drawn.
  const target =
    deps.target !== undefined ? located.get(deps.target) : undefined;
  if (target !== undefined) land(target);

  panel.append(
    el(
      "div",
      { class: "lm-cite-footer" },
      el("span", { class: "lm-cite-lock" }, "🔒"),
      el("span", {}, tr(locale, "rReadOnly")),
    ),
  );
  return panel;
}
