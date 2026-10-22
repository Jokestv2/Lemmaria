/**
 * Where a paper evidence can be OPENED, or nowhere (V2, ADR 0078 D12).
 *
 * A result's `url` is third-party data: it arrives from a scholarly index and
 * is copied by a model, and the tab must not be handed something it would turn
 * into a link of any scheme. So only an **http(s)** URL becomes an href; a
 * DOI, which is a stable identifier rather than a location, is resolved
 * through `doi.org`; anything else yields nothing and the row draws plain
 * text.
 *
 * The http(s) test is `parts/links.ts`' own, imported rather than rewritten:
 * two patterns for one rule agree only until one of them is edited.
 */
function paperHref(evidence: {
  url?: string;
  doi?: string;
}): string | undefined {
  if (evidence.url !== undefined && HTTP_SCHEME.test(evidence.url)) {
    return evidence.url;
  }
  if (evidence.doi !== undefined && evidence.doi !== "") {
    return `https://doi.org/${evidence.doi}`;
  }
  return undefined;
}

/**
 * V2's gate review, issue 3: the year a `paper` row may actually draw.
 *
 * Crossref dates a work it holds no date for as `[[null]]`, and the mapper
 * stringified that into the literal `"null"` — read on screen as
 * `… image segmentation (null)`, and carried into both assistant drafts. The
 * mapper is fixed, but every review stored before the fix still holds the
 * string, and this projection is the one path those records come back
 * through. Blank is refused for the same reason and on the same evidence: an
 * absent year renders with no parentheses, which is what an undated work
 * should look like.
 *
 * Whole-value, not a substring: a year is not wrong for containing letters,
 * and nothing here should silently edit third-party data.
 */
function usableYear(year: string | undefined): string | undefined {
  if (year === undefined) return undefined;
  const trimmed = year.trim();
  return trimmed === "" || trimmed === "null" || trimmed === "undefined"
    ? undefined
    : trimmed;
}

/**
 * M9 single-model review: `lemmaria.review` runs the built-in review action
 * (kind: review, annotations contract — ADR 0008) and renders the read-only
 * result in the Assistant webview's Review TAB (U5 round 2 — operator
 * feedback: a tab next to Assistant/Citations/Models/Venue, not a separate
 * view). Review never writes (invariant 3): adopting a suggestion re-enters
 * the ordinary Accept-gated diff + verify flow (`lemmaria.adoptSuggestion`).
 */

