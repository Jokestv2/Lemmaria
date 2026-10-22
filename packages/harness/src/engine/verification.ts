/**
 * The panel verifier's reply, read (V1, ADR 0076).
 *
 * One read-only child tries to refute each located concern from the
 * manuscript. What it may say is deliberately narrow: an `outcome`, a `kind`,
 * a `counter` quote that the HARNESS locates with the ledger's own locator, a
 * `central` answer on a major concern, and a note. There is no field in which
 * a concern could be rewritten — a verification points at a concern by id and
 * never restates it (ADR 0060 D7's rule, one role over).
 *
 * **This file is inside the v0.3 stage guard's scope** (`test/no-*.test.ts`):
 * its feedback strings are fed back inside the verifier's own loop, so they
 * are model-facing text, English only (invariant 6 rule 3).
 */

import type {
  DropReason,
  ReviewAnnotation,
  ReviewSpan,
  ReviewVerification,
  VerificationCounts,
  VerificationKind,
  VerificationOutcome,
} from "../contracts/data.js";
import { extractJsonPayload } from "./anchored-edit.js";
import type { Locator } from "./review.js";

/** How much of the verifier's own sentence is kept. One sentence is asked
 *  for; this bounds what a model that wrote a paragraph instead can put on a
 *  reader's screen. */
export const VERIFICATION_NOTE_CHARS = 280;

/** How much of a quote the feedback repeats — the ledger's own figure. */
const FEEDBACK_QUOTE_CHARS = 80;

const OUTCOMES: readonly VerificationOutcome[] = [
  "upheld",
  "refuted",
  "unverifiable",
];
const KINDS: readonly VerificationKind[] = [
  "absence",
  "contradiction",
  "literature",
  "judgment",
];
/**
 * The kinds a manuscript quote can never refute (ADR 0076 §3).
 *
 * `judgment` is an opinion and always will be. `literature` is conditional
 * since V2 (ADR 0078 §7): a claim about work outside the manuscript is
 * answerable **only** for a concern whose brief actually carried that work's
 * abstract — `abstractsHanded` says which those are. Without one the verifier
 * has nothing to reason from, and a refutation would be a guess.
 */
const NOT_REFUTABLE: readonly VerificationKind[] = ["judgment"];

export interface VerificationInput {
  /** The child's would-be final answer, or its settled report. */
  answer: string;
  /** The concerns THIS child was handed — ids outside it are problems. */
  concerns: readonly ReviewAnnotation[];
  /** The ledger's own locator, over the same manuscript (ADR 0076 §4). */
  locate: Locator;
  /**
   * V2 (ADR 0078 §7): the ids whose brief carried the abstract of the paper
   * they cite.
   *
   * A `literature` concern in this set may be **settled**, either way. One
   * outside it cannot be settled at all: a `refuted` downgrades to
   * `not_refutable` exactly as before, and an `upheld` to `no_abstract`
   * (ADR 0079 §2 — the half V2 built without). Absent means none, which is
   * what makes every pre-V2 caller — and every quick-action path — behave as
   * it did.
   *
   * **The refutation is still a MANUSCRIPT passage.** The abstract says what
   * the cited work is; the counter has to be the sentence where the manuscript
   * cites, compares against or distinguishes it. That is why this is a set of
   * ids and not a second kind of counter.
   */
  abstractsHanded?: ReadonlySet<string>;
}

export interface VerificationReading {
  /** Whole-answer failure (no JSON object, no `verifications` array).
   *  Model-facing English. */
  failure?: string;
  /** Recorded entries, by concern id. Empty when `failure` is set. */
  entries: ReadonlyMap<string, ReviewVerification>;
  /** What to feed back once: per-entry faults, downgrades and unanswered
   *  ids. Undefined when there is nothing to say. */
  problems?: string;
}

function quoteForFeedback(anchor: string): string {
  return anchor.length > FEEDBACK_QUOTE_CHARS
    ? `${anchor.slice(0, FEEDBACK_QUOTE_CHARS)}…`
    : anchor;
}

/** Why a counter-quote did not locate, as the verifier is told it — the
 *  ledger's own four sentences, reworded only in their subject. */
