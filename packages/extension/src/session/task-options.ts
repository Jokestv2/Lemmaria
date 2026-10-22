/**
 * ADR 0065 §2: the task options a composer send and a detached review share.
 *
 * Extracted from `handleComposerSend`'s tail when the review stopped being a
 * chat task. Both callers need the same read surface, the same budget
 * ceilings, the same skills, the same grants and the same protected-span
 * reader — and a review briefed from a DIFFERENT read surface than the chat is
 * exactly the divergence that would be impossible to see and expensive to
 * find.
 *
 * What is deliberately NOT here is what the two do not share: the write path
 * (`editHost`, `snapshots`), which a review must never have — ADR 0061's
 * `review` actions never write, and omitting them is that rule holding by
 * construction rather than by a check — plus steering, the event sink, and the
 * store/session identity, which is the whole of what "detached" means.
 */

import {
  type CompileLogSource,
  loadLatexAdapter,
  manuscriptGraphFor,
  parseCompileLog,
  protectedSpansForFile,
} from "@lemmaria/adapters";
import {
  type CompileResult,
  LITERATURE_SESSION_BUDGET,
  type LiteratureWithhold,
  type ReviewPdfDeps,
  type RunSessionTaskOptions,
} from "@lemmaria/harness";
import type * as vscode from "vscode";
import { resolvedLocale } from "../i18n";
import type { ResolvedReviewPanel } from "../model";
import { configuredPaperPdf } from "../paper-entry";
import { pdfRendererFor } from "../pdf-host";
import { currentSkills } from "../skills-ui";
import { venueForEntry } from "../venue-match";
import { resolveCompileEngine } from "../verify-ui";
import { VscodeWorkspace } from "../workspace";
import { activeSessionGrants } from "./grants-host";
import {
  buildSessionRegistry,
  sessionCeilings,
  sessionMaxFanOut,
} from "./registry";
import { buildSessionScriptHost } from "./script-host";

/** The shared half of a task's options. */
export type SharedTaskOptions = Pick<
  RunSessionTaskOptions,
  | "registry"
  | "locale"
  | "skills"
  | "grants"
  | "scriptHost"
  | "protectedSpans"
  | "manuscriptGraph"
  | "ceilings"
  | "workspace"
  | "paperEntry"
  | "paperPdf"
  | "maxFanOut"
  | "reviewPanel"
  // V2 (ADR 0078 §5): the withholding holder travels with the registry that
  // reads it, so both hosts hand the panel the SAME object.
  | "literatureWithhold"
  // V4 (ADR 0081 §2): what a review needs to see the compiled paper.
  | "reviewPdf"
>;

/**
 * Build them, reading every per-run setting ONCE.
 *
 * The read-once discipline is inherited from `handleComposerSend` and is not
 * cosmetic: a panel that re-discovered its entry between seats could brief
 * them on different manuscripts.
 */
