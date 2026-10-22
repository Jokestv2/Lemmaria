import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ModelAdapter,
  ModelBinding,
  Usage,
} from "../contracts/adapters.js";
import type {
  CompactionItem,
  SessionEntry,
  SessionEvent,
  SessionId,
  SessionItem,
  SessionLocale,
} from "../contracts/sessions.js";
import type { ToolName } from "../contracts/tools.js";
import { estimateTokens, isCjk } from "../text/truncate.js";
import { contextWindowFor } from "./context.js";
import { fileOperations, formatFileOperations } from "./file-operations.js";
import type { SleepFn } from "./loop.js";
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  abortableSleep,
  decideStreamRetry,
} from "./retry.js";
import { renderReviewForHistory } from "./review-panel.js";
import type { SessionStore } from "./store.js";

/**
 * A2 (ADR 0021) — CM5 context compaction.
 *
 * Compaction is a persisted CHECKPOINT: the model writes a handoff summary,
 * the loop appends one `compaction` item, and every later reader derives the
 * model-visible history from the transcript. There is exactly one definition
 * of "what the model sees", so a live task, a follow-up task, and a session
 * resumed in a new window agree by construction.
 */

/** Fraction of the model window kept as VERBATIM recent user messages. */
export const COMPACT_RETAIN_FRACTION = 0.1;

/**
 * Marker appended to a retained message that had to be cut.
 *
 * English (ADR 0034 consequence 2) — it is spliced into conversation history
 * the MODEL reads, not rendered to a reader, and no `SessionLocale` is in
 * scope at the splice.
 */
export const TRUNCATION_MARK = " …[truncated]";

/**
 * `estimateTokens` moved to `text/truncate.ts` at B4, when tool-result
 * truncation became its second consumer (B1's precedent: a helper moves when
 * it gains one). Re-exported here so every A2-era consumer keeps its import —
 * one definition, two names for the same binding, never a copy.
 */
export { estimateTokens } from "../text/truncate.js";

/**
 * Cut `text` to at most `maxTokens` estimated tokens, marking the cut.
 * The two character classes are accumulated separately and the estimate
 * recomputed — charging each character its own rounded-up cost would bill
 * non-CJK text four times over and cut a quarter of the allowed length.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = [...text];
  let cjk = 0;
  let other = 0;
  let cut = 0;
  for (const [i, ch] of chars.entries()) {
    if (isCjk(ch)) cjk += 1;
    else other += 1;
    if (cjk + Math.ceil(other / 4) > maxTokens) break;
    cut = i + 1;
  }
  return chars.slice(0, cut).join("") + TRUNCATION_MARK;
}

/** Verbatim-retention budget for a model, in estimated tokens. */
export function retainBudgetFor(model: string): number {
  return Math.floor(contextWindowFor(model) * COMPACT_RETAIN_FRACTION);
}

/** Per-message cap, so one huge message cannot eat the whole budget. */
function perMessageCap(budgetTokens: number): number {
  return Math.max(1, Math.floor(budgetTokens / 2));
}

/**
 * The text a retained message contributes (capped). Shared by selection and
 * history assembly so the two can never disagree about its size.
 */
export function retainedText(text: string, budgetTokens: number): string {
  return truncateToTokens(text, perMessageCap(budgetTokens));
}

/**
 * Which `user_message` items survive a compaction verbatim: the session's
 * FIRST user message is always pinned (a writing task's brief IS the task —
 * the deliberate divergence from Codex, which drops it once its budget runs
 * out), then the newest messages backwards while the budget lasts. Agent
 * messages are never retained; describing them is the summary's job.
 * Returned in transcript order.
 *
 * Selection sees only the LIVE window (review): the previous checkpoint's own
 * retained messages plus everything after it — exactly what the model can
 * still see. Forgetting is therefore monotone (a later checkpoint cannot
 * resurrect a message an earlier one dropped, which the summary was written
 * without), while the original brief survives because each checkpoint pins it
 * forward.
 */
