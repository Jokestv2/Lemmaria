/**
 * The scorecard is a view of the ledger (V5, ADR 0087 §3–§5).
 *
 * `deriveScorecard` reads a PERSISTED review — its result and its sibling
 * rows — and computes, per dimension, how the dimension stands: a level
 * (1 Blocking · 2 Major · 3 Minor · 4 Strong, the words being the host's), or
 * *nothing raised*, or *not assessed* with the reason. It is pure and total,
 * and **never persisted**: the store's format does not move, and a change to
 * the rule below re-derives every stored review. One function, because the
 * tab's host (V6), the CLI and the eval tier must all compute the same card.
 *
 * What it reads, and why from the record rather than the result alone: the
 * result cannot say who reviewed and on which model (the seat rows), whether
 * a verifier ran (`verifierSeat`, and `verification_missing` in the limits),
 * or whether the PDF was read (`pdfSeat`) — and the role switched *Off*
 * records no limit at all.
 *
 * What it does NOT read, by design: an impression never decides a standing
 * (it rides along as a median); ADR 0023's seat-level `unverified` mark is a
 * different fact from `checked` and is not read; a concern set aside is not
 * an annotation and is counted by nothing (ADR 0086 §1).
 *
 * **This file is inside the v0.3 stage guard's scope** (`test/no-*.test.ts`):
 * nothing here produces a number for the whole paper or an acceptance
 * prediction, and a structural test over a derived card holds that.
 */

import type {
  PanelDimension,
  Readiness,
  ReviewAnnotation,
  ReviewAssessment,
  ReviewLimit,
  ReviewPdfRecord,
  ReviewResult,
  ReviewStrength,
  Scorecard,
  ScorecardDelta,
  ScorecardDimension,
  ScorecardLevel,
  ScorecardSeat,
  ScorecardStanding,
} from "../contracts/data.js";
import { PANEL_DIMENSIONS } from "../contracts/data.js";
import type { ReviewSeatState } from "../contracts/sessions.js";
import { distinctIssues } from "./review-spans.js";
import { isBlocking, isWithdrawn } from "./verification.js";

/**
 * What `deriveScorecard` reads. Both a `StoredReview` and a `ReviewItem`
 * whose `result` is present satisfy it structurally, so a host, the CLI and a
 * test over a stored file all call the one function.
 */
export interface ScorecardSource {
  result: ReviewResult;
  /** The text reviewers' rows. Absent (a bare result) ⇒ every reviewer the
   *  result names contributes, on an unknown model. */
  seats?: readonly ReviewSeatState[];
  verifierSeat?: ReviewSeatState;
  pdfSeat?: ReviewSeatState;
  pdf?: ReviewPdfRecord;
}

/** The dimensions a TEXT reviewer assesses: the panel's eight but the page's. */
const TEXT_DIMENSIONS: readonly PanelDimension[] = PANEL_DIMENSIONS.filter(
  (d) => d !== "presentation",
);
/** The one dimension the PDF reviewer assesses. */
const PDF_DIMENSIONS: readonly PanelDimension[] = ["presentation"];
/** Where a missing literature makes *nothing raised* a guess. */
const LITERATURE_DIMENSIONS: readonly PanelDimension[] = [
  "originality",
  "positioning",
];

/** A contributing seat, as the derivation needs it. */
interface Contributor {
  reviewer: string;
  model: string;
  /** What it was asked to assess — seven, or `presentation`. */
  dimensions: readonly PanelDimension[];
  /** Its row's `searches`, when the record carries one. */
  searches?: { attempted: number; answered: number };
}

/** Which literature reason a row's zero answers earn (ADR 0089 §7). The caller
 *  has already established that every seat in `listing` searched and none
 *  was answered; this decides only WHY, from the review's `limits`:
 *  `search_budget_spent` says a seat was refused before asking, and
 *  `source_unavailable` says a source it asked did not answer. */
function literatureReason(
  listing: readonly Contributor[],
  limits: readonly ReviewLimit[],
): "no_literature" | "literature_budget" {
  // The budget is claimed only where it is the whole story: a seat that was
  // refused AND had a source fail could have found nothing anyway, and
  // `no_literature` stays true of every zero-answer row, so it is the
  // fallback. The panel's row asks every listing seat, as `declared` does.
  const has = (c: Contributor, kind: ReviewLimit["kind"]) =>
    limits.some(
      (l) => l.kind === kind && "reviewer" in l && l.reviewer === c.reviewer,
    );
  return listing.every(
    (c) => has(c, "search_budget_spent") && !has(c, "source_unavailable"),
  )
    ? "literature_budget"
    : "no_literature";
}

