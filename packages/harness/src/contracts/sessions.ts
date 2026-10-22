/**
 * Session contracts — the v0.2 agentic session layer (ADR 0014).
 *
 * Canonical source of truth (invariant 7); the architecture-design doc block
 * is commentary. Event/item stream shapes adapted from the OpenAI Codex
 * TypeScript SDK (`sdk/typescript/src/events.ts`, `items.ts`; Apache-2.0) —
 * see ADR 0014 for the adaptation record. Deliberate divergences: no shell /
 * `command_execution` item (no shell tool, stage-plan resolved Q7), no
 * auto-applied `file_change` — edits surface only as Accept-gated
 * `edit_proposal` items (invariant 3); `user_message` and `interrupted` are
 * first-class items.
 */

import type { Usage } from "./adapters.js";
import type {
  LedgerCounts,
  ModelFailureCause,
  ReviewPdfRecord,
  ReviewResult,
  VerificationCounts,
} from "./data.js";
import type { ToolName } from "./tools.js";

export type SessionId = string;

/**
 * The language model output is rendered in (ADR 0031).
 *
 * A decision the HOST makes, never one the model infers: before this, prompts
 * like the compaction handoff were one `／`-joined bilingual string ending in
 * "reply in the language the user has been writing in", and the model
 * resolved that heuristic partly from the half-Chinese prompt it was reading
 * — reliably producing Chinese output for an English-display user. Bilingual
 * stays first-class elsewhere (counting, terminology, shipped UI strings,
 * invariant 6); this type is what lets exactly one language be chosen per
 * rendered surface.
 */
export type SessionLocale = "en" | "zh";

/** Listing metadata; the first record of every session JSONL file. */
export interface SessionMeta {
  id: SessionId;
  /** First user message, whitespace-collapsed and capped for listing. */
  title: string;
  /** Absolute workspace root the session belongs to. */
  workspace: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  /**
   * Where this session was forked from (ADR 0057), absent on a session that
   * was `create`d rather than forked.
   *
   * The **immediate** parent's id — not the family root, and not a path — plus
   * where the copy stopped: the item id the fork cut before, or `null` for a
   * fork at the end. Written once with the meta record, so `index.json` stays
   * rebuildable from the JSONL (ADR 0014) and the Sessions view can nest a row
   * under its parent without opening a file.
   *
   * One field and not two: Codex separates `forked_from_id` from
   * `parent_thread_id` because a subagent's thread is a persisted peer, and
   * Lemmaria's child sessions are in-memory `TaskSessionStore`s that never
   * reach disk — so there is no second parent to name.
   */
  forkedFrom?: {
    sessionId: SessionId;
    cutBeforeItemId: string | null;
    /**
     * Which of the parent's messages the cut landed before, 1-based, counted
     * over `branchPoints` — the non-steered user messages, which is exactly
     * the population the ⟲ controls render over and therefore the number the
     * writer counts on screen (ADR 0058). Absent on a fork at the end, which
     * cut before nothing.
     *
     * Stored rather than derived, and stored as a NUMBER rather than as the
     * rendered `"(forked from 3rd message) "` prefix. Deriving it at list time
     * would open the PARENT's log once per row, which is the cost the Sessions
     * view exists without; persisting the rendered string would put an English
     * prefix in a Chinese reader's session list, which invariant 6 rule 2
     * makes a defect on sight — and one `check-mixed-language-strings` cannot
     * see, because the literal in the source is fine and the defect is on disk.
     */
    atMessage?: number;
  };
}

interface SessionItemBase {
  /** Unique within the session; assigned by the engine. */
  id: string;
}

/** What the user typed (a transcript replays the whole session, ADR 0057). */
export interface UserMessageItem extends SessionItemBase {
  type: "user_message";
  text: string;
  /**
   * True when this input joined a task already running (turn-boundary
   * steering, ADR 0015) rather than starting one. Such a message is not a
   * task boundary, so it is not a branch point (ADR 0031): branching there
   * would split a turn from its own request. Absent = a task-starting message.
   */
  steered?: boolean;
}

export interface AgentMessageItem extends SessionItemBase {
  type: "agent_message";
  text: string;
}

/** Reasoning summary (never raw thinking; ADR 0006 discipline). */
export interface ReasoningItem extends SessionItemBase {
  type: "reasoning";
  summary: string;
}

/** An allowlisted-tool invocation (produced from A1 on). */
export interface ToolCallItem extends SessionItemBase {
  type: "tool_call";
  tool: ToolName;
  argsJson: string;
  status: "in_progress" | "completed" | "failed";
  resultJson?: string;
}

/** How propose_edit batches land (ADR 0016). Default "review". */
export type SessionEditPolicy = "review" | "auto_apply";

/**
 * One proposed edit inside an edit_proposal item (ADR 0016).
 * Statuses: `pending` (awaiting decision — persisted only in the pause
 * record), `accepted` (live-only intermediate; never a persisted terminal),
 * `rejected` (user declined; `note` carries their steering), `applied`
 * (written), `stale` (apply-time revalidation failed — the file changed),
 * `invalid` (proposal-time defect: anchor not found/ambiguous, bad path,
 * create target exists, malformed entry).
 */