function counterNotFound(
  quote: string,
  error: DropReason,
  file: string | undefined,
): string {
  const q = `the counter quote "${quoteForFeedback(quote)}"`;
  if (error === "not_found") {
    return `${q} was not found in \`${file}\` or in any other file of the manuscript`;
  }
  if (error === "ambiguous") {
    return file === undefined
      ? `${q} is not in the file you named and appears in more than one other file of the manuscript`
      : `${q} appears more than once in \`${file}\``;
  }
  return `${q} names \`${file}\`, which is not a file of this manuscript, and was not found in any file that is`;
}

/**
 * Where a located counter lands on the concern's OWN record — the line it is
 * about, or the line the reviewer already offered as support. Undefined when
 * the counter is some other passage, which is the only case a refutation may
 * stand on.
 *
 * V1's J1 round: every withdrawal it read cited one of these two lines, so
 * the passage said to answer the concern was the passage the concern was
 * pointing at. Compared as file AND line: the same line number in another
 * file is a different passage, and says nothing.
 */
function ownLineOf(
  span: ReviewSpan,
  concern: ReviewAnnotation,
): "claim" | "evidence" | undefined {
  const same = (at: ReviewSpan): boolean =>
    at.file === span.file && at.line === span.line;
  if (same(concern.span)) return "claim";
  const evidence = concern.evidence;
  // V2 (ADR 0078): only a SPAN evidence has a line to collide with. A paper is
  // not in the manuscript at all, so a counter can never land "on" it.
  return evidence?.kind === "span" && same(evidence) ? "evidence" : undefined;
}

/** Why a counter the harness DID locate still refutes nothing, as the
 *  verifier is told it — `counterNotFound`'s voice, one case over. */
function counterIsTheConcern(
  quote: string,
  at: ReviewSpan,
  own: "claim" | "evidence",
): string {
  const line =
    own === "claim"
      ? "the very line this concern is about"
      : "this concern's own evidence line";
  return `the counter quote "${quoteForFeedback(quote)}" is at \`${at.file}:${at.line}\` — ${line} — so it answers nothing the concern does not already say; a refutation needs a DIFFERENT passage, the one that settles the concern. If the manuscript holds none, answer "upheld" or "unverifiable"`;
}

/**
 * Read one verifier reply (ADR 0076 §3). Pure — no I/O but the locator, which
 * is itself pure over the manuscript the driver read.
 *
 * Per entry, first match wins: a malformed entry, an id outside the brief, a
 * second entry for an id, or an unknown `kind` / `outcome` records nothing;
 * `refuted` on a kind the manuscript cannot refute, or with a counter the
 * harness cannot locate, is recorded as `unverifiable` and fed back. **A
 * concern is never withdrawn on a passage nobody can find.**
 */
