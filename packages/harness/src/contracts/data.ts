/**
 * Cross-component data contracts.
 *
 * Canonical source of truth. The TypeScript blocks in architecture-design-EN.md
 * are a human-readable mirror of these; if they ever diverge, THIS FILE WINS.
 * Ported verbatim into @lemmaria/harness/src/contracts at Milestone 1.
 */

import type { VenueManifest, VenuePageLimit } from "./venues.js";

// ── Unified warning structure ────────────────────────────────────────────────
// Emitted by the latexmk + tectonic log parsers, the Markdown parse-checker, and
// citation C1 — one shape so the Compile tab / diagnostics / citation C1 are all
// engine-agnostic. Warning is baseline-AGNOSTIC (ADR 0002): X1 removed the
// baseline comparison entirely (ADR 0013 — a compile reports every finding, not
// a diff against a snapshot), but the shape was always independent of it.

export type WarningSource = "latexmk" | "tectonic" | "markdown" | "citation";
export type Severity = "error" | "warning" | "info";

export interface Warning {
  /** Stable key for a finding, e.g. hash(code + file + normalizedMessage). */
  id: string;
  source: WarningSource;
  severity: Severity;
  /** Normalized code: "overfull-hbox" | "undefined-ref" | "duplicate-key" | "missing-label" | ... */
  code: string;
  message: string;
  /** Path relative to project root. */
  file: string;
  line?: number;
}

// ── Citation check result ────────────────────────────────────────────────────

export type CitationStatus =
  | "ok"
  | "metadata_mismatch"
  | "preprint_superseded"
  | "not_found" // suspected hallucinated citation
  | "unverified"; // online lookup could not complete (timeout/network) — NOT the same as not_found

export interface BibDiff {
  /** One-click-applicable patch to the .bib entry (field-level before/after). */
  key: string;
  changes: Array<{ field: string; from?: string; to: string }>;
}

export interface CitationResult {
  key: string; // bib key
  status: CitationStatus;
  source: "offline" | "crossref" | "dblp" | "semantic_scholar";
  matchedBy?: "doi" | "title";
  correction?: BibDiff; // for metadata_mismatch / preprint_superseded
}

// ── Review result ────────────────────────────────────────────────────────────
// Produced by the `review` action kind (the single-model quick action) and, as
// a concern LEDGER, by a panel seat's report (ADR 0008 → ADR 0060). Every
// position in here was located by the HARNESS in the manuscript's own bytes:
// the model supplies verbatim quotes, never line numbers and never identity.

/** A harness-located position. Lines are 1-based and computed from the file. */
export interface ReviewSpan {
  file: string;
  line: number;
  endLine?: number;
}

/**
 * A paper a reviewer's own search returned, as the HARNESS recorded it (V2,
 * ADR 0078).
 *
 * Every field is copied from the recorded `LiteratureResult`, never from the
 * model's typing of it: the model supplies a title to match on and nothing
 * else, exactly as it supplies a quote and never a line number. A title no
 * search of that reviewer's returned is not recorded at all — the whole
 * concern drops, which is ADR 0060 §3's rule with a second cause.
 *
 * **No abstract.** It is third-party text of up to 1,000 characters per
 * concern whose only consumer is the verifier, which reads it while the driver
 * still holds it (ADR 0078, D11). Nothing persists it.
 */
export interface ReviewPaper {
  /** The RECORDED result's title, never the model's typing of it. */
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  doi?: string;
  url?: string;
  /** The index that returned it, as the tool named it. */
  source: string;
}

/**
 * Where the support for a concern's claim sits — a located passage, a paper
 * one of that reviewer's own searches returned, or *none at all* meaning the
 * reviewer looked and the manuscript offers nothing (ADR 0060 D2, ADR 0078).
 *
 * The harness NEVER manufactures `{kind: "missing"}`: an evidence quote it
 * cannot locate, and a paper no search returned, each drop the whole
 * annotation instead, because *found none* and *quoted it wrong* are opposite
 * findings.
 *
 * **Tagged since V2 (ADR 0078, D1), and the old shapes are gone.** Two shapes
 * told apart by `evidence === "missing"` leave no room for a third that is
 * also an object; the tag is what makes `paper` addable without guessing
 * structurally. Nothing reads an untagged evidence — there is no
 * backward-compatibility burden (CLAUDE.md → Conventions), `ReviewStore` is at
 * `v: 2` and a `v: 1` file reads as empty.
 */
export type ReviewEvidence =
  | ({ kind: "span" } & ReviewSpan)
  | { kind: "missing" }
  | ({ kind: "paper" } & ReviewPaper)
  /**
   * V4 (ADR 0081): the page of the COMPILED PDF on which the problem is
   * visible — accepted only from the seat that viewed pages, and only for a
   * page it actually viewed in this review. Membership in that seat's viewed
   * set is the whole check, so the harness stamps nothing but the number.
   * Since ADR 0084 the harness may MOVE that number, once the ledger is final,
   * to the page the anchored float sits on — a page also in the viewed set —
   * and records every move as a `pages_corrected` limit.
   */
  | { kind: "page"; page: number };