export async function sharedTaskOptions(
  context: vscode.ExtensionContext,
  paper: { root: string; entry: string } | undefined,
  reviewPanel?: ResolvedReviewPanel,
): Promise<SharedTaskOptions> {
  const maxFanOut = sessionMaxFanOut();
  // V2 (ADR 0078 §5): ONE holder per task, handed both to the registry whose
  // `literature_search` reads it and to the harness, whose review driver fills
  // and empties it. The same object, by reference — that is the whole
  // mechanism, and two holders would be a guard that silently never fires.
  //
  // Per task, so a panel's detached registry is not the chat's: a review
  // withholds the manuscript from its own reviewers and from nobody else.
  const literatureWithhold: LiteratureWithhold = { titles: [] };
  // V6's E1 round: a review's search budget is the RUN's, minted here as the
  // holder is. ADR 0019's per-session budget is the conversation's, and since
  // ADR 0065 a review is not part of one — yet it drew on it, so in one window
  // the third panel searched with nothing left and its literature rows said
  // no source had answered. Shared by the run's seats (ADR 0067 §6 stands);
  // a chat send keeps the session's.
  const literatureBudget = reviewPanel
    ? { remaining: LITERATURE_SESSION_BUDGET }
    : undefined;
  // V3 (ADR 0080 §8): the PDF the user named, read ONCE with everything else.
  // V4's driver reads it, and only when the PDF reviewer could run.
  const paperPdf = await configuredPaperPdf();
  // V4 (ADR 0081 §2): built only for a review — a chat send never reads a
  // PDF, so it never pays for the renderer or the venue match.
  const reviewPdf = reviewPanel
    ? await reviewPdfFor(context, paper)
    : undefined;
  return {
    registry: await buildSessionRegistry(
      context,
      literatureWithhold,
      literatureBudget,
    ),
    literatureWithhold,
    // ADR 0031: the language MODEL OUTPUT is rendered in — the system prompt's
    // reply-language line and every compaction handoff. Read fresh per task,
    // like the setting it reads.
    locale: resolvedLocale(),
    // B7 (ADR 0028): the Writing Skills loaded for this workspace, read fresh
    // so a skill the user just added is available on the next run.
    skills: currentSkills(),
    // A4: the envelope re-declares active grants at each task start.
    grants: () => activeSessionGrants(),
    // The script path (A4b, ADR 0020): approval-gated run_script over the
    // active grants. Offered only when the loop's own gates pass.
    scriptHost: buildSessionScriptHost(),
    // D1 (ADR 0032): the same detector `buildSessionRegistry` gives
    // `read_span`, so what a reader is TOLD is protected is exactly what
    // `propose_edit` refuses to lose.
    protectedSpans: protectedSpansForFile,
    // X5 (ADR 0074 §4): the panel's manuscript is the entry's include graph,
    // not every .tex/.md/.bib in the folder. Wired here for the same reason
    // the detector above is — the walk lives in the adapters, and the harness
    // may not import them (invariant 1).
    manuscriptGraph: manuscriptGraphFor,
    ceilings: sessionCeilings(),
    // R3 (ADR 0061): the panel's own read port. Not the tool registry's — the
    // driver reads the whole manuscript itself, before any seat runs.
    ...(paper
      ? {
          workspace: new VscodeWorkspace(paper.root, paper.entry),
          paperEntry: paper.entry,
        }
      : {}),
    ...(paperPdf ? { paperPdf } : {}),
    // A3 (ADR 0022): the fan-out width, clamped again by MAX_FAN_OUT.
    ...(maxFanOut !== undefined ? { maxFanOut } : {}),
    // R9 (ADR 0069 §D8): who reviews and on what, already RESOLVED — the
    // caller refused the run if any role could not be bound, so what reaches
    // the harness is a panel that can actually run. Omitted entirely when the
    // caller has no panel to run (an ordinary chat), which leaves the
    // harness's own default in charge and keeps the CLI and the offline suites
    // on one code path.
    ...(reviewPanel
      ? {
          reviewPanel: {
            reviewers: reviewPanel.reviewers.map((model) => ({ model })),
            synthesis: reviewPanel.synthesis,
            // V1 (ADR 0076 §8): a ChildModel, or "off".
            verifier: reviewPanel.verifier,
            // V4 (ADR 0081 §8): a ChildModel, or "off"; absent ⇒ Writing's.
            ...(reviewPanel.pdfReviewer !== undefined
              ? { pdfReviewer: reviewPanel.pdfReviewer }
              : {}),
          },
        }
      : {}),
    ...(reviewPdf ? { reviewPdf } : {}),
  };
}

/**
 * The review's PDF dependencies (V4, ADR 0081 §2): the renderer, and — when
 * the paper is LaTeX and Compile Check's engine resolves — a compile of the
 * same overlay Compile Check compiles, asking for the PDF back; a reader for
 * that engine's log; and the venue the Venue tab would name.
 *
 * `undefined` when the renderer cannot be had (its asset is missing): the
 * driver then records `visual_unavailable / no_renderer`, which is true. A
 * compile that is absent — no TeX on this machine, or a Markdown paper —
 * leaves the driver to find a PDF on disk, never to report a spawn error.
 */
async function reviewPdfFor(
  context: vscode.ExtensionContext,
  paper: { root: string; entry: string } | undefined,
): Promise<ReviewPdfDeps | undefined> {
  let renderer: ReviewPdfDeps["renderer"];
  try {
    renderer = await pdfRendererFor(context);
  } catch {
    return undefined;
  }
  const compiling = paper ? await reviewCompileFor(paper) : undefined;
  const source: CompileLogSource =
    compiling?.engine === "tectonic" ? "tectonic" : "latexmk";
  const venue = await venueForEntry(context, paper);
  return {
    renderer,
    ...(compiling ? { compile: compiling.compile } : {}),
    compileLog: (log, entryFile) => parseCompileLog(log, { source, entryFile }),
    ...(venue ? { venue } : {}),
  };
}

/** The compile a review may run, or `undefined` when there is none to run. */
async function reviewCompileFor(paper: {
  root: string;
  entry: string;
}): Promise<
  { engine: string; compile: () => Promise<CompileResult> } | undefined
> {
  if (!/\.tex$/i.test(paper.entry)) return undefined;
  try {
    const workspace = new VscodeWorkspace(paper.root, paper.entry);
    const adapter = await loadLatexAdapter(workspace, paper.entry);
    const { engine, guidance } = resolveCompileEngine(
      adapter.preferredEngines(),
    );
    // `guidance` is set exactly when the engine is not on this machine.
    if (guidance !== undefined) return undefined;
    return {
      engine,
      compile: () => workspace.compile(engine, { wantPdf: true }),
    };
  } catch {
    return undefined;
  }
}
