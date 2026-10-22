/**
 * Planted-defect recall — the instrument R5 measures a review with (ADR 0070).
 *
 * ## What it measures, and what it deliberately does not
 *
 * Six milestones built a review panel and none of them said how good it is.
 * R3's panel found *"the empty Method and Experiments sections"* on a fixture
 * whose only defects were those two sections; R9's mixed panel located 4, 2 and
 * 4 concerns on the same fixture. Those are counts of what the panel **said**,
 * not of what it **found** — a panel raising nine unfounded concerns scores the
 * same. Recall on defects planted by hand separates the two.
 *
 * It is a number about the **reviewers**, never about the manuscript. Nothing
 * here is, or is derived into, a score of a paper — that is the stage's *no
 * score* principle and it is asserted, not merely intended (O4).
 *
 * ## Why a span rule, and no judge model
 *
 * The field's benchmark (arXiv 2606.19749, Appendix C) matches in two stages: a
 * fuzzy substring cover at τ = 0.75, because its reviewers quote loosely, and
 * then a judge model rating whether the comment names the injected error.
 * Lemmaria needs neither. The harness has already located every concern
 * byte-exactly in the manuscript's own bytes ([ADR 0060] §2 — *the harness
 * locates, the model never supplies a position*), so the substring stage is at
 * 100% by construction; and what remains of the judge's question — *is a
 * concern on this line about this error?* — is answered by a manifest that
 * lists **every span where the error is visible** plus a dimension gate.
 *
 * The cost is stated rather than hidden: a concern that names the planted error
 * from a span the manifest did not list is a **miss**. That is the price of a
 * number with no second model's unmeasured errors inside it, and the operator's
 * audit of the admissible spans (J1) is where it is paid down.
 *
 * [ADR 0060]: ../../../../Lemmaria-design-doc/docs/adr/0060-the-concern-ledger.md
 */

import { readFile } from "node:fs/promises";
import type {
  LedgerCounts,
  ReviewAnnotation,
  ReviewItem,
  ReviewSeatState,
  ReviewSpan,
} from "@lemmaria/harness";
import { normalizePath, spansOverlap } from "@lemmaria/harness";

/** The field's four categories (arXiv 2606.19749, Table 13), adopted whole. */
export type DefectCategory = "surface" | "claim" | "reasoning" | "experimental";

export const DEFECT_CATEGORIES: readonly DefectCategory[] = [
  "surface",
  "claim",
  "reasoning",
  "experimental",
];

/**
 * The dimensions a concern must be raised under to count as a detection.
 *
 * Panel-wide rather than per defect: every planted error is a fault of
 * soundness or of a claim, and sixteen per-defect dimension lists would be
 * sixteen judgement calls where one auditable rule does. A `language` concern
 * on a sign-flipped equation is not a detection of the sign flip — it is
 * counted in `spanOnlyHits`, so the gate's effect is visible rather than
 * assumed.
 */
export const MATCHING_DIMENSIONS: readonly string[] = ["soundness", "claims"];

/** One place in the planted manuscript where a defect is visible. */
export interface DefectSpan {
  /** Verbatim text, occurring exactly once in the planted paper. */
  anchor: string;
  /** 1-based, recorded from the assembled file and re-derived by O1. */
  line: number;
  /** Present only when the anchor spans more than one line. */
  endLine?: number;
  /**
   * X5 (ADR 0074 §10): the manuscript file this span sits in, workspace-
   * relative. **Absent means the manifest's own `file`**, which is why the
   * flat fixture — where no span carries one — matches exactly as it did.
   *
   * It lives on the SPAN and not on the defect because one defect legitimately
   * spans two files: a claim in the prose whose numbers are in an `\input`-ed
   * table, where either anchor is an admissible way to point at the error.
   */
  file?: string;
}

export interface PlantedDefect {
  id: string;
  category: DefectCategory;
  subtype: string;
  /** The text as `clean/main.tex` has it. */
  original: string;
  /** The replacement — and the defect's primary admissible span. */
  perturbed: string;
  spans: DefectSpan[];
  /** The verifier's *how a careful reader can tell*, so J1 is a read. */
  tell: string;
}

/**
 * V1 (ADR 0076, plan D11): a careless complaint the manuscript already
 * answers. Both lists point into the UNPERTURBED text — no fixture byte moved
 * to plant one — and no trap span overlaps a defect span, so a trap hit can
 * never be a defect hit.
 */
