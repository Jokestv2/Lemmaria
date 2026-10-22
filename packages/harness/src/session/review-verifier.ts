/**
 * The review panel's verifier (V1, ADR 0076).
 *
 * After every reviewer's ledger is frozen and before the cross-review, one
 * harness-issued, read-only child — split into chunks of at most
 * `VERIFIER_CHUNK` concerns — tries to refute each located concern from the
 * manuscript. A concern is withdrawn only on a passage the harness can locate,
 * stays in the result, and is never seen by the cross-review.
 *
 * **This file is inside the v0.3 stage guard's scope** (`test/no-*.test.ts`):
 * it holds the verifier's brief, which a model reads, so it is English only
 * (invariant 6 rule 3).
 */

import type { Usage } from "../contracts/adapters.js";
import type {
  ReviewAnnotation,
  ReviewEvidence,
  ReviewLimit,
  ReviewVerification,
} from "../contracts/data.js";
import type {
  ReviewItem,
  ReviewSeatState,
  SessionTaskBudget,
} from "../contracts/sessions.js";
import { manuscriptLocator } from "../engine/review.js";
import {
  type VerificationReading,
  countVerification,
  interpretVerification,
  mergeVerificationCorrection,
} from "../engine/verification.js";
import { classifyModelForSession } from "../model/floor.js";
import { runFanOut } from "./loop-tools/fan-out.js";
import { MAX_FAN_OUT } from "./loop-tools/subtask.js";
import {
  type BriefContext,
  type Manuscript,
  type ReviewPanelDeps,
  isUnpriced,
  manuscriptFilesSentence,
  observeSeat,
} from "./review-panel.js";
import { narrowChildTools, sumUsage } from "./subtasks.js";

/** The bundled protocol every verifier child is made to load. */
export const VERIFIER_SKILL = "concern-verifier";

/** The verifier's seat row names it by role, as the cross-review's does —
 *  never by model, and never as a reviewer. */
export const VERIFIER_NAME = "verifier";

/** At most this many concerns per verifier child (design §3: "more than
 *  twenty concerns are split"). Above `MAX_FAN_OUT × VERIFIER_CHUNK` the
 *  chunks grow rather than the fan-out. */
export const VERIFIER_CHUNK = 20;

/**
 * The output-token carve below which the verifier's share is called thin, and
 * `review.verifier_budget` is emitted. A WARNING THRESHOLD, not a floor: the
 * verifier is still handed exactly what `carve` left it, and ADR 0076's
 * rejection of *a floor for the verifier* stands untouched.
 *
 * **It is not `PANEL_SEAT_TOKEN_FLOOR`, and V1's J1 round is why.** That
 * constant sizes a REVIEWER, whose output is unbounded prose. A verifier
 * child's output is bounded by its own contract: at most `VERIFIER_CHUNK`
 * entries, each an id, a `kind`, an `outcome`, one source line of `counter`
 * quote, a boolean, and a `note` cut to `VERIFICATION_NOTE_CHARS`. Measured
 * against the reviewer's yardstick, an adequate carve read as a starved one:
 * at the shipped 16,000 default the round saw the notice on EVERY run while
 * verification finished every time, on 2,239 and 2,787 output tokens across
 * two children — roughly 85 per concern. A full `VERIFIER_CHUNK` chunk at
 * that rate is ~1,700; this is that, rounded up.
 */
export const VERIFIER_THIN_CARVE = 2_000;

/** The sentence every verifier brief's prose opens with. Exported so that a
 *  scripted adapter keys the verifier's requests on the brief's own words,
 *  not on a copy of them that could drift. */
export const VERIFIER_BRIEF_MARKER = "Reviewers have raised the concerns below";

/**
 * The verifier's tools: the parent's read tools, minus the literature. It
 * tests a concern against the manuscript, and a search would only let it go
 * and look at something else. Narrowed within the parent's allowlist, so a
 * parent without one of these yields a verifier without it — never an error,
 * and never a tool the parent does not hold (invariant 2).
 */
export const VERIFIER_TOOLS = [
  "read_span",
  "get_outline",
  "list_files",
  "grep_project",
] as const;

/**
 * Cut the concerns into `k = min(MAX_FAN_OUT, ⌈n / VERIFIER_CHUNK⌉)`
 * contiguous runs, in order, whose sizes differ by at most one — the larger
 * ones first. Every concern lands in exactly one chunk.
 */
