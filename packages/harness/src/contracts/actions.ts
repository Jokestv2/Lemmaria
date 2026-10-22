/**
 * The declarative ActionDefinition (TS mirror of the YAML/JSON schema) plus the
 * runtime types of the execution pipeline.
 *
 * Schema authority: design/custom-action-schema-EN.md (§3, §9 JSON Schema).
 * This TS type and that JSON Schema describe the same object — keep them in sync;
 * the JSON Schema is what validates at load time, this is what the engine consumes.
 */

import type { DocKind, SpanKind } from "./adapters.js";
import type { ReviewResult } from "./data.js";
import type { ToolName } from "./tools.js";

export type ActionKind = "edit" | "review" | "generate";
export type RoutingLevel = "L0" | "L1" | "L2" | "auto"; // `auto` deferred to v0.3
export type I18n = { en?: string; zh?: string };
/** The selection scopes an action can request; mirrors SemanticUnit["scope"] (adapters.ts). */
export type InputScope =
  | "selection"
  | "paragraph"
  | "section"
  | "environment"
  | "document";

export interface ActionDefinition {
  schema_version: "1";
  id: string;
  kind: ActionKind;
  version: string; // semver
  name: I18n;
  description?: I18n;
  author?: string;
  license?: string;
  tags?: string[];
  icon?: string;
  requires?: { harness?: string; tools?: ToolName[]; doc_kinds?: DocKind[] };
  ui?: {
    surfaces?: Array<"context_menu" | "command_palette" | "code_lens">;
    group?: string;
    keybinding?: string | null;
    requires_selection?: boolean;
  };
  input?: {
    scope?: InputScope;
    scope_fallback?: InputScope;
    min_chars?: number;
    max_chars?: number;
  };
  routing?: {
    level?: RoutingLevel;
    thinking_budget?: "none" | "low" | "medium" | "high";
    tools?: ToolName[];
    max_iterations?: number;
    max_tokens?: number;
    timeout_s?: number;
  };
  model?: {
    role?: "writing" | "reviewer_a" | "reviewer_b" | "reviewer_c" | "synthesis";
    override?: string | null;
    temperature?: number;
    fan_out?: string[] | null; // review kind
    synthesis?: string | null; // review kind
  };
  parameters?: Array<{
    id: string;
    name?: I18n;
    type: "integer" | "number" | "string" | "enum" | "boolean";
    required?: boolean;
    default?: unknown;
    prompt_on_invoke?: boolean;
    min?: number;
    max?: number;
    enum?: unknown[];
    /**
     * D4 / QA-3 (ADR 0041): a DISPLAY label per enum value, keyed by the value.
     * `target_language: [en, zh]` made the user choose between the strings "en"
     * and "zh"; the picker now offers the label and returns the value, because
     * `engine/params.ts` validates the value against `enum` membership.
     *
     * Applies to every enum parameter, built-in or local, not only this one.
     * A value with no entry falls back to the value itself, so a partial map is
     * a degraded picker rather than a load failure.
     */
    enum_labels?: Record<string, I18n>;
  }>;
  context?: {
    neighbors?: number;
    include_glossary?: boolean;
    include_profile?: string[]; // PAPER.md fields
    include_outline?: boolean;
    retrieval_budget?: number;
    protected_spans?:
      | "freeze"
      | "allow_edit"
      | {
          mode: "freeze_except";
          allow: SpanKind[];
        };
  };
  prompt: { system?: string; user: string };
  output?: {
    contract?:
      | "replace_selection"
      | "replace_anchor" // targeted edit: the model picks an anchored span (ADR 0007)
      | "insert_after"
      | "insert_before"
      | "new_file"
      | "annotations";
    language?: string; // same_as_input | en | zh | param:<id>
    format?: string;
    validators?: Array<{ type: string; [k: string]: unknown }>;
    on_validation_fail?: {
      strategy?: "retry_with_feedback" | "reject" | "accept_with_warning";
      max_retries?: number;
    };
  };
  /**
   * @deprecated ADR 0013 — accepted but ignored. The host runs no post-Accept
   * verify; a compile is a report the user asks for. Still parsed so existing
   * local actions keep loading; dropped from every built-in YAML.
   */
  verify?: {
    run?: "inherit" | "always" | "never";
    citation_check?: boolean;
    on_fail?: "auto_fix_then_rollback" | "rollback" | "warn";
  };
  review_schema?: {
    dimensions?: string[];
    severity?: string[];
    suggest_edits?: boolean;
  };
  review_ui?: {
    mode?: "inline_diff" | "side_panel";
    allow_retry_feedback?: boolean;
  };
}

