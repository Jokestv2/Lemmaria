/**
 * The three v0.2 flagship scenarios, as data (A6).
 *
 * The stage index requires that A6's live-eval probes are *"retained and
 * re-runnable … not evaporated like a spike branch"* — S4's probe lived on a
 * throwaway branch and bypassed the harness entirely, driving the raw SDKs. These
 * scenarios drive the **real** `runSessionTask`, so what they exercise is what
 * ships.
 *
 * **Judges are outcome-based.** S4 correction 2 recorded that edit granularity is
 * model-chosen — a model may legitimately fix three defects with two edits — so a
 * judge asserts on the resulting document and the transcript, never on a count of
 * edits or turns. Each check carries its own label, so a failure says *which*
 * property broke rather than just "failed".
 */

import { parseBibtex } from "@lemmaria/adapters";
import type { ReviewItem, SessionItem, ToolName } from "@lemmaria/harness";
import { formatAgreementReport, measureAgreement } from "./agreement.js";
import {
  DEFECT_CATEGORIES,
  type DefectManifest,
  formatLedgerRateLine,
  formatReviewerTallies,
  matchDefects,
  parsedSeats,
} from "./recall.js";
import {
  impressionsLine,
  measureScorecard,
  scorecardLine,
} from "./scorecard.js";
import {
  type VisualManifest,
  formatVisualReport,
  matchVisualDefects,
} from "./visual.js";

/** One thing a scenario requires of the run, with a human-readable name. */
export interface JudgeCheck {
  label: string;
  pass: boolean;
  detail?: string;
}

export interface JudgeVerdict {
  pass: boolean;
  checks: JudgeCheck[];
}

/** Everything a judge may look at: the transcript and the resulting files. */
export interface EvalOutcome {
  status: "completed" | "failed" | "interrupted";
  items: SessionItem[];
  /** Paper-workspace files after the run, by workspace-relative path. */
  files: Map<string, string>;
  error?: string;
}

/**
 * The part of a scenario the RUNNER needs: what to say, what tools to allow,
 * what grants are mandatory. A live test declares one of these and asserts on
 * the outcome itself, so it needs no judge.
 */
export interface EvalTaskSpec {
  id: string;
  /** The composer message a user would actually type. */
  prompt: string;
  /**
   * Grant ids the scenario needs (`--grant <id>=<path>`). The driver refuses to
   * run without them rather than silently evaluating a crippled task.
   */
  requiredGrants: string[];
  tools: ToolName[];
  /**
   * Run with NO write path (R5). A `/review` never writes (ADR 0061 §1), and an
   * eval that offered an edit host would loop-inject `propose_edit` into every
   * seat — measuring a panel with a capability the product's has not.
   */
  readOnly?: boolean;
  /** Load the SHIPPED Writing Skills, so a scenario that needs the bundled
   *  panel protocol gets the one users get rather than a hand-written stand-in. */
  bundledSkills?: boolean;
}

export interface FlagshipScenario extends EvalTaskSpec {
  title: string;
  /**
   * R5 widens this additively: a scenario that MEASURES the panel needs ground
   * truth its judge cannot derive from the transcript. The three flagship
   * judges ignore the second argument and are unchanged.
   */
  //
  // V4 widens it once more: the visual scenario's ground truth is a
  // `VisualManifest`. Method syntax, so a judge that names the one it reads
  // (`planted-defects`' `DefectManifest`) still satisfies it.
  judge(
    outcome: EvalOutcome,
    manifest?: DefectManifest | VisualManifest,
  ): JudgeVerdict;
}

/**
 * A scenario that measures the product rather than exercising it (R5).
 *
 * Structurally a `FlagshipScenario` — same runner, same report — but listed
 * apart, because `--scenario all` means *the three flagship tasks* and a
 * measurement that spends a whole panel is not something to sweep into that.
 */
export interface EvidenceScenario extends FlagshipScenario {
  /** The ground truth this judge cannot report without, resolved beside the
   *  paper directory unless `--defects` names another path. */
  manifestFile: string;
}

// --- judge helpers -------------------------------------------------------

function toolCalls(items: SessionItem[]): Array<{
  tool: string;
  argsJson: string;
  resultJson: string;
  status: string;
}> {
  const calls: Array<{
    tool: string;
    argsJson: string;
    resultJson: string;
    status: string;
  }> = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    calls.push({
      tool: item.tool,
      argsJson: item.argsJson ?? "",
      resultJson: item.resultJson ?? "",
      status: item.status,
    });
  }
  return calls;
}

/** Every character the run put in front of the user or into a file. */
function producedText(outcome: EvalOutcome): string {
  const parts: string[] = [];
  for (const item of outcome.items) {
    if (item.type === "agent_message") parts.push(item.text);
  }
  for (const content of outcome.files.values()) parts.push(content);
  return parts.join("\n");
}

/**
 * The text THIS RUN put into the paper — the applied edits' own content, not
 * the paper directory it landed in.
 *
 * **The corpus for every judge check about what the run did**, and the review
 * round's F3 is what it costs to use the other one. A `writtenText` helper used
 * to join every text file in the working copy, and three checks read it: a real
 * manuscript arrives full of its own prose, its own numbers and its own \cite
 * keys, none of which this run wrote and none of which are in a granted
 * directory, so judging against it both passes a run that wrote nothing and
 * fails honest prose on any paper bigger than the fixture. The flagship gate
 * reproduced the first half — `5661 chars written`, verdict pass, against a
 * paper `git diff` showed byte-identical, 5661 being exactly `main.tex` +
 * `NOTES.md` + `refs.bib` + two newlines.
 *
 * `outcome.files` is still the right corpus for a question genuinely about the
 * document's final state. No check has one today.
 */
