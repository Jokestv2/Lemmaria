/**
 * The action engine — lifecycle steps 1–8 for the L0 and L1 tiers (single
 * generate call, or the bounded tool loop in tier.ts). Emits EditProposals;
 * presenting the diff, Accept, and recording (steps 9–11) belong to the host
 * (M4/M5). Nothing verifies after an Accept — X1 deleted that step (ADR 0013:
 * a compile is a report the user asks for, never a gate on an edit).
 * The L2 agent loop lands post-MVP; review at M9.
 */

import { checkRequires } from "../actions/loader.js";
import type {
  ActionContext,
  ActionDefinition,
  BudgetCeilings,
  EditProposal,
  TierResult,
  ValidatorOutcome,
} from "../contracts/actions.js";
import type {
  ChatMessage,
  DocumentAdapter,
  ModelAdapter,
  ModelBinding,
  SourceSpan,
  Workspace,
} from "../contracts/adapters.js";
import type { ReviewResult } from "../contracts/data.js";
import { locateAnchor, parseAnchoredEdit } from "./anchored-edit.js";
import { DEFAULT_BUDGET_CEILINGS, resolveBudget } from "./budget.js";
import { buildContext } from "./context.js";
import { ActionEngineError } from "./errors.js";
import type { MemoryInput } from "./memory.js";
import { resolveParams } from "./params.js";
import { interpretAnnotations } from "./review.js";
import { thawText } from "./spans.js";
import { renderTemplate } from "./template.js";
import {
  type TierOptions,
  type TierUsage,
  runL0Tier,
  runL1Tier,
} from "./tier.js";
import { type CitationToolData, buildToolRegistry } from "./tools.js";
import { type ValidatorContext, runValidators } from "./validators.js";

export interface RunActionOptions {
  action: ActionDefinition;
  adapter: DocumentAdapter;
  workspace: Workspace;
  model: ModelAdapter;
  binding: ModelBinding;
  selection: SourceSpan;
  params?: Record<string, unknown>;
  ceilings?: Partial<BudgetCeilings>;
  /** Content of the project's PAPER.md, when the host found one. Alias for
   *  `memory.project`; ignored when `memory` is supplied (M4-era option). */
  paperMd?: string;
  /** CM1 layered memory (M8): raw contents of the user-global MEMORY.md, the
   *  project PAPER.md, and the nearest directory-level PAPER.md. Nearest scope
   *  wins on conflict (see engine/memory.ts). */
  memory?: MemoryInput;
  harnessVersion?: string;
  /** Retry(+note) from the diff review: appended as a final user message so the
   *  re-run can honor it (product-design Quick Actions). */
  userFeedback?: string;
  /** Host cancellation (e.g. the progress toast's Cancel). Combined with the
   *  action's own `timeout_s`; either firing aborts the run (stoppedBy error). */
  signal?: AbortSignal;
  /** Citation data + optional C2 sources for the `citation_check`/`list_citations`
   *  L1 tools (M7). Host-injected (the host owns bib extraction + the C2 network
   *  policy); absent ⇒ those tools are omitted from the registry. */
  citations?: CitationToolData;
}

export interface RunActionResult extends TierResult {
  context: ActionContext;
  templateWarnings: string[];
}

