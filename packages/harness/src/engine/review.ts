/**
 * The `annotations` output interpretation for `kind: review` (ADR 0008, M9),
 * extended into a concern LEDGER by ADR 0060 (R2).
 *
 * Both entry points share one core. The model's answer is JSON
 * {"annotations": [{dimension, severity, anchor, message, suggestion?, file?,
 * evidence?, blocking?}]}. The HARNESS locates each anchor verbatim and exactly
 * once, computes file line numbers, and stamps the reviewer and the concern's
 * `id` — the model never supplies a position and never supplies identity.
 * Shape/enum violations are hard failures; unlocatable/ambiguous anchors drop
 * that annotation and are recorded in the result's honesty record.
 *
 * The two modes differ in exactly four places, all deliberate (ADR 0060 §2, as
 * widened by ADR 0074 §1 and §3):
 *
 *   | | quick action (`interpretAnnotations`) | ledger (`interpretLedger`) |
 *   | scope | within the reviewed unit | the WHOLE manuscript — a named file is
 *   |       |                          | where the search STARTS |
 *   | empty / all-dropped | hard failure (retry) | a valid result + a limit |
 *   | a malformed entry | fails the whole list (retry) | costs that entry |
 *   | `evidence` | optional | required |
 *
 * Review results are read-only: nothing here builds an EditProposal.
 */

import type {
  DropReason,
  LedgerCounts,
  ModelFailureCause,
  ReviewAnnotation,
  ReviewAssessment,
  ReviewEvidence,
  ReviewLimit,
  ReviewResult,
  ReviewSpan,
  ReviewStrength,
  ReviewSynthesis,
  ReviewSynthesisEntry,
  SeatBudget,
  SetAsideConcern,
} from "../contracts/data.js";
import { extractJsonPayload, locateAnchor } from "./anchored-edit.js";
import { type LiteratureResult, sameTitle } from "./literature.js";
import { normalizePath } from "./review-spans.js";

const SEVERITIES = ["info", "minor", "major"] as const;
type Severity = (typeof SEVERITIES)[number];

/** Hard ceiling on accepted annotations per run (defensive; review fix). */
export const MAX_ANNOTATIONS = 50;

/**
 * Dimensions a LEDGER may not raise without a paper behind them (V2, ADR 0078
 * §3).
 *
 * One entry, and deliberately one: `originality` is the claim *this already
 * exists*, which is a statement about a specific other work. `positioning`
 * stays open on purpose — it is where a reviewer files what it suspects and
 * could not find, and requiring a paper there would close the only honest
 * home for a hunch.
 */
const PAPER_REQUIRED_DIMENSIONS: readonly string[] = ["originality"];

/**
 * Dimensions a LEDGER may not raise without a page of the compiled PDF behind
 * them (V4, ADR 0081 §4) — the rule `PAPER_REQUIRED_DIMENSIONS` states for a
 * paper, one artefact over. `presentation` is what is wrong with the rendered
 * page; a seat that viewed none cannot claim it, by construction.
 */
export const PAGE_REQUIRED_DIMENSIONS: readonly string[] = ["presentation"];

/**
 * Dimensions a STRENGTH may not be filed under without a paper behind it (V5,
 * ADR 0087 §1): the closest work one of that reviewer's own searches
 * returned, which the strength says the manuscript goes beyond.
 *
 * Two entries where the concerns' list has one, and the asymmetry is the
 * design's: models praise novelty in a fifth to a third of their strengths
 * and question it in almost none, so the praise is where a check belongs. A
 * `positioning` CONCERN still needs no paper (ADR 0078 §3 stands).
 */
export const STRENGTH_PAPER_REQUIRED_DIMENSIONS: readonly string[] = [
  "originality",
  "positioning",
];

/**
 * The one consistency rule the re-ask carries (V5, ADR 0087 §2): an
 * impression of this or more, under a dimension where the same seat filed a
 * blocking major, is named once. Whatever comes back is recorded as written —
 * the harness does not second-guess an answer, it asks once.
 */
export const IMPRESSION_CONTRADICTION_FLOOR = 8;

/**
 * What the one re-ask says about a seat's impressions and declarations (V5,
 * ADR 0087 §2). **Not limits**: an impression drives nothing and a
 * declaration is an answer, so none of these reaches `result.limits` — they
 * travel on `LedgerOutcome.impressionProblems`, engine-internal like
 * `relocatedIds`, and reach `describeLedgerProblems` as its fourth argument.
 *
 * `dimensions` on the block-level kinds is what the seat is asked to assess,
 * so the line names exactly that — `"presentation"` for the PDF seat.
 */
export type ImpressionProblem =
  | { kind: "absent"; dimensions: readonly string[] }
  | { kind: "not_object"; dimensions: readonly string[] }
  | { kind: "malformed"; dimension: string }
  | { kind: "declarations_not_list" }
  | { kind: "declaration_malformed"; index: number }
  | { kind: "contradiction"; dimension: string; impression: number };

/** One anchor the harness could not turn into a position, with why. Feeds both
 *  the soft retry signal (`dropped`) and the result's honesty record (D6). */
type DroppedAnchor = {
  anchor: string;
  file?: string;
  role: "claim" | "evidence";
  reason: DropReason;
};

/** The honesty record for one reviewer's drops — omitted entirely when nothing
 *  dropped, so a clean result carries no `limits` key (ADR 0060 §5). */
function anchorsDroppedLimit(
  reviewer: string,
  dropped: DroppedAnchor[],
): ReviewLimit[] | undefined {
  if (dropped.length === 0) return undefined;
  return [{ kind: "anchors_dropped", reviewer, anchors: dropped }];
}

export interface AnnotationsInput {
  /** The model's final answer text. */
  answer: string;
  /** The reviewed span — anchors must locate here, uniquely. */
  unitText: string;
  /** Maps unit-relative offsets to file offsets. */
  unitStartOffset: number;
  /** Full file content, for line-number computation. */
  fileContent: string;
  file: string;
  /** Stamped by the engine (model.role ?? "writing") — never model-supplied. */
  reviewer: string;
  /** review_schema.dimensions; absent ⇒ any non-empty dimension. */
  allowedDimensions?: string[];
  /** review_schema.severity subset; absent ⇒ all three. */
  allowedSeverities?: Severity[];
  /** review_schema.suggest_edits — false strips suggestions, keeps annotations. */
  suggestEdits: boolean;
  /** Thaws frozen ⟦Pn⟧ tokens a model may have copied from the prompt into an
   *  anchor/suggestion, so location runs against the raw unit text (the engine
   *  passes thawText over the built context's tokens — ADR 0007 precedent). */
  thaw?: (text: string) => string;
}

export interface AnnotationsOutcome {
  /** Present when at least one annotation located. */
  result?: ReviewResult;
  /** Anchors that failed to locate (soft distance for the best-candidate gate). */
  dropped: string[];
  /** Hard failure: unparseable / bad shape / bad enum / all anchors dropped. */
  failure?: string;
}

export interface LedgerInput {
  /** The seat's report — its last agent message. */
  answer: string;
  /** The seat name; stamped, never model-supplied. */
  reviewer: string;
  /** Manuscript files the seat may cite: path → content. */
  files: ReadonlyMap<string, string>;
  /** Where a bare anchor locates; must be a key of `files`. */
  defaultFile: string;
  allowedDimensions?: string[];
  allowedSeverities?: Severity[];
  suggestEdits: boolean;
  /**
   * V2 (ADR 0078 §3): the results THIS seat's own literature searches
   * returned, in the order they were returned.
   *
   * **Absent means none** — deny-by-default, so a caller that forgot to read
   * the seat's items cannot record a paper it never checked. Per seat and
   * never pooled: a paper only another reviewer's search returned is not one
   * this reviewer was shown.
   */
  papers?: readonly LiteratureResult[];
  /**
   * V4 (ADR 0081 §4): the pages of the compiled PDF THIS seat viewed.
   *
   * **Absent means the seat cannot cite pages at all** — deny-by-default,
   * exactly `papers`' rule: a `{"page": N}` from such a seat is a shape
   * violation, and every model-facing sentence names three evidence forms, not
   * four. Present (even empty) puts the ledger in page mode. The driver hands
   * in the seat's LIVE set, so a check that fires mid-run reads what the seat
   * has viewed so far.
   */
  viewedPages?: ReadonlySet<number>;
  /**
   * V5 (ADR 0087 §2): the dimensions this seat is asked to ASSESS — one
   * `ReviewAssessment` each whenever the ledger parses. Defaults to
   * `allowedDimensions`; the PDF seat's ledger is read with all eight allowed
   * and assesses `presentation` alone, which is why the two are separate.
   * Neither set ⇒ nothing is assessed and no assessment is recorded.
   */
  assessedDimensions?: readonly string[];
  /**
   * V5 (ADR 0087 §2): this answer is a seat's reply to its one re-ask. A reply
   * with no `annotations` key but an `impressions` or `not_assessed` block
   * then reads as `"annotations": []` plus those blocks — the likeliest answer
   * to a re-ask that named only scalars, which would otherwise be lost as a
   * parse failure. A FIRST answer so shaped is still that failure, so the
   * driver passes this at exactly one call site: the settle's merge.
   */
  correction?: true;
}

export interface LedgerOutcome {
  /** Present unless the report violated the wire format's SHAPE. */
  result?: ReviewResult;
  /** Set for a shape violation — unparseable JSON, a non-object answer, a
   *  non-array `annotations`. Exactly one of the two is ever set. */
  failure?: string;
  /** X5 (ADR 0074 §5): what the report came to. Set whenever `result` is. */
  counts?: LedgerCounts;
  /** X5: the ids counted in `counts.relocated`. Engine-internal — the merge of
   *  a correction round needs it, and it never reaches a contract. */
  relocatedIds?: ReadonlySet<string>;
  /** V5: the STRENGTH ids counted in `counts.strengths.relocated` — kept
   *  apart from `relocatedIds`, which counts concerns only. Engine-internal. */
  strengthRelocatedIds?: ReadonlySet<string>;
  /** V5 (ADR 0087 §2): what the re-ask should say about the seat's scalars.
   *  Engine-internal; never a limit. Empty when there is nothing to say. */
  impressionProblems?: readonly ImpressionProblem[];
  /** V5: the assessed dimensions the reply's `impressions` block NAMED (a
   *  value of any kind, `null` included) — what a correction replaces. */
  impressionsNamed?: ReadonlySet<string>;
  /** V5: the assessed dimensions the reply's `not_assessed` block declared,
   *  validly — what a correction replaces. */
  declarationsNamed?: ReadonlySet<string>;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content[i] === "\n") line += 1;
  return line;
}

