/**
 * The scorecard block (V6, ADR 0088 §3–§5; ADR 0037).
 *
 * It DRAWS the card the extension host derived (`deriveScorecard`, ADR 0087
 * §3–§5) and computes nothing about a level of its own: every level, count,
 * mark and delta below is read off the card, and every word over it is ours,
 * from `strings.ts`, over the engine's enum keys. Three things pass through as
 * authored: a reviewer id, a model id, and a declaring reviewer's own note
 * (third-party text, invariant 6's E1 boundary) — each set as text.
 *
 * Pure in ADR 0037's sense: state from the argument, strings from the table,
 * the host only through `onNarrow`. Nodes carry CLASSES only (ADR 0072 §1):
 * no `style` attribute, which the webview's CSP would drop; no image; no SVG,
 * since four steps need no namespace. Everything visual is `styles.css`'s.
 */
import type {
  Readiness,
  Scorecard,
  ScorecardDelta,
  ScorecardDimension,
  ScorecardStanding,
  SessionLocale,
} from "@lemmaria/harness";
import { el } from "./rows.js";
import { type StringKey, tr, versionLabel } from "./strings.js";

/**
 * A dimension's label in the reader's language — for the panel's eight and
 * the quick action's own (`clarity` is in both).
 *
 * An unknown dimension renders its RAW string. A dimension can only come from
 * an action definition, and a user's own action may name anything; inventing a
 * translation for a word we have never seen would be worse than showing the
 * word (invariant 6 rule 2's boundary — third-party text is not ours to
 * render in the reader's language).
 *
 * Here rather than in `review-tab.ts` since V6, which re-exports it: the rows
 * below label every dimension too, and the tab imports this module, so the
 * one table lives where both can reach it without a cycle.
 */
const DIMENSION_KEY: Record<string, StringKey> = {
  soundness: "rDimSoundness",
  claims: "rDimClaims",
  clarity: "rDimClarity",
  positioning: "rDimPositioning",
  // V2 (ADR 0078 6): the panel's two new dimensions. An unknown dimension
  // still passes through as its own word -- the map labels, it never gates.
  originality: "rDimOriginality",
  significance: "rDimSignificance",
  rigor: "rDimRigor",
  structure: "rDimStructure",
  language: "rDimLanguage",
  // V4 (ADR 0081 §1): the eighth panel dimension, the PDF reviewer's own.
  presentation: "rDimPresentation",
};

export function dimensionLabel(
  locale: SessionLocale,
  dimension: string,
): string {
  const key = DIMENSION_KEY[dimension];
  return key === undefined ? dimension : tr(locale, key);
}

/** What the block draws: the card, what it is compared against, and — from
 *  the tab, which owns the concern list — the narrowing's state (D9). */
export interface ScorecardView {
  card: Scorecard;
  /** The version compared against (ADR 0088 §2); absent on a first reading.
   *  `unmeasured` when no seat contributed to that version's card. */
  previous?: { version: number; comparable: boolean; unmeasured?: true };
  /** Present exactly when `previous` is. */
  delta?: ScorecardDelta;
  /** The review's PDF seat's record name, when it has one — its short label
   *  is `PDF` rather than the id. */
  pdfReviewer?: string;
  /** The dimension the concern list is narrowed to: its row is pressed. */
  narrowed?: string;
  /** The banner's numbers, over the concerns the tab counts (D9). */
  narrow?: { dimension: string; shown: number; total: number };
  /** The review has no seat row at all — no reviewer and no PDF seat ran —
   *  so a card with no contributor says that, rather than blaming a ledger
   *  nobody produced. The record cannot say WHY none ran. */
  noSeat?: true;
}

export interface ScorecardDeps {
  /** Narrow the concern list to a dimension, or clear it (`undefined`).
   *  Absent, the rows are drawn as text: a control with nothing behind it is
   *  one that cannot be operated (the `runPdf` rule). */
  onNarrow?: (dimension: string | undefined) => void;
}

const SEP = " · ";

/** Set a keyed sentence's slots. A replacer function, so a `$&` in a value
 *  stays text. */
function fill(
  sentence: string,
  slots: Record<string, string | number>,
): string {
  let out = sentence;
  for (const [name, value] of Object.entries(slots))
    out = out.replace(`{${name}}`, () => String(value));
  return out;
}