export interface Trap {
  /** `T<n>`, unique within the manifest. */
  id: string;
  /** The complaint a careless reader raises at the bait. */
  complaint: string;
  /** Where the complaint would anchor. */
  bait: DefectSpan[];
  /** The passage elsewhere that settles it — a counter on any one counts. */
  answer: DefectSpan[];
  /** How a careful reader can tell, so a trap is a read and not a claim. */
  tell: string;
}

export interface DefectManifest {
  fixture: string;
  /** The manuscript every span is in, workspace-relative. */
  file: string;
  categories: DefectCategory[];
  defects: PlantedDefect[];
  /** V1: absent means none — every manifest before V1 reads as it did. */
  traps?: Trap[];
}

/** Which concerns found a defect, and who raised them. */
export interface DefectHit {
  defect: string;
  ids: string[];
  reviewers: string[];
}

/**
 * A concern that reached more than one planted defect, and which one the rule
 * credited it with.
 *
 * Reported because the rule has to pick, and a pick an operator cannot see is
 * a number they cannot audit. Two defects sharing an admissible span is
 * legitimate and sometimes necessary — `C1`'s objection and `C2`'s both point
 * at the same Table 1 row — so the contest is a property of the manifest, not
 * a defect in it.
 */
export interface ContestedConcern {
  id: string;
  credited: string;
  /** The defects the rule passed over, in the order it considered them. */
  alsoReached: string[];
}

/** `recall` is `null` — never `NaN` — when nothing was planted. */
export interface CategoryRecall {
  planted: number;
  found: number;
  recall: number | null;
}

export interface ReviewerTally {
  model: string;
  /** Located plus dropped: everything the reviewer tried to say. */
  concerns: number;
  located: number;
  dropped: number;
  majors: number;
  blockingMajors: number;
  found: string[];
  /**
   * X5 (ADR 0074 §8): the seat's own tally, copied rather than re-derived.
   *
   * The harness counted these while it had the ledger in hand — including the
   * FIRST pass's, which no longer exists by the time the item is written — so
   * re-deriving them here could only ever produce a second, poorer answer.
   * Absent for a seat that produced no readable report, and for a panel run
   * before X5.
   */
  ledger?: ReviewSeatState["ledger"];
}

/** One concern whose content is really a literature outage (X5, ADR 0074 §8). */
export interface OutageShaped {
  id: string;
  reviewer: string;
  message: string;
}

export interface RecallReport {
  fixture: string;
  /**
   * Whether a measurement happened at all.
   *
   * `false` when no seat produced a ledger the driver could read: nothing was
   * measured, and every figure below is the arithmetic of an empty panel
   * rather than a reading. The absence of a measurement and a measured zero
   * are opposite findings — one says *top up the account*, the other says
   * *the panel found nothing in a manuscript with sixteen errors in it* — so
   * `formatRecallReport` prints no recall figure when this is `false`, and the
   * judge fails rather than passing a fabricated zero into a durable record.
   */
  measured: boolean;
  perCategory: Record<DefectCategory, CategoryRecall>;
  overall: CategoryRecall;
  hits: DefectHit[];
  missed: string[];
  /**
   * Concerns in a matching dimension that overlap no planted defect.
   *
   * The field's benchmark does not measure precision either, and neither does
   * R5 — but a panel that flags everything would otherwise reach a high recall
   * invisibly, so the honest, free proxy is reported beside it.
   */
  unmatched: string[];
  /** Concerns that DID overlap a defect but were gated out by dimension. */
  spanOnlyHits: number;
  /** Concerns that reached more than one defect — see `ContestedConcern`. */
  contested: ContestedConcern[];
  perReviewer: Record<string, ReviewerTally>;
  /**
   * X5: concerns whose content is really a literature outage. **Reported,
   * never asserted** — the instrument for ADR 0074 §9's protocol change, whose
   * whole point is to watch the number fall.
   */
  outageShaped: OutageShaped[];
}

/**
 * The concern's evidence pointer, when it has one.
 *
 * `{kind: "missing"}` is the reviewer saying the manuscript offers no support —
 * a finding, not a position, and never a pointer at anything. **A `paper` is
 * not a pointer either** (V2, ADR 0078, D13): it is a position in the
 * literature, and it can reach no planted defect, so ADR 0070 §2's *either
 * pointer* and ADR 0071 §2's claim-over-evidence tie-break read exactly as
 * they did before.
 */