/** Turns one located offset into the span a result carries. */
function spanOf(
  content: string,
  file: string,
  offset: number,
  length: number,
): ReviewSpan {
  const line = lineOf(content, offset);
  const endLine = lineOf(content, offset + length);
  return { file, line, ...(endLine !== line ? { endLine } : {}) };
}

/**
 * Locates one anchor, or says why not.
 *
 * `relocated` is set when the anchor resolved OUTSIDE the file its search
 * started in — the ledger's manuscript-wide fallback (ADR 0074 §1). The quick
 * action's locator never sets it, so its outcome is byte-identical to what it
 * was before X5.
 */
export type Locator = (
  anchor: string,
  file: string | undefined,
) =>
  | { span: ReviewSpan; relocated?: true }
  | { error: DropReason; file?: string };

interface EntryContext {
  reviewer: string;
  allowedDimensions?: string[];
  severities: Severity[];
  suggestEdits: boolean;
  /** Ledger mode requires `evidence` on every concern; quick mode does not. */
  requireEvidence: boolean;
  /**
   * What a per-entry SHAPE violation costs (ADR 0074 §3).
   *
   *  - `"fail"` — the whole list fails, and the caller retries. The quick
   *    action's behaviour, unchanged: its feedback exists for exactly that.
   *  - `"reject"` — the entry is recorded and skipped, the rest survive. A
   *    ledger is ten independent findings from a minutes-long paid read, and
   *    the failure of one says nothing about the other nine.
   */
  onEntryViolation: "fail" | "reject";
  locate: Locator;
  thaw?: (text: string) => string;
  /**
   * V2 (ADR 0078 §3): resolve a cited title against this seat's recorded
   * results. **Its presence is what puts the entry reader in LEDGER mode for
   * a paper** — undefined (the quick action) and a `paper` object is simply an
   * evidence object with no `anchor`, which is the violation it always was.
   */
  resolvePaper?: (title: string) => LiteratureResult | undefined;
  /** V2 (ADR 0078 §3): dimensions whose concerns MUST cite a paper, compared
   *  case-insensitively. Set to `["originality"]` by a ledger; unset in quick
   *  mode, whose dimensions are its action's own. */
  paperRequiredFor?: readonly string[];
  /**
   * V4 (ADR 0081 §4): the pages this seat viewed. **Its presence is what puts
   * the entry reader in PAGE mode**, exactly as `resolvePaper` does for a
   * paper — undefined, and `{"page": N}` is an evidence object with no
   * `anchor`, the violation it always was.
   */
  viewedPages?: ReadonlySet<number>;
  /** V4: dimensions whose concerns MUST cite a page, case-insensitively. Set
   *  by a ledger; unset in quick mode. */
  pageRequiredFor?: readonly string[];
  /**
   * V5 (ADR 0087 §1): what kind of entry is being read. Absent is a concern —
   * every concern path, and the quick action's, is byte-identical to V4's.
   * A `"strength"` skips the severity, blocking and suggestion checks (those
   * keys are ignored, rule 13), never requires evidence and refuses
   * `"missing"`, and owes a paper under `STRENGTH_PAPER_REQUIRED_DIMENSIONS`
   * and — from a seat that views pages — a page under every dimension.
   */
  entry?: "strength";
}

interface EntriesOutcome {
  annotations: ReviewAnnotation[];
  dropped: DroppedAnchor[];
  /** Ids of the annotations for which EITHER anchor came back `relocated` —
   *  the ledger's manuscript-wide fallback found it outside the file its
   *  search started in (ADR 0074 §1). Empty for the quick action, whose
   *  locator never sets the flag. */
  relocatedIds: Set<string>;
  /** Entries lost to a shape violation under `onEntryViolation: "reject"` —
   *  always empty under `"fail"`, which sets `failure` instead. */
  rejected: RejectedEntry[];
  /** A SHAPE violation, under `onEntryViolation: "fail"` only. */
  failure?: string;
}

/** One wire entry the ledger refused, and why (ADR 0074 §3). */
type RejectedEntry = { index: number; reason: string };

/** The record for one reviewer's rejected entries — omitted when empty, the
 *  same by-exception rule `anchorsDroppedLimit` follows. */
function entriesRejectedLimit(
  reviewer: string,
  rejected: RejectedEntry[],
): ReviewLimit[] | undefined {
  if (rejected.length === 0) return undefined;
  return [{ kind: "entries_rejected", reviewer, entries: rejected }];
}

/** One wire entry, validated. What the loop needs after the fourteen checks. */
interface ReadEntry {
  dimension: string;
  /** Always set on a concern; a strength has none. */
  severity?: Severity;
  anchor: string;
  message: string;
  suggestion?: string;
  file?: string;
  blocking?: boolean;
  /** The model wrote the literal `"missing"` — it looked and found none. */
  evidenceMissing: boolean;
  evidenceQuote?: { anchor: string; file?: string };
  /** V2 (ADR 0078 §2): the model cited a paper, by the title it typed. The
   *  title is checked against the seat's results by the caller, not here. */
  evidencePaper?: { title: string };
  /** V4 (ADR 0081 §4): the model cited a page, a positive whole number. It is
   *  checked against the seat's viewed set by the caller, not here. */
  evidencePage?: number;
}

/**
 * The fourteen per-entry shape checks, as ONE pure function (ADR 0074 §3).
 *
 * Extracted from the loop so that what a violation COSTS is a single decision
 * at the call site — the whole list under `onEntryViolation: "fail"`, that
 * entry under `"reject"` — rather than fourteen places that would each have to
 * agree. Every check body and every message is unchanged from ADR 0060's: the
 * strings are model-facing feedback, and rewording them would silently reword
 * the quick action's retry advice too.
 */
