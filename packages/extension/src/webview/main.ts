import "./styles.css";
import type {
  SessionEvent,
  SessionItem,
  SessionLocale,
  ToolErrorCode,
} from "@lemmaria/harness";
// The ONE runtime import the webview bundle takes (ADR 0011 keeps it
// self-contained): a narrow, dependency-free subpath so the per-file approval
// grouping and the pause predicate are shared with the host, not re-derived.
import {
  awaitsEditDecision,
  groupEditsByFile,
  summarizeEditGroup,
} from "@lemmaria/harness/session-edits";
// A leaf module with zero Node imports — the webview bundle is browser-platform,
// so it may only pull pure leaves like this one (the session-edits precedent).
import {
  summarizeToolArgs,
  summarizeToolResult,
} from "@lemmaria/harness/session-tool-summary";
import { QUICK_ACTION_ORDER, type QuickActionId } from "../quick-actions.js";
import type {
  BudgetInfo,
  CitationsC1State,
  CitationsC2State,
  CompileFindingInfo,
  CompileTabState,
  ConfiguredModelInfo,
  CostSummaryInfo,
  HostToWebview,
  ModelsState,
  ProbeResult,
  ProbeStep,
  QuickActionInfo,
  ReviewAnnotationInfo,
  ReviewTabState,
  SelectionState,
  VenueChecklistRowInfo,
  VenueState,
  VsCodeApi,
} from "../webview-protocol.js";
import { busyRow, welcomePanel } from "./parts/brand.js";
import {
  busyRowVisible,
  isStreamRetried,
  nextTurnStreamed,
  turnStreamedFromSnapshot,
} from "./parts/busy.js";
import { assistantToolbar, header } from "./parts/chrome.js";
import {
  type ActiveToken,
  type Candidate,
  type CommandVerb,
  type Completed,
  SIGIL_AT,
  SIGIL_SLASH,
  type SigilRule,
  activeToken,
  applyCompletion,
  label as candidateLabel,
  commandCandidates,
  forkCandidates,
  parseForkCommand,
  removeToken,
  reviewCandidates,
  reviewPdfCandidates,
  skillCandidates,
} from "./parts/completion.js";
import {
  type ContextPaths,
  contextNote,
  pathCandidates,
} from "./parts/context-paths.js";
import {
  type EditChoice,
  choiceAt,
  createDecisionMemory,
  forgetDecisions,
  groupDecisionView,
  liveChoices,
  pendingChoices,
  rememberPosted,
} from "./parts/decision.js";
import {
  createRenderScheduler,
  createScrollFollower,
  draftAnchor,
  replaceScrollPreserving,
  restoreDraft,
} from "./parts/frame.js";
import {
  menuKeyAction,
  needsExplicitNewline,
  shouldSubmit,
} from "./parts/keys.js";
import { agentMessage } from "./parts/markdown.js";
import {
  type MenuState,
  highlightAt,
  menuElement,
  menuHandles,
  menuRows,
  menuState,
  mountMenu,
  moveHighlight,
  reRank,
  scrollWindow,
  syncMenuAria,
} from "./parts/menu.js";
import { imageInputControl } from "./parts/model-image-input.js";
import { runProbeStep } from "./parts/probe.js";
import { declaredRemovals, removalLine } from "./parts/removals.js";
import type { ReviewRunView } from "./parts/review-progress.js";
import { chatDraft, resolvePrompt } from "./parts/review-prompts.js";
import {
  type ReviewRolesView,
  crossReviewCardBody,
  pdfReviewCardBody,
  reviewersCardBody,
} from "./parts/review-roles-card.js";
import { renderReviewTab } from "./parts/review-tab.js";
import { type RewindMenuHandle, openRewindMenu } from "./parts/rewind-menu.js";
import { contextRing, ringState } from "./parts/ring.js";
import { citeRow, el, foldedGroup } from "./parts/rows.js";
import { type FoldMemory, scriptOutputFold } from "./parts/script-card.js";
import { STR, type StringKey, tr } from "./parts/strings.js";

const vscode: VsCodeApi = acquireVsCodeApi();

/** Tiny DOM helper — no framework (ADR 0011). */

// ---- Locale-keyed strings live in `parts/strings.ts` (D2, ADR 0037), so
// both locales can be asserted offline. `t()` below keeps its signature. ----

// ---- Quick-action tables. MVP tiles come from `init` (real tiers from the
// action definitions); shells have no backend yet. The MVP order is
// `quick-actions.ts`'s — its one home (D4 / QA-2) — interleaved with the shell
// cells by GRID below. ----
const GLYPH: Record<string, string> = {
  polish: "✦",
  "shrink-to-target": "≡",
  expand: "⊕",
  proofread: "✓",
  translate: "文",
};
/**
 * Fallback tiles for the first paint, before `init` arrives.
 *
 * Order comes from `quick-actions.ts` (the one home, D4 / QA-2) and the labels
 * from `parts/strings.ts`, so the first paint is in the reader's language. Both
 * were hardcoded English here, and the wording had drifted too — the tile read
 * `Shrink` while the action is named `Shrink By`.
 */
const FALLBACK_TILE: Record<
  QuickActionId,
  { key: StringKey; tier: "L0" | "L1" }
> = {
  proofread: { key: "tileProofread", tier: "L0" },
  polish: { key: "tilePolish", tier: "L0" },
  "shrink-to-target": { key: "tileShrinkToTarget", tier: "L1" },
  expand: { key: "tileExpand", tier: "L1" },
  translate: { key: "tileTranslate", tier: "L1" },
};
/** Computed per call, not once at module load: `locale` is "en" until `init`
 *  arrives, and a fallback frozen before that would be English for ever. */
const mvpFallback = (): QuickActionInfo[] =>
  QUICK_ACTION_ORDER.map((id) => ({
    id,
    label: t(FALLBACK_TILE[id].key),
    tier: FALLBACK_TILE[id].tier,
  }));
const SHELLS: {
  name: { en: string; zh: string };
  glyph: string;
  tier: string;
  /** The roadmap version that promises it — never a version it doesn't. */
  tag: "v03" | "later";
}[] = [
  {
    name: { en: "Rephrase", zh: "改写" },
    glyph: "↻",
    tier: "L0",
    tag: "later",
  },
  {
    name: { en: "Academify", zh: "学术化" },
    glyph: "ᴀ",
    tier: "L0",
    tag: "later",
  },
  {
    name: { en: "Mock review", zh: "模拟评审" },
    glyph: "☷",
    tier: "L1",
    tag: "v03",
  },
];
/** Slot order: MVP index or shell index at each grid position. */
const GRID: ({ mvp: number } | { shell: number })[] = [
  { mvp: 0 },
  { mvp: 1 },
  { mvp: 2 },
  { shell: 0 },
  { mvp: 3 },
  { shell: 1 },
  { mvp: 4 },
  { shell: 2 },
];

// ---- State ----
let locale: SessionLocale = "en";
// 0 Assistant · 1 Citations · 2 Models · 3 Venue · 4 Review · 5 Compile
let activeTab = 0;
let citC1: CitationsC1State | undefined;
let citC2: CitationsC2State | undefined;
let citChecking = false;
let citFile = ""; // the file C1 was last requested for (refresh on file change)
let modelsState: ModelsState | undefined;
let venueState: VenueState | undefined;
let venueFile = ""; // the file the venue state was last requested for
let reviewTab: ReviewTabState | undefined;
/** ADR 0065 §3: the detached panel in flight, with its notices already
 *  localized — the host pushes `NoticeItem`s and `noticeText` renders them
 *  here, so a notice code has one rendering in the whole product. */
let reviewRun: ReviewRunView | undefined;
let compileTab: CompileTabState | undefined;
// The two triage sub-lists fold shut by default (clean view); remember the
// user's choice across re-renders so accepting/ignoring doesn't re-collapse.
/**
 * Which Review-tab groups the reader has folded (ADR 0062 §4).
 *
 * Keyed rather than one flag per group: every group folds now — one per seat,
 * the synthesis, the limits, the archive — and the seat set is a table in the
 * harness, so a boolean per group here would be a field to add whenever that
 * table grows. Absent = the group's own default, which is why the renderer
 * passes one in.
 */
const reviewFolds = new Map<string, boolean>();
/**
 * V6 (ADR 0088 §4): the dimension a scorecard row narrowed the Review tab's
 * concerns to. View state beside the folds, for their reason: never
 * persisted, so it survives a re-push and a version switch, not a reload.
 */
let reviewNarrow: string | undefined;
/**
 * V6: a concern to land on in the next Review render — a synthesis chip's,
 * whose row the narrowing it just cleared had hidden. The tab marks the row
 * and opens its fold while building; `render()` scrolls it once attached,
 * and the render that does so consumes it.
 */
let reviewTarget: string | undefined;
// The Compile tab's own pair (same rule, its own fold state).
let fixedOpen = false;
let cIgnoredOpen = false;
let mvpActions: QuickActionInfo[] = mvpFallback();
let modelLabel = "";
let budgetInfo: BudgetInfo | undefined;
/** A2: the last measured context occupancy the host pushed (undefined = unknown). */
let contextUsage: { occupied?: number; window: number } | undefined;
/** A5: THIS session's spend, folded by the host from its persisted turns. */
let sessionCost:
  | {
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
      /** Calls that reported tokens but no price — see costReadout. */
      unpricedCalls?: number;
    }
  | undefined;
let selectionState: SelectionState = {
  docKind: null,
  hasSelection: false,
  file: "",
  startLine: 0,
  endLine: 0,
};
const mvpTiles = new Map<string, HTMLButtonElement>();
let sendBtn: HTMLButtonElement | undefined;
let composerInput: HTMLTextAreaElement | undefined;
/**
 * ADR 0062 §6: the next Assistant render should put the caret in the composer.
 *
 * A flag rather than a `focus()` call at the click, because the composer the
 * click can see is the DETACHED one from the last Assistant render — focusing
 * it would do nothing, and the node the user will actually type into does not
 * exist until `render()` builds it.
 */
let pendingComposerFocus = false;
let chipEl: HTMLElement | undefined;
let heroEl: HTMLElement | undefined;
let modelPill: HTMLElement | undefined;

// ---- A0 session transcript: a pure fold of received sessionEvent messages,
// mirroring the harness replayEntries (the bundle stays self-contained —
// type-only imports erase, so the typed union costs nothing, ADR 0011).
// Other item kinds (tool_call, todo_list, …) arrive with A1+; A0 renders
// messages and errors only. ----
const transcriptOrder: string[] = [];
const transcriptById = new Map<string, SessionItem>();
const completedIds = new Set<string>();
let sessionBusy = false;
/**
 * CHAT-3: the CURRENT turn has put text on screen. Reset wherever `sessionBusy`
 * is set, which is what gives the busy row back to the next turn without a
 * second mechanism (see `parts/busy.ts`).
 */
let turnStreamed = false;
/**
 * A5: messages sent while a task was running. The host queues them as steering
 * and drains them at the next turn boundary (ADR 0015) — but the composer gave
 * no sign of it, so a user could not tell a steer from a new task, or see that
 * their message was waiting. Cleared when the task ends (they have been
 * delivered, or visibly discarded by the host's own warning).
 */
let queuedSteering: string[] = [];
// A1b: the session's edit policy (composer permission selector), kept in sync
// with the host via the `editPolicy` message.
let editPolicyState: "review" | "auto_apply" = "review";
// A4 (ADR 0019): the session's granted folders, kept in sync via `grantsState`;
// rendered as chips above the composer.
let sessionGrants: { id: string; label: string; path: string }[] = [];
// A1b: per-edit review choices being collected for a pending proposal
// (itemId → editIndex → decision). Survives transcript re-renders; the batch
// is posted once every pending edit is decided, then cleared.
// CHAT-5: TWO layers — see `parts/decision.ts`. Posting clears the collecting
// layer, and the re-render in the same tick is the one render the optimistic
// row exists for, so what was posted has to outlive it.
const editChoices = createDecisionMemory();
// CHAT-4: script output folds the user has opened or closed by hand. The
// transcript rebuilds its DOM on every streamed delta, so the gesture has to
// live outside it.
const openedFolds: FoldMemory = new Map();
// ADR 0031: the user messages the conversation can BRANCH at — every
// non-steered one, whether or not its turn wrote a file. E4 (ADR 0054) deleted
// the second set that used to sit beside this one (`writingBranchPointIds`, the
// subset with file changes after them): it chose between two glyphs and nothing
// else, and one face now serves every branch point.
//
// E7 (ADR 0055): a Map rather than a Set, because the transcript now needs the
// NUMBER as well as the membership — files the click would change, from the
// current leaf. Absence from the map still means "no control here"; a 0 in it
// means "a control, and clicking it changes nothing".
let rewindPointFiles = new Map<string, number>();
/**
 * The open ⟲ popover, or none (E6, D8).
 *
 * Module state for the same reason the completion menu's is: the transcript is
 * rebuilt wholesale by `render()`, and a handle held inside the tree would be
 * lost with the node it hung on — leaving a document-level Esc listener alive
 * over a menu that no longer exists. At most one is open at a time, which is
 * what makes a second click on the same ⟲ a dismissal.
 */
let rewindMenu: RewindMenuHandle | undefined;

/** Close the popover if one is open. Safe to call when there is none. */
function closeRewindMenu(): void {
  const open = rewindMenu;
  rewindMenu = undefined;
  open?.close();
}
// Half-typed rejection notes, keyed `itemId::file`. Kept in module state so an
// unrelated re-render (a branch-points push, a streaming item) cannot discard
// what the user was typing.
const rejectDrafts = new Map<string, string>();
// E2 (ADR 0049): the loaded writing skills, pushed by the host on ready and on
// every change (E1's toggle moves the enabled set while the panel is open).
let skillCatalogue: { name: string; description: string }[] = [];
// E2: the open completion menu, or nothing. In MODULE state, not in the DOM,
// for the reason `openedFolds` and `rejectDrafts` are: `render()` rebuilds the
// composer wholesale on every streamed delta, so anything held in the tree is
// destroyed a frame later.
//
// It holds its own TOKEN rather than re-deriving one from the caret (D4). The
// token is the span the user's TYPING established, and a render is not a user
// action: re-deriving it every frame would make what the menu is completing a
// function of the render schedule. `refreshComposerMenu` therefore runs on
// `input` and nowhere else, and the stored range then depends on nothing a
// rebuild touches. (`render()` now carries the caret across too — see
// `parts/frame.ts` — but that is a fix for the WRITER's position, not a licence
// to make the menu depend on it.)
let composerMenu: MenuState | undefined;
// E3 (ADR 0052): the `@` menu's candidate source — the paper workspace plus
// each active grant, walked by the host with the identical calls `list_files`
// makes. Pushed on `ready`, on every grant change, and on each `@`-open (a file
// created in the editor is invisible to a walk made at `ready`, which is the
// one way a path list goes stale where a skill catalogue does not).
let contextPaths: ContextPaths = { grants: [] };

/**
 * The live `.lm-composer` node, so the menu can be mounted into it WITHOUT a
 * render (operator's E-3 round, 2026-08-26).
 *
 * Held for the same reason `composerInput` is: `render()` rebuilds `.lm-app`'s
 * children wholesale, so anything that must outlive a frame has to be reachable
 * without querying the tree that is about to be replaced.
 */
let composerRoot: HTMLElement | undefined;

/**
 * Show what `composerMenu` says, in place.
 *
 * **This is deliberately NOT a render**, and that is the whole fix for the
 * operator's E-3 finding: a render rebuilds the composer, a rebuilt composer is
 * a new `<textarea>`, and a new textarea has an empty undo stack. See
 * `mountMenu` in `parts/menu.ts` for the full mechanism. Every menu effect —
 * opening, filtering, moving the highlight, scrolling, dismissing, accepting —
 * goes through here instead of through `scheduleRender()`.
 */
function syncComposerMenu(): void {
  if (composerRoot === undefined) return;
  const node =
    composerMenu === undefined
      ? undefined
      : menuElement(composerMenu, locale, {
          onPick: (index) => {
            acceptCompletion(index);
            composerMenu = undefined;
            syncComposerMenu();
          },
          onHover: (index) => {
            if (composerMenu === undefined) return;
            const next = highlightAt(composerMenu, index);
            if (next === composerMenu) return;
            composerMenu = next;
            syncComposerMenu();
          },
          onScroll: (delta) => {
            if (composerMenu === undefined) return;
            const next = scrollWindow(composerMenu, delta);
            // `scrollWindow` returns the SAME object when nothing moved — at
            // the ends of the list, and whenever every candidate already fits.
            // Re-mounting then would rebuild the rows under the pointer for no
            // change at all.
            if (next === composerMenu) return;
            composerMenu = next;
            syncComposerMenu();
          },
        });
  mountMenu(composerRoot, node, ".lm-composer__box");
  if (composerInput !== undefined) syncMenuAria(composerInput, composerMenu);
}