const READINESS_KEY: Record<Readiness, StringKey> = {
  blocking: "scReadinessBlocking",
  major: "scReadinessMajor",
  minor: "scReadinessMinor",
  none: "scReadinessNone",
  not_assessed: "scReadinessNotAssessed",
};

/** The readiness label's word. A `Record`, so a label the contract adds is a
 *  compile error here rather than a line that says nothing. */
export function readinessKey(label: Readiness): StringKey {
  return READINESS_KEY[label];
}

const LEVEL_KEY: Record<1 | 2 | 3 | 4, StringKey> = {
  1: "scLevel1",
  2: "scLevel2",
  3: "scLevel3",
  4: "scLevel4",
};

type NotAssessedReason = Extract<
  ScorecardStanding,
  { kind: "not_assessed" }
>["reason"]["kind"];

const REASON_KEY: Record<NotAssessedReason, StringKey> = {
  declared: "scReasonDeclared",
  no_literature: "scReasonNoLiterature",
  literature_budget: "scReasonLiteratureBudget",
  no_pdf: "scReasonNoPdf",
  no_reviewer: "scReasonNoReviewer",
};

/**
 * A seat's short label: an ordinal reviewer's letter (`reviewer_b` → `B`), the
 * PDF seat's format name, or — for any other id (a review stored before R9, a
 * bare result) — the id itself, since inventing a letter for it would name a
 * reviewer the record does not.
 */
export function seatLetter(reviewer: string, pdfReviewer?: string): string {
  if (pdfReviewer !== undefined && reviewer === pdfReviewer) return "PDF";
  const ordinal = /^reviewer_([a-z]+)$/.exec(reviewer);
  return ordinal === null ? reviewer : (ordinal[1] as string).toUpperCase();
}

/** A median: whole as an integer, otherwise to one decimal — the median of an
 *  even count of whole impressions can be `x.5`. */