function readEntry(
  item: unknown,
  ctx: EntryContext,
): ReadEntry | { violation: string } {
  const violation = (message: string): { violation: string } => ({
    violation: message,
  });
  // V5 (ADR 0087 §1): every branch below that reads this is a strength's
  // own; with it false, each check and each sentence is V4's, byte for byte.
  const isStrength = ctx.entry === "strength";
  const a = item as Record<string, unknown> | null;
  if (a === null || typeof a !== "object") {
    return violation(
      isStrength
        ? "each strength must be a JSON object"
        : "each annotation must be a JSON object",
    );
  }
  const {
    dimension,
    severity,
    anchor,
    message,
    suggestion,
    file,
    evidence,
    blocking,
  } = a;
  if (typeof dimension !== "string" || dimension.trim() === "") {
    return violation('"dimension" must be a non-empty string');
  }
  if (
    ctx.allowedDimensions !== undefined &&
    !ctx.allowedDimensions.some(
      (d) => d.toLowerCase() === dimension.toLowerCase(),
    )
  ) {
    return violation(
      `"${dimension}" is not an allowed dimension — use one of: ${ctx.allowedDimensions.join(", ")}`,
    );
  }
  if (
    !isStrength &&
    (typeof severity !== "string" ||
      !ctx.severities.includes(severity as Severity))
  ) {
    return violation(
      `"severity" must be one of: ${ctx.severities.join(", ")} (got ${JSON.stringify(severity)})`,
    );
  }
  if (typeof anchor !== "string" || anchor.length === 0) {
    return violation(
      '"anchor" must be a non-empty string copied VERBATIM from the reviewed text',
    );
  }
  if (typeof message !== "string" || message.trim() === "") {
    return violation('"message" must be a non-empty string');
  }
  if (
    !isStrength &&
    suggestion !== undefined &&
    typeof suggestion !== "string"
  ) {
    return violation(
      '"suggestion", when present, must be a string (the replacement for the anchor)',
    );
  }
  if (file !== undefined && (typeof file !== "string" || file.trim() === "")) {
    return violation(
      '"file", when present, must be a non-empty string naming a file of the manuscript',
    );
  }

  // `blocking` is orthogonal to severity, and the harness enforces the one
  // contradiction the protocol forbids — a Minor that blocks (ADR 0060 §4).
  if (!isStrength && blocking !== undefined && typeof blocking !== "boolean") {
    return violation('"blocking" must be true or false');
  }
  if (!isStrength && blocking !== undefined && severity !== "major") {
    return violation(
      `"blocking" may be set only on a "major" concern (this one is "${severity}") — raise the severity if the manuscript's central case fails without it, otherwise omit "blocking"`,
    );
  }

  // V2 (ADR 0078 §2): a ledger takes a third wire form. The two that exist are
  // UNCHANGED, byte for byte — they are model-facing, and every located rate
  // the stage has measured was measured against them.
  //
  // Hoisted above the absent-evidence check by V2's gate review (issue 4), so
  // that check can widen with it.
  const paperMode = ctx.resolvePaper !== undefined;
  // V4 (ADR 0081 §4): a page is a fourth form, open only to a seat that
  // viewed pages. Every sentence below is built from the forms THIS seat may
  // write (ADR 0079 §4's rule), so a text reviewer's wording is unchanged.
  const pageMode = ctx.viewedPages !== undefined;
  // V5 (ADR 0087 §1): the forms a STRENGTH's evidence may take, from this
  // seat — never "missing", and a page only from the seat that views pages.
  const strengthForms = pageMode
    ? 'a verbatim passage {"anchor": …}, a page you viewed {"page": N}, or a paper {"paper": {"title": …}}'
    : 'a verbatim passage {"anchor": …} or a paper {"paper": {"title": …}}';
  if (isStrength && evidence === "missing") {
    return violation(
      `a strength's "evidence" is ${strengthForms} — never "missing"; leave it out instead`,
    );
  }
  // `evidence` is the literal "missing" or a locatable quote (ADR 0060 §3).
  //
  // V2's gate review, issue 4: in paper mode this offered only *passage or
  // "missing"*, while the neighbouring non-object message below already named
  // all three forms. An `originality` seat corrected by the narrow sentence is
  // steered at `"missing"` — which the paper-required check then rejects, so
  // the one re-ask is spent telling the seat to do something forbidden.
  if (evidence === undefined && ctx.requireEvidence) {
    return violation(
      pageMode
        ? 'every concern needs "evidence" — a verbatim passage that supports or contradicts the claim, a page of the compiled PDF you viewed like {"page": 3}, a paper like {"paper": {"title": "exact title from your search"}}, or the literal "missing" when the manuscript offers none and no search returned the work'
        : paperMode
          ? 'every concern needs "evidence" — a verbatim passage that supports or contradicts the claim, a paper like {"paper": {"title": "exact title from your search"}}, or the literal "missing" when the manuscript offers none and no search returned the work'
          : 'every concern needs "evidence" — a verbatim passage that supports or contradicts the claim, or the literal "missing" when the manuscript offers none',
    );
  }
  let evidenceQuote: { anchor: string; file?: string } | undefined;
  let evidencePaper: { title: string } | undefined;
  let evidencePage: number | undefined;
  if (evidence !== undefined && evidence !== "missing") {
    const e = evidence as Record<string, unknown> | null;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      if (isStrength) {
        return violation(
          `a strength's "evidence", when present, is ${strengthForms}`,
        );
      }
      return violation(
        pageMode
          ? '"evidence" must be the literal "missing", an object like {"anchor": "verbatim passage"}, a page of the compiled PDF you viewed like {"page": 3}, or a paper like {"paper": {"title": "exact title from your search"}}'
          : paperMode
            ? '"evidence" must be the literal "missing", an object like {"anchor": "verbatim passage"}, or a paper like {"paper": {"title": "exact title from your search"}}'
            : '"evidence" must be the literal "missing" or an object like {"anchor": "verbatim passage"}',
      );
    }
    // V4 (ADR 0081 §4): a page, in page mode only. Checked BEFORE the paper
    // branch so `page` + `paper` is refused as two things, not read as a paper.
    if (pageMode && e.page !== undefined) {
      if (e.anchor !== undefined || e.paper !== undefined) {
        if (isStrength) {
          return violation(
            `a strength's "evidence" is ONE thing: ${strengthForms} — not two of them`,
          );
        }
        return violation(
          '"evidence" is ONE thing: a manuscript passage {"anchor": …}, a page you viewed {"page": N}, a paper {"paper": {"title": …}}, or the literal "missing" — not two of them',
        );
      }
      if (
        typeof e.page !== "number" ||
        !Number.isInteger(e.page) ||
        e.page < 1
      ) {
        return violation(
          '"evidence".page must be a positive whole number — a page of the compiled PDF you viewed',
        );
      }
      evidencePage = e.page;
    }
    if (evidencePage === undefined && paperMode && e.paper !== undefined) {
      if (e.anchor !== undefined) {
        if (isStrength) {
          return violation(
            `a strength's "evidence" is ONE thing: ${strengthForms} — not two of them`,
          );
        }
        return violation(
          '"evidence" is ONE thing: a manuscript passage {"anchor": …}, a paper {"paper": {"title": …}}, or the literal "missing" — not two of them',
        );
      }
      const paper = e.paper as Record<string, unknown> | null;
      if (
        paper === null ||
        typeof paper !== "object" ||
        Array.isArray(paper) ||
        typeof paper.title !== "string" ||
        paper.title.trim() === ""
      ) {
        return violation(
          '"evidence".paper needs a non-empty "title", copied exactly as one of your own searches returned it',
        );
      }
      evidencePaper = { title: paper.title };
    }
    if (evidencePaper === undefined && evidencePage === undefined) {
      if (typeof e.anchor !== "string" || e.anchor.length === 0) {
        return violation(
          isStrength
            ? '"evidence" needs a non-empty "anchor" copied VERBATIM from the manuscript (or leave "evidence" out)'
            : '"evidence" needs a non-empty "anchor" copied VERBATIM from the manuscript (or the literal "missing")',
        );
      }
      if (
        e.file !== undefined &&
        (typeof e.file !== "string" || e.file.trim() === "")
      ) {
        return violation(
          '"evidence".file, when present, must be a non-empty string naming a file of the manuscript',
        );
      }
      evidenceQuote = {
        anchor: e.anchor,
        ...(typeof e.file === "string" ? { file: e.file } : {}),
      };
    }
  }

  // V5 (ADR 0087 §1): a strength's own two rules, both rejections with a
  // sentence, because the seat can fix them. The concern rules below are not
  // read for a strength — a `positioning` concern still needs no paper.
  if (isStrength) {
    const praisesPriorWork = STRENGTH_PAPER_REQUIRED_DIMENSIONS.some(
      (d) => d.toLowerCase() === dimension.toLowerCase(),
    );
    // The seat that views pages owes a page under every dimension, and a
    // paper is ONE evidence — so from it, these two dimensions cannot be
    // filed at all. Said as that, rather than steering the one re-ask at a
    // paper the page rule would then refuse.
    if (praisesPriorWork && pageMode) {
      return violation(
        'a strength under "originality" or "positioning" needs a paper one of your own searches returned, and a strength you file needs a page you viewed — it cannot be both, so leave it out',
      );
    }
    if (praisesPriorWork && evidencePaper === undefined) {
      return violation(
        'a strength under "originality" or "positioning" must cite, as its evidence, a paper one of your own searches returned — {"paper": {"title": …}}, the closest work — and its message must say what this manuscript does beyond it. If no search returned one, leave the strength out',
      );
    }
    // ADR 0083 §2's reasoning at parse time: there is no display-only fold
    // for strengths, and a set-aside strength would be one nothing counts.
    if (pageMode && evidencePage === undefined) {
      return violation(
        'a strength you file must name the page on which what you praise is visible — {"page": N}, a page you viewed',
      );
    }
    return {
      dimension,
      anchor,
      message,
      ...(typeof file === "string" ? { file } : {}),
      evidenceMissing: false,
      ...(evidenceQuote !== undefined ? { evidenceQuote } : {}),
      ...(evidencePaper !== undefined ? { evidencePaper } : {}),
      ...(evidencePage !== undefined ? { evidencePage } : {}),
    };
  }

  // V2 (ADR 0078 §3): the dimensions that may not be raised on a hunch. A
  // rejection rather than a drop, because the seat CAN fix it — either by
  // citing a paper it was shown, or by filing under the dimension that exists
  // for exactly this case.
  if (
    ctx.paperRequiredFor?.some(
      (d) => d.toLowerCase() === dimension.toLowerCase(),
    ) === true &&
    evidencePaper === undefined
  ) {
    return violation(
      'an "originality" concern must cite, as its evidence, a paper one of your own searches returned — {"paper": {"title": …}}. If you suspect the work exists but no search returned it, file the concern under "positioning" with the manuscript passage that makes the claim',
    );
  }

  // V4 (ADR 0081 §4): the same rule, one artefact over — a rejection, because
  // the seat can fix it by citing a page it viewed or filing under `clarity`.
  if (
    ctx.pageRequiredFor?.some(
      (d) => d.toLowerCase() === dimension.toLowerCase(),
    ) === true &&
    evidencePage === undefined
  ) {
    return violation(
      'a "presentation" concern must carry, as its evidence, a page of the compiled PDF you viewed — {"page": N}. If what you see is in the source rather than on the rendered page, file the concern under "clarity" with the passage',
    );
  }

  return {
    dimension,
    severity: severity as Severity,
    anchor,
    message,
    ...(typeof suggestion === "string" ? { suggestion } : {}),
    ...(typeof file === "string" ? { file } : {}),
    ...(typeof blocking === "boolean" ? { blocking } : {}),
    evidenceMissing: evidence === "missing",
    ...(evidenceQuote !== undefined ? { evidenceQuote } : {}),
    ...(evidencePaper !== undefined ? { evidencePaper } : {}),
    ...(evidencePage !== undefined ? { evidencePage } : {}),
  };
}

/**
 * One entry's evidence, resolved — or the drop that ends the entry. Shared by
 * concerns and strengths (V5, ADR 0087 §1), so a strength is held to exactly
 * the concern's drop rule rather than a second copy of it.
 *
 * An evidence quote the harness cannot locate drops the WHOLE entry. It is
 * never coerced to "missing": *found none* and *quoted it wrong* are opposite
 * findings, and the second becoming the first would be the harness inventing
 * a location's absence (ADR 0060 §3).
 */
function resolveEvidence(
  read: ReadEntry,
  ctx: EntryContext,
  claimFile: string | undefined,
):
  | { evidence?: ReviewEvidence; relocated: boolean }
  | { dropped: DroppedAnchor } {
  if (read.evidenceMissing) {
    return { evidence: { kind: "missing" }, relocated: false };
  }
  if (read.evidencePage !== undefined) {
    // V4 (ADR 0081 §4): ADR 0060 §3's rule with a third cause. A page this
    // seat never viewed is not evidence, and the whole annotation goes —
    // the harness never manufactures a sighting. Membership is the whole
    // check, so a page in the set is stored as the number and nothing else.
    if (ctx.viewedPages?.has(read.evidencePage) !== true) {
      return {
        dropped: {
          // The number as the model wrote it; no `file`, because nothing was
          // searched for in the manuscript.
          anchor: `page ${read.evidencePage}`,
          role: "evidence",
          reason: "page_not_viewed",
        },
      };
    }
    return {
      evidence: { kind: "page", page: read.evidencePage },
      relocated: false,
    };
  }
  if (read.evidencePaper !== undefined) {
    // V2 (ADR 0078 §3): the same rule as an unlocatable quote, one domain
    // over. A paper no search of this seat's returned is not recorded, and
    // the whole annotation goes with it — the harness never manufactures a
    // citation any more than it manufactures a position.
    const found = ctx.resolvePaper?.(read.evidencePaper.title);
    if (found === undefined) {
      return {
        dropped: {
          // The title AS THE MODEL WROTE IT: that is what the feedback has to
          // name, because that is what the seat has to correct. No `file` —
          // nothing was searched for in the manuscript.
          anchor: read.evidencePaper.title,
          role: "evidence",
          reason: "not_in_results",
        },
      };
    }
    return {
      evidence: {
        kind: "paper",
        title: found.title,
        authors: found.authors,
        ...(found.year !== undefined ? { year: found.year } : {}),
        ...(found.venue !== undefined ? { venue: found.venue } : {}),
        ...(found.doi !== undefined ? { doi: found.doi } : {}),
        ...(found.url !== undefined ? { url: found.url } : {}),
        source: found.source,
      },
      relocated: false,
    };
  }
  if (read.evidenceQuote !== undefined) {
    const quote = ctx.thaw
      ? ctx.thaw(read.evidenceQuote.anchor)
      : read.evidenceQuote.anchor;
    const at = ctx.locate(quote, read.evidenceQuote.file ?? claimFile);
    if ("error" in at) {
      return {
        dropped: {
          anchor: quote,
          ...(at.file !== undefined ? { file: at.file } : {}),
          role: "evidence",
          reason: at.error,
        },
      };
    }
    return {
      evidence: { kind: "span", ...at.span },
      relocated: at.relocated === true,
    };
  }
  return { relocated: false };
}