import * as path from "node:path";
import { loadAdapterFor } from "@lemmaria/adapters";
import type {
  EditProposal,
  LoadedAction,
  ReviewAnnotation,
  ReviewPdfRecord,
  ReviewResult,
  ReviewSeatState,
} from "@lemmaria/harness";
import {
  ReviewStore,
  type StoredReview,
  deriveScorecard,
  isBlocking,
  nextPanelVersion,
  runAction,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import {
  actionLabel,
  captureTarget,
  ceilingsFromSettings,
  loadMemoryInput,
  prepareWorkspace,
} from "./action-run";
import { type ChromeKey, tr } from "./chrome-strings";
import { recordUsage } from "./cost-ui";
import { onProposalAccepted, openProposalDiff } from "./diff-review";
import { currentLocale } from "./i18n";
import { getModel } from "./model";
import { offerPaperMdOnce } from "./paper-md";
import { previousComparable } from "./review-previous";
import { reviewStoreDir } from "./session/session-state";
import type {
  ReviewAnnotationInfo,
  ReviewAnnotationStatus,
  ReviewSeatInfo,
  ReviewTabState,
} from "./webview-protocol.js";
import { HTTP_SCHEME } from "./webview/parts/links";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/** The originating-action name stamped on an adopt proposal — also the signal
 *  that lets the accept correlation tell adoptions from Polish/other edits. */
const ADOPT_ACTION_NAME = { en: "Adopt suggestion", zh: "采纳建议" } as const;

export interface ReviewOutcome {
  status:
    | "reviewed"
    | "no_review"
    | "not_latex"
    | "not_configured"
    | "cancelled"
    | "error";
  message?: string;
}

interface ReviewState {
  result: ReviewResult;
  /** Which review produced this state (R3, ADR 0061 §10). The two differ in
   *  exactly two places — how an annotation's file resolves, and what the tab
   *  carries beyond the annotations — and nowhere else. */
  mode: "quick" | "panel" | "pdf";
  /** The reviewed document, for annotation jumps and adoption. In panel mode
   *  this is the ENTRY's document; an annotation in another file resolves
   *  through `root` below. */
  uri: vscode.Uri;
  /** The workspace root every `span.file` is relative to. */
  root: string;
  /** Workspace-relative path of the reviewed entry. */
  entry: string;
  /** Per-annotation triage state, parallel to `result.annotations` (round 3). */
  statuses: ReviewAnnotationStatus[];
  /**
   * R9 (ADR 0069 D8): the panel's own seat rows — who reviewed, on what model.
   * Absent for a quick review, which has no panel, and for a panel restored
   * from a store written before R9.
   */
  seats?: ReviewSeatState[];
  /**
   * X5 (ADR 0074 §8): the cross-review's own row, in a reviewer's shape.
   * Absent for a quick review, and for a panel stored before X5. X6 (ADR 0075
   * §5) renders its model in the *Across the panel* heading; its tally and
   * cost are carried for the record and not yet rendered (X6 D12.2–3).
   */
  synthesisSeat?: ReviewSeatState;
  /** V1 (ADR 0076 §7): the verifier's row, the cross-review's sibling. Absent
   *  for a quick review, a panel that verified nothing, and one stored before
   *  V1 — whose rows then read *not checked*, which is true of them. */
  verifierSeat?: ReviewSeatState;
  /** V4 (ADR 0081 §3): the PDF reviewer's row — a sibling, like the two
   *  above. Absent when no PDF reviewer ran, and for a review stored before
   *  V4. */
  pdfSeat?: ReviewSeatState;
  /** V4 (ADR 0081 §1): the compiled PDF the review read, and its facts. */
  pdf?: ReviewPdfRecord;
  /** The panel's version number (ADR 0062 §1); absent for a quick review and
   *  for a panel that ran before versions existed. */
  version?: number;
  /** When the review was produced, epoch ms — the version's date tag. Taken
   *  from the persisted item for a panel, so a resumed session shows the day
   *  the review actually ran; stamped here for a quick action, which only ever
   *  reaches this module in the window that produced it. */
  at: number;
}

/**
 * The document one annotation points at.
 *
 * A quick action reviews ONE unit of ONE file, and its span's `file` is the
 * entry the harness was handed — so it resolves to the reviewed document and
 * the M9 flow is unchanged. A panel annotates the whole manuscript, so its
 * spans name files the user never focused, and each one is resolved against
 * the workspace root (ADR 0061 §10).
 */
function uriFor(s: ReviewState, span: { file: string }): vscode.Uri {
  if (s.mode === "quick") return s.uri;
  return vscode.Uri.file(path.resolve(s.root, span.file));
}

/**
 * Every review this window holds, oldest first (ADR 0062 §1).
 *
 * The tab used to show exactly one — the last review to complete — so running
 * `/review` a second time made the first one unreachable while its concerns
 * were still open in the manuscript. A reviewer revises and re-reviews, so the
 * reviews are a SEQUENCE, and the tab picks one of them.
 *
 * `selected` indexes it, and every index-addressed command (reveal, adopt,
 * ignore, resolve) addresses the SELECTED review's annotations — the same
 * handle the rendered rows carry, so the two cannot disagree.
 */
const reviews: ReviewState[] = [];
let selected = -1;

function current(): ReviewState | undefined {
  return reviews[selected];
}

/**
 * ADR 0065 §1: where the list above is kept between windows.
 *
 * Undefined in the ext-host suites that never call `initReviews` — every write
 * below is guarded, so a store-less window behaves exactly as the whole module
 * did before ADR 0065: the reviews are the window's and die with it.
 */
let store: ReviewStore | undefined;

/** The in-memory list as the store holds it. Built from `reviews` rather than
 *  maintained beside it, so the two cannot drift. */
function persistable(): StoredReview[] {
  return reviews.map((r) => ({
    mode: r.mode,
    result: r.result,
    root: r.root,
    entry: r.entry,
    file: r.uri.fsPath,
    at: r.at,
    ...(r.version !== undefined ? { version: r.version } : {}),
    ...(r.seats !== undefined ? { seats: r.seats } : {}),
    ...(r.synthesisSeat !== undefined
      ? { synthesisSeat: r.synthesisSeat }
      : {}),
    // V1: verification is part of the RESULT, not triage — the concerns carry
    // it already, and the seat says which model did it and what it cost.
    ...(r.verifierSeat !== undefined ? { verifierSeat: r.verifierSeat } : {}),
    // V4: the PDF reviewer's row and the facts it read, the same way.
    ...(r.pdfSeat !== undefined ? { pdfSeat: r.pdfSeat } : {}),
    ...(r.pdf !== undefined ? { pdf: r.pdf } : {}),
  }));
}

/** Write the history out. Fire-and-forget: a failed write costs the NEXT
 *  window its history, and blocking the review on the filesystem would cost
 *  this one its result. */
function persist(): void {
  void store?.save(persistable());
}

/**
 * ADR 0065 §1: load this workspace's reviews at activation.
 *
 * `reveal: false` throughout — the user opened a window, they did not ask for
 * the Review tab. Selecting the newest is `presentPanelReview`'s own
 * behaviour, so the tab opens on the last review the workspace ran, whatever
 * conversation ran it.
 */
export async function initReviews(
  context: vscode.ExtensionContext,
): Promise<void> {
  store = new ReviewStore(reviewStoreDir(context));
  const stored = await store.load();
  if (stored.length === 0) return;
  for (const r of stored) {
    reviews.push({
      result: r.result,
      mode: r.mode,
      uri: vscode.Uri.file(r.file),
      root: r.root,
      entry: r.entry,
      // Triage is not persisted (see `review-store.ts`): a restored review
      // starts pending, which is what a resume already did.
      statuses: r.result.annotations.map(() => "pending"),
      at: r.at,
      ...(r.version !== undefined ? { version: r.version } : {}),
      // R9: a review stored before R9 has none, and the tab then falls back
      // to an empty seat list rather than inventing three.
      ...(r.seats !== undefined ? { seats: r.seats } : {}),
      // X5: same rule for the cross-review — absent stays absent.
      ...(r.synthesisSeat !== undefined
        ? { synthesisSeat: r.synthesisSeat }
        : {}),
      // V1: and for the verifier.
      ...(r.verifierSeat !== undefined ? { verifierSeat: r.verifierSeat } : {}),
      // V4: and for the PDF reviewer and its facts.
      ...(r.pdfSeat !== undefined ? { pdfSeat: r.pdfSeat } : {}),
      ...(r.pdf !== undefined ? { pdf: r.pdf } : {}),
    });
  }
  selected = reviews.length - 1;
  notifyReviewChanged();
}

/**
 * The version the next panel takes (ADR 0065 §1) — one past the highest this
 * WORKSPACE has issued, not one past what the current conversation contains.
 */
export function nextReviewVersion(): number {
  return nextPanelVersion(persistable());
}

/**
 * An adopt-in-flight: the exact finding + span the user routed into the diff.
 * Keyed by real-file uri (only one proposal can be pending per file). Held so
 * an Accept flips EXACTLY that finding — not a same-text sibling, and not a
 * finding in a review that has since been re-run (`review` pins the generation
 * by identity). Cleared on the matching Accept; a stale entry (Reject / a diff
 * replaced by another action) is fail-safe — the guards below never mis-fire.
 */
interface PendingAdoption {
  review: ReviewState;
  index: number;
  startOffset: number;
  endOffset: number;
}
const pendingAdoptions = new Map<string, PendingAdoption>();

/** Test seam: the current panel model (undefined until a review ran). */
export function getReviewForTests(): ReviewResult | undefined {
  return current()?.result;
}

/**
 * Test seam (X5): exactly what `persist()` would write.
 *
 * This and not a disk read, because `clearReviews()` drops the store handle on
 * purpose — a suite that reset this module must not write the previous one's
 * history back out — so in the ext-host suites there is no file to read. The
 * boundary worth asserting here is the one where a field goes missing anyway:
 * the mapping from the in-memory review to `StoredReview`. Whether that shape
 * survives a save and a load is the harness store's own test.
 */
export function persistableReviewsForTests(): StoredReview[] {
  return persistable();
}

/** Listeners notified when a review completes (the webview's reveal trigger).
 *  Process-lifetime: no unsubscribe — register once from activation only. */
const reviewListeners: Array<() => void> = [];
export function onReviewCompleted(listener: () => void): void {
  reviewListeners.push(listener);
}

/** Listeners notified when a finding's triage status changes (adopt/ignore),
 *  so the host re-pushes the tab WITHOUT re-revealing it (round 3). */
const reviewChangedListeners: Array<() => void> = [];
export function onReviewChanged(listener: () => void): void {
  reviewChangedListeners.push(listener);
}
function notifyReviewChanged(): void {
  for (const l of reviewChangedListeners) l();
}

/** Move a finding out of the pending list. No-op on a bad index / no review.
 *
 *  `ignored` and `handed` are two different things the reader knows and we do
 *  not: *this is not a problem* and *I have given this to the assistant*. Both
 *  leave the pending list for the archive, and the archive keeps them apart —
 *  collapsing them would throw away the only fact the click carried. */
function triage(index: number, to: ReviewAnnotationStatus): void {
  const review = current();
  if (review === undefined) return;
  if (index < 0 || index >= review.statuses.length) return;
  if (review.statuses[index] === to) return;
  review.statuses[index] = to;
  notifyReviewChanged();
}

export function ignoreAnnotation(index: number): void {
  triage(index, "ignored");
}

/** Record that a finding has been handed to the assistant (ADR 0063 §3).
 *
 *  The SENDING is the caller's — this is only the bookkeeping half, kept beside
 *  the other two triage words so all three leave the pending list by the same
 *  door. `handed`, not `resolved`: at the moment of the click the work has been
 *  started, not finished, and the archive says exactly that. */
export function handAnnotationToAssistant(index: number): void {
  triage(index, "handed");
}

/** Show a different review of this session (ADR 0062 §1). Out-of-range ids are
 *  ignored rather than clearing the tab: the picker is the only sender, and a
 *  stale id from a webview that reloaded mid-change must not blank it. */
export function selectReview(id: number): void {
  if (id < 0 || id >= reviews.length) return;
  if (id === selected) return;
  selected = id;
  notifyReviewChanged();
}

/**
 * Drop every review this module holds, and detach the store.
 *
 * **A test seam, and since ADR 0065 nothing else.** It used to run on `New
 * Session` and on every resume, because the reviews were the SESSION's — which
 * is precisely the defect the operator reported: starting a fresh chat emptied
 * the picker and restarted the version sequence at v1. The reviews are the
 * workspace's now, so no conversation boundary clears them, and the two calls
 * in `lifecycle.ts` that did are gone.
 *
 * The store handle goes with them: a suite that has reset this module must not
 * have its next review write the previous suite's history back out.
 */
export function clearReviews(): void {
  store = undefined;
  if (reviews.length === 0 && selected === -1) return;
  reviews.length = 0;
  selected = -1;
  notifyReviewChanged();
}

/**
 * The panel's reviewers, in panel order, with what each one produced.
 *
 * Built from **the item's own seat rows** rather than from the annotations, so
 * a reviewer that reported NOTHING still appears — the stage's no-quota rule
 * means an empty reviewer is a finding, not an absence, and a tab that simply
 * omitted it would read as if that reviewer had never run.
 *
 * R9 (ADR 0069 §D8): it used to build from the `PANEL_SEATS` constant, which
 * was only correct while N and the names were fixed. The rows now carry the
 * model each reviewer ran on, which the constant never could.
 */
function seatsOf(
  result: ReviewResult,
  seats: readonly ReviewSeatState[],
): ReviewSeatInfo[] {
  return seats.map((seat): ReviewSeatInfo => {
    const missing = result.limits?.find(
      (l) => l.kind === "seat_missing" && l.reviewer === seat.reviewer,
    );
    return {
      reviewer: seat.reviewer,
      count: result.annotations.filter((a) => a.reviewer === seat.reviewer)
        .length,
      ...modelOf(seat),
      ...(missing?.kind === "seat_missing" ? { missing } : {}),
    };
  });
}

/** Which model a seat ran on, as a heading names it — ONE rule for every
 *  reviewer's heading and the cross-review's (ADR 0075 §5), so the two cannot
 *  disagree about when a model is worth naming.
 *
 *  By exception: a review persisted before R9 carries no model, which replay
 *  normalizes to `""`, and the heading simply omits the segment. */
function modelOf(
  seat: ReviewSeatState,
): Pick<ReviewSeatInfo, "model" | "unverified"> {
  return {
    ...(seat.model !== undefined && seat.model !== ""
      ? { model: seat.model }
      : {}),
    ...(seat.unverified === true ? { unverified: true as const } : {}),
  };
}

/** One row of the tab's review picker (ADR 0062 §1). */
function historyOf(): ReviewTabState["history"] {
  return reviews.map((r, id) => ({
    id,
    mode: r.mode,
    at: r.at,
    file: path.basename(r.entry === "" ? r.uri.fsPath : r.entry),
    concerns: r.result.annotations.length,
    ...(r.version !== undefined ? { version: r.version } : {}),
  }));
}

/** The selected review's card, and — when an earlier version of the same
 *  manuscript exists — the comparison `previousComparable` chose (V6, ADR
 *  0088 §1–§2). Absent stays absent: no `previous` key on a first reading. */
function scorecardOf(
  chosen: ReviewState,
): Pick<ReviewTabState, "scorecard" | "previous" | "delta"> {
  const scorecard = deriveScorecard(chosen);
  const compared = previousComparable(reviews, selected, (r) =>
    r === chosen ? scorecard : deriveScorecard(r),
  );
  return {
    scorecard,
    ...(compared !== undefined
      ? { previous: compared.previous, delta: compared.delta }
      : {}),
  };
}

/**
 * The Review tab's display state, built from the SELECTED review.
 *
 * `nextEntry` is passed IN rather than resolved here (ADR 0064 §1): it is
 * `reviewPaperEntry()`'s answer, which is async and is a fact about the
 * project rather than about any review, and this module is the reviews'. The
 * host caches it and hands it down, which is also what keeps this function
 * synchronous — every `notifyReviewChanged` push goes through it.
 */
export function computeReviewTabState(nextEntry = ""): ReviewTabState {
  const chosen = current();
  if (chosen === undefined)
    return {
      available: false,
      mode: "quick",
      file: "",
      entry: "",
      nextEntry,
      annotations: [],
    };
  const current_ = chosen;
  const panel = current_.mode === "panel";
  // V4 (ADR 0081 §7): a `/review-pdf` run reads the paper from its entry too,
  // so its header names the entry the way a panel's does.
  const manuscript = current_.mode !== "quick";
  return {
    available: true,
    mode: current_.mode,
    // A quick review names ONE file, so its basename is the whole story; a
    // panel names many, so the header is the entry's path and each row says
    // which file it is in when that is not the entry.
    file: manuscript ? current_.entry : path.basename(current_.uri.fsPath),
    // The comparison basis, in BOTH modes: a row prints its own `file:` only
    // when it differs from the entry. Quick mode's `file` above is a basename,
    // so comparing against THAT would print `sections/intro.tex:12` under a
    // header reading `intro.tex` — a difference the reader cannot act on.
    entry: current_.entry,
    nextEntry,
    annotations: current_.result.annotations.map(
      (a, index): ReviewAnnotationInfo => ({
        index,
        id: a.id,
        dimension: a.dimension,
        severity: a.severity,
        message: a.message,
        reviewer: a.reviewer,
        file: a.span.file,
        line: a.span.line,
        hasSuggestion: a.suggestedEdit !== undefined,
        status: current_.statuses[index] ?? "pending",
        ...(a.suggestedEdit !== undefined
          ? { suggestion: a.suggestedEdit.replacement }
          : {}),
        // Absent stays absent, in both directions: `blocking: false` is not a
        // thing the contract produces, and an unset evidence is not "missing".
        // V1 (ADR 0076 §6): the badge needs a second model's agreement — shown
        // unless the verifier answered that the concern is not central.
        ...(isBlocking(a) ? { blocking: true as const } : {}),
        // X6 (ADR 0075 §6): the FILE too — it was on this span all along and
        // dropped here, which is how a cross-file line came to print as `L3`
        // of the entry. `endLine` stays behind: the tab names a line.
        // V2 (ADR 0078, D12): projected BY KIND. A `paper` carries no file and
        // no line — it is a position in the literature, not in the manuscript
        // — so it is never projected as a span with invented coordinates.
        ...(a.evidence?.kind === "missing"
          ? { evidence: { kind: "missing" as const } }
          : a.evidence?.kind === "span"
            ? {
                evidence: {
                  kind: "span" as const,
                  file: a.evidence.file,
                  line: a.evidence.line,
                },
              }
            : a.evidence?.kind === "paper"
              ? {
                  evidence: {
                    kind: "paper" as const,
                    title: a.evidence.title,
                    // V2's gate review, issue 3: a year is dropped unless it
                    // says something. Crossref's `[[null]]` reached the record
                    // as the literal string "null" before the mapper was
                    // fixed, and every review stored then comes back through
                    // HERE — so the guard belongs on the read as well as the
                    // write. No year is a legitimate state: the row draws the
                    // title with no parentheses.
                    ...(usableYear(a.evidence.year) !== undefined
                      ? { year: usableYear(a.evidence.year) as string }
                      : {}),
                    ...(paperHref(a.evidence) !== undefined
                      ? { href: paperHref(a.evidence) as string }
                      : {}),
                  },
                }
              : // V4 (ADR 0081 §4): a page is a position in the compiled
                // PDF, so it too is never projected as a span.
                a.evidence?.kind === "page"
                ? { evidence: { kind: "page" as const, page: a.evidence.page } }
                : {}),
        // V1 (ADR 0076 §7): what the verifier made of it. The counter in the
        // evidence's shape — a file and a line, `endLine` left behind.
        ...(a.verification === undefined
          ? {}
          : {
              verification: {
                outcome: a.verification.outcome,
                kind: a.verification.kind,
                ...(a.verification.counter !== undefined
                  ? {
                      counter: {
                        file: a.verification.counter.file,
                        line: a.verification.counter.line,
                      },
                    }
                  : {}),
                ...(a.verification.note !== undefined
                  ? { note: a.verification.note }
                  : {}),
              },
            }),
      }),
    ),
    ...(panel ? { seats: seatsOf(current_.result, current_.seats ?? []) } : {}),
    ...(panel && current_.result.synthesis !== undefined
      ? { synthesis: current_.result.synthesis }
      : {}),
    // X6 (ADR 0075 §5): which model read across the panel — iff the stored
    // review has the row (X5 wrote it; a panel stored before X5 has none).
    ...(panel && current_.synthesisSeat !== undefined
      ? { crossReview: modelOf(current_.synthesisSeat) }
      : {}),
    // V1 (ADR 0076 §7): which model checked the concerns, by the same rule.
    ...(panel && current_.verifierSeat !== undefined
      ? { verifier: modelOf(current_.verifierSeat) }
      : {}),
    // V4 (ADR 0081 §3): the PDF reviewer's row, by a reviewer's own rule —
    // its count, its model, and why it reported nothing — and the facts it
    // read. Both modes that can hold them; a quick review never does.
    ...(manuscript && current_.pdfSeat !== undefined
      ? {
          pdfSeat: seatsOf(current_.result, [
            current_.pdfSeat,
          ])[0] as ReviewSeatInfo,
        }
      : {}),
    ...(manuscript && current_.pdf !== undefined ? { pdf: current_.pdf } : {}),
    // V6 (ADR 0088 §1): the card, derived HERE — the webview cannot, since
    // the projection above drops `endLine` and `central` and ships no seat
    // status, ledger, strengths or assessments — and on every push, since
    // it is never persisted (ADR 0087 §3). A quick review gets none. §2: and
    // what it is compared against, relative to the SELECTED review.
    ...(manuscript ? scorecardOf(current_) : {}),
    // Shipped in BOTH modes — the state describes the review, and the tab
    // decides what to show (today: panel only, `review-tab.ts`). Keeping the
    // data here means answering the open question is a renderer edit.
    ...(current_.result.limits !== undefined
      ? { limits: current_.result.limits }
      : {}),
    // ADR 0062 §1: which reviews this window holds, and which one is on
    // screen. Shipped even when there is only one — the picker decides for
    // itself whether a single-entry list is worth drawing.
    history: historyOf(),
    selected,
  };
}

/**
 * Present a `/review` panel's result in the Review tab (R3, ADR 0061 §10).
 *
 * The session host calls this when a `review` item completes; `runReview`
 * below is the quick action's equivalent. Both APPEND to `reviews`, select
 * what they appended, and fire the same listeners — so the tab has one source
 * and one push path, and the newest review is the one on screen.
 *
 * `reveal: false` is the RESUME case — re-presenting a session the user just
 * re-opened must not steal the tab they are looking at, so it goes out through
 * the changed-listeners, exactly as a triage flip does.
 */
export function presentPanelReview(
  result: ReviewResult,
  root: string,
  entry: string,
  opts: {
    reveal?: boolean;
    version?: number;
    at?: number;
    /** R9 (ADR 0069 D8): the panel's seat rows, so the tab can group by the
     *  reviewers that actually ran and name the model each one used. */
    seats?: readonly ReviewSeatState[];
    /** X5 (ADR 0074 §8): the cross-review's row, carried beside them. */
    synthesisSeat?: ReviewSeatState;
    /** V1 (ADR 0076 §7): the verifier's row, carried beside that. */
    verifierSeat?: ReviewSeatState;
    /** V4 (ADR 0081 §3): the PDF reviewer's row, and the PDF it read. */
    pdfSeat?: ReviewSeatState;
    pdf?: ReviewPdfRecord;
    /** V4 (ADR 0081 §7): `"pdf"` for a `/review-pdf` run. Absent ⇒ a panel. */
    mode?: "panel" | "pdf";
  } = {},
): void {
  reviews.push({
    result,
    mode: opts.mode ?? "panel",
    uri: vscode.Uri.file(path.resolve(root, entry)),
    root,
    entry,
    statuses: result.annotations.map(() => "pending"),
    at: opts.at ?? Date.now(),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.seats !== undefined ? { seats: [...opts.seats] } : {}),
    ...(opts.synthesisSeat !== undefined
      ? { synthesisSeat: opts.synthesisSeat }
      : {}),
    ...(opts.verifierSeat !== undefined
      ? { verifierSeat: opts.verifierSeat }
      : {}),
    ...(opts.pdfSeat !== undefined ? { pdfSeat: opts.pdfSeat } : {}),
    ...(opts.pdf !== undefined ? { pdf: opts.pdf } : {}),
  });
  selected = reviews.length - 1;
  // ADR 0065 §1: and it outlives this window. Written after the push, so what
  // is persisted is exactly what is on screen.
  persist();
  if (opts.reveal === false) {
    notifyReviewChanged();
    return;
  }
  for (const l of reviewListeners) l();
}