function evidencePointer(annotation: ReviewAnnotation): ReviewSpan | undefined {
  return annotation.evidence?.kind === "span" ? annotation.evidence : undefined;
}

/**
 * Whether a located pointer lands on a manifest span. Exported for V1's trap
 * reading (plan D12), which must use this rule and no second copy of it.
 */
export function overlaps(
  pointer: ReviewSpan,
  file: string,
  span: DefectSpan,
): boolean {
  // `span.file ?? file`: the span's own file when it has one, else the
  // manifest's. On a split manuscript the same line number exists in every
  // file, so a matcher blind to the file would credit a concern anchored at
  // `main.tex:89` for a defect that is at `sections/method.tex:89`.
  //
  // The span rule itself is the harness's one copy (V5, ADR 0087 §4).
  return spansOverlap(pointer, {
    file: span.file ?? file,
    line: span.line,
    ...(span.endLine !== undefined ? { endLine: span.endLine } : {}),
  });
}

function recallOf(planted: number, found: number): CategoryRecall {
  return { planted, found, recall: planted === 0 ? null : found / planted };
}

/**
 * Seats that both completed and produced a ledger the driver could read.
 *
 * The denominator of *"was anything measured at all"*, and the one home for
 * that question: `classifyPanel`'s `panel_unparsed` and `RecallReport.measured`
 * are the same fact wearing two names, and they must never be able to disagree.
 */
export function parsedSeats(item: ReviewItem | undefined): number {
  if (item?.result === undefined) return 0;
  const missing = new Set(
    (item.result.limits ?? [])
      .filter((l) => l.kind === "seat_missing")
      .map((l) => (l.kind === "seat_missing" ? l.reviewer : "")),
  );
  return item.seats.filter(
    (s) => s.status === "completed" && !missing.has(s.reviewer),
  ).length;
}

/**
 * Every planted defect one concern reached, in the order the crediting rule
 * considers them: the ones its **claim** anchor lands on first, then the ones
 * only its **evidence** anchor lands on, each group in manifest order.
 *
 * That order IS the rule (see `matchDefects`), so it lives here once rather
 * than being re-derived at each use.
 */
export function defectsReached(
  annotation: ReviewAnnotation,
  // Structural, so V4's visual instrument credits by this rule and no second
  // copy of it: all it reads is each defect's id and spans.
  manifest: { defects: ReadonlyArray<{ id: string; spans: DefectSpan[] }> },
  file: string,
): string[] {
  const claim = annotation.span;
  const evidence = evidencePointer(annotation);
  const byClaim: string[] = [];
  const byEvidence: string[] = [];
  for (const defect of manifest.defects) {
    if (defect.spans.some((span) => overlaps(claim, file, span))) {
      byClaim.push(defect.id);
    } else if (
      evidence !== undefined &&
      defect.spans.some((span) => overlaps(evidence, file, span))
    ) {
      byEvidence.push(defect.id);
    }
  }
  return [...byClaim, ...byEvidence];
}

/**
 * The measurement: which planted defects the panel's located concerns reached.
 *
 * Reported, never asserted. The first run of this is the floor, recorded in
 * prose (ADR 0070 §5) — a recall asserted in a live test would be a flake
 * generator across model versions and exactly the *"assertion admitting one
 * outcome only"* ADR 0035 §5 forbids.
 *
 * ## One concern, at most one defect (the review round's I3)
 *
 * Two defects may admit the same span, and legitimately do: `C3` and `R2` both
 * turn on `eq:cost`, `C1`'s objection and `C2`'s both point at the same Table 1
 * row. This loop used to run per defect over every annotation with nothing
 * bounding the other direction, so ONE concern quoting a shared line scored
 * twice, in two categories — 12.5% of an overall figure off a single sentence.
 *
 * The rule is deliberately small enough to audit, and it is the whole rule:
 *
 * 1. **A claim anchor beats an evidence-only anchor.** A concern is *about*
 *    what its claim anchor points at; evidence corroborates it. This is what
 *    lets two defects share a span without stealing each other's credit — the
 *    objection to the lemma claims the lemma and cites the table, the objection
 *    to the 98% sentence claims that sentence and cites the same table.
 * 2. **Then manifest order**, which is arbitrary but fixed, auditable, and
 *    applies only where the concern genuinely does not discriminate.
 *
 * Every resolved contest is reported in `contested`, so the pick is visible to
 * the operator instead of buried in the total.
 *
 * ## `only`: the same run, read again (V1, plan D12)
 *
 * The predicate removes concerns from the MATCH SET before the contest
 * (ADR 0071 §2), so the one-credit rule picks among what is left: a concern
 * verification withdrew is neither credited, contested nor unmatched. What
 * each reviewer SAID — `perReviewer`'s located, majors, blocking — is still
 * read off every annotation, because verification changes what survives, not
 * what was raised; and `measured` still keys off the seats, so a run whose
 * every concern was withdrawn reads 0/n, never *unmeasured* (ADR 0071 §1).
 */