/**
 * The shared core: validate, thaw, locate and stamp one wire list. Everything
 * that differs between a quick action and a ledger is in `ctx` — the locator,
 * whether evidence is required — so a rule can never mean two things in two
 * modes. Unknown keys are ignored (the five-then-eight known names are read by
 * name), which is what makes a model-supplied `id` harmless.
 */
function interpretEntries(
  rawList: unknown[],
  ctx: EntryContext,
): EntriesOutcome {
  const bad = (failure: string): EntriesOutcome => ({
    annotations: [],
    dropped: [],
    relocatedIds: new Set(),
    rejected: [],
    failure,
  });

  // Defensive cap: a flooding model must not overwhelm the host's panel; the
  // prompt asks for the few findings that matter most, so keep the head. The
  // cap counts ENTRIES, before location.
  const raw =
    rawList.length > MAX_ANNOTATIONS
      ? rawList.slice(0, MAX_ANNOTATIONS)
      : rawList;

  const annotations: ReviewAnnotation[] = [];
  const dropped: DroppedAnchor[] = [];
  const relocatedIds = new Set<string>();
  const rejected: RejectedEntry[] = [];
  for (const [position, item] of raw.entries()) {
    const read = readEntry(item, ctx);
    if ("violation" in read) {
      // The one branch the mode flag decides (ADR 0074 §3). `index` is the
      // entry's 1-based WIRE position, so a drop before it does not shift it.
      if (ctx.onEntryViolation === "fail") return bad(read.violation);
      rejected.push({ index: position + 1, reason: read.violation });
      continue;
    }
    const { dimension, severity, anchor, message, suggestion, file, blocking } =
      read;

    const anchorText = ctx.thaw ? ctx.thaw(anchor) : anchor;
    const suggestionText =
      typeof suggestion === "string" && ctx.thaw
        ? ctx.thaw(suggestion)
        : suggestion;
    const claimFile = typeof file === "string" ? file : undefined;
    const located = ctx.locate(anchorText, claimFile);
    if ("error" in located) {
      dropped.push({
        anchor: anchorText,
        ...(located.file !== undefined ? { file: located.file } : {}),
        role: "claim",
        reason: located.error,
      });
      continue;
    }

    const resolved = resolveEvidence(read, ctx, claimFile);
    if ("dropped" in resolved) {
      dropped.push(resolved.dropped);
      continue;
    }
    const evidenceValue = resolved.evidence;
    const evidenceRelocated = resolved.relocated;

    // Dense over the LOCATED annotations, so a drop consumes no number (§2).
    const id = `${ctx.reviewer}-${annotations.length + 1}`;
    // EITHER anchor resolving outside the file its search started in makes the
    // annotation a relocation — the concern arrived because of the fallback.
    if (located.relocated === true || evidenceRelocated) relocatedIds.add(id);

    annotations.push({
      id,
      reviewer: ctx.reviewer,
      dimension,
      severity: severity as Severity,
      span: located.span,
      message,
      ...(typeof blocking === "boolean" ? { blocking } : {}),
      ...(evidenceValue !== undefined ? { evidence: evidenceValue } : {}),
      ...(ctx.suggestEdits && typeof suggestionText === "string"
        ? {
            suggestedEdit: {
              original: anchorText,
              replacement: suggestionText,
            },
          }
        : {}),
    });
  }
  return { annotations, dropped, relocatedIds, rejected };
}

/** One seat's strengths, read (V5, ADR 0087 §1). Counted apart from its
 *  concerns, with its own relocated set and its own dense ids. */
interface StrengthsOutcome {
  strengths: ReviewStrength[];
  dropped: DroppedAnchor[];
  rejected: RejectedEntry[];
  relocatedIds: Set<string>;
  /** Wire entries considered, after the cap — a non-list block counts one. */
  entries: number;
}

/**
 * A ledger's `strengths` key, validated, located and stamped (V5, ADR 0087
 * §1). The SAME reader, locator and drop rule a concern goes through, in a
 * strength context; a malformed strength costs that strength, as a ledger's
 * malformed concern does. `undefined` (the key absent) is no strengths, and a
 * value that is not a list costs the block, recorded at index 0.
 */
function interpretStrengths(
  value: unknown,
  ctx: EntryContext,
): StrengthsOutcome {
  const out: StrengthsOutcome = {
    strengths: [],
    dropped: [],
    rejected: [],
    relocatedIds: new Set(),
    entries: 0,
  };
  if (value === undefined) return out;
  if (!Array.isArray(value)) {
    out.rejected.push({
      index: 0,
      reason:
        '"strengths" must be a list of entries — use [] or leave it out if you found nothing done well',
    });
    out.entries = 1;
    return out;
  }
  const raw =
    value.length > MAX_ANNOTATIONS ? value.slice(0, MAX_ANNOTATIONS) : value;
  out.entries = raw.length;
  // Evidence is optional for a strength: one with nothing behind it simply
  // leaves the field out.
  const strengthCtx: EntryContext = {
    ...ctx,
    entry: "strength",
    requireEvidence: false,
  };
  for (const [position, item] of raw.entries()) {
    const read = readEntry(item, strengthCtx);
    if ("violation" in read) {
      out.rejected.push({ index: position + 1, reason: read.violation });
      continue;
    }
    const anchorText = ctx.thaw ? ctx.thaw(read.anchor) : read.anchor;
    const claimFile = read.file;
    const located = ctx.locate(anchorText, claimFile);
    if ("error" in located) {
      out.dropped.push({
        anchor: anchorText,
        ...(located.file !== undefined ? { file: located.file } : {}),
        role: "claim",
        reason: located.error,
      });
      continue;
    }
    const resolved = resolveEvidence(read, strengthCtx, claimFile);
    if ("dropped" in resolved) {
      out.dropped.push(resolved.dropped);
      continue;
    }
    // Its own namespace, dense over the LOCATED strengths: `setAsideConcerns`
    // re-stamps concern ids and never reaches one of these.
    const id = `${ctx.reviewer}-s${out.strengths.length + 1}`;
    if (located.relocated === true || resolved.relocated) {
      out.relocatedIds.add(id);
    }
    // `readEntry` refuses "missing" for a strength, so the evidence here is a
    // passage, a paper or a page — or absent.
    const evidence = resolved.evidence as ReviewStrength["evidence"];
    out.strengths.push({
      id,
      reviewer: ctx.reviewer,
      dimension: read.dimension,
      span: located.span,
      message: read.message,
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }
  return out;
}

/** The record for one reviewer's lost strengths — omitted when nothing was
 *  lost, the by-exception rule every limit follows. */
function strengthsLostLimit(
  reviewer: string,
  out: StrengthsOutcome,
): ReviewLimit[] {
  if (out.dropped.length === 0 && out.rejected.length === 0) return [];
  return [
    {
      kind: "strengths_lost",
      reviewer,
      dropped: out.dropped,
      rejected: out.rejected,
    },
  ];
}

/** What a reply's two scalar blocks came to (V5, ADR 0087 §2). */
interface AssessmentsOutcome {
  assessments: ReviewAssessment[];
  problems: ImpressionProblem[];
  impressionsNamed: Set<string>;
  declarationsNamed: Set<string>;
}

/** An impression the harness keeps: a whole number from 1 to 10. */
function isImpression(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}

/**
 * The `impressions` and `not_assessed` blocks, shape-checked and nothing else
 * (V5, ADR 0087 §2). One `ReviewAssessment` per assessed dimension, in the
 * brief's order: an integer 1–10 is kept, anything else is `null`, and a key
 * naming a dimension the seat does not assess is ignored (rule 13). A
 * declaration's `reason` is kept as authored. **A declaration does not blank
 * the impression and rejects no entry**; whether it is honoured beside a
 * filed concern is the derivation's question, not this one's.
 */
function readAssessments(
  obj: Record<string, unknown>,
  reviewer: string,
  assessed: readonly string[],
): AssessmentsOutcome {
  const out: AssessmentsOutcome = {
    assessments: [],
    problems: [],
    impressionsNamed: new Set(),
    declarationsNamed: new Set(),
  };
  if (assessed.length === 0) return out;
  const canonical = (key: string): string | undefined =>
    assessed.find((d) => d.toLowerCase() === key.toLowerCase());

  const impressions = new Map<string, number | null>();
  const block = obj.impressions;
  if (block === undefined) {
    out.problems.push({ kind: "absent", dimensions: assessed });
  } else if (
    block === null ||
    typeof block !== "object" ||
    Array.isArray(block)
  ) {
    out.problems.push({ kind: "not_object", dimensions: assessed });
  } else {
    const malformed = new Set<string>();
    for (const [key, value] of Object.entries(block)) {
      const dimension = canonical(key);
      if (dimension === undefined || out.impressionsNamed.has(dimension)) {
        continue;
      }
      out.impressionsNamed.add(dimension);
      impressions.set(dimension, isImpression(value) ? value : null);
      // `null` is an answer (*I cannot form one*); anything else that is not
      // a whole number in range is a shape problem, named once.
      if (value !== null && !isImpression(value)) malformed.add(dimension);
    }
    // In the brief's order, so the re-ask reads in the order it asked.
    for (const dimension of assessed) {
      if (malformed.has(dimension)) {
        out.problems.push({ kind: "malformed", dimension });
      }
    }
  }

  const declared = new Map<string, string>();
  const declarations = obj.not_assessed;
  if (declarations !== undefined) {
    if (!Array.isArray(declarations)) {
      out.problems.push({ kind: "declarations_not_list" });
    } else {
      for (const [position, entry] of declarations.entries()) {
        const e = entry as Record<string, unknown> | null;
        if (
          e === null ||
          typeof e !== "object" ||
          Array.isArray(e) ||
          typeof e.dimension !== "string" ||
          typeof e.reason !== "string" ||
          e.reason.trim() === ""
        ) {
          out.problems.push({
            kind: "declaration_malformed",
            index: position + 1,
          });
          continue;
        }
        const dimension = canonical(e.dimension);
        // Not a dimension this seat assesses: ignored, as an unknown key is.
        if (dimension === undefined || declared.has(dimension)) continue;
        declared.set(dimension, e.reason);
        out.declarationsNamed.add(dimension);
      }
    }
  }

  for (const dimension of assessed) {
    const note = declared.get(dimension);
    out.assessments.push({
      reviewer,
      dimension,
      impression: impressions.get(dimension) ?? null,
      ...(note !== undefined ? { notAssessed: note } : {}),
    });
  }
  return out;
}

/**
 * The one consistency rule (V5, ADR 0087 §2): an impression at or above
 * `IMPRESSION_CONTRADICTION_FLOOR` under a dimension where this seat filed a
 * blocking major. One per dimension, read over what LOCATED — an entry that
 * dropped is already named by its own line.
 */
function contradictions(
  annotations: readonly ReviewAnnotation[],
  assessments: readonly ReviewAssessment[],
): ImpressionProblem[] {
  const found: ImpressionProblem[] = [];
  for (const a of assessments) {
    if (
      a.impression === null ||
      a.impression < IMPRESSION_CONTRADICTION_FLOOR
    ) {
      continue;
    }
    const blocks = annotations.some(
      (c) =>
        c.dimension.toLowerCase() === a.dimension.toLowerCase() &&
        c.severity === "major" &&
        c.blocking === true,
    );
    if (blocks) {
      found.push({
        kind: "contradiction",
        dimension: a.dimension,
        impression: a.impression,
      });
    }
  }
  return found;
}

/**
 * Pulls the `annotations` array out of a model answer, tolerating a fence or
 * surrounding prose exactly as ADR 0007's extractor does.
 *
 * BOTH failures are the caller's, because this is model-facing retry feedback
 * and the two modes owe the model different advice.
 *
 * `missingArray`: the quick action must still say *report at least one
 * finding* (ADR 0008 §1's quota, which ADR 0060 §1 narrows to it rather than
 * withdrawing), while telling a ledger seat the same thing would ask for the
 * quota the panel's protocol forbids.
 *
 * `notJson`: V2's gate review, issue 4. This sentence carries an EXAMPLE, and
 * a seat whose first answer did not parse has nothing else to copy. The
 * quick action's example is a quick action's — four keys, no `file` and no
 * `evidence` — and a ledger requires both. The 中文 run watched a paid seat
 * copy it and lose all nine of its concerns to `entries_rejected`, one round
 * later, with no third round to recover in. Our own feedback taught the
 * omission; each mode now shows the shape it actually accepts.
 */
function parseAnnotationsList(
  answer: string,
  failures: { notJson: string; missingArray: string },
  /** V5 (ADR 0087 §2): a correction may carry scalars alone — see
   *  `LedgerInput.correction`. Only a ledger's settle-time merge passes it. */
  correction = false,
): { list: unknown[]; obj: Record<string, unknown> } | { failure: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(answer));
  } catch {
    return { failure: failures.notJson };
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      failure: 'the answer must be a JSON object with an "annotations" key',
    };
  }
  if (
    correction &&
    obj.annotations === undefined &&
    (obj.impressions !== undefined || obj.not_assessed !== undefined)
  ) {
    return { list: [], obj };
  }
  if (!Array.isArray(obj.annotations))
    return { failure: failures.missingArray };
  return { list: obj.annotations, obj };
}