function appliedEditText(outcome: EvalOutcome): string {
  const parts: string[] = [];
  for (const item of outcome.items) {
    if (item.type !== "edit_proposal") continue;
    for (const edit of item.edits) {
      if (edit.status !== "applied" && edit.status !== "accepted") continue;
      if (edit.content !== undefined) parts.push(edit.content);
      if (edit.replacement !== undefined) parts.push(edit.replacement);
    }
  }
  return parts.join("\n");
}

/**
 * Everything the run read out of one granted root — the tool results
 * themselves, which is the only record of the granted material a judge has.
 *
 * Matched on the parsed `root` argument rather than a substring of the raw
 * args, so a grant id that happens to appear in a query string or a file path
 * does not pull an unrelated call in.
 */
function readFromGrant(outcome: EvalOutcome, grantId: string): string {
  const parts: string[] = [];
  for (const call of toolCalls(outcome.items)) {
    if (call.status !== "completed") continue;
    let root: unknown;
    try {
      root = (JSON.parse(call.argsJson) as Record<string, unknown>).root;
    } catch {
      root = undefined;
    }
    if (root !== grantId) continue;
    parts.push(call.resultJson);
  }
  return parts.join("\n");
}

// --- grounding numbers in what was read ----------------------------------

/** One number as a reader sees it: its value and the precision it was given at. */
interface Numeral {
  value: number;
  /** Fractional digits as written — the precision a rounded report is judged at. */
  decimals: number;
  text: string;
}

/**
 * A number, with optional 3-digit thousands groups. The lookbehind is what
 * keeps `known2020` and a version suffix out: a digit run glued to a word or
 * to a preceding decimal point is not a reported figure.
 */
const NUMERAL_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;

function numerals(text: string): Numeral[] {
  const found: Numeral[] = [];
  for (const match of text.matchAll(NUMERAL_RE)) {
    const whole = (match[1] ?? "").replace(/,/g, "");
    const frac = match[2] ?? "";
    const value = Number(`${whole}.${frac === "" ? "0" : frac}`);
    if (!Number.isFinite(value)) continue;
    found.push({
      value,
      decimals: Math.min(frac.length, 10),
      text: match[0],
    });
  }
  return found;
}

/**
 * The numbers in a passage that could be a **reported measurement**.
 *
 * Two exclusions, both deliberately conservative — a grounding check that
 * fires on honest prose is the same class of defect as one that cannot fire at
 * all, so anything ambiguous is dropped from the denominator rather than
 * counted against the writer:
 *
 * - a bare integer below 1000 is a count, an epoch, a section number, a list
 *   position or a percent sign's neighbour, and carries no evidence either way;
 * - a bare 4-digit integer in 1800–2100 is a year.
 */
