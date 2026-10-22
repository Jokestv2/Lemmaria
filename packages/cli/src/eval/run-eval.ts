/**
 * The retained, re-runnable flagship eval driver (A6).
 *
 * Runs a flagship scenario through the **real** `runSessionTask` — the same
 * loop, tool registry, grants, budgets and prompt the extension uses — in pure
 * Node. That it can be done at all is invariant 1's whole point: the session
 * engine has zero VS Code dependency, so a CLI (and later a Phase-2 server) can
 * drive it. This driver is the first thing that actually proves it.
 *
 * Two modes:
 * - **`--stub`** — a scripted model (`ScriptedModelAdapter`). Deterministic, offline,
 *   and therefore runnable in the gate. It exercises the plumbing and the
 *   judges, not the model.
 * - **live** — a real binding from `LEMMARIA_SMOKE_*` env keys (the M1/S4 smoke
 *   convention). This is what the operator runs against the private fixture set;
 *   it costs money and is never part of `pnpm test`.
 *
 * **The paper is always copied to a temp directory first.** An eval that edited
 * the user's real paper would be a milestone about honest agents committing the
 * exact sin it exists to prevent.
 */

import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  manuscriptGraphFor,
  parseCompileLog,
  protectedSpansForFile,
} from "@lemmaria/adapters";
import {
  type ChildModel,
  type EditDecision,
  type EditProposalItem,
  type GrantedRoot,
  type LiteratureProvider,
  type LiteratureWithhold,
  type ModelAdapter,
  type ModelBinding,
  PROVIDER_PRESETS,
  type PdfFacts,
  type PdfRenderer,
  type Protocol,
  type ReviewItem,
  type ReviewPdfDeps,
  type ReviewPdfSource,
  type ReviewVenue,
  ScriptedModelAdapter,
  type SessionEditHost,
  type SessionItem,
  SessionStore,
  type Skill,
  type ToolName,
  type Usage,
  type ViewPdfPagesTool,
  arxivLiterature,
  assertWorkspaceRelative,
  buildToolRegistry,
  canSeeImages,
  canonicalizeGrantRoot,
  createModelAdapter,
  createViewPdfPagesTool,
  crossrefLiterature,
  dblpLiterature,
  resolveReviewPdf,
  runSessionTask,
  semanticScholarLiterature,
  withholdImageTools,
} from "@lemmaria/harness";
import type { DefectManifest } from "./recall.js";
import type {
  EvalOutcome,
  EvalTaskSpec,
  FlagshipScenario,
  JudgeVerdict,
} from "./scenarios.js";
import { evidenceScenario } from "./scenarios.js";
import { stubLiteratureProviders, stubTurnsFor } from "./stub-script.js";
import type { VisualManifest } from "./visual.js";

