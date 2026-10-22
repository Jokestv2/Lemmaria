/**
 * What verification did to one review — the instrument V1 reads (ADR 0076,
 * plan D12).
 *
 * The verifier can withdraw a concern, and nothing it does measures itself:
 * it may withdraw the careless complaints it exists for, withdraw a true
 * defect — the error that would condemn it — or do nothing at all. This
 * module says which, off ONE run read twice:
 *
 * - **recall before and after** — `matchDefects` over every concern, then
 *   over the ones verification left standing, the filter running before the
 *   one-credit contest (ADR 0071 §2); `lost` names each defect the first
 *   reading credited and the second does not;
 * - **trap hits** — the careless complaints a manifest plants beside its
 *   defects (plan D11), and whether each was withdrawn with a counter on the
 *   passage that really answers it;
 * - **`central` among majors** — what the verifier made of *blocking*, read
 *   beside how often the reviewers claimed it.
 *
 * Every figure is about the **verifier and the reviewers**, never about the
 * manuscript — the *no score* rule, asserted by `verification.test.ts` the way
 * `recall.test.ts` asserts it. Like `recall.ts`, this stays off the harness's
 * export surface (ADR 0070 §6).
 */

import {
  type ReviewAnnotation,
  type ReviewItem,
  type ReviewLimit,
  type VerificationCounts,
  isWithdrawn,
} from "@lemmaria/harness";
import {
  type DefectManifest,
  type RecallReport,
  matchDefects,
  overlaps,
} from "./recall.js";

/** One concern the trap rule picked — printed, because the rule is loose. */
export interface TrapHit {
  trap: string;
  concern: string;
  message: string;
  /** Whether the verifier recorded anything for it. A chunk that failed
   *  leaves its concerns unchecked — silence, never a judgment (ADR 0071 §1). */
  checked: boolean;
  withdrawn: boolean;
  /** Whether the recorded counter overlaps one of the trap's answer spans. */
  counterOnAnswer: boolean;
}

type VerificationShortfall = Extract<
  ReviewLimit,
  { kind: "verification_missing" }
>["reason"];

export interface VerificationReport {
  /** A verifier seat exists on the item — some child was asked. */
  ran: boolean;
  /** The item's own verification state, for a panel where none ran. */
  state?: ReviewItem["verification"];
  /** The verifier's own tally, copied from its seat — never re-derived. */
  tally?: VerificationCounts;
  /** Every `verification_missing` reason on the record, in record order. */
  limits: VerificationShortfall[];
  before: RecallReport;
  after: RecallReport;
  /** Defect ids credited before verification and not after. */
  lost: string[];
  /** Concerns with no `verification` at all: never checked, so their sameness
   *  across the two readings is silence, not a reading. */
  unchecked: number;
  /** Every located concern on the record, withdrawn or not. */
  located: number;
  traps: { planted: number; hits: TrapHit[] };
  central: {
    majors: number;
    /** Majors the reviewer flagged `blocking`. */
    blocking: number;
    /** Majors the verifier answered the `central` question on at all. */
    asked: number;
    centralTrue: number;
    centralFalse: number;
  };
}

/**
 * The trap rule (plan D11): a concern whose **claim** span overlaps a bait
 * span **and** whose evidence is `{kind: "missing"}` — the ledger's own encoding of
 * *I looked and the manuscript offers none*, which is what makes a complaint
 * careless rather than merely adjacent. Any dimension.
 */
function trapHits(
  annotations: readonly ReviewAnnotation[],
  manifest: DefectManifest,
): TrapHit[] {
  const hits: TrapHit[] = [];
  for (const trap of manifest.traps ?? []) {
    for (const a of annotations) {
      if (a.evidence?.kind !== "missing") continue;
      if (!trap.bait.some((span) => overlaps(a.span, manifest.file, span))) {
        continue;
      }
      const counter = a.verification?.counter;
      hits.push({
        trap: trap.id,
        concern: a.id,
        message: a.message,
        checked: a.verification !== undefined,
        withdrawn: isWithdrawn(a),
        counterOnAnswer:
          counter !== undefined &&
          trap.answer.some((span) => overlaps(counter, manifest.file, span)),
      });
    }
  }
  return hits;
}

