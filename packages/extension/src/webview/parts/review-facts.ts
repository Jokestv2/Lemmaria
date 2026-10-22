/**
 * What the Review tab can say about a PANEL that no single row says (X6,
 * ADR 0075) — four derivations over data that is already on the wire.
 *
 * Pure and DOM-free, and deliberately so: each rule here decides whether a
 * sentence the tab writes is TRUE — *raised no concern*, *2 distinct models*,
 * *same model* — so each is asserted on data alone, without building a tab.
 * It reads no locale either; `review-tab.ts` turns these facts into words.
 *
 * Here and not in the harness: these are views for one surface, nothing else
 * reads them, and the CLI renders no tab. (V5's scorecard is the harness's
 * because two hosts and the eval tier read it.)
 */
import type { ReviewLimit, ReviewSynthesisEntry } from "@lemmaria/harness";
import type {
  ReviewAnnotationInfo,
  ReviewCrossReviewInfo,
  ReviewSeatInfo,
} from "../../webview-protocol.js";

/** Entries a reviewer raised that did not survive, by how they were lost. */
export interface LostEntries {
  /** Lost to an anchor — the claim's quote or the evidence's did not locate. */
  dropped: number;
  /** Rejected for its shape (X5, ADR 0074 §3). */
  rejected: number;
  /** Located, then set aside by a panel (ADR 0083 §2) — not lost to the
   *  seat's own report, so it never reads as *could not be recorded*. */
  setAside: number;
  /** Located, then set aside as review-mode furniture (ADR 0085 §2) — in
   *  both modes, and headed apart from the argument's. Present only when
   *  non-zero, as `LedgerCounts.setAside` is, so a seat that set none aside
   *  counts exactly as before. */
  furniture?: number;
}

/**
 * Per reviewer, how many ENTRIES its report lost — the count ADR 0075 §1's
 * heading needs to stop saying *raised no concern* of a reviewer that raised
 * four.
 *
 * Entries, not anchors, and the two are the same number: the interpreter
 * pushes exactly one `anchors[]` record for an entry it drops (on the claim's
 * quote, or failing that the evidence's) and moves on, and one `entries[]`
 * record for an entry it rejects. After X5's re-ask the limits are the second
 * pass's, and so is the seat's final `ledger` — the two cannot disagree.
 *
 * Every other kind is ignored, and `synthesis_missing` carries no reviewer at
 * all, so the kind is narrowed before one is read.
 */
export function lostBySeat(
  limits: readonly ReviewLimit[] | undefined,
): Map<string, LostEntries> {
  const lost = new Map<string, LostEntries>();
  const of = (reviewer: string): LostEntries => {
    let entry = lost.get(reviewer);
    if (entry === undefined) {
      entry = { dropped: 0, rejected: 0, setAside: 0 };
      lost.set(reviewer, entry);
    }
    return entry;
  };
  for (const limit of limits ?? []) {
    if (limit.kind === "anchors_dropped") {
      of(limit.reviewer).dropped += limit.anchors.length;
    } else if (limit.kind === "entries_rejected") {
      of(limit.reviewer).rejected += limit.entries.length;
    } else if (limit.kind === "concerns_set_aside") {
      of(limit.reviewer).setAside += limit.entries.length;
    } else if (limit.kind === "furniture_set_aside") {
      const entry = of(limit.reviewer);
      entry.furniture = (entry.furniture ?? 0) + limit.entries.length;
    }
  }
  return lost;
}

/** The panel, counted — what ADR 0075 §3's one results line says. */
export interface PanelFacts {
  reviewers: number;
  /**
   * Distinct model ids. ABSENT when any seat has no recorded model (a review
   * stored before R9): a count over some of them would claim a diversity the
   * record cannot support, so the line says less instead.
   */
  models?: number;
  failed: number;
  interrupted: number;
  unparsed: number;
  /** ADR 0082 §2: reviewers that ran out of a budget before finishing —
   *  counted here and NOT as unparsed, as their headings say. */
  outOfBudget: number;
}

export function panelFacts(seats: readonly ReviewSeatInfo[]): PanelFacts {
  const models = new Set<string>();
  let everyModelKnown = seats.length > 0;
  let failed = 0;
  let interrupted = 0;
  let unparsed = 0;
  let outOfBudget = 0;
  for (const seat of seats) {
    if (seat.model === undefined || seat.model === "") everyModelKnown = false;
    else models.add(seat.model);
    const reason = seat.missing?.reason;
    if (seat.missing?.ranOutOf !== undefined) outOfBudget++;
    else if (reason === "failed") failed++;
    else if (reason === "interrupted") interrupted++;
    else if (reason === "unparsed") unparsed++;
  }
  return {
    reviewers: seats.length,
    ...(everyModelKnown ? { models: models.size } : {}),
    failed,
    interrupted,
    unparsed,
    outOfBudget,
  };
}