export function selectRetainedMessageIds(
  items: readonly SessionItem[],
  budgetTokens: number,
): string[] {
  let previous = -1;
  for (const [i, item] of items.entries()) {
    if (item.type === "compaction") previous = i;
  }
  const prior = previous >= 0 ? (items[previous] as CompactionItem) : undefined;
  const live = prior
    ? [
        ...items
          .slice(0, previous)
          .filter((i) => prior.retainedItemIds.includes(i.id)),
        ...items.slice(previous + 1),
      ]
    : items;
  const users = live.filter(
    (i): i is Extract<SessionItem, { type: "user_message" }> =>
      i.type === "user_message",
  );
  const first = users[0];
  if (!first) return [];
  const kept = new Set<string>([first.id]);
  let spent = estimateTokens(retainedText(first.text, budgetTokens));
  for (let i = users.length - 1; i >= 1; i--) {
    const u = users[i];
    if (!u || kept.has(u.id)) continue;
    const cost = estimateTokens(retainedText(u.text, budgetTokens));
    if (spent + cost > budgetTokens) break;
    spent += cost;
    kept.add(u.id);
  }
  return users.filter((u) => kept.has(u.id)).map((u) => u.id);
}

/**
 * Prefix on the injected summary message. Explicit: the model must know it is
 * reading a handoff note, not the user's own words. Unlike Codex's prefix this
 * is NOT load-bearing for detection — the checkpoint is a typed item, so "this
 * is a summary" is structural, never a string match.
 *
 * **English** (ADR 0034 consequence 2): this is addressed to the model, inside
 * conversation history, and is never rendered to a reader. The summary it
 * prefixes is generated in the session's own language by `PROMPTS[locale]`,
 * which is where the reader's language actually belongs.
 */
export const SUMMARY_PREFIX =
  "[Compacted context] Earlier turns of this writing session were summarized for handoff. Continue the work from this summary:\n";

/**
 * Fraction of the model window a rebuilt history may spend re-sending tool
 * traffic (B4). Mirrors `COMPACT_RETAIN_FRACTION`'s shape deliberately: the
 * harness holds ONE idea about budgeting history, and this cap is also what
 * keeps cross-task memory from making a context overflow more likely — it is
 * sized against the same window an overflow would exceed.
 */
export const TOOL_TRAFFIC_FRACTION = 0.1;

/** Budget, in estimated tokens, for tool traffic replayed into a history. */
export function toolTrafficBudgetFor(model: string): number {
  return Math.floor(contextWindowFor(model) * TOOL_TRAFFIC_FRACTION);
}

/** A tool exchange recovered from the transcript: the call and its answer. */
interface ToolExchange {
  index: number;
  call: { id: string; name: ToolName; args: unknown };
  resultJson: string;
  cost: number;
}

/**
 * Recover a terminal tool call from its transcript item — or nothing.
 *
 * The two halves of a tool exchange live in ONE item (`argsJson` +
 * `resultJson`), which is why Lemmaria needs no cut-point machinery: a
 * boundary between items cannot split a pair. What CAN split one is a partial
 * recovery, so this is all-or-nothing — an in-flight call, a terminal call
 * with no result, and a call whose arguments do not parse all yield nothing.
 * An orphaned `tool_call` is a history Anthropic rejects outright.
 *
 * The pairing id is the item's own id: the provider's call id is not
 * persisted, and the pairing only has to be consistent within the request
 * being sent.
 */
function exchangeFrom(
  item: SessionItem,
  index: number,
): ToolExchange | undefined {
  if (item.type !== "tool_call") return undefined;
  if (item.status === "in_progress") return undefined;
  if (item.resultJson === undefined) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(item.argsJson === "" ? "{}" : item.argsJson);
  } catch {
    return undefined;
  }
  return {
    index,
    call: { id: item.id, name: item.tool, args },
    resultJson: item.resultJson,
    cost: estimateTokens(item.argsJson) + estimateTokens(item.resultJson),
  };
}

/**
 * Which exchanges a rebuilt history can afford: newest-first under the budget,
 * each kept or dropped WHOLE. Returned as a set of transcript indices so the
 * assembly below stays in transcript order.
 */
function affordableExchanges(
  items: readonly SessionItem[],
  budgetTokens: number,
): Set<number> {
  const kept = new Set<number>();
  let spent = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const exchange = exchangeFrom(items[i] as SessionItem, i);
    if (!exchange) continue;
    // A suffix, not a greedy fill (review, Important 3): the first exchange
    // that does not fit ends the walk, so the model never receives exchange 3
    // and exchange 30 with the middle silently missing, and the NEWEST
    // exchange can never be the one skipped to make room for older ones.
    if (spent + exchange.cost > budgetTokens) break;
    spent += exchange.cost;
    kept.add(i);
  }
  return kept;
}