export interface ProposedEdit {
  /**
   * Workspace-relative path (forward or back slashes accepted; absolute or
   * `..`-escaping paths are `invalid`).
   */
  file: string;
  kind: "replace" | "create";
  /** replace: copied verbatim from the file; must occur exactly once (ADR 0007's rule). */
  anchor?: string;
  /** replace: the replacement text. */
  replacement?: string;
  /** create: the full content of the new file. */
  content?: string;
  status: "pending" | "accepted" | "rejected" | "applied" | "stale" | "invalid";
  /** Rejection note (user steering) or the honest failure reason. */
  note?: string;
  /**
   * Protected content (comments, math, citations, references, macros) this
   * edit removes **on purpose**, each entry the span's raw text (X2, ADR
   * 0033).
   *
   * This is how the model says "the user asked me to delete this". Undeclared
   * loss stays `invalid` — that is the collateral-damage guarantee D1 was
   * built for. Declared loss is allowed, and **D2 is what makes it visible**:
   * the `review` proposal row names it, and under `auto_apply` — where there
   * is no row — the per-turn `changed_files` summary does
   * (`ChangedFilesItem.files[].removesProtected`). So the intent is in front
   * of the user instead of hidden in a narrowed anchor, which is what D1's
   * withdrawn carve-out did.
   *
   * *(Between X2 and D2 this comment asserted that visibility as already
   * true. It was not: X2's task T6 never shipped, and `removesProtected`
   * reached no file under `packages/extension`. Corrected with the milestone
   * that shipped it, rather than left as the stated advantage of a mechanism
   * over the one it replaced.)*
   *
   * Absent on every edit that removes nothing, which is nearly all of them.
   */
  removesProtected?: string[];
}

/**
 * The content identity of one file either side of an applied batch (ADR 0031).
 *
 * `before: null` means the file did NOT exist — the case `git stash` could not
 * express, and the reason a rewind can now delete a created file and a
 * switch-back can re-create it. Shas index the `SnapshotStore`.
 */
export interface FileState {
  file: string;
  before: string | null;
  after: string;
}

/**
 * A propose_edit batch under the session's edit policy (invariant 3 as
 * amended by ADR 0016: no silent writes). Persisted twice under review —
 * pending at pause start, terminal after decisions — and replayEntries
 * normalizes non-terminal statuses to `stale` (an undecided proposal is
 * never dangling, never auto-applied).
 */
export interface EditProposalItem extends SessionItemBase {
  type: "edit_proposal";
  policy: SessionEditPolicy;
  edits: ProposedEdit[];
  /**
   * Per-file content identity for the edits that APPLIED (ADR 0031). Absent on
   * a batch that wrote nothing, and on every session written before ADR 0031 —
   * such nodes fold to an empty manifest and degrade honestly rather than being
   * migrated (there is no backward-compatibility burden).
   */
  fileStates?: FileState[];
}

/** Auto-apply's per-turn changed-files summary (ADR 0016). */
export interface ChangedFilesItem extends SessionItemBase {
  type: "changed_files";
  files: {
    file: string;
    edits: number;
    created: boolean;
    /**
     * Protected content the model DECLARED it was removing from this file
     * (D2 / X2's T6), deduped across the turn's edits, absent when nothing was
     * declared.
     *
     * This is what makes `auto_apply` honest. It is the policy with no human
     * in the loop, so this summary is the only report a user gets — and
     * without it a deliberate removal of a comment, formula or citation
     * reached disk unannounced, which is exactly the visibility ADR 0033 §2
     * promised when it withdrew D1's anchor carve-out.
     */
    removesProtected?: string[];
  }[];
}

export interface TodoListItem extends SessionItemBase {
  type: "todo_list";
  items: { text: string; completed: boolean }[];
}

/**
 * A context-compaction checkpoint (A2, ADR 0021). The model-generated handoff
 * summary REPLACES every earlier turn in the model-visible history; the
 * transcript keeps everything (the user's record is never edited, and the fold
 * over entries deliberately does not stop here — B4's file-operations block is
 * derived from both sides of the checkpoint).
 * `retainedItemIds` are the `user_message` items kept VERBATIM after the
 * checkpoint — the session's first message (its brief) is always among them.
 * A forked session inherits its parent's, because ADR 0057's `fork` copies the
 * prefix verbatim, which is the same guarantee ADR 0027 got from sharing a
 * root.
 * `buildConversationHistory` is the single reader of this item; nothing else
 * may reinterpret it, so a live task, a follow-up task and a resumed session
 * agree by construction about what the model sees.
 */