/** The quick action's parse-failure sentence, unchanged since ADR 0007 and
 *  kept byte-identical: every located rate the stage has measured was
 *  measured against this wording. */
const QUICK_NOT_JSON =
  'the answer must be pure JSON like {"annotations": [{"dimension": "...", "severity": "...", "anchor": "...", "message": "..."}]} — no prose, no commentary';

/**
 * A ledger's own parse-failure sentence (V2's gate review, issue 4).
 *
 * The example is what a seat copies, so it shows every field a ledger
 * requires — `file` and `evidence` included — and then names the three forms
 * `evidence` may take, because `interpretLedger` always passes a paper
 * resolver and all three are therefore always open to a seat.
 *
 * V5 (D13): the example grows by the three keys a ledger now carries —
 * `strengths`, `impressions` and `not_assessed` — because a seat that failed
 * to parse copies this shape, and one that copied V4's would then spend its
 * re-ask on the absent `impressions` block.
 */
const LEDGER_NOT_JSON =
  'the answer must be pure JSON like {"annotations": [{"dimension": "...", "severity": "...", "file": "...", "anchor": "verbatim passage the concern is about", "message": "...", "evidence": {"anchor": "verbatim passage that supports it"}}], "strengths": [{"dimension": "...", "file": "...", "anchor": "verbatim passage the strength is about", "message": "..."}], "impressions": {"<dimension>": 7}, "not_assessed": [{"dimension": "...", "reason": "..."}]} — no prose, no commentary. Every concern needs "evidence", and it is ONE of three things: a manuscript passage {"anchor": …}, a paper {"paper": {"title": "exact title from your search"}}, or the literal "missing"';

/** V4 (ADR 0081 §4): the same sentence for a seat that may cite pages — it
 *  names the fourth form, and nothing else changes. */
const LEDGER_NOT_JSON_WITH_PAGES =
  'the answer must be pure JSON like {"annotations": [{"dimension": "...", "severity": "...", "file": "...", "anchor": "verbatim passage the concern is about", "message": "...", "evidence": {"anchor": "verbatim passage that supports it"}}], "strengths": [{"dimension": "...", "file": "...", "anchor": "verbatim passage the strength is about", "message": "..."}], "impressions": {"<dimension>": 7}, "not_assessed": [{"dimension": "...", "reason": "..."}]} — no prose, no commentary. Every concern needs "evidence", and it is ONE of four things: a manuscript passage {"anchor": …}, a page of the compiled PDF you viewed {"page": N}, a paper {"paper": {"title": "exact title from your search"}}, or the literal "missing"';

export function interpretAnnotations(
  input: AnnotationsInput,
): AnnotationsOutcome {
  const failed = (failure: string): AnnotationsOutcome => ({
    dropped: [],
    failure,
  });

  // ADR 0008 §1's quota, kept for the quick action and narrowed to it: a
  // LEDGER may be empty, because a panel forbids quotas (ADR 0060 §1). Both a
  // missing/non-array key and an empty one get this same sentence, which is
  // what pre-R2 did — the wording is unchanged retry feedback.
  const QUOTA =
    '"annotations" must be a non-empty array — report at least one finding';
  const parsed = parseAnnotationsList(input.answer, {
    notJson: QUICK_NOT_JSON,
    missingArray: QUOTA,
  });
  if ("failure" in parsed) return failed(parsed.failure);
  if (parsed.list.length === 0) {
    return failed(QUOTA);
  }

  // Quick scope: within the reviewed unit, as ADR 0008 §2 has it. A wire `file`
  // naming the unit's own file is accepted; any other drops the entry, so a
  // review of a section still cannot annotate text outside it.
  const unitFile = normalizePath(input.file);
  const locate: Locator = (anchor, file) => {
    if (file !== undefined && normalizePath(file) !== unitFile) {
      return { error: "unknown_file", file };
    }
    const at = locateAnchor(input.unitText, anchor);
    if ("error" in at) return { error: at.error };
    return {
      span: spanOf(
        input.fileContent,
        input.file,
        input.unitStartOffset + at.offset,
        anchor.length,
      ),
    };
  };

  const out = interpretEntries(parsed.list, {
    reviewer: input.reviewer,
    ...(input.allowedDimensions !== undefined
      ? { allowedDimensions: input.allowedDimensions }
      : {}),
    severities: input.allowedSeverities ?? [...SEVERITIES],
    suggestEdits: input.suggestEdits,
    requireEvidence: false,
    // ADR 0008's behaviour, unchanged: a quick action retries, and its
    // feedback exists for exactly that (ADR 0074 §3).
    onEntryViolation: "fail",
    locate,
    ...(input.thaw !== undefined ? { thaw: input.thaw } : {}),
  });
  if (out.failure !== undefined) return failed(out.failure);

  const dropped = out.dropped.map((d) => d.anchor);
  if (out.annotations.length === 0) {
    return failed(
      `no anchor could be located in the reviewed text — copy each anchor VERBATIM and make it unique (failed: ${dropped
        .map((d) => JSON.stringify(d))
        .join(", ")})`,
    );
  }
  const limits = anchorsDroppedLimit(input.reviewer, out.dropped);
  return {
    result: {
      annotations: out.annotations,
      ...(limits !== undefined ? { limits } : {}),
    },
    dropped,
  };
}

/**
 * The ledger's locator, as a factory (V1, ADR 0076 §4): the closure X5 built
 * inside `interpretLedger` (ADR 0074 §1), moved verbatim so the panel's
 * verifier locates a counter-quote by the SAME rule a reviewer's quote is
 * located by — never a second copy of it.
 *
 * A search starts in the file the model named, else `defaultFile`; an
 * `ambiguous` hit in the start file stops there; otherwise the rest of the
 * manuscript is swept, and exactly one hit in exactly one file is required.
 */
export function manuscriptLocator(
  files: ReadonlyMap<string, string>,
  defaultFile: string,
): Locator {
  // A `defaultFile` outside `files` is a DRIVER bug, so it throws rather than
  // becoming a `failure` — the same call `assembleReview` makes on a duplicate
  // seat name, and for the same reason. `failure` is the model's channel: R3
  // may hand it back to a seat as retry feedback, and a seat cannot act on an
  // English sentence about the driver's own argument. Worse, `assembleReview`
  // would file it in the honesty record as `seat_missing / unparsed`, which
  // says *this reviewer failed to write a ledger* about a reviewer that did.
  if (!files.has(defaultFile)) {
    throw new Error(
      `interpretLedger: defaultFile ${JSON.stringify(defaultFile)} is not one of the manuscript files supplied (${[...files.keys()].map((k) => JSON.stringify(k)).join(", ")})`,
    );
  }

  // Ledger scope since X5 (ADR 0074 §1): the whole MANUSCRIPT, searched in one
  // fixed order. A named file is where the search STARTS, not where it ends.
  const byNormalized = new Map<string, string>();
  for (const key of files.keys()) byNormalized.set(normalizePath(key), key);
  const locate: Locator = (anchor, file) => {
    // Where the search starts: the file the model named, else the entry.
    // `undefined` = it named a file this manuscript does not have.
    let start: string | undefined = defaultFile;
    if (file !== undefined) start = byNormalized.get(normalizePath(file));
    if (start !== undefined) {
      const content = files.get(start) as string;
      const at = locateAnchor(content, anchor);
      if (!("error" in at)) {
        return { span: spanOf(content, start, at.offset, anchor.length) };
      }
      // Twice in the file the model pointed at is the MODEL's to lengthen:
      // naming a file is how a model disambiguates, so once it has done so,
      // nothing else is searched.
      if (at.error === "ambiguous") return { error: "ambiguous", file: start };
    }

    // Not where the search started (or there was nowhere to start): the whole
    // manuscript — exactly one occurrence, in exactly one file, byte-exact.
    // A quote unique in the corpus the seat was told it may cite supplies no
    // position: the model wrote the bytes, the harness found where they are.
    let hit: { path: string; offset: number } | undefined;
    for (const [path, content] of files) {
      if (path === start) continue;
      const at = locateAnchor(content, anchor);
      if ("error" in at) {
        // Twice inside any ONE file is already a guess; stop rather than let a
        // later file break the tie.
        if (at.error === "ambiguous") return { error: "ambiguous" };
        continue;
      }
      // A second file holding it is the basename fallback by another name —
      // and `file` stays absent, which is how the record says *manuscript-wide*.
      if (hit !== undefined) return { error: "ambiguous" };
      hit = { path, offset: at.offset };
    }
    if (hit === undefined) {
      return start === undefined
        ? { error: "unknown_file", file }
        : { error: "not_found", file: start };
    }
    const content = files.get(hit.path) as string;
    return {
      span: spanOf(content, hit.path, hit.offset, anchor.length),
      relocated: true,
    };
  };
  return locate;
}