export interface EvalTaskOptions {
  /**
   * V2 (ADR 0078 §D13): literature providers to use instead of the scenario's
   * own choice — **whatever else is set**, `--stub` and an injected adapter
   * included.
   *
   * A caller that supplies its own providers is offline by construction, in
   * exactly the sense `offline` already means for an injected adapter: it is
   * reaching nothing. It is what lets a test drive the panel's withholding
   * guard end to end without asking a real scholarly index anything.
   */
  literatureProviders?: LiteratureProvider[];
  scenario: EvalTaskSpec;
  /**
   * The PDF renderer (V3, ADR 0080 §9). Present ⇒ a scenario whose `tools`
   * name `view_pdf_pages` gets the tool built over the PDF the policy resolved.
   * Absent ⇒ the report says `no_renderer`, honestly, rather than silently
   * running a scenario that cannot do the one thing it is for.
   */
  pdfRenderer?: PdfRenderer;
  /** The paper project to work on. COPIED before anything runs. */
  paperDir: string;
  /** Grant id → absolute path, from `--grant id=path`. */
  grants: Map<string, string>;
  /** Offline scripted model instead of a live one. */
  stub: boolean;
  binding?: ModelBinding;
  /**
   * The adapter to run with, instead of the one built from `binding.protocol`
   * (T2, ADR 0043).
   *
   * **Why this exists.** [ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
   * §2 sends *"what the model was **asked**, what it did"* to the live tier —
   * and the first half was unobservable. `buildSessionSystemPrompt` runs inside
   * `runSessionTask`, and the assembled `ChatMessage[]` is neither persisted nor
   * returned, so every live test could reach the prompt only INDIRECTLY, by
   * withholding a capability and inferring the branch from the answer.
   *
   * A caller passing a recording wrapper around the real adapter can assert on
   * the request itself. This is not a new capability: it is the same dependency
   * the driver already constructs, made injectable.
   */
  adapter?: ModelAdapter;
  /**
   * Run with NO write path at all (T2).
   *
   * **This exists because a live test claimed a condition the driver could not
   * produce.** `runSessionTask` loop-injects `propose_edit` whenever an
   * `editHost` is present — ignoring `scenario.tools`, exactly as the
   * `run_script` note below describes — and this driver always passed one. So
   * `envelope.editPolicy` was never `undefined`, and the system-prompt branch
   * that names the quick actions (`session/prompt.ts`) never fired under any
   * eval. D4's live row L1 was written to drive precisely that branch, and its
   * own comment named the hazard: *"Offering `propose_edit` here would take the
   * other branch and the test would pass for the wrong reason."* It did.
   *
   * With this set, no `editHost` is passed, `propose_edit` is not injected, and
   * the read-only branch is reachable — so the assertion can fail again.
   */
  readOnly?: boolean;
  /**
   * Writing Skills to hand the task (E1).
   *
   * **The same justification as `readOnly` above, and the same shape.** The
   * live tier's job is response verification, and E1's whole claim is about
   * what a model does when it is handed a ROUTER body — whether it takes the
   * second hop into `references/` or answers from the router's preamble as
   * though it had. That behaviour is unreachable from an eval unless the
   * driver can load skills, and this is not new capability: `runSessionTask`
   * already takes `skills`, it was simply not reachable from here.
   */
  skills?: Skill[];
  /**
   * The panel's reviewers, one binding each — and the cross-review's (R9,
   * ADR 0069 §D9).
   *
   * The extension resolves these from the Models tab; the CLI takes them
   * directly, so `lemmaria eval` and the live tier can run a MIXED panel over
   * the same seam the product drives rather than a second one written for
   * measurement. An empty `reviewers` is "no opinion", not zero reviewers: the
   * harness's own default answers it.
   *
   * Each binding gets `createModelAdapter(binding.protocol)` — unless the
   * caller injected an `adapter` above, which is this run's adapter for every
   * child as much as for the parent, and is what keeps a mixed panel
   * assertable offline.
   */
  reviewers?: ModelBinding[];
  synthesis?: ModelBinding;
  /**
   * V1 (ADR 0076 §5): the verifier's binding, or `"off"`. Absent means the
   * cross-review's, exactly as in the product. There is no `--verifier` flag,
   * as there is none for `reviewers` or `synthesis`: the live tier is
   * programmatic.
   */
  verifier?: ModelBinding | "off";
  /**
   * V1: the adapter for the VERIFIER's role only — the seam the live tier's
   * verifier row needs, where the reviewers are scripted through `adapter`
   * and the verifier alone is a real model. Nothing under `src/` sets it, and
   * it does not change what counts as offline: a caller that passes a live
   * adapter here is the live tier, and says so.
   */
  verifierAdapter?: ModelAdapter;
  /**
   * V4 (ADR 0081 §8): the PDF reviewer's binding, or `"off"`. Absent means
   * the parent's — the product's *Same as Writing*. It runs on the injected
   * `adapter` when there is one, like every role.
   */
  pdfReviewer?: ModelBinding | "off";
  /**
   * V4 (ADR 0081 §2): the venue the PDF's facts are stated against — what the
   * extension matches from the entry's class, and what a fixture's manifest
   * names here.
   */
  venue?: ReviewVenue;
  /**
   * The per-field budget CEILING for this run (the operator's tuning runs, and
   * `--max-turns` / `--max-tool-calls` / `--max-output-tokens`).
   *
   * **Named `ceilings`, and passed to `runSessionTask` as `ceilings`, because
   * the alternative silently did the opposite of what it advertised** (the
   * review round's F2). It used to be `budget`, which `runSessionTask` treats
   * as an *action's request* — `resolveTaskBudget` clamps that **down** from
   * the ceiling and can never raise it — so `--max-tool-calls 60` resolved to
   * `min(24, 60) = 24` and `EVAL_USAGE`'s offer to *"raise the budget for a
   * large repo"* was unreachable. The tell the gate caught was a
   * `budget.tool_calls` notice firing at 23 of a requested 60.
   *
   * It also cost R5 its own live rows: `planted-defects.live.test.ts` passed
   * `{maxOutputTokens: 24_000}` here, and every recorded panel ran at the
   * default 16,000 — a **5,333**-token carve per seat at N = 3, not the 8,000
   * the test, the plan and ADR 0070 all state.
   *
   * Invariant 5 is untouched: it governs what an *action* may request ("clamped
   * down to the user + global ceilings, never up"), and the operator driving
   * `lemmaria eval` is the user setting the ceiling, which is exactly the role
   * `ceilings` exists for — it raises OR lowers, per field, from the default.
   */
  ceilings?: {
    maxTurns?: number;
    maxToolCalls?: number;
    maxOutputTokens?: number;
  };
}