export interface CompactionItem extends SessionItemBase {
  type: "compaction";
  /** The handoff summary, in the language the conversation was using. */
  summary: string;
  /** `auto` = the context threshold fired; `manual` = the user asked. */
  trigger: "auto" | "manual";
  /** Ids of the `user_message` items kept verbatim (transcript order). */
  retainedItemIds: string[];
  /**
   * The occupancy that triggered it, in tokens; 0 when manual.
   *
   * **Measured where the provider reported one, ESTIMATED otherwise** (ADR
   * 0051, which widened this from "measured" only). Nothing reads this field —
   * it is a record, written by the two trigger sites and by the manual path —
   * so it carries no discriminator between the two; add one when a consumer
   * appears that needs to tell them apart.
   */
  tokensBefore: number;
  /**
   * What the summarization call itself cost. A compaction is a real, paid
   * model call — often a large one, since it reads the whole conversation —
   * so it is persisted here for the same reason `SubtaskItem.usage` is: it
   * never reaches a `turn.completed` event, and a fold that ignored it would
   * under-report the session's spend. Absent when the call reported none.
   */
  usage?: Usage;
  /**
   * Transient progress, live-only. **Absent = a real, completed checkpoint** —
   * which is the only shape that is ever PERSISTED, so every session already
   * on disk stays valid and `buildConversationHistory` needs no new branch.
   *
   * Summarization reads the whole conversation and is the slowest single call
   * in the app; before this the transcript said nothing at all until it
   * finished, so a user who ran `Lemmaria: Compact Session` (or crossed the
   * automatic threshold mid-task) watched a still window and could not tell
   * work from a hang. `running` is emitted as a live-only `item.started` and
   * `failed` as a live-only `item.updated` — both through the paths
   * `SessionEmitter` already refuses to persist — so the finished checkpoint
   * replaces the progress row in place, by id, and a failure leaves nothing
   * behind but the `compaction.failed` notice that explains it.
   */
  status?: "running" | "failed";
}

/**
 * A `run_script` invocation (ADR 0020). Persisted twice under approval —
 * `pending` at the pause, terminal after the decision/run — and replayEntries
 * normalizes non-terminal statuses (`pending`/`running`) to `failed` (a
 * process death mid-approval or mid-run replays honestly, never as a phantom
 * success). `command` is the argv the user approves, VERBATIM as shown in the
 * approval card ([interpreter, script, ...args]); the resolved absolute script
 * path is an internal spawn detail, not persisted here.
 */
export interface ScriptRunItem extends SessionItemBase {
  type: "script_run";
  /** [interpreter, script, ...args] — argv only, no shell. */
  command: string[];
  /** Granted-root id whose realpath is the cwd. */
  rootId: string;
  /** Granted-root label (UI). */
  rootLabel: string;
  status: "pending" | "running" | "completed" | "failed" | "denied";
  /**
   * The script source the user approves (ADR 0020, review #2) — capped. The
   * approval card renders it so a granted-folder file is never approved
   * sight-unseen; the run's always-allow identity hashes the full content.
   */
  scriptPreview?: string;
  /** Denial note (user steering) or the honest failure reason. */
  note?: string;
  stdout?: string;
  stderr?: string;
  /** null when the process was killed before exiting (interrupt/timeout). */
  exitCode?: number | null;
  /** True when captured output hit the cap. */
  truncated?: boolean;
  /**
   * Bytes CAPTURED on each stream (D2). B4 measured these on `ScriptRunResult`
   * — the adapter-level result — and used them to bound the model's payload,
   * but they never reached this item, so the transcript could say a run was
   * truncated without saying truncated from what. The transcript's fold
   * summary reports them, which is the only place a user sees the size of what
   * the rolling window kept.
   *
   * Captured, not produced: `stdoutBytes` is what the window held, so it
   * equals `truncated ? the cap : the whole stream`. Both are present on every
   * TERMINAL item — `ScriptRunResult` reports them as required numbers, so a
   * stream that emitted nothing carries an explicit `0` rather than an absent
   * key. They are absent only on the `pending` item persisted at the approval
   * pause, which has no run behind it yet. (The fold summary reports a count
   * only for a stream that has content, so a successful run does not read
   * `err 0`.)
   */
  stdoutBytes?: number;
  stderrBytes?: number;
}

/** One child's report-back within a spawn_subtask fan-out (A3, ADR 0022). */
export interface SubtaskReport {
  /** The child's goal, echoed so the parent correlates reports in request order. */
  goal: string;
  /**
   * `running` is a LIVE-ONLY progress state streamed via `item.updated` while the
   * fan-out is in flight (so the UI can show each child settle rather than one
   * final dump) — a persisted/completed `subtask` item never carries it; every
   * report is terminal by the time the item completes.
   */
  status: "running" | "completed" | "failed" | "interrupted";
  /** The child's final agent message — its report-back — or an honest note if none (empty while `running`). */
  summary: string;
  /**
   * The read-only tools this child was actually allowed (⊆ the parent's), plus
   * `load_skill` when — and only when — the child was equipped (R1, ADR 0059):
   * that is the tool set the child's own surface holds, and a report that
   * understated it would be the A3 review's defect.
   */
  allowedTools: ToolName[];
  /**
   * R1 (ADR 0059): the Writing Skills the parent equipped this child with, in
   * the parent's catalogue order. **Present only when non-empty**, so an
   * unequipped child's persisted report has no `skills` key and is byte-
   * identical to a pre-R1 one. The model-facing report-back never carries it —
   * the parent already knows what it asked for.
   */
  skills?: string[];
  usage?: Usage;
}