/**
 * One panel seat's report, parsed and located over the WHOLE manuscript
 * (ADR 0060 §2). Three semantics differ from the quick action, each deliberate:
 * an empty ledger is valid (no quota), all-anchors-dropped is a result with an
 * `anchors_dropped` limit rather than a failure (the seat reviewed; nothing
 * located; the record says so), and there is no retry — a shape violation is a
 * `failure` string the driver acts on.
 */
export function interpretLedger(input: LedgerInput): LedgerOutcome {
  // Ledger scope since X5 (ADR 0074 §1): the whole MANUSCRIPT. The factory
  // throws on a `defaultFile` outside `files` — a driver bug, never a model's.
  const locate = manuscriptLocator(input.files, input.defaultFile);

  const parsed = parseAnnotationsList(
    input.answer,
    {
      // Deliberately NOT the quick action's example either (V2's gate review,
      // issue 4): a ledger requires `file` and `evidence`, and the sentence a
      // seat copies has to show them.
      notJson:
        input.viewedPages !== undefined
          ? LEDGER_NOT_JSON_WITH_PAGES
          : LEDGER_NOT_JSON,
      // Deliberately NOT the quick action's sentence: telling a seat to "report
      // at least one finding" asks for the quota the panel's protocol forbids.
      missingArray:
        '"annotations" must be an array — use [] if you found no grounded concern',
    },
    input.correction === true,
  );
  if ("failure" in parsed) return { failure: parsed.failure };

  const ctx: EntryContext = {
    reviewer: input.reviewer,
    ...(input.allowedDimensions !== undefined
      ? { allowedDimensions: input.allowedDimensions }
      : {}),
    severities: input.allowedSeverities ?? [...SEVERITIES],
    suggestEdits: input.suggestEdits,
    requireEvidence: true,
    // One malformed entry costs that entry, never the ledger (ADR 0074 §3).
    onEntryViolation: "reject",
    locate,
    // V2 (ADR 0078 §3). `papers` absent ⇒ an empty list, so the resolver
    // answers `undefined` for everything and every cited paper drops: the
    // deny-by-default the field's own doc block promises.
    resolvePaper: (title) =>
      (input.papers ?? []).find((r) => sameTitle(r.title, title)),
    paperRequiredFor: PAPER_REQUIRED_DIMENSIONS,
    // V4 (ADR 0081 §4): page mode only when the driver handed in a set —
    // `undefined` for every reviewer, so its wording is byte-identical.
    ...(input.viewedPages !== undefined
      ? { viewedPages: input.viewedPages }
      : {}),
    pageRequiredFor: PAGE_REQUIRED_DIMENSIONS,
  };
  const out = interpretEntries(parsed.list, ctx);
  if (out.failure !== undefined) return { failure: out.failure };

  // V5 (ADR 0087): the second entry kind, and the two scalar blocks. Both are
  // read only here — the quick action never passes them on.
  const strengths = interpretStrengths(parsed.obj.strengths, ctx);
  const scalars = readAssessments(
    parsed.obj,
    input.reviewer,
    input.assessedDimensions ?? input.allowedDimensions ?? [],
  );

  const limits = [
    ...(anchorsDroppedLimit(input.reviewer, out.dropped) ?? []),
    ...(entriesRejectedLimit(input.reviewer, out.rejected) ?? []),
    ...strengthsLostLimit(input.reviewer, strengths),
  ];
  return {
    result: {
      annotations: out.annotations,
      ...(strengths.strengths.length > 0
        ? { strengths: strengths.strengths }
        : {}),
      ...(scalars.assessments.length > 0
        ? { assessments: scalars.assessments }
        : {}),
      ...(limits.length > 0 ? { limits } : {}),
    },
    counts: {
      // `entries === located + dropped + rejected` holds by construction: an
      // entry ends in exactly one of the three (ADR 0074 §5).
      entries:
        out.annotations.length + out.dropped.length + out.rejected.length,
      located: out.annotations.length,
      relocated: out.relocatedIds.size,
      dropped: out.dropped.length,
      rejected: out.rejected.length,
      // Strengths are counted APART, and only when there was one to count.
      ...(strengths.entries > 0
        ? {
            strengths: {
              entries: strengths.entries,
              located: strengths.strengths.length,
              relocated: strengths.relocatedIds.size,
              dropped: strengths.dropped.length,
              rejected: strengths.rejected.length,
            },
          }
        : {}),
    },
    relocatedIds: out.relocatedIds,
    strengthRelocatedIds: strengths.relocatedIds,
    impressionProblems: [
      ...scalars.problems,
      ...contradictions(out.annotations, scalars.assessments),
    ],
    impressionsNamed: scalars.impressionsNamed,
    declarationsNamed: scalars.declarationsNamed,
  };
}

/** How much of a quote the feedback repeats before cutting it. Long enough to
 *  identify the passage, short enough that ten of them stay readable. */
const FEEDBACK_QUOTE_CHARS = 80;

function quoteForFeedback(anchor: string): string {
  return anchor.length > FEEDBACK_QUOTE_CHARS
    ? `${anchor.slice(0, FEEDBACK_QUOTE_CHARS)}…`
    : anchor;
}

/**
 * One unlocated quote, as the re-ask names it. A concern's sentences are X5's,
 * V2's and V4's, byte for byte; a strength's (V5, ADR 0087 §2) are the same
 * four with the entry named, so the seat corrects the right list.
 */
function dropLine(
  dropped: {
    anchor: string;
    file?: string;
    role: "claim" | "evidence";
    reason: DropReason;
  },
  viewedPages: ReadonlySet<number> | undefined,
  of: "concern" | "strength",
): string {
  const strength = of === "strength";
  const what =
    dropped.role === "evidence"
      ? strength
        ? "the strength's evidence quote"
        : "the evidence quote"
      : strength
        ? "the strength's quote"
        : "the quote";
  const quote = `"${quoteForFeedback(dropped.anchor)}"`;
  if (dropped.reason === "not_found") {
    return `- ${what} ${quote} was not found in \`${dropped.file}\` or in any other file of the manuscript.`;
  }
  if (dropped.reason === "ambiguous") {
    return dropped.file === undefined
      ? `- ${what} ${quote} is not in the file you named and appears in more than one other file of the manuscript.`
      : `- ${what} ${quote} appears more than once in \`${dropped.file}\`.`;
  }
  if (dropped.reason === "page_not_viewed") {
    // V4 (ADR 0081 §3): its own branch, before the `else`, for V2's
    // reason — there is no file to name. The anchor is "page N".
    return `- ${strength ? "for a strength, " : ""}you cited ${dropped.anchor} as evidence but viewed ${describeViewedPages(viewedPages)}; view it, or cite a page you viewed.`;
  }
  if (dropped.reason === "not_in_results") {
    // V2 (ADR 0078 §3): its OWN branch, BEFORE the `else`. Falling
    // through would have told the seat its paper "names `undefined`,
    // which is not a file of this manuscript" — a sentence about the
    // wrong thing entirely, and the reason this case is not folded in.
    return `- ${strength ? "the strength's paper" : "the paper"} ${quote} is not among the results your own literature searches returned.`;
  }
  return `- ${what} ${quote} names \`${dropped.file}\`, which is not a file of this manuscript, and was not found in any file that is.`;
}

/** One scalar problem, as the re-ask names it (V5, ADR 0087 §2). */
function impressionLine(problem: ImpressionProblem): string {
  switch (problem.kind) {
    case "absent":
    case "not_object": {
      // What the seat is asked to assess, by name when it is one dimension —
      // the PDF seat is asked for `presentation` and nothing else.
      const which =
        problem.dimensions.length === 1
          ? `"${problem.dimensions[0]}"`
          : "each dimension your brief lists";
      return problem.kind === "absent"
        ? `- your reply carries no "impressions" block; send one, with an integer 1–10 or null for ${which}`
        : `- your "impressions" block is not an object keyed by dimension; send one, with an integer 1–10 or null for ${which}`;
    }
    case "malformed":
      return `- your impression of "${problem.dimension}" is not a whole number from 1 to 10; send it as one, or as null`;
    case "declarations_not_list":
      return '- your "not_assessed" block is not a list of {"dimension": "...", "reason": "..."}; send it as one, or leave it out';
    case "declaration_malformed":
      return `- entry ${problem.index} of your "not_assessed" block is not {"dimension": "...", "reason": "one sentence why"}; send it in that shape, or leave it out`;
    case "contradiction":
      // The concern is already recorded and a re-sent one is skipped, so the
      // seat is asked for the one value a correction can still change.
      return `- your impression of "${problem.dimension}" is ${problem.impression}, and you filed a blocking major under "${problem.dimension}". If both are as you meant them, send the impression again unchanged; otherwise send the one you now mean.`;
  }
}

/** The lead-in when an entry could not be recorded — X5's, unchanged. */
const LEAD_ENTRIES =
  "Some entries of your ledger could not be recorded. Each is listed with its reason.";

/** V5: the lead-in when every entry was recorded and only scalars are named —
 *  it must not claim a failed entry that does not exist. */
const LEAD_SCALARS =
  "Every entry of your ledger was recorded. Before it is final:";

/** X5's closing, unchanged: every located rate the stage recorded was
 *  measured against these bytes. */
const CLOSING_ENTRIES =
  "Reply once with one JSON ledger that holds ONLY your corrections to the entries listed above, each one complete. For a quote, open the file again and copy the passage exactly as it appears, from a single line — never describe it and never retype it from memory — and name the `file` you copied it from. Leave out any entry you withdraw. Every entry not listed above is already recorded: do not send it again. This is the only correction round.";

