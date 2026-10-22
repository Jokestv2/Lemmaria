/**
 * The scorecard, measured — V5 (ADR 0087, D15).
 *
 * `deriveScorecard` is the harness's: a pure view of a stored review, a level
 * per dimension computed from what survived, an impression that rides along.
 * This file only READS it, the way `recall.ts` and `agreement.ts` read a
 * review — for the `planted-defects` judge and the live rows, and never for a
 * user (ADR 0070 §6). Reported, never gated (§5): the first reading is the
 * floor.
 *
 * Three rules shape every line it prints:
 *
 * - **Unmeasured is not a card.** A panel no seat of which produced a ledger
 *   the driver could read derives a card of `no_reviewer` rows — which, taken
 *   off a report, reads as a panel that assessed nothing. It prints one
 *   *unmeasured* line and no figure (ADR 0071 §1's precedent, R5's I1).
 * - **Levels and impressions apart.** The design's bet is that the two behave
 *   differently — a level moves with what located, an impression with what a
 *   reviewer felt — so no line mixes them.
 * - **Numbers only as levels and impressions.** A dimension not assessed is
 *   named with its reason, never counted; a declaration names who declared,
 *   never what they wrote (third-party text, invariant 6 rule 1). The seats'
 *   own counts — strengths, searches — are printed by `formatSeatReadings`,
 *   apart from the report.
 */

import type {
  PanelDimension,
  ReviewItem,
  Scorecard,
  ScorecardDelta,
  ScorecardStanding,
} from "@lemmaria/harness";
import { deriveScorecard, scorecardDelta } from "@lemmaria/harness";

/** What one seat's record says about its strengths and its searches. */
export interface SeatReading {
  reviewer: string;
  model: string;
  /**
   * Absent when this seat's ledger was never read — it did not complete, or
   * its report did not parse — so it has no strength count, not a zero one.
   */
  strengths?: {
    /** Strengths the result holds for this reviewer — each one located. */
    located: number;
    /** What its `strengths_lost` limit names, dropped and rejected together. */
    lost: number;
  };
  /** Absent on a row stored without the fact: unknown, never zero. */
  searches?: { attempted: number; answered: number };
}

export interface ScorecardReading {
  /** False when no seat's ledger was read — then there is no card at all. */
  measured: boolean;
  card?: Scorecard;
  perSeat: SeatReading[];
}

export function measureScorecard(item: ReviewItem): ScorecardReading {
  const result = item.result;
  if (result === undefined) return { measured: false, perSeat: [] };
  const card = deriveScorecard({
    result,
    seats: item.seats,
    ...(item.verifierSeat !== undefined
      ? { verifierSeat: item.verifierSeat }
      : {}),
    ...(item.pdfSeat !== undefined ? { pdfSeat: item.pdfSeat } : {}),
    ...(item.pdf !== undefined ? { pdf: item.pdf } : {}),
  });
  // The card's own contributors are the readable seats: a seat counts when it
  // completed AND its ledger was read — the same fact the derivation uses, so
  // the two can never disagree about whether anything was measured.
  if (card.panel.reviewers.length === 0 && card.panel.pdf === undefined) {
    return { measured: false, perSeat: [] };
  }
  const lost = new Map<string, number>();
  for (const limit of result.limits ?? []) {
    if (limit.kind !== "strengths_lost") continue;
    lost.set(
      limit.reviewer,
      (lost.get(limit.reviewer) ?? 0) +
        limit.dropped.length +
        limit.rejected.length,
    );
  }
  const rows =
    item.pdfSeat !== undefined ? [...item.seats, item.pdfSeat] : item.seats;
  return {
    measured: true,
    card,
    perSeat: rows.map((seat) => ({
      reviewer: seat.reviewer,
      model: seat.model,
      // The derivation's own test for a readable seat: completed, ledger read.
      ...(seat.status === "completed" && seat.ledger !== undefined
        ? {
            strengths: {
              located: (result.strengths ?? []).filter(
                (s) => s.reviewer === seat.reviewer,
              ).length,
              lost: lost.get(seat.reviewer) ?? 0,
            },
          }
        : {}),
      ...(seat.searches !== undefined ? { searches: seat.searches } : {}),
    })),
  };
}

