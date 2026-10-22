/**
 * `/review` — the blind review panel (R3, ADR 0061; R9, ADR 0069).
 *
 * **N standalone reviewers** that never see each other read the whole
 * manuscript, each through the same whole-review lens, each on a model the user
 * picked, and each returns a concern LEDGER (ADR 0060). The harness locates
 * every anchor in the manuscript's own bytes, parses each ledger, then asks one
 * more tool-less child to cross-review the located concerns BY ID — after every
 * report is frozen, and blind to which model wrote which. What no reviewer
 * could do is written into the result's honesty record by this driver, never by
 * a model.
 *
 * R3 partitioned the panel by LENS on one model (`soundness` / `claims` /
 * `positioning`); R9 replaced that with ordinal reviewers, because the
 * agreement analysis the cross-review already implemented is only meaningful
 * between reviewers who could have disagreed. The three lens questions survive
 * verbatim, in `REVIEW_LENS`, asked of every reviewer.
 *
 * **This file is inside the v0.3 stage guard's scope** (`test/no-*.test.ts`).
 * It holds every model-facing string the panel emits — the reviewer briefs, the
 * cross-review brief, and the interpreter feedback fed back inside a reviewer's
 * own loop — and those are exactly the surfaces that guard is about.
 * Model-facing text here is **English only** (invariant 6 rule 3); every
 * reader-facing string the panel produces lives in the host's own tables.
 */

import { randomUUID } from "node:crypto";
import type {
  ChildModel,
  CompileResult,
  ManuscriptGraphReader,
  ModelBinding,
  PdfDocument,
  ReviewPdfDeps,
  Usage,
  Workspace,
} from "../contracts/adapters.js";
import { PANEL_DIMENSIONS as CONTRACT_PANEL_DIMENSIONS } from "../contracts/data.js";
import type {
  LedgerCounts,
  ModelFailureCause,
  ModelFailureClass,
  PdfFacts,
  ReviewAnnotation,
  ReviewLimit,
  ReviewPdfRecord,
  ReviewPdfSource,
  ReviewResult,
  ReviewSynthesis,
  ReviewVerification,
  SeatBudget,
  Warning,
} from "../contracts/data.js";
import type {
  NoticeItem,
  ReviewItem,
  ReviewPreflight,
  ReviewSeatState,
  SessionEvent,
  SessionItem,
  SessionTaskBudget,
} from "../contracts/sessions.js";
import type { Skill } from "../contracts/skills.js";
import type { ToolName } from "../contracts/tools.js";
import {
  auxOfAnotherBuild,
  correctFloatPages,
  recordUncheckedPages,
} from "../engine/float-pages.js";
import { type LiteratureResult, sameTitle } from "../engine/literature.js";
import { computePdfFacts } from "../engine/pdf-facts.js";
import { reviewFurniture } from "../engine/review-furniture.js";
import {
  type LedgerOutcome,
  type ParsedLedger,
  type SeatOutcome,
  assembleReview,
  describeLedgerProblems,
  interpretLedger,
  interpretSynthesis,
  mergeLedgerCorrection,
  setAsideConcerns,
} from "../engine/review.js";
import type { LiteratureWithhold } from "../engine/tools.js";
import {
  applyVerification,
  isBlocking,
  isWithdrawn,
} from "../engine/verification.js";
import {
  discoverPaperEntry,
  matchesFileGlob,
  shouldSkipDir,
} from "../engine/workspace-utils.js";
import { canSeeImages } from "../model/capabilities.js";
import { classifyModelForSession } from "../model/floor.js";
import { type BudgetUsed, carveChildBudget } from "./budget.js";
import {
  type FanOutChild,
  type FanOutDeps,
  type FanOutOutcome,
  runFanOut,
} from "./loop-tools/fan-out.js";
import {
  type ViewPdfPagesTool,
  createViewPdfPagesTool,
} from "./loop-tools/pdf-pages.js";
import { MAX_FAN_OUT } from "./loop-tools/subtask.js";
import { manuscriptTitle } from "./manuscript-title.js";
import {
  PDF_REVIEWER_NAME,
  PDF_SKILL,
  confirmedFloatPages,
  isPdfArgumentConcern,
  pdfReviewerBrief,
} from "./review-pdf-seat.js";
import { PDF_FRESHNESS_SLACK_MS, resolveReviewPdf } from "./review-pdf.js";
import { VERIFIER_TOOLS, runVerification } from "./review-verifier.js";
import { classifyStreamFailure } from "./stream-errors.js";
import { narrowChildTools, sumUsage } from "./subtasks.js";
import type { FinalAnswerCheck } from "./task-hooks.js";

/** The bundled protocol skill every seat is made to load (ADR 0061 §D4). */
export const PANEL_SKILL = "blind-reviewer";

/**
 * The dimensions a seat may raise a concern under — passed to every seat as
 * `allowedDimensions`, so any seat may raise a `clarity` concern whatever its
 * lens. Deliberately not the quick action's four wholesale (`clarity, rigor,
 * structure, language`, ADR 0008): those describe a pass over one unit of
 * prose, these describe a review of a paper. Two of the words are shared, and
 * on purpose — `clarity` since R3, and `language` since ADR 0063.
 *
 * **`language` is load-bearing, not decorative** (ADR 0063 §1). It is the
 * dimension the surface reads to tell a mechanical fix from a substantive
 * concern: a `language` concern carrying a `suggestion` is a copyedit the
 * author can adopt as a diff, and everything else is handed to the assistant
 * to work through. The protocol tells every seat when to use it, because a
 * dimension nobody is told to reach for is a dimension nothing ever lands in.
 *
 * **The list itself moved to the contracts at V2** (ADR 0078, D9), where the
 * eval instrument and the tab's labels can read the same words the brief does.
 *
 * **Since V4 (ADR 0081) this is the REVIEWERS' list — the contract's less
 * `presentation`.** That dimension requires a page of the compiled PDF as its
 * evidence, which only the PDF reviewer can cite, so a text reviewer is never
 * offered it: its brief still lists seven and its ledger still accepts seven,
 * byte for byte. The PDF reviewer reads the contract's eight directly. Exported
 * under the name every caller of the driver has always reached for; the
 * package index re-exports the CONTRACT's list under that name, so the two
 * never meet in one import.
 */
export const REVIEWER_DIMENSIONS: readonly string[] =
  CONTRACT_PANEL_DIMENSIONS.filter((d) => d !== "presentation");
export { REVIEWER_DIMENSIONS as PANEL_DIMENSIONS };

/**
 * V5 (ADR 0087 §2): the one dimension the PDF reviewer is asked to ASSESS —
 * the only one that is its own (the addendum's *the argument is not yours*).
 * Its ledger is still read with all eight allowed; its impression is of this.
 */
export const PDF_ASSESSED_DIMENSION = "presentation";

/**
 * The per-seat output-token carve below which a seat is unlikely to read a
 * manuscript AND write a ledger. Crossing it emits `review.seat_budget` and the
 * panel **still runs**: the budget is the user's dial (invariant 5), and the
 * honest outcome of a starved seat is a `seat_missing` limit saying so, not a
 * refusal to try.
 */
export const PANEL_SEAT_TOKEN_FLOOR = 4_000;

/**
 * How many reviewers run when the host configures none (R9, ADR 0069).
 *
 * The harness's own default, so the CLI, the eval driver and every test get
 * the shipped panel without restating the extension's store. The host's
 * default lives in `ReviewRolesStore` and says the same thing in its terms.
 */
export const DEFAULT_REVIEWER_COUNT = 3;

/**
 * One name per possible reviewer, in order; `length === MAX_FAN_OUT`.
 *
 * **The letter is the ORDINAL, never the model.** Two reviewers may share a
 * model (that is the operator's brief for R9), so a name derived from the model
 * would collide — and `assembleReview` THROWS on a duplicate reviewer name,
 * because concern ids are reviewer-prefixed and two `gpt-5.6-luna-1`s are one
 * concern the tab cannot tell apart. Which model each reviewer ran on is in the
 * record (`ReviewSeatState.model`), where a reader looks for reviewer facts.
 */
export const REVIEWER_NAMES = [
  "reviewer_a",
  "reviewer_b",
  "reviewer_c",
  "reviewer_d",
  "reviewer_e",
  "reviewer_f",
  "reviewer_g",
  "reviewer_h",
] as const;

/** What the host asks for, per reviewer. `model` absent ⇒ the parent's. */
export interface ReviewerSpec {
  model?: ChildModel;
}

/** One reviewer of the panel: its ordinal name, and the model it runs on. */
export interface PanelReviewer {
  name: string;
  model?: ChildModel;
}

/**
 * The panel the driver will run (ADR 0069 §D1).
 *
 * Absent or empty `specs` ⇒ `DEFAULT_REVIEWER_COUNT` reviewers on the parent's
 * own model. Otherwise one reviewer per spec, **clamped to `MAX_FAN_OUT`** —
 * a request can only ask for less (invariant 5), and the eighth-and-later are
 * dropped. The driver additionally SAYS so, through `review.reviewers_clamped`;
 * this function is silent because it is pure.
 */
export function panelReviewers(
  specs: readonly ReviewerSpec[] | undefined,
): PanelReviewer[] {
  const wanted: readonly ReviewerSpec[] =
    specs === undefined || specs.length === 0
      ? Array.from<unknown, ReviewerSpec>(
          { length: DEFAULT_REVIEWER_COUNT },
          () => ({}),
        )
      : specs;
  return wanted.slice(0, MAX_FAN_OUT).map((spec, i) => ({
    name: REVIEWER_NAMES[i] as string,
    ...(spec.model ? { model: spec.model } : {}),
  }));
}

/**
 * The whole-review lens every reviewer reads through (ADR 0069 §D1).
 *
 * R3's three seat lenses, kept **verbatim** as three sentences — because they
 * were the right questions and only the topology was wrong — plus the sentence
 * that used to sit on the positioning seat alone. A reviewer is asked all
 * three because that is what a referee is asked; they stay QUESTIONS because
 * R3 found that a topic is something a model restates and a question is
 * something it has to answer.
 */
export const REVIEW_LENS = [
  "Do the methods actually support the claims? Are the statistics, the proofs, or the arguments sound as given? What is missing that the central case needs in order to hold?",
  "Does every claim the abstract and the conclusion make follow from what the manuscript shows? Look for over-claims, unsupported generalisations, and results the text describes but never gives.",
  "Is the contribution stated against the right prior work? Is anything claimed as new that the literature already has, and is the related-work framing fair to it?",
  "Searching the literature is expected of every reviewer, not optional.",
].join(" ");

/**
 * `/review [focus]` over a WHOLE message (ADR 0061 §1).
 *
 * The second harness-parsed composer verb, and it follows `parseForkCommand`'s
 * grammar exactly: anchored, so *"we should /review this before submitting"*
 * stays a message to the model. `{}` = review with no focus; `{focus}` = the
 * user's own words, forwarded **verbatim** to every seat and to the synthesis
 * (invariant 6 rule 1). `null` = this is not the command, send it as prose.
 *
 * **The focus is never scanned for `/skill:`.** A `/skill:` inside a `/review`
 * message is part of the focus text: the branch that consumes this runs before
 * the synthetic load exchanges, and a panel's seats are equipped by the driver,
 * not by whatever the user typed.
 *
 * **The trailing-space case is the common one, not an edge** — the composer row
 * is insert-kind, so accepting it leaves exactly `"/review "` behind, and a
 * pattern that failed there would send the command to the model as prose.
 * Multi-line focus is accepted (`[\s\S]`): a pasted paragraph of concerns is a
 * focus, and refusing it would be a grammar the composer does not warn about.
 */
export function parseReviewCommand(text: string): { focus?: string } | null {
  const m = /^\s*\/review(?:\s+(\S[\s\S]*?))?\s*$/.exec(text);
  if (m === null) return null;
  const focus = m[1];
  return focus === undefined ? {} : { focus };
}

/** The workspace surface the driver needs — reads and a listing, nothing more.
 *  Narrow on purpose: a panel never writes, so a port that could would be a
 *  capability the milestone does not use (invariant 3).
 *
 *  V4 (ADR 0081): plus `stat` and `readBinary`, both optional on `Workspace`
 *  already, so every implementation compiles unchanged. They are how the PDF
 *  policy finds a compiled PDF; a host that gives neither gets
 *  `pdf_unavailable / none`, which is honest. Both are READS. */
export type ManuscriptWorkspace = Pick<
  Workspace,
  "root" | "readFile" | "listFiles" | "stat" | "readBinary"
>;

/** The manuscript the seats read: every file they may cite, plus where a bare
 *  anchor locates. */
export interface Manuscript {
  files: ReadonlyMap<string, string>;
  /** Workspace-relative path of the entry. ALWAYS a key of `files`. */
  defaultFile: string;
  /**
   * How the file set was decided (X5, ADR 0074 §4). `"graph"` is the entry's
   * own include graph; `"glob"` is the pre-X5 suffix sweep, which survives as
   * the recorded fallback and raises `review.manuscript_unresolved`.
   */
  resolved: "graph" | "glob";
  /** How many files the manuscript DECLARES that could not be read. Always 0
   *  under `"glob"`, which has nothing to compare a listing against. */
  missing: number;
}