/** V5: appended — never spliced — to X5's closing when scalars are named too. */
const CLOSING_SCALAR_CLAUSE =
  ' For an impression or a declaration, send the "impressions" or "not_assessed" block again with the values you now mean; a dimension you leave out keeps the value already recorded.';

/** V5: the closing when only scalars are named — a string of its own, because
 *  X5's asks for corrections to entries and tells the seat to reopen a file. */
const CLOSING_SCALARS =
  'Reply once with one JSON ledger: "annotations": [] and the "impressions" or "not_assessed" block with the values you now mean. Every entry is already recorded: do not send it again. This is the only correction round.';

/**
 * The one re-ask's feedback: every rejected entry and every unlocated quote,
 * in one message, asking for CORRECTIONS ONLY (ADR 0074 §5).
 *
 * Built from that seat's own `entries_rejected` and `anchors_dropped` limits
 * and nothing else, so ADR 0061 §6 still holds — the feedback is the
 * interpreter's own English, never a second phrasing of the same rules. One
 * message carrying every problem is Pi's `validateToolArguments` shape (MIT;
 * the idea, not the text).
 *
 * V5 (ADR 0087 §2): after the concern lines, one line per lost strength (from
 * the seat's `strengths_lost`) and one per scalar problem — which is not a
 * limit, and arrives as the fourth argument. **Byte-identical to V4's for a
 * ledger with none of those**: the lead-in and closing change only when a
 * scalar is named, and only as two strings of their own or one appended
 * clause. It is still once: this adds lines to the message that is already
 * going, never a second round.
 *
 * `undefined` when there is nothing to say, which is how the driver decides
 * whether to spend the re-ask at all.
 */
export function describeLedgerProblems(
  result: ReviewResult,
  reviewer: string,
  /** V4 (ADR 0081 §3): the pages this seat viewed — what a `page_not_viewed`
   *  drop's feedback names as the pages it may cite. */
  viewedPages?: ReadonlySet<number>,
  /** V5 (ADR 0087 §2): the seat's impression problems, from
   *  `LedgerOutcome.impressionProblems`. Absent ⇒ none. */
  impressionProblems: readonly ImpressionProblem[] = [],
): string | undefined {
  const lines: string[] = [];
  /** V2: at least one cited paper was not in this seat's own results. */
  let papersDropped = false;
  /** V5: the same, for a strength's paper. */
  let strengthPapersDropped = false;
  for (const limit of result.limits ?? []) {
    if (limit.kind === "entries_rejected" && limit.reviewer === reviewer) {
      for (const entry of limit.entries) {
        lines.push(`- entry ${entry.index}: ${entry.reason}`);
      }
    }
  }
  for (const limit of result.limits ?? []) {
    if (limit.kind !== "anchors_dropped" || limit.reviewer !== reviewer) {
      continue;
    }
    for (const dropped of limit.anchors) {
      if (dropped.reason === "not_in_results") papersDropped = true;
      lines.push(dropLine(dropped, viewedPages, "concern"));
    }
  }
  for (const limit of result.limits ?? []) {
    if (limit.kind !== "strengths_lost" || limit.reviewer !== reviewer) {
      continue;
    }
    for (const entry of limit.rejected) {
      // Index 0 is the block itself — a `strengths` value that was not a list.
      lines.push(
        entry.index === 0
          ? `- "strengths": ${entry.reason}`
          : `- strength ${entry.index}: ${entry.reason}`,
      );
    }
    for (const dropped of limit.dropped) {
      if (dropped.reason === "not_in_results") strengthPapersDropped = true;
      lines.push(dropLine(dropped, viewedPages, "strength"));
    }
  }
  const scalarLines = impressionProblems.map(impressionLine);
  if (lines.length === 0 && scalarLines.length === 0) return undefined;
  if (lines.length === 0) {
    return [LEAD_SCALARS, "", ...scalarLines, "", CLOSING_SCALARS].join("\n");
  }
  return [
    LEAD_ENTRIES,
    "",
    ...lines,
    ...scalarLines,
    "",
    // V2: added ONLY when a paper actually dropped, so a ledger that cited
    // none gets feedback byte-identical to X5's — which is what every located
    // rate the stage has recorded was measured against.
    ...(papersDropped
      ? [
          "For a paper, cite it only by a title exactly as one of your searches showed it; you may search again before you reply, and if no search returns it, file the concern without it.",
        ]
      : []),
    ...(strengthPapersDropped
      ? [
          "For a strength's paper, cite it only by a title exactly as one of your searches showed it; if no search returns it, leave the strength out.",
        ]
      : []),
    scalarLines.length > 0
      ? CLOSING_ENTRIES + CLOSING_SCALAR_CLAUSE
      : CLOSING_ENTRIES,
  ].join("\n");
}

/** A viewed set as the re-ask names it: `pages 1–3, 5`, or `no page`. */
function describeViewedPages(viewed: ReadonlySet<number> | undefined): string {
  const pages = [...(viewed ?? [])].sort((a, b) => a - b);
  if (pages.length === 0) return "no page";
  const runs: string[] = [];
  let start = pages[0] as number;
  let prev = start;
  for (const page of [...pages.slice(1), Number.NaN]) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = page;
    prev = page;
  }
  return `${pages.length === 1 ? "page" : "pages"} ${runs.join(", ")}`;
}

/** A `LedgerOutcome` whose `result` is set, narrowed — what the driver holds
 *  between a seat's first answer and its correction. */
export interface ParsedLedger {
  result: ReviewResult;
  counts: LedgerCounts;
  relocatedIds: ReadonlySet<string>;
}

/**
 * The correction round, merged (ADR 0074 §5). Pure.
 *
 * **What located the first time is frozen.** The first pass's annotations are
 * kept in order with their ids unchanged, and only genuinely new entries are
 * appended. That is what makes the panel never worse off for having asked: the
 * likeliest reply to *"these two entries failed"* is those two entries, and a
 * replace rule would delete every concern that had located.
 *
 * One accepted inaccuracy: a model that re-sends its whole ledger AND
 * mis-copies an entry that had located leaves that entry kept (step 1) and
 * recorded as a second-pass drop. The record over-reports a loss; it never
 * under-reports one.
 */
export function mergeLedgerCorrection(
  first: ParsedLedger,
  second: LedgerOutcome,
): ParsedLedger {
  // An unreadable correction costs nothing but the correction: the first pass
  // stands whole, limits and counts included.
  if (second.result === undefined || second.counts === undefined) return first;

  const kept = first.result.annotations;
  // A re-sent entry is one the first pass already recorded at the same
  // position, in the same dimension — which is what makes a model that
  // re-emits its whole ledger harmless rather than duplicating it.
  const keyOf = (a: { span: ReviewSpan; dimension: string }): string =>
    [a.span.file, a.span.line, a.span.endLine ?? "", a.dimension].join("\0");
  const seen = new Set(kept.map(keyOf));

  const appended: ReviewAnnotation[] = [];
  const relocated = new Set(first.relocatedIds);
  for (const a of second.result.annotations) {
    if (seen.has(keyOf(a))) continue;
    const id = `${a.reviewer}-${kept.length + appended.length + 1}`;
    // The SECOND pass's id is what `second.relocatedIds` is keyed by; the
    // merged set is keyed by the id the annotation ends up carrying.
    if (second.relocatedIds?.has(a.id) === true) relocated.add(id);
    appended.push({ ...a, id });
  }

  const annotations = [...kept, ...appended];

  // V5 (ADR 0087 §2): strengths merge by the same rule, under a key set of
  // their OWN — a concern and a strength on one span are two entries, never a
  // re-send of each other (ADR 0074 §5's rule 3 is per list). What located
  // the first time is frozen here too, so the first pass's relocated count
  // carries over and only the appended strengths add to it.
  const keptStrengths = first.result.strengths ?? [];
  const seenStrengths = new Set(keptStrengths.map(keyOf));
  const appendedStrengths: ReviewStrength[] = [];
  let appendedRelocated = 0;
  for (const s of second.result.strengths ?? []) {
    if (seenStrengths.has(keyOf(s))) continue;
    const id = `${s.reviewer}-s${keptStrengths.length + appendedStrengths.length + 1}`;
    if (second.strengthRelocatedIds?.has(s.id) === true) appendedRelocated += 1;
    appendedStrengths.push({ ...s, id });
  }
  const strengths = [...keptStrengths, ...appendedStrengths];
  const firstS = first.counts.strengths;
  const secondS = second.counts.strengths;

  // V5: scalars REPLACE, per dimension the correction named — `null`
  // included — and a dimension it left out keeps the first pass's value.
  // A declaration likewise, per dimension its `not_assessed` block declared.
  const secondBy = new Map(
    (second.result.assessments ?? []).map((a) => [a.dimension, a]),
  );
  const assessments =
    first.result.assessments?.map((a) => {
      const next = secondBy.get(a.dimension);
      let merged: ReviewAssessment = a;
      if (second.impressionsNamed?.has(a.dimension) === true) {
        merged = { ...merged, impression: next?.impression ?? null };
      }
      if (second.declarationsNamed?.has(a.dimension) === true) {
        const { notAssessed: _old, ...without } = merged;
        merged =
          next?.notAssessed !== undefined
            ? { ...without, notAssessed: next.notAssessed }
            : without;
      }
      return merged;
    }) ?? second.result.assessments;

  // The merged limits are the SECOND pass's: the first pass's failures were
  // answered — corrected, failed again (then they are in the second pass's),
  // or withdrawn.
  const limits = second.result.limits;
  // `limits` is absent, not undefined, when there is nothing to record —
  // `ReviewResult`'s own rule (ADR 0060 §5), which a spread of the first pass
  // would otherwise carry through with a stale value. Strengths and
  // assessments are rebuilt the same way.
  const {
    limits: _firstLimits,
    strengths: _firstStrengths,
    assessments: _firstAssessments,
    ...rest
  } = first.result;
  return {
    result: {
      ...rest,
      annotations,
      ...(strengths.length > 0 ? { strengths } : {}),
      ...(assessments !== undefined && assessments.length > 0
        ? { assessments }
        : {}),
      ...(limits !== undefined && limits.length > 0 ? { limits } : {}),
    },
    counts: {
      // A withdrawn entry leaves `entries`, so a located rate that rose by
      // withdrawal is never mistaken for one that rose by correction.
      entries:
        annotations.length + second.counts.dropped + second.counts.rejected,
      located: annotations.length,
      relocated: relocated.size,
      dropped: second.counts.dropped,
      rejected: second.counts.rejected,
      // Strengths follow the second pass's drops and rejections the way the
      // concerns do, and are present when either pass counted one.
      ...(firstS !== undefined || secondS !== undefined
        ? {
            strengths: {
              entries:
                strengths.length +
                (secondS?.dropped ?? 0) +
                (secondS?.rejected ?? 0),
              located: strengths.length,
              relocated: (firstS?.relocated ?? 0) + appendedRelocated,
              dropped: secondS?.dropped ?? 0,
              rejected: secondS?.rejected ?? 0,
            },
          }
        : {}),
    },
    relocatedIds: relocated,
  };
}