/**
 * A bounded read-only fan-out to isolated child agents (A3, ADR 0022). One item
 * per `spawn_subtask` call; each child runs its own retrieval loop in an
 * ephemeral context with a narrowed read-only allowlist and a carved budget
 * slice (invariant 5), and only these summaries return to the parent — the
 * child transcripts never flood the parent context (the CM6 rule). `running`
 * normalizes to `failed` on replay (a fan-out that never settled).
 */
export interface SubtaskItem extends SessionItemBase {
  type: "subtask";
  status: "running" | "completed" | "failed" | "interrupted";
  reports: SubtaskReport[];
  /** Summed over the children — accrued into the parent task's usage total. */
  usage?: Usage;
}

/** One panel seat's live state inside a `review` item (R3, ADR 0061). */
export interface ReviewSeatState {
  /** The seat name — the same string stamped into its concern ids. Since R9
   *  it is an ORDINAL (`reviewer_a`…), never a model (ADR 0069 §D1). */
  reviewer: string;
  status: "running" | "completed" | "failed" | "interrupted";
  /** Set when the seat's first report failed its shape check and the driver
   *  fed the interpreter's own words back inside the seat's loop (ADR 0061 §D6). */
  retried?: true;
  usage?: Usage;
  /**
   * R9 (ADR 0069 §D4): the model id this reviewer ran on — the binding's
   * `model`, the same string the host charges its usage against. The PARENT's
   * id when the reviewer inherited it.
   *
   * Required, because there is no backward-compatibility burden and a panel
   * whose record could omit the model would make R5's hivemind measurement
   * unreadable. A `review` item persisted BEFORE R9 carries none; replay
   * normalizes that to `""`, and every surface renders the model by exception,
   * so an empty one simply does not appear.
   */
  model: string;
  /**
   * R9: present only when `classifyModelForSession(model)` is `"unverified"`
   * (ADR 0023) — the same two-verdict fact the task-level notice states once,
   * restated per reviewer because a panel may MIX models.
   *
   * Never a prediction of failure; there is no `below`. The task notice
   * `model.unverified` still fires once per task and never on a child (ADR 0023
   * §5), so this is where a mixed panel's per-reviewer verdict lives.
   */
  unverified?: true;
  /**
   * X5 (ADR 0074 §8): what this seat's report came to, counted by the harness.
   * Absent when no report was read (a seat that failed, was interrupted, or
   * whose answer never parsed).
   *
   * `firstPass` is the FIRST answer's counts, present only when that answer
   * parsed and the one re-ask then fired — so *before and after the correction
   * round* is read off ONE run rather than two. `firstPass` present therefore
   * implies `retried: true`; the converse is false, because a re-ask over an
   * unparseable answer has nothing countable to remember.
   */
  ledger?: LedgerCounts & { firstPass?: LedgerCounts };
  /**
   * X5 (ADR 0074 §8): this seat's `usage` carries tokens but no `costUsd`,
   * because its model is unpriced — so its cost is **UNKNOWN, never zero**.
   * Present only when true, like `unverified`.
   *
   * The aggregate cost UI has always been honest about this (`engine/cost.ts`
   * renders *"$0.500 (+2 unpriced)"*); the persisted record was not, because
   * `sumUsage` carries a `costUsd` whenever ANY part had one. This is the
   * per-seat fact that makes `ReviewItem.usage` readable as the lower bound it
   * is.
   */
  unpriced?: true;
  /**
   * V1 (ADR 0076): what the verifier's answers came to. Present only on the
   * verifier's own row (`ReviewItem.verifierSeat`), never on a reviewer's.
   */
  verification?: VerificationCounts;
  /**
   * V2 (ADR 0078 §D8): how many results this seat's literature searches had
   * removed because they were the reviewed manuscript itself, summed over
   * every search it ran.
   *
   * Present only when greater than zero, so a seat whose searches never met
   * the paper serializes exactly as it did before V2. It is what the live tier
   * reads to show the guard fired; **no surface renders it** (a recorded
   * deliberate limit).
   */
  ownTitleWithheld?: number;
  /**
   * V5 (ADR 0087 §7): what this seat's literature searches came to, counted
   * by the driver from the seat's transcript before it is discarded.
   * `attempted` is every `literature_search` call the seat made; `answered`
   * is every completed call in which at least one source did not fail (or,
   * from a provider that reports no per-source statuses, which returned a
   * results list).
   *
   * Present on every reviewer row — and the PDF seat's — that a V5 driver
   * settles as completed; absent on rows stored before it, and an absent
   * field imposes nothing: the scorecard's *not assessed — no literature* is
   * read only from `answered === 0` on a field that is there.
   */
  searches?: { attempted: number; answered: number };
}

/**
 * One model's answer to the panel's pre-run check (X5, ADR 0074 §6).
 *
 * Before any reviewer is paid for, the driver sends each DISTINCT model one
 * minimal request. Any failure refuses the whole panel: the failure this
 * exists to prevent is an authorised-but-unfunded key, where the author pays
 * for a panel twice, and a refusal costs nothing.
 */