/** Which files a panel reads. Source and bibliography only — a seat cites
 *  prose and citation keys, and nothing else in a project is quotable text. */
const MANUSCRIPT_SUFFIXES = [".tex", ".md", ".bib"] as const;

/**
 * Read the manuscript into the map `interpretLedger` locates against.
 *
 * **The entry is read explicitly, whatever `listFiles` returned**, and that is
 * the load-bearing line: `interpretLedger` THROWS when its `defaultFile` is not
 * a key of `files`, because a driver that let those disagree is a driver bug,
 * not a model error (ADR 0060). A workspace whose listing happens to omit the
 * entry — a filter, a symlink, a race with a save — must not turn into a throw
 * halfway through a paid fan-out.
 *
 * An unreadable file is skipped rather than fatal: one file the host cannot
 * serve should cost the panel that file's anchors, not the whole review. The
 * entry itself is the exception — if that cannot be read there is no manuscript,
 * and the caller's precondition says so honestly.
 */
export async function collectManuscript(
  workspace: ManuscriptWorkspace,
  entry: string,
  graph?: ManuscriptGraphReader,
): Promise<Manuscript> {
  const files = new Map<string, string>();

  // X5 (ADR 0074 §4): the manuscript is the entry's include graph. Only files
  // the paper declares reach a reviewer — a second paper in the same folder,
  // an `official_reviews/`, a `rebuttal/` and Lemmaria's own `PAPER.md` all
  // stop being quotable, because a concern anchored in them is not a concern
  // about this paper.
  if (graph !== undefined) {
    let resolved: Awaited<ReturnType<ManuscriptGraphReader>>;
    try {
      resolved = await graph(entry, (path) => workspace.readFile(path));
    } catch {
      // A reader that fell over is a reader that covers nothing — the glob
      // below is the honest fallback, and the notice says it ran.
      resolved = undefined;
    }
    if (resolved !== undefined) {
      // In reading order, so the map's insertion order is the paper's — which
      // is the order the brief then lists for the seats. No skip list applies:
      // a graph follows declared edges, so there is nothing to skip.
      for (const path of resolved.files) {
        try {
          files.set(path, await workspace.readFile(path));
        } catch {
          // As below: one unreadable file costs its own anchors.
        }
      }
      // Unconditionally, as the glob path does and for the same reason — the
      // entry must be a key whatever the reader returned. Re-setting an
      // existing key keeps its position, so an entry the graph already listed
      // first STAYS first, and one it omitted is appended rather than missing.
      files.set(entry, await workspace.readFile(entry));
      return {
        files,
        defaultFile: entry,
        resolved: "graph",
        missing: resolved.missing.length,
      };
    }
  }

  let listed: string[] = [];
  try {
    listed = await workspace.listFiles();
  } catch {
    // A listing that fails leaves the entry alone, which is still a manuscript.
    listed = [];
  }
  for (const path of listed) {
    if (path === entry) continue;
    const segments = path.split(/[\/]/);
    if (segments.slice(0, -1).some((s) => shouldSkipDir(s))) continue;
    if (!MANUSCRIPT_SUFFIXES.some((s) => matchesFileGlob(path, `*${s}`)))
      continue;
    try {
      files.set(path, await workspace.readFile(path));
    } catch {
      // One unreadable file costs its own anchors, never the whole review.
    }
  }
  files.set(entry, await workspace.readFile(entry));
  // The pre-X5 suffix glob, kept as the RECORDED fallback (ADR 0074 §4): it
  // still reviews the paper, and `review.manuscript_unresolved` says that is
  // what happened.
  return { files, defaultFile: entry, resolved: "glob", missing: 0 };
}

/**
 * Which of the skill's two anchor forms this manuscript needs (ADR 0061 §7).
 *
 * R2's live row measured the failure this exists to prevent: over a `.tex`
 * hard-wrapped at ~75 columns, both pins returned quotes that were verbatim in
 * CONTENT and joined the file's newlines with spaces, and 7 of 8 and 6 of 8
 * claim anchors failed to locate. The remedy is a sentence in the brief, never
 * a locator that matches across whitespace — that would be the harness
 * supplying a position.
 *
 * The 90th percentile rather than the mean, because a wrapped source still has
 * short lines (headings, `\end{...}`, a lone `\item`) and a mean over them
 * would call an unwrapped document wrapped. Comment lines are dropped for the
 * same reason in reverse: a long `% TODO` says nothing about the prose.
 */
export function describeWrapping(text: string): string {
  const lengths = text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("%"))
    .map((line) => line.length)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return WRAPPED_HINT;
  // Nearest-rank: the 90th percentile is the ceil(0.9n)-th value, so index
  // ceil(0.9n) - 1. `floor(0.9n)` sits one past it and, on a short sample,
  // lands on the maximum — which would call every document long-lined on the
  // strength of its single longest line.
  const at = Math.min(
    lengths.length - 1,
    Math.max(0, Math.ceil(lengths.length * 0.9) - 1),
  );
  return (lengths[at] as number) <= WRAP_COLUMN_THRESHOLD
    ? WRAPPED_HINT
    : LONG_LINE_HINT;
}

/** Above this 90th-percentile line length a source is not hard-wrapped. */
export const WRAP_COLUMN_THRESHOLD = 100;

const WRAPPED_HINT =
  "The source is hard-wrapped: quote ONE WHOLE LINE, exactly as it appears, never a sentence that continues on the next line.";

const LONG_LINE_HINT =
  "The source has long lines: quote a distinctive clause that sits within ONE line, never a run that crosses a line break.";

/** What every reviewer's brief needs to know about this particular review. */
export interface BriefContext {
  /** Workspace-relative path of the manuscript's entry. */
  entry: string;
  /** Every file the reviewer may cite, entry first. */
  files: readonly string[];
  /** `describeWrapping` over the entry — which anchor form applies here. */
  wrapping: string;
  /** The user's `/review` argument, verbatim, when they gave one. */
  focus?: string;
}

/**
 * One reviewer's goal (ADR 0069 §D1). English only — this is model-facing text
 * (invariant 6 rule 3), and the manuscript's own language is whatever the
 * author wrote, which the reviewer reads through the tools it was given.
 *
 * It opens with the forced protocol load, exactly as R3's `seatBrief` did, so
 * the child's own head-of-task parse turns it into a real `load_skill`
 * exchange before the reviewer's first turn (ADR 0059, ADR 0061 §4).
 *
 * **No brief names a model** — its own or another's. A reviewer told it is
 * *the haiku one* reviews differently, and which model ran is a fact for the
 * record (`ReviewSeatState.model`), not for the reviewer's own head. It is
 * also what keeps R5's hivemind measurement honest: the agreement between two
 * reviewers on one model has to be observed, not anticipated.
 */
export function reviewerBrief(
  reviewer: PanelReviewer,
  total: number,
  ctx: BriefContext,
): string {
  const lines = [
    `/skill:${PANEL_SKILL}`,
    "",
    `You are \`${reviewer.name}\`, one of ${total} independent reviewers on a blind review panel. Follow the ${PANEL_SKILL} protocol you have just been given, in full. Read through every angle below; a lens is where you look hardest, not a fence.`,
    "",
    REVIEW_LENS,
    "",
    manuscriptFilesSentence(ctx),
    "",
    ctx.wrapping,
    "",
    `Every concern's \`dimension\` must be one of: ${REVIEWER_DIMENSIONS.join(", ")}. You may raise a concern under any of them.`,
    "A pure language error — a typo, a misspelling, a grammatical or article mistake, a wrong preposition — goes under `language`, and every `language` concern must carry a `suggestion` that is the corrected text and nothing more. Do not raise a substantive problem under `language` because you happen to have wording for it: `language` is for what a copy-editor fixes without reading the argument.",
    // V2 (ADR 0078 §6): the two dimensions the panel gained, distinguished
    // from each other and from `positioning` — a reviewer that cannot tell
    // *this already exists* from *I suspect it does* will file both as the
    // first, and only one of them is a finding.
    "Use `originality` only with a paper one of your own searches returned as its evidence; use `significance` for whether the contribution would matter if every claim held.",
  ];
  if (ctx.focus !== undefined) {
    lines.push(
      "",
      "The author asked the panel to attend to the following. Read it as emphasis, not as a fence — raise anything else you find:",
      ctx.focus,
    );
  }
  lines.push("", "Your reply is exactly one JSON ledger and nothing else.");
  return lines.join("\n");
}

/**
 * Which files the manuscript is, as a brief tells a child (X5, ADR 0074 §4).
 *
 * The files, in READING ORDER. What this replaced told every seat that
 * `main.tex` was "the manuscript's main file" and to read it in full — which
 * on an \input-split paper is an instruction to read a preamble, and is how
 * 89% of one real manuscript's dropped anchors came to be dropped.
 *
 * One builder, since V1 (ADR 0076 §5): the verifier's brief carries the same
 * sentence a reviewer was given, word for word, rather than a re-wording that
 * could drift from it.
 */
export function manuscriptFilesSentence(ctx: BriefContext): string {
  return ctx.files.length > 1
    ? `The manuscript is these files, in reading order: ${ctx.files.map((f) => `\`${f}\``).join(", ")}. Read all of them before you write anything — the first file may hold little of the prose. Name the \`file\` each quote was copied from.`
    : `The manuscript is one file, \`${ctx.entry}\`. Read it in full before you write anything. Every anchor is in it, so never name \`file\` on a concern.`;
}

/**
 * The synthesis seat's goal (ADR 0061 §2 and §7). It runs only after every
 * seat's report is frozen, with an EMPTY tool set and no skill: its whole input
 * is the located concerns below, so a tool would only let it go and look at
 * something the panel already read.
 *
 * It is given the concerns as compact JSON rather than as the seats' raw
 * reports, and that is the point — a synthesis that could see a seat's prose
 * could restate it, and `interpretSynthesis` accepts only notes that point at
 * concerns by id.
 */
export function synthesisBrief(
  annotations: readonly ReviewAnnotation[],
  reviewerCount: number,
  focus?: string,
): string {
  const rows = annotations.map((a) => ({
    id: a.id,
    reviewer: a.reviewer,
    dimension: a.dimension,
    severity: a.severity,
    ...(a.blocking === true ? { blocking: true } : {}),
    at: `${a.span.file}:${a.span.line}`,
    message: a.message,
  }));
  const lines = [
    `${reviewerCount} reviewers have each read the same manuscript without seeing one another. Their concerns are below, already located in the manuscript and given stable ids.`,
    "",
    JSON.stringify({ concerns: rows }),
    "",
  ];
  if (focus !== undefined) {
    lines.push(
      "The author asked the panel to attend to the following; weigh it when you decide what is worth saying:",
      focus,
      "",
    );
  }
  lines.push(
    "Write what the panel as a whole says. Reply with exactly one JSON object and nothing else:",
    '{"consensus": [{"ids": ["..."], "note": "..."}], "disagreements": [{"ids": ["..."], "note": "..."}]}',
    "",
    "Rules:",
    "- Every entry must cite at least two ids from DIFFERENT reviewers. An observation about one reviewer is not an observation about the panel.",
    "- A note is ABOUT the concerns it cites — what the reviewers agree on, or where they pull against each other. Never restate a concern, never add one of your own, and never suggest an edit.",
    "- Both arrays may be empty. If the reviewers neither converged nor conflicted, say nothing rather than manufacturing a pattern.",
    "- Cite only ids that appear above.",
  );
  return lines.join("\n");
}

/**
 * A completed review, rendered for the compaction history (ADR 0061 §9).
 *
 * `plainHistory` sees only `user_message`, `agent_message` and `tool_call`, so
 * without this a compaction after a `/review` would silently drop the review —
 * the model would go on discussing a paper whose concerns had evaporated from
 * its context. English, because compaction handoffs are model-facing.
 *
 * Deliberately lossy in one direction only: it keeps every concern's identity,
 * position and message, so a later turn can still refer to `reviewer_a-2`, and
 * it drops the evidence spans and the suggestions, which are the tab's job and
 * are still on disk.
 *
 * **R9 (§D4): it names which model each reviewer ran on.** A compaction after a
 * MIXED panel would otherwise lose the one fact that makes the panel's
 * agreement interpretable — two reviewers agreeing means something different
 * when they are the same model than when they are not.
 */