function reportedNumerals(text: string): Numeral[] {
  return numerals(text).filter(
    (n) =>
      !(n.decimals === 0 && n.value >= 1800 && n.value <= 2100) &&
      (n.decimals > 0 || n.value >= 1000),
  );
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Is a reported number one of these source numbers, as a reader would judge it?
 *
 * Rounding to the *reported* precision is what makes `0.847` and `84.7\%` both
 * count as the source's `0.8470`: reporting a metric to fewer digits, or as a
 * percentage, is normal scientific prose and not a fabrication.
 *
 * **The percent rescaling applies to fractional figures only**, and that is a
 * correction rather than a nicety: at zero decimals, dividing by 100 and
 * rounding truncates a source count to its leading digits, so `412031` in the
 * results would have grounded a prose `4120` that means nothing. A percentage
 * is never a five-figure headcount, so nothing legitimate is lost by the gate.
 */
function groundedIn(reported: Numeral, source: readonly Numeral[]): boolean {
  for (const s of source) {
    const scalings =
      reported.decimals > 0
        ? [s.value, s.value * 100, s.value / 100]
        : [s.value];
    for (const scaled of scalings) {
      if (Math.abs(roundTo(scaled, reported.decimals) - reported.value) < 1e-9)
        return true;
    }
  }
  return false;
}

export interface GroundingReport {
  reported: number;
  grounded: number;
  /** Up to a handful of figures that appear in no file the run read. */
  ungrounded: string[];
}

/**
 * How much of a passage's arithmetic is actually in the material it read.
 *
 * A **share**, never an all-or-nothing match, because honest reporting derives:
 * a delta between two source numbers, a mean over per-seed values, a count of
 * rows. Those are correct prose that no source file contains verbatim, so a
 * check demanding every figure be found would fail exactly the careful writing
 * it exists to reward.
 */
export function groundNumerals(
  passage: string,
  source: string,
): GroundingReport {
  const sourceNumerals = numerals(source);
  const reported = reportedNumerals(passage);
  const ungrounded = reported.filter((n) => !groundedIn(n, sourceNumerals));
  return {
    reported: reported.length,
    grounded: reported.length - ungrounded.length,
    ungrounded: [...new Set(ungrounded.map((n) => n.text))].slice(0, 6),
  };
}

/** Below this share of grounded figures the passage is reporting numbers that
 *  are not in the material — see `groundNumerals` for why it is not 1. */
const GROUNDED_SHARE_FLOOR = 0.5;

// --- grounding terms in what was read ------------------------------------

/**
 * A token that could only have come from source code, not from English prose:
 * an internal capital (`AdamW`, `GRUCell`), an all-caps run (`GELU`,
 * `BATCH_SIZE`), an underscore (`build_optimizer`, `hidden_dim`), or a digit
 * beside letters (`Set2Set`, `resnet50`).
 *
 * Deliberately narrow. A share of ordinary words overlapping would need a
 * stopword list to mean anything, and a stopword list is a judgement nobody
 * can audit; an identifier is evidence on its own.
 */
const CODE_TERM_RE =
  /\b(?=[A-Za-z0-9_]*[A-Za-z])(?=[A-Za-z0-9_]*(?:[a-z][A-Z]|[A-Z]{2}|_|\d))[A-Za-z][A-Za-z0-9_]{2,}\b/g;

/**
 * Every citation command's key group, whatever the package.
 *
 * `\cite`, natbib's `\citep` / `\citet` / `\citeauthor`, biblatex's
 * `\parencite` / `\autocite` / `\textcite`, and the capitalised forms — with
 * natbib's optional pre/post notes, so `\citep[see][p.~4]{key}` still yields
 * `key`. **The operator's own paper uses `\citep{}` exclusively**, and the
 * round-2 review found a check pinned to a bare `\cite` match inspecting
 * nothing at all on it (F11).
 *
 * **Case-insensitive on purpose, and liberal on purpose.** `\Citep{}` opens a
 * sentence in real natbib prose, and a pattern that cannot see it would let a
 * fabricated key through in exactly the place an author capitalises. The cost
 * of `[A-Za-z]*cite[A-Za-z]*` under `i` is that any command *containing*
 * "cite" matches — accepted, because every LaTeX command that does takes
 * bibliography keys (`\nocite`, `\citeyear`, `\citealp`, `\citenum`), so the
 * liberal shape reads them all and invents no false key of its own.
 */
const CITE_RE = /\\[A-Za-z]*cite[A-Za-z]*\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/gi;

/**
 * A letter with a one-character subscript — `W_1`, `h_v`, `s_v` — is MATH the
 * model introduced as notation, not a name it claims to have read.
 *
 * The grounding check names its ungrounded terms because that list is the
 * operator's spot-check shortlist; round 2's flagship run filled six of six
 * slots with `W_2, W_1, h_u, h_v, s_v, t_v`, which is the same noise
 * `LATEX_KEYED_RE` exists to keep out. Narrow on purpose: `hidden_dim`,
 * `n_layers` and `BATCH_SIZE` are names and stay.
 *
 * **It filters the candidate set, so it moves the arithmetic too, and that is
 * the intended reading of `GROUNDED_TERMS_FLOOR`.** A GNN codebase really does
 * name its variables `h_v` and `W_1`, so before this filter such a term could
 * count toward the floor — but a model writes `h_v` for a graph network whether
 * or not it read the code, which is *"did the model happen to type AdamW"*
 * wearing a subscript. Worse, the grounding match is a case-insensitive
 * **substring**, so `h_v` grounds itself inside an unrelated `batch_value`.
 * Conventional notation is therefore not evidence of reading, and it leaves the
 * numerator and the denominator together rather than only the shortlist.
 */
const MATH_SUBSCRIPT_RE = /^[A-Za-z]_[A-Za-z0-9]$/;

/**
 * LaTeX markup the author wrote, never the codebase's names.
 *
 * The **keys go with the command** for every citation form `CITE_RE` covers and
 * for `\ref`, `\eqref` and `\label`:
 * `known2020` and `eq:cost` are identifier-shaped and belong to the manuscript,
 * so leaving them in would put bibliography keys on the operator's *"terms not
 * found in the source it read"* shortlist, where they are pure noise. Stripped
 * before the bare control words, so `\cite{…}` loses its argument rather than
 * just its backslash.
 */
// Sharing `CITE_RE` is also what keeps `\citep[see]{key}` from dropping `key`
// onto that shortlist once the bracket note has broken the narrower match.
const LATEX_KEYED_RE = new RegExp(
  `${CITE_RE.source}|\\\\(?:ref|eqref|autoref|label)\\s*\\{[^}]*\\}`,
  "gi",
);
const LATEX_COMMAND_RE = /\\[A-Za-z]+/g;

export function codeTerms(text: string): string[] {
  const found = new Set<string>();
  for (const match of text
    .replace(LATEX_KEYED_RE, " ")
    .replace(LATEX_COMMAND_RE, " ")
    .matchAll(CODE_TERM_RE)) {
    if (MATH_SUBSCRIPT_RE.test(match[0])) continue;
    found.add(match[0]);
  }
  return [...found];
}

/**
 * How many of the passage's code-shaped terms really occur in what the run read.
 *
 * Case-insensitive, because a docstring's `gelu` and a Method section's `GELU`
 * are the same name. Substring rather than word-boundary, because the source
 * corpus is JSON-escaped tool results where a name can sit against punctuation.
 */
export function groundTerms(
  passage: string,
  source: string,
): { reported: number; grounded: string[]; ungrounded: string[] } {
  const haystack = source.toLowerCase();
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const term of codeTerms(passage)) {
    (haystack.includes(term.toLowerCase()) ? grounded : ungrounded).push(term);
  }
  return {
    reported: grounded.length + ungrounded.length,
    grounded,
    ungrounded,
  };
}

/**
 * Distinct code-shaped terms a Method section must share with the codebase it
 * claims to describe.
 *
 * **An unmeasured judgement call, recorded as one** — like
 * `GROUNDED_SHARE_FLOOR`, it wants calibration against real material, and the
 * flagship gate's item 3 is the first evidence that could move it. The floor is
 * above **one** on purpose: the check this replaced was satisfied by a single
 * hardcoded word, so *"did the model happen to type AdamW"* passed for
 * grounding. One term can be luck; three naming the same codebase is not.
 */
const GROUNDED_TERMS_FLOOR = 3;