export interface EvalRunOptions extends EvalTaskOptions {
  scenario: FlagshipScenario;
  /**
   * Keep the working copy even when the run PASSES (the flagship gate's round 2).
   *
   * I4 gave evidence scenarios their transcripts back, and left the three
   * flagship scenarios deleting theirs — so `tests/r5/3-live-flagship-gate`'s
   * B2–B4, *"read the Method section the run wrote … judge the prose"*, had no
   * prose to read on exactly the runs that passed. The documented workaround was
   * to force a failure with a small `--max-turns`, which hands the operator a
   * DIFFERENT, truncated run's passage (411 output tokens and an empty Method
   * section, when the reviewer measured it).
   *
   * Set by the CLI for every live run and by nothing else, so a green
   * `pnpm test` still leaves no copy of the paper behind.
   */
  keepWorkDir?: boolean;
  /**
   * Ground truth for a scenario that MEASURES the panel (R5, ADR 0070).
   *
   * Handed to the judge rather than read by the driver: the driver's job is to
   * run the task, and what a manifest means is the scenario's. The three
   * flagship judges ignore it.
   */
  manifest?: DefectManifest | VisualManifest;
}

/** One completed run, before anyone judges it. */
export interface EvalTaskResult {
  outcome: EvalOutcome;
  turns: number;
  toolCalls: number;
  usage?: Usage;
  /**
   * The temp working copy. `runEvalTask` NEVER removes it — the caller decides,
   * because whether to keep the evidence depends on whether the run passed, and
   * only the caller knows that.
   */
  workDir: string;
  model: string;
  /**
   * The session this run wrote (T2). Without it a caller wanting the persisted
   * event stream — per-turn usage, which the item list cannot give — had to
   * guess the filename by listing `<workDir>/sessions`.
   */
  sessionId: string;
  /**
   * What happened about the PDF (V3, ADR 0080), for a scenario that wanted
   * one. Absent for every scenario that does not name `view_pdf_pages`.
   */
  pdf?: {
    source?: ReviewPdfSource;
    reason?: string;
    /** Why the tool was not offered, when it was not. */
    withheld?: "model_has_no_image_input" | "no_renderer";
    /** Every page the model was shown, in call order. */
    viewed: number[];
    /** V4 (ADR 0081 §1): what the review measured about the PDF, when a
     *  review read one. */
    facts?: PdfFacts;
  };
}

export interface EvalReport {
  scenario: string;
  title: string;
  model: string;
  status: EvalOutcome["status"];
  verdict: JudgeVerdict;
  turns: number;
  toolCalls: number;
  /**
   * The run's work happened in CHILD sessions, so `turns` and `toolCalls` are
   * not a measure of it (the review round's I6).
   *
   * A panel discards its seats' transcripts (ADR 0061 §7) and `runEvalTask`
   * counts `turn.started` on the outer session, which does none — so every
   * `--scenario planted-defects` run printed `turns=0 tools=0`, including a
   * 63-second flagship panel that ran literature searches and emitted 10,090
   * output tokens. Two zeros beside a real `out=` figure read as a run that
   * did nothing. The numbers stay in `--json` because they are true of the
   * outer session; the formatter prints `n/a` instead of implying they are the
   * run's.
   */
  delegated?: true;
  usage?: Usage;
  /** Honest engine stops (budget, context, truncation, model floor). */
  notices: string[];
  /**
   * The working copy, and `undefined` once it has been cleaned up.
   *
   * KEPT for a failing run so it can be inspected, removed for a passing one —
   * a green `pnpm test` should not leak a full copy of the paper per scenario
   * (review, Important 6) — **except on an evidence scenario, which keeps it
   * either way** (the review round's I4).
   *
   * An evidence run's verdict is `pass` by construction whenever the task
   * completes (every recall check is reported, not gated — ADR 0070 §5), so the
   * old rule deleted the transcript of **every paid measurement** and kept only
   * the runs that produced no number. A 14/16 could then not be audited after
   * the fact: which concern earned which hit, whether one concern was credited
   * twice, whether a hit came through a claim anchor or an evidence anchor. For
   * an instrument whose whole output is a figure that goes into a durable
   * record, the supporting evidence is the one thing that must survive.
   */
  workDir?: string;
  error?: string;
}

/** Workspace-relative paths under `dir` (no contents — `list_files` needs none). */
async function listTree(dir: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (abs: string): Promise<void> => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(abs, entry.name);
      // Symlinks are neither isDirectory() nor isFile() here, so they are
      // skipped and the walk cannot loop.
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile())
        paths.push(relative(dir, child).split(sep).join("/"));
    }
  };
  await walk(dir);
  return paths;
}