/**
 * The dimensions a PANEL seat may file a concern under (V2, ADR 0078; R3's
 * five, plus `originality` and `significance`).
 *
 * In the contracts rather than in the driver because the eval instrument, the
 * tab's labels and the driver's brief all have to mean the same seven, and
 * because the stage's model-facing-text guard already covers this file — a
 * dimension whose name invited a number would fail a test rather than reach a
 * model. (That guard is deny-by-default with no allowlist, and it matches
 * whole words, so its own filename cannot be written here either.)
 *
 * A quick action's dimensions are NOT these: they come from its own
 * `review_schema.dimensions`, which is why `ReviewAnnotation.dimension` stays
 * a plain `string`.
 */
export const PANEL_DIMENSIONS = [
  "soundness",
  "claims",
  "clarity",
  "language",
  "positioning",
  "originality",
  "significance",
  // V4 (ADR 0081): what is wrong with the rendered page rather than the
  // argument. Filed only with a page as evidence, so only the seat that sees
  // the compiled paper can file it — by construction, not by instruction.
  "presentation",
] as const;

export type PanelDimension = (typeof PANEL_DIMENSIONS)[number];

export interface ReviewAnnotation {
  /** Harness-stamped identity, `"<reviewer>-<n>"`, `n` 1-based and dense over
   *  the LOCATED annotations of that reviewer in this result — a dropped anchor
   *  consumes no number (ADR 0060 D1). Distinct seat names make it unique
   *  across a panel; a model-supplied `id` is ignored like any unknown key.
   *  Stable within one result only: ledger → synthesis → tab → adoption. */
  id: string;
  /** The seat name: the quick action's `model.role`, or the panel seat R3
   *  names — a string, model-agnostic. Harness-stamped (ADR 0008 §3). */
  reviewer: string;
  dimension: string; // from review_schema.dimensions
  severity: "info" | "minor" | "major";
  /** The claim's position — harness-located from the model's verbatim anchor. */
  span: ReviewSpan;
  message: string;
  /** Model-supplied, harness-checked: settable ONLY on a `"major"` concern, and
   *  absent stays absent (ADR 0060 D3). Blocking is orthogonal to severity —
   *  it says the manuscript's central case fails without this — so the harness
   *  enforces the contradiction the protocol forbids, not the omission. */
  blocking?: boolean;
  /** Model-supplied, harness-resolved (ADR 0060 D2; ADR 0078): a quote the
   *  harness located, a paper one of this reviewer's own searches returned, or
   *  none. Required in a ledger, optional in a quick action, whose prompt never
   *  asks for it — and whose wire accepts only the first two forms. */
  evidence?: ReviewEvidence;
  /** On adopt, ENTERS the edit flow (diff + verify) — never written directly.
   *  `original` is the harness-located anchor text the replacement replaces
   *  (ADR 0008): hosts re-locate it in the live buffer at adopt time and
   *  refuse on drift, inheriting the content-anchor staleness semantics. */
  suggestedEdit?: { original: string; replacement: string };
  /**
   * V1 (ADR 0076): what the panel's verifier found for this concern. Absent on
   * a quick action, on a panel whose verification did not run, and on a concern
   * the verifier never answered — the result's `verification_missing` limit
   * says which. Attached AFTER the ledgers are frozen and never alters another
   * field of the concern.
   */
  verification?: ReviewVerification;
}

/** V1 (ADR 0076): the three things a verifier may conclude about a concern. */
export type VerificationOutcome = "upheld" | "refuted" | "unverifiable";

/** V1 (ADR 0076): what kind of claim a concern makes — each kind is tested
 *  differently, and only `absence` and `contradiction` can be refuted from the
 *  manuscript's own text. */
export type VerificationKind =
  | "absence"
  | "contradiction"
  | "literature"
  | "judgment";

/**
 * What the panel's verifier found for one concern (ADR 0076). Harness-checked:
 * `counter` is a position the HARNESS located, and it is present exactly when
 * `outcome` is `"refuted"`. There is no message, severity or suggestion here,
 * so a verification cannot restate the concern it is about (ADR 0060 D7's
 * rule, one role over).
 */
export interface ReviewVerification {
  outcome: VerificationOutcome;
  kind: VerificationKind;
  /** The passage that answers the concern — located by the harness from the
   *  verifier's verbatim quote, with the ledger's own locator. */
  counter?: ReviewSpan;
  /**
   * Present when the harness recorded `"unverifiable"` and the model answered
   * something else.
   *
   * Three reasons are a **refutation's**: its quote was missing or could not
   * be located (`counter_not_found`), the kind is one the manuscript cannot
   * refute (`not_refutable`), or the quote located to a line the concern
   * itself already points at — its claim span or its evidence
   * (`counter_is_the_concern`, V1's J1 round). A concern is never withdrawn on
   * a passage nobody can find, nor on the passage it is about.
   *
   * The fourth is **direction-blind** (ADR 0079 §2): `no_abstract` — a
   * `literature` concern whose brief carried no
   * abstract cannot be settled either way, so an `upheld` is downgraded
   * exactly as a `refuted` is. That is what `concern-verifier/SKILL.md`
   * rules 2–3 already told the verifier, and what an `upheld` quietly
   * bypassed until V2's gate-review round read one on screen.
   */
  downgraded?:
    | "counter_not_found"
    | "not_refutable"
    | "counter_is_the_concern"
    | "no_abstract";
  /**
   * Recorded only on a `"major"` concern, and only when the model gave a
   * boolean: `false` means the paper's main claim survives this concern. It
   * gates the *blocking* badge's DISPLAY (`isBlocking`) and never edits the
   * reviewer's own `blocking` flag (ADR 0060 §4 stands).
   */
  central?: boolean;
  /** The verifier's own sentence — third-party text, passing as authored. */
  note?: string;
}

