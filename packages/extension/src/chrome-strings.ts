/**
 * The chrome's string table (D4).
 *
 * Every runtime-rendered string outside the webview — toasts, quick-pick
 * titles, input-box prompts, tree-row labels, status-bar text — resolves here,
 * in the reader's language (invariant 6 rule 2; mechanism: ADR 0034).
 *
 * **This is a storage shape, not a second seam.** `i18n.ts`'s `currentLocale()`
 * remains the only place a chrome locale is decided; what changed is where the
 * two renderings live. They were `"english / 中文"` concatenations inline at the
 * call site, which is unassertable — a ternary's two arms are reachable only by
 * relaunching VS Code under a different display language. As a table both are
 * plain data, so `test/chrome-strings.test.ts` can pin key parity and the
 * language of every value with nothing launched. That is exactly the argument
 * ADR 0037 made one level down for `webview/parts/strings.ts`.
 *
 * **`en` is the authority.** `ChromeKey` is derived from it, so a key added to
 * `en` and missed in `zh` fails `pnpm typecheck` rather than reaching a reader.
 *
 * Values are static. Where a message interpolates — a path, a count, a reason
 * from the harness — the call site composes, so no key holds a template.
 */
import type { SessionLocale } from "@lemmaria/harness";

const en = {
  // ── Quick actions (polish-command.ts) ──────────────────────────────────────
  needsProseFile: "Lemmaria: open a .tex or .md file to run this action.",
  /** One home for what was duplicated verbatim in polish-command.ts and
   *  review-ui.ts. The zh half names the command by its CONTRIBUTED zh title
   *  (`package.nls.zh-cn.json`), not its English one — D2's precedent. */
  /** ADR 0064 §4: named `lemmaria.model.model` until the R3 gate-review round.
   *  That setting is the legacy single-model config, retained only as the
   *  one-time migration's rollback net — on a migrated install setting it
   *  changes nothing, so the message sent the reader to a dead control.
   *  `needsModelForFix` below already had the right shape; this matches it and
   *  names the surface that actually owns a model. */
  needsModel: "Lemmaria: add a model and its API key in the Models tab first.",
  /** R9 (ADR 0069 §D8): a reviewer pointed at a model that cannot run. NOT
   *  `needsModel` — the Writing model is set, so telling the reader to add one
   *  sends them to a control that is already filled in. No full stop: the call
   *  site appends the role in parentheses, like `closestAttempt` below. */
  needsReviewerModel:
    "Lemmaria: a reviewer's model has no API key, or is not set — check the Models tab",
  /** V4 (ADR 0081 §8): the role `needsReviewerModel` names in parentheses
   *  when it is the PDF reviewer's model that cannot run. */
  rolePdfReviewer: "PDF reviewer",
  /** V6's E1 round: *Review the PDF* with the role switched Off. The run
   *  would seat nobody, so it is refused before anything is stored — it used
   *  to store an empty version and spend a version number. The labels are
   *  the Models tab's own (`mRoles`, `mPdfReview`, `mPdfReviewerOff`). */
  pdfReviewerOff:
    "Lemmaria: PDF review is Off, so there is no reviewer to run — turn it on under Roles in the Models tab.",
  staleForAction:
    "Lemmaria: the document changed since this proposal; run the action again on the new text.",
  // The reason list is appended by the call site, so this must NOT end in a
  // full stop — "… Retry with a note. (glossary_consistent)" read as a defect.
  closestAttempt: "closest attempt shown — accept it, or Retry with a note",
  fixingCompileError: "Lemmaria: Fix Compile Error…",
  paperMdDraftFailed: "Lemmaria: could not draft PAPER.md",
  diffAccept: "Accept",
  diffReject: "Reject",
  diffRetry: "Retry",
  paramEnterNumber: "Enter a number",
  paramEnterWholeNumber: "Enter a whole number",
  paramAtLeast: "Must be at least",
  paramAtMost: "Must be at most",

  // ── Diff review (diff-review.ts) ───────────────────────────────────────────
  noProposalToAccept: "Lemmaria: no pending proposal to accept.",
  noProposalToReject: "Lemmaria: no pending proposal to reject.",
  proposalStale:
    "Lemmaria: the document changed since this proposal was created; it is stale. Reject and re-run.",
  applyFailed: "Lemmaria: applying the edit failed.",
  saveFailed:
    "Lemmaria: saving the file failed (read-only?). The edit was NOT applied.",
  retryNotePrompt: "Lemmaria: what should change? (sent to the model)",

  // ── Review (review-ui.ts) ──────────────────────────────────────────────────
  staleForReview:
    "Lemmaria: the document changed since this review; run Review again.",
  retryUnavailableAdopted:
    "Lemmaria: Retry is not available for an adopted suggestion — run Review again for fresh feedback.",
  needsProseFileForReview: "Lemmaria: open a .tex or .md file to run a review.",
  /** R3: replaces a literal that shipped both languages in one string —
   *  an invariant 6 rule 2 defect the mixed-language guard could not see
   *  (its extractor stops at a nested template backtick). */
  reviewNoAnnotations: "Lemmaria: the review produced no usable annotations.",
  reviewStoppedBy: "stopped by",

  // ── The paper's entry (paper-entry.ts; ADR 0062 §2) ────────────────────────
  entryNeedsFolder:
    "Lemmaria: open a folder to choose which document is the paper.",
  entryPickTitle: "Lemmaria: the paper's main file",
  entryPickPlaceholder:
    "Which document should a blind panel read as the whole paper?",
  entryAuto: "Detect automatically",
  entryNoneFound: "nothing detected in this folder",
  entryCurrent: "current",

  // ── Compile triage (compile-ui.ts) ─────────────────────────────────────────
  needsModelForFix: "Lemmaria: set a model and its API key first.",
  noFixProduced: "Lemmaria: no fix could be produced for this finding.",
  retryUnavailableCompileFix:
    "Lemmaria: Retry is not available for a compile fix — run Compile Check again (or click Fix again) for a fresh attempt.",

  // ── Compile Check (verify-ui.ts) ───────────────────────────────────────────
  compiling: "Lemmaria: compiling to check the project",
  compilingShort: "Compiling…",
  nothingToRollBack: "Lemmaria: nothing to roll back.",
  rollbackTextGone:
    "Lemmaria: the accepted text is no longer present; not rolling back.",
  rollbackTextAmbiguous:
    "Lemmaria: the accepted text appears more than once; roll back manually.",
  rollbackSaveFailed: "Lemmaria: rollback could not be saved.",

  // ── Citations (citation-ui.ts) ─────────────────────────────────────────────
  citationsNeedProseFile: "Open a .tex or .md file to check its citations.",
  citationsLoadFailed: "Could not load this document for citation checking.",
  citationsChecking: "Lemmaria: checking citations online (metadata only)…",
  citationsApplyCorrection: "Apply a correction",
  citationsNoEditor: "No active editor.",

  // ── Venue (venue-ui.ts) ────────────────────────────────────────────────────
  venueFetchesRestricted: "fetches restricted files online",
  venuePickTemplate: "Pick a venue template",
  venueCreateHere: "Create project here",
  venueOpenFolder: "Open Folder",
  venueOpenRequirements: "Open requirements.md",
  venueCreatedCompileSkipped: "Project created; baseline compile skipped",
  venueCreatedCompileOk: "Project created — baseline compile OK",
  venueCreatedCompileFailed: "Project created, but the baseline compile FAILED",
  venueScaffolding: "Lemmaria: scaffolding from venue template…",
  venueFailed: "New from Venue failed",
  venueTemplatesFailedToLoad: "Some venue templates failed to load",

  // ── Cost (cost-ui.ts) ──────────────────────────────────────────────────────
  costThisRun: "This run",
  costToday: "Today",
  costTotal: "Total",
  costTitle: "Lemmaria cost",

  // ── PAPER.md (paper-md.ts) ─────────────────────────────────────────────────
  paperMdNeedsProseFile: "Lemmaria: open a .tex or .md file first.",
  paperMdOffer:
    "Lemmaria: no PAPER.md found — create a draft so actions know your paper's glossary and style?",
  paperMdCreate: "Create PAPER.md",

  // ── Edits view (sidebar-ui.ts) ─────────────────────────────────────────────
  editsOpen: "Open",
  /** An agent row has no ↺ of its own, so it says where its undo lives. It
   *  read "To undo: branch at that turn's message" until ADR 0057 — naming an
   *  operation the product no longer has. It was an inline ternary, i.e. the
   *  one shape this table exists to remove, which is why nothing caught it. */
  editsAgentUndoHint:
    "To undo: click ⟲ on that turn's message in the transcript to go back to before it.",

  // ── Sessions view (sessions-view.ts) ──────────────────────────────────────
  /** E6 (ADR 0058 §7): what the ` ≠` on a session row means. The row is
   *  marked when a file the session WROTE no longer holds what it wrote —
   *  including the ACTIVE row after a code-only rewind, which is the honesty
   *  the marker exists for. Granularity is the whole session, so the sentence
   *  deliberately names no file. */
  sessionOutOfSync: "Files this session wrote have since changed on disk.",
  /** The row's `command.title`. VS Code never shows it for a tree-item command
   *  — it is what a keybinding or a macro would name — but it is a string
   *  Lemmaria writes, so it is one language per reader like every other. */
  resumeSession: "Resume session",

  // ── The rewind path (session-edit-ui.ts) ──────────────────────────────────
  /** E6 (D13): the eight inline ternaries this file used to carry, in the one
   *  home whose sweeps cover them. Where E5's sentence is still true of what
   *  the arm does, its copy moves VERBATIM — a working translation is not
   *  re-written on the way into a table. */
  editPreviewGone:
    "Lemmaria: this edit can no longer be previewed (the file changed or was not found).",
  /** "before forking" until E6 — two of the three arms do not fork. */
  rewindBusy: "Lemmaria: a task is running — stop it (◼) before rewinding.",
  rewindBusyAfterConsent:
    "Lemmaria: a task started meanwhile — the rewind was cancelled.",
  rewindNoMessage: "Lemmaria: this session has no message to rewind from.",
  /** A restoring arm with nowhere to place the files. Refused up front rather
   *  than consented to and then failed: the fork-only arm is what a user with
   *  no workspace folder actually wants, and it is one row above. */
  rewindNoWorkspace:
    "Lemmaria: no workspace folder is open, so no file can be restored.",
  /** `planFor` could not build one: no session, a log it cannot read, or a cut
   *  it cannot resolve. The popover's arms come back with it (D8). */
  rewindNoPlan:
    "Lemmaria: could not work out what that message changed — the session could not be read, or that message is no longer in it.",
  /** The fork-only arm's refusal. `rewindConversation` returns nothing for a
   *  failed fork and a failed SWITCH as well as an unresolvable target, and
   *  the arm moved no file — so, unlike `rewindStuck`, nothing disagrees. It
   *  still has to SAY so (ADR 0057's honest degradation). */
  forkFailed:
    "Lemmaria: could not fork from that message — nothing was changed. Try again, or start a new session.",
  rewindStuck:
    "Lemmaria: your files were restored, but the conversation did not move — this session still has that message in it, so the thread and your files disagree. Press ⟲ on that message again, or start a new session.",
  rewindForked:
    "Lemmaria: forked from that message into a new session; the one you left is kept.",
  rewindRestored:
    "Lemmaria: your files are back to before that message. The conversation is unchanged.",
  /** The palette twin's QuickPicks (D9). These duplicate `parts/strings.ts` by
   *  DESIGN: the webview's table and the chrome's are split (ADR 0037), and a
   *  host module must not import the webview's. */
  rewindPickArm: "Fork or rewind from this message",
  rewindArmFork: "Fork conversation from here",
  rewindArmRestore: "Rewind code to here",
  rewindArmBoth: "Fork conversation and rewind code",
  rewindAskRestore: "Rewind code to this message?",
  rewindAskBoth: "Fork the conversation and rewind code to this message?",
  /** Every path is a row, so consent is given by taking one — Esc cancels,
   *  which is what makes this the same gate the card is (invariant 3). */
  rewindPickConfirm: "Pick any line to confirm, or press Esc to cancel",
  rewindWillRestore: "will be restored",
  rewindWillDelete: "will be DELETED from disk (this session created it)",
  rewindNoFiles: "No files will change.",
  /** E6 (D10): `/fork [name]`, design §3's one status message — and the busy
   *  refusal, which mirrors the rewind's rather than inventing a second voice
   *  for the same condition. */
  forkedToNewSession: "Forked to a new session.",
  forkBusy: "Lemmaria: a task is running — stop it (◼) before forking.",

  // ── Models (model.ts) ──────────────────────────────────────────────────────
  apiKeyPrompt:
    "Lemmaria: API key for the configured model provider (stored in VS Code Secret Storage)",
  apiKeySaved: "Lemmaria: API key saved.",
} as const;