/** The row a dimension belongs to, or `undefined` for a quick action's own. */
function panelDimension(dimension: string): PanelDimension | undefined {
  const lower = dimension.toLowerCase();
  return PANEL_DIMENSIONS.find((d) => d === lower);
}

const SEVERITY_RANK: Readonly<Record<ReviewAnnotation["severity"], number>> = {
  info: 0,
  minor: 1,
  major: 2,
};

/** One distinct issue: its severity is its members' worst, and it blocks
 *  when any member does. */
interface Issue {
  severity: ReviewAnnotation["severity"];
  blocking: boolean;
  members: readonly ReviewAnnotation[];
}

function issuesOf(concerns: readonly ReviewAnnotation[]): Issue[] {
  return distinctIssues(concerns).map((members) => {
    let severity: ReviewAnnotation["severity"] = "info";
    for (const m of members) {
      if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[severity]) {
        severity = m.severity;
      }
    }
    return { severity, blocking: members.some(isBlocking), members };
  });
}

/** What one row — the panel's or a seat's — holds in one dimension. */
interface RowEvidence {
  issues: Issue[];
  strengths: number;
}

/**
 * D7's table: the level the row's evidence supports, or `undefined` when it
 * holds nothing above `info` and no strength — which D8 may then turn into
 * *not assessed*.
 */