/**
 * What the verifier's answers came to, counted by the harness (V1, ADR 0076).
 * Declared here, beside `LedgerCounts`, because it reaches the wire on
 * `ReviewSeatState`.
 *
 * The identity **`concerns === upheld + refuted + unverifiable + unanswered`**
 * holds by construction; `downgraded` is a subset of `unverifiable`, not a
 * fifth outcome.
 */
export interface VerificationCounts {
  /** Located concerns the verifier was handed. */
  concerns: number;
  upheld: number;
  refuted: number;
  unverifiable: number;
  /** Of `unverifiable`: those the model answered `refuted` and the harness
   *  could not record as such. */
  downgraded: number;
  /** Concerns with no recorded entry at all. */
  unanswered: number;
}

/**
 * V4 round 5 (ADR 0086): what a concern said when a rule SET IT ASIDE
 * (`concerns_set_aside`, `furniture_set_aside`) — kept so the reader can
 * check the rule against what it caught. A set-aside concern used to keep
 * only its dimension, so one a rule caught wrongly was invisible.
 *
 * **Display-only.** It is not an annotation: it has no id, is never
 * verified, charged, cited by a synthesis or counted by the eval, and a host
 * offers no action on it. `message` is the model's own prose, rendered AS A
 * CONCERN — the limit's own sentence is still built from its fields alone
 * (ADR 0060 D6).
 */
export interface SetAsideConcern {
  severity: ReviewAnnotation["severity"];
  /** Present only when the seat set it, as on an annotation. */
  blocking?: true;
  message: string;
  /** Where it was located, before it was set aside — the file and the line
   *  the fold names, and no `endLine`. */
  span: ReviewSpan;
  /** The page of the compiled PDF it cited, AS CITED: a set-aside concern is
   *  never moved (ADR 0084's step runs after the set-asides). */
  page?: number;
}

/** Why an anchor never became a position — the one vocabulary both
 *  `anchors_dropped` and V5's `strengths_lost` record (ADR 0087).
 *
 *  V2 (ADR 0078 §3): `not_in_results` is the one reason that is not about the
 *  manuscript at all — the anchor is a PAPER's title as the model wrote it,
 *  and no search that reviewer ran returned it. It therefore carries no
 *  `file`, because nothing was searched for in a file. V4 (ADR 0081):
 *  `page_not_viewed`, the same rule for a page. In the contracts since V5,
 *  because a second limit kind carries it; the engine imports it from here. */
export type DropReason =
  | "not_found"
  | "ambiguous"
  | "unknown_file"
  | "not_in_results"
  | "page_not_viewed";

/** What a review could NOT do — the harness-written honesty record (ADR 0060
 *  D6). Structured, and every SENTENCE a host writes of it is built from its
 *  fields: a host renders `kind` and `reason` in the reader's own language
 *  (invariant 6), the way the transcript renders a `ToolErrorCode`. Model text
 *  rides along in two places and is never part of that sentence:
 *  `anchors_dropped`'s `anchor`, for the record, and a set-aside entry's
 *  `concern`, drawn as a concern (ADR 0086). R3 (ADR 0061) extended this union additively with
 *  the four kinds only a panel DRIVER can observe: `seat_unguided`,
 *  `source_unavailable`, `search_budget_spent` and `synthesis_missing`. ADR 0060
 *  promised the first two; building the driver showed the other two are the same
 *  kind of fact — a seat that concluded something while a source or a budget was
 *  gone under it — and a record that omitted them would claim a completeness the
 *  panel does not have. */