export function renderReviewForHistory(
  result: ReviewResult,
  seats?: readonly ReviewSeatState[],
  synthesisSeat?: ReviewSeatState,
  verifierSeat?: ReviewSeatState,
  /** V4 (ADR 0081 §3): the PDF reviewer's sibling row, when one ran. */
  pdfSeat?: ReviewSeatState,
): string {
  // V1 (ADR 0076 §7): a compaction handoff must not hand the assistant a
  // withdrawn concern as live. The count rides the opening line BY EXCEPTION,
  // so a review with nothing withdrawn reads exactly as it did before V1.
  const withdrawn = result.annotations.filter(isWithdrawn).length;
  // V4 (ADR 0081 §7): a `/review-pdf` run is one seat and no panel, so its
  // handoff must not call it one — the code review's catch.
  const pdfOnly =
    (seats === undefined || seats.length === 0) && pdfSeat !== undefined;
  const lines: string[] = [
    `${pdfOnly ? "PDF review result" : "Review panel result"} — ${result.annotations.length} located concern(s)${
      withdrawn > 0 ? `, ${withdrawn} withdrawn by verification` : ""
    }.`,
  ];
  // Both guards, not just `!== ""`: replay normalizes a pre-R9 row to `""`,
  // and a row that reached here without passing through replay would
  // otherwise put `reviewer_a=undefined` into a compaction handoff.
  const named = (seats ?? []).filter(
    (s) => s.model !== undefined && s.model !== "",
  );
  if (named.length > 0) {
    lines.push(
      `reviewers: ${named.map((s) => `${s.reviewer}=${s.model}`).join(", ")}${
        synthesisSeat !== undefined && synthesisSeat.model !== ""
          ? `; synthesis=${synthesisSeat.model}`
          : ""
      }${
        // V1: the verifier too — whether a concern was checked by a relative
        // of the model that raised it is the same kind of fact.
        verifierSeat?.model !== undefined && verifierSeat.model !== ""
          ? `; verifier=${verifierSeat.model}`
          : ""
      }${
        // V4: the PDF reviewer too — it is a seat whose concerns are here.
        pdfSeat?.model !== undefined && pdfSeat.model !== ""
          ? `; ${PDF_REVIEWER_NAME}=${pdfSeat.model}`
          : ""
      }`,
    );
  } else if (pdfSeat?.model !== undefined && pdfSeat.model !== "") {
    // A PDF-only review has no reviewers to name, and still has a seat.
    lines.push(`reviewers: ${PDF_REVIEWER_NAME}=${pdfSeat.model}`);
  }
  // V4 (ADR 0081 §5): a handoff must not present a concern about the rendered
  // page as one the verifier checked — it never reads them.
  if (result.annotations.some((a) => a.reviewer === PDF_REVIEWER_NAME)) {
    lines.push(
      `${PDF_REVIEWER_NAME}'s concerns are about the rendered page of the compiled PDF and were not checked by the verifier.`,
    );
  }
  for (const a of result.annotations) {
    // V1 (ADR 0076 §6): the flag goes through the one predicate the tab uses,
    // so the history and the badge cannot disagree.
    const flags = [a.severity, ...(isBlocking(a) ? ["blocking"] : [])];
    const counter = a.verification?.counter;
    const withdrawnAt =
      isWithdrawn(a) && counter !== undefined
        ? ` · withdrawn by verification (answered at ${counter.file}:${counter.line})`
        : "";
    lines.push(
      `${a.id} · ${flags.join(" · ")} · ${a.dimension} · ${a.span.file}:${a.span.line}${withdrawnAt} — ${a.message}`,
    );
  }
  const synthesis = result.synthesis;
  if (synthesis !== undefined) {
    for (const [label, entries] of [
      ["consensus", synthesis.consensus],
      ["disagreement", synthesis.disagreements],
    ] as const) {
      for (const entry of entries) {
        lines.push(`${label} (${entry.ids.join(", ")}) — ${entry.note}`);
      }
    }
  }
  for (const limit of result.limits ?? []) {
    lines.push(`limit: ${describeLimitForHistory(limit)}`);
  }
  return lines.join("\n");
}

/** ADR 0082 §2: each budget as the history line names it. */
const BUDGET_FOR_HISTORY: Readonly<Record<SeatBudget, string>> = {
  turns: "turn",
  tool_calls: "tool-call",
  output_tokens: "output-token",
};

/** One honesty-record entry as one English line. Model-facing, so it names the
 *  kind rather than rendering a reader's sentence — the host has its own. */
function describeLimitForHistory(limit: ReviewLimit): string {
  switch (limit.kind) {
    case "anchors_dropped":
      return `anchors_dropped — ${limit.anchors.length} anchor(s) from ${limit.reviewer} could not be located`;
    case "seat_missing":
      // X5: the cause, where the child's own policy classified one. Appended
      // by exception, so a seat that carried none reads exactly as before —
      // and so, ADR 0082 §2, is the budget a seat ran out of.
      return `seat_missing — ${limit.reviewer} reported nothing usable (${limit.reason})${causeForHistory(limit.cause)}${
        limit.ranOutOf !== undefined
          ? ` — it ran out of its ${BUDGET_FOR_HISTORY[limit.ranOutOf]} budget`
          : ""
      }`;
    case "entries_rejected":
      // X5: the COUNT and the reviewer. The per-entry `reason` strings are the
      // re-ask's channel, and the model that wrote them has already been told.
      return `entries_rejected — ${limit.entries.length} entry(ies) of ${limit.reviewer}'s report violated the ledger's shape and were not recorded`;
    case "concerns_set_aside":
      // ADR 0083 §2: the count and the reviewer, so a compaction handoff does
      // not present the kept concerns as everything the seat raised.
      return `concerns_set_aside — ${limit.entries.length} concern(s) of ${limit.reviewer} outside presentation cited no page and were set aside; the text reviewers review the argument`;
    case "pages_corrected":
      // ADR 0084: the count and the moves, so a later turn quoting a page
      // knows the harness placed it, not the reviewer.
      return `pages_corrected — ${limit.entries.length} page citation(s) of ${limit.reviewer} named a page other than the one the anchored figure or table sits on, and were moved to it (${limit.entries
        .map((e) => `${e.id}: ${e.cited} → ${e.page}`)
        .join(", ")})`;
    case "furniture_set_aside":
      // ADR 0085 §2: as concerns_set_aside, so the kept concerns never read
      // as everything the seat raised.
      return `furniture_set_aside — ${limit.entries.length} concern(s) of ${limit.reviewer} about what the document class prints for review (an author block the anonymous option hides, a template placeholder DOI or ISBN) were set aside`;
    case "pages_unchecked":
      // ADR 0085 §3: a later turn quoting one of these pages should know the
      // harness did not check it.
      return `pages_unchecked — ${limit.entries.length} page citation(s) of ${limit.reviewer} anchored in a figure or table were not checked against the float's page: the .aux beside the PDF ${
        limit.reason === "aux_older_than_pdf"
          ? "is older than the PDF"
          : "counts a different number of pages than the PDF"
      } (${limit.entries.map((e) => e.id).join(", ")})`;
    case "strengths_lost":
      // V5 (ADR 0087 §1): the count and the reviewer. Strengths are not
      // compaction material, so neither are the ones that were lost.
      return `strengths_lost — ${limit.reviewer}: ${limit.dropped.length + limit.rejected.length} strength(s) not recorded`;
    case "seat_unguided":
      return `seat_unguided — ${limit.reviewer} never loaded the panel protocol`;
    case "source_unavailable":
      // R4: the anonymous clause is the model's cue to tell the user a key
      // would raise the limit — by exception, so a keyed source that failed
      // anyway reads exactly as it did before.
      return `source_unavailable — ${limit.source} did not answer ${limit.reviewer} (${limit.status})${
        limit.anonymous === true
          ? " (anonymous — an API key raises the limit)"
          : ""
      }`;
    case "search_budget_spent":
      return `search_budget_spent — ${limit.reviewer} searched after the session's literature budget was spent`;
    case "synthesis_missing":
      return `synthesis_missing — no synthesis (${limit.reason})${causeForHistory(limit.cause)}`;
    case "verification_missing":
      // V1 (ADR 0076): a compaction handoff must not present unchecked
      // concerns as checked ones.
      return `verification_missing — concerns were not checked against the manuscript (${limit.reason})${causeForHistory(limit.cause)}`;
    case "own_title_unguarded":
      // V2 (ADR 0078 §D8): a handoff must not present a review whose searches
      // could have returned the paper itself as one that could not.
      return `own_title_unguarded — literature searches were not kept from returning this manuscript (${limit.reason})`;
    // V4 (ADR 0081): the three ways a review falls short of the compiled PDF.
    // A handoff must not present a review that never saw the page as one that
    // did.
    case "pdf_unavailable":
      return `pdf_unavailable — the compiled PDF was not reviewed (${limit.reason})`;
    case "visual_unavailable":
      return `visual_unavailable — the compiled PDF was not reviewed (${limit.reason})`;
    case "pages_unviewed":
      return `pages_unviewed — the PDF reviewer viewed ${limit.viewed} of ${limit.total} pages`;
  }
}

/** A failure cause as the history's model-facing clause, or nothing. The
 *  provider's own sentence passes as authored (invariant 6 rule 2's boundary);
 *  this line is read by a model, in English, and never by a user. */
function causeForHistory(cause: ModelFailureCause | undefined): string {
  if (cause === undefined) return "";
  return cause.message === undefined
    ? ` — ${cause.class}`
    : ` — ${cause.class}: ${cause.message}`;
}

/** What the driver needs from the task that is running it. Everything here is
 *  already assembled by `run.ts`; the driver builds nothing of its own. */
export interface ReviewPanelDeps {
  /**
   * V2 (ADR 0078 §5): the host's literature-withholding holder — the SAME
   * object its tool registry closes over.
   *
   * The driver fills it with the manuscript's own title for the span of one
   * run and empties it on every exit. Absent means the host wired none, which
   * the record states as `own_title_unguarded / unavailable` rather than
   * passing over in silence.
   */
  literatureWithhold?: LiteratureWithhold;
  emit: (event: SessionEvent) => Promise<void>;
  emitItem: (item: SessionItem) => Promise<void>;
  emitNotice: (code: NoticeItem["code"], n: number) => Promise<void>;
  /** The same `runChild` `spawn_subtask` runs its children through. */
  runChild: FanOutDeps["runChild"];
  /** The parent task's own allowlist — a seat can only be narrowed within it. */
  parentAllowed: ToolName[];
  /** The skills this task was OFFERED. The protocol must be one of them. */
  offeredSkills: readonly Skill[];
  /** The task's resolved budget, and what it has spent — the carve's source. */
  budget: SessionTaskBudget;
  usedSoFar: () => BudgetUsed;
  accrue: (usage: Usage) => void;
  /** Concurrency width, already clamped by the caller (invariant 5). It is
   *  narrowed again to the panel's own size — N only ever asks for less. */
  fanOutConcurrency: number;
  /**
   * R9 (ADR 0069 §D2): the panel the host configured. Absent or empty ⇒
   * `DEFAULT_REVIEWER_COUNT` reviewers on the parent's own model, which is what
   * the CLI, the eval driver and every test get without restating the
   * extension's store.
   */
  reviewers?: readonly ReviewerSpec[];
  /** R9: the cross-review child's model. Absent ⇒ the parent's. */
  synthesis?: ChildModel;
  /**
   * V1 (ADR 0076 §5): the verifier's model, or `"off"`. **Absent means the
   * cross-review's** (itself absent ⇒ the parent's) — one model, preflighted
   * once. `"off"` makes no request of any kind and records a
   * `verification_missing / off` limit.
   */
  verifier?: ChildModel | "off";
  /**
   * R9 (§D4): the parent's own model id, stamped on every reviewer that
   * inherited it. Passed in rather than read off `deps.runChild`, which is a
   * function and knows nothing about what it is bound to.
   */
  parentModel: string;
  /**
   * The parent's own adapter and binding (X5, ADR 0074 §6) — what a reviewer
   * or the cross-review runs on when the host bound it no model of its own.
   *
   * **Required, not optional.** The parent is exactly the binding three
   * default reviewers inherit, so a construction site that forgot it would
   * skip the check on the most common panel there is while the record said the
   * preflight ran. `parentModel` stays beside it: that is the id string for
   * stamping a seat, this is what the driver actually calls.
   */
  parent: ChildModel;
  /** The manuscript port; absent ⇒ `review.no_manuscript`. */
  workspace?: ManuscriptWorkspace;
  /**
   * Resolves the entry's include graph (X5, ADR 0074 §4). Host-injected,
   * because the walk lives in the adapters and the harness must not depend on
   * them (invariant 1).
   *
   * **Absent is deny-by-default**: the panel falls back to the suffix glob and
   * emits `review.manuscript_unresolved`, so a host that forgot to wire it has
   * a panel that still works and says what it is reading.
   */
  manuscriptGraph?: ManuscriptGraphReader;
  /** The host's chosen entry; absent ⇒ discovered, and absent then too ⇒ refuse. */
  paperEntry?: string;
  /**
   * A compiled PDF the user named (V3, ADR 0080 §8), root-relative. Read by
   * V4's PDF policy call — only when the PDF reviewer could run.
   */
  paperPdf?: string;
  /**
   * V4 (ADR 0081 §2): what the review needs to see the compiled paper — a
   * renderer, and optionally a compile, a log reader and the matched venue.
   * Absent ⇒ no PDF reviewer can run, recorded as `visual_unavailable /
   * no_renderer` (unless the role is off).
   */
  pdf?: ReviewPdfDeps;
  /**
   * V4 (ADR 0081 §3): the PDF reviewer's model, or `"off"`. **Absent means the
   * parent's** — the Writing model, ADR 0069 §8's default for a role. `"off"`
   * means no PDF work of any kind: nothing resolved, no compile, no limit.
   */
  pdfReviewer?: ChildModel | "off";
  /** V4 (ADR 0081 §7): a `/review-pdf` run — the compiled paper alone. */
  pdfOnly?: true;
  /** The user's `/review` argument, verbatim. */
  focus?: string;
  /**
   * The version number this panel takes (ADR 0062 §1) — the caller counts the
   * session's already-versioned `review` items and adds one. Absent (the eval
   * driver, a bare unit test) means an unversioned panel, which the card
   * renders without a version rather than inventing `v1`.
   */
  reviewOrdinal?: number;
  signal?: AbortSignal;
}