/** Text files under `dir`, for the judges. Binaries are skipped by extension. */
async function readTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const rel of await listTree(dir)) {
    // readFile(…, "utf8") does NOT throw on binary — it returns mojibake — so
    // the filter has to be by extension, or a .png would reach the judges as
    // garbage prose (review, Minor 13).
    if (!/\.(tex|bib|md|txt|csv|tsv|json|ya?ml|cls|sty)$/i.test(rel)) continue;
    try {
      files.set(rel, await readFile(join(dir, ...rel.split("/")), "utf8"));
    } catch {
      // vanished or unreadable — not something a judge reads
    }
  }
  return files;
}

/**
 * An edit host that accepts everything, into the temp copy.
 *
 * Auto-accept is the right policy for an eval — the point is to measure what
 * the agent produces, not to sit at an approval prompt — and it is exactly the
 * `auto_apply` policy ADR 0016 already defines, not a bypass of invariant 3.
 */
function evalEditHost(root: string): SessionEditHost {
  return {
    policy: () => "auto_apply",
    async readFile(file) {
      try {
        return await readFile(resolve(root, file), "utf8");
      } catch {
        return undefined;
      }
    },
    async writeFile(file, content) {
      const target = resolve(root, file);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    },
    async fileExists(file) {
      try {
        await readFile(resolve(root, file), "utf8");
        return true;
      } catch {
        return false;
      }
    },
    // No checkpoint: the working copy IS the safety net (ADR 0031 removed the
    // git-stash checkpoint hook from the contract entirely).
    async requestDecisions(item: EditProposalItem) {
      return item.edits.map<EditDecision>(() => ({ accept: true }));
    },
  };
}

/** The `LEMMARIA_SMOKE_*` variable names for a protocol (the M1/S4 convention). */
function smokeEnvNames(protocol: Protocol): { key: string; endpoint: string } {
  return protocol === "anthropic"
    ? {
        key: "LEMMARIA_SMOKE_ANTHROPIC_KEY",
        endpoint: "LEMMARIA_SMOKE_ANTHROPIC_ENDPOINT",
      }
    : {
        key: "LEMMARIA_SMOKE_OPENAI_KEY",
        endpoint: "LEMMARIA_SMOKE_OPENAI_ENDPOINT",
      };
}

/**
 * A live binding from the smoke env keys.
 *
 * The endpoint variable is an **override, not a requirement**: it falls back to
 * the provider preset's `defaultEndpoint`. This matters because the OpenAI SDK
 * receives whatever we pass as `baseURL`, and `""` is not `undefined` — so an
 * unset variable used to produce a binding whose failure looked exactly like a
 * model failure. Anthropic's preset carries `""` ON PURPOSE (its own SDK
 * supplies the default), which is why the fallback is per-preset rather than a
 * blanket "endpoint required" rule.
 */
/**
 * The binding an OFFLINE run reports: no key, no endpoint, and a model id that
 * names the protocol's default rather than inventing one.
 *
 * Hoisted out of `runEvalTask` because two paths need the same literal — a
 * `--stub` run and a run whose caller injected its own adapter (the review
 * round's F12, below).
 */
const STUB_BINDING: ModelBinding = {
  protocol: "anthropic",
  endpoint: "",
  model: "claude-sonnet-4-5",
  apiKey: "stub",
};

export function liveBinding(protocol: Protocol, model: string): ModelBinding {
  const names = smokeEnvNames(protocol);
  const key = process.env[names.key];
  if (!key) {
    throw new Error(
      `no API key: set ${names.key} (or pass --stub to run offline)`,
    );
  }
  const preset = PROVIDER_PRESETS.find((p) => p.protocol === protocol);
  if (!preset) {
    throw new Error(
      `no provider preset for protocol "${protocol}": cannot resolve a default endpoint, set ${names.endpoint}`,
    );
  }
  // `||` not `??`: an env var set to the empty string means "unset" here.
  const endpoint = process.env[names.endpoint] || preset.defaultEndpoint;
  return { protocol, endpoint, model, apiKey: key };
}

/**
 * What a live run binds to when the caller names nothing.
 *
 * **OpenAI-compatible since 2026-09-17, by operator decision.** It was
 * `anthropic` / `claude-sonnet-4-5`; the build machine exports an anthropic key
 * with no credit, so a bare `lemmaria eval` failed on billing before it said
 * anything about the scenario. The model is the live tier's cheap pin — the one
 * id the provisioned key is known to serve — by value, because `src/` cannot
 * import test code; `live-binding.test.ts` asserts the two stay equal.
 */
export const DEFAULT_LIVE_PROTOCOL: Protocol = "openai-compatible";
export const DEFAULT_LIVE_MODEL = "gpt-5.6-luna";

/**
 * The binding a run reports and authenticates with.
 *
 * Not one `??` chain: `--stub` wins over an explicit `binding` ON PURPOSE —
 * `--stub --model X` reports the stub model, which is recorded as verified
 * behaviour in `tests/r5/4-flagship-recall/NOTES.md`. What F12 changes is only
 * the LAST resort: with an adapter injected there is nothing to authenticate,
 * so the fallback is the stub binding rather than a throw.
 */