export interface ReviewPreflight {
  /** The binding's model id — the same string `ReviewSeatState.model` carries,
   *  and the one the host charges this request's usage against. */
  model: string;
  status: "ok" | "failed";
  /** On `"failed"`: the class, and the provider's own sentence. */
  cause?: ModelFailureCause;
  /** On `"ok"`, when the adapter reported one. Real tokens, counted once. */
  usage?: Usage;
}

/**
 * One run of the blind review panel (R3, ADR 0061) — the persisted record of a
 * `/review`. Distinct from `subtask` on purpose: a panel is not the user's
 * exploration, its seats are never shown as reports, and what it leaves behind
 * is a `ReviewResult` — located concerns, a synthesis, and the honesty record
 * of what it could not do.
 *
 * The driver emits it `running` before the seats start, `updated` as each seat
 * settles, and terminal with the result. `running` normalizes to `failed` on
 * replay, exactly as `subtask` does (a panel that never settled), and its seats
 * with it.
 */
export interface ReviewItem extends SessionItemBase {
  type: "review";
  status: "running" | "completed" | "failed" | "interrupted";
  /**
   * Which review of this session this is: 1 for the first panel that ran, 2
   * for the next, and so on (ADR 0062 §1). Stamped once, when the panel is
   * about to start, so the transcript card carries it from the first frame.
   *
   * **A panel a precondition refused carries none**, and that is the rule
   * rather than an omission: a version is a thing the user can go back to, and
   * a review that never ran is not one. So the sequence has no holes, and
   * counting the versioned items is what produces the next number.
   */
  version?: number;
  /** When the panel started, epoch milliseconds — the version's date tag. It
   *  is persisted because a resumed session re-presents its reviews, and a
   *  date the host stamped at re-presentation would say "today" for all of
   *  them. Present on a refused panel too: it is when the user asked. */
  at?: number;
  /** The protocol skill every seat was made to load (`blind-reviewer`). */
  skill: string;
  /** The user's `/review` argument, verbatim (invariant 6 rule 1). */
  focus?: string;
  seats: ReviewSeatState[];
  synthesis?: "pending" | "running" | "completed" | "missing";
  /**
   * R9 (ADR 0069 §D4): the cross-review child, recorded in the SAME shape as a
   * reviewer (`reviewer: "synthesis"`), present from the moment it starts.
   *
   * Its own model matters for the same reason a reviewer's does — a user may
   * bind the cross-review to a stronger model than the panel — and without it
   * the one child whose whole job is reading across the others would be the
   * one child the record could not price or attribute.
   */
  synthesisSeat?: ReviewSeatState;
  /**
   * V1 (ADR 0076): where the panel's verification stands. `off` — the user
   * turned it off; `skipped` — nothing was located, so there was nothing to
   * check; `missing` — it did not run or did not finish, and the result's
   * `verification_missing` limit says why. Absent on a panel stored before V1.
   */
  verification?:
    | "pending"
    | "running"
    | "completed"
    | "missing"
    | "off"
    | "skipped";
  /**
   * V1 (ADR 0076): the verifier, recorded as ONE sibling seat
   * (`reviewer: "verifier"`) however many chunks it ran in — one model is
   * charged, and chunks are the driver's business. A sibling and not a fourth
   * `seats` row for `synthesisSeat`'s three reasons: the host would charge it
   * twice, the tab would render it as a reviewer that raised no concern, and
   * the eval's instruments would count it as a reviewer. Absent when no
   * verifier child ran.
   */
  verifierSeat?: ReviewSeatState;
  /**
   * V4 (ADR 0081): the PDF reviewer, recorded as ONE sibling seat
   * (`reviewer: "pdf_reviewer"`) and never a member of `seats` — for the four
   * reasons ADR 0074 §8 gave the cross-review its sibling: `seats` is what the
   * panel line counts as reviewers, what the distinct-model count reads, what
   * the eval's agreement pairs iterate, and what the progress block chips one
   * by one. Its concerns join `result.annotations` like a reviewer's. Absent
   * when no PDF reviewer ran.
   */
  pdfSeat?: ReviewSeatState;
  /**
   * V4 (ADR 0081): the compiled PDF this review read — where it came from, the
   * deterministic facts about it, and the pages the PDF reviewer viewed.
   * Absent when no PDF was resolved (the result's limits say why) and when the
   * user switched the PDF reviewer off.
   */
  pdf?: ReviewPdfRecord;
  /** V4 (ADR 0081): a `/review-pdf` run — the compiled paper reviewed alone,
   *  with no reviewers, no verifier and no cross-review. */
  pdfOnly?: true;
  /**
   * X5 (ADR 0074 §6): one row per DISTINCT model the panel was about to use,
   * from the pre-run check. Present whenever the preflight ran — including on
   * the refusal it produced, which is the case it exists for. Absent on a
   * panel refused by an earlier precondition (no skill, no manuscript), which
   * never reaches it.
   */
  preflight?: ReviewPreflight[];
  /** Present from `completed`/`interrupted`; absent while running or on `failed`. */
  result?: ReviewResult;
  /**
   * Summed over the seats, the synthesis, the verifier (V1) and the preflight,
   * so the host can charge it.
   *
   * **`costUsd` sums the PRICED seats only, and is a lower bound whenever any
   * seat is `unpriced`** (X5, ADR 0074 §8): `sumUsage` carries a cost when any
   * part had one, so a panel mixing a priced and an unpriced model produces a
   * number that is real but incomplete. The per-seat `unpriced` flag is what
   * says so; a reader that shows this total without it shows a cost as if it
   * were the whole cost.
   */
  usage?: Usage;
}