/**
 * The panel's synthesis: model-written, id-referenced, harness-checked
 * (ADR 0060 §6). The shape has no severity, anchor or message of its own, so a
 * synthesis structurally cannot restate a concern — only point at one. Empty
 * arrays are valid: no quota, again.
 */
export function interpretSynthesis(input: {
  answer: string;
  annotations: readonly ReviewAnnotation[];
}): { synthesis?: ReviewSynthesis; failure?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(input.answer));
  } catch {
    return {
      failure:
        'the synthesis must be pure JSON like {"consensus": [{"ids": ["seat-1", "other-2"], "note": "..."}], "disagreements": []} — no prose, no commentary',
    };
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      failure:
        'the synthesis must be a JSON object with "consensus" and "disagreements" keys',
    };
  }

  const byId = new Map(input.annotations.map((a) => [a.id, a]));
  const readSide = (
    key: "consensus" | "disagreements",
  ): { entries: ReviewSynthesisEntry[] } | { failure: string } => {
    const value = obj[key];
    if (!Array.isArray(value)) {
      return { failure: `"${key}" must be an array (it may be empty)` };
    }
    const entries: ReviewSynthesisEntry[] = [];
    for (const item of value) {
      const e = item as Record<string, unknown> | null;
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        return { failure: `each "${key}" entry must be a JSON object` };
      }
      if (
        !Array.isArray(e.ids) ||
        e.ids.length === 0 ||
        e.ids.some((id) => typeof id !== "string")
      ) {
        return {
          failure: `each "${key}" entry needs a non-empty "ids" array of concern ids`,
        };
      }
      const ids = e.ids as string[];
      const reviewers = new Set<string>();
      for (const id of ids) {
        const annotation = byId.get(id);
        if (annotation === undefined) {
          return {
            failure: `"${id}" is not a concern in this review — cite only the ids the ledgers carry`,
          };
        }
        reviewers.add(annotation.reviewer);
      }
      // A consensus of one seat is not consensus, and a disagreement needs two
      // parties: either way an entry that cites one reviewer is not an
      // observation ABOUT the panel (ADR 0060 §6).
      if (reviewers.size < 2) {
        return {
          failure: `each "${key}" entry must cite at least two different reviewers (${JSON.stringify(ids)} cites only ${JSON.stringify([...reviewers][0])})`,
        };
      }
      if (typeof e.note !== "string" || e.note.trim() === "") {
        return { failure: `each "${key}" entry needs a non-empty "note"` };
      }
      entries.push({ ids, note: e.note });
    }
    return { entries };
  };

  const consensus = readSide("consensus");
  if ("failure" in consensus) return { failure: consensus.failure };
  const disagreements = readSide("disagreements");
  if ("failure" in disagreements) return { failure: disagreements.failure };
  return {
    synthesis: {
      consensus: consensus.entries,
      disagreements: disagreements.entries,
    },
  };
}

/** One seat's contribution to a panel: its parsed ledger, or the fact that the
 *  seat never reported (ADR 0060 §7). */
export type SeatOutcome =
  | {
      reviewer: string;
      ledger: LedgerOutcome;
      /** ADR 0082 §2: the budget the seat stopped on, when its ledger then
       *  failed — carried onto the `seat_missing` limit, never onto a ledger
       *  that parsed. */
      ranOutOf?: SeatBudget;
    }
  | {
      reviewer: string;
      missing: "failed" | "interrupted";
      /** X5 (ADR 0074 §7): why, on `"failed"` — the class the child's own
       *  retry policy chose, and the provider's own words. An `interrupted`
       *  seat was stopped by the user and carries none. */
      cause?: ModelFailureCause;
    };

/** ADR 0086: what a set-aside concern said, for its record — display-only,
 *  so nothing the reader cannot see is kept (no suggested edit, no evidence
 *  beyond the page). Absent stays absent, as on the annotation. */
function asideConcern(a: ReviewAnnotation): SetAsideConcern {
  return {
    severity: a.severity,
    ...(a.blocking === true ? { blocking: true as const } : {}),
    message: a.message,
    span: { file: a.span.file, line: a.span.line },
    ...(a.evidence?.kind === "page" ? { page: a.evidence.page } : {}),
  };
}

/**
 * A SETTLED ledger with the concerns `setAside` matches taken out of it (ADR
 * 0083 §2). Pure.
 *
 * Run after the ledger is final — its correction merged — and before anything
 * downstream reads its ids, so the rest can be re-stamped densely and the
 * contract's *dense over the located annotations* holds. It is not a
 * rejection: no feedback, no re-ask, and so no output tokens spent persuading
 * a seat to keep what is about to be set aside. What went is recorded, as a
 * count and a `concerns_set_aside` limit, never silently — and since ADR 0086
 * with what each concern said, so the reader can check the rule.
 *
 * Returns the ledger ITSELF when nothing matches, so a seat with nothing set
 * aside serializes exactly as before.
 *
 * `kind` names the rule, and so the limit (ADR 0085 §2): the argument's
 * (ADR 0083 §2), or review-mode furniture's. The two can both run on one
 * ledger, so the count ADDS to one already there rather than replacing it.
 */
export function setAsideConcerns(
  ledger: ParsedLedger,
  setAside: (annotation: ReviewAnnotation) => boolean,
  kind: "concerns_set_aside" | "furniture_set_aside" = "concerns_set_aside",
): ParsedLedger {
  const aside = ledger.result.annotations.filter(setAside);
  const first = aside[0];
  if (first === undefined) return ledger;

  const relocated = new Set<string>();
  const annotations = ledger.result.annotations
    .filter((a) => !setAside(a))
    .map((a, i) => {
      const id = `${a.reviewer}-${i + 1}`;
      if (ledger.relocatedIds.has(a.id)) relocated.add(id);
      return { ...a, id };
    });
  return {
    result: {
      ...ledger.result,
      annotations,
      limits: [
        ...(ledger.result.limits ?? []),
        {
          kind,
          reviewer: first.reviewer,
          entries: aside.map((a) => ({
            dimension: a.dimension,
            concern: asideConcern(a),
          })),
        },
      ],
    },
    counts: {
      ...ledger.counts,
      located: annotations.length,
      relocated: relocated.size,
      setAside: (ledger.counts.setAside ?? 0) + aside.length,
    },
    relocatedIds: relocated,
  };
}

/**
 * Seat outcomes → one `ReviewResult`, carrying the honesty record. Pure and
 * synchronous, no I/O. Annotations concatenate in seat order; ids are already
 * seat-prefixed, so they stay unique — which is exactly why a duplicate seat
 * name THROWS: that is a driver bug, not a model error, and it is the one thing
 * that would break identity's uniqueness silently.
 */
export function assembleReview(input: {
  seats: SeatOutcome[];
  synthesis?: ReviewSynthesis;
}): ReviewResult {
  const seen = new Set<string>();
  const annotations: ReviewAnnotation[] = [];
  // V5 (ADR 0087 §1–§2): every parsed seat's strengths and assessments, in
  // seat order — the PDF seat's included, whose ledger joins the union the
  // scorecard reads. Copied here or lost: this is the one assembly point.
  const strengths: ReviewStrength[] = [];
  const assessments: ReviewAssessment[] = [];
  const limits: ReviewLimit[] = [];
  for (const seat of input.seats) {
    if (seen.has(seat.reviewer)) {
      throw new Error(
        `assembleReview: duplicate reviewer name ${JSON.stringify(seat.reviewer)} — seat names must be distinct, because concern ids are seat-prefixed`,
      );
    }
    seen.add(seat.reviewer);
    if ("missing" in seat) {
      limits.push({
        kind: "seat_missing",
        reviewer: seat.reviewer,
        reason: seat.missing,
        ...(seat.cause !== undefined ? { cause: seat.cause } : {}),
      });
      continue;
    }
    if (seat.ledger.failure !== undefined) {
      limits.push({
        kind: "seat_missing",
        reviewer: seat.reviewer,
        reason: "unparsed",
        detail: seat.ledger.failure,
        ...(seat.ranOutOf !== undefined ? { ranOutOf: seat.ranOutOf } : {}),
      });
      continue;
    }
    const result = seat.ledger.result;
    if (result === undefined) {
      // Unreachable while `LedgerOutcome`'s contract holds (exactly one of
      // result/failure is set, which `ledger.test.ts` pins). Recorded rather
      // than skipped, because a silent `continue` is the one branch here that
      // would contribute neither an annotation nor a limit — a review claiming
      // a completeness it does not have, which is what `limits` exists to stop.
      limits.push({
        kind: "seat_missing",
        reviewer: seat.reviewer,
        reason: "unparsed",
        detail: "the seat's ledger carried neither a result nor a failure",
      });
      continue;
    }
    // The ids are stamped from whatever `reviewer` the driver passed to
    // interpretLedger, so a driver that let the two disagree would slip past
    // the duplicate-name guard above and still collide. Same class of bug,
    // same answer.
    const stamped = result.annotations[0]?.reviewer;
    if (stamped !== undefined && stamped !== seat.reviewer) {
      throw new Error(
        `assembleReview: seat ${JSON.stringify(seat.reviewer)} carries annotations stamped ${JSON.stringify(stamped)} — the seat name and the reviewer passed to interpretLedger must be the same string`,
      );
    }
    annotations.push(...result.annotations);
    if (result.strengths !== undefined) strengths.push(...result.strengths);
    if (result.assessments !== undefined) {
      assessments.push(...result.assessments);
    }
    if (result.limits !== undefined) limits.push(...result.limits);
  }
  return {
    annotations,
    ...(strengths.length > 0 ? { strengths } : {}),
    ...(assessments.length > 0 ? { assessments } : {}),
    ...(limits.length > 0 ? { limits } : {}),
    ...(input.synthesis !== undefined ? { synthesis: input.synthesis } : {}),
  };
}