function levelOf(
  row: RowEvidence,
  verificationCompleted: boolean,
): ScorecardStanding | undefined {
  const level = ((): ScorecardLevel | undefined => {
    if (row.issues.some((i) => i.severity === "major" && i.blocking)) return 1;
    if (row.issues.some((i) => i.severity === "major")) return 2;
    if (row.issues.some((i) => i.severity === "minor")) return 3;
    if (row.strengths > 0) return 4;
    return undefined;
  })();
  if (level === undefined) return undefined;
  // D9: checked iff a verifier completed AND looked at every concern the
  // level rests on. No verifier reads a strength, so level 4 never is.
  const checked =
    level !== 4 &&
    verificationCompleted &&
    row.issues
      .filter((i) => i.severity !== "info")
      .every((i) => i.members.every((m) => m.verification !== undefined));
  return { kind: "level", level, checked };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The contributing seats, text reviewers first in `seats` order, then the
 *  PDF seat — or, for a bare result, every reviewer the result names. */
function contributorsOf(source: ScorecardSource): {
  text: Contributor[];
  pdf?: Contributor;
} {
  const contributes = (row: ReviewSeatState | undefined): boolean =>
    row !== undefined && row.status === "completed" && row.ledger !== undefined;
  const fromRow = (
    row: ReviewSeatState,
    dimensions: readonly PanelDimension[],
  ): Contributor => ({
    reviewer: row.reviewer,
    model: row.model ?? "",
    dimensions,
    ...(row.searches !== undefined ? { searches: row.searches } : {}),
  });
  const pdf =
    source.pdfSeat !== undefined && contributes(source.pdfSeat)
      ? fromRow(source.pdfSeat, PDF_DIMENSIONS)
      : undefined;

  if (source.seats !== undefined) {
    return {
      text: source.seats
        .filter(contributes)
        .map((row) => fromRow(row, TEXT_DIMENSIONS)),
      ...(pdf !== undefined ? { pdf } : {}),
    };
  }
  // A bare result (no rows at all): every reviewer it names, in order of
  // first appearance, on an unknown model — so the function stays total.
  const named: string[] = [];
  const note = (reviewer: string): void => {
    if (reviewer === source.pdfSeat?.reviewer) return;
    if (!named.includes(reviewer)) named.push(reviewer);
  };
  for (const a of source.result.annotations) note(a.reviewer);
  for (const s of source.result.strengths ?? []) note(s.reviewer);
  for (const a of source.result.assessments ?? []) note(a.reviewer);
  return {
    text: named.map((reviewer) => ({
      reviewer,
      model: "",
      dimensions: TEXT_DIMENSIONS,
    })),
    ...(pdf !== undefined ? { pdf } : {}),
  };
}

/**
 * The scorecard of one stored review (ADR 0087 §3–§4). Pure and total: no
 * I/O, no mutation, the same card for the same record, and a card for any
 * record — a bare result derives with unknown models, and a review stored
 * before V5 derives with no strengths, `null` impressions and nothing
 * imposed for literature.
 */
export function deriveScorecard(source: ScorecardSource): Scorecard {
  const { result } = source;
  const { text, pdf } = contributorsOf(source);
  const contributors = pdf !== undefined ? [...text, pdf] : text;
  const names = new Set(contributors.map((c) => c.reviewer));

  // D9: the review's verification COMPLETED — a verifier ran and nothing
  // says any concern went unchecked.
  const limits = result.limits ?? [];
  const verificationCompleted =
    source.verifierSeat !== undefined &&
    !limits.some((l) => l.kind === "verification_missing");
  // D11: the user's dial, not the outcome — a verification that ran and
  // failed is ON, and the marks say it did not complete.
  const verificationOn = !limits.some(
    (l) => l.kind === "verification_missing" && l.reason === "off",
  );

  // The concerns that stand: refuted ones stay in the result and are
  // excluded here; a set-aside one is not an annotation at all. Normalized
  // to its row's spelling, so two seats' casings are one dimension.
  const concerns = new Map<PanelDimension, ReviewAnnotation[]>();
  for (const a of result.annotations) {
    const d = panelDimension(a.dimension);
    if (d === undefined || isWithdrawn(a) || !names.has(a.reviewer)) continue;
    concerns.set(d, [...(concerns.get(d) ?? []), { ...a, dimension: d }]);
  }
  const strengths = new Map<PanelDimension, ReviewStrength[]>();
  for (const s of result.strengths ?? []) {
    const d = panelDimension(s.dimension);
    if (d === undefined || !names.has(s.reviewer)) continue;
    strengths.set(d, [...(strengths.get(d) ?? []), s]);
  }
  const assessment = (
    reviewer: string,
    d: PanelDimension,
  ): ReviewAssessment | undefined =>
    (result.assessments ?? []).find(
      (a) => a.reviewer === reviewer && panelDimension(a.dimension) === d,
    );

  const evidenceFor = (d: PanelDimension, only?: string): RowEvidence => ({
    issues: issuesOf(
      (concerns.get(d) ?? []).filter(
        (a) => only === undefined || a.reviewer === only,
      ),
    ),
    strengths: (strengths.get(d) ?? []).filter(
      (s) => only === undefined || s.reviewer === only,
    ).length,
  });

  /** D8, over the seats that list `d` for this row (all of them for the
   *  panel's row, one for a seat's own): what *nothing raised* becomes. */
  const unassessed = (
    d: PanelDimension,
    listing: readonly Contributor[],
  ): ScorecardStanding => {
    if (listing.length === 0) {
      // The panel's presentation row with no PDF seat that completed — the
      // role switched Off records neither a limit nor a row.
      return {
        kind: "not_assessed",
        reason: { kind: d === "presentation" ? "no_pdf" : "no_reviewer" },
      };
    }
    // Absent `searches` is unknown, and the harness does not guess.
    if (
      LITERATURE_DIMENSIONS.includes(d) &&
      listing.every(
        (c) => c.searches !== undefined && c.searches.answered === 0,
      )
    ) {
      return {
        kind: "not_assessed",
        reason: { kind: literatureReason(listing, limits) },
      };
    }
    const declared = listing.map((c) => ({
      reviewer: c.reviewer,
      note: assessment(c.reviewer, d)?.notAssessed,
    }));
    if (declared.every((x) => x.note !== undefined)) {
      return {
        kind: "not_assessed",
        reason: {
          kind: "declared",
          by: declared.map((x) => ({
            reviewer: x.reviewer,
            note: x.note as string,
          })),
        },
      };
    }
    return { kind: "nothing_raised" };
  };

  const dimensions: ScorecardDimension[] = PANEL_DIMENSIONS.map((d) => {
    const listing = contributors.filter((c) => c.dimensions.includes(d));
    const evidence = evidenceFor(d);
    // Evidence always wins: a level that rests on a located concern or a
    // strength is never a guess, so D8 is read only where there is neither.
    const standing =
      levelOf(evidence, verificationCompleted) ?? unassessed(d, listing);
    const seats: ScorecardSeat[] = contributors.map((c) => {
      const own = c.dimensions.includes(d);
      const impression = own
        ? (assessment(c.reviewer, d)?.impression ?? null)
        : null;
      return {
        reviewer: c.reviewer,
        model: c.model,
        ...(own
          ? {
              standing:
                levelOf(evidenceFor(d, c.reviewer), verificationCompleted) ??
                unassessed(d, [c]),
            }
          : {}),
        impression,
      };
    });
    const counted = evidence.issues;
    return {
      dimension: d,
      standing,
      issues: {
        blocking: counted.filter((i) => i.severity === "major" && i.blocking)
          .length,
        major: counted.filter((i) => i.severity === "major").length,
        minor: counted.filter((i) => i.severity === "minor").length,
        info: counted.filter((i) => i.severity === "info").length,
      },
      strengths: evidence.strengths,
      seats,
      // Rides along; nothing above reads it.
      impression: median(
        seats.flatMap((s) => (s.impression === null ? [] : [s.impression])),
      ),
    };
  });

  const assessed = dimensions.filter((d) => d.standing.kind !== "not_assessed");
  const levels = assessed.flatMap((d) =>
    d.standing.kind === "level" ? [d.standing] : [],
  );
  const worst = Math.min(...levels.map((l) => l.level));
  const label: Readiness =
    assessed.length === 0
      ? "not_assessed"
      : worst === 1
        ? "blocking"
        : worst === 2
          ? "major"
          : worst === 3
            ? "minor"
            : "none";

  return {
    // The conjunction over the rows that carry a mark: a `nothing_raised`
    // row rests on no concern, so it has nothing that went unchecked.
    readiness: { label, checked: levels.every((l) => l.checked) },
    notAssessed: dimensions.length - assessed.length,
    dimensions,
    panel: {
      reviewers: text.map((c) => ({ reviewer: c.reviewer, model: c.model })),
      verificationOn,
      ...(pdf !== undefined ? { pdf: { model: pdf.model } } : {}),
    },
  };
}

/** D11's order, worst first: 1 < 2 < 3 < nothing raised < 4. */
function rankOf(standing: ScorecardStanding): number {
  if (standing.kind === "nothing_raised") return 3;
  if (standing.kind === "level")
    return standing.level === 4 ? 4 : standing.level - 1;
  return -1;
}

/**
 * Two cards compared per dimension, and only where comparable (ADR 0087 §5).
 * Which stored review is the *previous* one is the caller's to choose; this
 * decides only whether two cards may be compared, and how each row moved.
 */
export function scorecardDelta(
  previous: Scorecard,
  current: Scorecard,
): ScorecardDelta {
  const models = (card: Scorecard): string[] =>
    card.panel.reviewers.map((r) => r.model).sort();
  const before = models(previous);
  const after = models(current);
  // Unknown is never *same* (ADR 0070 §4), and the multiset must match —
  // which implies the same number of reviewers.
  const sameReviewers =
    before.length === after.length &&
    before.every((m, i) => m !== "" && m === after[i]);
  const sameDial =
    previous.panel.verificationOn === current.panel.verificationOn;
  const pdfBefore = previous.panel.pdf?.model;
  const samePdf =
    pdfBefore !== undefined &&
    pdfBefore !== "" &&
    pdfBefore === current.panel.pdf?.model;

  return {
    dimensions: PANEL_DIMENSIONS.map((d) => {
      const from = previous.dimensions.find((x) => x.dimension === d)?.standing;
      const to = current.dimensions.find((x) => x.dimension === d)?.standing;
      if (d === "presentation" && !samePdf) {
        return { dimension: d, comparable: false, reason: "pdf" };
      }
      if (d !== "presentation" && !sameReviewers) {
        return { dimension: d, comparable: false, reason: "reviewers" };
      }
      if (d !== "presentation" && !sameDial) {
        return { dimension: d, comparable: false, reason: "verification" };
      }
      if (
        from === undefined ||
        to === undefined ||
        from.kind === "not_assessed" ||
        to.kind === "not_assessed"
      ) {
        return { dimension: d, comparable: false, reason: "not_assessed" };
      }
      const change =
        rankOf(to) > rankOf(from)
          ? "improved"
          : rankOf(to) < rankOf(from)
            ? "worsened"
            : "unchanged";
      return { dimension: d, comparable: true, from, to, change };
    }),
  };
}