/**
 * Drop items that streamed (started/updated) but never completed — the engine
 * discarded that partial turn (interrupt or transient retry, ADR 0015), so a
 * ghost half-message or a tool call frozen at "running…" must not linger.
 */
function dropUncompletedItems(): void {
  for (let i = transcriptOrder.length - 1; i >= 0; i--) {
    const id = transcriptOrder[i];
    if (id !== undefined && !completedIds.has(id)) {
      transcriptOrder.splice(i, 1);
      transcriptById.delete(id);
    }
  }
}

/**
 * ADR 0027 deleted this fold's rewind rule. A rewind is no longer an event the
 * live transcript truncates on — it is a leaf move, after which the host
 * re-seeds the whole transcript through `transcriptReplay` (the same path a
 * resume and a window reload already use). That removes the second of the two
 * places a rewind had to be implemented identically, which ADR 0018 named as
 * the cheapest place to introduce a divergence bug.
 */
function foldSessionEvent(event: SessionEvent): void {
  // A1a (ADR 0015): tasks are multi-turn, so the busy state is task-scoped —
  // turn.completed no longer clears it (the next turn follows immediately).
  // CHAT-3: the whole rule lives in `parts/busy.ts` — including the clear on
  // `stream.retried`, which has no `turn.started` to ride on because the retry
  // loop is inside the turn.
  turnStreamed = nextTurnStreamed(turnStreamed, event);
  if (event.type === "task.started" || event.type === "turn.started") {
    sessionBusy = true;
  }
  if (event.type === "task.completed") {
    sessionBusy = false;
    queuedSteering = [];
  }
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    if (!transcriptById.has(event.item.id)) transcriptOrder.push(event.item.id);
    transcriptById.set(event.item.id, event.item);
    if (event.type === "item.completed") completedIds.add(event.item.id);
  }
  // A retried turn replays with fresh ids; a finished task leaves nothing
  // in flight — both discard whatever never completed.
  if (event.type === "task.completed" || isStreamRetried(event)) {
    dropUncompletedItems();
  }
}

/**
 * A5: the queued-steering chips. Codex/Claude Code both show queued input while
 * the agent works; before this the only sign a message had been queued was a
 * toast if it was later DISCARDED — the success path was invisible.
 */
function steeringRow(): HTMLElement {
  const row = el("div", { class: "lm-steering" });
  if (queuedSteering.length === 0) {
    row.style.display = "none";
    return row;
  }
  for (const text of queuedSteering) {
    row.append(
      el(
        "span",
        { class: "lm-steering__chip", title: t("steeringQueuedTip") },
        `⤴ ${text}`,
      ),
    );
  }
  return row;
}

/** "12.4K" / "980" — a token count at a glance, never a wall of digits. */
function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  // 999_999 must not render as "1000K" — roll over to M at the boundary.
  if (n < 999_500) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Money the reader can trust. `toFixed(3)` turned a real $0.0004 into "$0.000",
 * which reads as free — the one thing this project's cost surfaces must never
 * imply. Below a cent, say "< $0.01" instead of rounding to nothing.
 */
function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/**
 * A5: this session's spend next to the context ring. Tokens are always known;
 * dollars only when the model priced them — a BYOK, local or unknown-pricing
 * model shows tokens alone rather than a fabricated $0.00 (ADR 0002).
 *
 * A session can be MIXED: switching models mid-thread (or a compaction on an
 * unpriced model) leaves some calls priced and some not. The tokens are still
 * complete, but the dollar figure covers only part of the session — so it is
 * marked "+?" and the tip says how many calls it is missing, rather than
 * passing a knowingly-too-small number off as the accrued cost.
 */
function costReadout(): HTMLElement {
  if (
    !sessionCost ||
    (sessionCost.inputTokens === 0 && sessionCost.outputTokens === 0)
  ) {
    return el("span", { class: "lm-cost lm-cost--empty" });
  }
  const tokens = `↑${shortTokens(sessionCost.inputTokens)} ↓${shortTokens(
    sessionCost.outputTokens,
  )}`;
  const priced = sessionCost.costUsd !== undefined;
  const unpriced = sessionCost.unpricedCalls ?? 0;
  // Partial only matters alongside a dollar figure: with none shown, the
  // tokens-only tip already explains why there is no money on screen.
  const partial = priced && unpriced > 0;
  const text = priced
    ? `${tokens} · ${formatUsd(sessionCost.costUsd ?? 0)}${partial ? " +?" : ""}`
    : tokens;
  const title = partial
    ? t("costTipPartial").replace("{n}", String(unpriced))
    : priced
      ? t("costTipPriced")
      : t("costTipTokens");
  return el(
    "span",
    { class: "lm-cost", title, "aria-label": `${text} — ${title}` },
    text,
  );
}

/** A1a: `Lemmaria: New Session` started a fresh thread — clear the fold. */
function resetTranscript(): void {
  transcriptOrder.length = 0;
  transcriptById.clear();
  completedIds.clear();
  sessionBusy = false;
  turnStreamed = false;
  openedFolds.clear();
  forgetDecisions(editChoices);
  editPolicyState = "review";
  rewindPointFiles = new Map();
  rejectDrafts.clear();
  // A4: grants are per-session; the host pushes the empty set too (belt).
  sessionGrants = [];
  // A5: a fresh thread has spent nothing yet.
  sessionCost = undefined;
  queuedSteering = [];
}

/**
 * A5: rebuild the transcript from the host's snapshot of the session already
 * live in this host — what this bundle lost when it re-executed (window reload,
 * the view dragged to another container). The items arrive already replayed
 * (rewinds folded in, undecided proposals normalized), so they seed the fold
 * exactly as `item.completed` events would.
 */
function seedTranscript(items: SessionItem[]): void {
  // MERGE, never clobber, and there is no longer an exception: a live event can
  // land between the host reading the snapshot and this message arriving, and
  // that item is never re-sent — a clear-and-replace would drop it permanently.
  // Snapshot items go first (they are the older history), then anything the
  // fold already holds that the snapshot did not carry.
  //
  // ADR 0027 had one inverting case — after a branch move, "held but not in the
  // snapshot" was the branch just rewound away from — and marked those posts
  // `authoritative` so they replaced instead. ADR 0057 retires it with the
  // move: a rewind switches to a forked session, and a resume clears this fold
  // before replaying, so nothing stale can survive to be merged back in.
  const held = new Map(transcriptById);
  const live = transcriptOrder.filter((id) => !items.some((i) => i.id === id));
  const liveItems = live.flatMap((id) => {
    const item = transcriptById.get(id);
    return item ? [{ id, item, completed: completedIds.has(id) }] : [];
  });
  transcriptOrder.length = 0;
  transcriptById.clear();
  completedIds.clear();
  for (const item of items) {
    transcriptOrder.push(item.id);
    // Sharing an id is not sharing CONTENT: some items upsert in place under a
    // stable id (a task's plan is one item rewritten each update — run.ts), so
    // "the snapshot also has this id" does not make the snapshot's copy right.
    // Anything already in this fold arrived AFTER the host read the snapshot
    // (messages are delivered in post order), i.e. it is the newer of the two
    // — writing the snapshot over it would regress the card to stale content.
    // The snapshot still owns POSITION: it is the authority on transcript order.
    transcriptById.set(item.id, held.get(item.id) ?? item);
    // Completion is not in question either way: a snapshot item is a persisted,
    // completed one, and only completed items are ever persisted.
    completedIds.add(item.id);
  }
  for (const entry of liveItems) {
    transcriptOrder.push(entry.id);
    transcriptById.set(entry.id, entry.item);
    if (entry.completed) completedIds.add(entry.id);
  }
  // A pending batch that outlived the reload is decided again from the card;
  // stale local choices would mislabel its rows.
  forgetDecisions(editChoices);
  rejectDrafts.clear();
  // `openedFolds` is deliberately NOT cleared here. Item ids are stable across
  // a replay, so a script fold the user opened should survive a reload the
  // same way it survives a delta — a decision is a claim about a batch that is
  // being re-decided, an open fold is just where the user was reading.
}

function t(key: StringKey): string {
  return tr(locale, key);
}

// CHAT-6: both strips live in `parts/chrome.ts` so what each one carries is
// asserted. The split is the point — `header()` shows on every tab, so a
// session control in it shows on tabs where it means nothing.
const globalHeader = () =>
  header(locale, {
    onSettings: () => vscode.postMessage({ type: "openSettings" }),
  });
const sessionBar = () =>
  assistantToolbar(locale, {
    onHistory: () => vscode.postMessage({ type: "resumeSession" }),
    onNew: () => vscode.postMessage({ type: "newSession" }),
  });

function selectTab(i: number): void {
  if (i === activeTab) return;
  activeTab = i;
  scheduleRender();
  if (activeTab === 1) {
    citFile = selectionState.file; // track the file C1 is being requested for
    requestCitations();
  }
  if (activeTab === 2) {
    vscode.postMessage({ type: "requestModels" });
  }
  if (activeTab === 3) {
    venueFile = selectionState.file;
    vscode.postMessage({ type: "requestVenue" });
  }
  if (activeTab === 4) {
    vscode.postMessage({ type: "requestReview" });
  }
  if (activeTab === 5) {
    vscode.postMessage({ type: "requestCompile" });
  }
}

function tabBar(): HTMLElement {
  const bar = el("div", { class: "lm-tabs", role: "tablist" });
  const btns: HTMLButtonElement[] = [];
  STR[locale].tabs.forEach((name, i) => {
    const selected = i === activeTab;
    const btn = el(
      "button",
      {
        class: "lm-tab",
        role: "tab",
        id: `lm-tab-${i}`,
        "aria-selected": String(selected),
        "aria-controls": "lm-tabpanel",
        tabindex: selected ? "0" : "-1",
      },
      name,
    ) as HTMLButtonElement;
    // Citations tab: a small count badge when C1 found issues.
    if (i === 1 && citC1 && citC1.issues.length > 0) {
      btn.append(
        el("span", { class: "lm-tab__badge" }, String(citC1.issues.length)),
      );
    }
    btn.addEventListener("click", () => selectTab(i));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const n = STR[locale].tabs.length;
        const next = (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
        selectTab(next);
        btns[next]?.focus();
      }
    });
    btns.push(btn);
    bar.append(btn);
  });
  return bar;
}

function mvpTile(info: QuickActionInfo): HTMLButtonElement {
  const btn = el("button", {
    class: "lm-tile",
    "data-action-id": info.id,
  }) as HTMLButtonElement;
  btn.append(
    el("span", { class: "lm-tile__glyph" }, GLYPH[info.id] ?? "✦"),
    el("span", { class: "lm-tile__name" }, info.label),
    el("span", { class: "lm-tile__tier" }, info.tier),
  );
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    vscode.postMessage({ type: "runQuickAction", actionId: info.id });
  });
  mvpTiles.set(info.id, btn);
  return btn;
}

function shellTile(s: (typeof SHELLS)[number]): HTMLButtonElement {
  const btn = el("button", {
    class: "lm-tile",
    title: s.tag === "v03" ? t("shellTipV03") : t("shellTipLater"),
  }) as HTMLButtonElement;
  btn.disabled = true;
  btn.append(
    el("span", { class: "lm-tile__glyph" }, s.glyph),
    el("span", { class: "lm-tile__name" }, s.name[locale]),
    el("span", { class: "lm-tile__tier" }, s.tier),
    el("span", { class: "lm-tag" }, s.tag === "v03" ? t("v03") : t("later")),
  );
  return btn;
}

function quickActions(): HTMLElement {
  mvpTiles.clear();
  const grid = el("div", { class: "lm-grid" });
  for (const slot of GRID) {
    if ("mvp" in slot) {
      const info = mvpActions[slot.mvp];
      if (info) grid.append(mvpTile(info));
    } else {
      const s = SHELLS[slot.shell];
      if (s) grid.append(shellTile(s));
    }
  }
  return grid;
}

function content(): HTMLElement {
  // P1b: one intro region, not two (operator direction). P1 put the branded
  // welcome panel inside the transcript, below the quick actions, while this
  // slot still held U1's diamond hero above them — two centred
  // mark/title/subtitle blocks in one scroll view. The welcome panel takes the
  // slot; `applySelection`'s hide-on-selection toggle below is unchanged.
  heroEl = welcomePanel(t("welcomeTitle"), t("welcomeBody"));
  return el(
    "div",
    { class: "lm-content", role: "tabpanel", id: "lm-tabpanel" },
    heroEl,
    el("div", { class: "lm-section-label" }, t("quickActions")),
    quickActions(),
  );
}

/** A0: the session transcript (folded sessionEvent stream), above the composer. */
/** A1b: post the collected decisions once every pending edit has one. */
function maybePostDecisions(item: SessionItem): void {
  if (item.type !== "edit_proposal") return;
  const choices = pendingChoices(editChoices, item.id);
  if (!choices) return;
  const pendingIdx = item.edits
    .map((e, i) => (e.status === "pending" ? i : -1))
    .filter((i) => i >= 0);
  if (pendingIdx.length === 0 || !pendingIdx.every((i) => choices.has(i)))
    return;
  const decisions = item.edits.map(
    (_e, i) => choices.get(i) ?? { accept: false },
  );
  vscode.postMessage({ type: "editDecisions", itemId: item.id, decisions });
  // NOT a delete: the choices move to the posted layer, so the row can keep
  // showing them until the host's echo settles the status (CHAT-5).
  rememberPosted(editChoices, item.id);
}

/**
 * CHAT-5 (b): how many OTHER files in this batch still have no choice — the
 * exact reason `maybePostDecisions` is still holding this one back.
 */
function undecidedFileCount(
  item: Extract<SessionItem, { type: "edit_proposal" }>,
  chosen: (i: number) => EditChoice | undefined,
  exceptFile: string,
): number {
  return groupEditsByFile(item.edits).filter(
    (g) =>
      g.file !== exceptFile &&
      g.indices.some((i) => item.edits[i]?.status === "pending" && !chosen(i)),
  ).length;
}

const EDIT_GLYPH: Record<string, string> = {
  applied: "✓",
  pending: "●",
  stale: "⟲",
  rejected: "✗",
  invalid: "✗",
};

function editStatusLabel(status: string): string {
  if (status === "applied") return t("editApplied");
  if (status === "rejected") return t("editRejected");
  if (status === "stale") return t("editStale");
  if (status === "invalid") return t("editInvalid");
  return "";
}

/**
 * A1b: an edit_proposal card. The approval unit is the FILE, not the edit
 * (manual-test finding 2b): a batch of five typo fixes in one paper is one
 * decision, not five. Rows are per-file; the posted decision array is still
 * per-edit — the group's choice fans out over its indices.
 */
