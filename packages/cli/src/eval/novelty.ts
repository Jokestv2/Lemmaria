/**
 * The novelty probe's instrument (V2, ADR 0078; plan D13).
 *
 * **What it measures.** A reviewer handed a paper that re-derives a known work
 * under another name either locates that work and cites it, or does not. V2
 * makes the first outcome *checkable* — an `originality` concern must carry a
 * paper one of the seat's own searches returned — so the probe asks the one
 * question the protocol now lets the record answer: **did a seat cite the
 * known paper, and under which dimension?**
 *
 * **What it refuses to measure.** Not whether the review was good. The
 * literature is a moving index and a panel may legitimately cite no paper at
 * all, so this reports `found/asked` and never a bare percentage — the plan's
 * acceptance gate promises none of the numbers, *"including a probe in which
 * no reviewer finds the known paper, which is a finding for the Done record
 * and never a reason to reword a rule until one does."*
 *
 * It lives here and not in the harness for ADR 0070 §6's reason: a measurement
 * is not part of the product's surface.
 */

import { readFile } from "node:fs/promises";
import {
  LITERATURE_SOURCE_ORDER,
  type ReviewItem,
  type ReviewLimit,
  sameTitle,
} from "@lemmaria/harness";
import type { DefectSpan } from "./recall.js";

/**
 * The probe's ground truth, read from `probe.json` — which lives OUTSIDE both
 * manuscript directories (ADR 0070's layout rule), so no seat can read the
 * answer out of the paper it is reviewing.
 */
export interface NoveltyProbe {
  fixture: string;
  /** The manuscript the claims are in, workspace-relative. */
  file: string;
  /** The work the paper re-derives without citing. */
  known: {
    /** Exactly as the index returns it — what `sameTitle` compares against. */
    title: string;
    arxiv: string;
    doi?: string;
  };
  /** Where the paper claims the known work's contribution as new. */
  claims: DefectSpan[];
}

/** What one seat did with the literature, read from the panel's own record. */
export interface ReviewerNovelty {
  reviewer: string;
  /** Concerns this seat raised whose evidence is a paper. */
  paperEvidence: number;
  /** One of them is the known work, by `sameTitle`. */
  citedKnown: boolean;
  /** The dimensions it cited the known work under, in first-seen order. */
  citedUnder: string[];
  /** Entries this seat lost to a paper no search of its own returned. */
  notInResults: number;
  /** Results withheld from it because they were the manuscript itself. */
  ownTitleWithheld: number;
}

export interface NoveltyReport {
  /**
   * One row per seat that could answer at all — a readable ledger.
   *
   * **The denominator of `found/asked` is this list's length**, so a seat that
   * produced nothing readable is absent from it rather than counted as a seat
   * that looked and missed. `found 0/3` on a panel where one seat died is a
   * fabricated zero of exactly the kind ADR 0070 §5 forbids, and the honest
   * reading is `found 0/2`, with the third named below.
   */
  reviewers: ReviewerNovelty[];
  /**
   * Seats left out of `reviewers`, by name — present only when non-empty.
   *
   * Shrinking a denominator silently is its own dishonesty, so the seats that
   * could not answer are named rather than merely subtracted.
   */
  unreadable?: string[];
  /** How many seats cited the known work. The numerator of `found/asked`. */
  citingKnown: number;
  /**
   * Whether this run measured anything at all.
   *
   * **False is not zero, and the two must never print alike.** A panel whose
   * seats produced no readable ledger, or whose every source was down, did not
   * *fail to find* the known paper — it was never in a position to look. A
   * record reporting those as `0/3` would put a floor in the Done record that
   * no reviewer's behaviour earned.
   */
  measured: boolean;
}

/** `probe.json`, validated. Refuses rather than repairs — `readManifest`'s rule. */
export async function readProbe(path: string): Promise<NoveltyProbe> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as NoveltyProbe;
  if (typeof parsed?.fixture !== "string" || parsed.fixture === "") {
    throw new Error(`${path}: not a novelty probe -- no fixture name`);
  }
  if (typeof parsed?.file !== "string" || parsed.file === "") {
    throw new Error(`${path}: not a novelty probe -- no manuscript file`);
  }
  if (typeof parsed?.known?.title !== "string" || parsed.known.title === "") {
    throw new Error(
      `${path}: the probe names no known work, so nothing could ever be found`,
    );
  }
  if (typeof parsed.known.arxiv !== "string" || parsed.known.arxiv === "") {
    throw new Error(
      `${path}: known work "${parsed.known.title}" has no arxiv id`,
    );
  }
  if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) {
    throw new Error(
      `${path}: the probe records no claim span, so it asserts nothing about the paper`,
    );
  }
  for (const claim of parsed.claims) {
    if (typeof claim?.anchor !== "string" || claim.anchor === "") {
      throw new Error(`${path}: a claim span has no anchor`);
    }
    if (typeof claim.line !== "number" || !Number.isInteger(claim.line)) {
      throw new Error(`${path}: claim "${claim.anchor}" has no integer line`);
    }
  }
  return parsed;
}

