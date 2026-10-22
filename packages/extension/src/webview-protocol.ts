/**
 * The single source of truth for host <-> webview messages (ADR 0011).
 * Imported by BOTH the extension host (`webview-view.ts`) and the webview
 * bundle (`webview/main.ts`). Must stay `vscode`-free and DOM-free — it is
 * pure types + a tiny interface, so both tsconfigs can compile it.
 *
 * U0 defined the round-trip proof messages (echo/echoed — retained as the live
 * pipeline test). U1 adds runQuickAction/composerEdit (W→H) and init/selection
 * (H→W). U2-U6 extend these unions further. A0 supersedes composerEdit with
 * composerSend — the composer is the session entry point (ADR 0014) — and adds
 * sessionEvent (H→W), the typed session stream the transcript renders.
 */

import type {
  NoticeItem,
  ReviewItem,
  ReviewLimit,
  ReviewPdfRecord,
  ReviewSynthesis,
  Scorecard,
  ScorecardDelta,
  SessionEvent,
  SessionItem,
  VerificationKind,
  VerificationOutcome,
} from "@lemmaria/harness";

/** Which document kind the active editor holds (drives selection-awareness). */
export type DocKind = "tex" | "md";

/**
 * The live editor selection, computed by the host and pushed to the webview.
 * `file` is the basename (or "" when none); `startLine`/`endLine` are 1-based
 * editor lines (or 0 when there is no selection).
 */
export interface SelectionState {
  docKind: DocKind | null;
  hasSelection: boolean;
  file: string;
  startLine: number;
  endLine: number;
}

/** One wired quick action, resolved from its action definition by the host. */
export interface QuickActionInfo {
  id: string;
  label: string;
  tier: "L0" | "L1";
}

/** The Writing-role model display — the ModelStore's ACTIVE model, which is the
 *  one `getModel` binds and therefore the one a turn will run on. It was read
 *  from `lemmaria.model.*` until the R3 gate-review round found that setting
 *  outliving the store (ADR 0064 §4); U3's Models tab manages the store. */
export interface ModelInfo {
  name: string;
  configured: boolean;
}

/** Budget ceilings for display (read from `lemmaria.budget.*`). */
export interface BudgetInfo {
  maxTokens: number;
  maxIterations: number;
}

/** One offline (C1) consistency issue rendered in the Citations tab. */
export interface CitationIssue {
  /** Warning.code, e.g. "undefined-citation" | "orphan-citation" | "duplicate-key" | "duplicate-entry". */
  code: string;
  severity: "error" | "warning" | "info";
  /** Backend warning message (already bilingual) — shown as the row detail. */
  message: string;
  /** Workspace-relative file the issue points at (jump-to-source). */
  file: string;
  /** 1-based line, or 0 when the issue carries no line. */
  line: number;
}

/** C2 online status vocabulary (mirrors the harness CitationStatus). */
export type CitationKeyStatus =
  | "ok"
  | "metadata_mismatch"
  | "preprint_superseded"
  | "not_found"
  | "unverified";

/** One per-key online (C2) result rendered in the Citations tab. */
export interface CitationKeyResult {
  key: string;
  status: CitationKeyStatus;
  /** Which source answered (or the fallback), e.g. "crossref". */
  source: string;
  /** Host-built, locale-resolved detail line (e.g. "year: 2019 → 2021"). */
  detail: string;
  /** True when the result carries an adoptable BibDiff correction. */
  hasCorrection: boolean;
}

/** The offline (C1) + header state pushed when the Citations tab opens. */
export interface CitationsC1State {
  /** False when the active editor is not a loadable .tex/.md paper. */
  available: boolean;
  /** Basenames of the discovered .bib files. */
  bibFiles: string[];
  entryCount: number;
  citedKeyCount: number;
  /** Bib entry keys — the C2-checkable set, for the idle ONLINE rows. */
  entryKeys: string[];
  /** C2 source endpoints, for the privacy footer (shown before a run too). */
  endpoints: string[];
  issues: CitationIssue[];
}

/** The online (C2) results pushed after a Run check. */
export interface CitationsC2State {
  status: "checked" | "skipped";
  message?: string;
  results: CitationKeyResult[];
  endpoints: string[];
}