/**
 * Transcript → chat messages. A1a's user/agent mapping, plus (B4) the tool
 * traffic that mapping used to drop.
 *
 * A run of consecutive tool calls becomes ONE assistant message carrying all
 * of them followed by their results in call order — the shape a B3 parallel
 * batch actually had, and the shape both protocol adapters already encode
 * (Anthropic merges consecutive same-role turns, so an `agent_message` just
 * before the run rejoins it as `[text, tool_use…]`).
 */
function plainHistory(
  items: readonly SessionItem[],
  budgetTokens: number,
): ChatMessage[] {
  const affordable = affordableExchanges(items, budgetTokens);
  const out: ChatMessage[] = [];
  let run: ToolExchange[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push({
      role: "assistant",
      content: "",
      toolCalls: run.map((e) => e.call),
    });
    for (const e of run)
      out.push({ role: "tool", content: e.resultJson, toolCallId: e.call.id });
    run = [];
  };
  for (const [i, item] of items.entries()) {
    if (item.type === "tool_call") {
      const exchange = affordable.has(i) ? exchangeFrom(item, i) : undefined;
      // A dropped exchange does not break a run: the calls around it were
      // still made together, and each pair carries its own id.
      if (exchange) run.push(exchange);
      continue;
    }
    flush();
    if (item.type === "user_message")
      out.push({ role: "user", content: item.text });
    else if (item.type === "agent_message")
      out.push({ role: "assistant", content: item.text });
    // R3 (ADR 0061 §9): a completed review panel is the ONLY thing its task
    // produced — it runs no model turn of its own, so without this branch a
    // compaction would leave the model discussing a paper whose concerns had
    // evaporated from its context. Rendered as one assistant message, which is
    // what the panel's report would have been had a turn written it.
    // `running`/`failed`/`interrupted` render nothing: a panel with no result
    // has nothing to carry, and a half-panel summarised as a whole one would
    // be the item claiming a completeness it does not have.
    else if (
      item.type === "review" &&
      item.status === "completed" &&
      item.result !== undefined
    )
      out.push({
        role: "assistant",
        // R9 (ADR 0069 §D4): the seats come too, so the handoff names which
        // model each reviewer ran on — the fact that makes a mixed panel's
        // agreement interpretable, and the one a compaction would otherwise
        // be the last place to lose it.
        content: renderReviewForHistory(
          item.result,
          item.seats,
          item.synthesisSeat,
          item.verifierSeat,
          // V4 (ADR 0081 §3): the PDF reviewer's sibling row.
          item.pdfSeat,
        ),
      });
  }
  flush();
  return out;
}

/**
 * The model-visible history for a transcript — the ONE definition, used by a
 * live task, the next task in the same window, and a resumed session alike.
 * Without a checkpoint this is the user/agent mapping plus (B4) the session's
 * affordable tool traffic; with one, everything before the NEWEST checkpoint
 * collapses to the retained user messages plus the summary.
 */
export function buildConversationHistory(
  items: readonly SessionItem[],
  model: string,
): ChatMessage[] {
  const toolBudget = toolTrafficBudgetFor(model);
  let cut = -1;
  for (const [i, item] of items.entries()) {
    if (item.type === "compaction") cut = i;
  }
  if (cut < 0) return plainHistory(items, toolBudget);

  const checkpoint = items[cut] as CompactionItem;
  const budget = retainBudgetFor(model);
  const before = items.slice(0, cut);
  const retained: ChatMessage[] = checkpoint.retainedItemIds.flatMap((id) => {
    const item = before.find((i) => i.id === id);
    // Its absence is not an error. Before ADR 0027 a rewind could delete a
    // retained item outright; now a checkpoint's retained ids are ancestors
    // of the checkpoint, so they are on any branch the checkpoint is on and
    // this guard should not fire. Kept: a corrupt log must not throw here.
    if (!item || item.type !== "user_message") return [];
    return [
      { role: "user" as const, content: retainedText(item.text, budget) },
    ];
  });
  // B4: the files the work touched, derived from the WHOLE transcript — the
  // one fact a lossy summary must not be trusted to remember. Everything
  // before the checkpoint is otherwise gone from the model's view, and a read
  // after it can still be dropped by the tool-traffic budget (review, Minor
  // 9), so both sides of the checkpoint contribute.
  const touched = formatFileOperations(fileOperations(items));
  return [
    ...retained,
    {
      role: "user",
      content: `${SUMMARY_PREFIX}${checkpoint.summary}${touched}`,
    },
    // Tool traffic BEFORE the checkpoint is gone by design (ADR 0021 §3:
    // describing it is the summary's job); after it, it is the live task's own
    // and survives under the budget.
    ...plainHistory(items.slice(cut + 1), toolBudget),
  ];
}