export type ReviewLimit =
  | {
      kind: "anchors_dropped";
      reviewer: string;
      anchors: Array<{
        /** The quote as the model wrote it (thawed, where thawing applies). */
        anchor: string;
        /**
         * The file the anchor was searched in, where the harness knows it.
         *
         * **Ledger mode, since X5 (ADR 0074 §1–§2):** a search STARTS in the
         * file the model named, else the seat's `defaultFile`, and falls back
         * to the rest of the manuscript. What `file` means is therefore read
         * together with `reason`:
         *
         *  - `not_found` + `file` — not in the file the search started in,
         *    **and nowhere else in the manuscript**.
         *  - `ambiguous` + `file` — more than once in the file the search
         *    started in, so no fallback ran: naming a file is how a model
         *    disambiguates, and lengthening the quote is its move to make.
         *  - `ambiguous`, **no `file`** — absent from the start file (or there
         *    was none), and present in more than one other file.
         *  - `unknown_file` + the model's own raw string — it named a file the
         *    manuscript does not have, **and** the quote is in no file that it
         *    does. A wrong `file` alone no longer drops the entry.
         *
         * **Absent on a quick action's `not_found` / `ambiguous` drop**, where
         * the file was never in doubt: a quick review annotates one unit of
         * one file, and its three reasons are unchanged by X5.
         *
         *  - `not_in_results`, **no `file`** (V2, ADR 0078) — nothing was
         *    searched for in the manuscript at all. The `anchor` is a PAPER's
         *    title as the model wrote it, and no search that reviewer ran
         *    returned it. Ledger mode only, and `role` is always `evidence`.
         *  - `page_not_viewed`, **no `file`** (V4, ADR 0081) — the seat cited
         *    a page of the compiled PDF it never viewed. The `anchor` is
         *    `"page N"`, the number as the model wrote it. Ledger mode only,
         *    `role` always `evidence`.
         */
        file?: string;
        role: "claim" | "evidence";
        reason: DropReason;
      }>;
    }
  /**
   * X5 (ADR 0074 §3): wire entries of a LEDGER that violated the shape and
   * were not recorded. One malformed entry costs that entry, never the ledger
   * — a seat's minutes-long paid read is ten independent findings, and losing
   * all of them to one bad `blocking` flag is what this kind exists to stop.
   *
   * Ledger mode only. The quick action still fails whole (`interpretAnnotations`
   * retries, and a retry is what its feedback is for), which is ADR 0008
   * untouched.
   */
  | {
      kind: "entries_rejected";
      reviewer: string;
      /**
       * One per rejected entry, ordered by `index`. `index` is the entry's
       * 1-based position in the seat's `annotations` array — the WIRE order,
       * so a rejected entry consumes a cap slot exactly as a drop does, and no
       * id. `reason` is the interpreter's own model-facing English: it feeds
       * the record and the one re-ask, and is **never rendered verbatim to a
       * reader** (invariant 6 rule 2) — a host renders the count.
       */
      entries: Array<{ index: number; reason: string }>;
    }
  | {
      kind: "seat_missing";
      reviewer: string;
      reason: "failed" | "interrupted" | "unparsed";
      /** The parse failure, model-facing English — for the record, never
       *  rendered verbatim to a reader (invariant 6 rule 2). */
      detail?: string;
      /** X5 (ADR 0074 §7): why the seat's stream died, classified by the
       *  child's own retry policy with the HTTP status in hand. Only ever
       *  present on `reason: "failed"` — an `interrupted` seat was stopped by
       *  the user and an `unparsed` one answered, so neither has a cause. */
      cause?: ModelFailureCause;
      /**
       * ADR 0082 §2: the budget the seat ran out of before it finished its
       * report — the one of the three a user sets (`lemmaria.budget.*`), so a
       * host can say which to raise instead of calling the report unreadable.
       * Only ever on `reason: "unparsed"`, and only when the seat stopped on
       * that budget; `detail` keeps its sentence for the record.
       */
      ranOutOf?: SeatBudget;
    }
  /** R3 (ADR 0061): the seat never loaded the panel protocol, so whatever it
   *  reported it reported unguided. With the forced `/skill:` load this should
   *  never appear; it is the runtime assertion that the load happened, not a
   *  condition the driver expects to meet. */
  | { kind: "seat_unguided"; reviewer: string }
  /** R3 (ADR 0061): a literature source this seat searched did not answer. One
   *  entry per (source, status) pair, so a `positioning` seat that concluded
   *  *no prior work* while arXiv was down is on the record rather than believed.
   *  `status` is the tool's own per-source status, minus `ok`. */
  | {
      kind: "source_unavailable";
      reviewer: string;
      source: string;
      status: "rate_limited" | "timeout" | "failed";
      /** R4 (ADR 0067): this source ran WITHOUT an API key, so its limit is
       *  the anonymous one and a key would raise it. Present only when true —
       *  the pointer is by exception, so a keyed source that failed anyway
       *  carries nothing and a source that answered carries nothing. */
      anonymous?: true;
    }
  /** R3 (ADR 0061): this seat asked the literature for something and the
   *  session's shared search budget was already spent — so its grounding is
   *  thinner than it would have been. The panel's seats share ONE budget:
   *  decided by R4 as shared (ADR 0067 §6), because only the `positioning`
   *  seat is told to search, so an equal carve would leave two thirds idle. */
  | { kind: "search_budget_spent"; reviewer: string }
  /** R3 (ADR 0061): the panel produced no synthesis, and why. `insufficient_seats`
   *  is the honest structural case (fewer than two parsed ledgers, or nothing
   *  located between them), not a failure — a synthesis of one seat is not a
   *  synthesis, which is the same rule `interpretSynthesis` enforces per entry. */
  | {
      kind: "synthesis_missing";
      reason:
        | "insufficient_seats"
        | "no_report"
        | "unparsed"
        | "failed"
        | "interrupted";
      /** Model-facing English, for the record only (invariant 6 rule 2). */
      detail?: string;
      /** X5 (ADR 0074 §7): as on `seat_missing`, and for the same reason —
       *  the fourth child dies the same way the other three do. Only ever
       *  present on `reason: "failed"`. */
      cause?: ModelFailureCause;
    }
  /**
   * V1 (ADR 0076): some or all of the panel's concerns were NOT checked
   * against the manuscript, and why.
   *
   *  - `off` — the user turned verification off. A limit on purpose: whether a
   *    review was checked must be readable from the persisted result alone.
   *  - `no_protocol` — the `concern-verifier` skill was not offered, or a
   *    child never completed its load; that child's answers are discarded,
   *    because an unguided verifier is not evidence.
   *  - `interrupted` — the user stopped the panel before or during it.
   *  - `failed` / `no_report` / `unparsed` — as on `synthesis_missing`, one
   *    entry PER FAILED CHILD.
   *  - `incomplete` — every child settled, and at least one concern still has
   *    no recorded entry.
   *
   * No entry at all when nothing was located: there was nothing to check.
   */
  | {
      kind: "verification_missing";
      reason:
        | "off"
        | "no_protocol"
        | "interrupted"
        | "failed"
        | "no_report"
        | "unparsed"
        | "incomplete";
      /** Model-facing English, for the record only (invariant 6 rule 2). */
      detail?: string;
      /** As on `synthesis_missing` (ADR 0074 §7). Only ever on `"failed"`. */
      cause?: ModelFailureCause;
    }
  /**
   * V2 (ADR 0078 §D8): this review's literature searches were NOT kept from
   * returning the manuscript itself, so a reviewer may have cited the paper it
   * was reviewing as prior work.
   *
   *  - `no_title` — the manuscript's own title could not be read, so there was
   *    nothing to withhold.
   *  - `unavailable` — the host wired no withholding holder for this run.
   *
   * **A limit and not a notice**, deliberately: a completed panel's WARN
   * notices do not survive to the Review tab, and design assumption 6 requires
   * that the *record* say so. Panel-wide, so it carries no `reviewer` — the
   * gap is the run's, not one seat's.
   */
  | { kind: "own_title_unguarded"; reason: "no_title" | "unavailable" }
  /**
   * V4 (ADR 0081): the compiled PDF was not reviewed, because it could not be
   * had. `reason` is exactly the PDF policy's failure vocabulary (ADR 0080 §8),
   * so the record and the policy cannot spell one thing two ways. `detail`
   * carries a failed compile's log tail — model-facing English, for the record
   * only, never rendered (invariant 6 rule 2). Panel-wide.
   */
  | {
      kind: "pdf_unavailable";
      reason: "none" | "stale" | "compile_failed" | "render_failed";
      detail?: string;
    }
  /**
   * V4 (ADR 0081): the compiled PDF was not reviewed, because nothing could
   * see it. *Visual* means a seeing model AND a renderer, together — a host
   * that wired no renderer is as blind as a model that takes no image.
   * Panel-wide.
   */
  | {
      kind: "visual_unavailable";
      reason: "model_has_no_image_input" | "no_renderer";
    }
  /**
   * V4 (ADR 0081): the PDF reviewer completed having viewed fewer pages than
   * the PDF has. Pushed only when that seat completed. Panel-wide.
   */
  | { kind: "pages_unviewed"; viewed: number; total: number }
  /**
   * ADR 0083 §2: concerns a seat raised that located and were then SET ASIDE —
   * in a panel, the PDF reviewer's concerns outside `presentation` that cite
   * no page. The text reviewers read the argument from the source, and nothing
   * verifies the PDF reviewer's, so a panel keeps the page's concerns and
   * records the count of the rest. One entry per concern set aside, carrying
   * its dimension for the record; a host renders the count.
   *
   * Since V4 round 5 (ADR 0086) each entry also keeps what the concern SAID
   * (`concern`), so the reader can check what a rule set aside. Absent on a
   * record written before it.
   */
  | {
      kind: "concerns_set_aside";
      reviewer: string;
      entries: Array<{ dimension: string; concern?: SetAsideConcern }>;
    }
  /**
   * ADR 0084: page citations the harness MOVED. The PDF reviewer cited a page
   * other than the one the float its anchor sits in was placed on — the page
   * the compile's `.aux` gives that float's `\label`, confirmed by the float's
   * caption label in the PDF's own text on that page — and the harness moved
   * the cite there, as it locates every other position. Only ever to a page
   * the seat viewed. One entry per concern, by its final id, with the page it
   * cited and the page it now carries; a host renders the count.
   */
  | {
      kind: "pages_corrected";
      reviewer: string;
      entries: Array<{ id: string; cited: number; page: number }>;
    }
  /**
   * V4 round 4 (ADR 0085 §2): concerns the PDF reviewer raised about what the
   * document class prints FOR REVIEW, set aside in both modes: the author
   * block, when the class runs with `anonymous` and so never prints it, and
   * the template's placeholder DOI or ISBN. The addendum's rule 1 says both
   * are not the seat's, and round 4 filed them as major and blocking in 3 of
   * 3 runs anyway. Counted in `LedgerCounts.setAside` beside
   * `concerns_set_aside`'s; one entry per concern set aside, carrying its
   * dimension for the record; a host renders the count. `concern` as there
   * (ADR 0086).
   */
  | {
      kind: "furniture_set_aside";
      reviewer: string;
      entries: Array<{ dimension: string; concern?: SetAsideConcern }>;
    }
  /**
   * V4 round 4 (ADR 0085 §3): page citations ADR 0084's step could NOT check,
   * although an `.aux` was found beside the PDF — it was older than the PDF,
   * or it counted a different number of pages, so it describes another build
   * and nothing in it was read. One entry per page-cited concern whose anchor
   * sits in a figure or table, by its final id. Recorded only then: a review
   * whose `.aux` is simply absent, or whose cites sit outside every float,
   * records nothing, because there was nothing this `.aux` could have
   * checked.
   */
  | {
      kind: "pages_unchecked";
      reviewer: string;
      reason: "aux_older_than_pdf" | "aux_other_build";
      entries: Array<{ id: string }>;
    }
  /**
   * V5 (ADR 0087 §1): strengths a reviewer filed that were NOT recorded — a
   * quote or an evidence that did not locate (`dropped`, with exactly
   * `anchors_dropped`'s reasons and `file` rules), or an entry that violated
   * the shape (`rejected`, with its 1-based index in the seat's `strengths`
   * array and the interpreter's model-facing English, never rendered
   * verbatim). One limit per reviewer, present only when something was lost.
   *
   * **Never a concern, and never counted as one:** a strength is not
   * "raised", so folding a lost one into `anchors_dropped` would make the
   * tab's *N concerns could not be anchored* sentence a false claim about
   * concerns. A host renders the count.
   */
  | {
      kind: "strengths_lost";
      reviewer: string;
      dropped: Array<{
        anchor: string;
        file?: string;
        role: "claim" | "evidence";
        reason: DropReason;
      }>;
      rejected: Array<{ index: number; reason: string }>;
    };