/** Limits of one kind, for one reviewer. */
function limitsFor<K extends ReviewLimit["kind"]>(
  limits: readonly ReviewLimit[],
  kind: K,
  reviewer: string,
): Array<Extract<ReviewLimit, { kind: K }>> {
  return limits.filter(
    (l): l is Extract<ReviewLimit, { kind: K }> =>
      l.kind === kind && (l as { reviewer?: string }).reviewer === reviewer,
  );
}

/**
 * Whether every source this seat asked came back unusable.
 *
 * Read from `source_unavailable`, which the panel records one row per (source,
 * status) pair — **and only for a source that did NOT answer**. A source that
 * answered records nothing, so "none answered" cannot be read off the record
 * directly; what can is whether the failures name the whole shipping set. That
 * is exact for the case this instrument exists for (the live tier, where all
 * four real providers run) and deliberately conservative elsewhere: a run with
 * one injected provider reads as *measured*, which is true of it.
 */
function noSourceAnswered(
  limits: readonly ReviewLimit[],
  reviewer: string,
): boolean {
  const down = new Set(
    limitsFor(limits, "source_unavailable", reviewer).map((l) => l.source),
  );
  return LITERATURE_SOURCE_ORDER.every((name) => down.has(name));
}

export function measureNovelty(
  item: ReviewItem,
  probe: NoveltyProbe,
): NoveltyReport {
  const limits = item.result?.limits ?? [];
  const annotations = item.result?.annotations ?? [];
  // The seats, never the synthesis or the verifier: those two read across the
  // panel rather than the literature, and counting them as reviewers is the
  // mistake `verifierSeat`'s own doc comment was written to prevent.
  // A seat with no readable ledger produced no countable answer at all, so it
  // is absent from the measurement rather than a zero inside it.
  const readable = item.seats.filter((s) => s.ledger !== undefined);
  const unreadable = item.seats
    .filter((s) => s.ledger === undefined)
    .map((s) => s.reviewer);
  const reviewers = readable.map<ReviewerNovelty>((seat) => {
    const mine = annotations.filter((a) => a.reviewer === seat.reviewer);
    const papers = mine.filter((a) => a.evidence?.kind === "paper");
    const citedUnder: string[] = [];
    for (const a of papers) {
      if (a.evidence?.kind !== "paper") continue;
      if (!sameTitle(a.evidence.title, probe.known.title)) continue;
      if (!citedUnder.includes(a.dimension)) citedUnder.push(a.dimension);
    }
    return {
      reviewer: seat.reviewer,
      paperEvidence: papers.length,
      citedKnown: citedUnder.length > 0,
      citedUnder,
      notInResults: limitsFor(limits, "anchors_dropped", seat.reviewer).reduce(
        (n, l) =>
          n + l.anchors.filter((a) => a.reason === "not_in_results").length,
        0,
      ),
      ownTitleWithheld: seat.ownTitleWithheld ?? 0,
    };
  });

  const measured =
    readable.length > 0 &&
    !readable.every((s) => noSourceAnswered(limits, s.reviewer));

  return {
    reviewers,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    citingKnown: reviewers.filter((r) => r.citedKnown).length,
    measured,
  };
}

/**
 * The report, as prose.
 *
 * `found/asked` and never a bare percentage: three seats is a sample of three,
 * and "33%" invites a reader to compare it against a number taken on a
 * different panel of a different size.
 */
export function formatNoveltyReport(
  report: NoveltyReport,
  probe: NoveltyProbe,
): string {
  const head = `novelty probe: ${probe.fixture} -- known work "${probe.known.title}" (arXiv:${probe.known.arxiv})`;
  if (!report.measured) {
    return [
      head,
      "  not measured -- no seat produced a readable ledger, or no source answered",
    ].join("\n");
  }
  const rows = report.reviewers.map((r) => {
    const cited = r.citedKnown
      ? `cited the known work under ${r.citedUnder.join(", ")}`
      : "did not cite the known work";
    const dropped =
      r.notInResults > 0 ? `, ${r.notInResults} not in its results` : "";
    const withheld =
      r.ownTitleWithheld > 0 ? `, ${r.ownTitleWithheld} withheld` : "";
    return `    ${r.reviewer}: ${r.paperEvidence} paper evidence, ${cited}${dropped}${withheld}`;
  });
  const left =
    report.unreadable === undefined
      ? []
      : [
          `    (${report.unreadable.join(", ")} produced no readable ledger, and is not in the denominator)`,
        ];
  return [
    head,
    `  found ${report.citingKnown}/${report.reviewers.length} reviewers citing it`,
    ...rows,
    ...left,
  ].join("\n");
}