export function matchDefects(
  item: ReviewItem,
  manifest: DefectManifest,
  only?: (annotation: ReviewAnnotation) => boolean,
): RecallReport {
  const file = normalizePath(manifest.file);
  const annotations = item.result?.annotations ?? [];
  const matchable = only === undefined ? annotations : annotations.filter(only);
  const limits = item.result?.limits ?? [];

  const creditedTo = new Map<string, { ids: string[]; reviewers: string[] }>();
  const foundByReviewer = new Map<string, string[]>();
  const matchedIds = new Set<string>();
  const spanOnly = new Set<string>();
  const contested: ContestedConcern[] = [];

  for (const annotation of matchable) {
    const reached = defectsReached(annotation, manifest, file);
    if (reached.length === 0) continue;
    if (!MATCHING_DIMENSIONS.includes(annotation.dimension)) {
      spanOnly.add(annotation.id);
      continue;
    }
    const credited = reached[0] as string;
    if (reached.length > 1) {
      contested.push({
        id: annotation.id,
        credited,
        alsoReached: reached.slice(1),
      });
    }
    const hit = creditedTo.get(credited) ?? { ids: [], reviewers: [] };
    hit.ids.push(annotation.id);
    if (!hit.reviewers.includes(annotation.reviewer)) {
      hit.reviewers.push(annotation.reviewer);
    }
    creditedTo.set(credited, hit);
    matchedIds.add(annotation.id);
    const mine = foundByReviewer.get(annotation.reviewer) ?? [];
    if (!mine.includes(credited)) mine.push(credited);
    foundByReviewer.set(annotation.reviewer, mine);
  }

  // Manifest order for both lists, independently of the order concerns arrived.
  const hits: DefectHit[] = [];
  const missed: string[] = [];
  const perCategoryFound = new Map<DefectCategory, number>();
  for (const defect of manifest.defects) {
    const hit = creditedTo.get(defect.id);
    if (hit === undefined) {
      missed.push(defect.id);
      continue;
    }
    hits.push({ defect: defect.id, ids: hit.ids, reviewers: hit.reviewers });
    perCategoryFound.set(
      defect.category,
      (perCategoryFound.get(defect.category) ?? 0) + 1,
    );
  }

  const perCategory = {} as Record<DefectCategory, CategoryRecall>;
  for (const category of DEFECT_CATEGORIES) {
    perCategory[category] = recallOf(
      manifest.defects.filter((d) => d.category === category).length,
      perCategoryFound.get(category) ?? 0,
    );
  }

  const perReviewer: Record<string, ReviewerTally> = {};
  for (const seat of item.seats) {
    const mine = annotations.filter((a) => a.reviewer === seat.reviewer);
    const dropped = limits
      .filter(
        (l) => l.kind === "anchors_dropped" && l.reviewer === seat.reviewer,
      )
      .flatMap((l) => (l.kind === "anchors_dropped" ? l.anchors : [])).length;
    const majors = mine.filter((a) => a.severity === "major");
    perReviewer[seat.reviewer] = {
      model: seat.model,
      concerns: mine.length + dropped,
      located: mine.length,
      dropped,
      majors: majors.length,
      // `blocking` is settable only on a major (ADR 0060 D3), and only `true`
      // is the reviewer saying the manuscript's central case fails without it.
      blockingMajors: majors.filter((a) => a.blocking === true).length,
      found: foundByReviewer.get(seat.reviewer) ?? [],
      ...(seat.ledger !== undefined ? { ledger: seat.ledger } : {}),
    };
  }

  return {
    fixture: manifest.fixture,
    measured: parsedSeats(item) > 0,
    perCategory,
    overall: recallOf(manifest.defects.length, hits.length),
    hits,
    missed,
    unmatched: matchable
      .filter(
        (a) =>
          MATCHING_DIMENSIONS.includes(a.dimension) && !matchedIds.has(a.id),
      )
      .map((a) => a.id),
    spanOnlyHits: spanOnly.size,
    contested,
    perReviewer,
    outageShaped: outageShapedOf(annotations),
  };
}