export function verifierChunks<T>(concerns: readonly T[]): T[][] {
  const n = concerns.length;
  if (n === 0) return [];
  const k = Math.min(MAX_FAN_OUT, Math.ceil(n / VERIFIER_CHUNK));
  const base = Math.floor(n / k);
  const extra = n % k;
  const chunks: T[][] = [];
  let at = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < extra ? 1 : 0);
    chunks.push(concerns.slice(at, at + size));
    at += size;
  }
  return chunks;
}

/**
 * One concern's evidence as the verifier's brief carries it.
 *
 * An explicit arm per kind, with no fall-through: before V4 the last arm was
 * an `else` that read a PAPER, so a fourth kind would have been serialised as
 * a paper with an undefined title (ADR 0081, D8).
 */
function briefEvidence(
  id: string,
  evidence: ReviewEvidence,
  abstracts: ReadonlyMap<string, string>,
): string | { paper: { title: string; year?: string; abstract?: string } } {
  switch (evidence.kind) {
    case "missing":
      return "missing";
    case "span":
      return `${evidence.file}:${evidence.line}`;
    case "paper":
      // V2 (ADR 0078 §7): the paper, with the abstract the reviewer's own
      // search recorded. That abstract is all the verifier may rely on about
      // the work — it is the only thing anybody here has actually read of it.
      return {
        paper: {
          title: evidence.title,
          ...(evidence.year !== undefined ? { year: evidence.year } : {}),
          ...(abstracts.has(id) ? { abstract: abstracts.get(id) } : {}),
        },
      };
    case "page":
      // V4 (ADR 0081, D8): unreachable in production — the driver never
      // hands the verifier a PDF reviewer's concern, and only that seat can
      // cite a page. Typed anyway, so the kind cannot fall into another arm.
      return `page ${evidence.page}`;
  }
}

/**
 * One verifier child's goal (ADR 0076 §5). English only — model-facing text.
 *
 * It opens with the forced protocol load, as a reviewer's brief does, and
 * then hands over the concerns as compact JSON. **No model id, no reviewer
 * field** (the id already carries the ordinal), **no focus** (it told the
 * reviewers where to look; it is not evidence), and no transcript — so the
 * verifier tests what was said, not who said it (ADR 0069 §6, extended).
 *
 * The file list and the wrapping sentence are the ones the reviewers were
 * given, from the same builders, so a counter-quote is asked for in exactly
 * the form a reviewer's quote was.
 */
export function verifierBrief(
  concerns: readonly ReviewAnnotation[],
  ctx: BriefContext,
  /** V2 (ADR 0078 §7): the abstract behind each cited paper, by concern id —
   *  from THAT seat's own recorded search results. Absent for a concern whose
   *  result carried none, which is what makes the id set the verifier is
   *  measured against smaller than the set of papers. */
  abstracts: ReadonlyMap<string, string> = new Map(),
): string {
  const rows = concerns.map((a) => ({
    id: a.id,
    dimension: a.dimension,
    severity: a.severity,
    ...(a.blocking === true ? { blocking: true } : {}),
    at: `${a.span.file}:${a.span.line}`,
    message: a.message,
    ...(a.evidence === undefined
      ? {}
      : { evidence: briefEvidence(a.id, a.evidence, abstracts) }),
  }));
  return [
    `/skill:${VERIFIER_SKILL}`,
    "",
    `${VERIFIER_BRIEF_MARKER} about the manuscript whose entry file is \`${ctx.entry}\`. Each one is already located in the manuscript and has a stable id.`,
    "",
    manuscriptFilesSentence(ctx),
    "",
    ctx.wrapping,
    "",
    JSON.stringify({ concerns: rows }),
    "",
    "Test each concern against the manuscript, as your protocol describes. Your reply is exactly one JSON object and nothing else.",
  ].join("\n");
}

/** What verification came to, for the driver to fold into its panel. */
export interface VerificationRun {
  /** Recorded entries, by concern id, across every chunk. */
  entries: ReadonlyMap<string, ReviewVerification>;
  /** Zero or more `verification_missing` limits. */
  limits: ReviewLimit[];
  state: NonNullable<ReviewItem["verification"]>;
  /** The one sibling seat, aggregated over every chunk. Absent when no child
   *  ran. */
  seat?: ReviewSeatState;
  /** Summed over the children — already accrued into the parent by the
   *  fan-out, so the driver only adds it to its own total. */
  usage?: Usage;
  /** True when the user stopped the panel before or during verification. */
  interrupted: boolean;
}