function editProposalCard(
  item: Extract<SessionItem, { type: "edit_proposal" }>,
): HTMLElement {
  const card = el("div", { class: "lm-msg lm-msg-proposal" });
  card.append(el("div", { class: "lm-todo__title" }, `✎ ${t("editProposal")}`));
  // Approval is live only while this batch still has pending edits and a task
  // is running (the pause) — a terminal/replayed record shows statuses only.
  const decidable =
    sessionBusy && item.edits.some((e) => e.status === "pending");
  const choices = decidable
    ? liveChoices(editChoices, item.id)
    : new Map<number, EditChoice>();
  // Live first, then what has already been posted — the second is what keeps
  // the row decided across the re-render that follows a post (CHAT-5).
  const chosen = (i: number) =>
    decidable ? choiceAt(editChoices, item.id, i) : undefined;

  for (const group of groupEditsByFile(item.edits)) {
    const edits = group.indices.flatMap((i) => {
      const edit = item.edits[i];
      return edit ? [edit] : [];
    });
    const pendingIdx = group.indices.filter(
      (i) => item.edits[i]?.status === "pending",
    );
    // One glyph for the file. `applied` wins over a failed sibling: a row
    // reading ✗ while one of its edits reached disk hides a real write.
    const { status: serverStatus, counts } = summarizeEditGroup(edits);
    // CHAT-5 (a): the row answers the click NOW. `summarizeEditGroup` stays the
    // one home for folding a group's server statuses; `groupDecisionView` only
    // decides whether the user's own just-made choice shows first.
    const decidedNow = chosen(pendingIdx[0] as number);
    const view = groupDecisionView({
      serverStatus,
      ...(decidedNow ? { localChoice: { accept: decidedNow.accept } } : {}),
      undecidedRemaining: undecidedFileCount(item, chosen, group.file),
    });
    const status = view.status;
    const kinds = edits.some((e) => e.kind === "create")
      ? t("editCreate")
      : t("editReplace");
    const count =
      edits.length > 1 ? ` · ${edits.length} ${t("editUnitPlural")}` : "";
    // Mixed outcomes are spelled out rather than collapsed to one word — but
    // not while showing an optimistic decision, which is one choice about the
    // whole file and has no mixture to report yet.
    const mixed = !view.optimistic && Object.keys(counts).length > 1;
    const label = mixed
      ? Object.entries(counts)
          .map(([s, n]) => `${n} ${editStatusLabel(s) || s}`)
          .join(" · ")
      : editStatusLabel(status);
    const row = el(
      "div",
      { class: `lm-proposal__row lm-proposal--${status}` },
      `${EDIT_GLYPH[status] ?? "●"} ${group.file} · ${kinds}${count}${
        label ? ` · ${label}` : ""
      }`,
    );
    card.append(row);
    // Per-edit reasons (anchor not found, the user's reject note) still show —
    // grouping the DECISION must not hide why an individual edit failed.
    for (const edit of edits) {
      if (!edit.note) continue;
      card.append(
        el("div", { class: "lm-proposal__note-line" }, `— ${edit.note}`),
      );
    }
    // D2 deliverable 8 (X2's T6): what the model declared it is removing on
    // purpose. ADR 0033 §2 withdrew D1's anchor carve-out because this would be
    // legible here; until now it was not.
    const removes = removalLine(
      declaredRemovals(item.edits, group.indices),
      locale,
    );
    if (removes) card.append(removes);
    if (!decidable || pendingIdx.length === 0) continue;

    const decided = decidedNow;
    const decideAll = (choice: { accept: boolean; note?: string }) => {
      for (const i of pendingIdx) choices.set(i, choice);
      maybePostDecisions(item);
      scheduleRender();
    };
    const viewBtn = el(
      "button",
      { class: "lm-btn lm-btn--secondary" },
      t("editViewDiff"),
    );
    viewBtn.addEventListener("click", () =>
      vscode.postMessage({
        type: "showEditDiff",
        itemId: item.id,
        file: group.file,
      }),
    );
    const acceptBtn = el(
      "button",
      { class: "lm-btn lm-btn--primary" },
      t("editAccept"),
    );
    acceptBtn.addEventListener("click", () => decideAll({ accept: true }));
    const rejectBtn = el(
      "button",
      { class: "lm-btn lm-btn--secondary" },
      t("editReject"),
    );
    const draftKey = `${item.id}::${group.file}`;
    const rejectRow = (): HTMLElement => {
      const note = el("input", {
        class: "lm-input lm-proposal__note",
        placeholder: t("editRejectNote"),
      }) as HTMLInputElement;
      note.value = rejectDrafts.get(draftKey) ?? "";
      note.addEventListener("input", () =>
        rejectDrafts.set(draftKey, note.value),
      );
      const confirm = el(
        "button",
        { class: "lm-btn lm-btn--secondary" },
        t("editReject"),
      );
      confirm.addEventListener("click", () => {
        const text = note.value.trim();
        rejectDrafts.delete(draftKey);
        decideAll({ accept: false, ...(text ? { note: text } : {}) });
      });
      return el("div", { class: "lm-proposal__reject" }, note, confirm);
    };
    // Re-open the note row after a re-render if one was already in progress.
    if (rejectDrafts.has(draftKey)) row.append(rejectRow());
    rejectBtn.addEventListener("click", () => {
      if (rejectDrafts.has(draftKey)) return; // already open
      rejectDrafts.set(draftKey, "");
      const opened = rejectRow();
      row.append(opened);
      opened.querySelector("input")?.focus();
    });
    const controls = el("div", { class: "lm-proposal__controls" });
    if (decided) {
      controls.append(
        el(
          "span",
          { class: "lm-proposal__decided" },
          decided.accept ? `✓ ${t("editAccept")}` : `✗ ${t("editReject")}`,
        ),
      );
      // CHAT-5 (b): the post is blocked until every file in the batch has a
      // choice, so this decision has genuinely done nothing yet. Saying so
      // beats a row that looks settled while the batch sits there.
      if (view.waitingFor > 0) {
        controls.append(
          el(
            "span",
            { class: "lm-proposal__waiting" },
            t("editWaitingForOthers").replace("{n}", String(view.waitingFor)),
          ),
        );
      }
    } else {
      controls.append(viewBtn, acceptBtn, rejectBtn);
    }
    row.append(controls);
  }

  // Only worth offering when there is more than one file left to decide.
  const undecidedFiles = groupEditsByFile(item.edits).filter((g) =>
    g.indices.some((i) => item.edits[i]?.status === "pending" && !chosen(i)),
  );
  if (decidable && undecidedFiles.length > 1) {
    const acceptAll = el(
      "button",
      { class: "lm-btn lm-btn--primary lm-proposal__all" },
      t("editAcceptAll"),
    );
    acceptAll.addEventListener("click", () => {
      for (const [i, edit] of item.edits.entries()) {
        if (edit.status === "pending") choices.set(i, { accept: true });
      }
      maybePostDecisions(item);
      scheduleRender();
    });
    card.append(acceptAll);
  }
  return card;
}

const SCRIPT_GLYPH: Record<string, string> = {
  pending: "⏳",
  running: "▶",
  completed: "✓",
  failed: "✗",
  denied: "⊘",
};

/**
 * Render an argv unambiguously (review #3): a plain `join(" ")` hides argument
 * boundaries, so an arg containing spaces or newlines can look materially
 * different from what actually runs. Tokens that aren't plain shell-safe words
 * are JSON-quoted, making whitespace, quotes, and newlines visible.
 */
function formatArgv(argv: string[]): string {
  return argv
    .map((a) =>
      a.length > 0 && /^[\w./:@=+-]+$/.test(a) ? a : JSON.stringify(a),
    )
    .join(" ");
}

/**
 * A4b (ADR 0020): a run_script card. Shows the full argv (what actually runs),
 * the granted folder (cwd), captured output, and — while pending — Approve /
 * Deny (+ reason) / "Always allow this script this session". Approving consents
 * to the script's file effects; the source the user approves is the argv here
 * plus the script file the model created via propose_edit (visible above).
 */
function scriptRunCard(
  item: Extract<SessionItem, { type: "script_run" }>,
): HTMLElement {
  const card = el("div", { class: "lm-msg lm-msg-proposal" });
  card.append(el("div", { class: "lm-todo__title" }, `⚙ ${t("scriptRun")}`));
  card.append(
    el(
      "div",
      { class: `lm-proposal__row lm-proposal--${item.status}` },
      `${SCRIPT_GLYPH[item.status] ?? "●"} ${formatArgv(item.command)}`,
    ),
  );
  card.append(
    el(
      "div",
      { class: "lm-proposal__note-line" },
      `${t("scriptInCwd")} ${item.rootLabel} (${item.rootId})`,
    ),
  );
  // review #2: every surface, the card included, must state that a script runs
  // with full OS permissions and network access (ADR 0020 §6).
  if (item.status === "pending") {
    card.append(
      el(
        "div",
        { class: "lm-proposal__note-line lm-script__warn" },
        t("scriptPermsWarning"),
      ),
    );
  }
  if (item.note) {
    card.append(
      el("div", { class: "lm-proposal__note-line" }, `— ${item.note}`),
    );
  }
  // review #2: show the script SOURCE being approved, not just its filename.
  if (item.status === "pending" && item.scriptPreview) {
    card.append(
      el("pre", { class: "lm-script__out lm-script__src" }, item.scriptPreview),
    );
  }
  // CHAT-4: fold it, the same way a tool_call row already folds — collapsed on
  // success, open on failure. The approval-time source preview above stays
  // open on purpose: it is the thing the user is being asked to approve.
  const fold = scriptOutputFold(item, locale, openedFolds);
  if (fold) card.append(fold);
  const decidable = sessionBusy && item.status === "pending";
  if (decidable) {
    const note = el("input", {
      class: "lm-input lm-proposal__note",
      placeholder: t("scriptDenyNote"),
    }) as HTMLInputElement;
    const always = el("input", {
      type: "checkbox",
      class: "lm-script__always-cb",
    }) as HTMLInputElement;
    const alwaysLabel = el("label", { class: "lm-script__always" });
    alwaysLabel.append(
      always,
      document.createTextNode(` ${t("scriptAlwaysAllow")}`),
    );
    const approve = el(
      "button",
      { class: "lm-btn lm-btn--primary" },
      t("scriptApprove"),
    );
    approve.addEventListener("click", () =>
      vscode.postMessage({
        type: "scriptDecision",
        itemId: item.id,
        approve: true,
        alwaysAllow: always.checked,
      }),
    );
    const deny = el(
      "button",
      { class: "lm-btn lm-btn--secondary" },
      t("scriptDeny"),
    );
    deny.addEventListener("click", () => {
      const text = note.value.trim();
      vscode.postMessage({
        type: "scriptDecision",
        itemId: item.id,
        approve: false,
        ...(text ? { note: text } : {}),
      });
    });
    const controls = el("div", { class: "lm-proposal__controls" });
    controls.append(approve, deny);
    card.append(note, alwaysLabel, controls);
  } else if (item.status === "running") {
    card.append(el("div", { class: "lm-msg lm-msg-busy" }, t("scriptRunning")));
  }
  return card;
}

const SUBTASK_GLYPH: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  interrupted: "⏹",
  running: "…",
};

/**
 * A3 (ADR 0022): a subtask fan-out card. Shows one row per child — its goal,
 * status glyph, and the short report it returned — the "location list + summary,
 * not the source text" isolation (the child's full transcript stays hidden).
 */
function subtaskCard(
  item: Extract<SessionItem, { type: "subtask" }>,
): HTMLElement {
  const card = el("div", { class: "lm-msg lm-msg-proposal" });
  card.append(
    el(
      "div",
      { class: "lm-todo__title" },
      `🡒 ${item.reports.length} ${t("subtaskExplored")}`,
    ),
  );
  for (const r of item.reports) {
    card.append(
      el(
        "div",
        { class: `lm-proposal__row lm-proposal--${r.status}` },
        `${SUBTASK_GLYPH[r.status] ?? "●"} ${r.goal}`,
      ),
    );
    // While a child is still running its summary is empty — show a live
    // "running…" line so a serial fan-out isn't a wall of blank rows.
    const line = r.summary || (r.status === "running" ? t("toolRunning") : "");
    if (line) card.append(el("div", { class: "lm-proposal__note-line" }, line));
  }
  return card;
}

/**
 * A5 (review fix): the ARG SHAPES live in the harness beside the tool
 * definitions (`session/tool-summary.ts`), unit-tested there — the first cut of
 * this logic guessed camelCase names and silently summarized nothing for
 * read_span ranges, spawn_subtask and run_script. This half only FORMATS and
 * localizes what the harness returns (invariant 6).
 */
function formatToolArgs(tool: string, argsJson: string | undefined): string {
  const summary = summarizeToolArgs(tool, argsJson);
  if (summary.count !== undefined) {
    const unit =
      summary.unit === "children"
        ? t("toolChildren")
        : summary.unit === "edits"
          ? t("toolEdits")
          : t("toolSteps");
    const files =
      summary.files !== undefined && summary.files > 0
        ? ` · ${summary.files} ${t("toolFiles")}`
        : "";
    return `${summary.count} ${unit}${files}`;
  }
  return summary.text ?? "";
}

/** How big the answer was — or, honestly, that the tool refused. */
function formatToolResult(resultJson: string | undefined): string {
  const summary = summarizeToolResult(resultJson);
  // A failed call used to read "✗ tool · failed" with no reason at all, then
  // (A5) with an English reason. ADR 0024 gives it a CODE, so the reason is
  // localized and the model-facing detail rides beside it. Keyed by the
  // contract's union: a code added to the harness fails this build until both
  // locales have a label — the `noticeText` discipline, one row down.
  if (summary.error !== undefined) {
    const byCode: Record<ToolErrorCode, string> = {
      not_found: t("toolErrNotFound"),
      denied: t("toolErrDenied"),
      too_large: t("toolErrTooLarge"),
      refused: t("toolErrRefused"),
      rate_limited: t("toolErrRateLimited"),
      unavailable: t("toolErrUnavailable"),
      invalid: t("toolErrInvalid"),
    };
    return `${byCode[summary.error.code]}: ${summary.error.message}`;
  }
  const parts: string[] = [];
  if (summary.matches !== undefined)
    parts.push(`${summary.matches} ${t("toolMatches")}`);
  if (summary.results !== undefined)
    parts.push(`${summary.results} ${t("toolResults")}`);
  if (summary.files !== undefined)
    parts.push(`${summary.files} ${t("toolFiles")}`);
  if (summary.chars !== undefined)
    parts.push(`${summary.chars} ${t("toolChars")}`);
  if (summary.truncated) parts.push(t("toolTruncated"));
  // A6: a partial answer must not read like a complete one.
  if (summary.excluded !== undefined)
    parts.push(`${summary.excluded} ${t("toolExcluded")}`);
  if (summary.degradedSources !== undefined) {
    // R4: a source that did not answer AND ran without a key gets the pointer
    // appended after its own name, so the reader can tell which of several
    // named sources a key would actually help. By exception — a keyed source
    // that failed anyway, and an anonymous source that answered, get nothing.
    const anonymous = new Set(summary.anonymousSources ?? []);
    const named = summary.degradedSources
      .map((s) => (anonymous.has(s) ? `${s}${t("toolDegradedAnonymous")}` : s))
      .join(", ");
    parts.push(`${t("toolDegraded")}: ${named}`);
  }
  return parts.join(" · ");
}

/**
 * A5: notices render from their CODE, in the reader's language. The harness's
 * `message` is combined-bilingual by contract (it also serves the CLI and the
 * JSONL), and rendering it verbatim was the one place the UI showed every user
 * both languages. An unknown code falls back to the message — a notice added
 * later is still shown, just not yet localized.
 */
function noticeText(item: Extract<SessionItem, { type: "notice" }>): string {
  // Keyed by the CONTRACT's code union, not by `string`: a code added to the
  // harness fails this build until it has both locales, so the fallback below
  // exists for forward-compatibility at runtime, never as a place to forget.
  const byCode: Record<
    Extract<SessionItem, { type: "notice" }>["code"],
    string
  > = {
    "budget.turns": t("noticeBudgetTurns"),
    "budget.tool_calls": t("noticeBudgetToolCalls"),
    "budget.output_tokens": t("noticeBudgetTokens"),
    "context.limit": t("noticeContextLimit"),
    "compaction.failed": t("noticeCompactionFailed"),
    "stream.retried": t("noticeStreamRetried"),
    "stream.retry_failed": t("noticeStreamRetryFailed"),
    "provider.quota": t("noticeProviderQuota"),
    "model.unverified": t("noticeModelUnverified"),
    "turn.truncated": t("noticeTurnTruncated"),
    "turn.truncated_recovered": t("noticeTurnTruncatedRecovered"),
    "review.skill_missing": t("noticeReviewSkillMissing"),
    "review.no_manuscript": t("noticeReviewNoManuscript"),
    "review.seat_budget": t("noticeReviewSeatBudget"),
    "review.reviewers_clamped": t("noticeReviewReviewersClamped"),
    "review.manuscript_unresolved": t("noticeReviewManuscriptUnresolved"),
    "review.manuscript_incomplete": t("noticeReviewManuscriptIncomplete"),
    "review.model_quota": t("noticeReviewModelQuota"),
    "review.model_unreachable": t("noticeReviewModelUnreachable"),
    "review.model_refused": t("noticeReviewModelRefused"),
    "review.verifier_budget": t("noticeReviewVerifierBudget"),
  };
  const text = byCode[item.code];
  if (text === undefined) return item.message;
  // B2 (ADR 0026): the notice now carries the number its sentence names, so a
  // localized string can render it too. Before this the harness interpolated
  // `n` into its own bilingual fallback and threw it away, which is why every
  // string here used to be number-free.
  return item.n === undefined ? text : text.replace("{n}", String(item.n));
}

/**
 * One transcript item → its node. A SWITCH, deliberately: the previous
 * if/else ladder rendered an unhandled item kind as NOTHING (that is how
 * `reasoning` stayed invisible from A1a to A5), so the default arm now shows an
 * honest unknown-item row instead of silently dropping it.
 */