export async function runAction(
  opts: RunActionOptions,
): Promise<RunActionResult> {
  const { action, adapter, workspace, model, binding, selection } = opts;

  // 1 — Resolve: requires + tier/kind support.
  const unmet = checkRequires(action, {
    ...(opts.harnessVersion !== undefined
      ? { harnessVersion: opts.harnessVersion }
      : {}),
    docKind: adapter.kind,
  });
  if (unmet.length > 0) {
    throw new ActionEngineError(
      "requires_unmet",
      `action "${action.id}" is disabled: ${unmet.join("; ")}`,
    );
  }
  const level = action.routing?.level ?? "L0";
  if (level === "L2" || level === "auto") {
    throw new ActionEngineError(
      "unsupported_level",
      `routing.level ${level}: the L2 agent loop lands post-MVP`,
    );
  }
  const contract =
    action.output?.contract ??
    (action.kind === "review" ? "annotations" : "replace_selection");
  if (action.kind === "review") {
    if ((action.model?.fan_out ?? []).length > 0) {
      throw new ActionEngineError(
        "unsupported_kind",
        "model.fan_out: cross-review lands post-MVP — single-model review only",
      );
    }
    if (contract !== "annotations") {
      throw new ActionEngineError(
        "unsupported_contract",
        'kind review emits only the "annotations" output contract (ADR 0008)',
      );
    }
  } else if (
    action.kind === "generate" ||
    (contract !== "replace_selection" && contract !== "replace_anchor")
  ) {
    throw new ActionEngineError(
      "unsupported_contract",
      "insert/new_file output contracts land post-MVP",
    );
  }

  // 2 — Acquire inputs: parameters.
  const { params, errors } = resolveParams(action, opts.params ?? {});
  if (errors.length > 0) {
    throw new ActionEngineError("params_invalid", errors.join("; "));
  }

  // 2–3 — Acquire inputs (scope) + build context.
  const memory =
    opts.memory ??
    (opts.paperMd !== undefined ? { project: opts.paperMd } : undefined);
  const built = await buildContext({
    action,
    adapter,
    workspace,
    selection,
    params,
    ...(memory !== undefined ? { memory } : {}),
  });

  // 4 — Resolve budget (invariant 5).
  const budget = resolveBudget(action, {
    ...DEFAULT_BUDGET_CEILINGS,
    ...opts.ceilings,
  });

  // 5 — Render prompt.
  const templateWarnings: string[] = [];
  const system = action.prompt.system
    ? renderTemplate(action.prompt.system, built.vars)
    : undefined;
  if (system) templateWarnings.push(...system.warnings);
  const user = renderTemplate(action.prompt.user, built.vars);
  templateWarnings.push(...user.warnings);
  const renderedPrompt = {
    ...(system ? { system: system.text } : {}),
    user: user.text,
  };

  const context: ActionContext = {
    action,
    level,
    docKind: adapter.kind,
    selectionText: built.unit.text,
    params,
    budget,
    renderedPrompt,
  };

  // 6–8 — Route (L0) → Generate → Validate, with retry_with_feedback.
  const validatorCtx: ValidatorContext = {
    countWords: (text) => adapter.countWords(text),
    unitText: built.unit.text,
    currentProseCount: built.wordCount.count,
    frozen: built.frozen,
    protectedSpans: built.protectedSpans,
    knownLabels: built.knownLabels,
    knownCitations: built.knownCitations,
    glossary: built.glossary,
    params,
  };
  const validatorConfigs = action.output?.validators ?? [];
  const strategy =
    action.output?.on_validation_fail?.strategy ?? "retry_with_feedback";
  const maxRetries = action.output?.on_validation_fail?.max_retries ?? 2;

  const messages: ChatMessage[] = [];
  if (renderedPrompt.system)
    messages.push({ role: "system", content: renderedPrompt.system });
  messages.push({ role: "user", content: renderedPrompt.user });
  // `userFeedback` crosses an untrusted host boundary: a VS Code title-bar
  // command can invoke Retry with a non-string positional arg (a URI). Coerce
  // defensively so it never reaches `.trim()` and crashes the run.
  const feedback =
    typeof opts.userFeedback === "string" ? opts.userFeedback : undefined;
  if (feedback !== undefined && feedback.trim() !== "") {
    messages.push({
      role: "user",
      content: `The user reviewed a previous proposal of this edit and asked for this change:\n${feedback}`,
    });
  }

  // The action's own timeout, plus the host's cancellation signal if supplied.
  const timeoutSignal = AbortSignal.timeout(budget.timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const tierOpts: TierOptions = {
    model,
    binding,
    messages,
    budget,
    ...(action.model?.temperature !== undefined
      ? { temperature: action.model.temperature }
      : {}),
    ...(action.routing?.thinking_budget !== undefined
      ? { thinkingBudget: action.routing.thinking_budget }
      : {}),
    signal,
  };
  const registry =
    level === "L1"
      ? buildToolRegistry({
          tools: action.routing?.tools ?? [],
          adapter,
          glossary: built.glossary,
          outline: built.outline,
          workspace,
          defaultFile: built.unit.span.file,
          ...(opts.citations !== undefined
            ? { citations: opts.citations }
            : {}),
        })
      : new Map();
  const allowedTools = action.routing?.tools ?? [];

  const usage: TierUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    iterations: 0,
  };
  let retries = 0;
  let outcomes: ValidatorOutcome[] = [];
  let output = "";
  let stoppedBy: TierResult["stoppedBy"] = "complete";
  let convo = messages;
  // Best emittable candidate across retries: one with NO hard-validator failure,
  // minimizing the summed soft-failure distance. A soft miss (e.g. shrink not
  // hitting the exact target) proposes the closest attempt instead of nothing.
  // For replace_anchor the candidate carries its already-located proposal.
  let best:
    | {
        output: string;
        outcomes: ValidatorOutcome[];
        distance: number;
        proposal?: EditProposal;
        review?: ReviewResult;
      }
    | undefined;
  // The current iteration's located anchored edit (replace_anchor only).
  let anchorProposal: EditProposal | undefined;
  // The current iteration's located annotations (kind review only).
  let reviewCandidate: ReviewResult | undefined;

  // Interpret a review final answer (ADR 0008): parse the JSON annotations,
  // locate each anchor within the reviewed unit, stamp the reviewer, and map
  // failures onto the ordinary retry loop — a shape/enum violation is a hard
  // synthetic "annotations" outcome, dropped (unlocatable) anchors are a soft
  // one whose distance picks the best-located attempt across retries. Review
  // is read-only by construction: no EditProposal, no working copy, and the
  // action's declared output.validators are NOT run (they judge edit text).
  const interpretReview = async (
    answer: string,
  ): Promise<ValidatorOutcome[]> => {
    reviewCandidate = undefined;
    const file = built.unit.span.file;
    // Line numbers come from the full file; if it is unreadable (it was read
    // moments ago for context, so this is near-impossible), fall back to the
    // unit itself WITH a zero offset base so lines stay unit-consistent.
    let fileContent: string;
    let unitStartOffset = built.unit.span.startOffset;
    try {
      fileContent = await workspace.readFile(file);
    } catch {
      fileContent = built.unit.text;
      unitStartOffset = 0;
    }
    const allowedSeverities = (action.review_schema?.severity ?? []).filter(
      (s): s is "info" | "minor" | "major" =>
        s === "info" || s === "minor" || s === "major",
    );
    const out = interpretAnnotations({
      answer,
      unitText: built.unit.text,
      unitStartOffset,
      fileContent,
      file,
      reviewer: action.model?.role ?? "writing",
      ...(action.review_schema?.dimensions !== undefined
        ? { allowedDimensions: action.review_schema.dimensions }
        : {}),
      ...(allowedSeverities.length > 0 ? { allowedSeverities } : {}),
      suggestEdits: action.review_schema?.suggest_edits ?? true,
      thaw: (text) => thawText(text, built.frozen.tokens),
    });
    if (out.failure !== undefined) {
      return [{ type: "annotations", pass: false, reason: out.failure }];
    }
    reviewCandidate = out.result;
    if (out.dropped.length > 0) {
      return [
        {
          type: "annotations",
          pass: false,
          soft: true,
          distance: out.dropped.length,
          reason: `these anchors could not be located verbatim in the reviewed text: ${out.dropped
            .map((d) => JSON.stringify(d))
            .join(", ")}`,
        },
      ];
    }
    return [{ type: "annotations", pass: true }];
  };

  // Interpret a replace_anchor final answer (ADR 0007): parse the JSON edit,
  // locate the unique anchor occurrence, and validate the REPLACEMENT with the
  // anchor as the input basis. Parse/locate failures become a synthetic hard
  // "anchored_edit" outcome so the ordinary retry_with_feedback loop corrects
  // them. NOTE: protected_spans_intact is meaningless under this contract (the
  // answer is JSON, not thawed frozen text) — actions must not declare it.
  const interpretAnchored = async (
    answer: string,
  ): Promise<ValidatorOutcome[]> => {
    anchorProposal = undefined;
    const failed = (reason: string): ValidatorOutcome[] => [
      { type: "anchored_edit", pass: false, reason },
    ];
    const parsed = parseAnchoredEdit(answer);
    if ("error" in parsed) return failed(parsed.error);
    // Thaw defensively: tokens shouldn't appear in a JSON answer, but a model
    // that copied a frozen span from the prompt must not break location.
    const anchor = thawText(parsed.anchor, built.frozen.tokens);
    const replacement = thawText(parsed.replacement, built.frozen.tokens);
    // M8 single-file limit (ADR 0007, recorded): the host's Accept-gated diff
    // renders ONE document, so a cross-file edit would splice foreign offsets
    // into the entry file. Refuse with steering feedback instead of silently
    // proposing against a document the user is not reviewing.
    const file = built.unit.span.file;
    if (parsed.file !== undefined && parsed.file !== file) {
      return failed(
        `cross-file edits are not supported yet — the anchor must be in "${file}" (omit the "file" field)`,
      );
    }
    let content: string;
    try {
      content = await workspace.readFile(file);
    } catch {
      return failed(`file "${file}" cannot be read — use the current file`);
    }
    const located = locateAnchor(content, anchor);
    if ("error" in located) {
      return failed(
        located.error === "not_found"
          ? "the anchor was not found — copy it VERBATIM from the file (use read_span to see the exact text)"
          : "the anchor occurs more than once — extend it with surrounding text until it is unique",
      );
    }
    // Engine-level structure guard (invariant-3 defense-in-depth, unbypassable
    // by action authors — supersedes the M6 document_structure_intact stopgap
    // for anchored edits): splicing the replacement must move each document
    // delimiter count TOWARD 1 (repairing a typo'd/missing/duplicated
    // delimiter), never away from it (dropping the only \end{document},
    // duplicating one). Whole-document semantics — a patch-local count check
    // would wrongly block \begin{doument} → \begin{document}.
    const spliced =
      content.slice(0, located.offset) +
      replacement +
      content.slice(located.offset + anchor.length);
    for (const [label, re] of [
      ["\\begin{document}", /\\begin\{document\}/g],
      ["\\end{document}", /\\end\{document\}/g],
    ] as const) {
      const before = (content.match(re) ?? []).length;
      const after = (spliced.match(re) ?? []).length;
      if (after !== before && Math.abs(after - 1) >= Math.abs(before - 1)) {
        return failed(
          `this edit would corrupt the document: ${label} count ${before} → ${after}`,
        );
      }
    }
    // Located ⇒ there is a proposable span (validators may still veto it via
    // the best-candidate gate; accept_with_warning emits it despite failures).
    anchorProposal = {
      file,
      span: {
        startOffset: located.offset,
        endOffset: located.offset + anchor.length,
      },
      expectedOriginal: anchor,
      replacement,
      contract: "replace_anchor",
    };
    return runValidators(validatorConfigs, replacement, {
      ...validatorCtx,
      unitText: anchor,
      currentProseCount: adapter.countWords(anchor).count,
    });
  };

  for (;;) {
    const tier =
      level === "L1"
        ? await runL1Tier({
            ...tierOpts,
            messages: convo,
            registry,
            allowedTools,
          })
        : await runL0Tier({ ...tierOpts, messages: convo });
    usage.inputTokens += tier.usage.inputTokens;
    usage.outputTokens += tier.usage.outputTokens;
    usage.iterations += tier.usage.iterations;
    usage.costUsd =
      usage.costUsd === undefined || tier.usage.costUsd === undefined
        ? undefined
        : usage.costUsd + tier.usage.costUsd;
    convo = tier.messages;
    output = tier.text;

    outcomes =
      action.kind === "review"
        ? await interpretReview(output)
        : contract === "replace_anchor"
          ? await interpretAnchored(output)
          : runValidators(validatorConfigs, output, validatorCtx);
    if (tier.stoppedBy !== "complete") {
      // Truncated/aborted output must never reach the user as a proposal;
      // retrying with the same budget would truncate again, so stop here.
      stoppedBy = tier.stoppedBy;
      break;
    }
    // Track the best candidate among complete outputs with no hard failure.
    const hardFailedNow = outcomes.filter((o) => !o.pass && o.soft !== true);
    if (
      hardFailedNow.length === 0 &&
      (contract !== "replace_anchor" || anchorProposal !== undefined) &&
      (action.kind !== "review" || reviewCandidate !== undefined)
    ) {
      const softDistance = outcomes
        .filter((o) => !o.pass && o.soft)
        .reduce((sum, o) => sum + (o.distance ?? 1), 0);
      if (best === undefined || softDistance < best.distance) {
        best = {
          output,
          outcomes,
          distance: softDistance,
          ...(anchorProposal !== undefined ? { proposal: anchorProposal } : {}),
          ...(reviewCandidate !== undefined ? { review: reviewCandidate } : {}),
        };
      }
    }
    const failed = outcomes.filter((o) => !o.pass);
    if (
      failed.length === 0 ||
      strategy !== "retry_with_feedback" ||
      retries >= maxRetries
    ) {
      break;
    }
    retries += 1;
    // The final answer is re-appended as a plain assistant turn (no reasoning):
    // it is followed by a user feedback message, never a tool_result, so no
    // signed thinking blocks need echoing here (ADR 0006). Intermediate tool
    // turns — which DO carry reasoning — are already in `convo` from the tier.
    convo = [
      ...convo,
      { role: "assistant", content: output },
      { role: "user", content: feedbackMessage(failed) },
    ];
  }

  // A hard-invalid generation is discarded, never applied. Emit the best
  // candidate (no hard failure; soft misses allowed, flagged in its outcomes),
  // or, under accept_with_warning, the final output even with hard failures.
  let emitOutput: string | undefined;
  let emitOutcomes = outcomes;
  let emitAnchor: EditProposal | undefined;
  let emitReview: ReviewResult | undefined;
  if (stoppedBy === "complete" && strategy === "accept_with_warning") {
    emitOutput = output;
    // replace_anchor: even under accept_with_warning an un-locatable answer
    // has no span to propose — validator failures pass through, parse/locate
    // failures cannot. Review likewise: no located annotations, nothing to show.
    emitAnchor = anchorProposal;
    emitReview = reviewCandidate;
  } else if (stoppedBy === "complete" && best !== undefined) {
    emitOutput = best.output;
    emitOutcomes = best.outcomes;
    emitAnchor = best.proposal;
    emitReview = best.review;
  }
  // Review is read-only (invariant 3): never build an EditProposal for it.
  const proposals: EditProposal[] | undefined =
    action.kind === "review"
      ? undefined
      : contract === "replace_anchor"
        ? emitAnchor !== undefined
          ? [emitAnchor]
          : undefined
        : emitOutput !== undefined
          ? [
              {
                file: built.unit.span.file,
                span: {
                  startOffset: built.unit.span.startOffset,
                  endOffset: built.unit.span.endOffset,
                },
                expectedOriginal: built.unit.text,
                replacement: thawText(emitOutput, built.frozen.tokens),
                contract: "replace_selection",
              },
            ]
          : undefined;

  return {
    kind: action.kind,
    ...(proposals ? { proposals } : {}),
    ...(action.kind === "review" && emitReview !== undefined
      ? { review: emitReview }
      : {}),
    validators: emitOutcomes,
    retries,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      iterations: usage.iterations,
    },
    stoppedBy,
    context,
    templateWarnings,
  };
}

function feedbackMessage(failed: ValidatorOutcome[]): string {
  const lines = failed.map((f) => `- ${f.type}: ${f.reason ?? "failed"}`);
  return [
    "Your previous answer failed these checks:",
    ...lines,
    "Revise it to fix every issue and reply with the full revised text only.",
  ].join("\n");
}
