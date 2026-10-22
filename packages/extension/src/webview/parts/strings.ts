// The webview's locale-keyed string table (invariant 6; U0's open question
// resolved: the panel renders the editor's language rather than cramming both
// into 366px).
//
// It lives here rather than in main.ts (D2, ADR 0037) for one reason: every
// locale claim in the milestone gate — "the removal line is Chinese under zh,
// with no English in it" — is only assertable offline if the table itself is
// importable. main.ts is not: it calls `acquireVsCodeApi()` at module scope
// and exports nothing.
//
// ONE home. main.ts imports `STR` and `tr` from here; there is no second
// table, and `t()` over there keeps its signature so no call site moved.
import type { SessionLocale } from "@lemmaria/harness";
// One home for the floor label (review, Minor 10): the ADR 0023 table and the
// text shown to the user must never drift apart.
import {
  L2_FLOOR_LABEL,
  L2_FLOOR_LABEL_ZH,
} from "@lemmaria/harness/model-floor";

export const STR = {
  en: {
    tabs: ["Assistant", "Citations", "Models", "Venue", "Review", "Compile"],
    history: "History",
    compacted: "Context compacted",
    compactedManual: "compacted on request",
    compactedAuto: "compacted at the context limit",
    // The Claude Code `/compact` convention: the work announces itself while
    // it runs, in the transcript, and the finished card takes its place.
    compacting: "Compacting conversation…",
    compactingAuto: "context limit reached — compacting conversation…",
    ringUsed: "Context window used",
    ringUnknown: "Context-window usage — not measured yet",
    new: "New",
    settings: "Settings",
    quickActions: "Quick actions · on selection",
    // P1b removed `heroTitle` / `heroSub`. The slot they filled now carries the
    // branded welcome below (operator direction: one intro region, not two).
    // Their no-silent-writes claim survives in `welcomeBody`; the "select text
    // first" hint does not, and `quickActions` above is the only thing left
    // saying it.
    placeholder: "Describe an edit, or ask Lemmaria…",
    // P1: the empty Assistant panel. It used to render nothing at all, so a
    // first-run reader had no idea what the panel was for.
    welcomeTitle: "Ask Lemmaria about your paper",
    welcomeBody:
      "Describe an edit, run a review, or check your citations. Every change arrives as a diff you approve.",
    sessionThinking: "Thinking…",
    sessionError: "Error",
    sessionInterrupted: "Interrupted",
    stop: "Stop",
    toolRunning: "running…",
    toolFailed: "failed",
    plan: "Plan",
    editProposal: "Edit proposal",
    editReplace: "replace",
    editCreate: "new file",
    editViewDiff: "View diff",
    editAccept: "Accept",
    editReject: "Reject",
    editAcceptAll: "Accept all",
    editRejectNote: "Why? This guides the agent",
    editApplied: "applied",
    editRejected: "rejected",
    editStale: "stale — the file changed",
    editInvalid: "invalid",
    editUnitPlural: "edits",
    // E4 (ADR 0054): ONE title, on every branch point, promising only what is
    // true in every case. It replaced B6's pair — "Restore files to before this
    // message" (⟲) and "Branch the conversation from this message" (⑂) — whose
    // split asked the reader to decode what the turn had written before they
    // could click.
    //
    // E7 (ADR 0055) supersedes §2 of that ADR and splits the one key in two,
    // on E4's own rule: a key whose string does not say what the control says
    // is renamed, not re-worded in place. The control may now be displaying a
    // number, and a tooltip that ignores the number beside it is the same
    // defect one layer down. Each string is true exactly when it is used, and
    // the zero case says "none" in words rather than leaving absence to carry
    // the difference between none and not-computed.
    //
    // The consent card is still where the FILES are named, by path, at the
    // moment of consent — these count, they do not list.
    //
    // E6 (ADR 0058 §4) re-words both, on that same rule. The control now opens
    // a MENU, and two of its three arms write no file at all: "go back" and
    // "will change" promised a file change the fork-only arm does not make.
    // The count is the restoring arms' plan, and the string now says so.
    rewindTitleNoFiles:
      "Fork or rewind from this message — rewinding code would change no files",
    rewindTitleFiles:
      "Fork or rewind from this message — rewinding code would change {n} file(s)",
    // E6 (D8): the three arms, the two-step consent card behind the restoring
    // pair, and the cap its list shares with `describeRestore`.
    rewindArmFork: "Fork conversation from here",
    rewindArmRestore: "Rewind code to here",
    rewindArmBoth: "Fork conversation and rewind code",
    rewindAskRestore: "Rewind code to this message?",
    rewindAskBoth: "Fork the conversation and rewind code to this message?",
    rewindDoRestore: "Rewind code",
    rewindDoBoth: "Fork and rewind",
    // Deliberately the modal's own wording, so the card, the QuickPick twin and
    // the post-restore caveat cannot describe one plan three ways.
    rewindCardRestored: "{n} file(s) will be restored:",
    rewindCardDeleted:
      "{n} file(s) will be DELETED from disk (this session created them):",
    rewindMore: "…and {n} more",
    rewindNoFiles: "No files will change.",
    changedFiles: "file(s) changed",
    changedNew: "new",
    // D2 / X2's T6: what the model declared it was removing on purpose. Shown
    // on the review row AND in auto_apply's summary — the second is the one
    // that matters, because there is no human in that loop.
    editRemovesProtected: "declared removed:",
    // D2 (CHAT-5): decisions post as one batch, so a decided file is still
    // waiting on its siblings. Saying nothing is what made Accept look broken.
    editWaitingForOthers: "waiting for {n} more file(s)",
    permReview: "Ask before edit",
    permAuto: "Auto",
    permReviewDesc: "Show every diff and wait for Accept",
    permAutoDesc: "Apply edits immediately",
    grantAdd: "＋ Grant folder",
    grantAddTip:
      "Grant this session read-only access to a folder (codebase, results dir…)",
    grantRevoke: "Revoke access",
    grantAdded: "Granted read-only access",
    grantRevoked: "Revoked access",
    scriptRun: "Run script",
    scriptApprove: "Approve",
    scriptDeny: "Deny",
    scriptDenyNote: "Reason (optional)",
    scriptAlwaysAllow: "Always allow this script this session",
    scriptRunning: "Running…",
    scriptInCwd: "in",
    // D2 (CHAT-4): the output fold's summary.
    scriptOutput: "Output",
    scriptExit: "exit",
    scriptKilled: "killed before exiting",
    scriptStdout: "out",
    scriptStderr: "err",
    scriptBytes: "bytes",
    scriptTruncated: "truncated",
    // ADR 0040: the Markdown code block's Copy affordance. The Claude Code
    // extension keeps ONE label across both states and swaps only the icon; a
    // second label is the deliberate divergence, because a button whose only
    // feedback is a glyph reports nothing to a screen reader.
    mdCopy: "Copy code",
    mdCopied: "Copied",
    scriptPermsWarning:
      "⚠ Runs with your full OS permissions — file access and network included.",
    subtaskExplored: "subtask(s) explored",
    context: "CONTEXT",
    selection: "Selection",
    v03: "v0.3",
    later: "Later",
    steerPlaceholder: "Steer Lemmaria — joins at the next turn boundary…",
    steeringQueuedTip:
      "Queued: the running task picks this up at its next turn boundary.",
    reasoning: "Thinking",
    unknownItem: "Unrecognized transcript item",
    toolArgs: "args",
    toolResult: "result",
    toolChildren: "subtasks",
    toolEdits: "edits",
    toolSteps: "steps",
    toolErrNotFound: "not found",
    toolErrDenied: "not permitted",
    toolErrTooLarge: "too large",
    toolErrRefused: "refused",
    toolErrRateLimited: "rate limited",
    toolErrUnavailable: "unavailable",
    toolErrInvalid: "invalid arguments",
    toolMatches: "matches",
    toolResults: "results",
    toolFiles: "files",
    toolChars: "chars",
    toolTruncated: "truncated",
    toolExcluded: "hidden (.gitignore / skipped)",
    toolDegraded: "no answer from",
    // R4: the pointer is the command's OWN contributed label, copied from
    // `package.nls.json`, so the reader finds the entry in their palette. The
    // English value carries its own leading space because half-width
    // parentheses need one; the Chinese full-width pair does not, and putting
    // the separator in the renderer instead would put typography in code.
    toolDegradedAnonymous:
      " (no API key — Lemmaria: Set Semantic Scholar API Key)",
    noticeBudgetTurns:
      "Stopped: this task reached its turn budget. Send another message to continue.",
    noticeBudgetToolCalls:
      "Stopped: this task reached its tool-call budget. Send another message to continue.",
    noticeBudgetTokens:
      "Stopped: this task reached its output-token budget. Send another message to continue.",
    noticeContextLimit:
      "Stopped: the conversation filled the model's context window. Compact the session or start a new one.",
    noticeCompactionFailed:
      "Could not summarize the conversation — nothing was discarded.",
    // B2 (ADR 0026): scheduled, not past — {n} is the delay about to be waited.
    noticeStreamRetried: "Connection problem — retrying in {n}s.",
    noticeStreamRetryFailed:
      "Could not reach the model after {n} attempt(s). The provider's message is below.",
    noticeProviderQuota:
      "The provider refused this request for a quota or billing reason, so retrying cannot help. Check your plan, credit balance or API key.",
    // A6 (ADR 0023). Honest uncertainty — NOT a prediction that it will fail.
    noticeModelUnverified: `Lemmaria has not verified this model for agentic sessions — it may not hold the tool-calling contract. Verified: ${L2_FLOOR_LABEL}.`,
    noticeTurnTruncated:
      "The answer hit this turn's length limit and was cut off; anything still being written — including an unfinished edit proposal — was discarded. Ask for smaller steps.",
    noticeTurnTruncatedRecovered:
      "The answer hit this turn's length limit while calling {n} tool(s). None were run — their arguments may be incomplete — and the model has been asked to re-issue them.",
    // R3 (ADR 0061): the review panel's three preconditions.
    noticeReviewSkillMissing:
      "Review needs the bundled blind-reviewer protocol, and it is not available in this session. Re-enable it in the Skills list and run the review again.",
    noticeReviewNoManuscript:
      "Review found no manuscript in this workspace to read. Open the folder that holds the paper, or focus its main file, and run the review again.",
    noticeReviewSeatBudget:
      "Each reviewer would get only {n} output tokens, below what reading a manuscript and writing up its concerns usually needs. The review will run anyway; raise lemmaria.budget.maxTokens if reviewers come back empty.",
    noticeReviewReviewersClamped:
      "More reviewers were asked for than one review can run at once, so only the first {n} took part. Ask for {n} or fewer to choose which ones run.",
    // X5 (ADR 0074): the manuscript's shape — both warn and run.
    noticeReviewManuscriptUnresolved:
      "The manuscript's include structure could not be resolved, so the panel is reading every .tex, .md and .bib file in the folder ({n}) — files that are not part of this paper may be among them.",
    noticeReviewManuscriptIncomplete:
      "{n} file(s) the manuscript includes could not be read, so the panel reviewed the paper without them.",
    // X5: the pre-run check's three stops, each before any reviewer is paid for.
    noticeReviewModelQuota:
      "The review did not start: {n} of the panel's models refused a one-word check for a quota or billing reason. Retrying cannot help — check that model's plan, credit balance or API key. No reviewer was run.",
    noticeReviewModelUnreachable:
      "The review did not start: {n} of the panel's models could not be reached for a one-word check. No reviewer was run — try again shortly.",
    noticeReviewModelRefused:
      "The review did not start: {n} of the panel's models rejected a one-word check. Check that model's id, endpoint and API key in the Models tab. No reviewer was run.",
    // V1 (ADR 0076): `noticeReviewSeatBudget`'s sentence, with verification as
    // its subject.
    noticeReviewVerifierBudget:
      "Verification would get only {n} output tokens, below what checking the reviewers' concerns against the manuscript usually needs. The review will run anyway; raise lemmaria.budget.maxTokens if concerns come back not checked.",
    costTipPriced: "This session's spend — tokens in/out and the accrued cost",
    costTipTokens:
      "This session's tokens in/out. No cost shown: this model reports no pricing (bring-your-own-key or local).",
    costTipPartial:
      "This session's tokens in/out. The amount is INCOMPLETE — {n} model call(s) reported no pricing (bring-your-own-key or local), so the real cost is higher.",
    shellTipV03: "Arrives with v0.3 — full paper review",
    shellTipLater: "Not on a published roadmap version yet",
    notConfigured: "Not configured",
    pin: "Pin",
    pinTip: "Pinning across selections is not built yet",
    send: "Send",
    model: "Model",
    auto: "Auto",
    budget: "Budget",
    addContext: "Add context",
    // E2 (ADR 0049): the composer command menu. This is Lemmaria's own chrome,
    // so it is locale-keyed here — while a skill's `description` is passed
    // through as its author wrote it (invariant 6's boundary, ADR 0045).
    menuCommands: "Commands",
    menuSkills: "Writing skills",
    menuEmpty: "No match",
    menuNewDesc: "Start a new session",
    menuCompactDesc: "Compact the conversation",
    menuHistoryDesc: "Resume an earlier session",
    // E6 (D10): an INSERT row, because the verb takes an argument. Capitalized
    // to match the three rows above it — D10 wrote the phrase as prose inside
    // a sentence, and carrying its lower case into the menu would have made
    // the fourth row the only one that starts small (E6 code review).
    menuForkDesc: "Fork this session, with an optional new name",
    // E3: the `@` menu's own chrome. A PATH is not Lemmaria's text and is
    // never localized — see `context-paths.ts`.
    menuPaths: "Files and folders",
    menuNoContext:
      "Nothing to reference — open a paper folder, or run Grant Folder Access to Session",
    // {n} entries a filter refused. B4/A6: counted, never silently dropped.
    menuPathsHidden: "{n} more not shown (ignored, skipped or excluded)",
    menuPathsTruncated: "and more — the listing hit its limit",
    // Both at once. A separate key rather than two concatenated sentences:
    // rendering only the hidden count would put a precise number where an
    // UNKNOWN remainder also exists, which is the invented-count failure A6
    // removed from the tool (E3 code review).
    menuPathsHiddenAndTruncated:
      "{n} not shown (ignored, skipped or excluded), and the listing hit its limit — there are more",
    cRunCheck: "Run check",
    cReRun: "Re-run",
    cOffline: "OFFLINE · C1 · ALWAYS-ON",
    cOnline: "ONLINE · C2 · CROSSREF / DBLP / S2",
    cNoIssues: "No consistency issues",
    cNotCheckedDetail:
      "Run the online check to verify against public metadata.",
    cChecking: "Checking…",
    cNoPaper: "Open a .tex or .md paper to check its citations.",
    cNoBibFile: "no .bib file",
    cNoEntries: "No bib entries to check",
    cEntries: "entries",
    cCitedKeys: "cited keys",
    cPrivacy:
      "Sent: title · authors · DOI only — never body text. Endpoint per request:",
    cAdopt: "Apply correction",
    cUndefined: "Undefined citation",
    cOrphan: "Uncited entry",
    cDupKey: "Duplicate key",
    cDupEntry: "Duplicate entry",
    cVerified: "Verified",
    cMismatch: "Metadata mismatch",
    cSuperseded: "Preprint superseded",
    cNotFound: "Not found — suspected hallucination",
    cUnverified: "Not verified",
    venueCurrent: "CURRENT VENUE",
    venueChecklistTitle: "PRE-SUBMISSION CHECKLIST",
    venueNewTitle: "NEW FROM VENUE",
    venueMigrateTitle: "MIGRATE TO VENUE",
    venueNone: "Open a LaTeX or Markdown paper to detect its venue.",
    venueNoClass: "No \\documentclass detected.",
    venueNoMatch: "Not in the venue library.",
    venueRowAnonymity: "Anonymity",
    venueRowPages: "Page limit",
    venueRowBibstyle: "Bibliography style",
    venueRowCitations: "Citations",
    venueMatches: "matches venue manifest",
    venueExpected: "expected",
    venueRequired: "required",
    venueManualCheck: "check manually",
    venueNotMeasured: "not measured — run Verify (compile) to count pages",
    venueUnresolved: "unresolved — see the Citations tab",
    venueNoBib: "no bibliography found",
    venueSeedNote:
      "From venue.yaml — seeds PAPER.md and drives the checklist below.",
    venueNewDesc:
      "Scaffold a fresh project from a venue template — starter files, requirements.md, a pre-filled PAPER.md, and a baseline compile.",
    venueNewBtn: "＋ New from Venue…",
    venueMigrateDesc:
      "Rejected? Migrate the whole project onto another venue's template in one action — every change diffed and compile-checked.",
    venueMigrateBtn: "⇄ Migrate to another venue…",
    venueMigrateTip: "Not on a published roadmap version yet",
    mRoles: "ROLES",
    mRolesIntro:
      "Each role runs on a model. Quick tasks follow Writing; reviewers may each run on their own.",
    mWriting: "Writing",
    mWritingDesc: "Polish · Shrink · Proofread · Translate all follow this",
    // D4 / QA-2: the FIRST-PAINT tile labels, before `init` brings the real
    // ones from the action definitions. They used to be hardcoded English in
    // `main.ts`, and clipped: the tile read `Shrink` where the action is named
    // `Shrink By`. Keep them equal to the YAML `name:` for this locale.
    tileProofread: "Proofread",
    tilePolish: "Polish",
    tileShrinkToTarget: "Shrink By",
    tileExpand: "Expand By",
    tileTranslate: "Translate",
    // R9 (ADR 0069 §D8): the two dimmed shells become real controls, so the
    // words change with them — a "Review" ROLE was one model reading once,
    // and what runs is N independent reviewers plus a reading across them.
    mReviewers: "Reviewers",
    mReviewersDesc:
      "Each one reads the whole manuscript, blind to the others. Add or remove reviewers to set how many run.",
    mCrossReview: "Cross-review",
    mCrossReviewDesc:
      "Reads every reviewer's concerns and reports where they agree and disagree. It is not told which model raised what.",
    mSameAsWriting: "Same as Writing",
    // V1 (ADR 0076 §8): the Cross-review card's second select — who checks
    // the concerns. No tool word reaches a reader (ADR 0075 §1).
    mVerifier: "Verification",
    mVerifierDesc:
      "Before the cross-review, one more model re-reads each concern against the manuscript and withdraws a concern the text already answers. It costs about as much as one more reviewer.",
    mSameAsCrossReview: "Same as Cross-review",
    mVerifierOff: "Off",
    mAddReviewer: "Add reviewer",
    mRemoveReviewer: "Remove this reviewer",
    mCrossReviewNeedsTwo: "A cross-review needs at least two reviewers.",
    mAddRole: "Add role",
    mConnected: "CONNECTED MODELS",
    mConnectedIntro:
      "The models you have configured. The active one drives Writing.",
    mNoModels: "No models configured yet.",
    mActive: "Active",
    mKeyOk: "Key set",
    mNoKey: "No key",
    mSetKey: "Set key",
    mRemove: "Remove",
    // V3 (ADR 0080 §6): the image-input override. "auto" reads the harness's
    // prefix table, and the label says which way it resolved.
    mImageInput: "Image input",
    mImageAutoYes: "auto (yes)",
    mImageAutoNo: "auto (no)",
    mImageYes: "yes",
    mImageNo: "no",
    mAddModel: "Add a New Model",
    mProvider: "Provider",
    mModel: "Model",
    mCustomModel: "Custom…",
    mCustomModelPh: "Enter model id",
    mEndpoint: "Endpoint",
    mApiKey: "API key",
    mSave: "Save",
    mCancel: "Cancel",
    mPickModel: "Select a writing model",
    mUsage: "USAGE · TOKENS THIS WINDOW",
    mModelCol: "MODEL",
    mIn: "IN",
    mOut: "OUT",
    mTotalRow: "Total",
    mNoRuns: "No runs yet this session",
    mToday: "Today",
    mTotal: "All time",
    mUnpriced: "unpriced",
    mKeysNote:
      "Keys stored securely in VS Code Secret Storage. You manage your own quota.",
    /** ADR 0064 §2 rewrote this. It used to name only the quick action, which
     *  contradicted the Run button now sitting directly above it. */
    rEmpty:
      "Run a blind panel over the whole manuscript, review the compiled PDF alone, or select text in a .tex or .md file and run “Lemmaria: Review Selection”.",
    rAnnotations: "to review",
    rAdopt: "Adopt fix",
    rIgnore: "Ignore",
    /** ADR 0062 §5: the reader has dealt with this one. Distinct from Ignore,
     *  which says it was never a problem — the archive keeps them apart. */
    rResolve: "Resolve with assistant",
    rChat: "Chat about it",
    /** ADR 0062 §5: ONE fold for everything triaged away, and a word per row
     *  saying which way it went. */
    rArchived: "Archived",
    rStatusAccepted: "accepted",
    rStatusIgnored: "ignored",
    rStatusHanded: "with the assistant",
    rAllResolved: "All findings triaged — nothing left to review.",
    rReadOnly:
      "Review is read-only — adopting re-enters the Accept-gated diff.",
    // ── R3 (ADR 0061): the blind panel ────────────────────────────────────
    menuReviewDesc: "Review the whole manuscript with a blind panel",
    // The panel's own header and its per-seat groups.
    rPanelTitle: "Blind panel",
    /** ADR 0062 §3: the header used to read `Blind panel · main.tex`, which
     *  says the panel reviewed that file. It reviews the whole manuscript and
     *  always did; the entry is where the document BEGINS, so it is named on a
     *  line of its own that says so. */
    rPanelWhole: "whole manuscript",
    rEntryLabel: "main file",
    rEntryChange: "Change",
    /** ADR 0064 §2: the launcher's verb. Named for what the product calls the
     *  thing (`rPanelTitle`), not for the command that implements it — the
     *  reader is choosing a kind of review, not typing `/review`. */
    rRunPanel: "Run blind panel",
    /** ADR 0064 §1: no entry configured and none discovered. */
    rEntryNone: "not detected",
    /** ADR 0064 §1: the shown review read a DIFFERENT entry from the one the
     *  next panel will. Only ever drawn when the two actually disagree. */
    rEntryWas: "this review read",
    /** ADR 0064 §3: a panel cannot start while a task is running. */
    /** ADR 0065 §3: a review at a time — and NOT "a task at a time". The
     *  panel is detached from the conversation, so a chat running beside it is
     *  no reason to refuse. */
    rRunPanelBusy: "A review is already running",
    rStopPanel: "Stop",
    /** The driver reads the whole manuscript before it briefs a seat, so a
     *  large project spends real seconds here with no chip to show. */
    rRunStarting: "starting…",
    /** ADR 0062 §1: the version picker. */
    rPickerLabel: "Review",
    rQuickReview: "selection review",
    rVersionPre: "v",
    rVersionPost: "",
    rJumpToConcern: "Go to this concern",
    /** ADR 0062 §6: what the composer is prefilled with. The call site
     *  composes; neither key is a template. */
    rCopyedit: "Copyedit",
    rCopyeditNone: "no language fix to adopt",
    rFixIntro: "Resolve this reviewer concern in the manuscript.",
    rFixConcern: "The concern",
    rFixAt: "at",
    rFixEvidence: "Supporting passage",
    /** V4 (ADR 0081 §4): a page is not a passage — the PDF reviewer SAW the
     *  concern there, so a draft says where it is visible, not where it is
     *  supported. */
    rFixEvidencePage: "Visible on page {n} of the compiled PDF",
    rFixSuggested: "The reviewer's suggested wording",
    rFixInstruction:
      "Read the surrounding text before you change anything. This may not be fixable in one place — if the manuscript states, relies on, or refers back to this anywhere else, change those passages too so the paper stays consistent. Then tell me what you changed and what you deliberately left as it was.",
    rChatIntro: "About this review concern",
    // V1's J1 round (2026-09-19), Judge question 3: on a WITHDRAWN concern
    // the draft said nothing about the withdrawal, so a reader who
    // disagreed with the verifier had to explain it to the assistant
    // themselves. `{where}` is the passage the verifier pointed at.
    rChatWithdrawn:
      "The panel's verification withdrew it, on this passage: {where}",
    rChatAsk: "What should I do about it?",
    rSeatConcerns: "concern(s)",
    // R9: a reviewer reads every angle now, so "under this lens" named a
    // partition that no longer exists.
    rSeatNone: "raised no concern",
    /** ADR 0023's second verdict, said where the reader is weighing what this
     *  reviewer wrote. By exception — a verified model says nothing. Each
     *  locale carries its own separator (the `toolDegradedAnonymous`
     *  precedent): the zh parenthesis is full-width and supplies the gap. */
    rSeatModelUnverified: " (unverified)",
    rSeatFailed: "this reviewer produced no usable report",
    rSeatInterrupted: "this reviewer was stopped before reporting",
    rSeatUnparsed: "this reviewer's report could not be read",
    // ADR 0082 §2: a reviewer that ran out of one of the user's three budgets
    // before it finished — said as that, never as an unreadable report, which
    // is all the record's `reason` alone could draw. One sentence per budget.
    rSeatRanOutTurns:
      "this reviewer ran out of model turns before it finished its report",
    rSeatRanOutToolCalls:
      "this reviewer ran out of tool calls before it finished its report",
    rSeatRanOutOutput:
      "this reviewer ran out of output tokens before it finished its report",
    // X6 (ADR 0075 §1): a reviewer that recorded nothing because every entry
    // it raised was LOST — to the locator, or to its own shape. *Raised no
    // concern* said the opposite of what happened. {n} is entries; the
    // one-entry forms carry no slot in English and keep it in Chinese, whose
    // sentence does not change with the count.
    //
    // The review round (2026-09-18) reworded three of the four in English. The
    // first wording, *all N … could not*, scoped the negation both ways (it
    // can read as *not all could*); *anchored* was the tool's word; and the
    // limits row for the same loss says *located*. Chinese already said
    // *located in the manuscript* (无法在原文中定位), so it did not move.
    rSeatAllUnanchored:
      "none of its {n} concerns could be located in the manuscript",
    rSeatOneUnanchored: "its 1 concern could not be located in the manuscript",
    rSeatAllUnrecorded: "none of its {n} concerns could be recorded",
    rSeatOneUnrecorded: "its 1 concern could not be recorded",
    // ADR 0083 §2: a PDF reviewer whose every concern was about the argument,
    // set aside in a panel — it raised concerns, so it never says it raised none.
    rSeatAllSetAside:
      "its {n} concerns were about the argument and were set aside",
    rSeatOneSetAside: "its 1 concern was about the argument and was set aside",
    // ADR 0085 §2: the same, for what the class prints for review; and a seat
    // whose concerns went both ways is told plainly, never as one kind.
    rSeatAllFurniture:
      "its {n} concerns were about what the class prints for review and were set aside",
    rSeatOneFurniture:
      "its {n} concern was about what the class prints for review and was set aside",
    rSeatAllSetAsideMixed: "its {n} concerns were set aside",
    // X6 (ADR 0075 §2): why a reviewer (or the cross-review) failed, by the
    // harness's class. `quota` reuses `noticeProviderQuota`, so that sentence
    // keeps one home. Each sentence claims only what its class guarantees:
    // `retryable` includes an overloaded provider and a stream that died mid-
    // answer, where the model WAS reached; `fatal` is the catch-all, so it
    // cannot say who refused — nor whether a retry would have helped: the
    // contract gives it a POLICY (report and stop), not a verdict, so the
    // sentence states the policy — as the Chinese always did, *not retried
    // AUTOMATICALLY*, which leaves the author free to press Run again (review
    // round, 2026-09-18). The provider's words fill the label's slot, as
    // authored — and the label owns its separator, which differs by locale.
    rCauseRetryable: "The model did not answer, and retrying did not help.",
    rCauseFatal:
      "The request failed with an error that Lemmaria does not retry automatically.",
    rCauseProvider: "The provider's message: {message}",
    // X6 (ADR 0075 §3): the results header's one line about the panel. Each
    // segment is a whole string with its count slot; English needs a singular.
    rHeadReviewersOne: "{n} reviewer",
    rHeadReviewersMany: "{n} reviewers",
    rHeadModelsOne: "{n} distinct model",
    rHeadModelsMany: "{n} distinct models",
    rHeadFailed: "{n} failed",
    rHeadInterrupted: "{n} stopped",
    rHeadUnparsed: "{n} unreadable",
    rHeadOutOfBudget: "{n} out of budget",
    // J1's round: a concern's severity on its id line. English reads as it
    // always did; the keys exist so zh stops printing `major` beside its
    // blocking word (`rBlocking`).
    rSeverityInfo: "info",
    rSeverityMinor: "minor",
    rSeverityMajor: "major",
    rBlocking: "blocking",
    // V1 (ADR 0076 §9): the id line's marks, by exception, and the fold that
    // holds what verification withdrew. `{where}` is filled by splitting.
    rConcernUnchecked: "not checked",
    rConcernOpinion: "reviewer's judgment",
    rConcernUnsettled: "could not be settled from the text",
    rWithdrawn: "Withdrawn by verification",
    rCounterAt: "Answered at {where}",
    rEvidence: "evidence",
    rNoEvidence: "no supporting passage in the manuscript",
    // V2: the label on an evidence line whose support is a PAPER rather than a
    // passage. "prior work" and not "citation": the reviewer is not saying the
    // manuscript cites this, it is saying this work exists.
    rPriorWork: "prior work",
    rSynthesis: "Across the panel",
    rConsensus: "Agreed",
    rDisagreements: "Disagreed",
    // X6 (ADR 0075 §4): a qualifier on a consensus note, not a verdict on it —
    // it states the fact and leaves the inference to the reader.
    rSameModel: "Same model — every reviewer cited here ran on {model}",
    // X6 (ADR 0075 §5): a cross-review that RAN and found nothing — which,
    // until X6, was drawn exactly like one that never ran: not at all.
    rSynthesisEmpty:
      "The cross-panel reading ran and found nothing the reviewers agree or disagree on.",
    rLimits: "What this review could not do",
    // ADR 0086: what a rule SET ASIDE has a fold of its own — something the
    // review did, not something it could not do. Each rule keeps its
    // rLimitSetAside / rLimitFurnitureSetAside sentence there.
    rSetAsideFold: "What this review set aside",
    // One sentence per limit kind, built from the record's own fields.
    rLimitAnchorsDropped: "quote(s) from this reviewer could not be located",
    // X5: carries its own separator and {n} slot — the two locales punctuate
    // and order this sentence differently, so each owns the whole of it.
    rLimitEntriesRejected:
      ": {n} entries of its report were malformed and were not recorded",
    rLimitEntriesRejectedOne:
      ": {n} entry of its report was malformed and was not recorded",
    // ADR 0083 §2: as rLimitEntriesRejected, its own separator and {n} slot.
    rLimitSetAside:
      ": {n} concerns about the argument cited no page and were set aside — the text reviewers review the argument",
    rLimitSetAsideOne:
      ": {n} concern about the argument cited no page and was set aside — the text reviewers review the argument",
    // ADR 0084: as rLimitSetAside, its own separator and {n} slot.
    rLimitPagesCorrected:
      ": {n} page citations named a page other than the one their figure or table sits on, and were moved to it",
    rLimitPagesCorrectedOne:
      ": {n} page citation named a page other than the one its figure or table sits on, and was moved to it",
    // ADR 0085 §2: as rLimitSetAside, its own separator and {n} slot.
    rLimitFurnitureSetAside:
      ": {n} concerns were about what the document class prints for review — an author block it hides, a placeholder DOI or ISBN — and were set aside",
    rLimitFurnitureSetAsideOne:
      ": {n} concern was about what the document class prints for review — an author block it hides, a placeholder DOI or ISBN — and was set aside",
    // ADR 0085 §3: the count, then why — each reason owns its separator.
    rLimitPagesUnchecked:
      ": {n} page citations of figures and tables were not checked against the pages they sit on",
    rLimitPagesUncheckedOne:
      ": {n} page citation of a figure or table was not checked against the page it sits on",
    rReasonAuxOlder:
      " — the .aux file beside the PDF is older than the PDF; compile the paper again for the check",
    rReasonAuxOtherBuild:
      " — the .aux file beside the PDF counts a different number of pages than the PDF; compile the paper again for the check",
    rLimitSeatMissing: "reported nothing usable",
    // ADR 0082 §2: the seat's heading says what happened; the fold adds the
    // setting that would have prevented it, in the maxTokens notice's words.
    rLimitRanOutTurns:
      "ran out of model turns before it finished its report; raise lemmaria.budget.maxTurns",
    rLimitRanOutToolCalls:
      "ran out of tool calls before it finished its report; raise lemmaria.budget.maxToolCalls",
    rLimitRanOutOutput:
      "ran out of output tokens before it finished its report; raise lemmaria.budget.maxTokens",
    rLimitSeatUnguided: "reviewed without the panel protocol",
    rLimitSearchBudget: "the literature-search budget ran out",
    rLimitSynthesisMissing: "no cross-panel reading was produced",
    // V1 (ADR 0076): what verification could not do. `rLimitVerificationMissing`
    // composes with the `rReason*` words below; the other three are whole.
    rLimitVerificationMissing:
      "concerns were not checked against the manuscript",
    rLimitVerificationOff:
      "concerns were not checked against the manuscript: verification is turned off",
    rLimitVerificationNoProtocol:
      "concerns were not checked against the manuscript: the verification skill is not available",
    rLimitVerificationIncomplete:
      "some concerns were not checked against the manuscript",
    rLimitOwnTitleNoTitle:
      "could not read the manuscript's title, so a literature search may have returned this paper itself",
    rLimitOwnTitleUnavailable:
      "could not keep literature searches from returning this paper itself",
    // V4 (ADR 0081): the compiled PDF — its facts block, the PDF reviewer's
    // group and card, a page as evidence, and the three ways a review falls
    // short of the page.
    rPdfFacts: "About the compiled PDF",
    rPdfPages: "{n} pages",
    // One per number, as `rLimitEntriesRejectedOne` (X6): "1 pages" is not
    // English, and a one-page PDF is O17's own fixture.
    rPdfPagesOne: "1 page",
    rPdfSizeA4: "A4 ({w} × {h} pt)",
    rPdfSizeLetter: "Letter ({w} × {h} pt)",
    rPdfSizeOther: "page size {w} × {h} pt",
    rPdfReferences: "references begin on page {page} — main text {n} pages",
    rPdfReferencesOne: "references begin on page {page} — main text 1 page",
    rPdfReferencesNone: "no references heading found",
    // The English carries its own leading space and the Chinese does not —
    // its full-width parenthesis supplies the gap (`rReasonAnonymous`'s rule).
    rPdfLimit: " of a {limit}-page limit ({note})",
    rPdfLimitBare: " of a {limit}-page limit",
    rPdfAuthor: "author named in the PDF's metadata: {author}",
    rPdfAuthorBlind: "the venue is double-blind",
    rPdfOverfull: "overfull boxes: {h} horizontal, {v} vertical",
    rPdfSmallestText: "smallest text: {pt} pt on page {page}",
    rPdfSourceCompiled: "compiled for this review",
    rPdfSourceFound: "{path}, newer than the manuscript",
    rPdfSourceNamed: "{path}, named in settings",
    rPdfSourceStale: "older than the manuscript",
    rPdfViewed: "pages viewed by the PDF reviewer: {viewed} of {total}",
    rPdfTitle: "PDF review",
    rSeatPdfReviewer: "PDF reviewer",
    rSeatPdfUnchecked:
      "not checked by the verifier — a concern about the rendered page cannot be tested against the text",
    rEvidencePage: "page {n} of the compiled PDF",
    // ADR 0085 §4: a cite the harness moved (ADR 0084) says the page the
    // reviewer cited, on its own row — the fold no longer counts the move.
    rEvidencePageMoved: "page {n} of the compiled PDF (cited {cited})",
    rDimPresentation: "presentation",
    rRunPdf: "Review the PDF",
    rLimitPdfNone:
      "the compiled PDF was not reviewed: no PDF was found beside the entry file and none could be compiled",
    rLimitPdfStale:
      "the compiled PDF was not reviewed: the PDF found is older than the manuscript and none could be compiled",
    rLimitPdfCompileFailed:
      "the compiled PDF was not reviewed: the compile failed",
    rLimitPdfRenderFailed:
      "the compiled PDF was not reviewed: the PDF could not be opened",
    rLimitVisualNoImageInput:
      "the compiled PDF was not reviewed: the PDF reviewer's model does not take images",
    rLimitVisualNoRenderer:
      "the compiled PDF was not reviewed: no PDF renderer is available",
    rLimitPagesUnviewed: "the PDF reviewer viewed {viewed} of {total} pages",
    // V4's code review: a PDF reviewer SKIPPED because its protocol is not
    // offered never ran, so "reviewed without the panel protocol" would be
    // false of it. Said whole, with the remedy the blind-reviewer refusal gives.
    rLimitPdfSeatSkipped:
      "the PDF reviewer did not run: its pdf-reviewer protocol is not available in this session. Re-enable it in the Skills list.",
    // V5 (ADR 0087 §1, D14): a strength that did not locate, or was refused
    // for its shape. The sentence owns its separator as well as its count, so
    // the reviewer is a slot too; "(s)" serves both numbers, as D14 words it.
    rLimitStrengthsLost:
      "{reviewer}: {n} strength(s) could not be recorded — the quote or its evidence was not found, or the entry was malformed",
    // V6 (ADR 0088 §6): the scorecard block. Every word over the card is
    // ours, over the engine's enum keys; nothing here names a score, a rating
    // or a verdict (O21). The readiness words say what is open, never a
    // venue's decision: J2's round did not ratify `Major revisions`.
    scTitle: "Scorecard",
    scReadinessBlocking: "Blocking issues",
    scReadinessMajor: "Major issues",
    scReadinessMinor: "Minor issues",
    scReadinessNone: "No open issues",
    scReadinessNotAssessed: "Not assessed",
    scNotAssessedCount: "{n} not assessed",
    // A level's number and word — one sentence, so the order can differ.
    scLevelWord: "{level} {word}",
    scLevel1: "Blocking",
    scLevel2: "Major",
    scLevel3: "Minor",
    scLevel4: "Strong",
    scNothingRaised: "nothing raised",
    scNotAssessed: "not assessed",
    scReasonDeclared: "{who} declared it could not be assessed",
    scReasonNoLiterature: "no literature source answered",
    scReasonLiteratureBudget: "the literature-search budget ran out",
    scReasonNoPdf: "no PDF was reviewed",
    scReasonNoReviewer: "no reviewer read this dimension",
    // The row counts distinct ISSUES (a group of overlapping concerns is
    // one), where the banner and the seat headings count concerns — so the
    // row names its unit. `major` is major and not blocking: the counts are
    // disjoint, or `blocking 8 · major 8` reads as 16 (E1/J2 round).
    scCountIssues: "issues: {list}",
    scCountBlocking: "blocking {n}",
    scCountMajor: "major {n}",
    scCountMinor: "minor {n}",
    scCountStrengths: "strengths {n}",
    scImpression: "impression {n}",
    scNoImpression: "no impression given",
    scUncalibrated: "uncalibrated",
    scFirstReading: "first reading of this manuscript",
    scComparedWith: "compared with {version}",
    // The pair's two reasons (ADR 0088 §3): other reviewers, or the same
    // reviewers with verification switched the other way.
    scNotComparable: "{version} was a different panel — not comparable",
    scNotComparableVerification:
      "{version} ran with a different verification setting — not comparable",
    // A compared version no seat contributed to: neither reason is true.
    scNotComparableUnmeasured:
      "{version} could not be measured — not comparable",
    scDeltaImproved: "improved",
    scDeltaWorsened: "worse",
    scDeltaUnchanged: "unchanged",
    scDeltaNew: "new",
    scUnmeasured:
      "No levels could be derived — no reviewer's ledger could be read.",
    // A review with no seat at all: nothing ran, so no ledger was unreadable.
    // Not *PDF review is off* — the record does not carry why (E1's round).
    scNoReviewerRan: "No levels could be derived — no reviewer ran.",
    scCaveat:
      "levels are computed from this panel's located concerns; impressions are reviewers' uncalibrated opinions; neither predicts acceptance.",
    scNarrowed: "Showing {dimension} · {shown} of {total} concerns",
    scShowAll: "Show all",
    scSeatConcernsOf: "{shown} of {total} concern(s)",
    menuReviewPdfDesc: "Review the compiled PDF alone",
    mPdfReview: "PDF review",
    mPdfReviewDesc: "one reviewer that sees the compiled pages",
    mPdfReviewer: "PDF reviewer",
    mPdfReviewerOff: "Off",
    mPdfReviewerDesc:
      "Reviews the rendered pages beside the panel, or alone from the Review tab. Needs a model that takes images.",
    mPdfReviewerBlind:
      "This model does not take images; the compiled PDF will not be reviewed. Pick another, or set its Image input.",
    rReasonRateLimited: "rate-limited",
    rReasonTimeout: "timed out",
    rReasonFailed: "failed",
    rReasonAnonymous: " (no API key — Lemmaria: Set Semantic Scholar API Key)",
    rReasonInterrupted: "stopped",
    rReasonUnparsed: "unreadable",
    rReasonInsufficientSeats: "too few reviewers reported",
    rReasonNoReport: "no report",
    // X6 (ADR 0075 §7): the separator inside a list of names or status words —
    // one merged limits row per source. Each locale punctuates its own lists.
    rListSep: ", ",
    // The running panel, at the top of the Review tab (ADR 0065 §3). These
    // keys kept their `rCard` prefix through the move: they are the same
    // strings, and renaming them would have made a pure relocation look like a
    // rewrite in every diff and every test. Four went with the card itself —
    // its title, its concern and limit counts, and its *Open the Review tab*
    // button, none of which a reader already ON the tab needs.
    /** ADR 0062 §4: the seat chip is STATIC and the spinner sits inside it. A
     *  rotating chip rotated its own text, which is what the operator saw. */
    rCardWorking: "working",
    rCardRunning: "reading the manuscript…",
    rCardSynthesis: "synthesis",
    rCardVerification: "verification",
    rCardFailed: "The panel did not run.",
    rCardInterrupted: "The panel was stopped.",
    rCardRetried: "retried",
    // The dimensions of the two review modes; `clarity` is in both, so the
    // union is NINE keys since V2 added `originality` and `significance` to
    // the panel's seven (ADR 0078 6).
    rDimSoundness: "soundness",
    rDimClaims: "claims",
    rDimClarity: "clarity",
    rDimPositioning: "positioning",
    rDimOriginality: "originality",
    rDimSignificance: "significance",
    rDimRigor: "rigor",
    rDimStructure: "structure",
    rDimLanguage: "language",
    cEmpty: "Run “Lemmaria: Compile Check” to see what the compiler reports.",
    cFindings: "to fix",
    cFix: "Fix",
    cFixAll: "Fix all",
    cIgnore: "Ignore",
    cFixed: "Fixed",
    cIgnored: "Ignored",
    cAllResolved: "All findings triaged — nothing left to fix.",
    cClean: "Compiles clean — no findings.",
    cFailed:
      "The project did not compile, though no specific findings could be parsed from the log.",
    cGuidance: "The project could not be compiled:",
    cReport:
      "A compile is a report you asked for — a fix re-enters the Accept-gated diff, and nothing re-runs on its own.",
  },
  zh: {
    tabs: ["助手", "引用", "模型", "会议", "审稿", "编译"],
    history: "历史",
    compacted: "上下文已压缩",
    compactedManual: "手动压缩",
    compactedAuto: "接近上下文上限，自动压缩",
    compacting: "正在压缩对话……",
    compactingAuto: "已达上下文上限，正在压缩对话……",
    ringUsed: "上下文窗口占用",
    ringUnknown: "上下文窗口占用——尚未测量",
    new: "新建",
    settings: "设置",
    quickActions: "快捷操作 · 针对所选",
    placeholder: "描述一处修改，或向 Lemmaria 提问……",
    welcomeTitle: "向 Lemmaria 提问你的论文",
    welcomeBody:
      "描述一处修改、发起一次评审，或检查参考文献。每次改动都会先生成差异，由你确认。",
    sessionThinking: "思考中……",
    sessionError: "出错了",
    sessionInterrupted: "已中断",
    stop: "停止",
    toolRunning: "运行中……",
    toolFailed: "失败",
    plan: "计划",
    editProposal: "编辑提议",
    editReplace: "替换",
    editCreate: "新文件",
    editViewDiff: "查看差异",
    editAccept: "接受",
    editReject: "拒绝",
    editAcceptAll: "全部接受",
    editRejectNote: "原因将反馈给智能体",
    editApplied: "已应用",
    editRejected: "已拒绝",
    editStale: "已过期——文件已变化",
    editInvalid: "无效",
    editUnitPlural: "处编辑",
    rewindTitleNoFiles: "从该消息分叉或回退——回退代码不会改动任何文件",
    rewindTitleFiles: "从该消息分叉或回退——回退代码将改动 {n} 个文件",
    rewindArmFork: "从此处分叉会话",
    rewindArmRestore: "将代码回退到此处",
    rewindArmBoth: "分叉会话并回退代码",
    rewindAskRestore: "将代码回退到该消息处？",
    rewindAskBoth: "分叉会话并将代码回退到该消息处？",
    rewindDoRestore: "回退代码",
    rewindDoBoth: "分叉并回退",
    rewindCardRestored: "以下 {n} 个文件的内容将被恢复：",
    rewindCardDeleted: "以下 {n} 个文件将从磁盘上删除（它们是本会话创建的）：",
    rewindMore: "……另有 {n} 个",
    rewindNoFiles: "没有文件会被改动。",
    changedFiles: "个文件已更改",
    changedNew: "新增",
    // D2 / X2 的 T6：模型声明要删除的受保护内容。
    editRemovesProtected: "声明删除：",
    // D2（CHAT-5）：决定按整批提交，因此已决定的文件仍在等待其余文件。
    editWaitingForOthers: "还需决定 {n} 个文件",
    permReview: "编辑前询问",
    permAuto: "自动",
    permReviewDesc: "显示每处差异并等待接受",
    permAutoDesc: "立即应用编辑",
    grantAdd: "＋ 授权文件夹",
    grantAddTip: "授权本会话只读访问一个文件夹（代码库、结果目录…）",
    grantRevoke: "撤销访问",
    grantAdded: "已授予只读访问",
    grantRevoked: "已撤销访问",
    scriptRun: "运行脚本",
    scriptApprove: "批准",
    scriptDeny: "拒绝",
    scriptDenyNote: "原因（可选）",
    scriptAlwaysAllow: "本次会话始终允许此脚本",
    scriptRunning: "运行中…",
    scriptInCwd: "位于",
    // D2（CHAT-4）：输出折叠的摘要。
    scriptOutput: "输出",
    scriptExit: "退出码",
    scriptKilled: "在退出前被终止",
    scriptStdout: "标准输出",
    scriptStderr: "标准错误",
    scriptBytes: "字节",
    scriptTruncated: "已截断",
    mdCopy: "复制代码",
    mdCopied: "已复制",
    scriptPermsWarning: "⚠ 将以你的完整操作系统权限运行——包括文件访问和网络。",
    subtaskExplored: "个子任务已探索",
    context: "上下文",
    selection: "所选",
    v03: "v0.3",
    later: "后续版本",
    steerPlaceholder: "引导 Lemmaria——将在下一轮开始时并入……",
    steeringQueuedTip: "已排队：正在运行的任务会在下一轮开始时读取。",
    reasoning: "思考",
    unknownItem: "无法识别的记录条目",
    toolArgs: "参数",
    toolResult: "结果",
    toolChildren: "个子任务",
    toolEdits: "处修改",
    toolSteps: "个步骤",
    toolErrNotFound: "未找到",
    toolErrDenied: "不允许",
    toolErrTooLarge: "过大",
    toolErrRefused: "已拒绝",
    toolErrRateLimited: "被限流",
    toolErrUnavailable: "不可用",
    toolErrInvalid: "参数无效",
    toolMatches: "处匹配",
    toolResults: "条结果",
    toolFiles: "个文件",
    toolChars: "个字符",
    toolTruncated: "已截断",
    // D2: was "…（.gitignore / 已跳过目录）". The " / " join put han text
    // straight after a Latin token, which is the shape ADR 0034 forbids and
    // `check-mixed-language-strings.mjs` flags.
    toolExcluded: "项被隐藏（.gitignore 规则或已跳过的目录）",
    toolDegraded: "未响应的来源",
    toolDegradedAnonymous:
      "（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
    noticeBudgetTurns:
      "已停止：本次任务达到轮次预算上限。再发送一条消息即可继续。",
    noticeBudgetToolCalls:
      "已停止：本次任务达到工具调用预算上限。再发送一条消息即可继续。",
    noticeBudgetTokens:
      "已停止：本次任务达到输出 token 预算上限。再发送一条消息即可继续。",
    noticeContextLimit:
      "已停止：对话已填满模型的上下文窗口。请压缩会话或新建会话。",
    noticeCompactionFailed: "无法总结对话——没有丢弃任何内容。",
    noticeStreamRetried: "连接出现问题——将在 {n} 秒后重试。",
    noticeStreamRetryFailed:
      "尝试 {n} 次后仍无法连接模型。服务商返回的信息见下。",
    noticeProviderQuota:
      "服务商因额度或账单原因拒绝了本次请求，重试无济于事。请检查你的套餐、余额或 API 密钥。",
    noticeModelUnverified: `Lemmaria 尚未验证该模型能否胜任智能体会话，它可能无法稳定遵循工具调用约定。已验证：${L2_FLOOR_LABEL_ZH}。`,
    noticeTurnTruncated:
      "本回合的回答达到长度上限被截断；尚未写完的内容（包括未完成的编辑提案）已被丢弃。可以让它分步继续。",
    noticeTurnTruncatedRecovered:
      "本回合回答达到长度上限时正在调用 {n} 个工具。由于参数可能不完整，这些调用均未执行，已请模型重新发起。",
    noticeReviewSkillMissing:
      "评审需要内置的 blind-reviewer 评审规程，但本次会话中它不可用。请在技能列表中重新启用它，然后再次发起评审。",
    noticeReviewNoManuscript:
      "评审未在当前工作区找到可读的稿件。请打开存放论文的文件夹，或先聚焦其主文件，然后再次发起评审。",
    noticeReviewSeatBudget:
      "每位评审人只分到 {n} 个输出 token，通常不足以读完稿件并写出意见。评审仍会继续；若评审人返回为空，请调高 lemmaria.budget.maxTokens。",
    noticeReviewReviewersClamped:
      "请求的评审人数量超过一次评审可同时运行的上限，因此只有前 {n} 位参与。请将数量减至 {n} 位或更少，以决定由哪几位运行。",
    noticeReviewManuscriptUnresolved:
      "无法解析稿件的文件引用关系，评审小组将读取该文件夹下全部的 .tex、.md 和 .bib 文件（共 {n} 个）——其中可能包含不属于本文的文件。",
    noticeReviewManuscriptIncomplete:
      "稿件引用的 {n} 个文件无法读取，评审小组是在缺少这些文件的情况下完成审阅的。",
    noticeReviewModelQuota:
      "审稿未启动：评审小组中有 {n} 个模型因额度或账单原因拒绝了一次单词级的连通检查。重试无济于事——请检查该模型的套餐、余额或 API 密钥。没有运行任何评审人。",
    noticeReviewModelUnreachable:
      "审稿未启动：评审小组中有 {n} 个模型在一次单词级的连通检查中无法连接。没有运行任何评审人——请稍后重试。",
    noticeReviewModelRefused:
      "审稿未启动：评审小组中有 {n} 个模型拒绝了一次单词级的连通检查。请在“模型”标签页中检查该模型的名称、接口地址和 API 密钥。没有运行任何评审人。",
    noticeReviewVerifierBudget:
      "核查只分到 {n} 个输出 token，通常不足以对照稿件核查评审意见。评审仍会继续；若意见显示为未核查，请调高 lemmaria.budget.maxTokens。",
    costTipPriced: "本次会话的用量——输入/输出 token 与累计成本",
    costTipTokens:
      "本次会话的输入/输出 token。未显示成本：该模型没有报价信息（自带密钥或本地模型）。",
    costTipPartial:
      "本次会话的输入/输出 token。金额并不完整——有 {n} 次模型调用没有报价信息（自带密钥或本地模型），实际成本更高。",
    shellTipV03: "将随 v0.3 完整论文评审推出",
    shellTipLater: "尚未列入已发布的版本路线图",
    notConfigured: "未配置",
    pin: "固定",
    pinTip: "跨选区固定尚未实现",
    send: "发送",
    model: "模型",
    auto: "自动",
    budget: "预算",
    addContext: "添加上下文",
    menuCommands: "命令",
    menuSkills: "写作技能",
    menuEmpty: "没有匹配项",
    menuNewDesc: "开始新的会话",
    menuCompactDesc: "压缩当前会话的上下文",
    menuHistoryDesc: "恢复此前的会话",
    menuForkDesc: "分叉当前会话，可指定新名称",
    menuPaths: "文件与文件夹",
    menuNoContext:
      "暂无可引用的内容——请打开论文文件夹，或执行“授权会话访问文件夹”",
    menuPathsHidden: "另有 {n} 项未显示（被忽略、跳过或排除）",
    menuPathsTruncated: "还有更多——列表已达上限",
    menuPathsHiddenAndTruncated:
      "{n} 项未显示（被忽略、跳过或排除），且列表已达上限——还有更多",
    cRunCheck: "联网核对",
    cReRun: "重新核对",
    cOffline: "离线 · C1 · 始终启用",
    cOnline: "在线 · C2 · CROSSREF / DBLP / S2",
    cNoIssues: "无一致性问题",
    cNotCheckedDetail: "运行在线核对以对照公开元数据验证。",
    cChecking: "核对中……",
    cNoPaper: "打开 .tex 或 .md 论文以检查其引用。",
    cNoBibFile: "无 .bib 文件",
    cNoEntries: "没有可核对的文献条目",
    cEntries: "条目",
    cCitedKeys: "被引用键",
    cPrivacy: "仅发送：标题 · 作者 · DOI —— 绝不发送正文。每次请求的端点：",
    cAdopt: "应用修正",
    cUndefined: "未定义引用",
    cOrphan: "未被引用条目",
    cDupKey: "重复键",
    cDupEntry: "重复条目",
    cVerified: "已验证",
    cMismatch: "元数据不一致",
    cSuperseded: "预印本已被取代",
    cNotFound: "未找到 —— 疑似虚构",
    cUnverified: "未验证",
    venueCurrent: "当前会议",
    venueChecklistTitle: "投稿前检查清单",
    venueNewTitle: "从会议模板新建",
    venueMigrateTitle: "迁移至其他会议",
    venueNone: "打开 LaTeX 或 Markdown 论文以检测其会议。",
    venueNoClass: "未检测到 \\documentclass。",
    venueNoMatch: "不在会议库中。",
    venueRowAnonymity: "匿名要求",
    venueRowPages: "页数限制",
    venueRowBibstyle: "参考文献样式",
    venueRowCitations: "引用",
    venueMatches: "与会议清单一致",
    venueExpected: "应为",
    venueRequired: "要求",
    venueManualCheck: "请人工检查",
    venueNotMeasured: "未测量 —— 运行验证（编译）以统计页数",
    venueUnresolved: "处未解决 —— 见「引用」标签页",
    venueNoBib: "未找到参考文献文件",
    venueSeedNote: "来自 venue.yaml —— 用于生成 PAPER.md 并驱动下方检查清单。",
    venueNewDesc:
      "从会议模板搭建全新项目 —— 起始文件、requirements.md、预填的 PAPER.md 与基线编译。",
    venueNewBtn: "＋ 从会议模板新建…",
    venueMigrateDesc:
      "被拒稿？一键将整个项目迁移到另一会议的模板 —— 每处改动都经过对比与编译检查。",
    venueMigrateBtn: "⇄ 迁移至其他会议…",
    venueMigrateTip: "尚未列入已发布的版本路线图",
    mRoles: "角色",
    mRolesIntro:
      "每个角色由一个模型驱动。快捷操作均使用「写作」模型；每位评审人可各自使用不同模型。",
    mWriting: "写作",
    mWritingDesc: "润色 · 压缩 · 校对 · 翻译均使用此模型",
    tileProofread: "校对",
    tilePolish: "润色",
    tileShrinkToTarget: "精简字数",
    tileExpand: "扩写字数",
    tileTranslate: "翻译",
    mReviewers: "评审人",
    mReviewersDesc:
      "每位评审人独立通读全文，彼此不可见。增删评审人即可设置数量。",
    mCrossReview: "交叉评审",
    mCrossReviewDesc:
      "通读全部评审意见，指出彼此一致与分歧之处；它不会被告知哪条意见出自哪个模型。",
    mSameAsWriting: "与写作模型相同",
    mVerifier: "核查",
    mVerifierDesc:
      "在交叉评审之前，再由一个模型对照稿件逐条核查意见；稿件中已有回应的意见会被撤回。开销约等于多一位评审人。",
    mSameAsCrossReview: "与交叉评审相同",
    mVerifierOff: "关闭",
    mAddReviewer: "添加评审人",
    mRemoveReviewer: "移除该评审人",
    mCrossReviewNeedsTwo: "交叉评审至少需要两位评审人。",
    mAddRole: "添加角色",
    mConnected: "已连接模型",
    mConnectedIntro: "您已配置的模型。当前启用的模型用于「写作」。",
    mNoModels: "尚未配置任何模型。",
    mActive: "启用中",
    mKeyOk: "已设置密钥",
    mNoKey: "未设置密钥",
    mSetKey: "设置密钥",
    mRemove: "移除",
    mImageInput: "图像输入",
    mImageAutoYes: "自动（是）",
    mImageAutoNo: "自动（否）",
    mImageYes: "是",
    mImageNo: "否",
    mAddModel: "添加新模型",
    mProvider: "提供方",
    mModel: "模型",
    mCustomModel: "自定义…",
    mCustomModelPh: "输入模型 ID",
    mEndpoint: "服务地址",
    mApiKey: "API 密钥",
    mSave: "保存",
    mCancel: "取消",
    mPickModel: "选择写作模型",
    mUsage: "用量 · 本窗口 TOKEN",
    mModelCol: "模型",
    mIn: "输入",
    mOut: "输出",
    mTotalRow: "合计",
    mNoRuns: "本会话尚无运行",
    mToday: "今日",
    mTotal: "累计",
    mUnpriced: "未计价",
    mKeysNote: "密钥安全存储于 VS Code Secret Storage，配额由您自行管理。",
    // The command by ITS palette title (`package.nls.zh-cn.json`), and only
    // that one — it read “Lemmaria: Review Selection / AI 审稿” until the X6
    // review round, both locales' titles joined for one reader.
    rEmpty:
      "可对全文运行盲审小组，或单独评审已编译的 PDF；也可在 .tex 或 .md 文件中选中文本，运行“Lemmaria: AI 审稿”。",
    rAnnotations: "条待处理",
    rAdopt: "采纳修改",
    rIgnore: "忽略",
    rResolve: "交给助手处理",
    rChat: "与助手讨论",
    rArchived: "已归档",
    rStatusAccepted: "已采纳",
    rStatusIgnored: "已忽略",
    rStatusHanded: "已交给助手",
    rAllResolved: "所有审稿意见均已处理——暂无待办。",
    rReadOnly: "审稿为只读——采纳建议将进入需确认的差异审阅。",
    menuReviewDesc: "由盲审小组通读全文并给出意见",
    rPanelTitle: "盲审小组",
    rPanelWhole: "通读全文",
    rEntryLabel: "主文件",
    rEntryChange: "更改",
    rRunPanel: "运行盲审小组",
    rEntryNone: "未检测到",
    rEntryWas: "本次审稿读取的是",
    rRunPanelBusy: "已有审稿正在进行",
    rStopPanel: "停止",
    rRunStarting: "正在启动……",
    rPickerLabel: "审稿",
    rQuickReview: "选区审稿",
    rVersionPre: "第",
    rVersionPost: "版",
    rJumpToConcern: "跳转到该条意见",
    rCopyedit: "文字校对",
    rCopyeditNone: "没有可直接采纳的文字修改",
    rFixIntro: "请在稿件中处理下面这条审稿意见。",
    rFixConcern: "意见",
    rFixAt: "位于",
    rFixEvidence: "佐证段落",
    rFixEvidencePage: "见于已编译 PDF 第 {n} 页",
    rFixSuggested: "审稿人给出的改法",
    rFixInstruction:
      "动笔之前先读一读上下文。这个问题未必能在一处改完——如果稿件在别处还陈述、依赖或回指了它，请一并修改那些地方，使全文保持一致。改完告诉我你改了什么，以及哪些地方你是有意保留不改的。",
    rChatIntro: "关于这条审稿意见",
    rChatWithdrawn: "盲审小组的核查据此撤回了这条意见：{where}",
    rChatAsk: "我应该怎么处理？",
    rSeatConcerns: "条意见",
    rSeatNone: "未提出意见",
    rSeatModelUnverified: "（未验证）",
    rSeatFailed: "该评审未产生可用报告",
    rSeatInterrupted: "该评审在给出意见前被停止",
    rSeatUnparsed: "该评审的报告无法解析",
    rSeatRanOutTurns: "该评审在完成报告前用完了模型轮次",
    rSeatRanOutToolCalls: "该评审在完成报告前用完了工具调用次数",
    rSeatRanOutOutput: "该评审在完成报告前用完了输出 token",
    rSeatAllUnanchored: "提出的 {n} 条意见均无法在原文中定位",
    rSeatOneUnanchored: "提出的 {n} 条意见无法在原文中定位",
    rSeatAllUnrecorded: "提出的 {n} 条意见均未能记录",
    rSeatOneUnrecorded: "提出的 {n} 条意见未能记录",
    rSeatAllSetAside: "提出的 {n} 条意见均关于论证，已被搁置",
    rSeatOneSetAside: "提出的 {n} 条意见关于论证，已被搁置",
    rSeatAllFurniture:
      "提出的 {n} 条意见均针对文档类为评审排印的内容，已被搁置",
    rSeatOneFurniture: "提出的 {n} 条意见针对文档类为评审排印的内容，已被搁置",
    rSeatAllSetAsideMixed: "提出的 {n} 条意见均已被搁置",
    rCauseRetryable: "该模型未能作答，重试后仍未成功。",
    rCauseFatal: "请求失败，此类错误不会自动重试。",
    rCauseProvider: "服务商返回的信息：{message}",
    rHeadReviewersOne: "{n} 位评审",
    rHeadReviewersMany: "{n} 位评审",
    rHeadModelsOne: "{n} 个不同模型",
    rHeadModelsMany: "{n} 个不同模型",
    rHeadFailed: "{n} 位失败",
    rHeadInterrupted: "{n} 位被停止",
    rHeadUnparsed: "{n} 位报告无法解析",
    rHeadOutOfBudget: "{n} 位用完预算",
    rSeverityInfo: "提示",
    rSeverityMinor: "次要",
    rSeverityMajor: "重大",
    // The scorecard's word for blocking too (`scLevel1`, `scCountBlocking`):
    // `关键` here beside `阻碍` above read as two judgements (V6 J2's round).
    rBlocking: "阻碍",
    rConcernUnchecked: "未核查",
    rConcernOpinion: "评审人的判断",
    rConcernUnsettled: "无法从稿件中核实",
    rWithdrawn: "经核查撤回",
    rCounterAt: "稿件中已有回应：{where}",
    rEvidence: "依据",
    rNoEvidence: "文中没有支持该判断的段落",
    rPriorWork: "已有工作",
    rSynthesis: "小组综述",
    rConsensus: "共识",
    rDisagreements: "分歧",
    rSameModel: "同一模型——此处引用的评审均运行于 {model}",
    rSynthesisEmpty: "小组综述已完成：各评审的意见之间未发现共识或分歧。",
    rLimits: "本次审稿未能完成的部分",
    rSetAsideFold: "本次审稿搁置的意见",
    rLimitAnchorsDropped: "条引文无法在原文中定位",
    rLimitEntriesRejected: "：其报告中有 {n} 条意见格式有误，未被记录",
    rLimitEntriesRejectedOne: "：其报告中有 {n} 条意见格式有误，未被记录",
    rLimitSetAside:
      "：有 {n} 条关于论证的意见未引用页码，已被搁置——论证由文字评审审阅",
    rLimitSetAsideOne:
      "：有 {n} 条关于论证的意见未引用页码，已被搁置——论证由文字评审审阅",
    rLimitPagesCorrected:
      "：有 {n} 处页码引用与所指图表所在的页不符，已改为该图表所在的页",
    rLimitPagesCorrectedOne:
      "：有 {n} 处页码引用与所指图表所在的页不符，已改为该图表所在的页",
    rLimitFurnitureSetAside:
      "：有 {n} 条意见针对的是文档类为评审而排印的内容（被隐去的作者信息、模板占位的 DOI 或 ISBN），已被搁置",
    rLimitFurnitureSetAsideOne:
      "：有 {n} 条意见针对的是文档类为评审而排印的内容（被隐去的作者信息、模板占位的 DOI 或 ISBN），已被搁置",
    rLimitPagesUnchecked: "：有 {n} 处图表页码引用未与图表所在的页核对",
    rLimitPagesUncheckedOne: "：有 {n} 处图表页码引用未与图表所在的页核对",
    rReasonAuxOlder: "——PDF 旁的 .aux 文件早于该 PDF；重新编译论文即可核对",
    rReasonAuxOtherBuild:
      "——PDF 旁的 .aux 文件记录的页数与该 PDF 不同；重新编译论文即可核对",
    rLimitSeatMissing: "未给出可用意见",
    rLimitRanOutTurns:
      "在完成报告前用完了模型轮次；请调高 lemmaria.budget.maxTurns",
    rLimitRanOutToolCalls:
      "在完成报告前用完了工具调用次数；请调高 lemmaria.budget.maxToolCalls",
    rLimitRanOutOutput:
      "在完成报告前用完了输出 token；请调高 lemmaria.budget.maxTokens",
    rLimitSeatUnguided: "未加载审稿协议即完成评审",
    rLimitSearchBudget: "文献检索额度已用尽",
    rLimitSynthesisMissing: "未产生小组综述",
    rLimitVerificationMissing: "未对照稿件核查意见",
    rLimitVerificationOff: "未对照稿件核查意见：核查已关闭",
    rLimitVerificationNoProtocol: "未对照稿件核查意见：核查技能不可用",
    rLimitVerificationIncomplete: "部分意见未对照稿件核查",
    rLimitOwnTitleNoTitle: "未能读取稿件标题，文献检索的结果中可能包含本文自身",
    rLimitOwnTitleUnavailable: "未能阻止文献检索返回本文自身",
    rPdfFacts: "关于已编译的 PDF",
    rPdfPages: "共 {n} 页",
    rPdfPagesOne: "共 1 页",
    rPdfSizeA4: "A4（{w} × {h} pt）",
    rPdfSizeLetter: "Letter（{w} × {h} pt）",
    rPdfSizeOther: "页面尺寸 {w} × {h} pt",
    rPdfReferences: "参考文献从第 {page} 页开始——正文 {n} 页",
    rPdfReferencesOne: "参考文献从第 {page} 页开始——正文 1 页",
    rPdfReferencesNone: "未找到参考文献标题",
    rPdfLimit: "（页数上限 {limit} 页：{note}）",
    rPdfLimitBare: "（页数上限 {limit} 页）",
    rPdfAuthor: "PDF 元数据中署名作者：{author}",
    rPdfAuthorBlind: "该投稿场所采用双盲评审",
    rPdfOverfull: "溢出盒子：横向 {h} 个，纵向 {v} 个",
    rPdfSmallestText: "最小文字：第 {page} 页 {pt} pt",
    rPdfSourceCompiled: "为本次评审编译",
    rPdfSourceFound: "{path}，比手稿更新",
    rPdfSourceNamed: "{path}，由设置指定",
    rPdfSourceStale: "比手稿旧",
    rPdfViewed: "PDF 评审人查看的页面：{viewed} / {total}",
    rPdfTitle: "PDF 评审",
    rSeatPdfReviewer: "PDF 评审人",
    rSeatPdfUnchecked: "未经核查人核对——关于排版页面的意见无法依据正文核实",
    rEvidencePage: "已编译 PDF 第 {n} 页",
    rEvidencePageMoved: "已编译 PDF 第 {n} 页（原引第 {cited} 页）",
    rDimPresentation: "呈现",
    rRunPdf: "审阅 PDF",
    rLimitPdfNone: "未评审已编译 PDF：入口文件旁没有 PDF，也无法编译",
    rLimitPdfStale: "未评审已编译 PDF：找到的 PDF 比手稿旧，且无法编译",
    rLimitPdfCompileFailed: "未评审已编译 PDF：编译失败",
    rLimitPdfRenderFailed: "未评审已编译 PDF：无法打开 PDF",
    rLimitVisualNoImageInput: "未评审已编译 PDF：PDF 评审人的模型不接受图像",
    rLimitVisualNoRenderer: "未评审已编译 PDF：没有可用的 PDF 渲染器",
    rLimitPagesUnviewed: "PDF 评审人查看了 {total} 页中的 {viewed} 页",
    rLimitPdfSeatSkipped:
      "PDF 评审人未运行：本次会话中它的 pdf-reviewer 评审规程不可用。请在技能列表中重新启用它。",
    rLimitStrengthsLost:
      "{reviewer}：有 {n} 条优点未能记录——引文或其依据未能找到，或条目格式有误",
    scTitle: "各维度等级",
    scReadinessBlocking: "存在阻碍性问题",
    scReadinessMajor: "存在重大问题",
    scReadinessMinor: "存在次要问题",
    scReadinessNone: "无未决问题",
    scReadinessNotAssessed: "未评估",
    scNotAssessedCount: "{n} 项未评估",
    scLevelWord: "{level} 级·{word}",
    scLevel1: "阻碍",
    scLevel2: "重大",
    scLevel3: "次要",
    // Not 优势: beside `优点 N` on one row it read like a typo (J2's round).
    scLevel4: "良好",
    scNothingRaised: "未提出意见",
    scNotAssessed: "未评估",
    scReasonDeclared: "{who} 声明无法评估",
    scReasonNoLiterature: "文献检索均无结果",
    scReasonLiteratureBudget: "文献检索额度已用尽",
    scReasonNoPdf: "未审阅 PDF",
    scReasonNoReviewer: "没有评审人阅读此维度",
    scCountIssues: "问题：{list}",
    scCountBlocking: "阻碍 {n}",
    scCountMajor: "重大 {n}",
    scCountMinor: "次要 {n}",
    // The tab's word for a strength (`rLimitStrengthsLost`).
    scCountStrengths: "优点 {n}",
    scImpression: "印象 {n}",
    scNoImpression: "未给出印象",
    scUncalibrated: "未经校准",
    scFirstReading: "本稿件的首次评审",
    scComparedWith: "与{version}相比",
    scNotComparable: "{version}的评审小组不同——不可比较",
    scNotComparableVerification: "{version}的核查设置不同——不可比较",
    scNotComparableUnmeasured: "{version}无法得出各维度等级——不可比较",
    scDeltaImproved: "改善",
    scDeltaWorsened: "变差",
    scDeltaUnchanged: "不变",
    scDeltaNew: "新增",
    scUnmeasured: "无法得出各维度等级——没有可读取的评审意见清单。",
    scNoReviewerRan: "无法得出各维度等级——未运行任何评审人。",
    scCaveat:
      "各维度等级由本次评审小组已定位的意见计算得出；印象为评审人未经校准的主观看法；两者都不预测是否录用。",
    scNarrowed: "仅显示{dimension} · {total} 条意见中的 {shown} 条",
    scShowAll: "显示全部",
    scSeatConcernsOf: "{total} 条意见中的 {shown} 条",
    menuReviewPdfDesc: "单独评审已编译的 PDF",
    mPdfReview: "PDF 评审",
    mPdfReviewDesc: "一位能看到已编译页面的评审人",
    mPdfReviewer: "PDF 评审人",
    mPdfReviewerOff: "关闭",
    mPdfReviewerDesc:
      "在评审小组之外查看排版页面，也可从评审标签页单独运行。需要能接受图像的模型。",
    mPdfReviewerBlind:
      "该模型不接受图像，将不会评审已编译 PDF。请另选模型，或设置其“图像输入”。",
    rReasonRateLimited: "触发限流",
    rReasonTimeout: "超时",
    rReasonFailed: "失败",
    rReasonAnonymous:
      "（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
    rReasonInterrupted: "被停止",
    rReasonUnparsed: "无法解析",
    rReasonInsufficientSeats: "给出报告的评审过少",
    rReasonNoReport: "没有报告",
    rListSep: "、",
    rCardWorking: "进行中",
    rCardRunning: "正在通读全文……",
    rCardSynthesis: "综述",
    rCardVerification: "核查",
    rCardFailed: "小组未能运行。",
    rCardInterrupted: "小组已被停止。",
    rCardRetried: "已重试",
    rDimSoundness: "论证",
    rDimClaims: "结论",
    rDimClarity: "清晰度",
    rDimPositioning: "定位",
    rDimOriginality: "原创性",
    rDimSignificance: "重要性",
    rDimRigor: "严谨性",
    rDimStructure: "结构",
    rDimLanguage: "语言",
    // D2: was "…“Lemmaria: Compile Check / 编译检查”…" — two languages in one
    // string. A zh reader sees the zh command title, which is what
    // `cmd.verifyNow` in package.nls.zh-cn.json already contributes.
    cEmpty: "运行“Lemmaria: 编译检查”以查看编译器的报告。",
    cFindings: "条待修复",
    cFix: "修复",
    cFixAll: "全部修复",
    cIgnore: "忽略",
    cFixed: "已修复的问题",
    cIgnored: "已忽略的问题",
    cAllResolved: "所有编译问题均已处理——暂无待办。",
    cClean: "编译通过，无任何问题。",
    cFailed: "项目未能编译通过，但未能从日志中解析出具体问题。",
    cGuidance: "无法编译该项目：",
    cReport:
      "编译是您主动请求的报告——修复将进入需确认的差异审阅，不会自动重新运行任何操作。",
  },
} as const;