// ── Runtime / execution-pipeline types ───────────────────────────────────────
// See architecture-design-EN.md#action-execution-lifecycle for the staged pipeline.

/**
 * The global ceilings actions clamp DOWN to (invariant 5) — the host maps
 * lemmaria.budget.{maxTokens,maxIterations,maxRetrieval,maxFanOut} onto this.
 */
export interface BudgetCeilings {
  maxTokens: number;
  maxIterations: number;
  maxRetrieval: number;
  maxFanOut: number;
}

export interface ResolvedBudget {
  maxIterations: number; // clamped to global ceiling (lemmaria.budget.maxIterations)
  maxTokens: number; // clamped to global ceiling (lemmaria.budget.maxTokens)
  /** Per-action cap only — no global ceiling, so not one of the invariant-5 fields. */
  timeoutMs: number;
  retrievalBudget: number; // clamped to global ceiling (lemmaria.budget.maxRetrieval)
  /** Review fan-out width (model.fan_out length), clamped to lemmaria.budget.maxFanOut — completes the invariant-5 four-field set. 0 for non-review actions. */
  fanOut: number;
}

/** The fully-resolved invocation the engine runs (config + live document context). */
export interface ActionContext {
  action: ActionDefinition;
  level: Exclude<RoutingLevel, "auto">;
  docKind: DocKind;
  selectionText: string;
  params: Record<string, unknown>;
  budget: ResolvedBudget;
  /** Rendered, ready-to-send prompt (logic-less template already interpolated). */
  renderedPrompt: { system?: string; user: string };
}

export interface ValidatorOutcome {
  type: string;
  pass: boolean;
  reason?: string; // fed back to the model on retry_with_feedback
  /** A soft validator's failure does not block emission once retries are
   *  exhausted — the best (closest) attempt is proposed with the reason shown
   *  as a note, rather than discarded. Set from the config's `soft: true`. */
  soft?: boolean;
  /** How far a (soft) failure was from acceptance — used to pick the best
   *  attempt across retries. word_count sets |count − target|; lower is better. */
  distance?: number;
}

/**
 * What an edit/generate action emits for the host to render as a reviewable diff.
 * The harness stages this on the working copy (Workspace.writeWorkingCopy) and emits
 * the proposal; the host's Accept gate decides whether it reaches the user's file.
 * An L2 loop may produce many proposals across files.
 */
export interface EditProposal {
  file: string;
  span: { startOffset: number; endOffset: number };
  /**
   * Content anchor (ADR 0002): the exact source text `span` covered when this
   * proposal was computed (empty for `new_file`). Before staging or committing,
   * the harness re-checks the span still matches; on mismatch the proposal is
   * stale and is rejected or re-anchored — never spliced blindly by offset.
   */
  expectedOriginal: string;
  replacement: string;
  contract:
    | "replace_selection"
    | "replace_anchor"
    | "insert_after"
    | "insert_before"
    | "new_file";
}

/** Output of a tier run, BEFORE the diff/Accept stage. */
export interface TierResult {
  kind: ActionKind;
  /** edit/generate: one or more proposed edits. review: structured result. */
  proposals?: EditProposal[];
  review?: ReviewResult;
  validators: ValidatorOutcome[];
  retries: number;
  /** costUsd omitted when the model's pricing is unknown (ADR 0002) — UI falls back to token counts. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    iterations: number;
  };
  stoppedBy?: "complete" | "budget" | "error"; // L2 hands back on budget
}