/** A standing as the reports print it: the level with its mark, or the word,
 *  or *not assessed* with its reason — never a number standing for a reason. */
export function standingText(standing: ScorecardStanding): string {
  if (standing.kind === "level") {
    return `${standing.level}:${standing.checked ? "checked" : "unchecked"}`;
  }
  if (standing.kind === "nothing_raised") return "nothing_raised";
  const { reason } = standing;
  return reason.kind === "declared"
    ? `not_assessed:declared(${reason.by.map((b) => b.reviewer).join(",")})`
    : `not_assessed:${reason.kind}`;
}

/** Whether two standings are the same standing — the mark aside, since a
 *  verifier that did not complete is not the panel changing its mind. */
function standingKey(standing: ScorecardStanding): string {
  if (standing.kind === "level") return `level:${standing.level}`;
  if (standing.kind === "nothing_raised") return "nothing_raised";
  return `not_assessed:${standing.reason.kind}`;
}

/** The panel's impression, a median: one decimal, or `null`. */
const median = (value: number | null): string =>
  value === null ? "null" : value.toFixed(1);

/** One seat's own impression, as written: an integer, or `null`. */
const own = (value: number | null): string =>
  value === null ? "null" : String(value);

const row = (
  card: Scorecard,
  cell: (d: Scorecard["dimensions"][number]) => string,
): string => card.dimensions.map((d) => `${d.dimension}=${cell(d)}`).join(" ");

/** The judge's levels line (O18): the panel's standing per dimension. */
export function scorecardLine(card: Scorecard): string {
  return `scorecard: ${row(card, (d) => standingText(d.standing))}`;
}

/** The judge's impressions line (O18), on a line of its own. */
export function impressionsLine(card: Scorecard): string {
  return `impressions: ${row(card, (d) => median(d.impression))}`;
}

const UNMEASURED =
  "scorecard: unmeasured — no seat produced a ledger the driver could read, so there is no card; record it as unmeasured, never as a floor";

export function formatScorecardReport(reading: ScorecardReading): string {
  const { card } = reading;
  if (!reading.measured || card === undefined) return UNMEASURED;
  const reviewers = card.panel.reviewers.map((r) => r.reviewer).join(", ");
  const unassessed = card.dimensions.flatMap((d) => {
    if (d.standing.kind !== "not_assessed") return [];
    const { reason } = d.standing;
    return [
      reason.kind === "declared"
        ? `${d.dimension} (declared by ${reason.by.map((b) => b.reviewer).join(", ")})`
        : `${d.dimension} (${reason.kind})`,
    ];
  });
  const lines = [
    `scorecard — readiness ${card.readiness.label}, ${card.readiness.checked ? "checked" : "unchecked"}; ` +
      `verification ${card.panel.verificationOn ? "on" : "off"}; ` +
      `reviewers ${reviewers || "none"}${card.panel.pdf !== undefined ? " + the PDF reviewer" : ""}`,
    `  levels: ${row(card, (d) => standingText(d.standing))}`,
    `  impressions: ${row(card, (d) => median(d.impression))}`,
    `  not assessed: ${unassessed.join(", ") || "nothing"}`,
  ];
  // Each seat's spread, over its own dimensions only — a seat is absent from
  // a row it was not asked to assess, and so from this line.
  const names = card.dimensions[0]?.seats.map((s) => s.reviewer) ?? [];
  for (const name of names) {
    const mine = card.dimensions.flatMap((d) => {
      const seat = d.seats.find((s) => s.reviewer === name);
      return seat?.standing === undefined ? [] : [{ d, seat }];
    });
    lines.push(
      `  ${name} levels: ${mine.map(({ d, seat }) => `${d.dimension}=${standingText(seat.standing as ScorecardStanding)}`).join(" ")}`,
      `  ${name} impressions: ${mine.map(({ d, seat }) => `${d.dimension}=${own(seat.impression)}`).join(" ")}`,
    );
  }
  return lines.join("\n");
}