export function formatMedian(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The level cell's words: a level's number and word, *nothing raised*, or
 *  *not assessed*. The *not checked* mark is drawn beside it, not in it. */
export function standingWords(
  locale: SessionLocale,
  standing: ScorecardStanding,
): string {
  if (standing.kind === "level")
    return fill(tr(locale, "scLevelWord"), {
      level: standing.level,
      word: tr(locale, LEVEL_KEY[standing.level]),
    });
  return tr(
    locale,
    standing.kind === "nothing_raised" ? "scNothingRaised" : "scNotAssessed",
  );
}

/**
 * The non-zero distinct-issue counts and strengths, in a fixed order. `info`
 * is never printed: it moves no level (ADR 0087 §3), and its cards are one
 * click away.
 *
 * The counts are DISJOINT, though the card's are not: the contract's
 * `blocking` is a subset of its `major`, so the line prints `major` as the
 * majors that do not block. Printed side by side as the card has them,
 * `blocking 8 · major 8` read as sixteen issues where there were eight (V6's
 * E1/J2 round). The issue counts carry their unit, because the banner and the
 * seat headings count concerns and a group of overlapping concerns is one
 * issue — without it one dimension read in three units.
 */
export function countsText(
  locale: SessionLocale,
  row: ScorecardDimension,
): string {
  const issues: string[] = [];
  const count = (key: StringKey, n: number): void => {
    if (n > 0) issues.push(fill(tr(locale, key), { n }));
  };
  count("scCountBlocking", row.issues.blocking);
  count("scCountMajor", row.issues.major - row.issues.blocking);
  count("scCountMinor", row.issues.minor);
  const parts =
    issues.length > 0
      ? [fill(tr(locale, "scCountIssues"), { list: issues.join(SEP) })]
      : [];
  if (row.strengths > 0)
    parts.push(fill(tr(locale, "scCountStrengths"), { n: row.strengths }));
  return parts.join(SEP);
}

/**
 * The faint second reading: the median, every seat's own value, and the word
 * that says what it is not. Every seat that ASSESSES the row is listed, a
 * dash where it gave none. It drives nothing — no class, no order, no delta.
 */
export function impressionText(
  locale: SessionLocale,
  row: ScorecardDimension,
  pdfReviewer?: string,
): string {
  const lead = impressionLead(locale, row, pdfReviewer);
  return lead === undefined
    ? tr(locale, "scNoImpression")
    : [...lead, tr(locale, "scUncalibrated")].join(SEP);
}

/** The median and each assessing seat's value — everything the line says
 *  before *uncalibrated* — or `undefined` when no seat gave one. */
function impressionLead(
  locale: SessionLocale,
  row: ScorecardDimension,
  pdfReviewer?: string,
): string[] | undefined {
  if (row.impression === null) return undefined;
  return [
    fill(tr(locale, "scImpression"), { n: formatMedian(row.impression) }),
    ...row.seats
      .filter((s) => s.standing !== undefined)
      .map(
        (s) =>
          `${seatLetter(s.reviewer, pdfReviewer)} ${
            s.impression === null ? "–" : formatMedian(s.impression)
          }`,
      ),
  ];
}

type DeltaEntry = ScorecardDelta["dimensions"][number];

const CHANGE: Record<
  "improved" | "worsened" | "unchanged",
  { glyph: string; cls: string; key: StringKey }
> = {
  improved: { glyph: "▲", cls: "lm-sc-delta--up", key: "scDeltaImproved" },
  worsened: { glyph: "▼", cls: "lm-sc-delta--down", key: "scDeltaWorsened" },
  unchanged: { glyph: "=", cls: "lm-sc-delta--same", key: "scDeltaUnchanged" },
};

/**
 * One row's delta cell, under a pair the engine called comparable (D8): a
 * glyph the eye reads with a word a screen reader does; *new* where the
 * compared version had no standing here (`not_assessed`) or no PDF seat on
 * this model (`pdf`) and this one has; nothing where this row is itself not
 * assessed, and nothing for a pair-level reason, which the compare line says.
 */
export function deltaCell(
  locale: SessionLocale,
  entry: DeltaEntry,
  rowAssessed: boolean,
): HTMLElement | undefined {
  if (entry.comparable) {
    const c = CHANGE[entry.change];
    return el(
      "span",
      {
        class: `lm-sc-row__delta ${c.cls}`,
        // A label on a bare span is not announced; as an image, its word
        // replaces the glyph a screen reader would otherwise spell out.
        role: "img",
        "aria-label": tr(locale, c.key),
      },
      c.glyph,
    );
  }
  if (!rowAssessed) return undefined;
  if (entry.reason === "pdf" || entry.reason === "not_assessed")
    return el(
      "span",
      { class: "lm-sc-row__delta lm-sc-delta--new" },
      tr(locale, "scDeltaNew"),
    );
  return undefined;
}

/** The four steps: filled to the level, empty, or hatched — never filled for
 *  *not assessed*, which is not a level (stage-gate claim 5). */
function track(standing: ScorecardStanding): HTMLElement {
  const kind =
    standing.kind === "level"
      ? `l${standing.level}`
      : standing.kind === "nothing_raised"
        ? "none"
        : "na";
  const node = el("span", { class: `lm-sc-track lm-sc-track--${kind}` });
  for (let i = 1; i <= 4; i++) {
    const step =
      standing.kind === "not_assessed"
        ? "na"
        : standing.kind === "level" && i <= standing.level
          ? "on"
          : "off";
    node.append(el("span", { class: `lm-sc-step lm-sc-step--${step}` }));
  }
  return node;
}

/** Why a row is not assessed — and, for a declared one, each seat's note as
 *  its author wrote it, as text. */
function reasonLine(
  locale: SessionLocale,
  standing: Extract<ScorecardStanding, { kind: "not_assessed" }>,
  pdfReviewer?: string,
): HTMLElement {
  const line = el("span", { class: "lm-sc-row__reason" });
  const reason = standing.reason;
  if (reason.kind !== "declared") {
    line.append(tr(locale, REASON_KEY[reason.kind]));
    return line;
  }
  const letter = (r: string): string => seatLetter(r, pdfReviewer);
  line.append(
    fill(tr(locale, "scReasonDeclared"), {
      who: reason.by
        .map((b) => letter(b.reviewer))
        .join(tr(locale, "rListSep")),
    }),
  );
  for (const b of reason.by)
    line.append(
      el(
        "span",
        { class: "lm-sc-row__note" },
        `${letter(b.reviewer)}${SEP}${b.note}`,
      ),
    );
  return line;
}

/** One dimension's row: a toggle button whose content is spans only
 *  (phrasing content), laid out by the stylesheet as three lines — or, with
 *  no `onNarrow` to call, the same spans in a `div` that claims no control. */
function scorecardRow(
  view: ScorecardView,
  locale: SessionLocale,
  deps: ScorecardDeps,
  row: ScorecardDimension,
): HTMLElement {
  const pressed = view.narrowed?.toLowerCase() === row.dimension;
  const { onNarrow } = deps;
  const button =
    onNarrow === undefined
      ? el("div", { class: "lm-sc-row", "data-dimension": row.dimension })
      : el("button", {
          class: "lm-sc-row",
          type: "button",
          "aria-pressed": pressed ? "true" : "false",
          "data-dimension": row.dimension,
        });
  if (onNarrow !== undefined)
    button.addEventListener("click", () =>
      onNarrow(pressed ? undefined : row.dimension),
    );
  const { standing } = row;
  const level = el(
    "span",
    { class: "lm-sc-row__level" },
    standingWords(locale, standing),
  );
  // The delta is part of the level it qualifies, so it sits in the level's
  // own cell, bound to the last word by a no-break space: as an item of the
  // row's flow it was pushed to the far edge, a column of its own at a real
  // width and a lone glyph on its own line at ~280 px (V6's E1 round).
  const entry = view.delta?.dimensions.find(
    (d) => d.dimension === row.dimension,
  );
  if (view.previous?.comparable === true && entry !== undefined) {
    const cell = deltaCell(locale, entry, standing.kind !== "not_assessed");
    if (cell !== undefined) level.append(" ", cell);
  }
  // By exception, in the id line's own words (ADR 0076 §9): one mark per row,
  // the panel's; a seat's own `checked` is not drawn.
  if (standing.kind === "level" && !standing.checked)
    level.append(
      SEP,
      el("span", { class: "lm-sc-mark" }, tr(locale, "rConcernUnchecked")),
    );
  button.append(
    el(
      "span",
      { class: "lm-sc-row__dim" },
      dimensionLabel(locale, row.dimension),
    ),
    track(standing),
    level,
  );
  if (standing.kind === "not_assessed") {
    button.append(reasonLine(locale, standing, view.pdfReviewer));
  } else {
    const counts = countsText(locale, row);
    if (counts !== "")
      button.append(el("span", { class: "lm-sc-row__counts" }, counts));
  }
  // The spread: each seat that assesses this row, its level or a dash.
  const seats = row.seats.filter((s) => s.standing !== undefined);
  if (seats.length > 0) {
    const column = el("span", { class: "lm-sc-row__seats" });
    seats.forEach((s, i) => {
      if (i > 0) column.append(SEP);
      column.append(
        el(
          "span",
          { class: "lm-sc-seat" },
          `${seatLetter(s.reviewer, view.pdfReviewer)} ${
            s.standing?.kind === "level" ? s.standing.level : "–"
          }`,
        ),
      );
    });
    button.append(column);
  }
  if (standing.kind !== "not_assessed") {
    const impression = el("span", { class: "lm-sc-row__impression" });
    const lead = impressionLead(locale, row, view.pdfReviewer);
    if (lead === undefined) impression.append(tr(locale, "scNoImpression"));
    else
      impression.append(
        lead.join(SEP) + SEP,
        el("span", { class: "lm-sc-uncal" }, tr(locale, "scUncalibrated")),
      );
    button.append(impression);
  }
  return button;
}

/** Who reviewed, on what — once, above the rows (design §7's *every
 *  reviewer's value with its model in view*). A model the record does not
 *  know is omitted, as the panel line omits one (ADR 0075 §3). */
function legend(card: Scorecard, pdfReviewer?: string): HTMLElement {
  const node = el("div", { class: "lm-sc-legend" });
  const entries: Array<{ label: string; model: string }> = [
    ...card.panel.reviewers.map((r) => ({
      label: seatLetter(r.reviewer, pdfReviewer),
      model: r.model,
    })),
    ...(card.panel.pdf !== undefined
      ? [{ label: "PDF", model: card.panel.pdf.model }]
      : []),
  ];
  entries.forEach(({ label, model }, i) => {
    if (i > 0) node.append(SEP);
    const entry = el("span", { class: "lm-sc-legend__seat" }, label);
    if (model !== "")
      entry.append(" ", el("span", { class: "lm-review-model" }, model));
    node.append(entry);
  });
  return node;
}

/**
 * Whether any seat contributed to the card — a text reviewer or the PDF
 * reader. One with none is drawn as a sentence with no row to press, so the
 * tab applies no narrowing over it (ADR 0088 §4).
 */
export function hasContributor(card: Scorecard): boolean {
  return card.panel.reviewers.length > 0 || card.panel.pdf !== undefined;
}

/** Which version the arrows are against, or why there are none (D8). */
function compareLine(view: ScorecardView, locale: SessionLocale): HTMLElement {
  const { previous } = view;
  let words: string;
  if (previous === undefined) {
    words = tr(locale, "scFirstReading");
  } else {
    const version = versionLabel(locale, previous.version);
    // The pair's two reasons: other reviewers is *a different panel*; the
    // same reviewers with the dial moved is said as that, not as the panel.
    // A version that measured nothing is neither, and says so (ADR 0088 §2).
    const byDial =
      !previous.comparable &&
      !(view.delta?.dimensions ?? []).some(
        (d) => !d.comparable && d.reason === "reviewers",
      ) &&
      (view.delta?.dimensions ?? []).some(
        (d) => !d.comparable && d.reason === "verification",
      );
    const key: StringKey = previous.comparable
      ? "scComparedWith"
      : previous.unmeasured === true
        ? "scNotComparableUnmeasured"
        : byDial
          ? "scNotComparableVerification"
          : "scNotComparable";
    words = fill(tr(locale, key), { version });
  }
  return el("div", { class: "lm-sc-compare" }, words);
}

/**
 * The whole block: readiness, legend, compare line, eight rows, the
 * narrowing's banner when narrowed, and the caveat — always last and always
 * visible. A card with no contributor is drawn as one sentence and the
 * caveat: eight rows of *no reviewer* would be one fact said eight times.
 */
export function renderScorecard(
  view: ScorecardView,
  locale: SessionLocale,
  deps: ScorecardDeps,
): HTMLElement {
  const { card } = view;
  const block = el("section", {
    class: "lm-scorecard",
    "aria-label": tr(locale, "scTitle"),
  });
  const caveat = el("div", { class: "lm-sc-caveat" }, tr(locale, "scCaveat"));
  if (!hasContributor(card)) {
    block.append(
      el(
        "div",
        { class: "lm-sc-unmeasured" },
        tr(locale, view.noSeat === true ? "scNoReviewerRan" : "scUnmeasured"),
      ),
      caveat,
    );
    return block;
  }
  // No string is written over `readiness.checked` (ADR 0088 §3): its meaning
  // is the operator's open question, and the rows carry the marks a reader
  // can check.
  const readiness = el(
    "div",
    { class: "lm-sc-readiness" },
    el(
      "span",
      { class: "lm-sc-readiness__word" },
      tr(locale, readinessKey(card.readiness.label)),
    ),
  );
  if (card.notAssessed > 0)
    readiness.append(
      SEP,
      el(
        "span",
        { class: "lm-sc-readiness__na" },
        fill(tr(locale, "scNotAssessedCount"), { n: card.notAssessed }),
      ),
    );
  const rows = el("div", { class: "lm-sc-rows" });
  for (const row of card.dimensions)
    rows.append(scorecardRow(view, locale, deps, row));
  block.append(
    readiness,
    legend(card, view.pdfReviewer),
    compareLine(view, locale),
    rows,
  );
  if (view.narrow !== undefined) {
    const banner = el(
      "div",
      { class: "lm-sc-narrow" },
      fill(tr(locale, "scNarrowed"), {
        dimension: dimensionLabel(locale, view.narrow.dimension),
        shown: view.narrow.shown,
        total: view.narrow.total,
      }),
    );
    const { onNarrow } = deps;
    if (onNarrow !== undefined) {
      const all = el(
        "button",
        { class: "lm-sc-narrow__all", type: "button" },
        tr(locale, "scShowAll"),
      );
      all.addEventListener("click", () => onNarrow(undefined));
      banner.append(" ", all);
    }
    block.append(banner);
  }
  block.append(caveat);
  return block;
}