/**
 * When an adopted suggestion's diff is Accepted, flip EXACTLY that finding to
 * `accepted` (round 3). Correlated by the adopt-in-flight record, not by text:
 * gated on the adopt action name (so a Polish/other edit is ignored), the same
 * review generation (so a re-run since adopting never mis-flips a fresh
 * finding), and the exact span (so a same-text sibling is never confused).
 */
function markAcceptedFromProposal(e: {
  realUri: vscode.Uri;
  proposal: EditProposal;
  actionName?: { en?: string; zh?: string };
}): void {
  if (e.actionName?.en !== ADOPT_ACTION_NAME.en) return;
  const pend = pendingAdoptions.get(e.realUri.toString());
  if (pend === undefined) return;
  pendingAdoptions.delete(e.realUri.toString());
  // The review the adoption came from must still be one this window holds —
  // a `clearReviews()` (new session) between adopt and Accept means the finding
  // no longer exists. It need NOT be the selected one: a user who adopted from
  // v1 and then ran v2 still adopted from v1, and that is the finding to flip.
  if (!reviews.includes(pend.review)) return;
  if (
    e.proposal.span.startOffset !== pend.startOffset ||
    e.proposal.span.endOffset !== pend.endOffset
  )
    return;
  if (pend.review.statuses[pend.index] !== "pending") return;
  pend.review.statuses[pend.index] = "accepted";
  notifyReviewChanged();
}