/** Each seat's strengths and searches — the counts the report leaves out. */
export function formatSeatReadings(reading: ScorecardReading): string {
  if (!reading.measured) return "  per seat: unmeasured";
  return reading.perSeat
    .map((s) => {
      const strengths =
        s.strengths === undefined
          ? "strengths unmeasured (no ledger read)"
          : `strengths ${s.strengths.located} located, ${s.strengths.lost} lost`;
      const searches =
        s.searches === undefined
          ? "searches unrecorded"
          : `searches ${s.searches.answered} of ${s.searches.attempted} answered`;
      return `  ${s.reviewer} [${s.model || "unknown model"}]: ${strengths}; ${searches}`;
    })
    .join("\n");
}

export interface DimensionMovement {
  dimension: PanelDimension;
  standing: {
    from: string;
    to: string;
    /** The level or the kind changed; the mark alone is not a move. */
    moved: boolean;
    /** `scorecardDelta`'s direction, present only where the two cards may be
     *  compared at all (ADR 0087 §5). */
    change?: "improved" | "worsened" | "unchanged";
  };
  impression: { from: number | null; to: number | null; moved: boolean };
}

export interface ReadingComparison {
  label: string;
  /** False when either side is unmeasured — then nothing is compared. */
  measured: boolean;
  dimensions: DimensionMovement[];
}

/**
 * Two readings, per dimension: the panel standing on each side and whether it
 * moved, the impression median on each side and whether it moved (D16's L4 —
 * test–retest, sensitivity, laundering). Nothing is judged here; a movement is
 * printed, and what it means is the reading's.
 */
export function compareReadings(
  a: ScorecardReading,
  b: ScorecardReading,
  label: string,
): ReadingComparison {
  const before = a.measured ? a.card : undefined;
  const after = b.measured ? b.card : undefined;
  if (before === undefined || after === undefined) {
    return { label, measured: false, dimensions: [] };
  }
  const delta: ScorecardDelta = scorecardDelta(before, after);
  return {
    label,
    measured: true,
    dimensions: before.dimensions.flatMap((d): DimensionMovement[] => {
      const other = after.dimensions.find((o) => o.dimension === d.dimension);
      if (other === undefined) return [];
      const row = delta.dimensions.find((r) => r.dimension === d.dimension);
      return [
        {
          dimension: d.dimension,
          standing: {
            from: standingText(d.standing),
            to: standingText(other.standing),
            moved: standingKey(d.standing) !== standingKey(other.standing),
            ...(row?.comparable === true ? { change: row.change } : {}),
          },
          impression: {
            from: d.impression,
            to: other.impression,
            moved: d.impression !== other.impression,
          },
        },
      ];
    }),
  };
}

export function formatComparison(comparison: ReadingComparison): string {
  const { label } = comparison;
  if (!comparison.measured) {
    return `${label}: unmeasured — one side produced no ledger the driver could read`;
  }
  const levels = comparison.dimensions.map(({ dimension, standing }) => {
    const movedText = standing.moved ? "moved" : "held";
    const change =
      standing.moved && standing.change !== undefined
        ? ` (${standing.change})`
        : "";
    return `${dimension} ${standing.from}→${standing.to} ${movedText}${change}`;
  });
  const impressions = comparison.dimensions.map(
    ({ dimension, impression }) =>
      `${dimension} ${median(impression.from)}→${median(impression.to)} ${impression.moved ? "moved" : "held"}`,
  );
  return [
    `${label} — levels: ${levels.join(" · ")}`,
    `${label} — impressions: ${impressions.join(" · ")}`,
  ].join("\n");
}
