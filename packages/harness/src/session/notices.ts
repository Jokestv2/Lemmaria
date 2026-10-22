import type { NoticeItem, SessionLocale } from "../contracts/index.js";
import { L2_FLOOR_LABEL, L2_FLOOR_LABEL_ZH } from "../model/floor.js";

/**
 * Harness-side notice text, **one language per reader** (invariant 6 rule 2,
 * ADR 0034).
 *
 * This used to be a single table of `"english / 中文"` strings. It was wrong for
 * the whole of its life: a reader whose display language is English cannot be
 * assumed to read Chinese, and vice versa. The table is now keyed by
 * `SessionLocale` first, so a caller physically cannot emit both.
 *
 * This is the FALLBACK, not the primary surface: the webview localizes every
 * notice by its `code` (`noticeText`, extension/src/webview/main.ts), so a
 * reader in the extension sees one language either way. The CLI is what reads
 * these strings. Moved out of `run.ts` at B1 because it is UI text, not loop
 * logic — and because a table indexed by a contract union belongs next to
 * nothing else.
 */
export const NOTICE_MESSAGES: Record<
  SessionLocale,
  Record<NoticeItem["code"], (n: number) => string>
> = {
  en: {
    "budget.turns": (n) =>
      `Task stopped: turn budget (${n}) reached — send a new message to continue with a fresh budget.`,
    "budget.tool_calls": (n) =>
      `Task stopped: tool-call budget (${n}) reached — send a new message to continue with a fresh budget.`,
    "budget.output_tokens": (n) =>
      `Task stopped: output-token budget (${n}) reached — send a new message to continue with a fresh budget.`,
    "context.limit": () =>
      "Context limit reached: this conversation is near the model's context window. Start a new session (Lemmaria: New Session) to continue.",
    "compaction.failed": () =>
      "Could not compact this conversation (the summarization request failed).",
    // B2 (ADR 0026): scheduled, not past — the loop emits this BEFORE it waits,
    // and `n` is the delay it is about to wait. The old wording ("retried once")
    // became untrue the moment the policy could retry more than once.
    "stream.retried": (n) => `Connection problem — retrying in ${n}s.`,
    "stream.retry_failed": (n) =>
      `The model could not be reached after ${n} attempt(s); the details are below.`,
    "provider.quota": () =>
      "The provider refused this request for a quota or billing reason, so retrying cannot help — check your plan, credit balance or API key.",
    // A6 (ADR 0023): honest uncertainty about the configured model — never a
    // claim that it will fail. The floor names only the tier S4 actually probed.
    "model.unverified": () =>
      `This model is not one Lemmaria has verified for agentic sessions, so it may not hold the tool-calling contract (symptoms: prose instead of tool calls, malformed edit anchors). Verified: ${L2_FLOOR_LABEL}.`,
    // A6: the per-turn cap cut the answer off. Say what was lost — a discarded
    // partial tool call is invisible otherwise, and reporting the task budget
    // here (as this path used to) names a limit that was never reached.
    "turn.truncated": () =>
      "The model's answer hit this turn's length limit and was cut off; anything it was still writing — including an unfinished edit proposal — was discarded. Ask it to continue in smaller steps.",
    // B2 (ADR 0026): the same cut-off, but with tool calls in flight. Nothing was
    // run — a truncated argument buffer can parse and still be incomplete — so
    // each call is handed back for the model to re-issue, and the task goes on.
    "turn.truncated_recovered": (n) =>
      `The model's answer hit this turn's length limit while it was calling ${n} tool(s); none were run, because their arguments may be incomplete. The model has been asked to re-issue them.`,
    // R3 (ADR 0061): the panel's three preconditions. The first two end the
    // run; the third warns and lets it proceed, because the budget is the
    // user's to set and a starved seat reports itself honestly.
    "review.skill_missing": () =>
      "Review needs the bundled blind-reviewer protocol, and it is not available in this session — re-enable it in the Skills list and run the review again.",
    "review.no_manuscript": () =>
      "Review found no manuscript in this workspace to read — open the folder that holds the paper, or focus its main file, and run the review again.",
    "review.seat_budget": (n) =>
      `Each reviewer would get only ${n} output tokens, which is below what reading a manuscript and writing up its concerns usually needs. The review will run anyway; raise lemmaria.budget.maxTokens if reviewers come back empty.`,
    "review.reviewers_clamped": (n) =>
      `More reviewers were asked for than one review can run at once, so only the first ${n} took part. Ask for ${n} or fewer to choose which ones run.`,
    // X5 (ADR 0074 §4): the manuscript's shape. Both WARN and run — a paper
    // read through the glob is still the paper, and one missing `\input` is
    // still a paper.
    "review.manuscript_unresolved": (n) =>
      `The manuscript's include structure could not be resolved, so the panel is reading every .tex, .md and .bib file in the folder (${n}) — files that are not part of this paper may be among them.`,
    "review.manuscript_incomplete": (n) =>
      `${n} file(s) the manuscript includes could not be read, so the panel reviewed the paper without them.`,
    // X5 (ADR 0074 §6): the pre-run check's three STOPs. Each refuses the
    // panel before a reviewer is paid for, and says what the user can do.
    "review.model_quota": (n) =>
      `The review did not start: ${n} of the panel's models refused a one-word check for a quota or billing reason. Retrying cannot help — check that model's plan, credit balance or API key. No reviewer was run.`,
    "review.model_unreachable": (n) =>
      `The review did not start: ${n} of the panel's models could not be reached for a one-word check. No reviewer was run — try again shortly.`,
    "review.model_refused": (n) =>
      `The review did not start: ${n} of the panel's models rejected a one-word check. Check that model's id, endpoint and API key in the Models tab. No reviewer was run.`,
    // V1 (ADR 0076): `review.seat_budget`'s sentence, with verification as its
    // subject. A warning: the check still runs on what the panel has left.
    "review.verifier_budget": (n) =>
      `Verification would get only ${n} output tokens, which is below what checking the reviewers' concerns against the manuscript usually needs. The review will run anyway; raise lemmaria.budget.maxTokens if concerns come back not checked.`,
  },
  zh: {
    "budget.turns": (n) =>
      `已达本次任务的回合上限（${n}）——发送新消息可继续（预算重置）。`,
    "budget.tool_calls": (n) =>
      `已达工具调用上限（${n}）——发送新消息可继续（预算重置）。`,
    "budget.output_tokens": (n) =>
      `已达输出 token 上限（${n}）——发送新消息可继续（预算重置）。`,
    "context.limit": () =>
      "会话已接近模型上下文上限，请新建会话（Lemmaria: New Session）后继续。",
    "compaction.failed": () => "无法压缩本次会话（生成摘要的请求失败）。",
    "stream.retried": (n) => `连接出现问题——将在 ${n} 秒后重试。`,
    "stream.retry_failed": (n) => `尝试 ${n} 次后仍无法连接模型，详情见下。`,
    "provider.quota": () =>
      "服务商因额度或账单原因拒绝了本次请求，重试无济于事——请检查你的套餐、余额或 API 密钥。",
    "model.unverified": () =>
      `Lemmaria 尚未验证该模型能否胜任智能体会话，它可能无法稳定遵循工具调用约定（表现为：只输出文字而不调用工具、编辑锚点不合法）。已验证：${L2_FLOOR_LABEL_ZH}。`,
    "turn.truncated": () =>
      "模型本回合的输出达到长度上限被截断；尚未写完的内容（包括未完成的编辑提案）已被丢弃。可以让它分步继续。",
    "turn.truncated_recovered": (n) =>
      `模型本回合输出达到长度上限时正在调用 ${n} 个工具；由于参数可能不完整，这些调用均未执行，已请模型重新发起。`,
    "review.skill_missing": () =>
      "评审需要内置的 blind-reviewer 评审规程，但本次会话中它不可用——请在技能列表中重新启用它，然后再次发起评审。",
    "review.no_manuscript": () =>
      "评审未在当前工作区找到可读的稿件——请打开存放论文的文件夹，或先聚焦其主文件，然后再次发起评审。",
    "review.seat_budget": (n) =>
      `每位评审人只分到 ${n} 个输出 token，通常不足以读完稿件并写出意见。评审仍会继续；若评审人返回为空，请调高 lemmaria.budget.maxTokens。`,
    "review.reviewers_clamped": (n) =>
      `请求的评审人数量超过一次评审可同时运行的上限，因此只有前 ${n} 位参与。请将数量减至 ${n} 位或更少，以决定由哪几位运行。`,
    "review.manuscript_unresolved": (n) =>
      `无法解析稿件的文件引用关系，评审小组将读取该文件夹下全部的 .tex、.md 和 .bib 文件（共 ${n} 个）——其中可能包含不属于本文的文件。`,
    "review.manuscript_incomplete": (n) =>
      `稿件引用的 ${n} 个文件无法读取，评审小组是在缺少这些文件的情况下完成审阅的。`,
    "review.model_quota": (n) =>
      `审稿未启动：评审小组中有 ${n} 个模型因额度或账单原因拒绝了一次单词级的连通检查。重试无济于事——请检查该模型的套餐、余额或 API 密钥。没有运行任何评审人。`,
    "review.model_unreachable": (n) =>
      `审稿未启动：评审小组中有 ${n} 个模型在一次单词级的连通检查中无法连接。没有运行任何评审人——请稍后重试。`,
    "review.model_refused": (n) =>
      `审稿未启动：评审小组中有 ${n} 个模型拒绝了一次单词级的连通检查。请在“模型”标签页中检查该模型的名称、接口地址和 API 密钥。没有运行任何评审人。`,
    "review.verifier_budget": (n) =>
      `核查只分到 ${n} 个输出 token，通常不足以对照稿件核查评审意见。评审仍会继续；若意见显示为未核查，请调高 lemmaria.budget.maxTokens。`,
  },
};