export function resolveRunBinding(
  opts: Pick<EvalTaskOptions, "stub" | "binding" | "adapter">,
): ModelBinding {
  if (opts.stub) return STUB_BINDING;
  if (opts.binding) return opts.binding;
  if (opts.adapter !== undefined) return STUB_BINDING;
  return liveBinding(DEFAULT_LIVE_PROTOCOL, DEFAULT_LIVE_MODEL);
}

export async function runEvalTask(
  opts: EvalTaskOptions,
): Promise<EvalTaskResult> {
  const { scenario } = opts;
  for (const id of scenario.requiredGrants) {
    if (!opts.grants.has(id)) {
      throw new Error(
        `scenario "${scenario.id}" needs --grant ${id}=<path>; refusing to evaluate it without one`,
      );
    }
  }

  // Never touch the caller's paper.
  const work = await mkdtemp(join(tmpdir(), "lemmaria-eval-"));
  const paper = join(work, "paper");
  // `preserveTimestamps` (V3, ADR 0080 §8): without it the copy gives every
  // file the same "now", and a fixture's committed PDF would read as exactly
  // as fresh as its .tex by accident rather than by fact — which would make
  // the freshness policy untestable here.
  await cp(opts.paperDir, paper, { recursive: true, preserveTimestamps: true });
  const store = new SessionStore(join(work, "sessions"));
  const session = await store.create({
    title: `eval:${scenario.id}`,
    workspace: paper,
  });

  const grants: GrantedRoot[] = [...opts.grants].map(([id, path]) => ({
    id,
    path: canonicalizeGrantRoot(path),
    label: id,
  }));
  const getGrants = () => grants;

  // R3 (ADR 0061): the same reader the tools serve, handed to the review panel
  // as well. `/review` locates every anchor in the manuscript's own bytes, so
  // it needs a workspace port of its own — and it must be THIS one, or an eval
  // would locate against a different copy than the one its seats read.
  const evalWorkspace = {
    root: paper,
    readFile: (rel: string) => readFile(resolve(paper, rel), "utf8"),
    listFiles: async () => listTree(paper),
    // V3 (ADR 0080 §8): the two optional Workspace members the PDF policy
    // reads. Root-contained through the same guard the other hosts use.
    stat: async (
      rel: string,
    ): Promise<{ mtimeMs: number; size: number } | undefined> => {
      assertWorkspaceRelative(rel);
      try {
        const s = await stat(resolve(paper, rel));
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return undefined;
      }
    },
    readBinary: async (rel: string): Promise<Uint8Array> => {
      assertWorkspaceRelative(rel);
      return new Uint8Array(await readFile(resolve(paper, rel)));
    },
  };

  // **An injected adapter is as offline as `--stub`** (the review round's F12).
  //
  // A caller that hands the driver its own adapter makes no model call, so it
  // needs no key and no live provider — but both were gated on `opts.stub`
  // alone, and the consequences were one visible and one latent:
  //
  // - `liveBinding("anthropic", …)` THREW for want of a key it would never use,
  //   so `pnpm test` — the milestone gate — failed on any machine without
  //   `LEMMARIA_SMOKE_ANTHROPIC_KEY` exported. Four offline tests in
  //   `planted-defects-scenario.test.ts` inject a scripted panel with
  //   `stub: false`, which is the whole point of them.
  // - the literature seam built the four REAL scholarly providers, and
  //   `planted-defects` carries `literature_search` — so a scripted panel that
  //   searched would have reached the network from inside the offline tier.
  //
  // ADR 0035's offline tier is supposed to be offline BY CONSTRUCTION; this is
  // the construction. `offline-by-construction.test.ts` is the guard.
  const offline = opts.stub || opts.adapter !== undefined;

  // V2 (ADR 0078 §5): one holder per task, handed to the registry AND to the
  // task, so the review driver fills the same object `literature_search`
  // reads — the extension's own wiring, one host over.
  const literatureWithhold: LiteratureWithhold = { titles: [] };

  const registry = buildToolRegistry({
    tools: scenario.tools,
    adapter: {
      countWords: () => ({ language: "en", unit: "words", count: 0 }),
    },
    glossary: [],
    outline: [],
    workspace: evalWorkspace,
    defaultFile: "main.tex",
    protectedSpans: protectedSpansForFile,
    grants: getGrants,
    ...(scenario.tools.includes("literature_search")
      ? {
          literature: {
            // The ADR 0019 provider seam: scripted offline (never the network),
            // the real scholarly set when the operator runs it live.
            //
            // V2 (ADR 0078 §D13): INJECTED providers win over both, whatever
            // else is set. A caller that supplies its own is by construction
            // not reaching the network, which is the same argument the
            // `offline` flag above makes for an injected adapter — and it is
            // what lets a test drive the withholding guard end to end without
            // asking a real index anything.
            providers:
              opts.literatureProviders ??
              (offline
                ? stubLiteratureProviders()
                : [
                    crossrefLiterature(),
                    dblpLiterature(),
                    arxivLiterature(),
                    semanticScholarLiterature(),
                  ]),
            withhold: literatureWithhold,
          },
        }
      : {}),
  });

  const binding = resolveRunBinding(opts);
  const model: ModelAdapter =
    opts.adapter ??
    (opts.stub
      ? new ScriptedModelAdapter(stubTurnsFor(scenario.id))
      : createModelAdapter(binding.protocol));

  // R9 (§D9): one child model per configured role. Built here rather than in
  // the options literal below so the `adapter` override reads once.
  const childModel = (b: ModelBinding): ChildModel => ({
    adapter: opts.adapter ?? createModelAdapter(b.protocol),
    binding: b,
  });
  const verifier = opts.verifier;
  const pdfReviewer = opts.pdfReviewer;
  const reviewPanel =
    opts.reviewers !== undefined ||
    opts.synthesis !== undefined ||
    verifier !== undefined ||
    pdfReviewer !== undefined
      ? {
          reviewers: (opts.reviewers ?? []).map((b) => ({
            model: childModel(b),
          })),
          ...(opts.synthesis ? { synthesis: childModel(opts.synthesis) } : {}),
          // V1 (ADR 0076 §5): Off passes through; a binding runs on the
          // role's own adapter when the caller handed one.
          ...(verifier === "off"
            ? { verifier: "off" as const }
            : verifier !== undefined
              ? {
                  verifier: {
                    ...childModel(verifier),
                    ...(opts.verifierAdapter
                      ? { adapter: opts.verifierAdapter }
                      : {}),
                  },
                }
              : {}),
          // V4 (ADR 0081 §8): Off passes through; a binding runs on the
          // run's adapter, like every role.
          ...(pdfReviewer === "off"
            ? { pdfReviewer: "off" as const }
            : pdfReviewer !== undefined
              ? { pdfReviewer: childModel(pdfReviewer) }
              : {}),
        }
      : undefined;

  // V4 (ADR 0081 §2): what a review needs to see the compiled paper — built
  // for every `/review` and `/review-pdf` when there is a renderer, and for
  // nothing else. No `compile`: a fixture ships its PDF, and an eval measures
  // the review, not the toolchain (`pdf_unavailable / stale` is the honest
  // reading if a copy ever loses its timestamps).
  const reviewPdf: ReviewPdfDeps | undefined =
    opts.pdfRenderer && /^\s*\/review/.test(scenario.prompt)
      ? {
          renderer: opts.pdfRenderer,
          compileLog: (log, entryFile) =>
            parseCompileLog(log, { source: "latexmk", entryFile }),
          ...(opts.venue ? { venue: opts.venue } : {}),
        }
      : undefined;

  // --- the visual door (V3, ADR 0080) --------------------------------------
  //
  // A scenario that names `view_pdf_pages` gets it here: the eval owns its
  // registry, resolves the PDF through the same policy the V4 review driver
  // uses, and hands the tool an opened document. (A review's PDF reviewer is
  // handed its own by the driver — `reviewPdf` below — never this one.) Both
  // locks apply here as they do there — the tool is withheld for a binding
  // that cannot see, and the adapters drop the blocks at the wire.
  let pdfReport: EvalTaskResult["pdf"];
  let pdfDocument: Awaited<ReturnType<PdfRenderer>> | undefined;
  let pdfTool: ViewPdfPagesTool | undefined;
  let allowedTools = scenario.tools as ToolName[];

  // ONE way to take the door away, so the four reasons below cannot drift
  // apart — and so V4's driver copies a helper rather than whichever inline
  // `filter` it happens to read first. `withholdImageTools` is the harness's
  // own rule and knows which tools bear images; this never names one.
  const withholdTheDoor = (): void => {
    allowedTools = withholdImageTools(allowedTools, {
      model: binding.model,
      imageInput: false,
    });
  };

  if (scenario.tools.includes("view_pdf_pages")) {
    if (!opts.pdfRenderer) {
      pdfReport = { withheld: "no_renderer", viewed: [] };
      withholdTheDoor();
    } else if (!canSeeImages(binding)) {
      pdfReport = { withheld: "model_has_no_image_input", viewed: [] };
      withholdTheDoor();
    } else {
      const graph = await manuscriptGraphFor("main.tex", (rel) =>
        readFile(resolve(paper, rel), "utf8"),
      );
      const resolved = await resolveReviewPdf({
        entry: "main.tex",
        files: graph?.files ?? ["main.tex"],
        stat: evalWorkspace.stat,
        readBinary: evalWorkspace.readBinary,
        // No `compile`: an eval measures the door, not the toolchain, and a
        // fixture ships its own PDF.
      });
      if (!resolved.ok) {
        pdfReport = { reason: resolved.reason, viewed: [] };
        withholdTheDoor();
      } else {
        pdfDocument = await opts.pdfRenderer(resolved.bytes);
        if (!pdfDocument) {
          pdfReport = { reason: "render_failed", viewed: [] };
          withholdTheDoor();
        } else {
          pdfTool = createViewPdfPagesTool({ document: pdfDocument });
          registry.set("view_pdf_pages", pdfTool.executor);
          pdfReport = { source: resolved.source, viewed: [] };
        }
      }
    }
  }

  try {
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: scenario.prompt,
      registry,
      allowedTools,
      grants: getGrants,
      // V2 (ADR 0078 §5): the same holder the registry above closes over.
      literatureWithhold,
      // Omitted under `readOnly`, which is what makes the no-write-path branch of
      // the system prompt reachable at all — see the option's doc comment.
      ...(opts.readOnly ? {} : { editHost: evalEditHost(paper) }),
      // E1: when present, `load_skill` is offered and the envelope declares the
      // catalogue. `runSessionTask` gates the tool on this being non-empty, so
      // an eval that passes none is byte-identical to one written before E1.
      ...(opts.skills && opts.skills.length > 0 ? { skills: opts.skills } : {}),
      // D1 (ADR 0032): the eval drives what production drives, protections
      // included — an eval that measured an unguarded write path would be
      // measuring something the user never runs.
      protectedSpans: protectedSpansForFile,
      // NO scriptHost, deliberately (review, Critical 1). `runSessionTask` unions
      // `run_script` into the allowlist whenever a scriptHost + grants exist,
      // IGNORING the caller's `allowedTools` — so passing one here would have
      // offered the model an auto-approved `run_script` that no scenario asked
      // for, running with cwd = the operator's REAL granted directory (grants are
      // canonicalized, never copied; only --paper is). An eval must not be able
      // to execute anything in the tree it is measuring.
      ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
      // R3 (ADR 0061): so `runEvalTask({prompt: "/review"})` reaches the panel
      // driver. `defaultFile` above is the registry's; the entry the panel
      // locates bare anchors against is the same file, named explicitly rather
      // than rediscovered — an eval's fixture is known, not guessed.
      workspace: evalWorkspace,
      paperEntry: "main.tex",
      // X5 (ADR 0074 §4): the same reader the extension wires, so an eval reads
      // the fixture's include graph rather than every file in the copied dir.
      // Without it every eval panel would raise `review.manuscript_unresolved`,
      // which is the deny-by-default the notice exists for.
      manuscriptGraph: manuscriptGraphFor,
      // R9 (§D9): omitted entirely when the caller said nothing, so every eval
      // written before this milestone runs byte-identically.
      ...(reviewPanel ? { reviewPanel } : {}),
      ...(reviewPdf ? { reviewPdf } : {}),
    });

    const outcome: EvalOutcome = {
      status: result.status,
      items: result.items,
      files: await readTree(paper),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };

    // Read the honest turn count from the persisted stream BEFORE any cleanup —
    // `agent_message` count is not a turn count (a tool-only turn emits none).
    const turns = (await store.load(session.id)).entries.filter(
      (e) => e.event.type === "turn.started",
    ).length;

    if (pdfReport && pdfTool) {
      pdfReport = { ...pdfReport, viewed: [...pdfTool.viewed] };
    }
    // V4: a review reports what ITS PDF reviewer saw — the record the driver
    // wrote, read back rather than re-derived.
    if (reviewPdf) pdfReport = reviewPdfReport(result.items) ?? pdfReport;

    return {
      outcome,
      turns,
      toolCalls: result.items.filter((i) => i.type === "tool_call").length,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      workDir: work,
      model: binding.model,
      sessionId: session.id,
      ...(pdfReport ? { pdf: pdfReport } : {}),
    };
  } finally {
    // The document holds native handles; close it whatever the run did.
    pdfDocument?.close();
  }
}