/** The transient facts the driver reads out of one seat's discarded items. */
export interface SeatObservation {
  /** The seat's last non-empty agent message, if it wrote one. */
  report?: string;
  /** True when a completed protocol load is in the seat's transcript. */
  guided: boolean;
  /** True when the seat was handed its shape feedback and answered again. */
  retried: boolean;
  /** Literature sources that did not answer, de-duplicated by (source, status). */
  badSources: Array<{
    source: string;
    status: SourceFailure;
    anonymous?: true;
  }>;
  /** True when a literature call came back with the session budget spent. */
  searchBudgetSpent: boolean;
  /** The budget notice the seat stopped on, when it stopped on one. */
  budgetStop?: string;
  /**
   * X5 (ADR 0074 §7): why the seat's stream died, read off its OWN transcript
   * — the last `error` item's message, classed by the notice the child's retry
   * policy chose.
   *
   * Present only when an `error` item exists, which is what a stream failure
   * leaves behind. **The class comes from the notice, never from re-reading
   * the message**: the child decided it with the HTTP status in hand, and a
   * 500 whose text matches no pattern would come back `fatal`.
   */
  failure?: ModelFailureCause;
  /**
   * V2 (ADR 0078 §3): every literature result THIS seat's searches returned,
   * in call order. What a cited paper is validated against — per seat and
   * never pooled, because a paper only another reviewer's search returned is
   * not one this reviewer was shown.
   */
  searchResults: LiteratureResult[];
  /** V2 (ADR 0078 §5): how many results were withheld from this seat because
   *  they were the reviewed manuscript itself, summed over its searches. */
  ownTitleWithheld: number;
  /** V5 (ADR 0087 §7): every `literature_search` call this seat made, in any
   *  state — counted before the transcript is discarded. */
  searchesAttempted: number;
  /** V5 (ADR 0087 §7): every COMPLETED search in which at least one source
   *  did not fail — or, from a provider that reports no per-source statuses,
   *  which returned a results list. What `no_literature` is read from. */
  searchesAnswered: number;
}

type SourceFailure = "rate_limited" | "timeout" | "failed";
const SOURCE_FAILURES: readonly string[] = [
  "rate_limited",
  "timeout",
  "failed",
];

/** Notices that mean *this seat ran out of room*, not *this seat had nothing
 *  to say* — worth naming in the record, because the two look identical from
 *  the outside and only one of them is the user's to fix. */
const BUDGET_STOPS: readonly NoticeItem["code"][] = [
  "budget.turns",
  "budget.tool_calls",
  "budget.output_tokens",
  "context.limit",
  "turn.truncated",
];

/** ADR 0082 §2: the three stops that name a budget the USER sets — the ones a
 *  host can point at a setting for. The other two stay in `detail` alone. */
const SEAT_BUDGET_OF: Readonly<Record<string, SeatBudget>> = {
  "budget.turns": "turns",
  "budget.tool_calls": "tool_calls",
  "budget.output_tokens": "output_tokens",
};

/** Read one seat's transient transcript for everything the record needs; the
 *  caller then throws the transcript away (ADR 0061 §7).
 *
 *  `skill` is the protocol whose completed load makes the child GUIDED — the
 *  panel's own for a reviewer, `concern-verifier` for a verifier child (V1,
 *  ADR 0076 §5). */
export function observeSeat(
  items: readonly SessionItem[],
  skill: string = PANEL_SKILL,
): SeatObservation {
  const searches = literatureResultsOf(items);
  const obs: SeatObservation = {
    guided: false,
    retried: false,
    badSources: [],
    searchBudgetSpent: false,
    searchResults: searches.results,
    ownTitleWithheld: searches.ownTitleWithheld,
    searchesAttempted: 0,
    searchesAnswered: 0,
  };
  const seenSource = new Set<string>();
  let errorMessage: string | undefined;
  let failureClass: ModelFailureClass | undefined;
  for (const item of items) {
    if (item.type === "agent_message" && item.text.trim() !== "") {
      obs.report = item.text;
      continue;
    }
    if (item.type === "user_message" && item.steered === true) {
      // The only steering a seat can receive is its own shape feedback: a
      // panel seat is a child, and no host queues input into one.
      obs.retried = true;
      continue;
    }
    if (item.type === "notice" && BUDGET_STOPS.includes(item.code)) {
      obs.budgetStop = item.code;
      continue;
    }
    // X5: the two notices the child's own retry policy emits before it gives
    // up. `fatal` emits none — "a fatal failure's own message is the whole
    // story" — so it is the absence of both, below.
    if (item.type === "notice" && item.code === "provider.quota") {
      failureClass = "quota";
      continue;
    }
    if (item.type === "notice" && item.code === "stream.retry_failed") {
      failureClass = "retryable";
      continue;
    }
    // The LAST error item: a child that failed emits one, carrying the
    // provider's own words. Before X5 this was read by nobody and thrown away
    // with the transcript, which is why a failed seat could only say that it
    // failed.
    if (item.type === "error") {
      errorMessage = item.message;
      continue;
    }
    if (item.type !== "tool_call") continue;
    if (item.tool === "load_skill" && item.status === "completed") {
      if (item.argsJson.includes(skill)) obs.guided = true;
      continue;
    }
    if (item.tool !== "literature_search") continue;
    // V5 (ADR 0087 §7): every call counts as attempted, readable or not.
    obs.searchesAttempted += 1;
    const parsed = parseToolResult(item.resultJson);
    if (parsed === undefined) continue;
    if (item.status === "completed" && searchAnswered(parsed)) {
      obs.searchesAnswered += 1;
    }
    if (item.status === "failed") {
      // `too_large` on this tool means one thing only: the session's shared
      // search budget is spent (the tool clamps an oversized `max_results`
      // rather than refusing it), so matching the code is exact.
      if (parsed.error?.code === "too_large") obs.searchBudgetSpent = true;
      continue;
    }
    for (const source of parsed.sources ?? []) {
      if (!SOURCE_FAILURES.includes(source.status)) continue;
      const key = `${source.name} ${source.status}`;
      if (seenSource.has(key)) continue;
      seenSource.add(key);
      obs.badSources.push({
        source: source.name,
        status: source.status as SourceFailure,
        ...(source.anonymous === true ? { anonymous: true as const } : {}),
      });
    }
  }
  // Only when the seat actually errored: a seat the user stopped, or one whose
  // budget ran out, failed in a way no provider has anything to say about.
  if (errorMessage !== undefined) {
    obs.failure = {
      class: failureClass ?? "fatal",
      ...(errorMessage.trim() !== "" ? { message: errorMessage } : {}),
    };
  }
  return obs;
}

/** A tool result as the transcript stores it. Parsed defensively: the row is
 *  capped for the model's sake, so a big one can be truncated JSON, and a
 *  record the driver could not read is simply a fact it does not have. */