/**
 * A root-scoped external read grant (ADR 0019). Read-only by construction —
 * only read tools accept a `root` argument; the write path stays
 * workspace-rooted (ADR 0018).
 */
export interface GrantedRoot {
  /** Stable short id the model addresses the root by (g1, g2, …). */
  id: string;
  /** Realpath-canonicalized absolute path, fixed at grant time. */
  path: string;
  /** Human label (folder basename) for UI + prompt. */
  label: string;
}

/**
 * Persisted record of a grant change (ADR 0019). Grants persist with the
 * session: `activeGrants` folds grant_update items in entry order into the
 * active set, so a resumed session retains its grants by construction — and
 * since ADR 0057 a fork inherits exactly the grants that stood at its cut,
 * because the copied prefix carries their records. A grant given or revoked
 * after the fork binds only the session it was made in.
 */
export interface GrantUpdateItem extends SessionItemBase {
  type: "grant_update";
  action: "added" | "revoked";
  grant: GrantedRoot;
}

/**
 * A user interruption. First-class by design (S4: the discarded partial turn
 * is the intended outcome, not an error).
 */
export interface InterruptedItem extends SessionItemBase {
  type: "interrupted";
}

export interface SessionErrorItem extends SessionItemBase {
  type: "error";
  message: string;
}

/**
 * An honest engine notice (ADR 0015): budget/context stops and the
 * transient-retry note. `message` renders in exactly ONE language, the reader's
 * (invariant 6 rule 2, ADR 0034) — the CLI from `NOTICE_MESSAGES`, the webview
 * from its own table keyed by `code`. It used to be one `"english / 中文"`
 * string, and this comment used to say so; X2/D4 made that false and R3 (ADR
 * 0061) corrected the comment while adding the three `review.*` codes below.
 */
export interface NoticeItem extends SessionItemBase {
  type: "notice";
  code:
    | "budget.turns"
    | "budget.tool_calls"
    | "budget.output_tokens"
    | "context.limit"
    // A2: compaction was attempted and failed — the session falls back to the
    // honest context.limit stop, never a silent continue.
    | "compaction.failed"
    // B2 (ADR 0026): a retry is SCHEDULED. `n` is the delay, in whole seconds,
    // the loop is about to wait — jitter already applied, so the number is the
    // one actually waited. The UI also treats this code as the signal to drop
    // the discarded partial turn.
    | "stream.retried"
    // B2: the retry budget is spent. `n` is the number of attempts made,
    // including the first — distinct from `provider.quota`, which never tried.
    | "stream.retry_failed"
    // B2: the provider refused for a quota/billing reason. Retrying cannot fix
    // it, so nothing was retried; the user has an action to take outside
    // Lemmaria, which is why this is not folded into a generic failure.
    | "provider.quota"
    // A6 (ADR 0023): the configured model is not one Lemmaria has verified for
    // agentic sessions. Honest uncertainty, NOT a prediction of failure —
    // there is deliberately no "below the floor" code.
    | "model.unverified"
    // A6: the model's answer hit the PER-TURN output cap and was cut off, and
    // any tool call it was mid-way through writing was discarded. Distinct from
    // `budget.output_tokens`, which means the whole task's budget is spent.
    // B2 narrowed it: this is now the case where the truncated turn carried NO
    // tool call, so there is nothing to re-issue and the task ends.
    | "turn.truncated"
    // B2 (ADR 0026): the turn was cut off while it still had tool calls, so
    // every one of them was failed back with "re-issue with complete
    // arguments" and the task CONTINUES. `n` is how many were failed.
    | "turn.truncated_recovered"
    // R3 (ADR 0061): `/review` could not run a panel because the protocol skill
    // `blind-reviewer` is not in this task's offered set — the user disabled the
    // bundled skill, or the host loaded none. A panel without its protocol is
    // three unguided seats, which is not the thing that was asked for.
    | "review.skill_missing"
    // R3: `/review` found no manuscript to review — the host passed no workspace,
    // or the folder holds no paper. Honest refusal, never an invented entry.
    | "review.no_manuscript"
    // R3: the per-seat output-token carve fell below the floor a seat needs to
    // read a manuscript and write a ledger. `n` is the carve. A WARNING, not a
    // stop: the budget is the user's dial (invariant 5), so the panel still
    // runs and a starved seat reports itself missing rather than being refused.
    | "review.seat_budget"
    // R9 (ADR 0069 §D2): the host asked for more reviewers than `MAX_FAN_OUT`,
    // so the request was clamped down to it and the extra reviewers were
    // dropped. `n` is the ceiling. A WARNING, not a stop, and the same shape as
    // `review.seat_budget`: an action can only ask for LESS (invariant 5), and
    // a clamp the user is not told about is a panel quietly smaller than the
    // one their Models tab shows.
    | "review.reviewers_clamped"
    // X5 (ADR 0074 §4): the entry's include graph could not be resolved — no
    // host reader, or no adapter covers this entry — so the panel fell back to
    // the suffix glob and may be reading files that are not part of this paper.
    // `n` is how many files it collected. A WARNING, not a stop: the glob is
    // what shipped before X5 and it still reviews the paper.
    | "review.manuscript_unresolved"
    // X5 (ADR 0074 §4): `n` files the manuscript declares could not be read, so
    // the panel reviewed the paper without them. A WARNING: a paper missing one
    // `\input` is still a paper, and refusing would be worse than saying so.
    | "review.manuscript_incomplete"
    // X5 (ADR 0074 §6): the pre-run check — the three STOP notices, one per
    // failure class present, `n` = how many distinct models were in it. All
    // three refuse the panel BEFORE any reviewer is paid for, which is the
    // whole point: a panel the author pays for twice is what they prevent.
    //
    // Quota, credit or plan allowance. Retrying cannot help.
    | "review.model_quota"
    // Could not be reached. The SDK's own retries already ran.
    | "review.model_unreachable"
    // Rejected the check outright — a wrong model id, endpoint or key.
    | "review.model_refused"
    // V1 (ADR 0076): the verifier's output-token carve fell below
    // `PANEL_SEAT_TOKEN_FLOOR`. `n` is the carve. A WARNING, not a stop, for
    // `review.seat_budget`'s reason word for word: the budget is the user's
    // dial, and a starved verifier reports itself through `no_report`.
    | "review.verifier_budget";
  message: string;
  /**
   * The number the message names (a budget, a delay, a count), carried so a
   * localizing UI can render it too (B2, ADR 0026).
   *
   * Before this, `emitNotice(code, n)` interpolated `n` into the harness's
   * bilingual fallback and then threw it away — which is why every webview
   * notice string is number-free, including the budget ones that are *about* a
   * number. Optional because most notices have none.
   */
  n?: number;
}