export function interpretVerification(
  input: VerificationInput,
): VerificationReading {
  const failed = (failure: string): VerificationReading => ({
    failure,
    entries: new Map(),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(input.answer));
  } catch {
    return failed(
      'the reply must be pure JSON like {"verifications": [{"id": "...", "kind": "absence", "outcome": "upheld"}]} — no prose, no commentary',
    );
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return failed('the reply must be a JSON object with a "verifications" key');
  }
  if (!Array.isArray(obj.verifications)) {
    return failed(
      '"verifications" must be an array with one entry per concern in your brief',
    );
  }

  const byId = new Map(input.concerns.map((c) => [c.id, c]));
  const entries = new Map<string, ReviewVerification>();
  const lines: string[] = [];

  for (const [i, item] of obj.verifications.entries()) {
    const at = `entry ${i + 1}`;
    const e = item as Record<string, unknown> | null;
    if (
      e === null ||
      typeof e !== "object" ||
      Array.isArray(e) ||
      typeof e.id !== "string"
    ) {
      lines.push(
        `- ${at}: each entry must be a JSON object with a string "id"`,
      );
      continue;
    }
    const id = e.id;
    const concern = byId.get(id);
    if (concern === undefined) {
      lines.push(
        `- ${at}: "${id}" is not a concern in your brief — cite only ids from your brief`,
      );
      continue;
    }
    if (entries.has(id)) {
      lines.push(
        `- ${at}: a second entry for \`${id}\` — answer each concern once; your first entry for it stands`,
      );
      continue;
    }
    if (!KINDS.includes(e.kind as VerificationKind)) {
      lines.push(`- \`${id}\`: "kind" must be one of: ${KINDS.join(", ")}`);
      continue;
    }
    if (!OUTCOMES.includes(e.outcome as VerificationOutcome)) {
      lines.push(
        `- \`${id}\`: "outcome" must be one of: ${OUTCOMES.join(", ")}`,
      );
      continue;
    }
    const kind = e.kind as VerificationKind;
    const outcome = e.outcome as VerificationOutcome;

    // `central` answers a question asked only of a major concern; an answer
    // to a question that was not asked is dropped, and is not worth a re-ask.
    // It never touches `blocking` (ADR 0060 §4 stands).
    const extras: Pick<ReviewVerification, "central" | "note"> = {
      ...(concern.severity === "major" && typeof e.central === "boolean"
        ? { central: e.central }
        : {}),
      ...(typeof e.note === "string" && e.note.trim() !== ""
        ? { note: e.note.trim().slice(0, VERIFICATION_NOTE_CHARS) }
        : {}),
    };

    // V2's gate review, issue 2 (ADR 0079 §2): the no-abstract test is
    // DIRECTION-BLIND, and only the refuting half of it was built.
    //
    // Without the abstract the verifier has nothing to reason from about that
    // work, and an `upheld` is as much a claim about it as a `refuted` is —
    // `concern-verifier/SKILL.md` rules 2–3 say `unverifiable` in both
    // directions, and known-limits records the behaviour as *stays
    // unanswerable*. It did not: an `upheld` passed through wearing no mark at
    // all, the same as a checked concern, and the synthesis built a consensus
    // entry on it.
    //
    // An `unverifiable` answer is left alone — the verifier said what the
    // protocol asks for, and `downgraded` means *the model answered X and we
    // recorded Y*. The `refuted` half is left to the branch below, untouched:
    // its reason and its feedback sentence are what ADR 0078 §7 and V1's
    // merged O3 row record, and this finding is not about them.
    if (
      kind === "literature" &&
      outcome === "upheld" &&
      input.abstractsHanded?.has(id) !== true
    ) {
      entries.set(id, {
        outcome: "unverifiable",
        kind,
        // NOT `not_refutable`: that names a property of the KIND, and nothing
        // here was refuted. The cause is the missing abstract, in either
        // direction, and the record should say which one it was.
        downgraded: "no_abstract",
        ...extras,
      });
      lines.push(
        `- \`${id}\`: a literature concern whose brief carried no abstract cannot be settled from the manuscript either way — answer "unverifiable"`,
      );
      continue;
    }
    if (outcome !== "refuted") {
      // A counter on any other outcome is ignored, never located: only a
      // refutation needs the passage.
      entries.set(id, { outcome, kind, ...extras });
      continue;
    }
    // V2 (ADR 0078 §7): `literature` joins the un-refutable kinds UNLESS this
    // concern's brief carried the abstract behind the paper it cites.
    const unanswerable =
      NOT_REFUTABLE.includes(kind) ||
      (kind === "literature" && input.abstractsHanded?.has(id) !== true);
    if (unanswerable) {
      entries.set(id, {
        outcome: "unverifiable",
        kind,
        downgraded: "not_refutable",
        ...extras,
      });
      lines.push(
        `- \`${id}\`: a ${kind} concern cannot be refuted from the manuscript's own text — answer "unverifiable"`,
      );
      continue;
    }
    const counter = e.counter as Record<string, unknown> | null | undefined;
    const quote =
      counter !== null &&
      typeof counter === "object" &&
      !Array.isArray(counter) &&
      typeof counter.anchor === "string" &&
      counter.anchor !== "" &&
      (counter.file === undefined || typeof counter.file === "string")
        ? { anchor: counter.anchor, file: counter.file as string | undefined }
        : undefined;
    const downgrade = (
      why: string,
      reason: NonNullable<
        ReviewVerification["downgraded"]
      > = "counter_not_found",
    ): void => {
      entries.set(id, {
        outcome: "unverifiable",
        kind,
        downgraded: reason,
        ...extras,
      });
      lines.push(`- \`${id}\`: ${why}`);
    };
    if (quote === undefined) {
      downgrade(
        'it is marked "refuted" but carries no "counter" with a non-empty "anchor" — a refutation owes the passage that answers the concern',
      );
      continue;
    }
    const hit = input.locate(quote.anchor, quote.file);
    if ("error" in hit) {
      downgrade(counterNotFound(quote.anchor, hit.error, hit.file));
      continue;
    }
    const own = ownLineOf(hit.span, concern);
    if (own !== undefined) {
      downgrade(
        counterIsTheConcern(quote.anchor, hit.span, own),
        "counter_is_the_concern",
      );
      continue;
    }
    entries.set(id, { outcome: "refuted", kind, counter: hit.span, ...extras });
  }

  const unanswered = input.concerns
    .map((c) => c.id)
    .filter((id) => !entries.has(id));
  if (unanswered.length > 0) {
    lines.push(
      `- no entry for: ${unanswered.map((id) => `\`${id}\``).join(", ")} — answer every concern you were given, by its id`,
    );
  }
  return {
    entries,
    ...(lines.length > 0 ? { problems: describeProblems(lines) } : {}),
  };
}

/** The one re-ask's message: every problem at once, asking for corrections
 *  only — the ledger's shape (ADR 0074 §5), one role over. */
function describeProblems(lines: readonly string[]): string {
  return [
    "Some entries of your reply could not be recorded as given. Each is listed with its reason.",
    "",
    ...lines,
    "",
    'Reply once with one JSON object {"verifications": [...]} that holds ONLY your corrections to the entries listed above, each one complete. For a counter quote, open the file again and copy the passage exactly as it appears, from a single line, and name the `file` you copied it from. Every entry not listed above is already recorded: do not send it again. This is the only correction round.',
  ].join("\n");
}

/**
 * The correction round, merged (ADR 0076 §3; ADR 0074 §5's principle one role
 * over): **what was good the first time is never put back at risk.** For each
 * id the first entry stands unless it is absent or downgraded; then the second
 * reading's entry is taken if it is not itself worse — an un-downgraded entry
 * replaces a downgraded one, and a downgraded one only fills an absence.
 */
export function mergeVerificationCorrection(
  first: VerificationReading,
  second: VerificationReading,
): VerificationReading {
  if (second.failure !== undefined) return first;
  const entries = new Map(first.entries);
  for (const [id, next] of second.entries) {
    const prior = entries.get(id);
    if (prior === undefined) {
      entries.set(id, next);
    } else if (
      prior.downgraded !== undefined &&
      next.downgraded === undefined
    ) {
      entries.set(id, next);
    }
  }
  return {
    entries,
    ...(second.problems !== undefined ? { problems: second.problems } : {}),
  };
}

/**
 * Each annotation with its recorded verification attached (ADR 0076 §3).
 * Every other field is carried over untouched — a verification can change
 * nothing about what a reviewer said (stage-gate claim 2). A concern with no
 * entry is returned as it came, with no `verification` key.
 */
export function applyVerification(
  annotations: readonly ReviewAnnotation[],
  entries: ReadonlyMap<string, ReviewVerification>,
): ReviewAnnotation[] {
  return annotations.map((a) => {
    const v = entries.get(a.id);
    return v === undefined ? a : { ...a, verification: v };
  });
}

/** What the verifier's answers came to over the concerns it was handed. The
 *  identity `concerns === upheld + refuted + unverifiable + unanswered` holds
 *  by construction: each concern lands in exactly one of the four. */
export function countVerification(
  concerns: readonly ReviewAnnotation[],
  entries: ReadonlyMap<string, ReviewVerification>,
): VerificationCounts {
  const counts: VerificationCounts = {
    concerns: concerns.length,
    upheld: 0,
    refuted: 0,
    unverifiable: 0,
    downgraded: 0,
    unanswered: 0,
  };
  for (const c of concerns) {
    const v = entries.get(c.id);
    if (v === undefined) {
      counts.unanswered += 1;
      continue;
    }
    counts[v.outcome] += 1;
    if (v.downgraded !== undefined) counts.downgraded += 1;
  }
  return counts;
}

/** A concern the verifier withdrew — refuted on a located passage. */
export function isWithdrawn(a: ReviewAnnotation): boolean {
  return a.verification?.outcome === "refuted";
}

/**
 * Whether the *blocking* badge shows (ADR 0076 §6): the reviewer flagged the
 * concern, and the verifier did not answer that the paper's main claim
 * survives it. One predicate, so the tab and the compaction history cannot
 * disagree. It never edits the flag — ADR 0060 §4 stands.
 */
export function isBlocking(a: ReviewAnnotation): boolean {
  return a.blocking === true && a.verification?.central !== false;
}