function parseToolResult(json: string | undefined):
  | {
      error?: { code?: string };
      sources?: Array<{ name: string; status: string; anonymous?: boolean }>;
      // V2 (ADR 0078): the merged results, and the count the guard removed.
      // `resultJson` is the whole bounded report — `LITERATURE_REPORT_MAX_CHARS`
      // (28,000) sits under `TOOL_RESULT_MAX_CHARS` (32,000) precisely so this
      // stays parseable, and titles are never cut (ADR 0067 limit 3).
      results?: LiteratureResult[];
      withheld?: { ownTitle?: number };
    }
  | undefined {
  if (json === undefined) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object"
      ? (value as ReturnType<typeof parseToolResult>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether one completed search ANSWERED (V5, ADR 0087 §7): at least one of
 * its sources reported something other than a failure. A provider that
 * reports no per-source statuses at all (the stub, an older one) answered
 * when it returned a results list — even an empty one, which is an answer
 * (a recorded deliberate limit: *searched, found nothing* reads as answered).
 */
function searchAnswered(
  parsed: NonNullable<ReturnType<typeof parseToolResult>>,
): boolean {
  if (Array.isArray(parsed.sources) && parsed.sources.length > 0) {
    return parsed.sources.some(
      (s) =>
        typeof s?.status === "string" && !SOURCE_FAILURES.includes(s.status),
    );
  }
  return Array.isArray(parsed.results);
}

/**
 * Every literature result a child's completed searches returned, in the order
 * they were returned, plus how many were withheld as the manuscript itself
 * (V2, ADR 0078 §3, §5).
 *
 * Deliberately forgiving in three ways, because a transcript is evidence and
 * not a contract: a FAILED call contributes nothing (it has no results), a row
 * whose JSON does not parse is skipped rather than throwing, and a row that
 * parses but carries no `results` array contributes an empty list. A driver
 * that cannot read one search must still be able to validate against the rest.
 */
export function literatureResultsOf(items: readonly SessionItem[]): {
  results: LiteratureResult[];
  ownTitleWithheld: number;
} {
  const results: LiteratureResult[] = [];
  let ownTitleWithheld = 0;
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    if (item.tool !== "literature_search") continue;
    if (item.status !== "completed") continue;
    const parsed = parseToolResult(item.resultJson);
    if (parsed === undefined) continue;
    for (const r of parsed.results ?? []) {
      if (typeof r?.title === "string") results.push(r);
    }
    const withheld = parsed.withheld?.ownTitle;
    if (typeof withheld === "number") ownTitleWithheld += withheld;
  }
  return { results, ownTitleWithheld };
}

/**
 * The pre-run check's prompt and its output ceiling (X5, ADR 0074 §6).
 *
 * Sixteen tokens rather than one because a reasoning model spends completion
 * tokens before its first visible one, and a ceiling of 1 would fail such a
 * model for a reason that has nothing to do with whether it can answer.
 *
 * **Success is the call resolving.** The text is ignored: what this predicts is
 * the endpoint, the model id, the credential and the account — the four things
 * the round's dead seats died of — and a model that replies "Ready!" or
 * "certainly, ready" has answered every one of them.
 */
export const PREFLIGHT_PROMPT = "Reply with the single word: ready";
export const PREFLIGHT_MAX_TOKENS = 16;

/**
 * Two bindings are the same model iff all four fields match.
 *
 * Compared PAIRWISE rather than through a composite map key, because such a key
 * would have to contain the `apiKey` — and a secret that reaches a map key is a
 * secret one stack trace, one debugger watch or one careless log away from
 * being read. It is O(n²) over at most nine models, which is nothing.
 */
function sameBinding(a: ModelBinding, b: ModelBinding): boolean {
  return (
    a.protocol === b.protocol &&
    a.endpoint === b.endpoint &&
    a.model === b.model &&
    a.apiKey === b.apiKey
  );
}

/** Every DISTINCT model a panel is about to use, in first-seen order. */
export function distinctModels(models: readonly ChildModel[]): ChildModel[] {
  const distinct: ChildModel[] = [];
  for (const candidate of models) {
    if (distinct.some((seen) => sameBinding(seen.binding, candidate.binding))) {
      continue;
    }
    distinct.push(candidate);
  }
  return distinct;
}

/**
 * Ask each distinct model one minimal question, before anything is spent
 * (ADR 0074 §6).
 *
 * No tools, no temperature, no thinking budget — the request is as close to
 * nothing as a request can be, so what it tests is reachability and authority
 * rather than any model's tolerance for a parameter.
 *
 * Neither Codex nor Pi has this. Codex's `provider_reachability_check` counts
 * 401/403 as healthy and gates nothing; Pi's `checkAuth` checks that a
 * credential is PRESENT. Both would pass the exact failure this exists for: an
 * authorised but unfunded key.
 */
async function preflightOne(
  model: ChildModel,
  signal: AbortSignal | undefined,
): Promise<ReviewPreflight> {
  try {
    const response = await model.adapter.generate({
      binding: model.binding,
      messages: [{ role: "user", content: PREFLIGHT_PROMPT }],
      maxTokens: PREFLIGHT_MAX_TOKENS,
      ...(signal ? { signal } : {}),
    });
    return {
      model: model.binding.model,
      status: "ok",
      ...(response.usage ? { usage: response.usage } : {}),
    };
  } catch (error) {
    return {
      model: model.binding.model,
      status: "failed",
      cause: {
        class: classifyStreamFailure(error),
        // The provider's own words — third-party text, passing as authored
        // (invariant 6 rule 2's boundary). Never translated, never rewritten.
        ...(messageOf(error) !== "" ? { message: messageOf(error) } : {}),
      },
    };
  }
}

/** The provider's sentence, where there was one. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * Did this usage cost real tokens whose PRICE is unknown? (X5, ADR 0074 §8.)
 *
 * Tokens but no `costUsd` means the model is not in the price table, so the
 * cost is UNKNOWN — never zero. `ReviewItem.usage.costUsd` sums the priced
 * parts only, and this is what marks the total as a lower bound.
 *
 * The token test is load-bearing: a part that reported NO usage is not
 * unpriced, it is unrun, and marking it would claim something is missing from
 * a total that is in fact complete. One predicate for the reviewer seats and
 * the cross-review, because two copies of this rule would drift.
 */
export function isUnpriced(usage: Usage | undefined): boolean {
  return (
    usage !== undefined &&
    usage.costUsd === undefined &&
    usage.inputTokens + usage.outputTokens > 0
  );
}

/** Which STOP notice a failure class earns. One per class present. */
const PREFLIGHT_NOTICE: Record<ModelFailureClass, NoticeItem["code"]> = {
  quota: "review.model_quota",
  retryable: "review.model_unreachable",
  fatal: "review.model_refused",
};

/**
 * Run one blind review panel (ADR 0061 §2). Returns the status the calling
 * task should end as.
 *
 * There is **no model turn in the parent**: this is a task branch, so
 * persistence, the live event stream, interrupt through the shared signal and
 * usage accounting all come for free, and the protocol reaches each seat
 * byte-exact rather than through a turn that might paraphrase it.
 */
/**
 * Run the panel, and leave the host's withholding holder as it was found (V2,
 * ADR 0078 §5).
 *
 * A thin wrapper rather than a `try` around six hundred lines: the guarantee
 * that matters is *the holder is empty once this returns, however it returns*,
 * and expressing it here covers every exit — completed, interrupted, a
 * precondition refusal, and a throw — without re-indenting the driver or
 * moving a single one of its returns.
 *
 * **Emptied rather than restored.** A review is the only thing that ever fills
 * it, panels do not nest, and leaving a title behind would filter the user's
 * own chat searches afterwards — a behaviour nobody asked for.
 */
export async function runReviewPanel(
  deps: ReviewPanelDeps,
): Promise<"completed" | "failed" | "interrupted"> {
  // V4 (ADR 0081 §2): the compiled PDF the run opened, if it opened one —
  // closed here, on every exit, after the fan-out and the verifier, for the
  // same reason the holder below is emptied here.
  const opened: { document?: PdfDocument } = {};
  try {
    return await runReviewPanelInner(deps, opened);
  } finally {
    if (deps.literatureWithhold !== undefined) {
      deps.literatureWithhold.titles = [];
    }
    opened.document?.close();
  }
}

async function runReviewPanelInner(
  deps: ReviewPanelDeps,
  opened: { document?: PdfDocument },
): Promise<"completed" | "failed" | "interrupted"> {
  const itemId = randomUUID();
  /** V4 (ADR 0081 §7): a `/review-pdf` run — the compiled paper reviewed
   *  alone, by the same driver with no reviewers, no verifier and no
   *  cross-review. */
  const pdfOnly = deps.pdfOnly === true;
  const reviewers = pdfOnly ? [] : panelReviewers(deps.reviewers);
  /** The model id a reviewer's requests actually go to, and whether ADR 0023
   *  classifies it as verified — stamped on every seat row (§D4). */
  const stampModel = (
    model: ChildModel | undefined,
  ): Pick<ReviewSeatState, "model" | "unverified"> => {
    const id = model?.binding.model ?? deps.parentModel;
    return {
      model: id,
      ...(classifyModelForSession(id) === "unverified"
        ? { unverified: true as const }
        : {}),
    };
  };
  const seats: ReviewSeatState[] = reviewers.map((r) => ({
    reviewer: r.name,
    status: "running",
    ...stampModel(r.model),
  }));
  const base = {
    id: itemId,
    type: "review" as const,
    // V4: a PDF-only run's protocol is the addendum's — it is what makes the
    // run what it is (both loads still happen; see the seat's child below).
    skill: pdfOnly ? PDF_SKILL : PANEL_SKILL,
    ...(pdfOnly ? { pdfOnly: true as const } : {}),
    // When the user asked — stamped even on a panel that is about to be
    // refused, because that is still when they asked (ADR 0062 §1).
    at: Date.now(),
    ...(deps.focus !== undefined ? { focus: deps.focus } : {}),
  };
  /** The version, carried only once the preconditions pass — see the field's
   *  own note in `ReviewItem`. */
  const versioned = {
    ...base,
    ...(deps.reviewOrdinal !== undefined
      ? { version: deps.reviewOrdinal }
      : {}),
  };
  const snapshot = (): ReviewSeatState[] => seats.map((s) => ({ ...s }));

  /** A precondition the panel cannot run under: say why, in the reader's own
   *  language, and record a `failed` panel rather than throwing. */
  const refuse = async (code: NoticeItem["code"]): Promise<"failed"> => {
    await deps.emitNotice(code, 0);
    // No seats: a precondition fires BEFORE any seat exists, and a `failed`
    // panel whose rows still said `running` would show three reviewers still
    // working inside a review that never started. Replay cannot correct it
    // either — it normalizes a running PANEL, and this one is already failed.
    await deps.emitItem({ ...base, status: "failed", seats: [] });
    return "failed";
  };

  if (!deps.offeredSkills.some((s) => s.name === PANEL_SKILL)) {
    return refuse("review.skill_missing");
  }
  const workspace = deps.workspace;
  if (workspace === undefined) return refuse("review.no_manuscript");
  const entry = deps.paperEntry ?? (await discoverPaperEntry(workspace));
  if (entry === undefined) return refuse("review.no_manuscript");

  let manuscript: Manuscript;
  try {
    manuscript = await collectManuscript(
      workspace,
      entry,
      deps.manuscriptGraph,
    );
  } catch {
    // The entry itself could not be read: there is no manuscript, and saying
    // so is more honest than reviewing whatever else happened to list.
    return refuse("review.no_manuscript");
  }

  // V2 (ADR 0078 §5): the manuscript's own title, withheld from every
  // literature search this run makes. Filled here — as early as the title is
  // knowable — and emptied by `runReviewPanel`'s own `finally`, so no exit
  // below can leave it set.
  const ownTitle = manuscriptTitle(manuscript);
  const withhold = deps.literatureWithhold;
  if (ownTitle !== undefined && withhold !== undefined) {
    withhold.titles = [ownTitle];
  }
  /** The record's own account of whether the guard could run at all (§D8). */
  // V4: a PDF-only run makes no literature search at all — the PDF reviewer
  // holds no search tool — so the guard has nothing to guard, and a limit
  // saying it could not would misdescribe the run.
  const unguarded: ReviewLimit[] = pdfOnly
    ? []
    : withhold === undefined
      ? [{ kind: "own_title_unguarded", reason: "unavailable" }]
      : ownTitle === undefined
        ? [{ kind: "own_title_unguarded", reason: "no_title" }]
        : [];

  // X5 (ADR 0074 §4): both WARN and run. Deny-by-default — a host that wires
  // no reader is told its panel is reading the folder, not the paper.
  if (manuscript.resolved === "glob") {
    await deps.emitNotice(
      "review.manuscript_unresolved",
      manuscript.files.size,
    );
  }
  if (manuscript.missing > 0) {
    await deps.emitNotice("review.manuscript_incomplete", manuscript.missing);
  }

  // R9 (§D2): a request above the ceiling is clamped AND said. `panelReviewers`
  // did the clamping — it is pure — so the driver's job is to make it visible,
  // in the same shape `review.seat_budget` uses: a warning, and the panel runs.
  if (
    !pdfOnly &&
    deps.reviewers !== undefined &&
    deps.reviewers.length > reviewers.length
  ) {
    await deps.emitNotice("review.reviewers_clamped", reviewers.length);
  }

  // --- V4 (ADR 0081 §2): can the PDF reviewer run at all? ---
  //
  // Decided STATICALLY, before the preflight, so a model that cannot see costs
  // no request and — because the PDF is resolved only after the preflight
  // passes — a model that cannot answer costs no compile. `off` is the user's
  // choice, not a way of falling short: no PDF work of any kind, no limit.
  const pdfLimits: ReviewLimit[] = [];
  /** The seat's model when the host bound one; undefined ⇒ the parent's. */
  const pdfSeatModel: ChildModel | undefined =
    deps.pdfReviewer === "off" ? undefined : deps.pdfReviewer;
  let pdfCandidate = false;
  if (deps.pdfReviewer !== "off") {
    const seeing = pdfSeatModel ?? deps.parent;
    if (deps.pdf === undefined) {
      pdfLimits.push({ kind: "visual_unavailable", reason: "no_renderer" });
    } else if (!canSeeImages(seeing.binding)) {
      pdfLimits.push({
        kind: "visual_unavailable",
        reason: "model_has_no_image_input",
      });
    } else if (!deps.offeredSkills.some((s) => s.name === PDF_SKILL)) {
      // D5: a missing bundled addendum is the host's defect — the seat is
      // skipped and the record says it would have run unguided.
      pdfLimits.push({ kind: "seat_unguided", reviewer: PDF_REVIEWER_NAME });
    } else {
      pdfCandidate = true;
    }
  }

  // --- The pre-run check (ADR 0074 §6), before ANY reviewer is paid for. ---
  //
  // Placed here on purpose: after the manuscript (so a paper-less workspace is
  // refused without spending anything at all) and BEFORE `carve`, because each
  // passing check's usage is accrued first and `carve` divides what remains.
  // Accruing afterwards would carve the seats from a budget that ignores what
  // the check just spent — invariant 5 says a request can only ask for less.
  // It also runs before `item.started`: a panel the check refuses never
  // started, so it is never announced as running.

  // `aborted` flips asynchronously, so every read has to be a FRESH one.
  // Written as a call rather than `deps.signal?.aborted === true` inline:
  // TypeScript narrows a property access after the first test and would then
  // call the later re-reads dead comparisons — which is exactly backwards,
  // since re-reading after each await is the whole point.
  const aborted = (): boolean => deps.signal?.aborted === true;

  const preflight = await (async (): Promise<ReviewPreflight[]> => {
    // V4: the PDF reviewer's model joins only when the seat could run. A
    // PDF-only run asks nothing of a cross-review or a verifier it never runs.
    const pdfModels = pdfCandidate ? [pdfSeatModel ?? deps.parent] : [];
    const models = distinctModels(
      pdfOnly
        ? pdfModels
        : [
            ...reviewers.map((r) => r.model ?? deps.parent),
            deps.synthesis ?? deps.parent,
            // V1 (ADR 0076 §5): an unfunded verifier key refuses the panel
            // before any reviewer is paid for. Off asks nothing.
            ...(deps.verifier === "off"
              ? []
              : [deps.verifier ?? deps.synthesis ?? deps.parent]),
            ...pdfModels,
          ],
    );
    return Promise.all(models.map((m) => preflightOne(m, deps.signal)));
  })();
  for (const row of preflight) {
    if (row.usage !== undefined) deps.accrue(row.usage);
  }
  const preflightUsages = preflight
    .map((row) => row.usage)
    .filter((u): u is Usage => u !== undefined);

  // A stop landing DURING the check DISCARDS what it found. An aborted request
  // does fail, but the user stopping is not the provider refusing, and calling
  // it a refusal would name a fault nothing committed. The run falls
  // through to the ordinary interrupted path instead, where the seats report
  // `interrupted` and the synthesis is missing for that reason — the record R3
  // has always written for a panel the user stopped (ADR 0061).
  const failedChecks = aborted()
    ? []
    : preflight.filter((row) => row.status === "failed");
  if (failedChecks.length > 0) {
    // ANY failure refuses the WHOLE panel. Proceeding with N-1 seats would
    // make the author pay for the panel twice — once now, once when they
    // re-run it having fixed the model — and a refusal costs nothing.
    const byClass = new Map<ModelFailureClass, number>();
    for (const row of failedChecks) {
      const cls = row.cause?.class ?? "fatal";
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }
    for (const [cls, n] of byClass) {
      await deps.emitNotice(PREFLIGHT_NOTICE[cls], n);
    }
    await deps.emitItem({
      ...base,
      status: "failed",
      seats: [],
      preflight,
      ...(sumUsage(preflightUsages)
        ? { usage: sumUsage(preflightUsages) }
        : {}),
    });
    return "failed";
  }

  // --- V4 (ADR 0081 §2): resolve and open the PDF — after the preflight
  // passed, and only for a seat that could run. V3's policy, unchanged. ---
  let pdfRecord: ReviewPdfRecord | undefined;
  let pdfTool: ViewPdfPagesTool | undefined;
  /** ADR 0084: the same build's `.aux`, which the page cites follow. */
  let pdfAux: string | undefined;
  /** ADR 0085 §3: an `.aux` was found beside the PDF and refused as older. */
  let pdfAuxRejected: "aux_older_than_pdf" | undefined;
  if (pdfCandidate && deps.pdf !== undefined && !aborted()) {
    const got = await openReviewPdf(
      deps.pdf,
      workspace,
      entry,
      manuscript,
      deps.paperPdf,
      opened,
    );
    if ("limit" in got) {
      pdfLimits.push(got.limit);
    } else {
      pdfRecord = got.record;
      pdfAux = got.aux;
      pdfAuxRejected = got.auxRejected;
      // One instance, whose viewed set and view budget are this seat's alone.
      pdfTool = createViewPdfPagesTool({ document: got.document });
    }
  }
  /** The PDF reviewer's own row, a sibling of `seats` (ADR 0081 §3). */
  let pdfSeat: ReviewSeatState | undefined =
    pdfTool !== undefined
      ? {
          reviewer: PDF_REVIEWER_NAME,
          status: "running",
          ...stampModel(pdfSeatModel),
        }
      : undefined;
  const pdfFrame = () => ({
    ...(pdfRecord !== undefined ? { pdf: { ...pdfRecord } } : {}),
    ...(pdfSeat !== undefined ? { pdfSeat: { ...pdfSeat } } : {}),
  });
  /** A PDF-only run never plans a cross-review, so its frames carry none. */
  const pendingSynthesis = pdfOnly ? {} : { synthesis: "pending" as const };

  const carve = (childCount: number): SessionTaskBudget =>
    carveChildBudget(deps.budget, deps.usedSoFar(), childCount);
  // V4 (ADR 0081 §3): the PDF reviewer is carved BESIDE the reviewers —
  // `carve(n + 1)` — so the reviewers' share shrinks when it joins, which is
  // invariant 5's direction; a floor for it is what ADR 0076 refused the
  // verifier.
  const seatCount = reviewers.length + (pdfTool !== undefined ? 1 : 0);
  const seatCeiling = carve(seatCount);
  if (seatCount > 0 && seatCeiling.maxOutputTokens < PANEL_SEAT_TOKEN_FLOOR) {
    // A WARNING, not a refusal: the budget is the user's dial (invariant 5),
    // and a starved seat reports itself missing, which is a fact the user can
    // act on. Refusing here would substitute our arithmetic for their choice.
    await deps.emitNotice("review.seat_budget", seatCeiling.maxOutputTokens);
  }

  /** V1 (ADR 0076 §5): where verification stands, carried on every live
   *  frame from the first, so the progress block can draw its chip. */
  let verificationState: NonNullable<ReviewItem["verification"]> = pdfOnly
    ? "skipped"
    : deps.verifier === "off"
      ? "off"
      : "pending";
  /** The verifier's one sibling seat, once it has started. */
  let verifierSeat: ReviewSeatState | undefined;
  const verificationFrame = () => ({
    verification: verificationState,
    ...(verifierSeat ? { verifierSeat: { ...verifierSeat } } : {}),
  });

  await deps.emit({
    type: "item.started",
    item: {
      ...versioned,
      status: "running",
      seats: snapshot(),
      ...pendingSynthesis,
      ...verificationFrame(),
      ...pdfFrame(),
    },
  });

  const ctx: BriefContext = {
    entry,
    files: [entry, ...[...manuscript.files.keys()].filter((f) => f !== entry)],
    // X5: over the manuscript's PROSE, not the entry. On an \input shell the
    // entry is a preamble, and letting a preamble decide the anchor rule for
    // prose it does not hold is §1's mistake one layer up. `.bib` is excluded:
    // its line lengths say nothing about how the paper is wrapped.
    wrapping: describeWrapping(
      [...manuscript.files.entries()]
        .filter(([path]) => !path.toLowerCase().endsWith(".bib"))
        .map(([, content]) => content)
        .join("\n"),
    ),
    ...(deps.focus !== undefined ? { focus: deps.focus } : {}),
  };
  const protocol = deps.offeredSkills.filter((s) => s.name === PANEL_SKILL);
  const seatTools = narrowChildTools(deps.parentAllowed);
  const readLedger = (
    answer: string,
    reviewer: string,
    // V2 (ADR 0078 §3): THIS seat's own recorded results. Required rather than
    // optional at this call site, so every construction of a ledger has to say
    // what the seat was shown — including the two freeze-time calls.
    papers: readonly LiteratureResult[],
    // V4 (ADR 0081 §4): the pages the PDF reviewer viewed — set for that seat
    // only, which is what opens the fourth evidence form and the eighth
    // dimension to it and to nobody else.
    viewedPages?: ReadonlySet<number>,
    // V5 (ADR 0087 §2): this answer is the seat's reply to its one re-ask, so
    // a reply carrying only scalars is read rather than lost. Passed at ONE
    // call site — the settle's merge — and never to a first answer.
    correction = false,
  ): LedgerOutcome =>
    interpretLedger({
      answer,
      reviewer,
      files: manuscript.files,
      defaultFile: manuscript.defaultFile,
      allowedDimensions:
        viewedPages !== undefined
          ? [...CONTRACT_PANEL_DIMENSIONS]
          : [...REVIEWER_DIMENSIONS],
      suggestEdits: true,
      papers,
      // V5 (ADR 0087 §2): the PDF reviewer is read with all eight dimensions
      // allowed and asked to assess `presentation` alone; a text reviewer
      // assesses the seven its brief lists (the default).
      ...(viewedPages !== undefined
        ? { viewedPages, assessedDimensions: [PDF_ASSESSED_DIMENSION] }
        : {}),
      ...(correction ? { correction: true as const } : {}),
    });

  /**
   * Each seat's FIRST would-be-final answer, kept for the correction round.
   *
   * `finalAnswerCheck` is called exactly once per seat (ADR 0061 §6), so this
   * is that one answer with no double counting. `ledger` is present only when
   * the answer PARSED — a shape failure has nothing to merge into, and its
   * second answer is a whole ledger interpreted alone, exactly as before X5.
   */
  const stash = new Map<string, { text: string; ledger?: ParsedLedger }>();

  /** The seat's own interpreter, run as a dry run on its would-be final
   *  answer (§6). The feedback is `interpretLedger`'s own English, so a seat
   *  is never corrected in words other than the ones that will judge it.
   *
   *  X5 (ADR 0074 §5): it now also fires on entries the ledger REJECTED and
   *  anchors that did not locate — where before a seat whose anchors all
   *  dropped was never asked again, and simply lost them. */
  const ledgerCheck =
    (
      reviewer: string,
      // V4 (ADR 0081 §3): the PDF reviewer's LIVE viewed set, read at the
      // moment the check fires — the one accessor the settled read shares.
      viewed?: () => ReadonlySet<number>,
    ): FinalAnswerCheck =>
    (text, items): string | undefined => {
      // V2 (ADR 0078 §4): the seat's own searches, read out of its transcript
      // at the moment the check fires — inside the child, before the driver
      // has seen any of it.
      const outcome = readLedger(
        text,
        reviewer,
        literatureResultsOf(items).results,
        viewed?.(),
      );
      if (outcome.failure !== undefined) {
        stash.set(reviewer, { text });
        return outcome.failure;
      }
      const { result, counts, relocatedIds } = outcome;
      if (result === undefined || counts === undefined) return undefined;
      // V5 (ADR 0087 §2): the seat's impression problems ride the same
      // message — an absent block, on its own, spends the one re-ask
      // (operator direction, 2026-09-27).
      const problems = describeLedgerProblems(
        result,
        reviewer,
        viewed?.(),
        outcome.impressionProblems,
      );
      if (problems === undefined) return undefined;
      stash.set(reviewer, {
        text,
        ledger: { result, counts, relocatedIds: relocatedIds ?? new Set() },
      });
      return problems;
    };

  const observations: SeatObservation[] = [];
  const children: FanOutChild[] = reviewers.map((reviewer) => ({
    goal: reviewerBrief(reviewer, reviewers.length, ctx),
    allowedTools: seatTools,
    skills: [...protocol],
    finalAnswerCheck: ledgerCheck(reviewer.name),
    ...(reviewer.model ? { model: reviewer.model } : {}),
  }));
  // V4 (ADR 0081 §3): the PDF reviewer runs in the SAME fan-out, one child
  // more. Its tools are the verifier's read set — no literature search: it
  // reviews the page, not the field — plus the one tool no other seat holds,
  // handed to it alone through `runChild`'s seventh parameter (§6). The
  // reviewers' `seatTools` are untouched, and since the parent never holds
  // `view_pdf_pages`, no reviewer can name it.
  if (pdfTool !== undefined && pdfRecord !== undefined) {
    const tool = pdfTool;
    children.push({
      goal: pdfReviewerBrief(
        ctx,
        pdfRecord.facts,
        pdfRecord,
        tool.views.remaining,
      ),
      allowedTools: [
        ...narrowChildTools(deps.parentAllowed, [...VERIFIER_TOOLS]),
        "view_pdf_pages",
      ],
      skills: deps.offeredSkills.filter(
        (s) => s.name === PANEL_SKILL || s.name === PDF_SKILL,
      ),
      finalAnswerCheck: ledgerCheck(PDF_REVIEWER_NAME, () => tool.viewed),
      ...(pdfSeatModel ? { model: pdfSeatModel } : {}),
      tools: new Map([["view_pdf_pages", tool.executor]]),
      // ADR 0082 §1: a turn and a call for every page it may view, on top of
      // the slice the reviewers share — its protocol views one page a turn,
      // and a slice sized for reading a manuscript held eight of J1's nine.
      // Bounded by the tool's own view budget, never by the paper's length.
      allowance: {
        turns: Math.min(pdfRecord.facts.pages, tool.views.remaining),
        toolCalls: Math.min(pdfRecord.facts.pages, tool.views.remaining),
      },
    });
  }
  const fanOut =
    children.length === 0
      ? { outcomes: [] as FanOutOutcome[] }
      : await runFanOut(
          {
            fanOutConcurrency: Math.min(
              deps.fanOutConcurrency,
              children.length,
            ),
            carveCeiling: carve,
            accrue: deps.accrue,
            runChild: deps.runChild,
            ...(deps.signal ? { signal: deps.signal } : {}),
          },
          children,
          {
            onStarted: async () => {},
            onChildSettled: async (i, outcome) => {
              const obs = observeSeat(outcome.items);
              observations[i] = obs;
              if (i >= reviewers.length) {
                // V4: the PDF reviewer's own row — a sibling, never `seats`.
                pdfSeat = {
                  reviewer: PDF_REVIEWER_NAME,
                  status: outcome.status,
                  ...stampModel(pdfSeatModel),
                  ...(obs.retried ? { retried: true as const } : {}),
                  ...(outcome.usage ? { usage: outcome.usage } : {}),
                };
              } else {
                const reviewer = reviewers[i] as PanelReviewer;
                seats[i] = {
                  reviewer: reviewer.name,
                  status: outcome.status,
                  ...stampModel(reviewer.model),
                  ...(obs.retried ? { retried: true as const } : {}),
                  ...(outcome.usage ? { usage: outcome.usage } : {}),
                };
              }
              await deps.emit({
                type: "item.updated",
                item: {
                  ...versioned,
                  status: "running",
                  seats: snapshot(),
                  ...pendingSynthesis,
                  ...verificationFrame(),
                  ...pdfFrame(),
                },
              });
            },
          },
        );
  const fanOutUsage = "usage" in fanOut ? fanOut.usage : undefined;

  // --- Each reviewer's ledger, and what the driver saw it could not do. ---
  const seatOutcomes: SeatOutcome[] = [];
  /** Per seat, the FIRST answer's counts — set only when that answer parsed
   *  and the one re-ask then fired, which is how *before and after the
   *  correction round* is read off ONE run (ADR 0074 §8). */
  const firstPassCounts = new Map<string, LedgerCounts>();
  // V2 (ADR 0078 §D8): the guard's own account leads the driver's limits. A
  // LIMIT and not a notice, because a completed panel's WARN notices do not
  // survive to the Review tab — a notice would be a guarantee the surface
  // cannot keep.
  const driverLimits: ReviewLimit[] = [...unguarded];
  /**
   * Every seat that ran, in fan-out order: the reviewers, then — V4 (ADR 0081
   * §3) — the PDF reviewer, whose ledger is read with its own viewed set and
   * whose guidance is BOTH protocols' loads.
   */
  const toSettle: Array<{
    name: string;
    index: number;
    viewed?: ReadonlySet<number>;
  }> = [
    ...reviewers.map((r, index) => ({ name: r.name, index })),
    ...(pdfTool !== undefined
      ? [
          {
            name: PDF_REVIEWER_NAME,
            index: reviewers.length,
            viewed: pdfTool.viewed,
          },
        ]
      : []),
  ];
  for (const seat of toSettle) {
    const i = seat.index;
    const outcome = fanOut.outcomes[i];
    const obs = observations[i];
    if (outcome === undefined || obs === undefined) {
      // Unreachable today — `runFanOut` pre-fills `outcomes` and every child
      // settles into `observations`. Recorded rather than skipped anyway: a
      // driver whose whole point is an honesty record must not let a seat
      // disappear from the panel without saying that it did.
      seatOutcomes.push({ reviewer: seat.name, missing: "failed" });
      continue;
    }
    if (obs.badSources.length > 0) {
      for (const bad of obs.badSources) {
        driverLimits.push({
          kind: "source_unavailable",
          reviewer: seat.name,
          source: bad.source,
          status: bad.status,
          ...(bad.anonymous === true ? { anonymous: true as const } : {}),
        });
      }
    }
    if (obs.searchBudgetSpent) {
      driverLimits.push({ kind: "search_budget_spent", reviewer: seat.name });
    }
    if (outcome.status !== "completed") {
      seatOutcomes.push({
        reviewer: seat.name,
        missing: outcome.status,
        // X5 (ADR 0074 §7): only a FAILED seat has a provider cause. An
        // interrupted one was stopped by the user, which no provider said
        // anything about.
        ...(outcome.status === "failed" && obs.failure !== undefined
          ? { cause: obs.failure }
          : {}),
      });
      continue;
    }
    // Only a seat that RAN can be unguided; one that failed before its first
    // turn never had the chance, and saying it ignored the protocol would be
    // the record blaming a seat for the harness's own failure.
    // V4: the PDF reviewer is guided only if BOTH loads completed — the
    // protocol and its addendum (ADR 0081 §3).
    const guided =
      seat.viewed === undefined
        ? obs.guided
        : obs.guided && observeSeat(outcome.items, PDF_SKILL).guided;
    if (!guided) {
      driverLimits.push({ kind: "seat_unguided", reviewer: seat.name });
    }
    // ADR 0082 §2: which of the user's budgets stopped the seat, if one did —
    // attached only where the ledger then FAILED, so a host can name the
    // setting to raise instead of calling the report unreadable.
    const ranOutOf =
      obs.budgetStop !== undefined ? SEAT_BUDGET_OF[obs.budgetStop] : undefined;
    if (obs.report === undefined) {
      seatOutcomes.push({
        reviewer: seat.name,
        ledger: {
          failure: `the seat produced no report (${obs.budgetStop ?? "no report"})`,
        },
        ...(ranOutOf !== undefined ? { ranOutOf } : {}),
      });
      continue;
    }
    // X5 (ADR 0074 §5): if this seat's first answer parsed and was re-asked,
    // the report in hand is a CORRECTION — merged into the first pass rather
    // than replacing it, so what located the first time is never put back at
    // risk. Three cases, and the last two are why the panel is never worse
    // off for having asked.
    const first = stash.get(seat.name)?.ledger;
    const firstText = stash.get(seat.name)?.text;
    if (first === undefined) {
      // No parsed first answer: today's path exactly — plus, when a budget
      // stopped the seat mid-way, what its last words were cut off by.
      const ledger = readLedger(
        obs.report,
        seat.name,
        obs.searchResults,
        seat.viewed,
      );
      seatOutcomes.push({
        reviewer: seat.name,
        ledger,
        ...(ledger.failure !== undefined && ranOutOf !== undefined
          ? { ranOutOf }
          : {}),
      });
      continue;
    }
    if (obs.report === firstText) {
      // The seat repeated itself, or its budget ran out before it could
      // answer. The first pass stands, its limits final.
      seatOutcomes.push({
        reviewer: seat.name,
        ledger: {
          result: first.result,
          counts: first.counts,
          relocatedIds: first.relocatedIds,
        },
      });
      firstPassCounts.set(seat.name, first.counts);
      continue;
    }
    const merged = mergeLedgerCorrection(
      first,
      // The SETTLED items, so a paper the seat found by searching again after
      // its feedback is recorded (ADR 0078 §4). V5: read as a correction, the
      // one call site that is — a reply carrying only scalars is not lost.
      readLedger(obs.report, seat.name, obs.searchResults, seat.viewed, true),
    );
    seatOutcomes.push({
      reviewer: seat.name,
      ledger: {
        result: merged.result,
        counts: merged.counts,
        relocatedIds: merged.relocatedIds,
      },
    });
    firstPassCounts.set(seat.name, first.counts);
  }

  // The PDF reviewer's ledger once it is final, for the two steps below that
  // rewrite it before anything reads its ids — or undefined when it has none.
  const pdfAt = seatOutcomes.findIndex((o) => o.reviewer === PDF_REVIEWER_NAME);
  const settledPdfLedger = (): ParsedLedger | undefined => {
    const outcome = seatOutcomes[pdfAt];
    if (outcome === undefined || !("ledger" in outcome)) return undefined;
    const { result, counts, relocatedIds } = outcome.ledger;
    if (result === undefined || counts === undefined) return undefined;
    return { result, counts, relocatedIds: relocatedIds ?? new Set() };
  };
  const replacePdfLedger = (ledger: ParsedLedger): void => {
    const outcome = seatOutcomes[pdfAt];
    if (outcome !== undefined && "ledger" in outcome) {
      seatOutcomes[pdfAt] = { ...outcome, ledger };
    }
  };

  // ADR 0085 §2: in BOTH modes, the PDF reviewer's concerns about what the
  // document class prints for review — an author block `anonymous` hides, a
  // template's placeholder DOI or ISBN — are set aside. The addendum's rule 1
  // held at round 3 and not at round 4, on the same PDF, where every run filed
  // both as major and blocking. First, so a concern that is both furniture and
  // page-less is counted as what it is about.
  const beforeFurniture = settledPdfLedger();
  if (beforeFurniture !== undefined) {
    replacePdfLedger(
      setAsideConcerns(
        beforeFurniture,
        reviewFurniture({ files: manuscript.files, entry }),
        "furniture_set_aside",
      ),
    );
  }

  // ADR 0083 §2: in a PANEL, the PDF reviewer's concerns about the argument
  // are set aside. The text reviewers read the argument from the source and
  // nothing verifies the PDF reviewer's (ADR 0081 §5), so they only repeat the
  // panel — and J1's default-budget run filed three of six. Done here, once
  // the ledger is final and before anything reads its ids, so the rest are
  // re-stamped densely. A PDF-only run has no text reviewer to leave them to.
  const beforeSetAside = pdfOnly ? undefined : settledPdfLedger();
  if (beforeSetAside !== undefined) {
    replacePdfLedger(setAsideConcerns(beforeSetAside, isPdfArgumentConcern));
  }

  // ADR 0084: in BOTH modes, a page cite follows the float its anchor sits
  // in. Round 3's *Review the PDF* cited all four of its floats one page early
  // with each page named on the wire, so the page is located here, as every
  // other position is: the compile's `.aux` gives the float's page, and the
  // PDF's own text on that page confirms it. Moved only to a page the seat
  // viewed, and recorded. After the set-aside, so the ids it records are final.
  const cited = settledPdfLedger();
  if (
    cited !== undefined &&
    pdfAux !== undefined &&
    pdfTool !== undefined &&
    opened.document !== undefined
  ) {
    const pages = await confirmedFloatPages(cited.result.annotations, {
      files: manuscript.files,
      entry,
      aux: pdfAux,
      document: opened.document,
    });
    replacePdfLedger(
      correctFloatPages(cited, (a) => pages.get(a.id), pdfTool.viewed),
    );
  }

  // ADR 0085 §3: an `.aux` was found and could not be used — older than the
  // PDF, or counting another build's pages — so the step above checked
  // nothing. Round 4's J1 lost its whole guard that way, silently, on a
  // committed PDF beside an untracked `.aux`. Said now, wherever a cite it
  // would have checked stands unchecked.
  const unusedAux =
    pdfAuxRejected ??
    (pdfAux !== undefined &&
    opened.document !== undefined &&
    auxOfAnotherBuild(pdfAux, opened.document.pageCount)
      ? ("aux_other_build" as const)
      : undefined);
  const unchecked = settledPdfLedger();
  if (unchecked !== undefined && unusedAux !== undefined) {
    replacePdfLedger(
      recordUncheckedPages(unchecked, unusedAux, {
        files: manuscript.files,
        entry,
      }),
    );
  }

  // X5 (ADR 0074 §8): what each seat's report came to, stamped onto its row
  // now that the ledgers are parsed and merged. The rows themselves were built
  // as the children settled, which is before any of this was known.
  for (const seat of toSettle) {
    const i = seat.index;
    const row = i < reviewers.length ? seats[i] : pdfSeat;
    if (row === undefined) continue;
    const outcome = seatOutcomes.find(
      (o) => o.reviewer === seat.name && "ledger" in o,
    );
    const counts =
      outcome !== undefined && "ledger" in outcome
        ? outcome.ledger.counts
        : undefined;
    if (counts !== undefined) {
      const firstPass = firstPassCounts.get(seat.name);
      row.ledger = {
        ...counts,
        ...(firstPass !== undefined ? { firstPass } : {}),
      };
    }
    // V2 (ADR 0078 §D8): present only when the guard actually fired for this
    // seat, so a seat whose searches never met the paper — the ordinary case —
    // serializes exactly as it did before V2.
    const withheldHere = observations[i]?.ownTitleWithheld ?? 0;
    if (withheldHere > 0) row.ownTitleWithheld = withheldHere;
    if (isUnpriced(row.usage)) row.unpriced = true;
    // V5 (ADR 0087 §7): what this seat's searches came to — per seat, never
    // pooled, on every row that completed. Counted here because the
    // transcript it is read from is about to be discarded (ADR 0061 §7).
    const observed = observations[i];
    if (row.status === "completed" && observed !== undefined) {
      row.searches = {
        attempted: observed.searchesAttempted,
        answered: observed.searchesAnswered,
      };
    }
  }

  // V4 (ADR 0081 §5): the REVIEWERS' parsed ledgers only. The verifier has
  // no eyes and the cross-review reads reviewers, so the PDF reviewer's
  // concerns reach the result through assembly below and nowhere else — and
  // `parsed.length`, the cross-review's two-ledger precondition, counts
  // reviewers.
  const parsed = seatOutcomes.filter(
    (s): s is Extract<SeatOutcome, { ledger: LedgerOutcome }> =>
      s.reviewer !== PDF_REVIEWER_NAME &&
      "ledger" in s &&
      s.ledger.result !== undefined,
  );

  // V4 (ADR 0081 §2): the pages the seat viewed go on the record, and a seat
  // that completed short of the last page says so.
  if (pdfRecord !== undefined && pdfTool !== undefined) {
    const viewed = [...pdfTool.viewed].sort((a, b) => a - b);
    pdfRecord = { ...pdfRecord, viewed };
    if (
      pdfSeat?.status === "completed" &&
      viewed.length < pdfRecord.facts.pages
    ) {
      pdfLimits.push({
        kind: "pages_unviewed",
        viewed: viewed.length,
        total: pdfRecord.facts.pages,
      });
    }
  }
  driverLimits.push(...pdfLimits);
  const located = parsed.flatMap((s) => s.ledger.result?.annotations ?? []);

  // --- V1 (ADR 0076 §5): the verifier, after every ledger is frozen and
  // merged, and before the cross-review reads any of it. ---
  //
  // V2 (ADR 0078 §7): the abstract behind each cited paper, keyed by concern
  // id and looked up in THAT seat's own recorded results — the same per-seat
  // rule the citation itself was validated under. Built here and nowhere else:
  // it lives only as long as this call, and nothing persists it.
  const abstracts = new Map<string, string>();
  for (const parsedSeat of parsed) {
    const seatResults =
      observations[reviewers.findIndex((r) => r.name === parsedSeat.reviewer)]
        ?.searchResults ?? [];
    for (const a of parsedSeat.ledger.result?.annotations ?? []) {
      const cited = a.evidence;
      if (cited?.kind !== "paper") continue;
      const hit = seatResults.find((r) => sameTitle(r.title, cited.title));
      if (hit?.abstract !== undefined) abstracts.set(a.id, hit.abstract);
    }
  }
  // V4 (ADR 0081 §7): a PDF-only run has no reviewer concern to check, and
  // nothing was skippable — so no verifier runs and no limit is recorded.
  const verification = pdfOnly
    ? {
        entries: new Map<string, ReviewVerification>(),
        limits: [] as ReviewLimit[],
        state: "skipped" as const,
        interrupted: false,
        seat: undefined,
        usage: undefined,
      }
    : await runVerification(
        deps,
        located,
        manuscript,
        ctx,
        carve,
        async (seat) => {
          verificationState = "running";
          verifierSeat = seat;
          await deps.emit({
            type: "item.updated",
            item: {
              ...versioned,
              status: "running",
              seats: snapshot(),
              ...pendingSynthesis,
              ...verificationFrame(),
              ...pdfFrame(),
            },
          });
        },
        abstracts,
      );
  verificationState = verification.state;
  verifierSeat = verification.seat;
  driverLimits.push(...verification.limits);
  /** What survived verification — the ONLY concerns the cross-review sees,
   *  in its brief and in both of its checks, so a withdrawn id is uncitable
   *  by construction. */
  const alive = applyVerification(located, verification.entries).filter(
    (a) => !isWithdrawn(a),
  );

  // --- The synthesis, after every report is frozen. ---
  // Re-read after the synthesis settles too: a signal that fires WHILE the
  // fourth child runs leaves a panel that was stopped, and reporting it
  // `completed` because the seats had already finished would be the item
  // claiming a completeness the run does not have.
  let interrupted = aborted() || verification.interrupted;
  let synthesis: ReviewSynthesis | undefined;
  // V4 (ADR 0081 §7): a PDF-only run never planned a cross-review, so it
  // records none — not `missing`, which would say one was owed.
  let synthesisState: ReviewItem["synthesis"] = pdfOnly ? undefined : "missing";
  let synthesisUsage: Usage | undefined;
  /** R9 (§D4): the cross-review recorded as a seat of its own. Absent until it
   *  actually starts — a panel that never ran one has no seat to show. */
  let synthesisSeat: ReviewSeatState | undefined;
  if (pdfOnly) {
    // Nothing to read across: one seat, and no reviewer.
  } else if (interrupted) {
    // A panel the user stopped owes no synthesis, and running one over a
    // half-finished panel would present a partial reading as the whole.
    driverLimits.push({
      kind: "synthesis_missing",
      reason: "interrupted",
    });
  } else if (parsed.length < 2 || alive.length === 0) {
    // V1: read over what SURVIVED verification — every concern withdrawn is
    // the same honest structural case as nothing located (ADR 0076 §5).
    driverLimits.push({
      kind: "synthesis_missing",
      reason: "insufficient_seats",
    });
  } else {
    synthesisState = "running";
    synthesisSeat = {
      reviewer: "synthesis",
      status: "running",
      ...stampModel(deps.synthesis),
    };
    await deps.emit({
      type: "item.updated",
      item: {
        ...versioned,
        status: "running",
        seats: snapshot(),
        synthesis: "running",
        synthesisSeat: { ...synthesisSeat },
        ...verificationFrame(),
        ...pdfFrame(),
      },
    });
    const outcome = await runSynthesis(deps, alive, carve, reviewers.length);
    if (outcome.reason === "interrupted" || aborted()) {
      interrupted = true;
    }
    synthesisUsage = outcome.usage;
    synthesisSeat = {
      ...synthesisSeat,
      status: outcome.childStatus,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(isUnpriced(outcome.usage) ? { unpriced: true as const } : {}),
    };
    if (outcome.usage) deps.accrue(outcome.usage);
    if (outcome.synthesis !== undefined) {
      synthesis = outcome.synthesis;
      synthesisState = "completed";
    } else {
      synthesisState = "missing";
      driverLimits.push({
        kind: "synthesis_missing",
        reason: outcome.reason ?? "unparsed",
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      });
    }
  }

  const result = assembleReview({
    seats: seatOutcomes,
    ...(synthesis !== undefined ? { synthesis } : {}),
  });
  // V1 (ADR 0076 §5): verification attaches AFTER assembly, by id — assembly
  // is pure and concatenates without re-stamping, so this is exact. Withdrawn
  // concerns stay in the result; nothing is deleted.
  result.annotations = applyVerification(
    result.annotations,
    verification.entries,
  );
  // The driver's own limits are APPENDED, so a result with everything located
  // and nothing observed still carries no `limits` key at all (ADR 0060 D6).
  if (driverLimits.length > 0) {
    result.limits = [...(result.limits ?? []), ...driverLimits];
  }
  const usage = sumUsage([
    ...preflightUsages,
    fanOutUsage,
    verification.usage,
    synthesisUsage,
  ]);
  await deps.emitItem({
    ...versioned,
    status: interrupted ? "interrupted" : "completed",
    seats: snapshot(),
    ...(synthesisState !== undefined ? { synthesis: synthesisState } : {}),
    ...(synthesisSeat ? { synthesisSeat } : {}),
    verification: verificationState,
    ...(verifierSeat ? { verifierSeat } : {}),
    ...pdfFrame(),
    preflight,
    result,
    ...(usage ? { usage } : {}),
  });
  return interrupted ? "interrupted" : "completed";
}

/**
 * Resolve, open and measure the compiled PDF for one review (V4, ADR 0081
 * §2) — V3's policy for WHICH PDF (ADR 0080 §8), unchanged, then the
 * renderer, then the facts. Each way it can fail is a `pdf_unavailable`
 * reason, never a throw: a panel that cannot have the PDF runs as it always
 * did.
 *
 * The opened document is handed to `opened` the moment it exists, so the
 * driver's `finally` closes it whatever happens after.
 */
async function openReviewPdf(
  pdf: ReviewPdfDeps,
  workspace: ManuscriptWorkspace,
  entry: string,
  manuscript: Manuscript,
  namedPdf: string | undefined,
  opened: { document?: PdfDocument },
): Promise<
  | { limit: ReviewLimit }
  | {
      document: PdfDocument;
      record: ReviewPdfRecord;
      aux?: string;
      /** ADR 0085 §3: an `.aux` beside the PDF was refused as older. */
      auxRejected?: "aux_older_than_pdf";
    }
> {
  const unavailable = (
    reason: Extract<ReviewLimit, { kind: "pdf_unavailable" }>["reason"],
    detail?: string,
  ): { limit: ReviewLimit } => ({
    limit: {
      kind: "pdf_unavailable",
      reason,
      ...(detail !== undefined ? { detail } : {}),
    },
  });
  const stat = workspace.stat?.bind(workspace);
  const readBinary = workspace.readBinary?.bind(workspace);
  // A host that cannot stat or read bytes cannot find a PDF at all.
  if (stat === undefined || readBinary === undefined) {
    return unavailable("none");
  }
  // The compile's own log, kept for the overfull fact: the policy hands back
  // bytes only.
  let compiled: CompileResult | undefined;
  const compile = pdf.compile;
  let outcome: Awaited<ReturnType<typeof resolveReviewPdf>>;
  try {
    outcome = await resolveReviewPdf({
      entry,
      files: manuscript.files.keys(),
      ...(namedPdf !== undefined ? { namedPdf } : {}),
      stat,
      readBinary,
      ...(compile !== undefined
        ? {
            compile: async () => {
              compiled = await compile();
              return compiled;
            },
          }
        : {}),
    });
  } catch (error) {
    // A compile that threw (a spawn error, a timeout) is a failed compile.
    return unavailable(
      "compile_failed",
      error instanceof Error ? error.message : undefined,
    );
  }
  if (!outcome.ok) return unavailable(outcome.reason, outcome.detail);

  let document: PdfDocument | undefined;
  try {
    document = await pdf.renderer(outcome.bytes);
  } catch {
    document = undefined;
  }
  if (document === undefined) return unavailable("render_failed");
  opened.document = document;

  const warnings = await compileWarnings(
    pdf,
    workspace,
    entry,
    outcome,
    compiled,
  );
  let facts: PdfFacts;
  try {
    facts = await computePdfFacts({
      document,
      ...(warnings !== undefined ? { warnings } : {}),
      ...(pdf.venue !== undefined ? { venue: pdf.venue } : {}),
    });
  } catch {
    // A document PDFium opened and then could not read is a PDF that could
    // not be opened, as far as a reader of the record is concerned.
    return unavailable("render_failed");
  }
  // ADR 0084: the same build's `.aux`, for the page cites to follow — this
  // run's compile's, or one beside a found PDF by the log's own rule. ADR
  // 0085 §3: one found and refused as older is remembered, so the review can
  // say it checked nothing rather than fall silent.
  const found =
    outcome.source === "compiled"
      ? compiled?.aux !== undefined
        ? { text: compiled.aux }
        : undefined
      : await besidePdfFile(workspace, outcome.path, ".aux");
  return {
    document,
    record: {
      source: outcome.source,
      ...(outcome.path !== undefined ? { path: outcome.path } : {}),
      ...(outcome.stale === true ? { stale: true as const } : {}),
      facts,
    },
    ...(found !== undefined && "text" in found ? { aux: found.text } : {}),
    ...(found !== undefined && "older" in found
      ? { auxRejected: "aux_older_than_pdf" as const }
      : {}),
  };
}

/**
 * A build artifact beside a found PDF — `<base>.log`, `<base>.aux` — as its
 * text when it is not older than the PDF, within the policy's own freshness
 * slack for filesystems that round a timestamp; as `{ older: true }` when it
 * exists and is older, which makes it a record of a different build; and
 * `undefined` for anything else, never a throw.
 */
async function besidePdfFile(
  workspace: ManuscriptWorkspace,
  pdfPath: string | undefined,
  ext: ".log" | ".aux",
): Promise<{ text: string } | { older: true } | undefined> {
  if (pdfPath === undefined || !/\.pdf$/i.test(pdfPath)) return undefined;
  const path = pdfPath.replace(/\.pdf$/i, ext);
  const stat = workspace.stat?.bind(workspace);
  if (stat === undefined) return undefined;
  try {
    const [own, pdf] = await Promise.all([stat(path), stat(pdfPath)]);
    if (own === undefined || pdf === undefined) return undefined;
    if (own.mtimeMs < pdf.mtimeMs - PDF_FRESHNESS_SLACK_MS) {
      return { older: true };
    }
    return { text: await workspace.readFile(path) };
  } catch {
    return undefined;
  }
}

/** `besidePdfFile`'s text, for a caller that has no use for *why* not. */
async function besidePdf(
  workspace: ManuscriptWorkspace,
  pdfPath: string | undefined,
  ext: ".log" | ".aux",
): Promise<string | undefined> {
  const found = await besidePdfFile(workspace, pdfPath, ext);
  return found !== undefined && "text" in found ? found.text : undefined;
}

/**
 * The compile log's warnings for the overfull fact — or `undefined`, which
 * the facts read as *no log*, never as *no boxes*.
 *
 * The compile THIS run ran, when it ran one; else the `<base>.log` beside a
 * found PDF — what LaTeX-Workshop leaves — when it is not older than the PDF
 * (within the policy's own freshness slack, for filesystems that round a
 * timestamp). Any other log would be a claim about a different build.
 */
async function compileWarnings(
  pdf: ReviewPdfDeps,
  workspace: ManuscriptWorkspace,
  entry: string,
  outcome: { source: ReviewPdfSource; path?: string },
  compiled: CompileResult | undefined,
): Promise<Warning[] | undefined> {
  const read = pdf.compileLog;
  if (read === undefined) return undefined;
  if (outcome.source === "compiled") {
    return compiled !== undefined ? read(compiled.log, entry) : undefined;
  }
  const log = await besidePdf(workspace, outcome.path, ".log");
  if (log === undefined) return undefined;
  try {
    return read(log, entry);
  } catch {
    return undefined;
  }
}

/** The cross-review child: tool-less, skill-less, and given only the located
 *  concerns (ADR 0061 §7). Its own shape failure is fed back once, exactly as a
 *  reviewer's. Since R9 it may run on a model of its own (§D2). */
async function runSynthesis(
  deps: ReviewPanelDeps,
  located: readonly ReviewAnnotation[],
  carve: (childCount: number) => SessionTaskBudget,
  reviewerCount: number,
): Promise<{
  synthesis?: ReviewSynthesis;
  reason?: Extract<ReviewLimit, { kind: "synthesis_missing" }>["reason"];
  detail?: string;
  /** X5 (ADR 0074 §7): why the cross-review's stream died, on `"failed"`. The
   *  fourth child dies the same way the other three do, and its items hold the
   *  same evidence — read with `observeSeat`, not a second reader. */
  cause?: ModelFailureCause;
  usage?: Usage;
  /** What the child itself settled as — the synthesis seat's `status` (§D4). */
  childStatus: ReviewSeatState["status"];
}> {
  const remaining = carve(1);
  const child = await deps.runChild(
    synthesisBrief(located, reviewerCount, deps.focus),
    // An EMPTY allowlist. The synthesis has the whole panel's findings in its
    // goal, so a read tool could only send it back to material the seats have
    // already read — and a tool it cannot use is a tool it can be distracted by.
    narrowChildTools(deps.parentAllowed, []),
    {
      ...remaining,
      // Floored, and the overrun is deliberate and bounded: N reviewers that
      // each spend their whole carve leave nothing, and starving the synthesis
      // would throw the panel's last step away after paying for all of it. At
      // most PANEL_SEAT_TOKEN_FLOOR beyond the task's ceiling, once per panel
      // — a total for this child's whole run, NOT a per-turn cap (turns are
      // carved per-agent and undivided, and one hand-back can spend a second
      // one). Reachable at ANY budget and any N, the stock one included:
      // reviewers that spend their carves leave ~0, and the floor adds 4,000.
      maxOutputTokens: Math.max(
        PANEL_SEAT_TOKEN_FLOOR,
        remaining.maxOutputTokens,
      ),
    },
    [],
    (text) =>
      interpretSynthesis({ answer: text, annotations: located }).failure,
    // R9 (D2): the cross-review's own model, when the host bound one.
    deps.synthesis,
  );
  const usage = child.usage;
  const settled = { childStatus: child.status, ...(usage ? { usage } : {}) };
  if (child.status !== "completed") {
    const cause =
      child.status === "failed" ? observeSeat(child.items).failure : undefined;
    return {
      reason: child.status,
      ...(cause !== undefined ? { cause } : {}),
      ...settled,
    };
  }
  const report = [...child.items]
    .reverse()
    .find((i) => i.type === "agent_message" && i.text.trim() !== "");
  if (report === undefined) {
    return { reason: "no_report", ...settled };
  }
  const outcome = interpretSynthesis({
    answer: (report as { text: string }).text,
    annotations: located,
  });
  if (outcome.synthesis === undefined) {
    return {
      reason: "unparsed",
      ...(outcome.failure !== undefined ? { detail: outcome.failure } : {}),
      ...settled,
    };
  }
  return { synthesis: outcome.synthesis, ...settled };
}