/** The typed transcript entries a UI renders. */
export type SessionItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | EditProposalItem
  | ChangedFilesItem
  | TodoListItem
  | CompactionItem
  | ScriptRunItem
  | SubtaskItem
  | ReviewItem
  | GrantUpdateItem
  | InterruptedItem
  | SessionErrorItem
  | NoticeItem;

/**
 * The typed event stream every UI is a projection of — of ONE BRANCH of it
 * (ADR 0027): the session is a tree, and a projection is a fold over the walk
 * from its leaf to the root. `item.updated` carries in-flight deltas (S4
 * finding 1) and is never persisted (ADR 0015); the `task.*` events bound one
 * user-input-triggered task — with multi-turn tasks (A1a) the busy state is
 * task-scoped, not turn-scoped. `task.completed` is always delivered, whatever
 * fails (the A0 P1 guarantee extended).
 */
export type SessionEvent =
  | { type: "task.started" }
  | {
      type: "task.completed";
      status: "completed" | "failed" | "interrupted";
    }
  | { type: "turn.started"; turn: number }
  | { type: "turn.completed"; turn: number; usage: Usage }
  | { type: "turn.failed"; turn: number; error: string }
  | { type: "item.started"; item: SessionItem }
  | { type: "item.updated"; item: SessionItem }
  | { type: "item.completed"; item: SessionItem };

/**
 * Per-task budget ceilings (invariant 5; ADR 0015). Wall-clock is
 * deliberately absent — human-in-the-loop pauses make elapsed time
 * meaningless as a runaway guard.
 */
export interface SessionTaskBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
}

/**
 * One line of a session's append-only JSONL transcript file (ADR 0014, made a
 * tree by ADR 0027 and made linear again by ADR 0057).
 *
 * A file is a `meta` record followed by `event` records and, from ADR 0058,
 * `title` records, in the order they happened. ADR 0027's `leaf` record kind
 * and its `parentId` link are both gone, because a rewind now writes a NEW
 * session file holding a verbatim copy of the prefix (`SessionStore.fork`)
 * rather than moving a pointer inside this one.
 *
 * A `title` record is how a session gets named AFTER its meta was written
 * (ADR 0058): a rewind fork is born untitled, because at fork time the child
 * has no message of its own, and its first send names it. Latest-wins on load,
 * and it is a PARSED record, not an unknown one — `skippedLines` must stay 0
 * over a titled session or the blob-GC sweep, which fails closed on any
 * skipped line, stops reclaiming snapshots for good. Adapted from Pi's
 * `session_info { name? }` append (MIT); Codex keeps names in a side index
 * instead, which Lemmaria deliberately does not — one file stays
 * self-contained and the index stays rebuildable (ADR 0014).
 *
 * An `event` record still carries its own MINTED `id`. Reusing the item's id
 * would be tidier, but `edit_proposal`, `script_run` and `subtask` items are
 * each persisted TWICE (pending, then terminal), so two records would carry
 * one id and the second would be unreachable. An item id a caller already
 * holds (`retainedItemIds`, the ⟲ control) resolves to a POSITION through
 * `cutBeforeItem`, which stores nothing and therefore cannot drift. Turn and
 * task records are records too, which is what keeps turn usage foldable.
 *
 * `version` marks the format. A file written in any other version is refused,
 * not migrated (there is no backward-compatibility burden; Lemmaria is
 * unreleased) — ADR 0027 §10's rule, re-applied by ADR 0057.
 */