/**
 * Measured occupancy of the LIVE window: the last completed turn's usage on
 * THIS BRANCH, counting only turns after the newest compaction checkpoint on
 * it. `undefined` = nothing has been measured since that boundary, so
 * occupancy is honestly unknown (without this, a compacted session would
 * re-compact off a stale reading).
 *
 * A rewind used to be a second kind of boundary (`{type:"rewound"}`, ADR
 * 0018); under ADR 0027 it needs no rule at all, because the turns it rewound
 * past are simply not on the branch. That is what keeps ADR 0018's fix intact
 * — rewinding the huge turn is the natural remedy for a full window, and it
 * must not leave the session permanently refusing to run.
 */
export function liveTurnUsage(
  branch: readonly SessionEntry[],
): Usage | undefined {
  let boundary = -1;
  for (const [i, { event }] of branch.entries()) {
    if (event.type === "item.completed" && event.item.type === "compaction")
      boundary = i;
  }
  for (let i = branch.length - 1; i > boundary; i--) {
    const event = branch[i]?.event;
    if (event?.type === "turn.completed") return event.usage;
  }
  return undefined;
}

/** Ceiling for the summarization request (invariant 5: it asks for less). */
export const COMPACTION_MAX_TOKENS = 1024;

/**
 * ADR 0031: ONE language per prompt, chosen by the caller.
 *
 * B6 shipped a single `／`-joined bilingual string ending in "reply in the
 * language the user has been writing in". The model resolves that heuristic
 * partly from the prompt it is reading, so a half-Chinese prompt reliably
 * produced Chinese summaries for English-display users. The language is a
 * decision the host makes, not one the model infers. This does not weaken
 * the bilingual invariant (invariant 6) — bilingual stays first-class in
 * counting, terminology, and shipped UI strings; what changes is that ONE
 * language is selected per rendered surface, which a half-and-half prompt
 * could never actually deliver.
 */
export const COMPACTION_PROMPTS: Record<SessionLocale, string> = {
  en: [
    "You are performing a CONTEXT CHECKPOINT COMPACTION for a writing session.",
    "Write a handoff summary for another model that will resume this writing task.",
    "Include: what has been written or changed so far (files and sections touched, which edits were applied and which the user rejected);",
    "the user's stated preferences and terminology constraints;",
    "sources, citations, or script results that matter;",
    "what remains to be done, as concrete next steps;",
    "and any critical data or references needed to continue.",
    "Be concise and structured. Do not ask questions. Reply in English.",
  ].join(" "),
  zh: [
    "你正在为一次写作会话生成上下文检查点摘要。",
    "请为将要接手这项写作任务的另一个模型撰写交接摘要。",
    "内容应包括：目前已完成的写作与修改（涉及哪些文件与章节、哪些编辑已应用、哪些被用户拒绝）；",
    "用户明确表达的偏好与术语约束；",
    "重要的资料、引用或脚本结果；",
    "以及接下来需要完成的具体步骤和必要的关键数据或参考。",
    "请简洁、结构化。不要提问。请用中文回答。",
  ].join(""),
};

/**
 * Strip tool traffic from a history clone before summarizing (review,
 * Critical #1). A summarization request declares NO tools, and a provider that
 * requires `tool_use`/`tool_result` blocks to be accompanied by a tools
 * definition (Anthropic) rejects the whole request — which would kill exactly
 * the mid-loop compaction path, the milestone's headline case, while every
 * scripted-model test stayed green. The model's own narration is kept; the
 * summary is built from that (the same user/assistant-text shape
 * `buildConversationHistory` already produces on the other two paths).
 */
export function sanitizeForSummarization(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role !== "assistant") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    // A turn that was only a tool call carries no prose — dropping it also
    // avoids an empty content block, which providers reject.
    if (m.content.trim() === "") continue;
    out.push({ role: "assistant", content: m.content });
  }
  return out;
}

