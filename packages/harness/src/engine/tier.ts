/**
 * Tier control flow (execution lifecycle step 7). `runL0Tier` is a single
 * generate call (no tools); `runL1Tier` is the *bounded* tool loop: it offers the
 * action's `routing.tools` to the model, executes each requested call through the
 * tool registry, feeds results back as messages, and stops with a final answer —
 * capped by `max_iterations` (all model round-trips) and `retrieval_budget`
 * (retrieval-category tool calls only). The L2 agent loop lands post-MVP.
 *
 * Each tier run returns its own usage; the engine's `retry_with_feedback` loop
 * sums usage across runs and validates the returned `text`.
 */

import type { ResolvedBudget } from "../contracts/actions.js";
import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ThinkingBudget,
  ToolCall,
  ToolSpec,
} from "../contracts/adapters.js";
import type { ToolErrorCode } from "../contracts/results.js";
import type { ToolName } from "../contracts/tools.js";
import { capToolResult } from "../text/tool-result.js";
import type { ToolExecutor } from "./tools.js";

export interface TierUsage {
  inputTokens: number;
  outputTokens: number;
  /** Undefined once any turn is unpriced (ADR 0002). */
  costUsd?: number;
  iterations: number;
}

export interface TierRun {
  /** The final answer prose (protected-span tokens still frozen). */
  text: string;
  /**
   * Conversation including any intermediate tool turns (assistant tool_use +
   * tool results); EXCLUDES the final answer turn, which the engine appends only
   * when it retries. Carrying tool turns preserves history across retries.
   */
  messages: ChatMessage[];
  usage: TierUsage;
  stoppedBy: "complete" | "budget" | "error";
}

export interface TierOptions {
  model: ModelAdapter;
  binding: ModelBinding;
  messages: ChatMessage[];
  budget: ResolvedBudget;
  temperature?: number;
  thinkingBudget?: ThinkingBudget;
  signal: AbortSignal;
}

export interface L1TierOptions extends TierOptions {
  registry: Map<ToolName, ToolExecutor>;
  /** The action's `routing.tools`; a model-requested tool outside it is refused. */
  allowedTools: ToolName[];
}

function terminalStop(
  reason: GenerateResult["stopReason"],
): TierRun["stoppedBy"] {
  if (reason === "max_tokens") return "budget";
  if (reason === "aborted") return "error";
  return "complete";
}

function accrue(acc: TierUsage, delta: GenerateResult["usage"]): void {
  acc.inputTokens += delta.inputTokens;
  acc.outputTokens += delta.outputTokens;
  acc.costUsd =
    acc.costUsd === undefined || delta.costUsd === undefined
      ? undefined
      : acc.costUsd + delta.costUsd;
  acc.iterations += 1;
}

function buildRequest(
  opts: TierOptions,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
): GenerateRequest {
  return {
    binding: opts.binding,
    messages,
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
    ...(opts.thinkingBudget !== undefined
      ? { thinkingBudget: opts.thinkingBudget }
      : {}),
    maxTokens: opts.budget.maxTokens,
    signal: opts.signal,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

export async function runL0Tier(opts: TierOptions): Promise<TierRun> {
  const usage: TierUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    iterations: 0,
  };
  const result = await opts.model.generate(
    buildRequest(opts, opts.messages, undefined),
  );
  accrue(usage, result.usage);
  return {
    text: result.text,
    messages: opts.messages,
    usage,
    stoppedBy: terminalStop(result.stopReason),
  };
}

/** The one failure shape a tool result can carry (ADR 0024). */
function failure(code: ToolErrorCode, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

export async function runL1Tier(opts: L1TierOptions): Promise<TierRun> {
  const usage: TierUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    iterations: 0,
  };
  const messages = [...opts.messages];
  const toolSpecs = opts.allowedTools
    .map((name) => opts.registry.get(name)?.spec)
    .filter((spec): spec is ToolSpec => spec !== undefined);
  let retrievalUsed = 0;

  const executeCall = async (call: ToolCall): Promise<string> => {
    if (!opts.allowedTools.includes(call.name)) {
      return failure(
        "denied",
        `tool "${call.name}" is not permitted for this action`,
      );
    }
    const tool = opts.registry.get(call.name);
    if (!tool)
      return failure("unavailable", `tool "${call.name}" is not available`);
    if (tool.category === "retrieval") {
      if (retrievalUsed >= opts.budget.retrievalBudget) {
        return failure(
          "too_large",
          `retrieval budget exhausted (${opts.budget.retrievalBudget}); answer with the information you already have`,
        );
      }
      retrievalUsed += 1;
    }
    try {
      const outcome = await tool.invoke(call.args);
      // B4: the SAME backstop the session loop applies (`tool-batch.ts`). This
      // was the second serialization path, and it was uncapped — an L1 quick
      // action could take an unbounded `list_citations` straight into its
      // context. The per-tool limits sit below it; this is the last line.
      return capToolResult(
        outcome.ok
          ? JSON.stringify(outcome.value)
          : JSON.stringify({ error: outcome.error }),
      );
    } catch (error) {
      // ADR 0024: tools must not throw. One that does is a defect, not a dead
      // action — report it as `unavailable` so the loop can still finish.
      return failure("unavailable", (error as Error).message);
    }
  };

  for (;;) {
    // Offer tools on every round-trip except the last permitted one, which is
    // sent tools-off to force a final answer — so total calls ≤ max_iterations
    // (the round-trip budget). Consequence for action authors: max_iterations
    // grants one FEWER tool round than its number (max_iterations: 2 ⇒ one tool
    // round then the forced answer; max_iterations: 1 ⇒ no tool round, i.e. L0).
    // No tools ⇒ the loop degenerates to a single call.
    const offerTools =
      toolSpecs.length > 0 && usage.iterations < opts.budget.maxIterations - 1;
    const result = await opts.model.generate(
      buildRequest(opts, messages, offerTools ? toolSpecs : undefined),
    );
    accrue(usage, result.usage);

    if (result.stopReason === "max_tokens" || result.stopReason === "aborted") {
      return {
        text: result.text,
        messages,
        usage,
        stoppedBy: terminalStop(result.stopReason),
      };
    }

    if (
      offerTools &&
      result.stopReason === "tool_use" &&
      result.toolCalls.length > 0
    ) {
      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
        ...(result.reasoning !== undefined
          ? { reasoning: result.reasoning }
          : {}),
      });
      for (const call of result.toolCalls) {
        messages.push({
          role: "tool",
          content: await executeCall(call),
          toolCallId: call.id,
        });
      }
      continue;
    }

    return { text: result.text, messages, usage, stoppedBy: "complete" };
  }
}