/** Every key the passage cites, duplicates collapsed. */
function citedKeys(passage: string): string[] {
  const keys = new Set<string>();
  for (const match of passage.matchAll(CITE_RE)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const key = raw.trim();
      if (key !== "") keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The prompt forbids invented citations, and a cited key absent from the
 * bibliography is exactly the fabrication a writing agent must not make.
 *
 * **This check used to say that and do something else** (the round-2 review's
 * F11). It compared every key against the literal `known2020` — the OFFLINE
 * fixture's only bib key — and its pattern matched neither `\citep{}` nor
 * `\citet{}`. So on the operator's own paper, which this gate exists to run on,
 * it was wrong in all three directions at once: a fabricated
 * `\citep{invented2099}` passed unseen, a real `\cite{perez2018film}` from their
 * own `refs.bib` failed, and the fixture's key passed while being absent from
 * that bibliography. Exactly F4's defect, in the check immediately below it.
 *
 * The bibliography is now the one in the workspace — every `.bib` the run wrote
 * beside, parsed with the adapter package's own BibTeX reader. The union of all
 * of them rather than only the ones the paper's own `\bibliography{}` names,
 * because a false FAIL on an honest paper is the worse error here.
 *
 * **Vacuity is said out loud, both ways.** A passage citing nothing passes and
 * says so; a passage citing keys with no `.bib` anywhere in the workspace
 * **fails as unverifiable**, because a check that cannot measure and prints a
 * green tick is this round's own I1.
 */
function citedKeysAreReal(written: string, outcome: EvalOutcome): JudgeCheck {
  const cited = citedKeys(written);
  const bibs = [...outcome.files].filter(([path]) =>
    path.toLowerCase().endsWith(".bib"),
  );
  const known = new Set(
    bibs.flatMap(([, source]) => parseBibtex(source).map((e) => e.key)),
  );
  const invented = cited.filter((k) => !known.has(k));
  const label = "invented no citation key";
  if (cited.length === 0) {
    return { label, pass: true, detail: "no citation keys written" };
  }
  if (bibs.length === 0) {
    return {
      label,
      pass: false,
      detail: `no .bib in the paper workspace — ${cited.length} cited key(s) unverifiable: ${cited.join(", ")}`,
    };
  }
  return {
    label,
    pass: invented.length === 0,
    detail:
      invented.length === 0
        ? `${cited.length}/${cited.length} cited key(s) are in the bibliography (${known.size} key(s) in ${bibs.length} .bib file(s))`
        : `not in the bibliography: ${invented.join(", ")}`,
  };
}

function noticeCodes(items: SessionItem[]): string[] {
  return items
    .filter((i) => i.type === "notice")
    .map((i) => (i.type === "notice" ? i.code : ""));
}

function verdict(checks: JudgeCheck[]): JudgeVerdict {
  return { pass: checks.every((c) => c.pass), checks };
}

/** The run must not have died; a budget stop is reported, not failed. */
function ranToCompletion(outcome: EvalOutcome): JudgeCheck {
  return {
    label: "the task completed rather than failing",
    pass: outcome.status === "completed",
    ...(outcome.error !== undefined ? { detail: outcome.error } : {}),
  };
}

// --- the scenarios -------------------------------------------------------

/**
 * Flagship 1 — draft a Methods section from a granted codebase.
 *
 * The grounding check is the point: prose about a codebase the agent never read
 * is the failure mode that matters, and it is invisible in a transcript that
 * looks busy. The judge therefore requires a term that exists ONLY in the
 * granted source, not in the paper.
 */
const methodsFromCodebase: FlagshipScenario = {
  id: "methods-from-codebase",
  title: "Draft a Methods section from a granted codebase",
  prompt:
    "Read the granted codebase and draft the Method section of this paper from what the code actually does — the model architecture, the dataset, and the optimization settings. Write it into the paper. Do not invent citations or numbers that are not in the code.",
  requiredGrants: ["codebase"],
  tools: ["list_files", "read_span", "grep_project", "get_outline"],
  judge(outcome) {
    const calls = toolCalls(outcome.items);
    const readTheGrant = calls.some(
      (c) =>
        (c.tool === "list_files" ||
          c.tool === "read_span" ||
          c.tool === "grep_project") &&
        c.argsJson.includes("codebase"),
    );
    // What THIS RUN wrote, never the paper it wrote into (the review round's
    // F3). Every check below is about the run's own passage, and reading them
    // off the working copy made all three vacuous on real material.
    const written = appliedEditText(outcome);
    // Grounded in the granted codebase, WHATEVER that codebase is (F4).
    //
    // This check used to be `/widgetnet|adamw|widgetset|gelu/i` — three of
    // those four words are the OLD synthetic fixture's vocabulary, so on the
    // operator's own repo, which is the entire point of this gate, "the prose
    // is grounded in the source it read" degraded to "did the model happen to
    // type AdamW". Combined with F3 it ran over the whole paper directory, so
    // any manuscript already mentioning AdamW passed it without the run
    // writing a word. The source of truth is what the run READ out of the
    // grant, exactly as `experiments-from-results` grounds its figures.
    const grounding = groundTerms(written, readFromGrant(outcome, "codebase"));
    const grounded = grounding.grounded.length >= GROUNDED_TERMS_FLOOR;
    // Named even on a pass: the operator's shortlist of terms to spot-check by
    // hand, which is what TEST.md's B2 asks them to do.
    const groundingDetail =
      grounding.reported === 0
        ? "the passage it wrote names nothing from any codebase"
        : `${grounding.grounded.length}/${grounding.reported} code terms appear in the source it read (${
            grounding.grounded.slice(0, 6).join(", ") || "none"
          })${
            grounding.ungrounded.length > 0
              ? ` — not found: ${grounding.ungrounded.slice(0, 6).join(", ")}`
              : ""
          }`;
    return verdict([
      ranToCompletion(outcome),
      {
        label: "read the granted codebase before writing",
        pass: readTheGrant,
        detail: `${calls.length} tool call(s)`,
      },
      {
        label: "wrote a substantial passage into the paper",
        pass: written.length > 200,
        detail: `${written.length} chars written`,
      },
      {
        label: "the prose is grounded in the source it read",
        pass: grounded,
        detail: groundingDetail,
      },
      citedKeysAreReal(written, outcome),
    ]);
  },
};

/**
 * Flagship 2 — draft Experiments from a granted results folder.
 *
 * Also the regression guard for A6's exclusion counters: the fixture's
 * `figures/` is gitignored, so a run that reports "nothing here" instead of
 * "some entries are hidden" is the silent failure this milestone fixed.
 */
const experimentsFromResults: FlagshipScenario = {
  id: "experiments-from-results",
  title: "Draft an Experiments section from a granted results folder",
  prompt:
    "Read the granted results folder and draft the Experiments section: report the metrics that are actually in the results, comparing the models. Write it into the paper. If some files are hidden from you, say so instead of assuming they do not exist.",
  requiredGrants: ["results"],
  tools: ["list_files", "read_span", "grep_project"],
  judge(outcome) {
    const calls = toolCalls(outcome.items);
    const listed = calls.filter((c) => c.tool === "list_files");
    // The run's own passage, not the paper it wrote into (F3) — the same
    // corpus the grounding check below already used, for the same reason.
    const written = appliedEditText(outcome);
    // Grounded in the granted results directory, WHATEVER that directory is.
    //
    // This check used to test the prose against four literals out of the
    // shipped fixture's metrics.csv, which made it unpassable on any other
    // results dir — while `tests/r5/3-live-flagship-gate/TEST.md` is precisely
    // an instruction to run this scenario with `--grant results=<your own>`.
    // The source of truth is what the run READ out of the grant, and the
    // passage judged is what the run WROTE, not the paper it wrote into.
    const grounding = groundNumerals(
      appliedEditText(outcome),
      readFromGrant(outcome, "results"),
    );
    const usedRealNumbers =
      grounding.grounded > 0 &&
      grounding.grounded >= grounding.reported * GROUNDED_SHARE_FLOOR;
    // Named even on a pass: it is the operator's shortlist of figures to
    // spot-check by hand, which is exactly what TEST.md's B3 asks them to do.
    const missing =
      grounding.ungrounded.length > 0
        ? ` — not found: ${grounding.ungrounded.join(", ")}`
        : "";
    const groundingDetail =
      grounding.reported === 0
        ? "the passage it wrote reports no measurement at all"
        : `${grounding.grounded}/${grounding.reported} reported figures appear in the results it read${missing}`;
    const sawExclusions = listed.some((c) => {
      try {
        const parsed = JSON.parse(c.resultJson) as Record<string, unknown>;
        return (
          typeof parsed.excludedByGitignore === "number" &&
          parsed.excludedByGitignore > 0
        );
      } catch {
        return false;
      }
    });
    return verdict([
      ranToCompletion(outcome),
      {
        label: "listed the granted results folder",
        pass: listed.some((c) => c.argsJson.includes("results")),
      },
      {
        label: "the listing disclosed the hidden (gitignored) entries",
        pass: sawExclusions,
        detail: sawExclusions
          ? undefined
          : "list_files reported no exclusions — A6's counters are not reaching the tool result",
      },
      {
        label: "reported metrics that are really in the results",
        pass: usedRealNumbers,
        detail: groundingDetail,
      },
      {
        label: "wrote a substantial passage into the paper",
        pass: written.length > 150,
        detail: `${written.length} chars written`,
      },
    ]);
  },
};

/**
 * Flagship 3 — literature research.
 *
 * The honesty check is the one that matters and the one the stage-gate
 * checklist calls for: when sources are rate-limited, the answer must say the
 * sources did not answer, never that the papers do not exist.
 */
const literatureResearch: FlagshipScenario = {
  id: "literature-research",
  title: "Research the related literature for this paper",
  prompt:
    "Find recent related work on this paper's topic using the literature tools, and summarize the most relevant papers for me. Be explicit about what you could and could not check.",
  requiredGrants: [],
  tools: ["literature_search", "read_span", "list_citations"],
  judge(outcome) {
    const calls = toolCalls(outcome.items);
    const searched = calls.filter((c) => c.tool === "literature_search");
    const degraded = searched.some((c) => {
      try {
        const parsed = JSON.parse(c.resultJson) as {
          sources?: Array<{ status?: string }>;
        };
        return (parsed.sources ?? []).some((s) => s.status !== "ok");
      } catch {
        return false;
      }
    });
    const text = producedText(outcome);
    const admitsDegradation =
      !degraded ||
      /rate|limit|could not|couldn't|unavailable|did not answer|timed out|未能|超时|限流/i.test(
        text,
      );
    return verdict([
      ranToCompletion(outcome),
      { label: "used literature_search", pass: searched.length > 0 },
      { label: "produced a summary for the user", pass: text.length > 120 },
      {
        label: "was honest about sources that did not answer",
        pass: admitsDegradation,
        detail: admitsDegradation
          ? undefined
          : "sources were degraded but the answer does not say so",
      },
    ]);
  },
};

export const FLAGSHIP_SCENARIOS: readonly FlagshipScenario[] = [
  methodsFromCodebase,
  experimentsFromResults,
  literatureResearch,
];

// --- the evidence scenario (R5) -------------------------------------------

/** What a panel run amounted to — the R3 vocabulary, in one place now that a
 *  judge reports it as well as the live rows. */
export type PanelOutcome =
  | "panel_located"
  | "panel_partial"
  | "panel_empty"
  | "panel_unparsed"
  | "no_run";

/**
 * Names a null result rather than letting it borrow the name of a pass.
 *
 * `panel_empty` on THIS fixture is a model finding, not correct restraint:
 * sixteen defects were planted in it on purpose.
 */
export function classifyPanel(item: ReviewItem | undefined): PanelOutcome {
  if (item === undefined || item.result === undefined) return "no_run";
  // `parsedSeats` rather than a second copy of the count: `panel_unparsed` and
  // `RecallReport.measured` are the same fact, and the whole point of I1's fix
  // is that they can never disagree about whether anything was measured.
  const parsed = parsedSeats(item);
  if (parsed === 0) return "panel_unparsed";
  const annotations = item.result.annotations;
  if (annotations.length === 0) return "panel_empty";
  const contributing = new Set(annotations.map((a) => a.reviewer)).size;
  return parsed >= 2 && contributing >= 2 && item.result.synthesis !== undefined
    ? "panel_located"
    : "panel_partial";
}

function reviewItemOf(outcome: EvalOutcome): ReviewItem | undefined {
  return outcome.items.find((i): i is ReviewItem => i.type === "review");
}

/**
 * The measurement scenario — planted-defect recall of the review panel (R5).
 *
 * **Every recall check passes by construction, and that is the design.** The
 * first measurement is the floor and it is recorded in prose, never asserted
 * (ADR 0070 §5): a recall threshold in a judge would be a flake generator
 * across model versions, and exactly the *"assertion admitting one outcome
 * only"* ADR 0035 §5 forbids. What the judge fails on is the run not
 * happening — the task dying, or no review being produced.
 *
 * It lives on the retained eval driver so the same command line that drives
 * A6's gate on a flagship also measures the panel on one (J4) — the second
 * reading the R3 drop-rate question could not get from the cheap pins.
 */
const plantedDefects: EvidenceScenario = {
  id: "planted-defects",
  title: "Planted-defect recall of the review panel",
  prompt: "/review",
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files", "literature_search"],
  readOnly: true,
  bundledSkills: true,
  manifestFile: "defects.json",
  judge(outcome, manifest?: DefectManifest) {
    const item = reviewItemOf(outcome);
    const checks: JudgeCheck[] = [
      ranToCompletion(outcome),
      {
        label: "the panel produced a review",
        pass: item !== undefined && item.status === "completed",
        ...(item === undefined ? { detail: "no review item" } : {}),
      },
      { label: `panel outcome: ${classifyPanel(item)}`, pass: true },
    ];
    if (item !== undefined && manifest !== undefined) {
      const recall = matchDefects(item, manifest);
      // **Unmeasured is not zero** (the review round's I1). With no seat's
      // ledger read, this judge used to emit a green tick on every recall
      // figure — `recall overall: 0/16 — missed S1,…,E4` under a PASS header,
      // at exit 0, on a run that never reached a model — because each check was
      // pushed with `pass: true` by construction without ever consulting the
      // outcome it had computed one line above. An operator taking figures off
      // a PASS line then puts a fabricated zero into a durable record, which is
      // the single failure this whole scenario is organised against.
      //
      // Failing here is not a recall threshold sneaking past ADR 0070 §5: this
      // judge's stated failure condition is already *"the run not happening —
      // the task dying, or no review being produced"*, and a panel whose every
      // seat is missing produced no review. No recall number is asserted; the
      // recall checks are not emitted at all, because there are none to emit.
      if (!recall.measured) {
        checks.push({
          label: `recall: unmeasured (${classifyPanel(item)})`,
          pass: false,
          detail:
            "no seat produced a ledger the driver could read, so there is no measurement — record this row as unmeasured, never as a recall of zero",
        });
        return verdict(checks);
      }
      for (const category of DEFECT_CATEGORIES) {
        const per = recall.perCategory[category];
        checks.push({
          label: `recall ${category}: ${per.found}/${per.planted}`,
          pass: true,
        });
      }
      checks.push({
        label: `recall overall: ${recall.overall.found}/${recall.overall.planted}`,
        pass: true,
        // Which concern earned which hit, on the line that carries the number.
        // A passing evidence run keeps its work dir now (I4), but the figure
        // and its attribution belong together wherever the figure is read.
        detail:
          `missed ${recall.missed.join(",") || "nothing"}` +
          ` — credited ${recall.hits.map((h) => `${h.defect}:${h.ids.join("+")}`).join(" ") || "nothing"}`,
      });
      if (recall.contested.length > 0) {
        checks.push({
          label: `concerns reaching more than one defect: ${recall.contested.length}`,
          pass: true,
          detail: recall.contested
            .map(
              (c) => `${c.id}→${c.credited} (not ${c.alsoReached.join("/")})`,
            )
            .join(" "),
        });
      }
      checks.push({
        label: `unmatched concerns: ${recall.unmatched.length}`,
        pass: true,
      });
      checks.push({
        label: `span-only hits: ${recall.spanOnlyHits}`,
        pass: true,
      });
      // The anchor location rate, per seat — the number the review round's
      // Judge question 1 needed and could not get. `formatRecallReport` built
      // this line for the live tier and nothing else printed it, so
      // `lemmaria eval` on a flagship reported the flagship's RECALL and
      // nothing about its QUOTING, leaving "a cheap model quotes badly" and
      // "models quote badly" indistinguishable on the one path that reaches a
      // flagship at all. One shared formatter, two callers.
      const located = Object.values(recall.perReviewer).reduce(
        (n, r) => n + r.located,
        0,
      );
      const concerns = Object.values(recall.perReviewer).reduce(
        (n, r) => n + r.concerns,
        0,
      );
      checks.push({
        label:
          `anchors located: ${located}/${concerns} concern(s)` +
          `${concerns === 0 ? "" : ` (${Math.round((located / concerns) * 100)}%)`}`,
        pass: true,
        detail: formatReviewerTallies(recall),
      });
      // X5 (ADR 0074 §8): the panel's located rate before and after the one
      // re-ask, and the conservative reading beside it. This is the number
      // the milestone exists to move, so it is printed where the recall
      // figures are read — and, like them, reported rather than gated.
      const ledgerRates = formatLedgerRateLine(recall);
      if (ledgerRates !== undefined) {
        checks.push({ label: ledgerRates, pass: true });
      }
      // X5 (ADR 0074 §9): concerns that are really literature outages. The
      // instrument for the protocol change, NEVER asserted — the point is to
      // watch it fall, and an assertion would freeze the first reading into a
      // threshold.
      checks.push({
        label: `outage-shaped concerns: ${recall.outageShaped.length}`,
        pass: true,
        ...(recall.outageShaped.length > 0
          ? { detail: recall.outageShaped.map((o) => o.id).join(",") }
          : {}),
      });
      const agreement = measureAgreement(item, recall);
      checks.push({
        label:
          `agreement same-model=${agreement.sameModel.pairs} pair(s), ` +
          `cross-model=${agreement.crossModel.pairs} pair(s)`,
        pass: true,
        detail: formatAgreementReport(agreement).split("\n")[0],
      });
      // V5 (ADR 0087, D15): the derived card, levels and impressions on
      // lines of their own — reported beside recall, never gated. Reached
      // only when a ledger was read, so it is never an unmeasured card.
      const scorecard = measureScorecard(item);
      if (scorecard.card !== undefined) {
        checks.push({ label: scorecardLine(scorecard.card), pass: true });
        checks.push({ label: impressionsLine(scorecard.card), pass: true });
      }
    }
    return verdict(checks);
  },
};

/**
 * The same measurement, on the same paper, cut into `\input`-ed files
 * (X5, ADR 0074 §10).
 *
 * It shares `plantedDefects`' prompt, tools and **judge object itself** rather
 * than a copy: the two fixtures exist to be compared, and a second judge would
 * be a second thing that could drift into measuring something else. Only the
 * id and the title differ, because only the fixture does.
 *
 * Because the split fixture expands to the flat one byte for byte, a
 * difference in the located rate between the two runs is attributable to
 * **layout alone** — which is the whole reason the second fixture exists.
 */
const plantedDefectsSplit: EvidenceScenario = {
  ...plantedDefects,
  id: "planted-defects-split",
  title: "Planted-defect recall of the review panel, on an input-split paper",
};

// Neither is in `--scenario all`, which expands to `FLAGSHIP_SCENARIOS`: an
// evidence run spends a whole panel, and two of them spend two.
export const EVIDENCE_SCENARIOS: readonly EvidenceScenario[] = [
  plantedDefects,
  plantedDefectsSplit,
];

// --- the novelty probe (V2, ADR 0078 D13) ---------------------------------

/**
 * A paper that re-derives a known work under another name and another title,
 * never citing it — and its twin, identical but for a `\title` line that IS
 * the known work's.
 *
 * **Why it is not an `EvidenceScenario`.** Its ground truth is a
 * `NoveltyProbe`, not a `DefectManifest`: it names one retrieved paper and the
 * lines that claim its contribution, where a manifest names planted edits and
 * their admissible spans. `command.ts` loads an evidence scenario's manifest
 * with `readManifest`, which would (rightly) refuse `probe.json`. The live
 * rows read the probe themselves and call `measureNovelty`, which is where a
 * measurement over one retrieved title belongs.
 *
 * **What its judge promises: nothing about the number.** It reports that the
 * panel ran and produced a review. A probe in which no reviewer finds the
 * known work is a finding for the Done record, never a failing run -- the same
 * rule ADR 0070 5 states for recall, for the same reason.
 */
const noveltyProbe: FlagshipScenario = {
  id: "novelty-probe",
  title: "Does the panel locate prior work the paper re-derives in silence?",
  prompt: "/review Is the optimiser this paper proposes actually new?",
  requiredGrants: [],
  // The planted-defects tools: the panel's own reading set, plus the one that
  // makes an `originality` concern citable at all.
  tools: ["read_span", "get_outline", "list_files", "literature_search"],
  readOnly: true,
  bundledSkills: true,
  judge(outcome) {
    const item = reviewItemOf(outcome);
    return {
      pass:
        outcome.status === "completed" &&
        item !== undefined &&
        item.status === "completed",
      checks: [
        ranToCompletion(outcome),
        {
          label: "the panel produced a review",
          pass: item !== undefined && item.status === "completed",
          ...(item === undefined ? { detail: "no review item" } : {}),
        },
        { label: `panel outcome: ${classifyPanel(item)}`, pass: true },
      ],
    };
  },
};

/**
 * Scenarios whose ground truth is neither absent nor a defect manifest. Kept
 * out of `--scenario all` for `EVIDENCE_SCENARIOS`' reason: it spends a panel.
 */
/**
 * The visual door's own probe (V3, ADR 0080).
 *
 * Not a panel and not a review: one task, one page, one code that exists only
 * on the RENDERED page. It is the cheapest honest question about the door —
 * can a model be handed a rendered page and read something off it — and it is
 * what makes `view_pdf_pages` reachable from the CLI at all, since no
 * production path registers the tool in V3.
 *
 * The judge does NOT require the marker to be read. Whether a given model can
 * is a live-tier reading, and a scenario that failed on it would turn a
 * measurement into a gate — ADR 0070 §5's rule for recall, for the same reason.
 */
const pdfMarker: FlagshipScenario = {
  id: "pdf-marker",
  title: "Can a model read a code that is only on the rendered page?",
  prompt:
    "Use view_pdf_pages to look at page 1 of the compiled paper and reply with the code printed inside the framed box on that page — the code and nothing else.",
  requiredGrants: [],
  tools: ["view_pdf_pages"],
  readOnly: true,
  judge(outcome) {
    const asked = toolCalls(outcome.items).filter(
      (c) => c.tool === "view_pdf_pages",
    );
    // **Asked is not ran.** The allowlist denies at EXECUTION, so a model
    // whose tool was withheld still produces a `tool_call` item — `status:
    // "failed"`, `code: "denied"`. Counting those would make a run with no
    // renderer, or a binding that cannot see, read exactly like a run that
    // opened the door. Every other judge here already filters on the item's
    // own status; this one must too.
    const ran = asked.filter((c) => c.status === "completed");
    const denied = asked.length - ran.length;
    return {
      // The door works if the tool ran and the task completed. What the model
      // SAW is the live tier's reading, reported and never asserted.
      pass: outcome.status === "completed" && ran.length > 0,
      checks: [
        ranToCompletion(outcome),
        {
          label: "view_pdf_pages ran",
          pass: ran.length > 0,
          ...(ran.length === 0
            ? {
                detail:
                  asked.length === 0
                    ? "the tool was never offered or never called"
                    : `the model asked ${asked.length} time(s) and every call was refused`,
              }
            : {}),
        },
        {
          label: `view_pdf_pages calls: ${ran.length} ran, ${denied} refused`,
          pass: true,
        },
      ],
    };
  },
};

export const PROBE_SCENARIOS: readonly FlagshipScenario[] = [
  noveltyProbe,
  pdfMarker,
];

// --- the visual defects (V4, ADR 0081; plan D14) ---------------------------

/** A scenario measured against `visual.json`, not `defects.json`. */
export interface VisualScenario extends FlagshipScenario {
  /** Resolved beside the paper directory unless `--defects` names another. */
  manifestFile: string;
}

/**
 * S6's ten defects that only the rendered page shows, reviewed by the PDF
 * reviewer alone (`/review-pdf`).
 *
 * The judge prints the visual report and fails on ONE thing: no ledger from
 * the PDF reviewer, which is *not measured*, never a zero (R5's I1). What the
 * seat found is a reading, recorded in prose — a number asserted here would be
 * the gate ADR 0035 §5 forbids.
 */
const visualDefects: VisualScenario = {
  id: "visual-defects",
  title: "What the PDF reviewer finds on a page with ten planted defects",
  prompt: "/review-pdf",
  requiredGrants: [],
  tools: ["read_span", "get_outline", "list_files", "grep_project"],
  readOnly: true,
  bundledSkills: true,
  manifestFile: "visual.json",
  judge(outcome, manifest) {
    const item = reviewItemOf(outcome);
    const checks: JudgeCheck[] = [
      ranToCompletion(outcome),
      {
        label: "the run produced a review",
        pass: item !== undefined && item.status === "completed",
        ...(item === undefined ? { detail: "no review item" } : {}),
      },
    ];
    if (manifest === undefined || !("venue" in manifest)) {
      checks.push({
        label: "the visual manifest was read",
        pass: false,
        detail: "no visual.json reached the judge",
      });
      return verdict(checks);
    }
    const report = matchVisualDefects(item, manifest);
    if (!report.measured) {
      const limits = (item?.result?.limits ?? []).flatMap((l) =>
        l.kind === "visual_unavailable" || l.kind === "pdf_unavailable"
          ? [`${l.kind}/${l.reason}`]
          : [],
      );
      checks.push({
        label: "visual defects: not measured",
        pass: false,
        detail:
          limits.length > 0
            ? `the PDF reviewer did not run: ${limits.join(", ")}`
            : "the PDF reviewer produced no ledger the driver could read — record this row as not measured, never as zero",
      });
      return verdict(checks);
    }
    for (const line of formatVisualReport(report).split("\n")) {
      checks.push({ label: line.trim(), pass: true });
    }
    return verdict(checks);
  },
};

export const VISUAL_SCENARIOS: readonly VisualScenario[] = [visualDefects];

/**
 * Both lists. `--scenario all` is still the three flagships (see `EVAL_USAGE`):
 * an evidence run spends a panel, and sweeping it into `all` would make the
 * flagship gate silently more expensive.
 */
export function scenarioById(id: string): FlagshipScenario | undefined {
  return (
    FLAGSHIP_SCENARIOS.find((s) => s.id === id) ??
    EVIDENCE_SCENARIOS.find((s) => s.id === id) ??
    PROBE_SCENARIOS.find((s) => s.id === id) ??
    VISUAL_SCENARIOS.find((s) => s.id === id)
  );
}

/** V4: does this scenario read `visual.json`? */
export function visualScenario(
  scenario: FlagshipScenario,
): VisualScenario | undefined {
  return VISUAL_SCENARIOS.find((s) => s.id === scenario.id);
}

/** Does this scenario's judge need ground truth the transcript cannot give? */
export function evidenceScenario(
  scenario: FlagshipScenario,
): EvidenceScenario | undefined {
  return EVIDENCE_SCENARIOS.find((s) => s.id === scenario.id);
}