/**
 * The one model every reviewer a synthesis entry cites ran on — or
 * `undefined`, which is also the answer whenever anything is unknown.
 *
 * ADR 0075 §4: agreement between two reviewers on one model is weaker
 * evidence than agreement across models, and the tab says so. It is computed
 * HERE, at render time, because the cross-review is never told the models
 * (ADR 0069 §6) — so nothing a model reads learns of it.
 *
 * **Unknown is never marked.** An id that resolves to no annotation, a
 * reviewer with no seat row, or a seat with no recorded model each answer
 * `undefined`: the mark is a claim of sameness, and a claim needs the facts.
 * At least two DISTINCT reviewers, which `interpretSynthesis` already enforces
 * per entry — a guard here, not a filter.
 */
export function sharedModel(
  entry: ReviewSynthesisEntry,
  annotations: readonly ReviewAnnotationInfo[],
  seats: readonly ReviewSeatInfo[],
): string | undefined {
  const reviewers = new Set<string>();
  for (const id of entry.ids) {
    const cited = annotations.find((a) => a.id === id);
    if (cited === undefined) return undefined;
    reviewers.add(cited.reviewer);
  }
  if (reviewers.size < 2) return undefined;
  let model: string | undefined;
  for (const reviewer of reviewers) {
    const ran = seats.find((s) => s.reviewer === reviewer)?.model;
    if (ran === undefined || ran === "") return undefined;
    if (model === undefined) model = ran;
    else if (ran !== model) return undefined;
  }
  return model;
}

/** A failed literature source's status — the record's own type, not a copy
 *  of it, so a status the contract adds reaches `STATUS_RANK` as a compile
 *  error rather than as a status the row silently leaves out. */
export type SourceStatus = Extract<
  ReviewLimit,
  { kind: "source_unavailable" }
>["status"];

/** One row of the limits fold. */
export type LimitRow =
  | {
      kind: "limit";
      limit: Exclude<ReviewLimit, { kind: "source_unavailable" }>;
    }
  | {
      kind: "source";
      source: string;
      /** Distinct, in panel order; any the panel does not list come after,
       *  in the order they were first seen. */
      reviewers: string[];
      /** Distinct, in the fixed order below. */
      statuses: SourceStatus[];
      /** True if ANY folded limit ran without a key — the pointer to the key
       *  command is by exception, and one keyless failure earns it. */
      anonymous: boolean;
    };

/** Where each status sits in a merged row. A `Record`, not a list, so it
 *  must name every status the record can carry. */
const STATUS_RANK: Record<SourceStatus, number> = {
  rate_limited: 0,
  timeout: 1,
  failed: 2,
};

/**
 * The limits fold's rows: one per failed literature SOURCE, every other limit
 * in place (ADR 0075 §7).
 *
 * A VIEW, never a rewrite of the record — which keeps one `source_unavailable`
 * per `(reviewer, source, status)` (ADR 0061 §8). The round saw 16 limit lines
 * of which 13 were source rows — `arxiv — timed out` beside `arxiv —
 * rate-limited` among them; what a reader needs is *which sources did not
 * answer*, once each.
 *
 * The first limit for a source becomes its row, AT ITS POSITION, and later
 * ones fold into it and emit nothing. So a source that failed for one reviewer
 * with one status is exactly the one-limit row it always was.
 *
 * A `pages_corrected` limit is NO row (ADR 0085 §4): the move is something
 * the review did, not something it could not do, and each moved concern's
 * own evidence line says it (`movedFrom`). Nor, since ADR 0086, is a
 * set-aside: it has a fold of its own (`setAsideLimits`).
 */
