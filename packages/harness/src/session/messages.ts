/**
 * Session-path notes that reach a reader, **one language per reader**
 * (invariant 6 rule 2, ADR 0034).
 *
 * These are the `note` fields on a `ProposedEdit` or a `ScriptRunItem` — the
 * awkward case, because each is fed back to the MODEL as a tool result *and*
 * rendered to the USER in the proposal row. They resolve to the session's
 * locale and only that: the reader is one person with one display language,
 * and a model that can write a Chinese paper can read a Chinese note.
 *
 * They lived as `"english / 中文"` literals from A1b until X2. The convention
 * predates `SessionLocale` (ADR 0031) — it was the only way to reach both
 * audiences before a locale existed to pick between them, and it outlived the
 * reason for it by six milestones.
 */
import type { SessionLocale } from "../contracts/index.js";

interface SessionMessages {
  /** `create` target sprang into existence between proposal and apply. */
  editFileExists: string;
  /** The anchor no longer resolves uniquely — the file moved under us. */
  editAnchorChanged: string;
  /** Task ended while the batch was still awaiting a per-file decision. */
  editInterrupted: string;
  /** Process died while the proposal was still pending; replay says so. */
  editSessionEnded: string;
  /** A `run_script` pause that never got its answer. */
  scriptInterruptedBeforeApproval: string;
  /** The grant backing the run disappeared during the pause. */
  scriptGrantRevoked: (grantId: string) => string;
  /** Content hash moved between approval and spawn — nothing ran. */
  scriptChangedAfterApproval: (reason: string) => string;
  /** The same, as the user-facing half. */
  scriptChangedNothingRun: string;
  /** Interrupted after spawn; the tree was killed. */
  scriptInterruptedDuringRun: string;
  /** A run that replay found unfinished — never a phantom success. */
  scriptInterruptedBeforeCompletion: string;
  /** A child agent that produced no final message. */
  subtaskNoReport: string;
}

export const SESSION_MESSAGES: Record<SessionLocale, SessionMessages> = {
  en: {
    editFileExists: "file already exists at apply time",
    editAnchorChanged:
      "the file changed — the anchor no longer matches exactly once",
    editInterrupted: "task interrupted before a decision",
    editSessionEnded: "session ended before a decision",
    scriptInterruptedBeforeApproval: "interrupted before approval",
    scriptGrantRevoked: (grantId) =>
      `granted folder ${grantId} was revoked before the run`,
    scriptChangedAfterApproval: (reason) =>
      `script changed after approval — ${reason}`,
    scriptChangedNothingRun:
      "the script changed after you approved it — nothing was run",
    scriptInterruptedDuringRun: "interrupted during the run",
    scriptInterruptedBeforeCompletion: "interrupted before completion",
    subtaskNoReport: "(the subtask produced no report)",
  },
  zh: {
    editFileExists: "应用时文件已存在",
    editAnchorChanged: "文件已变化，锚点不再唯一匹配",
    editInterrupted: "决定前任务被中断",
    editSessionEnded: "决定前会话已结束",
    scriptInterruptedBeforeApproval: "批准前任务被中断",
    scriptGrantRevoked: (grantId) => `运行前授权文件夹 ${grantId} 已被撤销`,
    scriptChangedAfterApproval: (reason) => `批准后脚本已变化——${reason}`,
    scriptChangedNothingRun: "批准后脚本已被修改，未执行",
    scriptInterruptedDuringRun: "运行期间被中断",
    scriptInterruptedBeforeCompletion: "完成前被中断",
    subtaskNoReport: "（子任务没有产生报告）",
  },
};

/** The table for a locale, defaulting to English — the non-Chinese fallback. */
export const messagesFor = (locale?: SessionLocale): SessionMessages =>
  SESSION_MESSAGES[locale ?? "en"];