function renderItem(item: SessionItem): HTMLElement | undefined {
  switch (item.type) {
    case "user_message": {
      const bubble = el("div", { class: "lm-msg lm-msg-user" }, item.text);
      // ADR 0031: ONE affordance, on every message the conversation can branch
      // at, and it never refuses.
      //
      // E4 (ADR 0054, CHAT-7 point 1): and now ONE FACE. ADR 0031 kept B6's
      // two — ⟲ where files would change, ⑂ where they would not — on the
      // reasoning that those are different promises. They are, but the glyph
      // was the wrong place to make them: both faces posted the same message
      // and ran the same operation, so the split asked the reader to decode an
      // implementation detail (what the turn happened to write) before they
      // could act, and gave them nothing to do with the answer. What it used
      // to signal, the confirm modal already states by path.
      //
      // E7 (ADR 0055): and now one face carrying a NUMBER. J1 reported that
      // the pre-click signal E4 removed is genuinely missed, which is the
      // revisit trigger ADR 0054's own rejected-alternatives list wrote for
      // this. What comes back is not the retired category — a fact about what
      // that turn happened to write — but files THIS CLICK would change,
      // counted from the current leaf. The glyph itself is untouched, which is
      // what keeps ADR 0054 §1 literally true: the count is a sibling node,
      // not a mutation of the character.
      const files = rewindPointFiles.get(item.id);
      if (files !== undefined) {
        // Zero renders no annotation (ADR 0055 §3): the mark exists to warn,
        // and a warning on the null case is chrome. The tooltip carries the
        // difference between "none" and "not computed" in words, which is
        // where a specific belongs.
        const title =
          files > 0
            ? t("rewindTitleFiles").replace("{n}", String(files))
            : t("rewindTitleNoFiles");
        const rewind = el(
          "button",
          {
            class: "lm-msg-user__restore",
            title,
            "aria-label": title,
          },
          "⟲",
        );
        if (files > 0)
          rewind.append(
            el("span", { class: "lm-msg-user__restore-count" }, String(files)),
          );
        const messageId = item.id;
        // E6 (D8, ADR 0058 §4): the click opens a MENU rather than starting a
        // rewind. ADR 0054 gave the control one face; E6 gives that face three
        // arms, because "go back" turned out to be two operations the user
        // wants separately — the conversation and the worktree — and the pair
        // together. A second click on the same control dismisses it, which is
        // why `openRewindMenu` does not treat the anchor as a click-away.
        rewind.addEventListener("click", () => {
          const open = rewindMenu;
          closeRewindMenu();
          if (open?.messageId === messageId) return;
          rewindMenu = openRewindMenu(rewind, {
            messageId,
            locale,
            post: (message) => vscode.postMessage(message),
            onClose: () => {
              if (rewindMenu?.messageId === messageId) rewindMenu = undefined;
            },
          });
        });
        bubble.append(rewind);
      }
      return bubble;
    }
    case "agent_message":
      // D3 (CHAT-2, ADR 0039): the whole bubble is built in `parts/markdown.ts`
      // so that this line carries no rendering decision of its own. ADR 0040's
      // chrome is passed IN rather than reached for, so that module stays free
      // of `acquireVsCodeApi()` and of this one's locale state.
      return agentMessage(item.text, {
        locale,
        onCopy: (text) => vscode.postMessage({ type: "copyText", text }),
      });
    case "reasoning": {
      // A5: the model's own summary of its thinking. Dimmed and collapsed by
      // default — it is context for the answer, never the answer itself.
      if (!item.summary) return undefined;
      const card = el("details", { class: "lm-msg lm-msg-reasoning" });
      card.append(
        el("summary", { class: "lm-reasoning__head" }, `✻ ${t("reasoning")}`),
        el("div", { class: "lm-reasoning__body" }, item.summary),
      );
      return card;
    }
    case "error":
      return el(
        "div",
        { class: "lm-msg lm-msg-error" },
        `${t("sessionError")}: ${item.message}`,
      );
    case "tool_call": {
      // A1a: ⚙ name + live status. A5: plus what it asked for and how big the
      // answer was, expanding to the raw JSON on click.
      const glyph =
        item.status === "in_progress"
          ? "⚙"
          : item.status === "failed"
            ? "✗"
            : "✓";
      const status =
        item.status === "in_progress"
          ? t("toolRunning")
          : item.status === "failed"
            ? t("toolFailed")
            : "";
      const args = formatToolArgs(item.tool, item.argsJson);
      // Both terminal states carry a reason worth showing: completed → what
      // came back, failed → why.
      const result =
        item.status === "in_progress" ? "" : formatToolResult(item.resultJson);
      const head = [`${glyph} ${item.tool}`, args, status, result]
        .filter((part) => part !== "")
        .join(" · ");
      const row = el("details", { class: "lm-msg lm-msg-tool" });
      row.append(el("summary", { class: "lm-tool__head" }, head));
      const raw = el("pre", { class: "lm-tool__raw" });
      raw.textContent = [
        item.argsJson ? `${t("toolArgs")}: ${item.argsJson}` : "",
        item.resultJson ? `${t("toolResult")}: ${item.resultJson}` : "",
      ]
        .filter((part) => part !== "")
        .join("\n");
      if (raw.textContent !== "") row.append(raw);
      return row;
    }
    case "todo_list": {
      const list = el("div", { class: "lm-msg lm-msg-todo" });
      list.append(el("div", { class: "lm-todo__title" }, t("plan")));
      for (const entry of item.items) {
        list.append(
          el(
            "div",
            { class: "lm-todo__row" },
            `${entry.completed ? "☑" : "☐"} ${entry.text}`,
          ),
        );
      }
      return list;
    }
    case "notice":
      // Honest engine stops (budgets, context limit, retry) — dimmed line, in
      // the reader's language (A5).
      return el("div", { class: "lm-msg lm-msg-notice" }, noticeText(item));
    case "compaction": {
      // A failed compaction leaves no card: the transient row it replaces was
      // never persisted, nothing was discarded, and the `compaction.failed`
      // notice emitted alongside it is the honest record. Rendering a second,
      // emptier one here would just say the same thing worse.
      if (item.status === "failed") return undefined;
      // Summarization reads the whole conversation, so it is the slowest call
      // in the app. While it runs, say so — a still transcript is
      // indistinguishable from a hang (D4 manual round).
      if (item.status === "running") {
        const row = el("div", { class: "lm-msg lm-msg-compaction" });
        row.append(
          el("span", { class: "lm-spin" }, "⌁"),
          el(
            "span",
            {},
            ` ${item.trigger === "auto" ? t("compactingAuto") : t("compacting")}`,
          ),
        );
        return row;
      }
      // A2 (ADR 0021): compaction is never silent — the summary the model now
      // carries is exactly what the user can read here.
      const card = el("div", { class: "lm-msg lm-msg-compaction" });
      card.append(
        el(
          "div",
          { class: "lm-todo__title" },
          `⌁ ${t("compacted")} · ${
            item.trigger === "manual"
              ? t("compactedManual")
              : t("compactedAuto")
          }`,
        ),
      );
      card.append(el("div", { class: "lm-compaction__summary" }, item.summary));
      return card;
    }
    case "grant_update": {
      // A4 (ADR 0019): the transcript's record of a grant change — dimmed,
      // with the full path visible (the user should see exactly what the
      // session can read).
      const verb =
        item.action === "added" ? t("grantAdded") : t("grantRevoked");
      return el(
        "div",
        { class: "lm-msg lm-msg-notice", title: item.grant.path },
        `📁 ${verb}: ${item.grant.label} (${item.grant.id}) — ${item.grant.path}`,
      );
    }
    case "interrupted":
      return el(
        "div",
        { class: "lm-msg lm-msg-notice" },
        `⏹ ${t("sessionInterrupted")}`,
      );
    case "edit_proposal":
      return editProposalCard(item);
    case "changed_files": {
      const total = item.files.reduce((n, f) => n + f.edits, 0);
      const card = el("div", { class: "lm-msg lm-msg-changed" });
      card.append(
        el(
          "div",
          { class: "lm-todo__title" },
          `✎ ${total} ${t("changedFiles")}`,
        ),
      );
      for (const f of item.files) {
        card.append(
          el(
            "div",
            { class: "lm-changed__row" },
            `${f.file} · ${f.edits}${f.created ? ` · ${t("changedNew")}` : ""}`,
          ),
        );
        // D2 deliverable 8: this summary is the ONLY report an auto_apply user
        // gets — a declared removal that is not named here reaches disk
        // unannounced.
        const removed = removalLine(f.removesProtected ?? [], locale);
        if (removed) card.append(removed);
      }
      return card;
    }
    case "script_run":
      return scriptRunCard(item);
    case "subtask":
      return subtaskCard(item);
    // ADR 0065 §2: a review is not part of this conversation, so it draws
    // nothing here. The card R3 (ADR 0061 §9) put in the transcript is now the
    // progress block at the top of the Review tab.
    //
    // Still an explicit arm, and it earns its place twice: the default arm
    // would announce a `review` item as a kind this bundle does not know, and
    // sessions recorded BEFORE this change still carry them on disk. Rendering
    // nothing is the honest answer for both — the review itself is in the
    // Review tab, which is where it now lives for good.
    case "review":
      return undefined;
    default:
      // An item kind this bundle does not know yet: say so rather than drop it.
      return el(
        "div",
        { class: "lm-msg lm-msg-notice" },
        `• ${t("unknownItem")}: ${(item as { type: string }).type}`,
      );
  }
}

function transcript(): HTMLElement {
  const wrap = el("div", { class: "lm-transcript" });
  for (const id of transcriptOrder) {
    const item = transcriptById.get(id);
    if (!item) continue;
    const node = renderItem(item);
    if (node) wrap.append(node);
  }
  // A1b manual-test finding 1: the task is "busy" for the whole approval
  // pause, but it is waiting on the USER, not thinking. Showing a spinner
  // under a card that is asking you a question is a lie about who is blocked.
  const items = transcriptOrder.flatMap((id) => {
    const item = transcriptById.get(id);
    return item ? [item] : [];
  });
  // A4b: a pending run_script is likewise a wait-on-user pause, not thinking.
  const awaitsScript = items.some(
    (i) => i.type === "script_run" && i.status === "pending",
  );
  // CHAT-3: and a turn that is already streaming its answer is not "thinking"
  // either — the text arriving IS the progress indicator.
  if (
    busyRowVisible({
      sessionBusy,
      awaitsEditDecision: awaitsEditDecision(items),
      awaitsScript,
      turnStreamed,
    })
  )
    // P1: the row now carries the brand's animated mark beside the same
    // localized label. `busyRowVisible` above is untouched — what changed is
    // what the row looks like, not when it appears.
    wrap.append(busyRow(t("sessionThinking")));
  // An empty transcript stays empty. P1b moved the branded welcome region up
  // to `content()`'s slot, above the quick actions; rendering it here as well
  // is what put two of them on screen at once.
  if (transcriptOrder.length === 0 && !sessionBusy) wrap.style.display = "none";
  return wrap;
}

// ---- Venue tab (U4) ----

function venueChip(text: string): HTMLElement {
  return el("span", { class: "lm-venue-chip" }, text);
}

function venueChecklistRow(row: VenueChecklistRowInfo): HTMLElement {
  const glyph = row.status === "pass" ? "✓" : row.status === "fail" ? "✗" : "—";
  const cls =
    row.status === "pass"
      ? "lm-check--pass"
      : row.status === "fail"
        ? "lm-check--fail"
        : "lm-check--unknown";
  const title =
    row.id === "anonymity"
      ? t("venueRowAnonymity")
      : row.id === "page_limit"
        ? t("venueRowPages")
        : row.id === "bibstyle"
          ? t("venueRowBibstyle")
          : t("venueRowCitations");
  let detail = "";
  if (row.id === "anonymity") {
    const req = (row.expected ?? "none").replace("_", "-");
    detail =
      row.status === "pass"
        ? `${req} · ${t("venueMatches")}`
        : row.status === "fail"
          ? `${t("venueRequired")}: ${req}`
          : `${t("venueRequired")}: ${req} · ${t("venueManualCheck")}`;
  } else if (row.id === "page_limit") {
    const limit = row.expected ?? "";
    detail =
      row.actual !== undefined
        ? `${row.actual} / ${limit}`
        : limit !== ""
          ? `${limit} · ${t("venueNotMeasured")}`
          : t("venueManualCheck");
  } else if (row.id === "bibstyle") {
    detail =
      row.status === "pass"
        ? `${row.actual ?? ""} · ${t("venueMatches")}`
        : row.status === "fail"
          ? `${row.actual ?? ""} · ${t("venueExpected")} ${row.expected ?? ""}`
          : `${t("venueExpected")} ${row.expected ?? "—"} · ${t("venueManualCheck")}`;
  } else {
    detail =
      row.status === "unknown"
        ? t("venueNoBib")
        : `${row.count ?? 0} ${t("venueUnresolved")}`;
  }
  const rowEl = el(
    "div",
    { class: `lm-check-row ${cls}` },
    el("span", { class: "lm-check-glyph", "aria-hidden": "true" }, glyph),
    el(
      "div",
      { class: "lm-check-body" },
      el("div", { class: "lm-check-title" }, title),
      el("div", { class: "lm-check-detail" }, detail),
    ),
  );
  if (row.id === "citations") {
    rowEl.classList.add("lm-check-row--link");
    rowEl.setAttribute("role", "button");
    rowEl.setAttribute("tabindex", "0");
    rowEl.addEventListener("click", () => selectTab(1));
    rowEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // Space must not also scroll (role="button")
        selectTab(1);
      }
    });
  }
  return rowEl;
}

function venuePanel(): HTMLElement {
  const root = el("div", {
    class: "lm-content",
    role: "tabpanel",
    id: "lm-tabpanel",
  });
  const s = venueState;

  root.append(el("div", { class: "lm-section-label" }, t("venueCurrent")));
  if (!s || !s.available) {
    root.append(el("div", { class: "lm-cite-empty" }, t("venueNone")));
  } else if (s.detectedClass === undefined) {
    root.append(el("div", { class: "lm-cite-empty" }, t("venueNoClass")));
  } else {
    const optionsText =
      s.detectedOptions.length > 0 ? `[${s.detectedOptions.join(",")}]` : "";
    const card = el(
      "div",
      { class: "lm-venue-card" },
      el(
        "div",
        { class: "lm-venue-card__head" },
        el("span", { class: "lm-diamond" }),
        el(
          "div",
          {},
          el(
            "div",
            { class: "lm-venue-card__title" },
            s.venue ? s.venue.label : s.detectedClass,
          ),
          el(
            "div",
            { class: "lm-venue-card__class" },
            `\\documentclass${optionsText}{${s.detectedClass}}`,
          ),
        ),
      ),
    );
    if (s.venue) {
      const chips = el("div", { class: "lm-venue-chips" });
      if (s.venue.pageLimit) {
        const note = s.venue.pageLimit.note
          ? ` (${s.venue.pageLimit.note})`
          : "";
        chips.append(
          venueChip(
            `${s.venue.pageLimit.value} ${s.venue.pageLimit.unit}${note}`,
          ),
        );
      }
      if (s.venue.anonymity)
        chips.append(venueChip(s.venue.anonymity.replace("_", "-")));
      if (s.venue.bibstyle) chips.append(venueChip(s.venue.bibstyle));
      chips.append(venueChip(s.venue.engine));
      card.append(
        chips,
        el("div", { class: "lm-venue-note" }, t("venueSeedNote")),
      );
    } else {
      card.append(el("div", { class: "lm-venue-note" }, t("venueNoMatch")));
    }
    root.append(card);
  }

  if (s?.venue && s.checklist.length > 0) {
    root.append(
      el("div", { class: "lm-section-label" }, t("venueChecklistTitle")),
    );
    for (const row of s.checklist) root.append(venueChecklistRow(row));
  }

  root.append(el("div", { class: "lm-section-label" }, t("venueNewTitle")));
  root.append(el("div", { class: "lm-venue-desc" }, t("venueNewDesc")));
  const newBtn = el(
    "button",
    { class: "lm-dashed-btn" },
    t("venueNewBtn"),
  ) as HTMLButtonElement;
  newBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newFromVenue" });
  });
  root.append(newBtn);

  root.append(
    el(
      "div",
      { class: "lm-section-label" },
      t("venueMigrateTitle"),
      " ",
      // The revised roadmap moves venue migration out of v0.4 to "Later".
      el("span", { class: "lm-tag" }, t("later")),
    ),
  );
  root.append(el("div", { class: "lm-venue-desc" }, t("venueMigrateDesc")));
  const migrateBtn = el(
    "button",
    { class: "lm-dashed-btn", title: t("venueMigrateTip") },
    t("venueMigrateBtn"),
  ) as HTMLButtonElement;
  migrateBtn.disabled = true;
  root.append(migrateBtn);

  return root;
}

// ---- Models tab (U3) ----

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** A summary line for a persisted cost bucket (today / all-time). */
function costSummaryLine(label: string, b: CostSummaryInfo): HTMLElement {
  const usd = b.usd > 0 ? ` · $${b.usd.toFixed(3)}` : "";
  const unpriced =
    b.unpricedRuns > 0 ? ` (+${b.unpricedRuns} ${t("mUnpriced")})` : "";
  return el(
    "div",
    { class: "lm-usage__summary" },
    `${label} · ${fmtTok(b.inputTokens)} ${t("mIn").toLowerCase()} / ${fmtTok(b.outputTokens)} ${t("mOut").toLowerCase()}${usd}${unpriced}`,
  );
}

function roleCard(opts: {
  dot: string; // "accent" | "green" | "amber" | "red"
  title: string;
  desc: string;
  body?: HTMLElement;
  /** The roadmap version that promises this role, when it is still a shell. */
  shell?: "v03" | "later";
}): HTMLElement {
  const card = el("div", { class: "lm-mcard" });
  const head = el(
    "div",
    { class: "lm-mcard__head" },
    el("span", { class: `lm-mcard__dot lm-mcard__dot--${opts.dot}` }),
    el("span", { class: "lm-mcard__title" }, opts.title),
  );
  if (opts.shell) {
    head.append(
      el(
        "span",
        { class: "lm-tag" },
        opts.shell === "v03" ? t("v03") : t("later"),
      ),
    );
  }
  card.append(head, el("div", { class: "lm-mcard__desc" }, opts.desc));
  if (opts.body) card.append(opts.body);
  if (opts.shell) card.classList.add("lm-mcard--shell");
  return card;
}