export interface AdoptOutcome {
  status: "proposed" | "stale" | "no_suggestion" | "no_review";
  message?: string;
  virtualUri?: vscode.Uri;
}

/**
 * Adopt-a-suggestion (ADR 0008): re-locate the suggestion's `original` anchor
 * in the LIVE document (verbatim, exactly once — refuse on drift) and route it
 * through the ordinary Accept-gated diff. Accept then splices + saves, exactly
 * like every other edit (invariant 3) — nothing compiles as a side effect; the
 * user runs Compile Check when they choose to (ADR 0013).
 */
async function adoptSuggestion(index: number): Promise<AdoptOutcome> {
  const review = current();
  const a = review?.result.annotations[index];
  if (review === undefined || a === undefined) {
    return { status: "no_review", message: "run Lemmaria: Review first" };
  }
  if (!a.suggestedEdit) {
    return { status: "no_suggestion", message: "annotation has no suggestion" };
  }
  const { original, replacement } = a.suggestedEdit;
  // The annotation's OWN file, not the review's entry (R3): a panel's
  // suggestion can land in any file of the manuscript, and adopting it must
  // open that one. Quick mode resolves to the reviewed document, as before.
  const realUri = uriFor(review, a.span);
  const doc = await vscode.workspace.openTextDocument(realUri);
  const text = doc.getText();
  // The harness guaranteed the anchor unique within the REVIEWED UNIT only —
  // it may legitimately repeat elsewhere in the file. Collect occurrences and,
  // when several, disambiguate by the annotation's recorded line (review fix).
  const occurrences: number[] = [];
  for (
    let at = text.indexOf(original);
    at !== -1;
    at = text.indexOf(original, at + 1)
  ) {
    occurrences.push(at);
  }
  let start: number | undefined;
  if (occurrences.length === 1) {
    start = occurrences[0];
  } else if (occurrences.length > 1) {
    const atLine = occurrences.filter(
      (offset) => doc.positionAt(offset).line + 1 === a.span.line,
    );
    if (atLine.length === 1) start = atLine[0];
  }
  if (start === undefined) {
    const message = chrome("staleForReview");
    void vscode.window.showWarningMessage(message);
    return { status: "stale", message };
  }
  const proposal: EditProposal = {
    file: path.basename(realUri.fsPath),
    span: { startOffset: start, endOffset: start + original.length },
    expectedOriginal: original,
    replacement,
    contract: "replace_selection",
  };
  const virtualUri = await openProposalDiff({
    realUri,
    documentText: text,
    proposal,
    onRetry: () => {
      void vscode.window.showInformationMessage(
        chrome("retryUnavailableAdopted"),
      );
      return Promise.resolve();
    },
    actionName: ADOPT_ACTION_NAME,
  });
  // Remember exactly what we adopted, so the Accept event flips this finding
  // (this review generation, this span) and nothing else.
  pendingAdoptions.set(realUri.toString(), {
    review,
    index,
    startOffset: start,
    endOffset: start + original.length,
  });
  return { status: "proposed", virtualUri };
}