export function limitRows(
  limits: readonly ReviewLimit[],
  seatOrder: readonly string[],
): LimitRow[] {
  const rows: LimitRow[] = [];
  const bySource = new Map<string, Extract<LimitRow, { kind: "source" }>>();
  const seen = new Map<string, Set<SourceStatus>>();
  for (const limit of limits) {
    if (limit.kind === "pages_corrected" || isSetAside(limit)) continue;
    if (limit.kind !== "source_unavailable") {
      rows.push({ kind: "limit", limit });
      continue;
    }
    let row = bySource.get(limit.source);
    if (row === undefined) {
      row = {
        kind: "source",
        source: limit.source,
        reviewers: [],
        statuses: [],
        anonymous: false,
      };
      bySource.set(limit.source, row);
      seen.set(limit.source, new Set());
      rows.push(row);
    }
    if (!row.reviewers.includes(limit.reviewer))
      row.reviewers.push(limit.reviewer);
    seen.get(limit.source)?.add(limit.status);
    if (limit.anonymous === true) row.anonymous = true;
  }
  // Order what was collected. `sort` is stable, so reviewers the panel does
  // not list keep the order they were first seen in, after the ones it does.
  const rank = (reviewer: string): number => {
    const at = seatOrder.indexOf(reviewer);
    return at < 0 ? seatOrder.length : at;
  };
  for (const row of bySource.values()) {
    row.reviewers.sort((a, b) => rank(a) - rank(b));
    row.statuses = [...(seen.get(row.source) ?? [])].sort(
      (a, b) => STATUS_RANK[a] - STATUS_RANK[b],
    );
  }
  return rows;
}

/** A limit recording concerns a rule SET ASIDE — the argument's in a panel
 *  (ADR 0083 §2), review-mode furniture's in both modes (ADR 0085 §2). */
export type SetAsideLimit = Extract<
  ReviewLimit,
  { kind: "concerns_set_aside" | "furniture_set_aside" }
>;

const isSetAside = (limit: ReviewLimit): limit is SetAsideLimit =>
  limit.kind === "concerns_set_aside" || limit.kind === "furniture_set_aside";

/**
 * The record's set-aside limits, in record order — the rows of the fold
 * ADR 0086 gives them. A set-aside is something the review DID, so it left
 * *What this review could not do* (`limitRows`); and each entry now keeps
 * what its concern said, so the fold lists it for the reader to check the
 * rule against.
 */
export function setAsideLimits(
  limits: readonly ReviewLimit[] | undefined,
): SetAsideLimit[] {
  return (limits ?? []).filter(isSetAside);
}

/**
 * The page each moved concern CITED, by concern id — from the record's
 * `pages_corrected` limits (ADR 0084), for its evidence line to say beside the
 * page it now carries (ADR 0085 §4). A concern the harness did not move is
 * absent.
 */
export function movedFrom(
  limits: readonly ReviewLimit[] | undefined,
): Map<string, number> {
  const cited = new Map<string, number>();
  for (const limit of limits ?? []) {
    if (limit.kind !== "pages_corrected") continue;
    for (const entry of limit.entries) cited.set(entry.id, entry.cited);
  }
  return cited;
}

/**
 * V1 (ADR 0076 §9): was this concern withdrawn by verification?
 *
 * Only a `refuted` outcome withdraws — and the harness records one only with
 * a counter it located, so a withdrawn row always has a passage to show.
 * Restated here over the tab's own type because the webview imports no
 * harness code (ADR 0011); the harness's `isWithdrawn` is the same rule over
 * its own.
 */
export function isWithdrawn(a: ReviewAnnotationInfo): boolean {
  return a.verification?.outcome === "refuted";
}

/** What the id line says about a concern the verifier did not withdraw. */
export type VerificationMark = "unchecked" | "opinion" | "unsettled";

/**
 * The mark a concern carries, BY EXCEPTION (ADR 0076 §9): nothing on one the
 * verifier upheld or withdrew. No verification at all is *not checked* —
 * which is true of a panel stored before V1, and of one run with it off. An
 * unverifiable `judgment` is the reviewer's opinion; any other unverifiable
 * concern is one the text could not settle either way.
 */
export function verificationMark(
  a: ReviewAnnotationInfo,
): VerificationMark | undefined {
  const v = a.verification;
  if (v === undefined) return "unchecked";
  if (v.outcome !== "unverifiable") return undefined;
  return v.kind === "judgment" ? "opinion" : "unsettled";
}

/**
 * V4 (ADR 0081 §5): did verification COMPLETE over this panel?
 *
 * The tab says once, under the PDF reviewer's heading, that its concerns were
 * not checked — and only then: when verification did not complete, the
 * limits fold already says the concerns were not checked, and saying it twice
 * would be the same fact in two places. The record's own rule restated over
 * the tab's data: the driver calls verification complete exactly when a
 * verifier ran and recorded no `verification_missing`.
 */
export function verificationCompleted(
  verifier: ReviewCrossReviewInfo | undefined,
  limits: readonly ReviewLimit[] | undefined,
): boolean {
  return (
    verifier !== undefined &&
    !(limits ?? []).some((l) => l.kind === "verification_missing")
  );
}