function modelRow(m: ConfiguredModelInfo): HTMLElement {
  const statusColor = m.keyPresent ? "is-ok" : "is-warning";
  const statusText = m.keyPresent ? t("mKeyOk") : t("mNoKey");
  const modelsLine = el("div", { class: "lm-mrow__models" }, m.model);
  if (m.endpoint) {
    modelsLine.append(
      el(
        "span",
        { class: "lm-cite-mono lm-mrow__endpoint" },
        ` · ${m.endpoint}`,
      ),
    );
  }
  const name = el("div", { class: "lm-mrow__name" }, m.providerLabel);
  if (m.active) {
    name.append(el("span", { class: "lm-tag lm-tag--active" }, t("mActive")));
  }
  const status = el(
    "span",
    { class: `lm-mrow__status ${statusColor}` },
    el("span", { class: "lm-mrow__statusdot", "aria-hidden": "true" }),
    statusText,
  );
  const remove = el(
    "button",
    {
      class: "lm-mrow__remove",
      title: t("mRemove"),
      "aria-label": t("mRemove"),
    },
    "✕",
  ) as HTMLButtonElement;
  remove.addEventListener("click", () =>
    vscode.postMessage({ type: "removeModel", id: m.id }),
  );
  const row = el(
    "div",
    { class: "lm-mrow" },
    el("div", { class: "lm-mrow__body" }, name, modelsLine),
    status,
    remove,
  );
  // A key-less model gets an inline Set-key affordance.
  if (!m.keyPresent) {
    const keyInput = el("input", {
      class: "lm-mform__input",
      type: "password",
      placeholder: t("mApiKey"),
      "aria-label": t("mApiKey"),
    }) as HTMLInputElement;
    const setBtn = el(
      "button",
      { class: "lm-mform__save" },
      t("mSetKey"),
    ) as HTMLButtonElement;
    setBtn.addEventListener("click", () => {
      if (keyInput.value !== "") {
        vscode.postMessage({
          type: "updateModelKey",
          id: m.id,
          apiKey: keyInput.value,
        });
        keyInput.value = "";
      }
    });
    row.append(el("div", { class: "lm-mrow__setkey" }, keyInput, setBtn));
  }
  // V3 (ADR 0080 §6): whether this model can be SHOWN a rendered page. After
  // the key controls, because the key is what decides whether the row works
  // at all and this decides only what it may be given.
  row.append(imageInputControl(locale, m, (msg) => vscode.postMessage(msg)));
  return row;
}

function labeledField(label: string, control: HTMLElement): HTMLElement {
  return el(
    "label",
    { class: "lm-mform__field" },
    el("span", { class: "lm-mform__label" }, label),
    control,
  );
}

function addModelForm(onDone: () => void): HTMLElement {
  const providers = modelsState?.providers ?? [];
  const form = el("div", { class: "lm-mform" });

  const providerSel = el("select", {
    class: "lm-mform__input",
    "aria-label": t("mProvider"),
  }) as HTMLSelectElement;
  for (const p of providers) {
    providerSel.append(el("option", { value: p.id }, p.label));
  }

  const modelSel = el("select", {
    class: "lm-mform__input",
    "aria-label": t("mModel"),
  }) as HTMLSelectElement;
  const customModel = el("input", {
    class: "lm-mform__input lm-hidden",
    placeholder: t("mCustomModelPh"),
    "aria-label": t("mModel"),
  }) as HTMLInputElement;
  const endpoint = el("input", {
    class: "lm-mform__input",
    placeholder: t("mEndpoint"),
    "aria-label": t("mEndpoint"),
  }) as HTMLInputElement;
  const apiKey = el("input", {
    class: "lm-mform__input",
    type: "password",
    placeholder: t("mApiKey"),
    "aria-label": t("mApiKey"),
  }) as HTMLInputElement;

  const syncProvider = (): void => {
    const p = providers.find((x) => x.id === providerSel.value);
    modelSel.replaceChildren();
    for (const id of p?.suggestedModels ?? []) {
      modelSel.append(el("option", { value: id }, id));
    }
    modelSel.append(el("option", { value: "__custom__" }, t("mCustomModel")));
    modelSel.value = p?.suggestedModels[0] ?? "__custom__";
    customModel.classList.toggle("lm-hidden", modelSel.value !== "__custom__");
    endpoint.value = p?.defaultEndpoint ?? "";
  };
  providerSel.addEventListener("change", syncProvider);
  modelSel.addEventListener("change", () => {
    customModel.classList.toggle("lm-hidden", modelSel.value !== "__custom__");
  });
  syncProvider();

  const save = el(
    "button",
    { class: "lm-mform__save" },
    t("mSave"),
  ) as HTMLButtonElement;
  save.addEventListener("click", () => {
    const model =
      modelSel.value === "__custom__"
        ? customModel.value.trim()
        : modelSel.value;
    if (model === "") {
      apiKey.value = "";
      return;
    }
    vscode.postMessage({
      type: "addModel",
      provider: providerSel.value,
      model,
      endpoint: endpoint.value.trim(),
      apiKey: apiKey.value,
    });
    apiKey.value = "";
    customModel.value = "";
    onDone();
  });
  const cancel = el(
    "button",
    { class: "lm-mform__cancel" },
    t("mCancel"),
  ) as HTMLButtonElement;
  cancel.addEventListener("click", () => {
    apiKey.value = "";
    onDone();
  });

  form.append(
    labeledField(t("mProvider"), providerSel),
    labeledField(t("mModel"), modelSel),
    customModel,
    labeledField(t("mEndpoint"), endpoint),
    labeledField(t("mApiKey"), apiKey),
    el("div", { class: "lm-mform__actions" }, cancel, save),
  );
  return form;
}

function modelsPanel(): HTMLElement {
  const panel = el("div", {
    class: "lm-content",
    role: "tabpanel",
    id: "lm-tabpanel",
  });
  const s = modelsState;
  const models = s?.models ?? [];

  // ---- ROLES ----
  panel.append(
    el("div", { class: "lm-section-label" }, t("mRoles")),
    el("div", { class: "lm-msub" }, t("mRolesIntro")),
  );
  // Writing role: a <select> over configured models -> setActiveModel.
  const writingSelect = el("select", {
    class: "lm-mcard__modelselect",
    "aria-label": t("mPickModel"),
  }) as HTMLSelectElement;
  if (models.length === 0) {
    const opt = el(
      "option",
      { value: "" },
      t("notConfigured"),
    ) as HTMLOptionElement;
    opt.disabled = true;
    opt.selected = true;
    writingSelect.append(opt);
    writingSelect.disabled = true;
  } else {
    // No active model yet (fresh/ corrupted state): a disabled placeholder so
    // the <select> doesn't imply the first model is active when none is.
    if (!models.some((m) => m.active)) {
      const ph = el(
        "option",
        { value: "" },
        t("mPickModel"),
      ) as HTMLOptionElement;
      ph.disabled = true;
      ph.selected = true;
      writingSelect.append(ph);
    }
    for (const m of models) {
      const opt = el(
        "option",
        { value: m.id },
        `${m.label} · ${m.providerLabel}`,
      ) as HTMLOptionElement;
      if (m.active) opt.selected = true;
      writingSelect.append(opt);
    }
  }
  writingSelect.addEventListener("change", () => {
    if (writingSelect.value !== "") {
      vscode.postMessage({ type: "setActiveModel", id: writingSelect.value });
    }
  });
  // R9 (ADR 0069 §D8): the two `shell: "v03"` cards U3 drew dimmed are real
  // controls now. Their bodies come from a pure `parts/` module so a control
  // that decides how many models a review spends on is asserted offline
  // rather than sent to a human; `roleCard` stays the one home of the chrome.
  //
  // `undefined` until the first `modelsState` lands, and the two cards then
  // draw NO body. A card built from a guessed default would show three rows
  // the user may not have — and its ✕ buttons are live, so one click inside
  // that window would post the guess over five configured reviewers and the
  // host would persist it. There is nothing to edit before the host has
  // spoken, so nothing is offered.
  const rolesView: ReviewRolesView | undefined = s
    ? { models, roles: s.reviewRoles, maxReviewers: s.maxReviewers }
    : undefined;
  const postRoles = (roles: {
    reviewers: string[];
    synthesis: string;
    verifier: string;
    pdfReviewer?: string;
  }): void =>
    vscode.postMessage({
      type: "setReviewRoles",
      ...roles,
      // V4: the view is built from `s.reviewRoles`, so the field is always
      // there; the fallback only satisfies the wire's four-field shape.
      pdfReviewer: roles.pdfReviewer ?? s?.reviewRoles.pdfReviewer ?? "",
    });
  panel.append(
    roleCard({
      dot: "accent",
      title: t("mWriting"),
      desc: t("mWritingDesc"),
      body: writingSelect,
    }),
    roleCard({
      dot: "green",
      title: t("mReviewers"),
      desc: t("mReviewersDesc"),
      ...(rolesView
        ? { body: reviewersCardBody(rolesView, locale, postRoles) }
        : {}),
    }),
    roleCard({
      dot: "amber",
      title: t("mCrossReview"),
      desc: t("mCrossReviewDesc"),
      ...(rolesView
        ? { body: crossReviewCardBody(rolesView, locale, postRoles) }
        : {}),
    }),
    // V4 (ADR 0081 §8): the fourth role — who reads the compiled PDF. Its
    // blind notice reads each model's `imageInput` / `imageInputDefault` and
    // the Writing row's `active`, all on `ConfiguredModelInfo` already.
    roleCard({
      dot: "red",
      title: t("mPdfReview"),
      desc: t("mPdfReviewDesc"),
      ...(rolesView
        ? { body: pdfReviewCardBody(rolesView, locale, postRoles) }
        : {}),
    }),
  );
  const addRole = el(
    "button",
    { class: "lm-dashed-btn", title: t("shellTipLater") },
    `＋ ${t("mAddRole")}`,
  ) as HTMLButtonElement;
  // User-defined model roles are on no published roadmap version.
  addRole.disabled = true;
  addRole.append(el("span", { class: "lm-tag" }, t("later")));
  panel.append(addRole);

  // ---- CONNECTED MODELS ----
  panel.append(
    el("div", { class: "lm-section-label lm-msection" }, t("mConnected")),
    el("div", { class: "lm-msub" }, t("mConnectedIntro")),
  );
  if (models.length === 0) {
    panel.append(el("div", { class: "lm-usage__empty" }, t("mNoModels")));
  }
  for (const m of models) {
    panel.append(modelRow(m));
  }
  // Add-model form (hidden until toggled).
  const addBtn = el(
    "button",
    { class: "lm-dashed-btn" },
    `＋ ${t("mAddModel")}`,
  ) as HTMLButtonElement;
  const form = addModelForm(() => {
    form.classList.add("lm-hidden");
    addBtn.classList.remove("lm-hidden");
  });
  form.classList.add("lm-hidden");
  addBtn.addEventListener("click", () => {
    addBtn.classList.add("lm-hidden");
    form.classList.remove("lm-hidden");
  });
  panel.append(addBtn, form);

  // ---- USAGE ----
  panel.append(
    el("div", { class: "lm-section-label lm-msection" }, t("mUsage")),
  );
  const table = el("div", { class: "lm-usage" });
  table.append(
    el(
      "div",
      { class: "lm-usage__head" },
      el("span", { class: "lm-usage__model" }, t("mModelCol")),
      el("span", { class: "lm-usage__num" }, t("mIn")),
      el("span", { class: "lm-usage__num" }, t("mOut")),
    ),
  );
  const rows = s?.session ?? [];
  const DOTS = ["accent", "green", "amber"] as const;
  if (rows.length === 0) {
    table.append(el("div", { class: "lm-usage__empty" }, t("mNoRuns")));
  }
  rows.forEach((r, i) => {
    table.append(
      el(
        "div",
        { class: "lm-usage__row" },
        el(
          "span",
          { class: "lm-usage__model" },
          el("span", {
            class: `lm-mcard__dot lm-mcard__dot--${DOTS[i % DOTS.length]}`,
          }),
          el("span", { class: "lm-usage__name" }, r.model),
        ),
        el(
          "span",
          { class: "lm-usage__num lm-cite-mono" },
          fmtTok(r.inputTokens),
        ),
        el(
          "span",
          { class: "lm-usage__num lm-cite-mono" },
          fmtTok(r.outputTokens),
        ),
      ),
    );
  });
  if (rows.length > 0) {
    const inSum = rows.reduce((a, r) => a + r.inputTokens, 0);
    const outSum = rows.reduce((a, r) => a + r.outputTokens, 0);
    table.append(
      el(
        "div",
        { class: "lm-usage__row lm-usage__total" },
        el("span", { class: "lm-usage__model" }, t("mTotalRow")),
        el("span", { class: "lm-usage__num lm-cite-mono" }, fmtTok(inSum)),
        el("span", { class: "lm-usage__num lm-cite-mono" }, fmtTok(outSum)),
      ),
    );
  }
  panel.append(table);
  if (s) {
    panel.append(
      costSummaryLine(`${t("mToday")} (${s.today.date})`, s.today),
      costSummaryLine(t("mTotal"), s.total),
    );
  }

  // ---- footer ----
  panel.append(
    el(
      "div",
      { class: "lm-cite-footer" },
      el("span", { class: "lm-cite-lock" }, "🔒"),
      el("span", {}, t("mKeysNote")),
    ),
  );
  return panel;
}

function contextTray(): HTMLElement {
  chipEl = el("span", { class: "lm-chip lm-chip--live" });
  const pin = el(
    "button",
    { class: "lm-chip__pin", title: t("pinTip"), "aria-label": t("pin") },
    `📌 ${t("pin")}`,
  ) as HTMLButtonElement;
  pin.disabled = true; // pinning across selections is not built
  chipEl.append(el("span", { class: "lm-chip__label" }, ""), pin);
  return el(
    "div",
    { class: "lm-context" },
    el("span", { class: "lm-context__label" }, t("context")),
    chipEl,
  );
}

/**
 * E2 (ADR 0049): every candidate the `/` menu can offer, in group order.
 *
 * The verbs are Lemmaria's own chrome and are localized; a skill's description
 * is its author's text and is not (invariant 6's stated boundary, ADR 0045).
 */
function composerCandidates(rule: SigilRule, token: ActiveToken): Candidate[] {
  // E3 (D7): sourced BY SIGIL. The design's *Alternatives rejected* refused one
  // merged list — the two sigils reach different things, and merging them would
  // mean either widening `/` or narrowing `@`. Shared module, separate sources.
  // By the sigil, not by reference: a caller that built an equal rule value
  // would otherwise silently get `/`'s candidates (E3 code review).
  if (rule.sigil === SIGIL_AT.sigil) return pathCandidates(contextPaths);
  // E6 (D10): the `/fork` row is offered only where the command could run, so
  // it takes the TOKEN. That is why this function has one at all — the two
  // other sources are position-independent.
  return [
    ...commandCandidates(locale),
    ...forkCandidates(locale, token),
    // R3 (ADR 0061 §2): the second harness-parsed verb, offered under the same
    // rule as the first — only where its anchored parser could actually run.
    ...reviewCandidates(locale, token),
    // V4 (ADR 0081 §8): the third, beside it and under the same rule.
    ...reviewPdfCandidates(locale, token),
    ...skillCandidates(skillCatalogue),
  ];
}

/**
 * Recomputes the menu from the composer's text and caret.
 *
 * Called on `input` and nowhere else. The token it produces is then HELD in
 * `composerMenu` — see that declaration for why re-deriving it on every render
 * would be wrong.
 */
function refreshComposerMenu(): void {
  const input = composerInput;
  if (!input) {
    composerMenu = undefined;
    return;
  }
  const caret = input.selectionStart ?? input.value.length;
  const wasAt = composerMenu?.rule === SIGIL_AT;
  // E3 (D7): both sigils, and there is NO precedence question to settle —
  // `activeToken` takes the whitespace-delimited word the caret is in and asks
  // whether THAT word begins with the sigil, and a word cannot begin with two
  // different characters. At most one of these can answer, whatever the order.
  for (const rule of [SIGIL_SLASH, SIGIL_AT]) {
    const token = activeToken(input.value, caret, rule);
    if (!token) continue;
    const candidates = composerCandidates(rule, token);
    composerMenu = menuState(
      token,
      rule,
      menuRows(candidates, token.query),
      rule.sigil === SIGIL_AT.sigil
        ? contextNote(contextPaths, locale)
        : undefined,
    );
    // The transition into an `@` menu, and only that, asks the host to re-walk
    // (D6). The menu opens NOW from what is already here; the fresh set
    // re-ranks it a beat later, on the machinery `skillsCatalogue` established.
    if (rule.sigil === SIGIL_AT.sigil && !wasAt) {
      vscode.postMessage({ type: "requestContextPaths" });
    }
    return;
  }
  composerMenu = undefined;
}