export interface SummarizeRequest {
  /**
   * The history to summarize. Tool traffic, tool calls and reasoning blocks
   * are stripped before sending; a system message is passed through when the
   * caller supplies one (the loop does, `runSessionCompaction` does not).
   */
  messages: ChatMessage[];
  model: ModelAdapter;
  binding: ModelBinding;
  /**
   * B2 (ADR 0026): the same retry policy the turn loop uses, so a transient
   * drop at the threshold crossing no longer ends a long session. Absent =
   * `DEFAULT_RETRY_POLICY`.
   */
  retry?: RetryPolicy;
  /** The backoff's wait; injected in tests. Defaults to a real timer. */
  sleep?: SleepFn;
  signal?: AbortSignal;
  /**
   * B6: the instruction appended as the last user message. Absent =
   * `COMPACTION_PROMPTS[locale ?? "en"]`. The branch summarizer (ADR 0030) is
   * the second caller and supplies its own; it reuses this function rather
   * than cloning the retry loop, so B2's "the policy is shared, so the two
   * cannot drift" keeps holding with three summarization sites instead of two.
   */
  prompt?: string;
  /** B6: the per-request output ceiling. Absent = `COMPACTION_MAX_TOKENS`. */
  maxTokens?: number;
  /**
   * ADR 0031: which `COMPACTION_PROMPTS` entry to send when `prompt` is not
   * supplied (the branch summarizer always supplies its own, so this is moot
   * there). Absent = `"en"` — the CLI eval runner and the harness's own test
   * harnesses call this with no locale, and a required parameter would break
   * every one of them.
   */
  locale?: SessionLocale;
}

export interface SummarizeOutcome {
  summary?: string;
  usage?: Usage;
  error?: string;
}

/**
 * Ask the model for the handoff summary. NEVER throws and never streams to
 * the UI: the caller decides what a failure means (A2's rule — fall back to
 * A1a's honest `context.limit` stop, never a faked compaction).
 */
export async function summarizeForCompaction(
  req: SummarizeRequest,
): Promise<SummarizeOutcome> {
  const generateStream = req.model.generateStream?.bind(req.model);
  if (!generateStream)
    return { error: "model adapter does not support streamed generation" };
  const messages: ChatMessage[] = [
    ...sanitizeForSummarization(req.messages),
    {
      role: "user",
      content: req.prompt ?? COMPACTION_PROMPTS[req.locale ?? "en"],
    },
  ];
  // B2 (ADR 0026): the loop's own RetryPolicy, applied here too — a network
  // blip at the threshold crossing must not end a long session with the honest
  // stop the loop itself would have retried past. Before B2 this was one
  // immediate retry; the policy is now shared, so the two cannot drift.
  const policy = req.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = req.sleep ?? abortableSleep;
  for (let attempt = 1; ; attempt++) {
    const outcome = await requestSummary(generateStream, req, messages);
    const { thrown, ...result } = outcome;
    if (outcome.summary !== undefined || req.signal?.aborted) return result;
    const decision = decideStreamRetry(thrown, attempt, policy);
    if (decision.kind !== "retry") return result;
    // A failed compaction is silent to the user until it gives up (the caller
    // emits `compaction.failed`), so there is nothing to announce here — but
    // the wait must still yield to an interrupt.
    if (!(await sleep(decision.delayMs, req.signal))) return result;
  }
}