export type SessionRecord =
  | {
      at: string;
      kind: "meta";
      version: SessionFormatVersion;
      meta: SessionMeta;
    }
  | {
      at: string;
      kind: "event";
      id: string;
      event: SessionEvent;
    }
  | {
      at: string;
      kind: "title";
      title: string;
    };

/** The only session file format this build reads or writes (ADR 0058). */
export type SessionFormatVersion = 4;
export const SESSION_FORMAT_VERSION: SessionFormatVersion = 4;

/**
 * One persisted event of a session, in file order. A session's `entries` are
 * the whole conversation, linearly — there is no walk and no leaf to pick one
 * out of a tree (ADR 0057).
 */
export interface SessionEntry {
  id: string;
  event: SessionEvent;
}

/** Per-edit approval decision, parallel to EditProposalItem.edits (ADR 0016). */
export interface EditDecision {
  accept: boolean;
  /** Optional rejection note — returned to the model as steering. */
  note?: string;
}

/**
 * Host seam for the write path (ADR 0016). The extension implements it over
 * VS Code buffers; a future CLI over fs. All paths workspace-relative. The
 * loop owns policy branching, validation, revalidation, decision bookkeeping,
 * and event persistence (invariant 1); the host provides IO + the approval
 * UI. No editHost configured → propose_edit is not offered and the envelope
 * prompt keeps the read-only honesty.
 */
export interface SessionEditHost {
  /** Read at each propose_edit call — the policy is mid-session switchable. */
  policy(): SessionEditPolicy;
  /** undefined = file does not exist. Open dirty buffers win over disk. */
  readFile(file: string): Promise<string | undefined>;
  writeFile(file: string, content: string): Promise<void>;
  fileExists(file: string): Promise<boolean>;
  /**
   * Review policy: present the pending batch; resolve with decisions parallel
   * to item.edits. The loop races this against the task's AbortSignal — an
   * unresolved promise cannot wedge an interrupted task.
   */
  requestDecisions(item: EditProposalItem): Promise<EditDecision[] | undefined>;
}

/** The user's decision on a pending run (ADR 0020). Parallel to EditDecision. */
export interface ScriptApproval {
  approve: boolean;
  /** Denial note — returned to the model as steering. */
  note?: string;
}

/** Captured result of a spawned run. Never thrown — a spawn failure sets `error`. */
export interface ScriptRunResult {
  /**
   * B4 (ADR 0029): the captured output is the **tail** of each stream, not the
   * head. A4b kept the first bytes, which is exactly backwards for the case
   * that matters — a script that prints a lot and then fails puts its error
   * last.
   */
  stdout: string;
  stderr: string;
  /** null = killed before exit (interrupt/timeout). */
  exitCode: number | null;
  /** True when either stream produced more than the capture kept. */
  truncated: boolean;
  /**
   * B4: total bytes each stream PRODUCED, whether or not they survived the
   * capture. `truncated` alone cannot say which stream was cut or by how much,
   * and a caller that must tell the model what it is missing needs the size.
   */
  stdoutBytes: number;
  stderrBytes: number;
  /** Present when the process could not be spawned or was killed. */
  error?: string;
}

/**
 * Host seam for script execution (ADR 0020). The extension implements it over
 * VS Code (approval webview + per-session always-allow) and `@lemmaria/adapters`
 * `spawnScript`; a future CLI over a prompt + spawn. The loop owns the
 * interpreter-allowlist check, granted-cwd + script containment, the approval
 * round-trip, the script_run items, and budget (invariant 1). No scriptHost
 * (or an empty allowlist) → run_script is not offered and the envelope says so.
 */
export interface SessionScriptHost {
  /** Interpreter basenames the user allows (e.g. ["python","python3","Rscript"]). */
  interpreters(): string[];
  /**
   * Present the pending run for approval; resolve approve/deny (+ note). The
   * loop races this against the AbortSignal — a wedged host cannot wedge an
   * interrupted task. `scriptHash` keys the host's per-session always-allow
   * cache (content + argv shape); the host may resolve immediately on a hit.
   */
  requestApproval(
    item: ScriptRunItem,
    scriptHash: string,
  ): Promise<ScriptApproval | undefined>;
  /**
   * Run the resolved argv in `cwd` (a granted root's realpath). Captures
   * stdout/stderr with caps; kills the process tree when `signal` aborts.
   * Never throws — a spawn failure returns `{ error }`.
   */
  run(
    argv: string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<ScriptRunResult>;
}