/** One per-model session usage row in the Models tab (U3). */
export interface UsageRowInfo {
  /** The bound model id at run time ("—" when a run carried no model tag). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** One persisted cost bucket rendered as a summary line (today / total). */
export interface CostSummaryInfo {
  inputTokens: number;
  outputTokens: number;
  /** Accrued USD for priced runs; 0 when nothing was priced. */
  usd: number;
  /** Runs whose model had no known pricing (tokens counted, no fabricated $). */
  unpricedRuns: number;
}

/** One configured model row rendered in the Models tab (revised U3). */
export interface ConfiguredModelInfo {
  id: string;
  provider: string; // preset id
  providerLabel: string;
  protocol: "anthropic" | "openai-compatible";
  endpoint: string;
  model: string;
  label: string; // friendly name; = model when unset
  keyPresent: boolean; // never the key itself
  active: boolean;
  /**
   * The user's image-input override (V3, ADR 0080 §6), or absent for *auto*.
   */
  imageInput?: boolean;
  /**
   * What the harness's prefix table says about `model` — computed HOST-side,
   * because the webview may import nothing from the harness but the declared
   * leaf subpaths, and the table is not one of them. It is what the *auto*
   * option renders as: *auto (yes)* or *auto (no)*.
   */
  imageInputDefault: boolean;
}

/** A provider preset relayed to the webview for the add-model form. */
export interface ProviderInfo {
  id: string;
  label: string;
  protocol: "anthropic" | "openai-compatible";
  defaultEndpoint: string;
  keyRequired: boolean;
  suggestedModels: string[];
}

/**
 * V1 (ADR 0076 §8): the verifier's *Off*. Here because it crosses the wire —
 * the card offers it and the store keeps it — and this file is the one home
 * for what does (ADR 0011). Model ids are UUIDs, so it cannot be one.
 */
export const VERIFIER_OFF = "off";

/**
 * V4 (ADR 0081 §8): the PDF reviewer's *Off* — the same literal, shared rather
 * than spelled twice, so the two roles that may be off cannot disagree on how.
 */
export const PDF_REVIEWER_OFF = VERIFIER_OFF;

/**
 * Who reviews, and on what (R9, ADR 0069 §D8).
 *
 * Each entry is a `ConfiguredModelInfo.id`, or `""` meaning *same as Writing*.
 * The count IS `reviewers.length` — the card adds and removes rows, and there
 * is no separate number to disagree with the list.
 */
export interface ReviewRolesInfo {
  reviewers: string[];
  synthesis: string;
  /**
   * V1 (ADR 0076 §8): who checks the concerns. `""` means *same as
   * Cross-review* (the default), `"off"` means no verifier runs, anything
   * else is a `ConfiguredModelInfo.id`. The one role that may default to
   * another role, and the one that may be off.
   */
  verifier: string;
  /**
   * V4 (ADR 0081 §8): who reads the compiled PDF. `""` means *same as
   * Writing* (the default), `"off"` means no PDF work of any kind, anything
   * else is a `ConfiguredModelInfo.id`. Its model must take images; the card
   * says so when it cannot.
   */
  pdfReviewer: string;
}

/**
 * The Models tab state (revised U3): the user's configured model list, the
 * provider presets for the add-model form, the active model id, the review
 * roles (R9), per-model session usage, and the persisted today/total buckets.
 * Keys never cross — each ConfiguredModelInfo carries only `keyPresent`.
 */
export interface ModelsState {
  models: ConfiguredModelInfo[];
  providers: ProviderInfo[];
  activeModelId?: string;
  reviewRoles: ReviewRolesInfo;
  /** The harness's fan-out ceiling (`MAX_FAN_OUT`), relayed so the Reviewers
   *  card can stop its Add button where the panel actually stops. The webview
   *  takes only pure leaf subpaths of the harness (ADR 0011), so it cannot
   *  import the constant, and a second copy of the number is a second thing to
   *  keep true. */
  maxReviewers: number;
  session: UsageRowInfo[];
  today: CostSummaryInfo & { date: string };
  total: CostSummaryInfo;
}

/** A venue manifest's page limit, relayed for the chip + checklist (U4). */
export interface VenuePageLimitInfo {
  value: number;
  unit: string;
  note?: string;
}

/** The resolved library venue rendered as the CURRENT VENUE card (U4). */
export interface VenueInfo {
  id: string;
  /** Locale-resolved manifest name. */
  label: string;
  engine: string;
  bibstyle?: string;
  anonymity?: "double_blind" | "single_blind" | "none";
  pageLimit?: VenuePageLimitInfo;
}

/**
 * One pre-submission checklist row (U4). `unknown` is the honest "cannot
 * check automatically today" state; the webview owns the bilingual wording.
 */
export interface VenueChecklistRowInfo {
  id: "anonymity" | "page_limit" | "bibstyle" | "citations";
  status: "pass" | "fail" | "unknown";
  /** Required anonymity / declared bibstyle / the "9 pages" limit. */
  expected?: string;
  /** Detected bibstyle / measured pages (as a string). */
  actual?: string;
  /** Unresolved citation count. */
  count?: number;
}

/**
 * A finding's triage state (U5 round 3 — operator feedback). `pending` until
 * the user adopts it (Accept the diff → `accepted`, shown green in a folded
 * "Accepted" sub-list) or ignores it (→ `ignored`, folded "Ignored" sub-list).
 */
/** ADR 0062 §5 added `resolved` — *the reader has dealt with this* — and
 *  **ADR 0063 §3 replaces it with `handed`**, which is a different claim and a
 *  true one. Resolve no longer files a concern away; it hands the concern to
 *  the assistant with a prompt and sends it, so what the archive can honestly
 *  say at the moment of the click is *given to the assistant to work through*,
 *  never *done*. Whether it was done is in the transcript, and later in the
 *  manuscript — not in a status the click could only have guessed at.
 *
 *  `resolved` is GONE rather than kept beside it: nothing writes it any more,
 *  and an unreleased build owes its old vocabulary nothing (the bundle's
 *  *no backward-compatibility burden* rule). */
export type ReviewAnnotationStatus =
  | "pending"
  | "accepted"
  | "ignored"
  | "handed";

/** One review annotation rendered in the Review tab (U5 round 2, widened by
 *  R3 / ADR 0061 for the panel — every added field is present in quick mode
 *  too, because the harness stamps them on every annotation). */
export interface ReviewAnnotationInfo {
  /** Position in the review's annotation list — the reveal/adopt handle.
   *  `index` stays THE handle across the protocol; `id` is display and the
   *  synthesis's reference (ADR 0061 §10). */
  index: number;
  /** Harness-stamped `"<reviewer>-<n>"` — what the synthesis's chips cite. */
  id: string;
  dimension: string;
  severity: "info" | "minor" | "major";
  message: string;
  reviewer: string;
  /** Workspace-relative path of the annotated file. A panel annotates many
   *  files; the tab shows this only when it is not the entry. */
  file: string;
  /** 1-based line in the annotated file. */
  line: number;
  hasSuggestion: boolean;
  /** The suggested replacement text (present iff hasSuggestion). */
  suggestion?: string;
  /** Triage state — drives the pending list vs. the folded sub-lists (round 3). */
  status: ReviewAnnotationStatus;
  /** The manuscript's central case fails without this (ADR 0060 D3). Absent,
   *  never `false` — the contract's own absent-stays-absent rule. */
  blocking?: true;
  /** Where the support sits: a located line, or `missing` — the reviewer
   *  looked and the manuscript offers none. The harness never manufactures
   *  `missing`, so the tab may render it as a finding.
   *
   *  X6 (ADR 0075 §6): the located line carries its workspace-relative FILE.
   *  Since X5 most evidence is cross-file, and a bare line number printed
   *  under the entry named a line of the wrong document. The tab shows the
   *  file by the same rule as the claim's: only when it is not the entry.
   *
   *  V2 (ADR 0078, D12): **tagged**, mirroring the harness contract's own
   *  discriminant — but this is NOT that contract and is never persisted, so
   *  it carries only what the tab draws.
   *
   *  A `paper` carries no file and no line: it is a position in the
   *  literature, not in the manuscript. `href` is present only when the host
   *  could build an http(s) one — the tab never decides that for itself,
   *  because the URL is third-party data and the host is where it is judged.
   *  The authors, venue and DOI stay behind: the row draws a title, a year
   *  and a link. */
  evidence?:
    | { kind: "span"; file: string; line: number }
    | { kind: "missing" }
    | { kind: "paper"; title: string; year?: string; href?: string }
    // V4 (ADR 0081 §4): a page of the compiled PDF the PDF reviewer viewed.
    | { kind: "page"; page: number };
  /**
   * V1 (ADR 0076 §7): what the verifier made of this concern, when one ran.
   * The counter is where the manuscript answers a WITHDRAWN concern — a file
   * and a line, the evidence's shape. `central` is not shipped: it gates
   * `blocking` above and is not a thing the tab shows.
   */
  verification?: {
    outcome: VerificationOutcome;
    kind: VerificationKind;
    counter?: { file: string; line: number };
    note?: string;
  };
}

/** One seat of a panel, for the tab's per-seat grouping (R3). `count` is that
 *  seat's located concerns; `missing` says the seat produced no usable report
 *  and why — the two are mutually exclusive in practice, and a seat with
 *  neither found nothing to report, which is a valid outcome (no quota). */
export interface ReviewSeatInfo {
  reviewer: string;
  count: number;
  /**
   * R9 (ADR 0069 §D4): the model id this reviewer ran on. Optional HERE, and
   * required on the harness's `ReviewSeatState`, because a review restored
   * from a store written before R9 carries none — the header then omits the
   * segment rather than rendering an empty one.
   */
  model?: string;
  /** R9: the model is outside Lemmaria's verified floor (ADR 0023). Rendered
   *  as a suffix BY EXCEPTION; never a prediction of failure. */
  unverified?: true;
  missing?: Extract<ReviewLimit, { kind: "seat_missing" }>;
}

/**
 * X6 (ADR 0075 §5): the cross-review's own row, as much of it as the tab
 * renders — the model that read across the panel, by the same exceptions a
 * seat's heading uses. Its tally and cost stay on the record (X6 D12.2–3).
 *
 * Present iff the stored review carries a cross-review row (X5, ADR 0074 §8);
 * a panel stored before X5 has none and the heading simply says less. An
 * EMPTY object is a real value: the row exists and its model replayed as `""`.
 */
export interface ReviewCrossReviewInfo {
  model?: string;
  unverified?: true;
}

/**
 * One review this window holds, for the tab's picker (ADR 0062 §1).
 *
 * Structured rather than pre-labelled: the label is a locale decision and the
 * webview owns those (invariant 6 rule 2), so the host ships the facts and
 * `review-tab.ts` writes the row.
 */
export interface ReviewHistoryEntry {
  /** The handle `selectReview` addresses — position in the window's list. */
  id: number;
  mode: "quick" | "panel" | "pdf";
  /** A panel's version number; absent for a quick review, which reviews one
   *  unit of one file and is not a reading of the manuscript. */
  version?: number;
  /** When the review was produced, epoch milliseconds. */
  at: number;
  /** Basename of what was reviewed — how a quick review is named in the list. */
  file: string;
  /** Located concerns, so the row says how much is in there. */
  concerns: number;
}

/**
 * ADR 0065 §3: a panel in flight, drawn at the top of the Review tab.
 *
 * The transcript card used to be the whole account of a running `/review` —
 * which seats were reading, which had reported, whether the synthesis had been
 * produced. The panel is not in the transcript any more (§2), so that account
 * moves to the surface the review belongs to, and this is what carries it.
 *
 * Deliberately NOT part of `ReviewTabState`: that state describes a review that
 * HAS run and is rebuilt from the reviews the host holds, while this describes
 * one that is running and is rebuilt from the driver's events. Folding them
 * together would mean every seat-chip frame re-sent the whole findings list.
 */
export interface ReviewRunInfo {
  /** True while the panel is in flight; false on a run that ended with
   *  nothing to show, whose row stays until the next one starts. */
  running: boolean;
  /** The panel item as it progresses. Absent between the click and the
   *  driver's first emit — a real gap, since the driver reads the whole
   *  manuscript before it starts a seat. */
  item?: ReviewItem;
  /** Notices the run emitted (a refused precondition, a starved seat), as
   *  ITEMS: the webview localizes a notice by its `code` (`noticeText`), and a
   *  second rendering of the same code is a second place to get it wrong. */
  notices: NoticeItem[];
}

/**
 * The Review tab state (U5 round 2 — operator feedback: Review lives as a TAB
 * next to Assistant/Citations/Models/Venue, not as a separate view).
 */
export interface ReviewTabState {
  /** False until a review has run in this window. */
  available: boolean;
  /** Which review produced this state (R3): the single-model quick action, or
   *  `/review`'s blind panel. Quick mode carries no seats and no synthesis. */
  mode: "quick" | "panel" | "pdf";
  /** The reviewed file, for the HEADER: a basename in quick mode (one unit of
   *  one file), the workspace-relative entry path in panel mode ("" when
   *  unavailable). Never compare an annotation's `file` against this — it is a
   *  display string; compare against `entry`. */
  file: string;
  /** The workspace-relative entry path, in BOTH modes ("" when unavailable).
   *  A row shows its own `file:` only when it differs from this, so a quick
   *  review of `sections/intro.tex` still renders `L12` and not the redundant
   *  `sections/intro.tex:12` its basename header would contradict. */
  entry: string;
  /** ADR 0064 §1: the entry the NEXT panel will read — `reviewPaperEntry()`'s
   *  answer right now, NOT the shown review's `entry`.
   *
   *  Deliberately a second field. `entry` is a fact about the review on screen
   *  and every row's `file:` suppression compares against it; this is a fact
   *  about the PROJECT, and it is what the launcher's *main file* names and
   *  what Change rewrites. They agree until the reader changes the entry, and
   *  the moment they disagree is exactly the moment collapsing them would lie
   *  about which document the review on screen actually read.
   *
   *  Present in BOTH `available` states — the launcher renders before any
   *  review has run, which is the whole point of ADR 0064. `""` means nothing
   *  was configured and nothing was discovered. */
  nextEntry: string;
  annotations: ReviewAnnotationInfo[];
  /** Panel only, in seat order — the tab's grouping. */
  seats?: ReviewSeatInfo[];
  /** Panel only, and only when one was produced (ADR 0060 D7). An EMPTY one
   *  is a cross-review that ran and found nothing (ADR 0075 §5); absence is
   *  one that did not run, and a `synthesis_missing` limit says why. */
  synthesis?: ReviewSynthesis;
  /** Panel only: which model wrote the cross-review (ADR 0075 §5). */
  crossReview?: ReviewCrossReviewInfo;
  /** Panel only: which model checked the concerns (V1, ADR 0076 §7) — by the
   *  cross-review's own rule, and absent when no verifier seat ran. */
  verifier?: ReviewCrossReviewInfo;
  /** The honesty record, present only when non-empty (ADR 0060 D6). */
  limits?: ReviewLimit[];
  /**
   * V4 (ADR 0081 §1): the compiled PDF the review read — where it came from,
   * its deterministic facts, and the pages the PDF reviewer viewed. Panel and
   * pdf modes; absent when no PDF was resolved (a limit says why) and when the
   * role is off. The record's own shape: the tab draws every field of it.
   */
  pdf?: ReviewPdfRecord;
  /**
   * V4 (ADR 0081 §3): the PDF reviewer's row, by a reviewer's rule — a
   * sibling of `seats`, never a member, so the panel line never counts it.
   * Absent when no PDF reviewer ran.
   */
  pdfSeat?: ReviewSeatInfo;
  /**
   * V6 (ADR 0088 §1): the shown review's scorecard — `deriveScorecard` of
   * the stored review, computed by the HOST on every push and never
   * persisted (ADR 0087 §3). Panel and pdf modes only; a quick review carries
   * no key. Enum keys and numbers: every word the tab draws over it is the
   * tab's own.
   */
  scorecard?: Scorecard;
  /**
   * V6 (ADR 0088 §2): the earlier review of the SAME manuscript the card is
   * compared against, by the version the picker shows, and whether the
   * engine called the pair comparable. Absent on a manuscript's first
   * reading. Present exactly when `delta` is. `unmeasured` (only when true):
   * no seat contributed to that version's card, so it measured nothing.
   */
  previous?: { version: number; comparable: boolean; unmeasured?: true };
  /** V6 (ADR 0088 §2): `scorecardDelta(previous card, this card)`. */
  delta?: ScorecardDelta;
  /** Every review this window holds, oldest first (ADR 0062 §1). */
  history?: ReviewHistoryEntry[];
  /** Which of them this state describes — an index into `history`. */
  selected?: number;
}

/** Triage state of one compile finding (X1) — mirrors ReviewAnnotationStatus. */
export type CompileFindingStatus = "pending" | "fixed" | "ignored";

export interface CompileFindingInfo {
  /** Position in the compile's finding list — the reveal/fix handle. */
  index: number;
  severity: "error" | "warning" | "info";
  /** Normalized code, e.g. "undefined-ref" | "overfull-hbox". */
  code: string;
  message: string;
  /** 1-based line; absent when the compiler reported none. */
  line?: number;
  status: CompileFindingStatus;
}

/**
 * The Compile tab state (X1). `ok` is the compile's own verdict, distinct from
 * `findings.length === 0`: a compile can succeed WITH warnings.
 */
export interface CompileTabState {
  /** False until a Compile Check has run in this window. */
  available: boolean;
  /** Checked file basename ("" when unavailable). */
  file: string;
  /** Did the project compile? */
  ok: boolean;
  findings: CompileFindingInfo[];
  /** Engine-resolution guidance (e.g. tectonic absent) — the honest empty state. */
  guidance?: string;
}

/** The Venue tab state (U4). */
export interface VenueState {
  /** A .tex/.md paper is open and parsed. */
  available: boolean;
  /** Entry basename ("" when unavailable). */
  file: string;
  /** \documentclass name; absent for Markdown / class-less fragments. */
  detectedClass?: string;
  detectedOptions: string[];
  /** Resolved library venue, when the detected class matched one. */
  venue?: VenueInfo;
  /** 4 rows when a venue matched, else []. */
  checklist: VenueChecklistRowInfo[];
}

// ── T2 (ADR 0043): the drive-and-measure vocabulary ─────────────────────────
//
// Plain data, deliberately: this file is compiled under the HOST's tsconfig,
// whose `lib` is `["ES2022"]` with no DOM, so nothing here may name an
// `Element`. The execution lives in `webview/parts/probe.ts`, which is compiled
// only under the webview's tsconfig and does have the DOM lib.
//
// **The vocabulary is closed, and that is the security property.** The obvious
// design — post a string of JavaScript and evaluate it — is refused, and is not
// even reachable: the webview CSP carries no `'unsafe-eval'`, so it would mean
// weakening the CSP of the one browser context in the product, the one that
// renders model output. Capability arrives as a named, bounded verb, never as a
// general escape hatch (invariant 2's shape, one level down). The SELECTOR is
// free; the VERB is not.

/** How many animation frames to wait AFTER this step, before the next one. */
export interface ProbeTiming {
  /**
   * Defaulted by the client, not by the wire. `1` pins an optimistic view (D2
   * item 1's actual claim — *the row changes within one frame*); `2` is settled
   * and is the default; `0` measures synchronously.
   *
   * It is part of the assertion, and it exists so these tests never wait on a
   * wall clock — a timing test that passes by waiting long enough measures the
   * CI machine, not the product.
   */
  afterFrames?: number;
}

export type ProbeVerb =
  // ── measure ──────────────────────────────────────────────────────────────
  | { verb: "exists"; selector: string }
  | { verb: "count"; selector: string }
  | { verb: "text"; selector: string }
  /** A form field's `value`, which is not its `textContent`. */
  | { verb: "value"; selector: string }
  | { verb: "classes"; selector: string }
  | { verb: "computed"; selector: string; name: string }
  | { verb: "rect"; selector: string }
  /**
   * Every match's rect, in document order. Separate from `rect` because the
   * questions differ: `rect` asks *where is this one box*, `rects` asks *do
   * these boxes share a row, and does any of them stick out of its container* —
   * which is D2 item 2's whole claim and cannot be answered one box at a time.
   */
  | { verb: "rects"; selector: string }
  | { verb: "overflows"; selector: string }
  // ── drive ────────────────────────────────────────────────────────────────
  | { verb: "click"; selector: string }
  | {
      verb: "key";
      selector: string;
      key: string;
      shift?: boolean;
      ctrl?: boolean;
      alt?: boolean;
      meta?: boolean;
    }
  | { verb: "input"; selector: string; text: string }
  /**
   * Sets an explicit width on the query container, through **CSSOM**. The verb
   * the milestone turns on: a `style` attribute is CSP-blocked while CSSOM is
   * not (the route `webview/parts/ring.ts` already uses for `--lm-ring-pct`),
   * and forcing the width is what makes `@container (max-width: 300px)` resolve
   * for real — the one fact jsdom structurally cannot supply.
   *
   * **`px: 0` REMOVES the override** rather than setting a zero-width panel.
   * The override outlives the request on a view the whole ext-host suite
   * shares, so a suite that forces a width must be able to hand it back — and
   * `width: 0px` is a collapsed panel, which would silently change what every
   * later suite measures.
   */
  | { verb: "setWidth"; selector: string; px: number };

export type ProbeStep = ProbeTiming & ProbeVerb;

/** A rect reduced to the six numbers a geometry assertion actually needs. */
export interface ProbeRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export type ProbeValue =
  | boolean
  | number
  | string
  | string[]
  | ProbeRect
  | ProbeRect[];

/**
 * Exactly one of `value` / `error` is set.
 *
 * An error is a *result*, never a thrown exception, because a rejected promise
 * is reserved for a broken channel (ADR 0043 §D6). That separation is what
 * makes a probe failure unambiguous between *the plumbing is broken* and *the
 * DOM is wrong* — the circularity objection [ADR 0037](../../../Lemmaria-design-doc/docs/adr/0037-webview-dom-tests.md)
 * §4 raised when it rejected this design.
 */
export interface ProbeResult {
  verb: string;
  value?: ProbeValue;
  error?: string;
}

/**
 * Messages the webview posts TO the extension host. Every type except the
 * `ready`/`echoed` handshake is auto-routed by the provider's single inbound
 * router to `handleWebviewMessage` (webview-view.ts) — there is NO second
 * allow-list to keep in sync, so a new command type here is reachable as soon
 * as `handleWebviewMessage` handles it.
 */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "echoed"; text: string }
  // T2 (ADR 0043): the reply half of the drive-and-measure protocol. Like
  // `echoed`, it is a REPLY rather than a command, so it needs its own branch
  // in `routeInboundMessage` — `handleWebviewMessage` handles commands and has
  // no access to the pending-request map.
  | { type: "probed"; requestId: string; results: ProbeResult[] }
  | { type: "runQuickAction"; actionId: string }
  // A5: the header ⚙ — open Lemmaria's own settings (it was a no-op button).
  | { type: "openSettings" }
  // ADR 0040: the Markdown code block's Copy button. The HOST writes the
  // clipboard — `navigator.clipboard` inside a webview is gated on a permission
  // the webview host owns and nothing here has verified it is granted, while
  // `vscode.env.clipboard` always works. One mechanism, not a fallback pair.
  | { type: "copyText"; text: string }
  | { type: "composerSend"; text: string }
  // A1a: abort the live session task (the composer's Stop affordance).
  | { type: "interruptTask" }
  // A1a: start a fresh thread from the header ＋ button (New Session command parity).
  | { type: "newSession" }
  // A2 (ADR 0021): the header ⟲ button — the same quick-pick as the
  // `Lemmaria: Resume Session` command.
  | { type: "resumeSession" }
  // E2 (ADR 0049): the composer menu's `/compact` verb. The only one of the
  // three that had no webview message: `Lemmaria: Compact Session` was
  // palette-only, where `newSession` and `resumeSession` were already posted by
  // the ＋ and ⟲ buttons. The handler calls the same function the palette
  // command calls, so the two cannot drift.
  | { type: "compactSession" }
  // E3 (ADR 0052): the composer's `@` menu asking for a FRESH candidate set.
  //
  // Posted on the transition from no menu to an `@` menu, and nowhere else —
  // one walk per open, never one per keystroke. The set is otherwise pushed
  // (on `ready`, on a grant change, on a session reset) exactly as
  // `skillsCatalogue` is; this exists because a file set goes stale in a way a
  // skill catalogue does not, since a file created in the editor is invisible
  // to a walk made at `ready`. The menu opens immediately from what it has and
  // the fresh set re-ranks it a beat later, which is why this can be a
  // fire-and-forget notification rather than a request/reply.
  | { type: "requestContextPaths" }
  // A1b (ADR 0016): per-edit decisions for the pending proposal batch,
  // parallel to the item's edits array. Note = rejection steering.
  | {
      type: "editDecisions";
      itemId: string;
      decisions: { accept: boolean; note?: string }[];
    }
  // A1b: the composer permission-mode selector (review = ask before edit).
  | { type: "setEditPolicy"; policy: "review" | "auto_apply" }
  // A1b: on-demand read-only diff for ONE FILE of a proposal — every edit of
  // that file combined, because the file is the approval unit.
  | { type: "showEditDiff"; itemId: string; file: string }
  // A4b (ADR 0020): approve/deny a pending run_script; alwaysAllow caches the
  // script's content-hash for the session so an identical re-run is silent.
  | {
      type: "scriptDecision";
      itemId: string;
      approve: boolean;
      note?: string;
      alwaysAllow?: boolean;
    }
  /*
   * E6 (D8, ADR 0058 §4) DELETED `branchFromMessage` from here — the ⟲'s one
   * message, which started a rewind outright and let an OS modal ask for
   * consent. The control opens a menu now, and the operator's three arms are
   * three different operations, so one message could not carry them; per the
   * no-backward-compatibility-burden convention it is removed rather than left
   * as an alias. What replaced it is the trio below.
   */
  /**
   * E6 (D8, ADR 0058 §4): the ⟲ is a MENU now, and one glyph posts three
   * different things because the operator asked for three different
   * operations — fork the conversation, rewind the code, or both.
   *
   * `rewindFork` runs on the click: a fork writes no user file, so invariant 3
   * asks nothing of it and a consent step in front of it would be ceremony.
   */
  | { type: "rewindFork"; messageId: string }
  /**
   * Compute the restore plan and push it back for consent — never apply it.
   *
   * The split into preview-then-decide is what replaced the OS modal: the host
   * computes the plan and its `expected` shas ONCE, holds them under a nonce,
   * and applies exactly that plan when the decision comes back. Same
   * compute-once-apply-that window the modal had, on a surface a test can read.
   */
  | { type: "rewindPreview"; messageId: string; withFork: boolean }
  /**
   * The answer to one consent card. `confirmed: false` — Cancel, Esc or a
   * click away — releases the pending plan rather than leaving it held.
   */
  | { type: "rewindDecision"; nonce: string; confirmed: boolean }
  /**
   * E6 (D10, ADR 0058 §6): `/fork [name]` — fork the active session at its END
   * and continue in the child.
   *
   * Posted by the composer INSTEAD of `composerSend`, which is what keeps a
   * `/fork` typed while a task runs from reaching the model as steering text.
   * `name` absent = the child inherits its parent's title (design §3).
   */
  | { type: "forkSession"; name?: string }
  | { type: "requestCitations" }
  | { type: "runCitationCheck" }
  | { type: "revealCitation"; file: string; line: number }
  | { type: "adoptCitation"; key: string }
  | { type: "requestModels" }
  | { type: "setActiveModel"; id: string }
  | {
      type: "addModel";
      provider: string;
      model: string;
      endpoint: string;
      label?: string;
      apiKey: string;
    }
  | { type: "removeModel"; id: string }
  | { type: "updateModelKey"; id: string; apiKey: string }
  | {
      type: "setModelImageInput";
      id: string;
      /** "auto" clears the override and returns the row to the table. */
      value: "auto" | "yes" | "no";
    }
  // R9 (ADR 0069 §D8): the whole roles value, every time — the card has no
  // per-row message, so a reader of the host never has to reconstruct the
  // count from a sequence of edits.
  | {
      type: "setReviewRoles";
      reviewers: string[];
      synthesis: string;
      verifier: string;
      /** V4 (ADR 0081 §8): the fourth role, in the same whole value. */
      pdfReviewer: string;
    }
  | { type: "requestVenue" }
  | { type: "newFromVenue" }
  | { type: "requestReview" }
  // V1 (ADR 0076 §9): `which: "counter"` opens the passage that answered a
  // withdrawn concern instead of the concern's own line. `index` stays the
  // handle, as everywhere in this protocol.
  | { type: "revealAnnotation"; index: number; which?: "counter" }
  | { type: "adoptSuggestion"; index: number }
  | { type: "ignoreAnnotation"; index: number }
  // ADR 0063 §3: hand this concern to the assistant. `prompt` is composed in
  // the webview, where the reader's language lives, and the host sends it down
  // exactly the path a typed message takes — so the busy/steering rule keeps
  // its one home. Was ADR 0062 §5's pure triage flip; it writes nothing itself,
  // and anything the assistant then proposes goes through approval as always.
  | { type: "resolveAnnotation"; index: number; prompt: string }
  // ADR 0062 §1: show a different review of this window.
  | { type: "selectReview"; id: number }
  // ADR 0062 §2: run `Lemmaria: Select Paper Entry` from the tab's header.
  | { type: "choosePaperEntry" }
  // ADR 0064 §2: start a blind panel from the Review tab's launcher. Carries no
  // payload because it IS the `/review` a user would type — ADR 0065 §2 moved
  // where that goes (a detached run, not a chat task), and the two routes still
  // meet at one implementation.
  | { type: "runReviewPanel" }
  // V4 (ADR 0081 §7): the launcher's *Review the PDF* — the `/review-pdf` a
  // user would type. No payload, for the same reason as the panel's.
  | { type: "runReviewPdf" }
  // ADR 0065 §3: stop the running panel. The tab owns the run now, so the tab
  // owns stopping it — the composer's Stop is the CHAT's and the two are
  // independent, which is the point of detaching them.
  | { type: "stopReview" }
  | { type: "requestCompile" }
  | { type: "revealFinding"; index: number }
  | { type: "fixFinding"; index: number }
  | { type: "fixAllFindings" }
  | { type: "ignoreFinding"; index: number }
  // A4 (ADR 0019): the ＋ grant chip opens the host's folder picker…
  | { type: "addGrant" }
  // …and a chip's × revokes that grant (bites at the next tool call).
  | { type: "revokeGrant"; id: string };