type MissingReason = Extract<
  ReviewLimit,
  { kind: "verification_missing" }
>["reason"];

/**
 * Run the panel's verifier over the located concerns (ADR 0076 §5).
 *
 * `carve` is the panel's own; each child is carved `carve(k + 1)`, so one
 * share is left for the cross-review and the verifier cannot by construction
 * push it onto its floor. There is NO floor here: ADR 0061's invariant-5
 * consequence — one floored child, once per panel — stands verbatim.
 */
export async function runVerification(
  deps: ReviewPanelDeps,
  located: readonly ReviewAnnotation[],
  manuscript: Manuscript,
  ctx: BriefContext,
  carve: (childCount: number) => SessionTaskBudget,
  onStarted: (seat: ReviewSeatState) => Promise<void>,
  /** V2 (ADR 0078 §7): per concern id, the abstract behind the paper it cites
   *  — built by the driver from the SAME seat's recorded results. */
  abstracts: ReadonlyMap<string, string> = new Map(),
): Promise<VerificationRun> {
  const none = new Map<string, ReviewVerification>();
  const missing = (
    reason: MissingReason,
    interrupted = false,
  ): VerificationRun => ({
    entries: none,
    limits: [{ kind: "verification_missing", reason }],
    state: "missing",
    interrupted,
  });

  if (deps.verifier === "off") {
    return { ...missing("off"), state: "off" };
  }
  // Nothing was located, so there was nothing to check — not a shortfall.
  if (located.length === 0) {
    return { entries: none, limits: [], state: "skipped", interrupted: false };
  }
  // A call, not an inline property read: TypeScript would narrow the second
  // read below to `false` after this one, and re-reading after the fan-out's
  // awaits is the whole point (the panel's own `aborted` says the same).
  const aborted = (): boolean => deps.signal?.aborted === true;
  if (aborted()) return missing("interrupted", true);
  const protocol = deps.offeredSkills.filter((s) => s.name === VERIFIER_SKILL);
  if (protocol.length === 0) return missing("no_protocol");

  // Absent ⇒ the cross-review's model, itself absent ⇒ the parent's: one
  // model, so it preflighted as one.
  const model = deps.verifier ?? deps.synthesis;
  const modelId = model?.binding.model ?? deps.parentModel;
  const stamp: Pick<ReviewSeatState, "model" | "unverified"> = {
    model: modelId,
    ...(classifyModelForSession(modelId) === "unverified"
      ? { unverified: true as const }
      : {}),
  };

  const chunks = verifierChunks(located);
  const share = carve(chunks.length + 1);
  if (share.maxOutputTokens < VERIFIER_THIN_CARVE) {
    // `review.seat_budget`'s reasoning word for word: the budget is the
    // user's dial, and a starved child reports itself through `no_report`.
    // The THRESHOLD is the verifier's own, not the reviewer seat's — see
    // `VERIFIER_THIN_CARVE`.
    await deps.emitNotice("review.verifier_budget", share.maxOutputTokens);
  }

  const seat: ReviewSeatState = {
    reviewer: VERIFIER_NAME,
    status: "running",
    ...stamp,
  };
  await onStarted({ ...seat });

  const locate = manuscriptLocator(manuscript.files, manuscript.defaultFile);
  /** Each child's FIRST would-be final answer and its reading — the one the
   *  re-ask was decided on (ADR 0061 §6: the check runs once per child). */
  const stash = new Map<
    number,
    { text: string; reading: VerificationReading }
  >();
  const tools = narrowChildTools(deps.parentAllowed, [...VERIFIER_TOOLS]);
  // ONE set, read by BOTH readings of a child's answer (ADR 0079 §2). It used
  // to be built inline at the `finalAnswerCheck` below and nowhere else, so a
  // chunk that went to the re-ask had its CORRECTION read as though no
  // abstract had ever been handed — downgrading exactly the concerns the
  // hand-off exists to make answerable. Hoisted so the two reads cannot
  // disagree, rather than passed twice.
  const abstractsHanded = new Set(abstracts.keys());

  const fanOut = await runFanOut(
    {
      fanOutConcurrency: Math.max(
        1,
        Math.min(deps.fanOutConcurrency, chunks.length),
      ),
      carveCeiling: (n) => carve(n + 1),
      accrue: deps.accrue,
      runChild: deps.runChild,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    chunks.map((chunk, i) => ({
      goal: verifierBrief(chunk, ctx, abstracts),
      allowedTools: tools,
      skills: [...protocol],
      finalAnswerCheck: (text: string): string | undefined => {
        const reading = interpretVerification({
          answer: text,
          concerns: chunk,
          locate,
          // Only a concern whose abstract actually reached the brief can be
          // settled on a literature ground (ADR 0078 §7, ADR 0079 §2).
          abstractsHanded,
        });
        if (!stash.has(i)) stash.set(i, { text, reading });
        return reading.failure ?? reading.problems;
      },
      ...(model ? { model } : {}),
    })),
    { onStarted: async () => {}, onChildSettled: async () => {} },
  );

  const entries = new Map<string, ReviewVerification>();
  const limits: ReviewLimit[] = [];
  /** Chunks whose unanswered concerns a limit above already explains. */
  const explained = new Set<number>();
  let interrupted = false;
  let retried = false;

  for (const [i, chunk] of chunks.entries()) {
    const outcome = fanOut.outcomes[i];
    if (outcome === undefined) {
      // Unreachable — `runFanOut` pre-fills every outcome. Recorded anyway,
      // as the seats' loop does: a chunk must not vanish without a record.
      limits.push({ kind: "verification_missing", reason: "failed" });
      explained.add(i);
      continue;
    }
    const obs = observeSeat(outcome.items, VERIFIER_SKILL);
    if (obs.retried) retried = true;
    if (outcome.status !== "completed") {
      if (outcome.status === "interrupted") interrupted = true;
      limits.push({
        kind: "verification_missing",
        reason: outcome.status,
        ...(outcome.status === "failed" && obs.failure !== undefined
          ? { cause: obs.failure }
          : {}),
      });
      explained.add(i);
      continue;
    }
    // An unguided verifier is not evidence: whatever it answered is
    // discarded, and the record says why.
    if (!obs.guided) {
      limits.push({ kind: "verification_missing", reason: "no_protocol" });
      explained.add(i);
      continue;
    }
    if (obs.report === undefined) {
      limits.push({
        kind: "verification_missing",
        reason: "no_report",
        ...(obs.budgetStop !== undefined ? { detail: obs.budgetStop } : {}),
      });
      explained.add(i);
      continue;
    }
    // The seats' three cases (ADR 0074 §5): no re-ask, a repeated answer, or
    // a correction merged onto the first reading.
    const first = stash.get(i);
    const readReport = (): VerificationReading =>
      interpretVerification({
        answer: obs.report as string,
        concerns: chunk,
        locate,
        // The SAME set the first reading used: a correction is judged on the
        // abstracts its seat was given, not on none (ADR 0079 §2).
        abstractsHanded,
      });
    const reading =
      first === undefined
        ? readReport()
        : obs.report === first.text
          ? first.reading
          : mergeVerificationCorrection(first.reading, readReport());
    if (reading.failure !== undefined && reading.entries.size === 0) {
      limits.push({
        kind: "verification_missing",
        reason: "unparsed",
        detail: reading.failure,
      });
      explained.add(i);
      continue;
    }
    for (const [id, entry] of reading.entries) entries.set(id, entry);
  }

  const unexplained = chunks.some(
    (chunk, i) => !explained.has(i) && chunk.some((a) => !entries.has(a.id)),
  );
  if (unexplained) {
    limits.push({ kind: "verification_missing", reason: "incomplete" });
  }
  if (aborted()) interrupted = true;

  const statuses = fanOut.outcomes.map((o) => o.status);
  const usage = sumUsage(fanOut.outcomes.map((o) => o.usage));
  const settled: ReviewSeatState = {
    ...seat,
    status: statuses.every((s) => s === "completed")
      ? "completed"
      : statuses.includes("interrupted")
        ? "interrupted"
        : "failed",
    ...(retried ? { retried: true as const } : {}),
    ...(usage ? { usage } : {}),
    ...(isUnpriced(usage) ? { unpriced: true as const } : {}),
    verification: countVerification(located, entries),
  };
  return {
    entries,
    limits,
    state: limits.length === 0 ? "completed" : "missing",
    seat: settled,
    ...(usage ? { usage } : {}),
    interrupted,
  };
}