/** Every key the table defines. `en` is the authority: a key missing from
 *  `zh` fails the build, and `strings.test.ts` asserts the parity. */
export type StringKey = keyof (typeof STR)["en"];

/**
 * ONE language, chosen by the reader (invariant 6 rule 2). Never returns a
 * string carrying both — that is a defect, and every value in the table is
 * wholly one language.
 */
export function tr(locale: SessionLocale, key: StringKey): string {
  return STR[locale][key] as string;
}

/**
 * A review's version, written (ADR 0062 §1) — `v3` / `第3版`.
 *
 * Here rather than at the two call sites, because the transcript card and the
 * tab's picker must name the same review the same way: a reader who saw `v3`
 * in the transcript looks for `v3` in the list. Composed from two table keys
 * rather than a template, per this file's rule that no value is a template.
 */
export function versionLabel(locale: SessionLocale, version: number): string {
  return `${tr(locale, "rVersionPre")}${version}${tr(locale, "rVersionPost")}`;
}

/**
 * The date tag — the LOCAL calendar day, as `YYYY-MM-DD`.
 *
 * Deliberately not `toLocaleDateString`: the digits are the same in both
 * locales (so no string here is language), the ordering is unambiguous in a
 * list a user scans for "the one from Tuesday", and it is stable enough for a
 * test to assert. The local day, not UTC, because a review run at 23:00 was
 * run today from where the reader is sitting.
 */
export function dayStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