/** Messages the extension host posts TO the webview. */
export type HostToWebview =
  | { type: "echo"; text: string }
  // T2 (ADR 0043): drive a gesture and measure the result, in the REAL webview.
  // It SHIPS rather than being compiled out, deliberately: an instrument that
  // measures an artifact users never receive is the class of error ADR 0038 §3
  // is about. It grants the host nothing it lacks — the host already posts
  // every message this webview acts on.
  | { type: "probe"; requestId: string; steps: ProbeStep[] }
  | {
      type: "init";
      locale: "en" | "zh";
      quickActions: QuickActionInfo[];
      model: ModelInfo;
      budget: BudgetInfo;
    }
  | { type: "selection"; state: SelectionState }
  | { type: "citationsC1"; state: CitationsC1State }
  | { type: "citationsC2"; state: CitationsC2State }
  | { type: "modelsState"; state: ModelsState }
  | { type: "venueState"; state: VenueState }
  // `reveal: true` = a review just completed; the webview switches to the tab.
  | { type: "reviewState"; state: ReviewTabState; reveal?: boolean }
  // ADR 0065 §3: the running panel, or `undefined` once there is nothing to
  // say about one. Pushed on every driver frame, independently of
  // `reviewState` — see `ReviewRunInfo`.
  | { type: "reviewRun"; run?: ReviewRunInfo }
  // `reveal: true` = a Compile Check just completed; the webview switches to the tab.
  | { type: "compileState"; state: CompileTabState; reveal?: boolean }
  // A0: one typed session event (ADR 0014); the transcript folds these by item id.
  | { type: "sessionEvent"; event: SessionEvent }
  // A1a: Lemmaria: New Session started a fresh thread — clear the transcript fold.
  | { type: "sessionReset" }
  // A5: the whole transcript of the session already live in the host, sent on
  // the `ready` handshake so a re-created webview (window reload, view moved
  // between containers) rebuilds what its module-level state just lost. The
  // items are the persisted, replayed ones — deltas were never persisted — so
  // this is a state SNAPSHOT, not a replay of the event stream. Absent when no
  // session is active: re-opening an OLD session stays an explicit gesture.
  | {
      type: "transcriptReplay";
      sessionId: string;
      items: SessionItem[];
      /**
       * Whether a task is STILL RUNNING in the host. Without it a reloaded
       * webview renders a pending approval card read-only (its buttons are
       * gated on busy) while the loop waits forever for a decision — a
       * transcript that looks restored but cannot be acted on.
       */
      busy: boolean;
    }
  // A1b: the session's current edit policy (pushed on ready and after change).
  | { type: "editPolicy"; policy: "review" | "auto_apply" }
  /**
   * ADR 0031: the user messages the conversation can branch at — every
   * non-steered one. This is what decides whether the affordance is drawn at
   * all.
   *
   * E4 (ADR 0054) DELETED the `writingBranchPoints` member that used to sit
   * beside this one — the subset with file changes after it, which chose ⟲
   * over ⑂ and did nothing else. One face now serves every branch point, so
   * this is the only set the transcript needs, and there is no longer a pair
   * that has to be read and delivered together.
   *
   * E7 (ADR 0055) gives each point a NUMBER — files the click would change,
   * from the current leaf — and takes it as a FIELD rather than as a second
   * message, because the pair is the hazard E4 removed. It is `rewindPoints`
   * and no longer `forkPoints`: ADR 0054 retired "fork" as this control's
   * concept (*the user is not asking to create a sibling node; they are
   * asking to go back*), and E6 is scheduled to introduce a real `/fork`, so
   * the old name would have collided with the milestone arriving next.
   *
   * `files` is a HINT in front of invariant 3's gate, never a substitute for
   * it: the consent card still names every file by path before consent (E6,
   * ADR 0058 §4 — it was the OS modal that named them until then). ADR 0058
   * also restates what the number means, now that the click leads to a menu:
   * **the count is the RESTORING arms' plan**, and the fork-only arm changes
   * no file at all.
   */
  | {
      type: "rewindPoints";
      points: { id: string; files: number }[];
    }
  /**
   * E6 (D8): the plan a `rewindPreview` asked for, on its way to the card.
   *
   * `nonce` identifies the plan the host is holding — the webview echoes it
   * back with the decision, and a decision under any other nonce is dropped.
   * `files` and `deletions` are workspace-relative paths, rendered as
   * textContent; `messageId` is what routes the push to the open popover, so a
   * card cannot land on a menu opened at a different message.
   */
  | {
      type: "rewindConfirm";
      nonce: string;
      messageId: string;
      withFork: boolean;
      files: string[];
      deletions: string[];
    }
  /**
   * E6 (code review): the host computed no plan, so there is no card coming.
   *
   * A restoring arm disables all three while it waits, and the host answers
   * with nothing when a task is in flight, no workspace folder holds the files,
   * or the session or the cut cannot be resolved. Without this the popover sits
   * on three dead buttons — so a refusal is a MESSAGE, not a silence. It
   * carries no nonce because no plan was stored; `messageId` routes it to the
   * menu that asked, exactly as `rewindConfirm` does.
   */
  | { type: "rewindPreviewRefused"; messageId: string }
  // A1b round 2 (ADR 0018): a rewind hands the message back to the composer,
  // so the user can edit and resend it (the Codex convention). B7 (ADR 0028)
  // reuses it for `Lemmaria: Use a Writing Skill`, which prefills the
  // `/skill:<name> ` prefix — in both cases the composer is filled and focused
  // but NOT sent, so the user sees exactly what will go.
  | { type: "composerPrefill"; text: string }
  // A2 (ADR 0021): measured context-window occupancy for the composer ring.
  // `occupied` omitted = not measured yet (a fresh thread, or just compacted).
  | { type: "contextUsage"; occupied?: number; window: number }
  // A5: THIS session's spend so far, folded from its persisted turn usage.
  // `costUsd` absent = the model reports no price (BYOK/local, ADR 0002) — the
  // composer then shows tokens only, never a fabricated $0.00.
  | {
      type: "sessionCost";
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
      /**
       * Calls that reported tokens but no price (absent = none). With a
       * `costUsd` present this means the dollar figure covers only PART of the
       * session — switching models mid-thread is enough to cause it — so the
       * composer marks the total as incomplete instead of quietly showing a
       * number that is too small.
       */
      unpricedCalls?: number;
    }
  // A4 (ADR 0019): the session's granted folders (pushed on ready and change);
  // the webview renders them as chips above the composer.
  | {
      type: "grantsState";
      grants: { id: string; label: string; path: string }[];
    }
  // E2 (ADR 0049): the loaded writing skills, for the composer's `/` menu.
  // Pushed on ready and on every change, never polled — E1 shipped a runtime
  // toggle (`lemmaria.skills.toggle`), so the enabled set moves while the panel
  // is open.
  //
  // **`name` and `description` only, deliberately.** `Skill.path` is UI
  // provenance that E1 keeps from the model on purpose; the menu has no use for
  // it, and putting it on this wire would be a decision about provenance rather
  // than a field addition. The description crosses AS AUTHORED — invariant 6's
  // stated boundary (ADR 0045): Lemmaria localizes what it writes as its own,
  // never text a third party wrote that it merely displays as theirs.
  | {
      type: "skillsCatalogue";
      skills: { name: string; description: string }[];
    }
  // E3 (ADR 0052): the paths the composer's `@` menu may offer — the paper
  // workspace plus each active grant, and nothing else.
  //
  // **Every root here was walked by the call `list_files` itself makes** —
  // `VscodeWorkspace.listFiles` for the workspace, `walkGrantedRoot` for a
  // grant — so *the menu offers no path the model could not already reach*
  // holds by construction rather than by inspection (invariant 2, design §5).
  // The two walks filter DIFFERENTLY and that is deliberate: ADR 0019 applies
  // `.gitignore` and the deny-read list to granted roots only, and narrowing
  // the workspace half to match would hide paths the model can read today.
  //
  // `workspace` is ABSENT when there is no paper in context, because the
  // session's registry then has no workspace either and `list_files` refuses.
  //
  // Paths cross AS WALKED — invariant 6's stated boundary, the same rule a
  // skill description travels under. A filename is the filesystem's text, not
  // Lemmaria's, whatever scripts it mixes.
  | {
      type: "contextPaths";
      workspace?: ContextRootPayload;
      grants: ContextRootPayload[];
    };

/** One walked root on the `contextPaths` wire (E3). */
export interface ContextRootPayload {
  /** The grant's `label`; absent for the paper workspace, which needs none. */
  qualifier?: string;
  /** Root-relative, `/`-separated file paths. Folders are DERIVED, not sent. */
  files: string[];
  /** The discovered paper entry, root-relative — it sorts first (design §2). */
  entry?: string;
  /**
   * What the walk refused to show, counted (B4 / A6) — never listed.
   *
   * **An absent figure means NOT COUNTED; zero means none.** `list_files`
   * draws exactly this distinction in exactly this branch: its workspace
   * listing reports `excludedByDefault: 0` (a fact — that walk applies no
   * deny-list) and OMITS the gitignore and skip-dir counts, because
   * `VscodeWorkspace.listFiles` skips `node_modules` and friends without ever
   * counting them, and reporting `0` would be the invented count A6 added the
   * counters to eliminate.
   */
  excluded: {
    truncated: boolean;
    byDefault?: number;
    byGitignore?: number;
    bySkipDir?: number;
  };
}

/** The object VS Code injects into the webview via `acquireVsCodeApi()`. */
export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