// ── The compiled PDF, as a review records it (V4, ADR 0081) ─────────────────

/** Where the reviewed PDF came from — the PDF policy's own vocabulary (ADR
 *  0080 §8). In the contracts since V4, because the record carries it. */
export type ReviewPdfSource =
  | "named"
  | "beside_entry"
  | "output_dir"
  | "compiled";

/**
 * The venue the host matched for the manuscript's entry, as a summary (V4,
 * ADR 0081). The host resolves it — the harness never reads a venue library —
 * and hands in only what the facts compare against. `VenueManifest` gains no
 * field: paper size stays undeclared (a recorded limit).
 */
export interface ReviewVenue {
  id: string;
  pageLimit?: VenuePageLimit;
  anonymity?: NonNullable<VenueManifest["anonymity"]>;
}

/**
 * What is DETERMINISTIC about the compiled paper, computed by the harness
 * before any model runs (V4, ADR 0081). Facts, not findings: nothing here
 * raises a concern, and a seat that files one about a fact anchors it at the
 * source line that causes it.
 */
export interface PdfFacts {
  pages: number;
  /** Page 1, in points. `name` only within ±2 pt of portrait A4 or Letter. */
  pageSize: { width: number; height: number; name?: "a4" | "letter" };
  /** 1-based page whose text holds a standalone references heading. */
  referencesStart?: number;
  /** `referencesStart − 1` when the heading is the page's first line, else
   *  `referencesStart` — the page that still holds prose above it counts. */
  mainTextPages?: number;
  /** The PDF's Author metadata, as authored — third-party text. */
  author?: string;
  /** From the compile log; absent when no log was available. */
  overfull?: { hboxes: number; vboxes: number };
  /** Per page, the smallest EFFECTIVE text size set with enough characters to
   *  count; pages with none omitted. No threshold, and nothing judged. */
  smallestText?: Array<{ page: number; sizePt: number }>;
  venue?: ReviewVenue;
}

