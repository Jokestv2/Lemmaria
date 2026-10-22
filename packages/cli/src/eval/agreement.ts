/**
 * The hivemind measurement — agreement between reviewers, from the record
 * (ADR 0070 §4).
 *
 * ## The question the field asks
 *
 * A panel of N reviewers sharing one model may be one reviewer with N voices.
 * Since R9 the topology that could answer it exists — each reviewer runs on a
 * model the user picked, and the record says which (`ReviewSeatState.model`,
 * ADR 0069 §4). So the question becomes arithmetic: do two reviewers on the
 * SAME model agree more than two on different ones?
 *
 * ## Why the CLI computes it and the cross-review never sees it
 *
 * ADR 0069 §6 keeps the cross-review blind to which model produced which
 * concern, deliberately. R5 measures what that blindness costs or buys rather
 * than undoing it, so the number is reconstructed here — ids → reviewer →
 * the record's model — and shown to no model and no user.
 *
 * ## Two numbers per pair
 *
 * `jaccardDefects` is the field's own shape (per-paper Jaccard over what each
 * reviewer flagged) taken over GROUND TRUTH, so it says whether two reviewers
 * found the same errors. It needs a manifest. `spanOverlap` needs none, so it
 * is the number that also works on the operator's own manuscript (J2) — and
 * the two disagreeing is itself informative: reviewers landing on the same
 * lines while finding different planted errors is a panel agreeing about where
 * to look and not about what is wrong.
 *
 * Reported, never gated. The first measurement is the floor (ADR 0070 §5).
 */

import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewSpan,
} from "@lemmaria/harness";
import { spansOverlap } from "@lemmaria/harness";
import type { RecallReport } from "./recall.js";

export interface PairAgreement {
  a: string;
  b: string;
  /** `null` when either seat's model is unrecorded — unknown, never "same". */
  sameModel: boolean | null;
  jaccardDefects: number | null;
  spanOverlap: number | null;
}

export interface GroupAgreement {
  pairs: number;
  meanJaccardDefects: number | null;
  meanSpanOverlap: number | null;
}

export interface AgreementReport {
  pairs: PairAgreement[];
  sameModel: GroupAgreement;
  crossModel: GroupAgreement;
  /**
   * What the cross-review managed to say, and how much of it reads ACROSS
   * models. `interpretSynthesis` has always demanded two different reviewers
   * per entry; under R3's one-model topology that could never mean two
   * different models, which is why R9 had to land before this could be taken.
   */
  crossReview: {
    consensus: number;
    consensusCrossModel: number;
    disagreements: number;
    disagreementsCrossModel: number;
  };
}

/** Claim and located evidence both point somewhere; `missing` points nowhere,
 *  and a `paper` points outside the manuscript (V2, ADR 0078, D13). */
function pointers(annotation: ReviewAnnotation): ReviewSpan[] {
  const found = [annotation.span];
  if (annotation.evidence?.kind === "span") found.push(annotation.evidence);
  return found;
}

/** Two concerns overlap when any pointer of one meets any pointer of the other
 *  — the harness's span rule (`spansOverlap`, V5, ADR 0087 §4), applied over
 *  claim AND evidence pointers: this instrument's measured definition (ADR
 *  0070 §4), which the scorecard's claim-only *distinct issues* do not share. */
function touches(left: ReviewAnnotation, right: ReviewAnnotation): boolean {
  for (const a of pointers(left)) {
    for (const b of pointers(right)) {
      if (spansOverlap(a, b)) return true;
    }
  }
  return false;
}

function jaccard(left: string[], right: string[]): number | null {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return null;
  const other = new Set(right);
  const shared = left.filter((id) => other.has(id)).length;
  return shared / union.size;
}

/**
 * Symmetric coverage: how much of each side the other side reaches.
 *
 * `(|A reached| + |B reached|) / (|A| + |B|)` rather than a Jaccard over
 * annotation ids, because ids are per-reviewer and never shared — two
 * reviewers quoting the same line produce two different ids, and an id-Jaccard
 * would read 0 for perfect agreement.
 */