/**
 * Open a concern's own line — or, with `which: "counter"` (V1, ADR 0076 §9),
 * the passage that answered a withdrawn concern, through the same path rule.
 * A concern with no counter opens nothing: falling back to the claim would
 * answer a question the reader did not ask.
 */
async function revealAnnotation(
  index: number,
  which?: "counter",
): Promise<void> {
  const review = current();
  if (review === undefined) return;
  const a = review.result.annotations[index];
  if (!a) return;
  const target = which === "counter" ? a.verification?.counter : a.span;
  if (target === undefined) return;
  const doc = await vscode.workspace.openTextDocument(uriFor(review, target));
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const line = Math.min(Math.max(target.line - 1, 0), doc.lineCount - 1);
  const range = doc.lineAt(line).range;
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

async function runReview(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): Promise<ReviewOutcome> {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    editor.document.uri.scheme !== "file" ||
    !/\.(tex|md)$/i.test(editor.document.fileName)
  ) {
    const message = chrome("needsProseFileForReview");
    void vscode.window.showWarningMessage(message);
    return { status: "not_latex", message };
  }
  const loaded = actions.find((a) => a.definition.id === "review");
  if (!loaded) {
    return { status: "error", message: "built-in action review missing" };
  }
  const bound = await getModel(context.secrets);
  if (!bound) {
    const message = chrome("needsModel");
    void vscode.window.showWarningMessage(message);
    return { status: "not_configured", message };
  }

  const target = captureTarget(editor);
  const { entry, workspace } = await prepareWorkspace(target.doc, target.text);
  const memory = await loadMemoryInput(workspace, entry);
  if (memory.project === undefined) offerPaperMdOnce(context);

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Lemmaria: ${actionLabel(loaded.definition)}…`,
      },
      async () => {
        const adapter = await loadAdapterFor(workspace, entry);
        return runAction({
          action: loaded.definition,
          adapter,
          workspace,
          model: bound.adapter,
          binding: bound.binding,
          selection: {
            file: entry,
            startOffset: target.startOffset,
            endOffset: target.endOffset,
          },
          ceilings: ceilingsFromSettings(),
          memory,
        });
      },
    );

    recordUsage({ ...result.usage, model: bound.binding.model });

    if (!result.review) {
      const reasons = result.validators
        .filter((v) => !v.pass)
        .map((v) => v.reason ?? v.type)
        .join("; ");
      // One language per reader (invariant 6 rule 2, ADR 0034). The parenthesis
      // carries the harness's own stop reason and validator names — identifiers,
      // not prose, so they are the same in both locales.
      const stopped = `${chrome("reviewStoppedBy")} ${result.stoppedBy ?? "?"}`;
      const message = `${chrome("reviewNoAnnotations")} (${stopped}${
        reasons ? `; ${reasons}` : ""
      })`;
      void vscode.window.showWarningMessage(message);
      return { status: "no_review", message };
    }

    reviews.push({
      result: result.review,
      mode: "quick",
      uri: target.doc.uri,
      root: workspace.root,
      entry,
      statuses: result.review.annotations.map(() => "pending"),
      // A quick review has no version — it reviews one unit of one file, not
      // the manuscript, so numbering it beside the panels would say the two
      // are the same kind of thing (ADR 0062 §1). It is still in the picker,
      // named by its file and its time.
      at: Date.now(),
    });
    selected = reviews.length - 1;
    // ADR 0065 §1: a quick review persists too. It is unnumbered and it reads
    // one unit of one file, but it is still a review of this project and the
    // picker is the project's — leaving it window-scoped would mean the list
    // held two kinds of row with two different lifetimes.
    persist();
    // The webview (registered at activation) reveals its Review tab on this.
    for (const l of reviewListeners) l();
    return { status: "reviewed" };
  } catch (error) {
    const message = `Lemmaria: review failed — ${(error as Error).message}`;
    void vscode.window.showErrorMessage(message);
    return { status: "error", message };
  }
}

export function registerReview(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("lemmaria.review", () =>
      runReview(context, actions),
    ),
    // Both commands address an annotation by its index in the last review —
    // the Review tab's rows (and tests) pass the ReviewAnnotationInfo.index.
    vscode.commands.registerCommand(
      "lemmaria.revealAnnotation",
      (index, which) =>
        revealAnnotation(
          typeof index === "number" ? index : -1,
          which === "counter" ? "counter" : undefined,
        ),
    ),
    vscode.commands.registerCommand("lemmaria.adoptSuggestion", (index) =>
      adoptSuggestion(typeof index === "number" ? index : -1),
    ),
    // ADR 0062 §5 registered `lemmaria.resolveAnnotation` here. It is GONE
    // (ADR 0063 §3): Resolve now composes a prompt in the reader's language and
    // sends it, which a bare command taking an index cannot do. It was never
    // contributed to `package.json` and nothing ever called it, so removing it
    // moves no user-facing surface — the tab reaches this through the
    // `resolveAnnotation` webview message instead.
    // When an adopted suggestion's diff is Accepted, flip its finding to
    // accepted (green, folded away) — the same event drives verify + sidebar.
    onProposalAccepted.event((e) => markAcceptedFromProposal(e)),
  );
}