/** The compiled PDF a review read, as its record keeps it (V4, ADR 0081). */
export interface ReviewPdfRecord {
  source: ReviewPdfSource;
  /** Root-relative, when the PDF was found rather than compiled. */
  path?: string;
  /** A named PDF older than the manuscript, used anyway (ADR 0080 §8). */
  stale?: true;
  facts: PdfFacts;
  /** The pages the PDF reviewer viewed, ascending — absent when no seat ran. */
  viewed?: number[];
}

/**
 * What a failed model request means for the retry policy — the harness's ONE
 * vocabulary for it (X5, ADR 0074 §6–§7).
 *
 *  - `retryable` — the same request may succeed later (transport blip,
 *    provider overload, a stream that died before its terminal event).
 *  - `quota` — the account is out of quota, credit or plan allowance. Retrying
 *    cannot fix it and the user has an action to take outside Lemmaria.
 *  - `fatal` — everything else: a malformed request, a bad key, an unknown
 *    failure. Report it and stop.
 *
 * Declared here rather than in the engine because it reaches the wire on both
 * `ReviewLimit` and `ReviewPreflight`; `session/stream-errors.ts`'s
 * `StreamFailureClass` is an alias of it, so the classifier and the record
 * cannot drift into two spellings of the same three cases.
 */
export type ModelFailureClass = "retryable" | "quota" | "fatal";

/**
 * The three budgets a user sets for a task — `lemmaria.budget.maxTurns`,
 * `maxToolCalls` and `maxTokens` (output) — named on a `seat_missing` limit
 * when a seat ran out of one before it finished its report (ADR 0082 §2).
 * A context window that fills is not one of them: no setting raises it.
 */