const zh: Record<keyof typeof en, string> = {
  needsProseFile: "Lemmaria：请在 .tex 或 .md 文件中运行该操作。",
  needsModel: "Lemmaria：请先在 Models 标签页添加模型并设置 API 密钥。",
  needsReviewerModel:
    "Lemmaria：某位评审人所选模型未设置 API 密钥或尚未选定——请检查 Models 标签页",
  // The card and the tab's name for the role, so one reader meets one name.
  rolePdfReviewer: "PDF 评审人",
  pdfReviewerOff:
    "Lemmaria：PDF 评审已关闭，没有可运行的评审人——请在 Models 标签页的角色中开启。",
  staleForAction: "Lemmaria：文档已更改，请在新文本上重新运行该操作。",
  closestAttempt: "已显示最接近的结果——可接受，或重试并附说明",
  fixingCompileError: "Lemmaria：正在修复编译错误…",
  paperMdDraftFailed: "Lemmaria：无法生成 PAPER.md",
  diffAccept: "接受",
  diffReject: "拒绝",
  diffRetry: "重试",
  paramEnterNumber: "请输入数字",
  paramEnterWholeNumber: "请输入整数",
  paramAtLeast: "不得小于",
  paramAtMost: "不得大于",

  noProposalToAccept: "Lemmaria：没有待接受的修改建议。",
  noProposalToReject: "Lemmaria：没有待拒绝的修改建议。",
  proposalStale:
    "Lemmaria：文档在生成该建议后已更改，建议已过期。请拒绝并重新运行。",
  applyFailed: "Lemmaria：应用修改失败。",
  saveFailed: "Lemmaria：保存失败（文件只读？），修改未写入。",
  retryNotePrompt: "Lemmaria：想怎么改？（将发送给模型）",

  staleForReview: "Lemmaria：文档在本次审稿后已更改，请重新运行审稿。",
  retryUnavailableAdopted:
    "Lemmaria：已采纳的建议不支持重试——请重新运行审稿以获取新的意见。",
  needsProseFileForReview: "Lemmaria：请在 .tex 或 .md 文件中运行审稿。",
  reviewNoAnnotations: "Lemmaria：审稿未产生可用批注。",
  reviewStoppedBy: "终止于",

  entryNeedsFolder: "Lemmaria：请先打开一个文件夹，再选择论文主文件。",
  entryPickTitle: "Lemmaria：论文主文件",
  entryPickPlaceholder: "盲审小组应通读哪一份文档？",
  entryAuto: "自动检测",
  entryNoneFound: "该文件夹中未检测到",
  entryCurrent: "当前",

  needsModelForFix: "Lemmaria：请先配置模型并设置 API 密钥。",
  noFixProduced: "Lemmaria：未能为该问题生成修复方案。",
  retryUnavailableCompileFix:
    "Lemmaria：编译修复不支持重试——请重新运行编译检查（或再次点击“修复”）以获取新的修复方案。",

  compiling: "Lemmaria：正在编译检查项目",
  compilingShort: "正在编译…",
  nothingToRollBack: "Lemmaria：没有可回滚的修改。",
  rollbackTextGone: "Lemmaria：已找不到接受的文本，取消回滚。",
  rollbackTextAmbiguous: "Lemmaria：接受的文本出现多次，请手动回滚。",
  rollbackSaveFailed: "Lemmaria：回滚无法保存。",

  citationsNeedProseFile: "请打开 .tex 或 .md 文件以检查引用。",
  citationsLoadFailed: "无法加载该文档以检查引用。",
  citationsChecking: "Lemmaria：正在联网核对引用（仅发送元数据）…",
  citationsApplyCorrection: "应用修正",
  citationsNoEditor: "没有活动的编辑器。",

  venueFetchesRestricted: "在线获取受限文件",
  venuePickTemplate: "选择投稿模板",
  venueCreateHere: "在此创建项目",
  venueOpenFolder: "打开文件夹",
  venueOpenRequirements: "打开投稿要求",
  venueCreatedCompileSkipped: "项目已创建，跳过基线编译",
  venueCreatedCompileOk: "项目已创建，基线编译通过",
  venueCreatedCompileFailed: "项目已创建，但基线编译失败",
  venueScaffolding: "Lemmaria：正在从投稿模板创建…",
  venueFailed: "创建投稿项目失败",
  venueTemplatesFailedToLoad: "部分投稿模板加载失败",

  costThisRun: "本次",
  costToday: "今日",
  costTotal: "累计",
  costTitle: "Lemmaria 成本",

  paperMdNeedsProseFile: "Lemmaria：请先打开 .tex 或 .md 文件。",
  paperMdOffer:
    "Lemmaria：未找到 PAPER.md——要生成草稿以便操作了解术语与风格吗？",
  paperMdCreate: "创建 PAPER.md",

  editsOpen: "打开",
  editsAgentUndoHint: "撤销方式：在对话中该轮次的消息上点击 ⟲，回到它之前。",

  sessionOutOfSync: "该会话写入的文件之后在磁盘上已被改动。",
  resumeSession: "恢复会话",

  editPreviewGone: "Lemmaria：该编辑已无法预览（文件已变化或未找到）。",
  rewindBusy: "Lemmaria：任务运行中——请先停止（◼）再回退。",
  rewindBusyAfterConsent: "Lemmaria：任务已开始运行——回退已取消。",
  rewindNoMessage: "Lemmaria：本会话没有可回退的消息。",
  rewindNoWorkspace: "Lemmaria：未打开工作区文件夹，无法恢复任何文件。",
  rewindNoPlan:
    "Lemmaria：无法确定该消息改动了什么——会话无法读取，或该消息已不在其中。",
  forkFailed:
    "Lemmaria：无法从该消息处分叉——未做任何改动。请重试，或新建会话。",
  rewindStuck:
    "Lemmaria：文件已恢复，但对话没有移动——本会话记录中仍保留该消息，因此记录与文件不一致。请再次点击该消息上的 ⟲，或新建会话。",
  rewindForked: "Lemmaria：已从该消息处分叉为新会话；原会话已保留。",
  rewindRestored: "Lemmaria：文件已恢复到该消息之前的状态，对话保持不变。",
  rewindPickArm: "从该消息分叉或回退",
  rewindArmFork: "从此处分叉会话",
  rewindArmRestore: "将代码回退到此处",
  rewindArmBoth: "分叉会话并回退代码",
  rewindAskRestore: "将代码回退到该消息处？",
  rewindAskBoth: "分叉会话并将代码回退到该消息处？",
  rewindPickConfirm: "选择任意一行以确认，按 Esc 取消",
  rewindWillRestore: "内容将被恢复",
  rewindWillDelete: "将从磁盘上删除（本会话创建）",
  rewindNoFiles: "没有文件会被改动。",
  forkedToNewSession: "已分叉出新会话。",
  forkBusy: "Lemmaria：任务运行中——请先停止（◼）再分叉。",

  apiKeyPrompt:
    "Lemmaria：所配置模型提供方的 API 密钥（保存在 VS Code 密钥存储中）",
  apiKeySaved: "Lemmaria：API 密钥已保存。",
};

export const CHROME = { en, zh } as const;

/** Every chrome string key. Derived from `en`, which is the authority. */
export type ChromeKey = keyof typeof en;

/** One chrome string in the reader's language. */
export function tr(locale: SessionLocale, key: ChromeKey): string {
  return CHROME[locale][key];
}