function isCategory(value: unknown): value is DefectCategory {
  return DEFECT_CATEGORIES.includes(value as DefectCategory);
}

function isWellFormedSpan(span: DefectSpan): boolean {
  return (
    typeof span?.anchor === "string" &&
    Number.isInteger(span?.line) &&
    // X5: optional, but a PRESENT one has to be a real path. A manifest that
    // is wrong about where a defect sits measures the wrong thing while
    // looking healthy, and a silently wrong instrument is worse than no
    // instrument.
    (span.file === undefined ||
      (typeof span.file === "string" && span.file !== ""))
  );
}

/**
 * V1 (plan D11): the traps, validated the way a defect is — refuse, never
 * repair. A trap with no answer span could never be withdrawn *correctly*, and
 * one with no bait could never be hit, so either would read as a measurement
 * of the verifier while measuring nothing.
 */
function validateTraps(path: string, traps: unknown): void {
  if (traps === undefined) return;
  if (!Array.isArray(traps)) {
    throw new Error(`${path}: "traps" is not a list`);
  }
  const seen = new Set<string>();
  for (const trap of traps as Trap[]) {
    if (typeof trap?.id !== "string" || !/^T\d+$/.test(trap.id)) {
      throw new Error(
        `${path}: a trap id must read T<n>, got "${String(trap?.id)}"`,
      );
    }
    if (seen.has(trap.id)) {
      throw new Error(`${path}: duplicate trap id "${trap.id}"`);
    }
    seen.add(trap.id);
    if (typeof trap.complaint !== "string" || trap.complaint.trim() === "") {
      throw new Error(`${path}: trap "${trap.id}" has no complaint`);
    }
    if (typeof trap.tell !== "string" || trap.tell.trim() === "") {
      throw new Error(`${path}: trap "${trap.id}" has no tell`);
    }
    for (const list of ["bait", "answer"] as const) {
      const spans = trap[list];
      if (!Array.isArray(spans) || spans.length === 0) {
        throw new Error(`${path}: trap "${trap.id}" has no ${list} span`);
      }
      if (!spans.every(isWellFormedSpan)) {
        throw new Error(
          `${path}: trap "${trap.id}" has a malformed ${list} span`,
        );
      }
    }
  }
}

/**
 * Reads and validates a manifest.
 *
 * Refusal, not repair: a manifest that cannot be ground truth would produce a
 * recall that looks like a measurement and is not, which is worse than no
 * number at all.
 */
export async function readManifest(path: string): Promise<DefectManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as DefectManifest;
  if (typeof parsed?.file !== "string" || !Array.isArray(parsed?.defects)) {
    throw new Error(`${path}: not a defect manifest`);
  }
  const seen = new Set<string>();
  for (const defect of parsed.defects) {
    if (typeof defect?.id !== "string" || defect.id === "") {
      throw new Error(`${path}: a defect has no id`);
    }
    if (seen.has(defect.id)) {
      throw new Error(`${path}: duplicate defect id "${defect.id}"`);
    }
    seen.add(defect.id);
    if (!isCategory(defect.category)) {
      throw new Error(
        `${path}: defect "${defect.id}" has unknown category "${String(defect.category)}"`,
      );
    }
    if (!Array.isArray(defect.spans) || defect.spans.length === 0) {
      throw new Error(
        `${path}: defect "${defect.id}" has no admissible span, so nothing could ever hit it`,
      );
    }
    if (!defect.spans.every(isWellFormedSpan)) {
      throw new Error(`${path}: defect "${defect.id}" has a malformed span`);
    }
    if (typeof defect.tell !== "string" || defect.tell === "") {
      throw new Error(`${path}: defect "${defect.id}" has no tell`);
    }
    if (typeof defect.subtype !== "string" || defect.subtype === "") {
      throw new Error(`${path}: defect "${defect.id}" has no subtype`);
    }
    // A row whose edit is empty, or which changes nothing, is not a planted
    // defect: nothing was done to the manuscript, so a reviewer that "misses"
    // it has missed nothing and the recall is short by one for no reason.
    if (
      typeof defect.original !== "string" ||
      typeof defect.perturbed !== "string" ||
      defect.original === "" ||
      defect.perturbed === ""
    ) {
      throw new Error(
        `${path}: defect "${defect.id}" is missing its original or perturbed text`,
      );
    }
    if (defect.original === defect.perturbed) {
      throw new Error(
        `${path}: defect "${defect.id}" perturbs nothing -- original and perturbed are identical`,
      );
    }
    // The primary admissible span is the perturbed text itself. A manifest
    // whose first span points somewhere else is describing a different edit
    // from the one it claims to have made.
    if ((defect.spans[0] as DefectSpan).anchor !== defect.perturbed) {
      throw new Error(
        `${path}: defect "${defect.id}"'s first span is not its perturbed text`,
      );
    }
  }
  validateTraps(path, parsed.traps);
  return parsed;
}