async function requestSummary(
  generateStream: NonNullable<ModelAdapter["generateStream"]>,
  req: SummarizeRequest,
  messages: ChatMessage[],
): Promise<SummarizeOutcome & { thrown?: unknown }> {
  try {
    const stream = generateStream({
      binding: req.binding,
      messages,
      tools: [],
      maxTokens: req.maxTokens ?? COMPACTION_MAX_TOKENS,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    for await (const event of stream) {
      if (event.type === "aborted") return { error: "compaction interrupted" };
      if (event.type !== "completed") continue;
      // A summary that ran into `maxTokens` is half a sentence, and a
      // checkpoint is PERSISTED: every later reader — a resumed session, a
      // follow-up task, the next compaction — derives the model's history from
      // it, so accepting a truncated one damages the session permanently and
      // silently. `COMPACTION_MAX_TOKENS` is 1024 against a prompt that asks
      // for six kinds of content, so this is a case the design meets, not a
      // theoretical one. The caller's fallback is A2's honest `context.limit`
      // stop, which is the right outcome here.
      //
      // The same guard covers the ADR 0030 branch summarizer, which reaches
      // the model through this function rather than cloning the loop.
      // Adapted from Pi's fix for its issue #7048 (MIT); the harness already
      // refuses a truncated turn the same way in `task-hooks.ts`.
      if (event.result.stopReason === "max_tokens")
        return { error: "truncated summary", usage: event.result.usage };
      const summary = event.result.text.trim();
      if (summary === "")
        return { error: "empty summary", usage: event.result.usage };
      return { summary, usage: event.result.usage };
    }
    return { error: "model stream ended without a terminal event" };
  } catch (error) {
    return { error: (error as Error).message, thrown: error };
  }
}

export interface RunSessionCompactionOptions {
  store: SessionStore;
  sessionId: SessionId;
  model: ModelAdapter;
  binding: ModelBinding;
  signal?: AbortSignal;
  onEvent?: (event: SessionEvent) => void;
  /**
   * ADR 0031: which `COMPACTION_PROMPTS` entry the handoff summary is asked
   * for in. Absent = `"en"` — the extension passes `resolvedLocale()`; the
   * harness's own callers are unaffected by the default.
   */
  locale?: SessionLocale;
}

/**
 * A2: user-triggered compaction (`Lemmaria: Compact Session`, the Claude Code
 * `/compact` convention) — the same checkpoint the loop writes automatically,
 * asked for on demand between tasks. Never throws; a failure writes nothing.
 */
export async function runSessionCompaction(
  opts: RunSessionCompactionOptions,
): Promise<{ ok: boolean; item?: CompactionItem; error?: string }> {
  const loaded = await opts.store.load(opts.sessionId);
  const history = buildConversationHistory(loaded.items, opts.binding.model);
  if (history.length === 0) return { ok: false, error: "nothing to compact" };
  // The transcript revision as seen by the summary (review): the model call
  // below takes real time, during which a concurrent task can append a turn.
  // A count is enough again (ADR 0057): ADR 0027 had to add the leaf id,
  // because a leaf move between the two loads changed WHICH branch the summary
  // described without changing how many records existed. Nothing can do that
  // now — a session only ever grows at its end.
  const baseRevision = `${loaded.entries.length}`;
  // The progress row (D4 manual round). Its id is minted here and reused by
  // the checkpoint below, so the finished card REPLACES it in the fold rather
  // than stacking under it. Delivered straight to the sink, never through the
  // store: `item.started`/`item.updated` are the two live-only event types
  // (see `SessionEmitter`), and a compaction that fails must leave no trace.
  const itemId = randomUUID();
  const progress = (status: "running" | "failed"): CompactionItem => ({
    id: itemId,
    type: "compaction",
    summary: "",
    trigger: "manual",
    retainedItemIds: [],
    tokensBefore: 0,
    status,
  });
  opts.onEvent?.({ type: "item.started", item: progress("running") });
  const clearProgress = (): void => {
    opts.onEvent?.({ type: "item.updated", item: progress("failed") });
  };
  const outcome = await summarizeForCompaction({
    messages: history,
    model: opts.model,
    binding: opts.binding,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
  if (!outcome.summary) {
    clearProgress();
    return { ok: false, ...(outcome.error ? { error: outcome.error } : {}) };
  }
  // Validate before appending: if the transcript grew while we were
  // summarizing, appending the checkpoint now would collapse that concurrent
  // turn out of every later `buildConversationHistory` (it sits before the
  // new checkpoint, and the summary never saw it). Refuse instead of
  // clobbering — the user retries when the session is quiet.
  const current = await opts.store.load(opts.sessionId);
  if (`${current.entries.length}` !== baseRevision) {
    clearProgress();
    return { ok: false, error: "conversation changed during compaction" };
  }
  const item: CompactionItem = {
    id: itemId,
    type: "compaction",
    summary: outcome.summary,
    trigger: "manual",
    retainedItemIds: selectRetainedMessageIds(
      loaded.items,
      retainBudgetFor(opts.binding.model),
    ),
    // A manual compaction is not a threshold crossing: there is no measured
    // occupancy to record, and inventing one would be a lie.
    tokensBefore: 0,
    // Asking for a summary is a paid model call like any other — it reads the
    // whole conversation, so it is rarely a small one. Persisting it here is
    // what puts it in `sumSessionUsage`; dropping it made "compact" the one
    // way to spend money in this app that no surface ever reported.
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
  const event: SessionEvent = { type: "item.completed", item };
  try {
    await opts.store.append(opts.sessionId, event);
  } catch (error) {
    clearProgress();
    return { ok: false, error: (error as Error).message };
  }
  opts.onEvent?.(event);
  return { ok: true, item };
}