/**
 * Re-rank an OPEN menu against a candidate source that has just changed.
 *
 * The token is NOT re-derived (E2's D4): a push is not a user action, so what
 * the menu is completing must not move. Only the rows do — a skill that has
 * since been disabled, or a path under a grant that has since been revoked,
 * must stop being offered while the menu is on screen.
 */
function reRankOpenMenu(): void {
  const open = composerMenu;
  if (!open) return;
  const candidates = composerCandidates(open.rule, open.token);
  // `reRank`, not `menuState`: the rows change, the HIGHLIGHT does not. A push
  // arriving while the user is arrowing must not hand them row 0 on Enter.
  composerMenu = reRank(
    open,
    menuRows(candidates, open.token.query),
    open.rule.sigil === SIGIL_AT.sigil
      ? contextNote(contextPaths, locale)
      : undefined,
  );
}

/**
 * Takes the row at `index` — the two kinds, and nothing else (design §3).
 *
 * `insert` splices the token and lets the user go on typing their actual
 * request, so the tested harness path then runs completely unchanged.
 * `command` posts exactly the message the candidate names — the same one its
 * command-palette twin posts — and clears the composer.
 */
function acceptCompletion(index: number): void {
  const menu = composerMenu;
  const input = composerInput;
  if (!menu || !input) return;
  const candidate = menu.rows[index]?.candidate;
  composerMenu = undefined;
  if (!candidate) return;

  if (candidate.kind === "command") {
    // Only the TOKEN goes. Design §3 says "clear the composer", written when it
    // was assumed to hold nothing else — see `removeToken` for why a draft
    // behind the verb is not ours to throw away.
    //
    // E3 (D4): `Candidate` is a union, so a command row HAS a message by type.
    // The `if (!verb) return` this branch used to open with is gone: it guarded
    // a state the old optional field made expressible and nothing ever
    // produced.
    splice(input, menu.token, removeToken(input.value, menu.token));
    vscode.postMessage({ type: candidate.command });
    return;
  }

  // E3 (D4): the insertion is CARRIED, not derived from the label. A skill row
  // writes its own `/skill:<name>`; an `@` row writes a path with no sigil.
  splice(
    input,
    menu.token,
    applyCompletion(input.value, menu.token, candidate.insertion),
  );
}

/**
 * Write a {@link Completed} into the composer as an **undoable** edit.
 *
 * Selecting the token and running `insertText` over it is the only splice
 * Chromium records on the undo stack — the same argument the Alt+Enter branch
 * below already makes, and it applies with more force here, because a
 * completion writes far more than a newline. Assigning `.value` would leave
 * Ctrl+Z with nothing to undo but the whole draft.
 *
 * The `.value` assignment is kept as the fallback for a host where
 * `execCommand` is absent or refuses; the caret is written afterwards either
 * way, because the reused-space case (`written` ends before a space the user
 * already typed) puts it one past where the insertion itself lands.
 */
function splice(
  input: HTMLTextAreaElement,
  token: ActiveToken,
  done: Completed,
): void {
  input.focus();
  input.setSelectionRange(token.start, token.end);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, done.written);
  } catch {
    ok = false;
  }
  if (!ok || input.value !== done.text) input.value = done.text;
  input.setSelectionRange(done.caret, done.caret);
}

/**
 * Type a sigil in at the caret, as the ＋ button's click (E3, D8).
 *
 * **A separating space is added when the caret is mid-word**, because
 * `activeToken` asks whether the whitespace-delimited word the caret is in
 * begins with the sigil — so an `@` appended to `abc` yields the word `abc@`
 * and no menu at all. That is the same rule that makes `a@b` an email address
 * rather than a reference, applied from the other side.
 *
 * Written as an UNDOABLE edit for the reason every other splice here is
 * (ADR 0049 decision 3): `insertText` is the only insertion Chromium records on
 * the undo stack, and a button that put text in the composer which Ctrl+Z could
 * not take out again would be a small trap.
 */
function insertSigilAtCaret(rule: SigilRule): void {
  const input = composerInput;
  if (!input) return;
  input.focus();
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const written =
    before.length > 0 && !/\s$/.test(before) ? ` ${rule.sigil}` : rule.sigil;
  input.setSelectionRange(caret, caret);
  const text = before + written + input.value.slice(caret);
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, written);
  } catch {
    ok = false;
  }
  // `splice`'s exact pair, verification included: `execCommand` can report
  // success and leave the value alone (a host that swallows it, a readonly
  // moment), so the result is CHECKED rather than trusted. Assigning `.value`
  // is what costs the undo entry, which is why it is the fallback and not the
  // route.
  if (!ok || input.value !== text) input.value = text;
  const at = caret + written.length;
  input.setSelectionRange(at, at);
  // The `input` listener does not fire for a programmatic write, so the menu is
  // refreshed here — through the SAME pair every other menu effect goes
  // through, so the button cannot drift from the keystroke.
  refreshComposerMenu();
  syncComposerMenu();
}

function composer(): HTMLElement {
  composerInput = el("textarea", {
    class: "lm-input",
    rows: "2",
    placeholder: t("placeholder"),
    "aria-label": t("placeholder"),
  }) as HTMLTextAreaElement;
  // E2: the menu never takes DOM focus — the composer keeps it, which is what
  // lets an input method go on owning the keyboard (design §6). So the active
  // row is NAMED here instead, which is the pattern that combination exists
  // for.
  //
  // `aria-activedescendant` alone is inert: the id it names has to be OWNED by
  // the element carrying it, and a `<textarea>` can own nothing by containment
  // — the menu is its sibling. `aria-owns` supplies the ownership, and
  // `aria-expanded` is what tells a screen reader a list is open at all. A
  // textarea's implicit `textbox` role supports all three, so no explicit role
  // is set: `role="combobox"` on a `<textarea>` is not a mapping ARIA-in-HTML
  // permits, and reaching for it would trade a real defect for a spec one.
  // The three attributes are written by `syncMenuAria`, called from
  // `syncComposerMenu` — they have to change when the menu changes, and the
  // menu now changes without a render.

  const addCtx = el(
    "button",
    {
      class: "lm-addctx",
      title: t("addContext"),
      "aria-label": t("addContext"),
    },
    "＋",
  ) as HTMLButtonElement;
  // E3 (D8): the button TYPES an `@`; it does not open a menu of its own.
  //
  // One code path, not two. A button that built a menu directly would be a
  // second way to open the same surface, with its own token to keep in step
  // with the composer's text — and the token is the one piece of state E2's D4
  // says must come from the typing. Making the button do the typing means the
  // empty-query `@` menu design §2 promises is the ordinary case, reached the
  // ordinary way. Disabled since U1, and this is what it was reserved for.
  addCtx.addEventListener("click", () => insertSigilAtCaret(SIGIL_AT));

  modelPill = el(
    "button",
    { class: "lm-pill", disabled: "true", "aria-label": t("model") },
    el("span", { class: "lm-pill__dot" }),
    el("span", { class: "lm-pill__text" }, modelLabel || t("notConfigured")),
  );
  // A5: was disabled since U1. Model management lives in the Models tab (U3),
  // so the pill becomes the way there instead of a dead label.
  (modelPill as HTMLButtonElement).addEventListener("click", () =>
    selectTab(2),
  );

  // A2 (ADR 0021): the ring shows MEASURED occupancy (the last turn's reported
  // tokens over the model's window). Before the first turn — and right after a
  // compaction — occupancy is genuinely unknown and it shows "—".
  const ringPct = ringState(contextUsage);
  const pct = ringPct.pct;
  const budgetPart = budgetInfo
    ? `${t("budget")}: ${budgetInfo.maxTokens} tok · ${budgetInfo.maxIterations} iter — `
    : "";
  const ringTitle =
    pct === undefined
      ? `${budgetPart}${t("ringUnknown")}`
      : `${budgetPart}${t("ringUsed")}: ${pct}% (${contextUsage?.occupied} / ${contextUsage?.window} tok)`;
  // No longer aria-hidden (review): the ring now carries a live measurement,
  // so the number must be announced, not just shown.
  const ring = contextRing(ringPct, ringTitle);
  // A1b (ADR 0016): the permission-mode selector — click toggles between
  // review ("Ask before edit") and auto_apply ("Auto"); the dot color and
  // label reflect the live policy, kept in sync with the host.
  const isAuto = editPolicyState === "auto_apply";
  const perm = el(
    "button",
    {
      class: "lm-pill",
      title: isAuto ? t("permAutoDesc") : t("permReviewDesc"),
      "aria-label": isAuto ? t("permAuto") : t("permReview"),
    },
    el("span", {
      class: `lm-pill__dot lm-pill__dot--${isAuto ? "auto" : "review"}`,
    }),
    el(
      "span",
      { class: "lm-pill__text" },
      isAuto ? t("permAuto") : t("permReview"),
    ),
  ) as HTMLButtonElement;
  perm.addEventListener("click", () => {
    const next = editPolicyState === "auto_apply" ? "review" : "auto_apply";
    editPolicyState = next;
    vscode.postMessage({ type: "setEditPolicy", policy: next });
    scheduleRender();
  });

  // A1a (ADR 0015): while a task runs the button becomes Stop (interrupt);
  // typing + ⌘↵ still sends — the host queues it as steering.
  sendBtn = el("button", {
    class: "lm-send",
    title: sessionBusy ? t("stop") : t("send"),
    "aria-label": sessionBusy ? t("stop") : t("send"),
  }) as HTMLButtonElement;
  sendBtn.textContent = sessionBusy ? "◼" : "↑";
  // A5: say what the next send will DO — start a task, or steer the running one.
  composerInput.placeholder = sessionBusy
    ? t("steerPlaceholder")
    : t("placeholder");
  const submit = () => {
    const text = composerInput?.value ?? "";
    if (text.trim() === "") return;
    // E2: whatever was open is about to be answering a draft that no longer
    // exists. The keydown path clears it too; this covers the send BUTTON,
    // which reaches `submit` without passing through a key at all.
    composerMenu = undefined;
    // E6 (D10): `/fork [name]` is read BEFORE anything is posted, and that
    // order is the whole point. A send while a task runs is queued as steering
    // text, so a `/fork` parsed after the post would already have gone to the
    // model as prose. The host owns the busy refusal — one home for that rule
    // — and it never sees this as a message.
    const fork = parseForkCommand(text);
    if (fork !== null) {
      vscode.postMessage({ type: "forkSession", ...fork });
      if (composerInput) composerInput.value = "";
      return;
    }
    vscode.postMessage({ type: "composerSend", text });
    if (composerInput) composerInput.value = "";
    // A5: sending while busy STEERS the running task — show that it is queued
    // rather than leaving the user wondering whether it registered at all.
    if (sessionBusy) {
      queuedSteering.push(text.trim());
      scheduleRender();
    }
  };
  sendBtn.addEventListener("click", () => {
    if (sessionBusy) vscode.postMessage({ type: "interruptTask" });
    else submit();
  });
  // CHAT-1: Enter sends, Shift+Enter and Alt+Enter insert a newline, Ctrl/Cmd+
  // Enter stays a send alias — and an IME composition never sends. Both rules
  // live in `parts/keys.ts` so every case is asserted offline (ADR 0037).
  //
  // Shift+Enter is absent below on purpose: the textarea's own default inserts
  // it, and natively is the only way that keeps the undo stack. Alt+Enter has
  // no default insertion, which is why it needs a branch of its own — it did
  // nothing at all until the operator's D2 round found it.
  // E2 (ADR 0049): the menu is re-derived from the text on every edit, and ONLY
  // on an edit. Navigation keys move the highlight without recomputing, so a
  // rebuild between two keystrokes cannot re-point the menu (D4).
  //
  // **Two guards, and both are load-bearing.** `render()` rebuilds `.lm-app`'s
  // children wholesale, and the composer is one of them (`parts/frame.ts`
  // preserves `.lm-content`'s node, not its siblings) — so a render here is a
  // render that DESTROYS THE TEXTAREA THE USER IS TYPING IN. Before E2 that
  // could happen only while a response streamed; an unconditional render on
  // `input` would make it happen once per keystroke, for everyone, forever.
  //
  // 1. **A composition never renders.** Chromium fires `input` for each
  //    composition update, so without this a Pinyin user rebuilds the focused
  //    element mid-composition — which ends the composition and writes the
  //    half-formed candidate back as committed text. That is invariant 6's
  //    reader, in the composer, with no `/` anywhere near it: the same failure
  //    `menuKeyAction` leads with its own guard to avoid.
  // 2. **No menu, no render.** If the menu was closed and stays closed there is
  //    nothing on screen to update, so typing costs exactly what it cost before
  //    E2 — no rebuild, and an intact per-element undo stack.
  composerInput.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    refreshComposerMenu();
    // Unconditional and cheap: `mountMenu` removes nothing when there is
    // nothing mounted, so the closed-menu case costs one `children` scan and,
    // crucially, no rebuild of the element being typed into.
    syncComposerMenu();
  });
  composerInput.addEventListener("keydown", (e) => {
    // E2 (design §6): the menu gets first refusal, and ONLY while it is open
    // with something to act on. Outside that narrow window the composer
    // behaves exactly as CHAT-1 and D2 settled it — including during an IME
    // composition, which `menuKeyAction` declines before any other test.
    const action = composerMenu ? menuKeyAction(e) : undefined;
    if (action && composerMenu && menuHandles(composerMenu, action)) {
      e.preventDefault();
      if (action === "dismiss") {
        // Esc closes the menu and LEAVES THE DRAFT. Clearing it is the one Esc
        // behaviour a user might expect and would be a data loss.
        composerMenu = undefined;
      } else if (action === "up" || action === "down") {
        composerMenu = moveHighlight(composerMenu, action === "up" ? -1 : 1);
      } else {
        acceptCompletion(composerMenu.index);
        // Accepting closes the menu. Held here rather than inside
        // `acceptCompletion` so that every path which clears it is visible in
        // this handler.
        composerMenu = undefined;
      }
      syncComposerMenu();
      return;
    }
    if (shouldSubmit(e)) {
      e.preventDefault();
      composerMenu = undefined;
      submit();
    } else if (needsExplicitNewline(e)) {
      e.preventDefault();
      // `execCommand` over splicing `.value`: it is the only insertion the
      // browser records as an undoable edit, so Ctrl+Z after Alt+Enter behaves
      // like Ctrl+Z after any other typing. Deprecated but universally
      // implemented, and the webview is Chromium.
      document.execCommand("insertText", false, "\n");
    }
  });

  const root = el(
    "div",
    { class: "lm-composer" },
    contextTray(),
    grantsRow(),
    steeringRow(),
    // E2: the menu rises out of the composer and over the transcript, so it is
    // a child of `.lm-composer` — which the stylesheet makes the positioning
    // ancestor — rather than of the input box, whose padding would inset it.
    // It is mounted by `syncComposerMenu` rather than built here, so that ONE
    // function owns the menu's node on every path — the render that rebuilds
    // this composer and the four interactions that must not.
    el("div", { class: "lm-composer__box" }, composerInput),
    el(
      "div",
      { class: "lm-composer__row" },
      addCtx,
      modelPill,
      el("span", { class: "lm-composer__spacer" }),
      costReadout(),
      ring,
      perm,
      sendBtn,
    ),
  );
  composerRoot = root;
  // A render REBUILDS this node, so the menu has to be put back into the new
  // one — the open menu is state, not a frame's decoration.
  syncComposerMenu();
  return root;
}

/**
 * A4 (ADR 0019): the granted-folder chips — one per grant (× revokes), plus
 * the dashed ＋ chip that opens the host's explicit folder picker. The chips
 * are the composer-side mirror of the transcript's grant_update record.
 */
function grantsRow(): HTMLElement {
  const row = el("div", { class: "lm-grants" });
  for (const grant of sessionGrants) {
    const chip = el(
      "span",
      { class: "lm-grant", title: `${grant.path} · ${t("grantAddTip")}` },
      `📁 ${grant.label}`,
    );
    const remove = el(
      "button",
      {
        class: "lm-grant__x",
        title: t("grantRevoke"),
        "aria-label": `${t("grantRevoke")}: ${grant.label}`,
      },
      "×",
    );
    const id = grant.id;
    remove.addEventListener("click", () =>
      vscode.postMessage({ type: "revokeGrant", id }),
    );
    chip.append(remove);
    row.append(chip);
  }
  const add = el(
    "button",
    { class: "lm-grant lm-grant--add", title: t("grantAddTip") },
    t("grantAdd"),
  );
  add.addEventListener("click", () => vscode.postMessage({ type: "addGrant" }));
  row.append(add);
  return row;
}