const ratio = (value: CategoryRecall): string =>
  `${value.found}/${value.planted}`;

/**
 * One line naming what each seat located, dropped and reached.
 *
 * Exported so the **judge** can print it too, not only the live tier. It was
 * reachable from no operator-facing surface until the review round, which is
 * what blocked that round's Judge question 1: `lemmaria eval` on a flagship
 * gave the operator a flagship's *recall* and nothing about its *quoting*, so
 * *"a cheap model quotes badly"* and *"models quote badly"* could not be told
 * apart on the one path that can reach a flagship at all.
 */
/** `E/L/D/R` — entries, located, dropped, rejected, in that fixed order. */
function counts(c: LedgerCounts): string {
  return `${c.entries}/${c.located}/${c.dropped}/${c.rejected}`;
}

export function formatReviewerTallies(report: RecallReport): string {
  return Object.entries(report.perReviewer)
    .map(([name, tally]) => {
      // X5: what the seat's report came to, before and after the one re-ask.
      // The `first=` half only when there WAS a first pass — a seat that never
      // retried has no before to compare against, and printing its final
      // counts twice would read as a re-ask that changed nothing.
      const ledger =
        tally.ledger === undefined
          ? ""
          : ` ${
              tally.ledger.firstPass !== undefined
                ? `first=${counts(tally.ledger.firstPass)} → `
                : ""
            }final=${counts(tally.ledger)} relocated=${tally.ledger.relocated}`;
      return (
        `${name}@${tally.model}=${tally.located}loc/${tally.dropped}drop` +
        `/${tally.majors}maj(${tally.blockingMajors}blocking)` +
        `/found:${tally.found.join(",") || "none"}${ledger}`
      );
    })
    .join(" ");
}

/**
 * The panel's located rate, before the re-ask and after it (X5, ADR 0074 §8).
 *
 * *Located rate* is `located / entries` of the pass it describes, summed over
 * the seats that reported a tally; a seat with no `firstPass` contributes its
 * final counts to both, because for that seat nothing changed.
 *
 * The **conservative** reading — final `located` over FIRST-PASS `entries` —
 * is printed beside it because a withdrawn entry leaves `entries` (§5): a seat
 * that gives up on an entry raises its own final rate without having corrected
 * anything, and only the conservative reading cannot be flattered that way.
 * Both are derived from the raw counts, which are what the record holds.
 *
 * Absent when no seat reported a tally, for the same reason `measured` exists:
 * an absent measurement and a measured zero are opposite findings.
 */
export function formatLedgerRateLine(report: RecallReport): string | undefined {
  const tallies = Object.values(report.perReviewer).filter(
    (t): t is ReviewerTally & { ledger: LedgerCounts } =>
      t.ledger !== undefined,
  );
  if (tallies.length === 0) return undefined;
  const sum = (pick: (c: LedgerCounts) => number): number =>
    tallies.reduce((n, t) => n + pick(t.ledger), 0);
  const sumFirst = (pick: (c: LedgerCounts) => number): number =>
    tallies.reduce(
      (n, t) => n + pick((t.ledger.firstPass ?? t.ledger) as LedgerCounts),
      0,
    );
  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
  const firstEntries = sumFirst((c) => c.entries);
  const firstLocated = sumFirst((c) => c.located);
  const finalEntries = sum((c) => c.entries);
  const finalLocated = sum((c) => c.located);
  return (
    `located rate: first ${firstLocated}/${firstEntries} (${pct(firstLocated, firstEntries)})` +
    ` → final ${finalLocated}/${finalEntries} (${pct(finalLocated, finalEntries)}),` +
    ` conservative ${finalLocated}/${firstEntries} (${pct(finalLocated, firstEntries)}),` +
    ` relocated ${sum((c) => c.relocated)}, rejected ${sum((c) => c.rejected)}`
  );
}