export function measureVerification(
  item: ReviewItem,
  manifest: DefectManifest,
): VerificationReport {
  const annotations = item.result?.annotations ?? [];
  const before = matchDefects(item, manifest);
  const after = matchDefects(item, manifest, (a) => !isWithdrawn(a));
  const standing = new Set(after.hits.map((h) => h.defect));
  const majors = annotations.filter((a) => a.severity === "major");
  const answered = majors.filter(
    (a) => typeof a.verification?.central === "boolean",
  );
  const tally = item.verifierSeat?.verification;
  return {
    ran: item.verifierSeat !== undefined,
    ...(item.verification !== undefined ? { state: item.verification } : {}),
    ...(tally !== undefined ? { tally } : {}),
    limits: (item.result?.limits ?? []).flatMap((l) =>
      l.kind === "verification_missing" ? [l.reason] : [],
    ),
    before,
    after,
    lost: before.hits.map((h) => h.defect).filter((d) => !standing.has(d)),
    unchecked: annotations.filter((a) => a.verification === undefined).length,
    located: annotations.length,
    traps: {
      planted: manifest.traps?.length ?? 0,
      hits: trapHits(annotations, manifest),
    },
    central: {
      majors: majors.length,
      blocking: majors.filter((a) => a.blocking === true).length,
      asked: answered.length,
      centralTrue: answered.filter((a) => a.verification?.central === true)
        .length,
      centralFalse: answered.filter((a) => a.verification?.central === false)
        .length,
    },
  };
}

const PICK_CHARS = 160;

const quoted = (message: string): string =>
  `"${message.length > PICK_CHARS ? `${message.slice(0, PICK_CHARS)}…` : message}"`;

function pickLine(hit: TrapHit): string {
  const what = !hit.checked
    ? "not checked"
    : !hit.withdrawn
      ? "kept"
      : hit.counterOnAnswer
        ? "withdrawn, counter on the answer"
        : "withdrawn, counter elsewhere";
  return `    ${hit.trap} ${hit.concern} ${what}: ${quoted(hit.message)}`;
}

/**
 * The `[live]`-line shape, beside `formatRecallReport`'s. Counts first, so a
 * reader sees the denominator; an unmeasured panel prints no recall figure,
 * for recall's own reason (the review round's I1).
 */
export function formatVerificationReport(report: VerificationReport): string {
  const shortfall =
    report.limits.length > 0 ? `; fell short: ${report.limits.join(", ")}` : "";
  const t = report.tally;
  const head = !report.ran
    ? `verification — not run (${report.limits.join(", ") || report.state || "no verifier on this panel"})`
    : t === undefined
      ? `verification — ran, no tally on the seat${shortfall}`
      : `verification — upheld ${t.upheld}, refuted ${t.refuted}, unverifiable ${t.unverifiable}` +
        ` (${t.downgraded} downgraded), unanswered ${t.unanswered} of ${t.concerns} concerns${shortfall}`;

  const { before, after } = report;
  // What was never checked cannot have been withdrawn: say how much of the
  // second reading's sameness is silence rather than a reading (ADR 0071 §1).
  const silence =
    report.unchecked > 0
      ? `; ${report.unchecked} of ${report.located} concerns not checked`
      : "";
  const recall = before.measured
    ? `  recall before → after: ${before.overall.found}/${before.overall.planted}` +
      ` → ${after.overall.found}/${after.overall.planted},` +
      ` lost to verification: ${report.lost.join(",") || "none"}${silence}`
    : "  recall before → after: unmeasured — no seat produced a ledger the driver could read";

  const { planted, hits } = report.traps;
  const kept = hits.filter((h) => !h.withdrawn).length;
  const unchecked = hits.filter((h) => !h.checked).length;
  const traps =
    planted === 0
      ? ["  trap hits: none planted"]
      : [
          `  trap hits: ${hits.length} → ${kept} of ${planted} planted` +
            `${unchecked > 0 ? ` (${unchecked} not checked)` : ""}`,
          ...hits.map(pickLine),
        ];

  const c = report.central;
  const central =
    `  central among majors: ${c.centralTrue} true, ${c.centralFalse} false of ${c.asked} answered;` +
    ` blocking ${c.blocking}/${c.majors} majors`;

  return [head, recall, ...traps, central].join("\n");
}