/**
 * The PDF half of a review's record, in the V3 report's shape (V4): where the
 * PDF came from, the pages viewed, the facts — or why none was read. Absent
 * when the run held no review.
 */
function reviewPdfReport(
  items: readonly SessionItem[],
): EvalTaskResult["pdf"] | undefined {
  const item = [...items]
    .reverse()
    .find((i): i is ReviewItem => i.type === "review");
  if (item === undefined) return undefined;
  const limits = item.result?.limits ?? [];
  const visual = limits.find((l) => l.kind === "visual_unavailable");
  const unavailable = limits.find((l) => l.kind === "pdf_unavailable");
  return {
    ...(item.pdf ? { source: item.pdf.source, facts: item.pdf.facts } : {}),
    ...(visual?.kind === "visual_unavailable"
      ? { withheld: visual.reason }
      : {}),
    ...(unavailable?.kind === "pdf_unavailable"
      ? { reason: unavailable.reason }
      : {}),
    viewed: item.pdf?.viewed ?? [],
  };
}

export async function runFlagshipEval(
  opts: EvalRunOptions,
): Promise<EvalReport> {
  // V4: a visual manifest names the venue the facts are stated against.
  const venue =
    opts.venue ??
    (opts.manifest !== undefined && "venue" in opts.manifest
      ? opts.manifest.venue
      : undefined);
  const task = await runEvalTask({ ...opts, ...(venue ? { venue } : {}) });
  const verdict = opts.scenario.judge(task.outcome, opts.manifest);

  // Keep the evidence when there is something to look at; otherwise clean up.
  // A green `pnpm test` should not leak a full copy of the paper per scenario.
  //
  // An EVIDENCE run is always something to look at: its verdict cannot fail on
  // the number it produced, so "pass" never meant "nothing to inspect" here —
  // see `EvalReport.workDir` for what that cost (I4). A run the OPERATOR drove
  // is the same case for a different reason: the prose it wrote is the thing
  // they are judging, and a pass is when they most want to read it
  // (`keepWorkDir`).
  const keep =
    evidenceScenario(opts.scenario) !== undefined || opts.keepWorkDir === true;
  let workDir: string | undefined = task.workDir;
  if (!keep && verdict.pass && task.outcome.status === "completed") {
    try {
      await rm(task.workDir, { recursive: true, force: true });
      workDir = undefined;
    } catch {
      // A locked file on Windows is not a reason to fail an eval.
    }
  }

  return {
    scenario: opts.scenario.id,
    title: opts.scenario.title,
    model: task.model,
    status: task.outcome.status,
    verdict,
    turns: task.turns,
    toolCalls: task.toolCalls,
    // A panel's work is its seats', and the outer session takes no turn of its
    // own — so say so rather than printing two zeros (I6).
    ...(task.outcome.items.some((i) => i.type === "review")
      ? { delegated: true as const }
      : {}),
    ...(task.usage !== undefined ? { usage: task.usage } : {}),
    notices: task.outcome.items
      .filter((i) => i.type === "notice")
      .map((i) => (i.type === "notice" ? i.code : "")),
    ...(workDir !== undefined ? { workDir } : {}),
    ...(task.outcome.error !== undefined ? { error: task.outcome.error } : {}),
  };
}