/**
 * Concerns whose content is really a **literature outage** (X5, ADR 0074 §9).
 *
 * The instrument for D12's protocol change, and **never asserted**: the whole
 * point is to watch this number fall as the new Grounding rule takes effect,
 * and an assertion would turn the first reading into a threshold — exactly the
 * "assertion admitting one outcome only" ADR 0035 §5 forbids.
 *
 * Both patterns must match. A source name alone is an ordinary citation
 * concern ("the arXiv version of [3] differs from the one cited"); an outage
 * word alone is usually about the experiments ("the run timed out at 40
 * epochs"). Only the conjunction is a reviewer filing a search failure against
 * the author's paper.
 */
const OUTAGE_SOURCE = /crossref|arxiv|dblp|semantic scholar/i;
const OUTAGE_EVENT =
  /timed? ?out|rate.?limit|unavailable|did not (answer|respond)|failed|inconclusive/i;

function outageShapedOf(
  annotations: readonly ReviewAnnotation[],
): OutageShaped[] {
  return annotations
    .filter(
      (a) => OUTAGE_SOURCE.test(a.message) && OUTAGE_EVENT.test(a.message),
    )
    .map((a) => ({ id: a.id, reviewer: a.reviewer, message: a.message }));
}

/**
 * The `[live]`-line shape: counts first, so a reader sees the denominator.
 *
 * **An unmeasured run prints no recall figure at all** (the review round's I1).
 * It used to print the full table — four `0/4` categories, `overall: 0/16` and
 * all sixteen ids under `missed:` — when no seat had produced a ledger, so a
 * dead API key and a panel that read the manuscript and found nothing in it
 * emitted byte-identical blocks, separated only by an `outcome=` token on the
 * previous line. The driving documents tell the operator three times to record
 * that case as *unmeasured, never as a recall of zero*; suppressing the figures
 * is what makes the instrument say the same thing.
 */
export function formatRecallReport(report: RecallReport): string {
  const seats = [`  ${formatReviewerTallies(report)}`];
  if (!report.measured) {
    return [
      `recall ${report.fixture} — unmeasured: no seat produced a ledger the driver could read`,
      ...seats,
    ].join("\n");
  }
  const categories = DEFECT_CATEGORIES.map(
    (category) => `${category}: ${ratio(report.perCategory[category])}`,
  );
  // One formatter, two readers: the report indents it, the judge prints it
  // bare, and computing it here means they cannot disagree about the rate.
  const ledgerRate = formatLedgerRateLine(report);
  // Named only when it happened: the number this exists to watch is one that
  // should be FALLING as the protocol takes effect, and a `0` line every run
  // is how a number stops being read.
  const outage =
    report.outageShaped.length > 0
      ? [
          `  outage-shaped concerns: ${report.outageShaped.length} (${report.outageShaped
            .map((o) => o.id)
            .join(",")})`,
        ]
      : [];
  // Named only when it happened, for the same reason: a contest is worth an
  // operator's attention precisely because it is rare, and a `contested: 0`
  // line every run is how a rare thing becomes invisible.
  const contested =
    report.contested.length > 0
      ? [
          `  contested: ${report.contested
            .map((c) => `${c.id}→${c.credited}(not ${c.alsoReached.join("/")})`)
            .join(" ")}`,
        ]
      : [];
  return [
    `recall ${report.fixture} — ${categories.join(", ")}, overall: ${ratio(report.overall)}`,
    `  missed: ${report.missed.join(",") || "none"}`,
    `  unmatched: ${report.unmatched.length}, span-only: ${report.spanOnlyHits}`,
    ...contested,
    ...(ledgerRate === undefined ? [] : [`  ${ledgerRate}`]),
    ...outage,
    ...seats,
  ].join("\n");
}