function applySelection(): void {
  if (activeTab !== 0) return; // Assistant-only DOM
  const enabled =
    selectionState.docKind !== null && selectionState.hasSelection;
  for (const btn of mvpTiles.values()) btn.disabled = !enabled;
  // A0: the composer is a session entry point (chat) — Send no longer needs a
  // selection; submit() still ignores blank text. Tiles keep their gating.
  if (heroEl) heroEl.style.display = enabled ? "none" : "";
  if (chipEl) {
    const label = chipEl.querySelector(".lm-chip__label");
    if (enabled) {
      const range =
        selectionState.startLine === selectionState.endLine
          ? `L${selectionState.startLine}`
          : `L${selectionState.startLine} – ${selectionState.endLine}`;
      if (label)
        label.textContent = `${t("selection")} · ${selectionState.file} ${range}`;
      chipEl.style.display = "";
    } else {
      chipEl.style.display = "none";
    }
  }
}

// ---- Citations tab ----
function requestCitations(): void {
  vscode.postMessage({ type: "requestCitations" });
}

const C1_GLYPH: Record<string, string> = {
  "undefined-citation": "⚠",
  "duplicate-key": "⊘",
  "duplicate-entry": "⊘",
  "orphan-citation": "○",
};
const C1_TITLE: Record<string, StringKey> = {
  "undefined-citation": "cUndefined",
  "duplicate-key": "cDupKey",
  "duplicate-entry": "cDupEntry",
  "orphan-citation": "cOrphan",
};
const C2_GLYPH: Record<string, string> = {
  ok: "✓",
  metadata_mismatch: "⚠",
  preprint_superseded: "⚠",
  not_found: "✗",
  unverified: "○",
};
const C2_TITLE: Record<string, StringKey> = {
  ok: "cVerified",
  metadata_mismatch: "cMismatch",
  preprint_superseded: "cSuperseded",
  not_found: "cNotFound",
  unverified: "cUnverified",
};
const C2_COLOR: Record<string, string> = {
  ok: "is-ok",
  metadata_mismatch: "is-warning",
  preprint_superseded: "is-warning",
  not_found: "is-error",
  unverified: "is-faint",
};

function severityColor(sev: string): string {
  return sev === "error"
    ? "is-error"
    : sev === "warning"
      ? "is-warning"
      : "is-faint";
}

function offlineGroup(): HTMLElement {
  const group = el("div", {});
  group.append(el("div", { class: "lm-cite-group" }, t("cOffline")));
  const issues = citC1?.issues ?? [];
  if (issues.length === 0) {
    group.append(citeRow("✓", "is-ok", t("cNoIssues"), "", {}));
    return group;
  }
  for (const iss of issues) {
    const titleKey = C1_TITLE[iss.code];
    group.append(
      citeRow(
        C1_GLYPH[iss.code] ?? "•",
        severityColor(iss.severity),
        titleKey ? t(titleKey) : iss.code,
        iss.message,
        {
          mono: true,
          onClick: () =>
            vscode.postMessage({
              type: "revealCitation",
              file: iss.file,
              line: iss.line,
            }),
        },
      ),
    );
  }
  return group;
}

function onlineGroup(): HTMLElement {
  const group = el("div", {});
  group.append(
    el("div", { class: "lm-cite-group lm-cite-group--top" }, t("cOnline")),
  );
  const keys = citC1?.entryKeys ?? [];
  if (citChecking) {
    for (const key of keys) {
      group.append(
        citeRow("⟳", "is-faint", key, t("cChecking"), {
          mono: true,
          spin: true,
        }),
      );
    }
    return group;
  }
  if (citC2) {
    if (citC2.results.length === 0) {
      group.append(citeRow("○", "is-faint", t("cNoEntries"), "", {}));
    }
    for (const r of citC2.results) {
      group.append(
        citeRow(
          C2_GLYPH[r.status] ?? "○",
          C2_COLOR[r.status] ?? "is-faint",
          `${r.key} — ${t(C2_TITLE[r.status] ?? "cUnverified")}`,
          r.detail,
          r.hasCorrection
            ? {
                adopt: () =>
                  vscode.postMessage({ type: "adoptCitation", key: r.key }),
                // R3: `citeRow` moved to `parts/rows.ts` and lost its hidden
                // `t("cAdopt")` fallback — a pure primitive cannot read a
                // locale. The caption is passed where it is known.
                adoptLabel: t("cAdopt"),
              }
            : {},
        ),
      );
    }
    return group;
  }
  // Idle (not yet run).
  if (keys.length === 0) {
    group.append(citeRow("○", "is-faint", t("cNoEntries"), "", {}));
  }
  for (const key of keys) {
    group.append(
      citeRow("○", "is-faint", key, t("cNotCheckedDetail"), { mono: true }),
    );
  }
  return group;
}

function privacyFooter(): HTMLElement {
  const endpoints = (citC2?.endpoints ?? citC1?.endpoints ?? []).join(", ");
  return el(
    "div",
    { class: "lm-cite-footer" },
    el("span", { class: "lm-cite-lock" }, "🔒"),
    el("span", {}, `${t("cPrivacy")} `),
    el("span", { class: "lm-cite-mono" }, endpoints),
  );
}

function citationsPanel(): HTMLElement {
  const available = citC1?.available ?? false;
  // No .bib → nothing the online check could verify, so no button at all
  // (U2 manual review): a disabled control would beg "why can't I click it?".
  const hasBib = available && (citC1?.bibFiles.length ?? 0) > 0;
  const runBtn = el(
    "button",
    { class: "lm-btn lm-btn--primary" },
    citC2 ? t("cReRun") : t("cRunCheck"),
  ) as HTMLButtonElement;
  runBtn.addEventListener("click", () => {
    citChecking = true;
    citC2 = undefined;
    scheduleRender();
    vscode.postMessage({ type: "runCitationCheck" });
  });

  // When unavailable the centered empty body carries the "no paper" message,
  // so keep the header title blank to avoid duplicating the sentence.
  const title = !available
    ? ""
    : citC1?.bibFiles.length
      ? citC1.bibFiles.join(" · ")
      : t("cNoBibFile");
  const sub = available
    ? `${citC1?.entryCount ?? 0} ${t("cEntries")} · ${citC1?.citedKeyCount ?? 0} ${t("cCitedKeys")}`
    : "";
  const head = el(
    "div",
    { class: "lm-cite-header" },
    el(
      "div",
      { class: "lm-cite-header__text" },
      el("div", { class: "lm-cite-title" }, title),
      el("div", { class: "lm-cite-sub" }, sub),
    ),
    ...(hasBib ? [runBtn] : []),
  );

  const panel = el(
    "div",
    { class: "lm-content", role: "tabpanel", id: "lm-tabpanel" },
    head,
  );
  if (!available) {
    panel.append(el("div", { class: "lm-cite-empty" }, t("cNoPaper")));
    return panel;
  }
  panel.append(offlineGroup(), onlineGroup(), privacyFooter());
  return panel;
}

// ---- Review tab (U5 round 2: a tab, not a separate view). R3 moved the
// RENDERING into `parts/review-tab.ts` so both modes are jsdom-testable
// (ADR 0037); what stays here is the state and the host wiring. ----

/**
 * ADR 0063 §3: hand one concern to the assistant, and send it.
 *
 * This is what *Resolve* means now. It used to file the concern away as dealt
 * with, which changed nothing in the manuscript and asserted something nobody
 * had checked; and the only other fix path was *Adopt suggestion*, which
 * splices one anchored run of text. Most reviewer concerns fit neither: a
 * disputed claim can touch the abstract, the discussion and everything that
 * leans on it, and that is work for a model with the whole paper in front of
 * it, not for a text swap.
 *
 * The composition is `resolvePrompt` (`parts/review-prompts.ts`), where a test
 * can read what the model reads. What stays here is the sending, and one
 * thing about it is deliberate: it never reads the composer. The prompt is
 * sent as its own message, so a half-typed draft is neither shipped to the
 * model nor destroyed — it is still sitting there afterwards.
 */
function resolveWithAssistant(a: ReviewAnnotationInfo): void {
  const prompt = resolvePrompt(locale, a);
  // One message, so the host marks the concern and sends the prompt together
  // — and sends it down the path a typed message takes, which is where the
  // busy/steering rule lives.
  vscode.postMessage({ type: "resolveAnnotation", index: a.index, prompt });
  // A5, as `submit()` does: a send while a task runs is queued as steering,
  // and the queue is shown so the click does not look like it was swallowed.
  if (sessionBusy) queuedSteering.push(prompt.trim());
  selectTab(0);
  if (activeTab === 0) scheduleRender();
}

/**
 * ADR 0062 §6: take one concern to the Assistant, with the composer already
 * holding it.
 *
 * The text is written into the LIVE composer node — which is detached while
 * the Review tab is on screen, but is exactly what `render()` reads the draft
 * from (`draftAnchor`, `parts/frame.ts`), so the rebuild carries it over. The
 * prefill is a draft, not a send: what to ask about a reviewer's concern is
 * the writer's sentence to finish, and posting it for them would be answering
 * a question they had not asked yet.
 */
function chatAboutConcern(a: ReviewAnnotationInfo): void {
  const input = composerInput;
  if (!input) return;
  const draft = chatDraft(locale, a);
  // The draft is REPLACED, not appended to: the button says "chat about it",
  // and appending would silently mix the reviewer's words into a half-typed
  // message the user was already composing. Anything already there is
  // preserved above it instead, so nothing typed is destroyed.
  const existing = input.value.trim();
  input.value = existing === "" ? draft : `${existing}\n\n${draft}`;
  pendingComposerFocus = true;
  selectTab(0);
  // Already on the Assistant tab: `selectTab` short-circuits, so the render
  // that applies the draft has to be asked for here.
  if (activeTab === 0) scheduleRender();
}

/**
 * ADR 0064 §2: start a blind panel from the Review tab's launcher.
 *
 * ADR 0065 §2: the host starts a DETACHED panel — not a chat task — and
 * typing `/review` reaches the same place, so the two routes still meet at one
 * implementation.
 *
 * **And the reader stays here.** ADR 0064 §2 switched to the Assistant tab,
 * because that is where the panel's progress was drawn; the progress is in
 * this tab now, so leaving it would be walking the reader away from the thing
 * they just started.
 */
function runReviewPanel(): void {
  // One review at a time. Not gated on `sessionBusy` any more: a chat task
  // running beside a review is fine, which is the whole of ADR 0065 §3.
  if (reviewRun?.running === true) return;
  vscode.postMessage({ type: "runReviewPanel" });
}

/**
 * V4 (ADR 0081 §8): review the compiled PDF alone — the launcher's second
 * verb, and the same place `/review-pdf` reaches. One review at a time, by
 * `runReviewPanel`'s rule; the host refuses a second click too.
 */
function runReviewPdf(): void {
  if (reviewRun?.running === true) return;
  vscode.postMessage({ type: "runReviewPdf" });
}

function reviewPanel(): HTMLElement {
  return renderReviewTab(reviewTab, {
    locale,
    reveal: (index) => vscode.postMessage({ type: "revealAnnotation", index }),
    // V1 (ADR 0076 §9): the passage that answered a withdrawn concern.
    revealCounter: (index) =>
      vscode.postMessage({ type: "revealAnnotation", index, which: "counter" }),
    ignore: (index) => vscode.postMessage({ type: "ignoreAnnotation", index }),
    adopt: (index) => vscode.postMessage({ type: "adoptSuggestion", index }),
    resolve: resolveWithAssistant,
    chat: chatAboutConcern,
    selectReview: (id) => vscode.postMessage({ type: "selectReview", id }),
    chooseEntry: () => vscode.postMessage({ type: "choosePaperEntry" }),
    runPanel: runReviewPanel,
    runPdf: runReviewPdf,
    stopPanel: () => vscode.postMessage({ type: "stopReview" }),
    ...(reviewRun ? { run: reviewRun } : {}),
    groupOpen: (key, fallback) => reviewFolds.get(key) ?? fallback,
    onGroupToggle: (key, open) => {
      reviewFolds.set(key, open);
    },
    ...(reviewNarrow !== undefined ? { narrowed: reviewNarrow } : {}),
    onNarrow: (dimension, reveal) => {
      reviewNarrow = dimension;
      reviewTarget = reveal;
      scheduleRender();
    },
    ...(reviewTarget !== undefined ? { target: reviewTarget } : {}),
  });
}

// ---- Compile tab (X1): the findings of a Compile Check the USER asked for.
// Every row is triage the user drives — Fix (one) / Fix all (every pending one)
// re-enter the Accept-gated diff, and nothing here re-runs a compile. ----

const C_GLYPH: Record<string, string> = { error: "✗", warning: "⚠", info: "○" };
const C_COLOR: Record<string, string> = {
  error: "is-error",
  warning: "is-warning",
  info: "is-faint",
};

/** A finding's detail line: its code and, when the compiler gave one, its line. */
function findingDetail(f: CompileFindingInfo): string {
  return f.line !== undefined ? `${f.code} · L${f.line}` : f.code;
}

function revealFinding(index: number): void {
  vscode.postMessage({ type: "revealFinding", index });
}

/** One resolved (fixed/ignored) finding — read-only, no action buttons. */
function resolvedFindingRow(f: CompileFindingInfo): HTMLElement {
  const glyph = f.status === "fixed" ? "✓" : "⊘";
  const color = f.status === "fixed" ? "is-ok" : "is-faint";
  return citeRow(glyph, color, f.message, findingDetail(f), {
    onClick: () => revealFinding(f.index),
  });
}

function compilePanel(): HTMLElement {
  const panel = el("div", {
    class: "lm-content",
    role: "tabpanel",
    id: "lm-tabpanel",
  });
  const s = compileTab;
  if (!s || !s.available) {
    panel.append(el("div", { class: "lm-cite-empty" }, t("cEmpty")));
    return panel;
  }
  // The engine could not be resolved: say so. An empty finding list here would
  // read as a clean bill of health for a project that never compiled.
  if (s.guidance !== undefined && s.guidance !== "") {
    panel.append(
      el(
        "div",
        { class: "lm-cite-header" },
        el(
          "div",
          { class: "lm-cite-header__text" },
          el("div", { class: "lm-cite-title is-warning" }, t("cGuidance")),
          el("div", { class: "lm-cite-sub" }, s.guidance),
        ),
      ),
    );
    return panel;
  }
  const pending = s.findings.filter((f) => f.status === "pending");
  const fixed = s.findings.filter((f) => f.status === "fixed");
  const ignored = s.findings.filter((f) => f.status === "ignored");

  // A failed compile the parser recognised no findings in: still say the
  // project did not compile — an empty list here would read as clean.
  if (!s.ok && s.findings.length === 0) {
    panel.append(el("div", { class: "lm-cite-empty" }, t("cFailed")));
    return panel;
  }
  if (s.ok && s.findings.length === 0) {
    panel.append(el("div", { class: "lm-cite-empty" }, t("cClean")));
    return panel;
  }

  const fixAllBtn = el(
    "button",
    { class: "lm-btn lm-btn--primary" },
    t("cFixAll"),
  ) as HTMLButtonElement;
  fixAllBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "fixAllFindings" }),
  );
  panel.append(
    el(
      "div",
      { class: "lm-cite-header" },
      el(
        "div",
        { class: "lm-cite-header__text" },
        el("div", { class: "lm-cite-title" }, s.file),
        el(
          "div",
          { class: "lm-cite-sub" },
          `${pending.length} ${t("cFindings")}`,
        ),
      ),
      // One pending finding needs no "all" — its own Fix button says it.
      ...(pending.length >= 2 ? [fixAllBtn] : []),
    ),
  );
  for (const f of pending) {
    panel.append(
      citeRow(
        C_GLYPH[f.severity] ?? "○",
        C_COLOR[f.severity] ?? "is-faint",
        f.message,
        findingDetail(f),
        {
          mono: true,
          onClick: () => revealFinding(f.index),
          adopt: () =>
            vscode.postMessage({ type: "fixFinding", index: f.index }),
          adoptLabel: t("cFix"),
          ignore: () =>
            vscode.postMessage({ type: "ignoreFinding", index: f.index }),
          ignoreLabel: t("cIgnore"),
        },
      ),
    );
  }
  // A clean "you're done" state once every finding is triaged.
  if (pending.length === 0 && (fixed.length > 0 || ignored.length > 0)) {
    panel.append(el("div", { class: "lm-cite-empty" }, t("cAllResolved")));
  }
  if (fixed.length > 0) {
    panel.append(
      foldedGroup(
        t("cFixed"),
        fixed,
        fixedOpen,
        (next) => {
          fixedOpen = next;
        },
        resolvedFindingRow,
      ),
    );
  }
  if (ignored.length > 0) {
    panel.append(
      foldedGroup(
        t("cIgnored"),
        ignored,
        cIgnoredOpen,
        (next) => {
          cIgnoredOpen = next;
        },
        resolvedFindingRow,
      ),
    );
  }
  panel.append(
    el(
      "div",
      { class: "lm-cite-footer" },
      el("span", { class: "lm-cite-lock" }, "🔒"),
      el("span", {}, t("cReport")),
    ),
  );
  return panel;
}