export type SeatBudget = "turns" | "tool_calls" | "output_tokens";

/** Why one model request failed: the harness's class, and the provider's own
 *  sentence where there was one. */
export interface ModelFailureCause {
  class: ModelFailureClass;
  /**
   * The provider's own words. **Third-party text, passing as authored** —
   * invariant 6 rule 2's boundary (ADR 0045 E1): Lemmaria does not translate,
   * segment or rewrite a sentence someone else wrote, it only labels whose it
   * is. A host that shows it shows it as the provider's, beside its own
   * localized sentence — never in place of one.
   */
  message?: string;
}

/**
 * What one seat's report came to, counted by the harness (X5, ADR 0074 §5).
 * Declared in the contracts, not the engine, because it reaches the wire on
 * `ReviewSeatState` — and the contracts never import from the engine.
 *
 * The identity **`entries === located + dropped + rejected + (setAside ?? 0)`**
 * holds by construction: an entry ends in exactly one of the four. `relocated`
 * is a subset of `located`, not a fifth outcome.
 */
export interface LedgerCounts {
  /** Wire entries considered, after the `MAX_ANNOTATIONS` slice. */
  entries: number;
  /** Annotations that survived — located, and recorded. */
  located: number;
  /** Of `located`: those where either anchor resolved OUTSIDE the file its
   *  search started in. The measure of what X5's locator bought. */
  relocated: number;
  /** Entries lost to a claim or evidence anchor that could not be located. */
  dropped: number;
  /** Entries lost to a shape violation (`entries_rejected`). */
  rejected: number;
  /** ADR 0083 §2: entries that located and were then set aside
   *  (`concerns_set_aside`, and since ADR 0085 §2 `furniture_set_aside` too —
   *  the sum of both). Present only when non-zero, so every ledger that sets
   *  nothing aside serializes exactly as before. */
  setAside?: number;
  /**
   * V5 (ADR 0087 §1): the seat's STRENGTHS, counted apart — the concern
   * identity above is unchanged and never sees one. Present only when the
   * ledger carried at least one strength entry, so every ledger without one
   * serializes exactly as before.
   *
   * `entries === located + dropped + rejected` holds by construction;
   * `relocated` is a subset of `located`, counted over strengths only, so the
   * concerns' `relocated` (and their relocated ids) never see a strength.
   */
  strengths?: {
    entries: number;
    located: number;
    relocated: number;
    dropped: number;
    rejected: number;
  };
}

/** One synthesis observation: a note ABOUT concerns, pointing at them by id and
 *  never restating them — the shape has no severity, anchor or message of its
 *  own, so a synthesis cannot edit what it summarises (ADR 0060 D7). */
export interface ReviewSynthesisEntry {
  ids: string[];
  note: string;
}

export interface ReviewSynthesis {
  consensus: ReviewSynthesisEntry[];
  disagreements: ReviewSynthesisEntry[];
}

/**
 * V5 (ADR 0087 §1): what a reviewer found done well — located exactly as a
 * concern is, by the same locator and the same drop rule, with no severity, no
 * blocking and no suggestion, so it can never enter the edit flow or the
 * verifier's brief. No verifier reads one (a recorded limit).
 */
export interface ReviewStrength {
  /** `"<reviewer>-s<n>"`, `n` 1-based and dense over the LOCATED strengths of
   *  that reviewer — its own namespace, so `setAsideConcerns`' re-stamping of
   *  concern ids never touches it. */
  id: string;
  reviewer: string;
  dimension: string;
  /** The passage praised — harness-located from the model's verbatim anchor. */
  span: ReviewSpan;
  message: string;
  /** Optional, and never `{kind: "missing"}`: a strength with nothing behind
   *  it leaves the field out. Required — as a paper — under `originality` and
   *  `positioning`; required — as a page — from the seat that views pages. */
  evidence?: Exclude<ReviewEvidence, { kind: "missing" }>;
}

/**
 * V5 (ADR 0087 §2): one reviewer's reading of one dimension it was asked to
 * assess. Shape-checked, recorded as written, and read by nothing that decides
 * a level.
 */
export interface ReviewAssessment {
  reviewer: string;
  dimension: string;
  /** An integer 1–10 as the reviewer wrote it, or `null`: none given, or not a
   *  whole number in range (named once in the re-ask, then recorded as it came
   *  back). Never second-guessed, and never an input to a level. */
  impression: number | null;
  /** The reviewer's own declaration that it could not assess this dimension,
   *  with its reason, as authored (third-party text, invariant 6 rule 1).
   *  Honoured by the derivation only where the reviewer's ledger holds nothing
   *  under the dimension (ADR 0087 §3). */
  notAssessed?: string;
}

export interface ReviewResult {
  annotations: ReviewAnnotation[];
  /** V5 (ADR 0087 §1): present only when NON-EMPTY, like `limits`. */
  strengths?: ReviewStrength[];
  /** V5 (ADR 0087 §2): one record per (seat, dimension that seat was asked to
   *  assess), present whenever a seat's ledger parsed in ledger mode. Absent on
   *  a quick action and on a review stored before V5. */
  assessments?: ReviewAssessment[];
  /** Present only when NON-EMPTY, so a result with everything located carries
   *  no key at all (ADR 0060 D6). */
  limits?: ReviewLimit[];
  /** Model-written, id-referenced, harness-checked (ADR 0060 D7). Produced by
   *  R3's panel driver; the single-model quick action omits it. */
  synthesis?: ReviewSynthesis;
}