function overlapRatio(
  left: ReviewAnnotation[],
  right: ReviewAnnotation[],
): number | null {
  if (left.length === 0 && right.length === 0) return null;
  const reached =
    left.filter((a) => right.some((b) => touches(a, b))).length +
    right.filter((b) => left.some((a) => touches(a, b))).length;
  return reached / (left.length + right.length);
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

function group(pairs: PairAgreement[]): GroupAgreement {
  return {
    pairs: pairs.length,
    meanJaccardDefects: mean(pairs.map((p) => p.jaccardDefects)),
    meanSpanOverlap: mean(pairs.map((p) => p.spanOverlap)),
  };
}

export function measureAgreement(
  item: ReviewItem,
  recall?: RecallReport,
): AgreementReport {
  const annotations = item.result?.annotations ?? [];
  const mine = (reviewer: string): ReviewAnnotation[] =>
    annotations.filter((a) => a.reviewer === reviewer);

  const pairs: PairAgreement[] = [];
  for (let i = 0; i < item.seats.length; i++) {
    for (let j = i + 1; j < item.seats.length; j++) {
      const a = item.seats[i] as (typeof item.seats)[number];
      const b = item.seats[j] as (typeof item.seats)[number];
      // Unknown is never "same". `model` is required by the contract and
      // replay normalizes an absent one to "", but a falsy check costs
      // nothing and an absent model reading as same-model would
      // manufacture the hivemind finding this measurement exists to find.
      const known = Boolean(a.model) && Boolean(b.model);
      pairs.push({
        a: a.reviewer,
        b: b.reviewer,
        sameModel: known ? a.model === b.model : null,
        jaccardDefects:
          recall === undefined
            ? null
            : jaccard(
                recall.perReviewer[a.reviewer]?.found ?? [],
                recall.perReviewer[b.reviewer]?.found ?? [],
              ),
        spanOverlap: overlapRatio(mine(a.reviewer), mine(b.reviewer)),
      });
    }
  }

  // ids → reviewer → the model the record says it ran on. The cross-review is
  // told none of this (ADR 0069 §6); it is reconstructed after the fact.
  const modelOf = new Map(item.seats.map((s) => [s.reviewer, s.model]));
  const reviewerOf = new Map(annotations.map((a) => [a.id, a.reviewer]));
  const spansModels = (ids: string[]): boolean => {
    const models = new Set(
      ids.map((id) => modelOf.get(reviewerOf.get(id) ?? "") ?? ""),
    );
    models.delete("");
    return models.size >= 2;
  };
  const consensus = item.result?.synthesis?.consensus ?? [];
  const disagreements = item.result?.synthesis?.disagreements ?? [];

  return {
    pairs,
    sameModel: group(pairs.filter((p) => p.sameModel === true)),
    crossModel: group(pairs.filter((p) => p.sameModel === false)),
    crossReview: {
      consensus: consensus.length,
      consensusCrossModel: consensus.filter((e) => spansModels(e.ids)).length,
      disagreements: disagreements.length,
      disagreementsCrossModel: disagreements.filter((e) => spansModels(e.ids))
        .length,
    },
  };
}

const show = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(3);

export function formatAgreementReport(report: AgreementReport): string {
  const pairs = report.pairs.map(
    (p) =>
      `${p.a}+${p.b}[${p.sameModel === null ? "unknown" : p.sameModel ? "same" : "cross"}]` +
      `=defects:${show(p.jaccardDefects)}/spans:${show(p.spanOverlap)}`,
  );
  const summarise = (label: string, g: GroupAgreement): string =>
    `${label}: ${g.pairs} pair(s), defects:${show(g.meanJaccardDefects)}, spans:${show(g.meanSpanOverlap)}`;
  return [
    `agreement — ${summarise("same-model", report.sameModel)}; ${summarise("cross-model", report.crossModel)}`,
    `  cross-review: ${report.crossReview.consensus} consensus (${report.crossReview.consensusCrossModel} across models), ` +
      `${report.crossReview.disagreements} disagreement(s) (${report.crossReview.disagreementsCrossModel} across models)`,
    `  ${pairs.join(" ")}`,
  ].join("\n");
}