/**
 * D3 round 4: whether the transcript rides the stream is the reader's intent,
 * held here for the life of the bundle rather than re-derived from the scroll
 * offset on every frame. It survives the rebuild because it is not IN the tree;
 * a tab switch resets it, which `replaceScrollPreserving` does off
 * `keepPosition`. Only the Assistant tab passes it, so no other view can be
 * moved by it.
 */
const transcriptFollower = createScrollFollower();

let lastRenderTab = -1;

function render(): void {
  // E6 (D8): the ⟲ popover hangs off a transcript node this rebuild is about
  // to throw away. Closing it here rather than letting it be orphaned is what
  // keeps its document-level listeners from outliving it — and a card closed
  // this way declines its nonce, so the host stops holding the plan.
  closeRewindMenu();
  // A0: session events re-render tab 0 asynchronously — preserve the user's
  // in-progress composer draft, its focus AND its caret across the rebuild.
  // The caret was the half A0 dropped; `parts/frame.ts` says why it matters.
  const draft = draftAnchor(composerInput, document.activeElement);
  // A1a: follow streamed transcript output, but only while we stay on tab 0 —
  // a tab switch just lands at the bottom.
  const sameTabRerender = lastRenderTab === 0 && activeTab === 0;
  // Reset Assistant-only element refs so applySelection stays safe off-tab.
  // (composerInput is deliberately NOT reset: the draft capture above and the
  // restore below bridge it across the rebuild; composer() reassigns it.)
  mvpTiles.clear();
  sendBtn = undefined;
  chipEl = undefined;
  heroEl = undefined;
  // D3 round 2: `replaceScrollPreserving` builds FIRST and reads the scroll
  // anchor at the last possible moment before the old tree is detached. Reading
  // it before the build — which is what this function used to do — discarded
  // every scroll the user performed while a response streamed, because the
  // position was read from a node that was about to be thrown away. The order
  // lives in `parts/frame.ts` so a jsdom test can assert it.
  //
  // D3 round 3: that ordering was necessary and not sufficient, and the
  // operator's round found the transcript still locked. When a position is being
  // carried, `replaceScrollPreserving` now SPLICES rather than replacing — the
  // live `.lm-content` node stays attached while its siblings and its children
  // are swapped around and beneath it. A wheel gesture is a compositor animation
  // and a thumb drag is a pointer capture, and both live on that element; a
  // wholesale rebuild destroyed it once per frame and cancelled them. This call
  // site is unchanged, deliberately: what it asks for — "keep the reader's
  // place" — is what it always asked for, and only the mechanism was wrong.
  replaceScrollPreserving({
    root: document.body,
    // Only the Assistant tab carries a scroll across the swap. Every other tab
    // has a `.lm-content` of its own, so passing this unconditionally sent the
    // Citations, Models, Venue, Review and Compile panels to the BOTTOM of their
    // content on every render — the scoping the pre-round-2 code got from
    // sitting inside `if (activeTab === 0)`, which this restores explicitly.
    ...(activeTab === 0
      ? {
          scroll: {
            selector: ".lm-content",
            keepPosition: sameTabRerender,
            follower: transcriptFollower,
          },
        }
      : {}),
    build: () => {
      const children: (Node | string)[] = [globalHeader(), tabBar()];
      if (activeTab === 0) {
        // CHAT-6: the session controls belong to this tab, so they render with it.
        children.push(sessionBar());
        // The transcript lives INSIDE the scroll region (.lm-content) with the
        // hero/quick-actions; the composer is a fixed sibling that never scrolls
        // away and is never pushed off-screen by a growing transcript.
        const body = content();
        body.append(transcript());
        children.push(body, composer());
      } else if (activeTab === 1) {
        children.push(citationsPanel());
      } else if (activeTab === 2) {
        children.push(modelsPanel());
      } else if (activeTab === 3) {
        children.push(venuePanel());
      } else if (activeTab === 4) {
        children.push(reviewPanel());
      } else {
        children.push(compilePanel());
      }
      return el("div", { class: "lm-app" }, ...children);
    },
  });
  if (activeTab === 0) {
    // composer() reassigned the module ref during the children build; read it
    // through a fresh local so TS's narrowing (from the reset above) resets.
    const input: HTMLTextAreaElement | undefined = composerInput;
    restoreDraft(input, draft);
    // ADR 0062 §6: a prefill from another tab lands here — after the draft is
    // restored, so the caret is written last and wins (the same order
    // `restoreDraft` documents for itself).
    if (pendingComposerFocus && input) {
      pendingComposerFocus = false;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    applySelection();
  }
  // V6 (ADR 0088 §4): a synthesis chip's landing, once the narrowing that hid
  // its row is cleared. The tab marked the row and opened its fold while
  // building; only now is it attached, so only now can it be scrolled to.
  if (reviewTarget !== undefined) {
    reviewTarget = undefined;
    if (activeTab === 4)
      document
        .querySelector(".lm-review-tab .is-target")
        ?.scrollIntoView({ block: "center" });
  }
  lastRenderTab = activeTab;
}

/**
 * D3 round 2: every caller schedules; nothing rebuilds synchronously.
 *
 * At streaming rates `sessionEvent` fired several times per frame and each one
 * rebuilt the whole of `document.body`, leaving the main thread no room to
 * process a wheel event — the transcript read as locked rather than as slow.
 * Coalescing collapses those N rebuilds into one per frame.
 *
 * Every call site was checked before being converted. All but one mutate module
 * state and then re-render without touching the DOM afterwards, so a frame of
 * latency is invisible. **The exception is the tab bar's arrow-key handler**,
 * which calls `selectTab(next)` and then `btns[next]?.focus()` on a button from
 * the render that is being replaced. That focus call was already a no-op before
 * this change — it ran after a synchronous rebuild had detached `btns` — so
 * deferring the render makes it no worse, but it is named here rather than
 * covered by a blanket claim; the roving-tabindex defect behind it is recorded
 * in `docs/open-questions.md`.
 *
 * The first paint at the bottom of this file stays a direct `render()`: there is
 * nothing to coalesce, and deferring it by a frame would show an empty body.
 *
 * `renderScheduler` is a module-scope `const` reached through a hoisted
 * function, so every `scheduleRender()` call must happen after this line runs.
 * They all do — they are event handlers — but moving the message listener above
 * this point would throw on the first host message.
 */
const renderScheduler = createRenderScheduler(render, (cb) =>
  requestAnimationFrame(cb),
);

function scheduleRender(): void {
  renderScheduler.schedule();
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (msg.type === "init") {
    locale = msg.locale;
    mvpActions = msg.quickActions.length > 0 ? msg.quickActions : mvpFallback();
    modelLabel = msg.model.configured ? msg.model.name : "";
    budgetInfo = msg.budget;
    scheduleRender();
  } else if (msg.type === "selection") {
    selectionState = msg.state;
    // Refresh C1 when the active FILE changes while the Citations tab is open
    // (not on every cursor move).
    if (
      activeTab === 1 &&
      msg.state.file !== "" &&
      msg.state.file !== citFile
    ) {
      citFile = msg.state.file;
      requestCitations();
    }
    // Same refresh rule for the Venue tab: the detected venue follows the file.
    if (
      activeTab === 3 &&
      msg.state.file !== "" &&
      msg.state.file !== venueFile
    ) {
      venueFile = msg.state.file;
      vscode.postMessage({ type: "requestVenue" });
    }
    applySelection();
  } else if (msg.type === "citationsC1") {
    citC1 = msg.state;
    citC2 = undefined; // a new C1 context invalidates stale C2 results
    citChecking = false;
    if (activeTab === 1) scheduleRender();
  } else if (msg.type === "citationsC2") {
    citC2 = msg.state;
    citChecking = false;
    if (activeTab === 1) scheduleRender();
  } else if (msg.type === "modelsState") {
    modelsState = msg.state;
    // Keep the composer's model pill label in sync for the next Assistant paint.
    const active = msg.state.models.find((m) => m.active);
    const nextLabel = active ? active.model : "";
    const labelMoved = nextLabel !== modelLabel;
    modelLabel = nextLabel;
    // Tab 2 is the Models tab this state describes; tab 0 is where the pill
    // that shows `modelLabel` actually LIVES (the composer). Repainting only
    // tab 2 left a reader sitting on the Assistant tab with the old name until
    // something else asked for a render — the second half of the R3
    // gate-review's stale-chip report (ADR 0064 §4).
    if (activeTab === 2 || (activeTab === 0 && labelMoved)) scheduleRender();
  } else if (msg.type === "venueState") {
    venueState = msg.state;
    if (activeTab === 3) scheduleRender();
  } else if (msg.type === "reviewState") {
    reviewTab = msg.state;
    // reveal = a review just completed: switch to the Review tab (the host
    // has already focused this webview).
    if (msg.reveal) {
      activeTab = 4;
      scheduleRender();
    } else if (activeTab === 4) {
      scheduleRender();
    }
  } else if (msg.type === "compileState") {
    compileTab = msg.state;
    // reveal = a Compile Check just completed: switch to the Compile tab (the
    // host has already focused this webview).
    if (msg.reveal) {
      activeTab = 5;
      scheduleRender();
    } else if (activeTab === 5) {
      scheduleRender();
    }
  } else if (msg.type === "reviewRun") {
    // ADR 0065 §3: a frame from the detached panel. Repainted only when the
    // Review tab is the one on screen — the run draws nowhere else, which is
    // the point of detaching it.
    reviewRun =
      msg.run === undefined
        ? undefined
        : {
            running: msg.run.running,
            ...(msg.run.item ? { item: msg.run.item } : {}),
            notices: msg.run.notices.map(noticeText),
          };
    if (activeTab === 4) scheduleRender();
  } else if (msg.type === "sessionEvent") {
    // A0: fold the typed session stream into the transcript (ADR 0014).
    foldSessionEvent(msg.event);
    if (activeTab === 0) scheduleRender();
    // ADR 0064 §3's second repaint arm is GONE: the Review tab's Run was gated
    // on `sessionBusy`, and ADR 0065 §3 gates it on the review instead. A chat
    // task starting or ending changes nothing the Review tab draws.
  } else if (msg.type === "transcriptReplay") {
    // A5: this bundle just (re-)started over a session the host still holds.
    // ADR 0027 had a second case here — a rewind moving the branch under a
    // live bundle, where the snapshot had to REPLACE rather than merge. ADR
    // 0057 removed it: a rewind changes the session id and goes through the
    // ordinary resume, which resets this panel first, so there is one case
    // left and `seedTranscript` merges unconditionally.
    seedTranscript(msg.items);
    // The task may still be running: keep Stop (◼) live and leave any pending
    // approval card decidable (its buttons are gated on busy).
    sessionBusy = msg.busy;
    // CHAT-3: the live flag went with the page. Derive it, so a reload
    // mid-answer does not put "Thinking…" back under text already on screen.
    turnStreamed = turnStreamedFromSnapshot(msg.items);
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "sessionReset") {
    // A1a: Lemmaria: New Session — a fresh thread, fresh transcript.
    resetTranscript();
    // A2: a fresh thread has measured nothing — the ring goes back to "—".
    contextUsage = undefined;
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "sessionCost") {
    // A5: this session's spend so far (tokens always, dollars when priced).
    sessionCost = {
      inputTokens: msg.inputTokens,
      outputTokens: msg.outputTokens,
      ...(msg.costUsd === undefined ? {} : { costUsd: msg.costUsd }),
      ...(msg.unpricedCalls === undefined
        ? {}
        : { unpricedCalls: msg.unpricedCalls }),
    };
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "contextUsage") {
    // A2 (ADR 0021): measured occupancy for the composer ring; window 0 =
    // nothing to report (a fresh thread), so the ring shows "—".
    contextUsage = msg.window > 0 ? msg : undefined;
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "editPolicy") {
    // A1b: keep the composer permission selector in sync with the host.
    editPolicyState = msg.policy;
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "grantsState") {
    // A4: keep the granted-folder chips in sync with the host.
    sessionGrants = msg.grants;
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "skillsCatalogue") {
    // E2 (ADR 0049): the `/` menu's second candidate source, pushed rather than
    // polled — E1's runtime toggle moves the enabled set while the panel is
    // open. An OPEN menu is re-ranked against the new set rather than left
    // showing a skill that has since been disabled.
    skillCatalogue = msg.skills;
    reRankOpenMenu();
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "contextPaths") {
    // E3 (ADR 0052): the `@` menu's candidate source, on the shape
    // `skillsCatalogue` established. An OPEN menu is re-ranked against the new
    // set rather than left showing a path a revoked grant no longer covers —
    // which is decision 10's failure arriving by a different route.
    contextPaths = {
      ...(msg.workspace ? { workspace: msg.workspace } : {}),
      grants: msg.grants,
    };
    reRankOpenMenu();
    syncComposerMenu();
  } else if (msg.type === "composerPrefill") {
    // A rewind hands the message back so it can be edited and resent; B7's
    // "Use a Writing Skill" fills the `/skill:<name> ` prefix the same way.
    // E2: the draft is replaced wholesale, so a menu still pointing into the
    // old text is describing a token that no longer exists.
    composerMenu = undefined;
    if (composerInput) {
      composerInput.value = msg.text;
      composerInput.focus();
    }
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "rewindPoints") {
    // ADR 0031: which user messages the conversation can branch at, and
    // (E7, ADR 0055) what clicking each one would change.
    rewindPointFiles = new Map(msg.points.map((p) => [p.id, p.files]));
    if (activeTab === 0) scheduleRender();
  } else if (msg.type === "rewindConfirm") {
    // E6 (D8): the plan a restoring arm asked for, on its way to the card.
    // Routed by `messageId` — a push that arrives after the user dismissed the
    // menu, or opened one at a different message, is DECLINED rather than
    // re-opening a surface they closed — declined and not merely ignored,
    // because the host is holding a plan under that nonce and this is the only
    // side that knows the card will never be shown.
    if (rewindMenu?.messageId === msg.messageId) {
      rewindMenu.showConsent({
        nonce: msg.nonce,
        withFork: msg.withFork,
        files: msg.files,
        deletions: msg.deletions,
      });
    } else {
      vscode.postMessage({
        type: "rewindDecision",
        nonce: msg.nonce,
        confirmed: false,
      });
    }
  } else if (msg.type === "rewindPreviewRefused") {
    // E6 (code review): no plan is coming, so give the arms back. Routed by
    // `messageId` like the card, and needing no reply — the host stored
    // nothing, so there is no plan to release.
    if (rewindMenu?.messageId === msg.messageId) rewindMenu.refuse();
  } else if (msg.type === "echo") {
    // U0 pipeline proof (retained): reply so the host can observe the reverse
    // direction. No visible surface — the real Assistant tab renders above.
    vscode.postMessage({ type: "echoed", text: `${msg.text} (from webview)` });
  } else if (msg.type === "probe") {
    // T2 (ADR 0043): drive a gesture and measure the result. No visible
    // surface, and no state of its own — every step re-queries by selector.
    void runProbe(msg.requestId, msg.steps);
  }
});

/**
 * Walks a probe request, honouring each step's `afterFrames` (T2, ADR 0043 §D3).
 *
 * **Why frames and not a timer.** `scheduleRender()` coalesces every rebuild
 * into one per animation frame, and `render()` replaces `document.body`'s
 * children wholesale — so a step measured synchronously after a `click` reads
 * the DOM the click has not changed yet, and a node handle is stale one frame
 * later. Waiting on a wall clock instead would make the test measure the
 * machine; waiting on frames makes the number part of the assertion.
 *
 * `frame.ts`'s `RenderScheduler` is deliberately NOT given a `flush()` for
 * this — its own comment argues that an unused escape hatch is a thing a later
 * reader assumes something calls, and a double-`requestAnimationFrame` here
 * needs nothing from it.
 */
async function runProbe(requestId: string, steps: ProbeStep[]): Promise<void> {
  const results: ProbeResult[] = [];
  for (const step of steps) {
    // **A throwing step must still be a RESULT** (ADR 0043 §D6). `runProbeStep`
    // is written never to throw, but `click` and `key` run the PRODUCT's own
    // handlers, and those can. Letting that escape would post no `probed` at
    // all, so the host would hit its timeout and REJECT — the one signal §D6
    // reserves for a dead channel. A defective handler would then be reported
    // as broken plumbing, which is exactly the ambiguity the design removes.
    try {
      results.push(runProbeStep(step, document));
    } catch (e) {
      results.push({ verb: step.verb, error: `threw: ${String(e)}` });
    }
    const frames = step.afterFrames ?? 2;
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  }
  vscode.postMessage({ type: "probed", requestId, results });
}

render();
vscode.postMessage({ type: "ready" });