// ── The scorecard (V5, ADR 0087) ─────────────────────────────────────────────
// DERIVED, never persisted: `deriveScorecard` computes these from a stored
// review (its result and its sibling rows) every time it is read, so a rule
// change re-derives every stored review. There is no number for the whole
// paper here and no acceptance prediction — the stage's principle, which the
// stage guard (`test/no-*.test.ts`) holds as a structural test over a derived
// card. Every word a host shows for these is its own, over the enum keys
// (invariant 6 rule 2): nothing below is prose.

/** 1 Blocking · 2 Major · 3 Minor · 4 Strong — the host's words, the harness's
 *  numbers, computed from located concerns and strengths (ADR 0087 §3). */
export type ScorecardLevel = 1 | 2 | 3 | 4;

/** How one dimension stands for one row — the panel's, or one seat's. */
export type ScorecardStanding =
  | {
      kind: "level";
      level: ScorecardLevel;
      /** A verifier completed AND looked at every concern the level rests on.
       *  Not ADR 0023's seat-level `unverified` — a different fact, and the
       *  name is chosen so the two cannot be confused. Level 4 is always
       *  `false`: no verifier reads a strength. */
      checked: boolean;
    }
  | { kind: "nothing_raised" }
  | {
      kind: "not_assessed";
      reason:
        | {
            kind: "declared";
            /** Each declaring reviewer's own sentence, as authored. */
            by: Array<{ reviewer: string; note: string }>;
          }
        | { kind: "no_literature" }
        /** V6's round 1 (ADR 0089 §7): the same zero answers, but the run's
         *  literature budget was spent before a source could answer — so the
         *  literature was never asked, not asked and silent. */
        | { kind: "literature_budget" }
        | { kind: "no_pdf" }
        | { kind: "no_reviewer" };
    };

/** One contributing seat's column in a dimension's row. */
export interface ScorecardSeat {
  reviewer: string;
  /** `""` when the record does not say (a row stored before R9). */
  model: string;
  /** Absent where the dimension is not that seat's to assess. */
  standing?: ScorecardStanding;
  /** That seat's recorded impression, or `null`. Drives nothing. */
  impression: number | null;
}

export interface ScorecardDimension {
  dimension: PanelDimension;
  standing: ScorecardStanding;
  /** Distinct issues (overlapping claim spans in one dimension are one), by
   *  their group's severity; `blocking` is a subset of `major`. */
  issues: { blocking: number; major: number; minor: number; info: number };
  strengths: number;
  /** Every contributing seat, in `seats` order then the PDF seat. */
  seats: ScorecardSeat[];
  /** The arithmetic median of the seats' non-null impressions, or `null`.
   *  Rides along; nothing reads it to decide anything. */
  impression: number | null;
}

/** The worst assessed level, as a word key the host localizes. */
export type Readiness =
  | "blocking"
  | "major"
  | "minor"
  | "none"
  | "not_assessed";

export interface Scorecard {
  /** `checked` is the conjunction over the assessed panel rows. */
  readiness: { label: Readiness; checked: boolean };
  /** How many panel rows are `not_assessed`. */
  notAssessed: number;
  /** Always eight, in `PANEL_DIMENSIONS` order. */
  dimensions: ScorecardDimension[];
  panel: {
    /** The contributing text reviewers, with their models. */
    reviewers: Array<{ reviewer: string; model: string }>;
    /** False only when the user switched verification off — the dial, not
     *  the outcome (a verification that ran and failed is on). */
    verificationOn: boolean;
    /** The contributing PDF seat's model, when one contributed. */
    pdf?: { model: string };
  };
}

/** Two cards compared per dimension, and only where comparable (ADR 0087 §5). */
export type ScorecardDelta = {
  dimensions: Array<
    | {
        dimension: PanelDimension;
        comparable: false;
        reason: "reviewers" | "verification" | "pdf" | "not_assessed";
      }
    | {
        dimension: PanelDimension;
        comparable: true;
        from: ScorecardStanding;
        to: ScorecardStanding;
        change: "improved" | "worsened" | "unchanged";
      }
  >;
};

// ── Migration report (post-MVP: Migrate to Venue) ────────────────────────────

export interface MigrationReport {
  sourceVenue: string;
  targetVenue: string;
  mapped: string[]; // fields/preamble swapped by rule
  needsManualAttention: string[]; // agent-flagged ambiguities for the user
  packagesAdded: string[];
  packagesRemoved: string[];
  unmappedCommands: string[]; // macros with no target equivalent
  anonymized: boolean;
  checkpointRef: string; // git ref taken before migration, for one-step undo
  /** The venue-engine compile the migration explicitly runs (step 6). `warnings`
   *  is every finding that compile reported — there is no baseline to be "new"
   *  against (ADR 0013). */
  compile: { ok: boolean; warnings: Warning[] };
}