/**
 * The S4-style summary line: one row per scenario, judgement first.
 *
 * Two figures the review round found missing from it. The turn and tool-call
 * counts read `n/a` on a delegated run rather than `0` (I6 — see
 * `EvalReport.delegated`); and the **cost** is printed whenever there is usage
 * at all — as `$unpriced` when the model id carries no price (N5) — because the
 * live tier printed `usage=6396out/$0.0750` while the one path where an operator
 * spends their own flagship money printed no cost at all. The work dir is
 * printed when one was kept, with the line that removes it, so the evidence
 * behind the figures is findable without listing the temp directory (I4).
 */
export function formatEvalReport(report: EvalReport): string {
  const turns = report.delegated ? "n/a" : String(report.turns);
  const tools = report.delegated ? "n/a" : String(report.toolCalls);
  // An unpriced model id is SAID, not left as silence (the recall round's N5):
  // the flagship panel printed `out=9129` with no `$` and the operator had no
  // way to tell "this run was free" from "nobody knows what this run cost".
  const cost =
    report.usage?.costUsd === undefined
      ? "/$unpriced"
      : `/$${report.usage.costUsd.toFixed(4)}`;
  const head = `${report.verdict.pass ? "PASS" : "FAIL"}  ${report.scenario.padEnd(28)} ${report.model}  turns=${turns} tools=${tools}${
    report.usage ? ` out=${report.usage.outputTokens}${cost}` : ""
  }`;
  const checks = report.verdict.checks.map(
    (c) =>
      `    ${c.pass ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`,
  );
  const notices =
    report.notices.length > 0
      ? [`    notices: ${report.notices.join(", ")}`]
      : [];
  const evidence =
    report.workDir !== undefined
      ? [
          `    work dir: ${report.workDir}`,
          // `scripts/test-manual.mjs`'s idiom: a kept directory names the one
          // line that removes it, so "keep the evidence" does not mean "leak".
          `    when done: rm -rf "${report.workDir}"`,
        ]
      : [];
  return [head, ...checks, ...notices, ...evidence].join("\n");
}
