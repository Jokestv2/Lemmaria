import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  type CitationResult,
  LIST_FILES_MAX,
  type LoadedAction,
  MAX_FAN_OUT,
  PROVIDER_PRESETS,
  type SessionEvent,
  type Skill,
  type VenueChecklistRow,
  computeVenueChecklist,
  imageInputFor,
  providerPreset,
  walkGrantedRoot,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { ceilingsFromSettings } from "./action-run";
import { tr } from "./chrome-strings";
import {
  adoptCitationCorrection,
  citationEndpoints,
  computeCitationC1,
  runCitationC2,
} from "./citation-ui";
import {
  computeCompileTabState,
  ignoreFinding,
  onCompileChanged,
  onCompileCompleted,
} from "./compile-ui";
import {
  currentCostState,
  onUsageRecorded,
  recordRun,
  recordUsage,
  sessionUsageRows,
} from "./cost-ui";
import { onProposalAccepted } from "./diff-review";
import { currentLocale, localeLabel } from "./i18n";
import { modelStore, reviewRolesStore } from "./model";
import { modelKeySecret } from "./model-store";
import { reviewPaperEntry } from "./paper-entry";
import { ACTION_COMMAND_BY_ID } from "./polish-command";
import {
  currentReviewRun,
  onReviewRunChanged,
  startReviewRun,
  stopReviewRun,
} from "./review-host";
import { DEFAULT_REVIEW_ROLES } from "./review-roles-store";
import {
  computeReviewTabState,
  handAnnotationToAssistant,
  ignoreAnnotation,
  onReviewChanged,
  onReviewCompleted,
  selectReview,
} from "./review-ui";
import {
  decideRewind,
  onSessionRestore,
  previewRewind,
  rewindFromMessage,
  showSessionEditDiff,
} from "./session-edit-ui";
import {
  activeSessionGrants,
  activeSessionId,
  activeSessionReady,
  activeSessionSnapshot,
  activeSessionUsage,
  compactActiveSession,
  currentEditPolicy,
  handleComposerSend,
  interruptSessionTask,
  isTaskInFlight,
  listSessions,
  onContextUsage,
  onGrantsChanged,
  onRestorePointsChanged,
  onRunUsage,
  onTurnUsage,
  resumeSession,
  revokeGrant,
  rewindPointsOf,
  setEditPolicy,
  startNewSession,
  submitEditDecisions,
  submitScriptDecision,
} from "./session-host";
// E3 (ADR 0052): the READ root the session actually uses — not
// `workspaceFolders[0]`, which the write path falls back to. The `@` menu must
// offer paths from the root `list_files` walks, and no other.
import { forkSessionAtEnd } from "./session/edit-host";
import { paperInContext } from "./session/registry";
import { refreshSessionsView } from "./sessions-view";
import {
  currentSkills,
  setComposerPrefill,
  setSkillsChanged,
} from "./skills-ui";
import { matchVenueForEntry } from "./venue-match";
import type {
  BudgetInfo,
  CitationIssue,
  CitationKeyResult,
  CitationsC1State,
  CitationsC2State,
  CompileTabState,
  ConfiguredModelInfo,
  ContextRootPayload,
  CostSummaryInfo,
  HostToWebview,
  ModelInfo,
  ModelsState,
  ProbeResult,
  ProbeStep,
  ProviderInfo,
  QuickActionInfo,
  ReviewTabState,
  SelectionState,
  VenueChecklistRowInfo,
  VenueState,
  WebviewToHost,
} from "./webview-protocol.js";
import { VscodeWorkspace, lastCompilePages } from "./workspace";

const VIEW_ID = "lemmariaAssistant";

/** The bundled actions, stashed by `registerWebview` for init-state metadata. */
let loadedActions: LoadedAction[] = [];
/** The extension context, stashed by `registerWebview` for the composer path. */
let extContext: vscode.ExtensionContext | undefined;
/** The last SelectionState pushed to the webview (test observability). */
let lastPushedSelection: SelectionState | undefined;
/** Citations tab: one state per window (M9 precedent). The workspace root the
 *  last C1 was computed for, so `revealCitation` can resolve jump targets. */
let lastCitationRoot: string | undefined;
/** The paper uri the last C1 was computed for — the post-Accept refresh re-reads it. */
let lastCitationUri: vscode.Uri | undefined;
/** The last C1 bib entries, so a Run check reuses them for the C2 lookup. */
let lastCitationEntries: { key: string; fields: Record<string, string> }[] = [];
/** The last C2 results, so `adoptCitation` needs no second network call. */
let lastC2Results: CitationResult[] = [];
/** The last C2 display state pushed to the webview (test observability). */
let lastC2State: CitationsC2State | undefined;
/** Adopt-in-flight bookkeeping: real .bib uri (string) → the adopted key, so
 *  the proposal-accepted event can tell citation adoptions from other edits. */
const pendingAdoptKeys = new Map<string, string>();
/** The last ModelsState the host built/pushed (test observability, U3). */
let lastModelsState: ModelsState | undefined;
/** The last VenueState the host built/pushed (test observability, U4). */
let lastVenueState: VenueState | undefined;
/** The last ReviewTabState the host built/pushed (test observability, U5). */
let lastReviewTabState: ReviewTabState | undefined;
/** The last CompileTabState the host built/pushed (test observability, X1). */
let lastCompileTabState: CompileTabState | undefined;

/**
 * The ONE way the host reaches the webview (A5). Every H→W message funnels
 * here, so there is a single place that knows how to post and a single place
 * tests can observe — the A1a inbound-router lesson applied to the outbound
 * direction (a second, hand-maintained path is a path that drifts).
 */
function postToWebview(msg: HostToWebview): void {
  postedToWebview.push(msg);
  if (postedToWebview.length > POSTED_LOG_CAP) postedToWebview.shift();
  void current?.webview.postMessage(msg);
}

/**
 * E2 (ADR 0049): the loaded catalogue, narrowed to what the `/` menu shows.
 *
 * **`name` and `description` only.** `Skill.path` is UI provenance that E1
 * deliberately keeps from the model, `body` is the guidance itself, and the
 * menu needs neither — so neither goes on the wire. The description is
 * forwarded byte-for-byte: it is the author's text, not Lemmaria's (invariant
 * 6's stated boundary, ADR 0045).
 */
function postSkillsCatalogue(skills: readonly Skill[]): void {
  postToWebview({
    type: "skillsCatalogue",
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
  } satisfies HostToWebview);
}

/**
 * E3 (ADR 0052): the paths the composer's `@` menu may offer.
 *
 * **Every root is walked by the call `list_files` itself makes** — that is the
 * whole of invariant 2 here, and it is why this function does not have a walk
 * of its own. `VscodeWorkspace.listFiles` for the workspace,
 * `walkGrantedRoot` for a grant: the same two branches
 * [`engine/tools.ts`](../../harness/src/engine/tools.ts)'s `list_files`
 * executor takes, with the same cap. A third walk would be a third filter, and
 * the moment the menu's filter and the tool's are written separately, *"no path
 * the model could not already reach"* becomes a claim maintained by hand.
 *
 * **The two filter DIFFERENTLY, deliberately.** ADR 0019 applies `.gitignore`
 * and the deny-read list to granted roots only — the user's own repository is
 * not filtered — so mirroring means mirroring *per root kind*. Narrowing the
 * workspace half to match would hide paths the model can read today, including
 * the gitignored results folder the Experiments flagship is about.
 *
 * **No paper in context ⇒ no workspace half at all**, because the session's
 * registry then has no workspace either and `list_files` refuses outright.
 * Falling back to `workspaceFolders[0]` would offer a root the session is not
 * reading.
 */
let contextPathsWalking = false;
/**
 * A walk was asked for while one was running (E3 code review).
 *
 * D6 authorises DROPPING an overlapping request — a user who types `@`, deletes
 * it and types it again should not queue two filesystem walks. It does not
 * authorise dropping a **push**: the same guard also governs the grant-change
 * re-push, and a grant added or revoked mid-walk would otherwise never reach the
 * webview at all, with no second event to recover it. So a dropped call sets
 * this and the walk re-runs exactly once when it finishes — collapsing any
 * number of overlapping calls into one repeat, which is the queue-of-two the
 * drop rule was actually protecting against.
 */
let contextPathsAgain = false;

async function postContextPaths(): Promise<void> {
  if (contextPathsWalking) {
    contextPathsAgain = true;
    return;
  }
  contextPathsWalking = true;
  try {
    // Each root is walked in its OWN try. One unreadable grant must not
    // discard the roots already walked beside it: a partial listing is the
    // A0 P1 best-effort rule, while an all-or-nothing post silently blanks a
    // menu over a folder that has nothing wrong with it.
    const grants: ContextRootPayload[] = [];
    for (const grant of activeSessionGrants()) {
      try {
        const walked = walkGrantedRoot(grant, { maxFiles: LIST_FILES_MAX });
        grants.push({
          // The label, falling back to the grant's id when it is empty —
          // `basename(realpath(dir))` is `""` for a drive or filesystem root,
          // and `${""}/${rel}` reads as an absolute path, which is the one
          // shape D3 says may never be inserted. `g1/results/x.csv` is a plain
          // relative path: the colon D3 rejected is what the win32 guard
          // denies, and there is none here.
          qualifier: grant.label.trim() === "" ? grant.id : grant.label,
          files: walked.files,
          excluded: {
            truncated: walked.truncated,
            byDefault: walked.excludedByDefault,
            byGitignore: walked.excludedByGitignore,
            bySkipDir: walked.excludedBySkipDir,
          },
        });
      } catch {
        // This grant contributes nothing; the others still do.
      }
    }

    let workspace: ContextRootPayload | undefined;
    try {
      const active = await paperInContext();
      if (active) {
        const all = await new VscodeWorkspace(active.root).listFiles();
        workspace = {
          files: all.slice(0, LIST_FILES_MAX),
          entry: active.entry,
          excluded: {
            truncated: all.length > LIST_FILES_MAX,
            // A FACT, not a guess: the workspace walk applies no deny-list at
            // all (ADR 0019), which is exactly what `list_files` reports here.
            byDefault: 0,
            // The gitignore and skip-dir figures are ABSENT rather than zero.
            // `VscodeWorkspace.listFiles` does skip `node_modules`, `dist` and
            // dot-directories — it simply never counts them — and writing `0`
            // would be the invented count A6 added the counters to eliminate.
            // `list_files` omits them for the same reason, in the same branch.
          },
        };
      }
    } catch {
      // An unreadable workspace leaves the grants standing, and vice versa.
    }

    postToWebview({
      type: "contextPaths",
      ...(workspace ? { workspace } : {}),
      grants,
    } satisfies HostToWebview);
  } catch {
    // Anything left (the post itself) leaves the previous set standing rather
    // than blanking the menu. The A0 P1 rule: discovery is best-effort and
    // never takes the panel down.
  } finally {
    contextPathsWalking = false;
    if (contextPathsAgain) {
      contextPathsAgain = false;
      void postContextPaths();
    }
  }
}

/**
 * Bounded log of what the host posted (test observability, A5). It retains
 * references to messages the host allocated anyway, but some of those are
 * large (a `transcriptReplay` carries a whole transcript), so the ceiling is
 * deliberately small — long enough for any single test's assertions, short
 * enough that a long-running window holds nothing meaningful.
 */
const postedToWebview: HostToWebview[] = [];
const POSTED_LOG_CAP = 200;

/** Build, cache, and push the Compile tab state; `reveal` switches the tab. */
function pushCompileState(reveal = false): CompileTabState {
  const state = computeCompileTabState();
  lastCompileTabState = state;
  postToWebview({
    type: "compileState",
    state,
    ...(reveal ? { reveal: true } : {}),
  } satisfies HostToWebview);
  return state;
}

/**
 * The entry the next blind panel will read (ADR 0064 §1), cached.
 *
 * `reviewPaperEntry()` is async — it stats the configured path and may run
 * discovery — and `pushReviewState` is called from a synchronous listener
 * (`onReviewChanged`). So the answer is resolved out of band and remembered,
 * and every push carries whatever the last resolution said. It is refreshed at
 * `ready`, whenever `lemmaria.paperEntry` changes, and after the picker runs;
 * a stale value therefore only survives until one of those happens.
 */
let nextPaperEntry = "";

/**
 * Re-resolve the next panel's entry and, if it moved, re-push the Review tab
 * so the launcher's *main file* line follows. Silent on failure: a workspace
 * that cannot be read is not a reason to break the tab.
 */
async function refreshNextPaperEntry(): Promise<void> {
  let resolved: string;
  try {
    resolved = (await reviewPaperEntry())?.entry ?? "";
  } catch {
    resolved = "";
  }
  if (resolved === nextPaperEntry) return;
  nextPaperEntry = resolved;
  pushReviewState(false);
}

/** Build, cache, and push the Review tab state; `reveal` switches the tab. */
function pushReviewState(reveal = false): ReviewTabState {
  const state = computeReviewTabState(nextPaperEntry);
  lastReviewTabState = state;
  postToWebview({
    type: "reviewState",
    state,
    ...(reveal ? { reveal: true } : {}),
  } satisfies HostToWebview);
  return state;
}

/**
 * ADR 0065 §3: push the detached panel's progress to the Review tab.
 *
 * A message of its own rather than a field on `reviewState`: the run is
 * rebuilt from the driver's frames and the state from the reviews the host
 * holds, and folding them together would re-send the whole findings list on
 * every seat chip.
 */
function pushReviewRun(): void {
  const run = currentReviewRun();
  postToWebview({
    type: "reviewRun",
    ...(run ? { run } : {}),
  } satisfies HostToWebview);
}

/** Generation guard: two in-flight store reads must not deliver out of order. */
let restorePointsGeneration = 0;

/**
 * ADR 0031: tell the webview which user bubbles can be branched at.
 *
 * E4 (ADR 0054) removed the second set this used to read and post beside that
 * one — `writingBranchPoints()`, the subset with file changes after it, which
 * the transcript used to pick ⟲ over ⑂. With one face there is no pair, so the
 * comment that used to explain why the two had to be delivered together is
 * gone with the hazard it described.
 *
 * E7 (ADR 0055) buys the per-branch-point `restorePlan` fold back — the cost
 * E4 recorded as a consequence of the deletion — because a NUMBER is what J1
 * asked for and a fold is what produces one. Still ONE message: the count
 * rides `rewindPoints` as a field, so nothing here has to be paired or ordered
 * and the generation guard below is unchanged. One `store.load` covers both
 * answers, so a push is strictly cheaper than the two loads and two messages
 * ADR 0031 shipped.
 */
function pushRestorePoints(): void {
  const generation = ++restorePointsGeneration;
  void (async () => {
    const points = await rewindPointsOf();
    if (generation !== restorePointsGeneration) return; // superseded
    postToWebview({
      type: "rewindPoints",
      points,
    } satisfies HostToWebview);
  })();
}

/**
 * A5: hand a freshly-loaded webview the transcript of the session already live
 * in this host — it does not open, reset or resume anything, and does nothing
 * when no session is active.
 *
 * The snapshot always MERGES into whatever the view already holds, because a
 * live event can land between the host reading it and this post arriving and
 * that item is never re-sent. ADR 0027 needed a second, REPLACING mode for a
 * branch move, where "in my fold but not in the snapshot" was the branch just
 * left; ADR 0057 retired it with the move — a rewind now switches sessions,
 * and a resume resets the panel before it replays, so there is nothing stale
 * left to clobber and no flag to get wrong.
 */
let replayGeneration = 0;

async function replayActiveTranscript(): Promise<void> {
  // Generation guard (the pushRestorePoints precedent): loading the snapshot
  // is async, and live session events keep flowing during the await. A stale
  // snapshot must never overwrite a newer one — and a snapshot that lost the
  // race to a second `ready` is simply dropped.
  const generation = ++replayGeneration;
  // A5 (reload survival): after a window reload this handshake races the
  // activation-time restore. Reading the snapshot first would find no active
  // session and leave the user on the welcome screen over a conversation that
  // was one await away from coming back.
  await activeSessionReady();
  const snapshot = await activeSessionSnapshot();
  if (!snapshot || generation !== replayGeneration) return;
  // The session can also CHANGE during the load (New Session, or resuming a
  // different one). The generation counter cannot see that, so check the id:
  // posting session A's transcript into a fresh thread would resurrect a
  // conversation the user just left.
  if (snapshot.sessionId !== activeSessionId()) return;
  postToWebview({
    type: "transcriptReplay",
    sessionId: snapshot.sessionId,
    items: snapshot.items,
    // A task can be mid-flight during a reload; the webview needs this to keep
    // Stop (◼) and any pending approval card live.
    busy: isTaskInFlight(),
  } satisfies HostToWebview);
  // The `ready` handler pushed the grant chips synchronously, i.e. possibly
  // BEFORE the reload restore finished and re-hydrated them from the transcript
  // — re-push, or a restored session serves granted reads with no chip to show
  // for them (an active read permission must never be invisible, ADR 0019).
  // Same reason `resumeSessionById` re-pushes after its own reset.
  postToWebview({
    type: "grantsState",
    grants: activeSessionGrants(),
  } satisfies HostToWebview);
  // The ring was blank after a reload: occupancy is pushed on turn boundaries,
  // and the reloaded view missed every one of them.
  if (snapshot.contextUsage) {
    postToWebview({
      type: "contextUsage",
      ...snapshot.contextUsage,
    } satisfies HostToWebview);
  }
  // The readout is pushed on turn boundaries, which a reloaded view missed —
  // without this it reads blank over a session that has already spent.
  await pushSessionCost();
}

/**
 * A5: push THIS session's spend (folded from its persisted turn events) to the
 * composer readout. Tokens always; dollars only when the model priced them —
 * a BYOK or local model shows tokens alone rather than a fabricated $0.00.
 */
/** Generation + session guard: the fold is a disk read, and the thread can
 *  change under it. Without the scope check a read started for session A
 *  finishes after New Session (or a resume) and posts A's spend into the fresh
 *  transcript — a readout attributing one conversation's money to another. */
let sessionCostGeneration = 0;

async function pushSessionCost(): Promise<void> {
  const generation = ++sessionCostGeneration;
  const scope = activeSessionId();
  const usage = await activeSessionUsage();
  if (generation !== sessionCostGeneration) return; // superseded
  if (activeSessionId() !== scope) return; // the thread changed mid-read
  postToWebview({
    type: "sessionCost",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    // A mixed session (some calls priced, some not) must not present its
    // partial dollar sum as the whole bill — the readout says so.
    ...(usage.unpricedCalls > 0 ? { unpricedCalls: usage.unpricedCalls } : {}),
  } satisfies HostToWebview);
}

/** Recompute the selection and push it to the live webview (if any). */
function pushSelection(): void {
  const state = computeSelectionState();
  lastPushedSelection = state;
  postToWebview({
    type: "selection",
    state,
  } satisfies HostToWebview);
}

/** Build a locale-resolved C2 detail line from the structured result. */
function describeC2Detail(r: CitationResult, endpoints: string[]): string {
  const zh = currentLocale() === "zh";
  const changes = (r.correction?.changes ?? [])
    .map((c) => `${c.field}: ${c.from ?? "—"} → ${c.to}`)
    .join(" · ");
  switch (r.status) {
    case "ok":
      return zh ? `${r.source} · 元数据一致` : `${r.source} · metadata matches`;
    case "metadata_mismatch":
      return changes || (zh ? "元数据不一致" : "metadata differs");
    case "preprint_superseded":
      return zh
        ? `预印本已被正式版取代 · ${changes}`
        : `superseded by published version · ${changes}`;
    case "not_found":
      return zh
        ? `在 ${endpoints.join(", ")} 中未找到匹配`
        : `no match in ${endpoints.join(", ")}`;
    default: // "unverified"
      return zh
        ? "在线核对未能完成（超时/网络）"
        : "online check could not complete (timeout / network)";
  }
}

/**
 * The init payload the host pushes on `ready`: the four wired quick actions
 * (id/label/tier resolved from their definitions — invariant: tier comes from
 * `routing.level`, not a hardcoded table), the Writing-role model display, and
 * the budget ceilings, all in the editor locale.
 */
function computeInitState(): {
  locale: "en" | "zh";
  quickActions: QuickActionInfo[];
  model: ModelInfo;
  budget: BudgetInfo;
} {
  const quickActions: QuickActionInfo[] = [];
  for (const id of Object.keys(ACTION_COMMAND_BY_ID)) {
    const def = loadedActions.find((a) => a.definition.id === id)?.definition;
    if (!def) continue;
    quickActions.push({
      id,
      label: localeLabel(def.name, id),
      tier: def.routing?.level === "L1" ? "L1" : "L0",
    });
  }
  // The chip must name the model that will RUN, and what runs is the store's
  // active model — `getModel` reads `store.active()` and nothing else. This
  // line used to read the legacy `lemmaria.model.model` setting, which is
  // WRONG in the ordinary case rather than in an edge one: the one-time
  // migration (`model.ts`) deliberately RETAINS that setting as a rollback
  // net, so it keeps naming whatever model was configured before the store
  // existed, forever, while every model the user adds afterwards changes only
  // the store. The chip therefore opened on a stale name and silently
  // corrected itself the first time the Models tab was visited (which pushes
  // `modelsState`) — the bug the operator reported at the R3 gate-review.
  const modelName = modelStore()?.active()?.model ?? "";
  const ceilings = ceilingsFromSettings();
  return {
    locale: currentLocale(),
    quickActions,
    model: { name: modelName, configured: modelName !== "" },
    budget: {
      maxTokens: ceilings.maxTokens ?? 16000,
      maxIterations: ceilings.maxIterations ?? 8,
    },
  };
}

/** The SelectionState the host pushes for the active editor (U1). */
function computeSelectionState(): SelectionState {
  const editor = vscode.window.activeTextEditor;
  const empty: SelectionState = {
    docKind: null,
    hasSelection: false,
    file: "",
    startLine: 0,
    endLine: 0,
  };
  if (!editor || editor.document.uri.scheme !== "file") return empty;
  const name = editor.document.fileName;
  const docKind = /\.tex$/i.test(name)
    ? "tex"
    : /\.md$/i.test(name)
      ? "md"
      : null;
  if (docKind === null) return empty;
  const sel = editor.selection;
  const hasSelection = !sel.isEmpty;
  return {
    docKind,
    hasSelection,
    file: path.basename(name),
    startLine: hasSelection ? sel.start.line + 1 : 0,
    endLine: hasSelection ? sel.end.line + 1 : 0,
  };
}

let current: vscode.WebviewView | undefined;
let readyResolvers: Array<() => void> = [];
let readyFired = false;
let echoResolver: ((text: string) => void) | undefined;

/**
 * T2 (ADR 0043 §D2): pending probe requests, by id.
 *
 * A `Map` rather than `echoResolver`'s single slot, and the difference is not
 * cosmetic: with one slot a second in-flight request overwrites the first,
 * which then hangs to its own timeout, and a stray reply resolves whichever
 * request happens to be pending. The echo seam gets away with it because
 * nothing sends two echoes; a protocol meant to be used several times per test
 * does not.
 */
const probeResolvers = new Map<
  string,
  { resolve: (r: ProbeResult[]) => void }
>();
let probeSeq = 0;

/**
 * The Models tab state (revised U3): the user's configured model list (from the
 * ModelStore), each model's key presence (SecretStorage — only a boolean crosses
 * to the webview), the provider presets for the add-model form, per-model session
 * usage, the review roles, and the persisted today/total cost buckets. The
 * active model drives Writing; R9 lit the Reviewers and Cross-review cards.
 */
async function computeModelsState(): Promise<ModelsState> {
  const store = modelStore();
  const activeId = store?.activeId();
  const models: ConfiguredModelInfo[] = [];
  for (const m of store?.list() ?? []) {
    // The OS keyring can reject (e.g. a Linux secret-service hiccup); this runs
    // on fire-and-forget push paths, so degrade honestly to "no key" instead of
    // an unhandled rejection that silently drops the push.
    let keyPresent = false;
    try {
      const k = extContext
        ? await extContext.secrets.get(modelKeySecret(m.id))
        : undefined;
      keyPresent = k !== undefined && k !== "";
    } catch {
      keyPresent = false;
    }
    models.push({
      id: m.id,
      provider: m.provider,
      providerLabel: providerPreset(m.provider)?.label ?? m.provider,
      protocol: m.protocol,
      endpoint: m.endpoint,
      model: m.model,
      label: m.label && m.label !== "" ? m.label : m.model,
      keyPresent,
      active: m.id === activeId,
      // V3 (ADR 0080 §6): the override, and what the table would say without
      // it. Both travel, so the control can render *auto (yes)* / *auto (no)*
      // without the webview ever seeing the table.
      ...(m.imageInput !== undefined ? { imageInput: m.imageInput } : {}),
      imageInputDefault: imageInputFor(m.model),
    });
  }
  const providers: ProviderInfo[] = PROVIDER_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    defaultEndpoint: p.defaultEndpoint,
    keyRequired: p.keyRequired,
    suggestedModels: [...p.suggestedModels],
  }));
  const cost = currentCostState();
  const summary = (b?: {
    inputTokens: number;
    outputTokens: number;
    usd: number;
    unpricedRuns: number;
  }): CostSummaryInfo => ({
    inputTokens: b?.inputTokens ?? 0,
    outputTokens: b?.outputTokens ?? 0,
    usd: b?.usd ?? 0,
    unpricedRuns: b?.unpricedRuns ?? 0,
  });
  return {
    models,
    providers,
    activeModelId: activeId,
    // R9: the PRUNING read (`get()`), so a model the user just deleted never
    // reaches the card as a selected option it cannot draw — and so the state
    // is right regardless of which `ModelStore.onDidChange` subscriber runs
    // first (the persisted prune is the other one).
    reviewRoles: reviewRolesStore()?.get() ?? DEFAULT_REVIEW_ROLES,
    maxReviewers: MAX_FAN_OUT,
    session: sessionUsageRows(),
    today: { date: cost?.today.date ?? "", ...summary(cost?.today) },
    total: summary(cost?.total),
  };
}

/** Build, cache, and push the Models state to the live webview (if any). */
async function pushModelsState(): Promise<ModelsState> {
  const state = await computeModelsState();
  lastModelsState = state;
  postToWebview({
    type: "modelsState",
    state,
  } satisfies HostToWebview);
  return state;
}

function emptyVenueState(): VenueState {
  return { available: false, file: "", detectedOptions: [], checklist: [] };
}

/**
 * Venue-tab state (U4): detected \documentclass → library venue + the honest
 * pre-submission checklist. Side-effect-free (C1 is offline; no network, no
 * diagnostics) — safe to compute on tab open.
 */
async function computeVenueState(): Promise<VenueState> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || !extContext) return emptyVenueState();
  const c1 = await computeCitationC1(uri);
  if (!c1.available) return emptyVenueState();

  // V4 (ADR 0081 §2): the match is shared with the review's venue fact, so
  // the two cannot name different venues for one paper.
  const workspace = new VscodeWorkspace(c1.root, c1.entry);
  const found = await matchVenueForEntry(extContext, workspace, c1.entry);
  if (!found) return emptyVenueState();
  const { adapter, detected, matched } = found;
  const state: VenueState = {
    available: true,
    file: path.basename(c1.entry),
    detectedOptions: detected?.options ?? [],
    checklist: [],
    ...(detected !== undefined ? { detectedClass: detected.name } : {}),
  };
  if (!detected || !matched) return state;

  const m = matched.manifest;
  state.venue = {
    id: m.id,
    label: localeLabel(m.name, m.id),
    engine: m.engine,
    ...(m.bibstyle !== undefined ? { bibstyle: m.bibstyle } : {}),
    ...(m.anonymity !== undefined ? { anonymity: m.anonymity } : {}),
    ...(m.page_limit !== undefined ? { pageLimit: m.page_limit } : {}),
  };
  const bibliographyStyle =
    "bibliographyStyle" in adapter ? adapter.bibliographyStyle() : undefined;
  // Fail the row only on error-severity C1 issues (undefined-citation,
  // duplicate-key); orphans are info. No bib at all → unknown, not a fake pass.
  const citationErrors =
    c1.bibFiles.length === 0
      ? undefined
      : c1.consistency.filter((w) => w.severity === "error").length;
  const pages = lastCompilePages(uri.fsPath);
  state.checklist = computeVenueChecklist({
    manifest: m,
    detected,
    ...(bibliographyStyle !== undefined ? { bibliographyStyle } : {}),
    ...(citationErrors !== undefined ? { citationErrors } : {}),
    ...(pages !== undefined ? { pages } : {}),
  }).map(toVenueRowInfo);
  return state;
}

/** Harness checklist row → the protocol's display facts. */
function toVenueRowInfo(row: VenueChecklistRow): VenueChecklistRowInfo {
  const info: VenueChecklistRowInfo = { id: row.id, status: row.status };
  if (row.id === "anonymity") info.expected = row.required;
  if (row.id === "page_limit") {
    if (row.limit) info.expected = `${row.limit.value} ${row.limit.unit}`;
    if (row.pages !== undefined) info.actual = String(row.pages);
  }
  if (row.id === "bibstyle") {
    if (row.expected !== undefined) info.expected = row.expected;
    if (row.detected !== undefined) info.actual = row.detected;
  }
  if (row.id === "citations" && row.errors !== undefined)
    info.count = row.errors;
  return info;
}

async function pushVenueState(): Promise<VenueState> {
  const state = await computeVenueState();
  lastVenueState = state;
  postToWebview({
    type: "venueState",
    state,
  } satisfies HostToWebview);
  return state;
}

/**
 * Run C1 over `uri`, refresh the module state it feeds, and push the result.
 *
 * ONE function, because CITE-1's fix gave it a second caller. The Run-check
 * handler needs a fresh C1 (the cache it used to trust went stale the moment a
 * user hand-edited the `.bib`), and if it recomputed C1 without pushing it, the
 * two halves of the Citations tab would disagree after every re-check: the C2
 * rows correct, the entry count / entry keys / offline issues above them still
 * pre-edit, from the very read that had just happened. Found by D4's review.
 *
 * C1 is side-effect-free — no diagnostics, no network egress — which is what
 * makes it safe on tab open and cheap to repeat here.
 */
async function refreshCitationC1(
  uri: vscode.Uri | undefined,
): Promise<CitationsC1State> {
  const c1 = await computeCitationC1(uri ?? vscode.Uri.file(""));
  lastCitationRoot = c1.available ? c1.root : undefined;
  lastCitationUri = c1.available ? uri : undefined;
  lastCitationEntries = c1.entries;
  const state: CitationsC1State = {
    available: c1.available,
    bibFiles: c1.bibFiles,
    entryCount: c1.entryCount,
    citedKeyCount: c1.citedKeyCount,
    entryKeys: c1.entryKeys,
    endpoints: citationEndpoints(),
    issues: c1.consistency.map(
      (w): CitationIssue => ({
        code: w.code,
        severity: w.severity,
        message: w.message,
        file: w.file,
        line: w.line ?? 0,
      }),
    ),
  };
  postToWebview({ type: "citationsC1", state } satisfies HostToWebview);
  return state;
}

/**
 * Translate a webview intent into the existing command/edit plumbing. Every
 * edit still lands in the M4 Accept-gated diff (invariant 3); the webview never
 * writes. Unknown/shell action ids are ignored (the webview also disables them).
 */
async function handleWebviewMessage(msg: WebviewToHost): Promise<unknown> {
  if (msg.type === "runQuickAction") {
    const command = ACTION_COMMAND_BY_ID[msg.actionId];
    if (!command) return undefined;
    return vscode.commands.executeCommand(command);
  }
  if (msg.type === "openSettings") {
    // A5: filtered to this extension — the settings the header button implies.
    return vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:lemmaria.lemmaria",
    );
  }
  if (msg.type === "copyText") {
    // ADR 0040: the Markdown code block's Copy affordance. Nothing reaches the
    // workspace, so invariant 3 is not in play — this is the clipboard, and the
    // host owns it because a webview's `navigator.clipboard` is gated on a
    // permission the webview host controls.
    return vscode.env.clipboard.writeText(msg.text);
  }
  if (msg.type === "composerSend") {
    // A0 (ADR 0014): the composer is the session entry point. Blank guard HERE
    // (undefined = truly nothing happened), the old composerEdit discipline.
    if (!extContext || msg.text.trim() === "") return undefined;
    const outcome = handleComposerSend(extContext, msg.text, postSessionEvent);
    // A5: the first message of a thread creates the session, and every task
    // moves its updatedAt — both change what the Sessions view should show.
    // Refresh only AFTER the task settles: the session is created inside
    // handleComposerSend, so an eager refresh had nothing new to show anyway.
    void outcome.finally(() => refreshSessionsView());
    return outcome;
  }
  if (msg.type === "rewindFork") {
    // E6 (D8, ADR 0058 §4): the ⟲ menu's fork-only arm. It writes no user
    // file, so invariant 3 asks nothing of it and the click IS the action —
    // no card, no nonce. The sink registered at activation carries the fork to
    // the live transcript, so this and the palette command behave identically.
    if (!extContext) return undefined;
    return rewindFromMessage(extContext, msg.messageId, "fork");
  }
  if (msg.type === "rewindPreview") {
    // Step one of a restoring arm: compute the plan, hold it under a nonce,
    // and push it back to be NAMED before anything is written (invariant 3).
    // Nothing here touches a file.
    return previewRewind(msg.messageId, msg.withFork).then((preview) => {
      // ALWAYS answer (E6 code review). A refusal that says nothing leaves the
      // popover's three arms disabled with no way forward but Esc, and ⟲
      // renders on every user bubble whatever the task state — so "click ⟲
      // mid-task, pick an arm" is an ordinary click, not an edge case.
      postToWebview(
        (preview === undefined
          ? { type: "rewindPreviewRefused", messageId: msg.messageId }
          : { type: "rewindConfirm", ...preview }) satisfies HostToWebview,
      );
      return undefined;
    });
  }
  if (msg.type === "forkSession") {
    // E6 (D10): `/fork [name]`. The busy gate lives HERE and not in the
    // composer's parser: the webview posts this instead of `composerSend`
    // whatever the task state, which is what keeps `/fork` from reaching the
    // model as steering text, and the host is the one place that knows
    // whether a task is running. One home for the rule, as with every other
    // verb the menu offers.
    if (isTaskInFlight()) {
      void vscode.window.showInformationMessage(
        tr(currentLocale(), "forkBusy"),
      );
      return undefined;
    }
    return forkSessionAtEnd(msg.name, (childId) =>
      resumeSessionById(childId),
    ).then((childId) => {
      if (childId === undefined) return undefined;
      refreshSessionsView();
      void vscode.window.showInformationMessage(
        tr(currentLocale(), "forkedToNewSession"),
      );
      return undefined;
    });
  }
  if (msg.type === "rewindDecision") {
    // Step two. An unknown nonce is dropped silently — superseded, already
    // answered, or declined by a card the transcript's own re-render closed.
    if (!extContext) return undefined;
    return decideRewind(extContext, msg.nonce, msg.confirmed);
  }
  if (msg.type === "interruptTask") {
    // A1a: the composer's Stop affordance aborts the live task; the loop
    // answers with an interrupted item + task.completed (ADR 0015).
    return interruptSessionTask();
  }
  if (msg.type === "newSession") {
    // A1a: the header ＋ button — same fresh-thread operation as the
    // `lemmaria.newSession` command (Codex `/new` / Claude Code `/clear`).
    newSession();
    return undefined;
  }
  if (msg.type === "resumeSession") {
    // A2 (ADR 0021): the header ⟲ button — same quick-pick as the
    // `lemmaria.resumeSession` command.
    return pickAndResumeSession();
  }
  if (msg.type === "compactSession") {
    // E2 (ADR 0049): the composer menu's `/compact` verb — the SAME call the
    // `lemmaria.compactSession` command makes. Its refusals (no session, a task
    // in flight, no model resolved) stay in `compactActiveSession`, where they
    // are already localized; the menu carries no second opinion about when a
    // verb is allowed.
    return extContext
      ? compactActiveSession(extContext, postSessionEvent)
      : undefined;
  }
  if (msg.type === "requestContextPaths") {
    // E3 (ADR 0052): the `@` menu opened, so re-walk. A file created in the
    // editor is invisible to the set walked at `ready`, which is the one way a
    // path list goes stale where a skill catalogue does not. One walk per open
    // — never one per keystroke, which is what keeps `refreshComposerMenu`
    // synchronous (E2's D4).
    return postContextPaths();
  }
  if (msg.type === "editDecisions") {
    // A1b (ADR 0016): the webview approves/rejects the pending proposal batch.
    return submitEditDecisions(msg.itemId, msg.decisions);
  }
  if (msg.type === "scriptDecision") {
    // A4b (ADR 0020): the webview approves/denies the pending run_script.
    return submitScriptDecision(
      msg.itemId,
      {
        approve: msg.approve,
        ...(msg.note !== undefined ? { note: msg.note } : {}),
      },
      msg.alwaysAllow,
    );
  }
  if (msg.type === "setEditPolicy") {
    // A1b: the composer permission selector switches the session's edit policy.
    setEditPolicy(msg.policy);
    postToWebview({
      type: "editPolicy",
      policy: msg.policy,
    } satisfies HostToWebview);
    return undefined;
  }
  if (msg.type === "showEditDiff") {
    // A1b: the on-demand read-only diff for one file of a proposal.
    await showSessionEditDiff(msg.itemId, msg.file);
    return undefined;
  }
  if (msg.type === "addGrant") {
    // A4 (ADR 0019): the ＋ chip opens the same explicit picker as the palette
    // command — one grant flow, whatever the entry point.
    return vscode.commands.executeCommand("lemmaria.grantFolder");
  }
  if (msg.type === "revokeGrant") {
    if (!extContext) return undefined;
    return revokeGrant(extContext, msg.id);
  }
  if (msg.type === "requestCitations") {
    return refreshCitationC1(vscode.window.activeTextEditor?.document.uri);
  }
  if (msg.type === "revealCitation") {
    if (!lastCitationRoot || msg.file === "") return undefined;
    const target = vscode.Uri.file(path.join(lastCitationRoot, msg.file));
    const doc = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(doc);
    const line = Math.max(0, msg.line - 1);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(
      new vscode.Range(pos, pos),
      vscode.TextEditorRevealType.InCenter,
    );
    return target;
  }
  if (msg.type === "runCitationCheck") {
    // CITE-1 (D4): re-read the bib FIRST, so the online check always verifies
    // what is on disk. The cache this used to trust is refreshed only on tab
    // activation, on a file switch, and by `refreshAdoptedCitation` after an
    // Accept — and nothing invalidates it when the user edits the `.bib`, so a
    // hand-edit after an Accept was invisible and C2 re-verified text that no
    // longer existed. C1 is offline and holds no state of its own (a fresh
    // `VscodeWorkspace` and adapter per call), so this is nearly free against
    // the network C2 is about to spend — and it is already paid on every tab
    // activation. A `.bib` watcher would be the thorough version; it is not
    // built, because one re-read in the one handler that was stale IS the
    // defect, and a watcher adds a generation-guard failure mode for nothing
    // this milestone needs.
    // Deliberately `lastCitationUri` only, NOT a fall back to the active
    // editor: the tab shows one paper, and binding to whatever happens to be
    // focused would let a later `adoptCitation` write a `.bib` under a root the
    // user is not looking at. When it is undefined there is nothing to refresh,
    // because the last C1 was unavailable.
    if (lastCitationUri) await refreshCitationC1(lastCitationUri);
    // C2 network egress happens ONLY here (explicit Run check) and in the
    // single-key re-verify after an adopted correction is accepted; metadata only.
    const c2 = await runCitationC2(lastCitationEntries);
    lastC2Results = c2.results;
    return pushCitationsC2(
      lastCitationEntries.length > 0 ? "checked" : "skipped",
      c2.endpoints,
    );
  }
  if (msg.type === "adoptCitation") {
    if (!lastCitationRoot) return undefined;
    const result = lastC2Results.find((r) => r.key === msg.key && r.correction);
    if (!result) return undefined;
    const diffUri = await adoptCitationCorrection(lastCitationRoot, result);
    // The diff's query carries the real .bib uri (diff-review's virtualUriFor)
    // — remember it so the Accept event triggers a re-check of this key.
    if (diffUri) pendingAdoptKeys.set(diffUri.query, msg.key);
    return diffUri;
  }
  if (msg.type === "requestModels") {
    return pushModelsState();
  }
  if (msg.type === "setActiveModel") {
    await modelStore()?.setActive(msg.id);
    return pushModelsState();
  }
  if (msg.type === "setReviewRoles") {
    // R9: the whole value, every time. The store clamps the count at this
    // edge, so what comes back in the push is what will actually run.
    await reviewRolesStore()?.set({
      reviewers: msg.reviewers,
      synthesis: msg.synthesis,
      verifier: msg.verifier,
      pdfReviewer: msg.pdfReviewer,
    });
    return pushModelsState();
  }
  if (msg.type === "addModel") {
    // The webview sends provider + model + (optional) endpoint + key; the host
    // resolves protocol + the default endpoint from the preset. The key is
    // stored in SecretStorage and never echoed back (only keyPresent crosses).
    const preset = providerPreset(msg.provider);
    const protocol = preset?.protocol ?? "anthropic";
    const endpoint =
      msg.endpoint !== "" ? msg.endpoint : (preset?.defaultEndpoint ?? "");
    await modelStore()?.add(
      {
        provider: msg.provider,
        protocol,
        endpoint,
        model: msg.model,
        label: msg.label,
      },
      msg.apiKey,
    );
    return pushModelsState();
  }
  if (msg.type === "removeModel") {
    await modelStore()?.remove(msg.id);
    return pushModelsState();
  }
  if (msg.type === "updateModelKey") {
    await modelStore()?.updateKey(msg.id, msg.apiKey);
    return pushModelsState();
  }
  if (msg.type === "setModelImageInput") {
    // "auto" clears the override, returning the row to the prefix table.
    await modelStore()?.setImageInput(
      msg.id,
      msg.value === "auto" ? undefined : msg.value === "yes",
    );
    return pushModelsState();
  }
  if (msg.type === "requestVenue") {
    return pushVenueState();
  }
  if (msg.type === "requestReview") {
    // ADR 0064 §1: opening the tab is the moment the launcher is about to be
    // read, so re-resolve the entry here as well as at `ready`. This is what
    // covers the case the config listener cannot — `reviewPaperEntry()` roots
    // its discovery at `sessionEditRoot()`, which follows the focused paper's
    // FOLDER, so in a multi-root workspace the answer moves without any
    // setting changing. Out of band, and a second push only if it moved.
    void refreshNextPaperEntry();
    return pushReviewState();
  }
  if (msg.type === "revealAnnotation") {
    return vscode.commands.executeCommand(
      "lemmaria.revealAnnotation",
      msg.index,
      ...(msg.which !== undefined ? [msg.which] : []),
    );
  }
  if (msg.type === "adoptSuggestion") {
    // Adopt re-enters the ordinary Accept-gated diff (invariant 3).
    return vscode.commands.executeCommand(
      "lemmaria.adoptSuggestion",
      msg.index,
    );
  }
  if (msg.type === "ignoreAnnotation") {
    // Ignore is pure triage state (no edit). The flip fires onReviewChanged,
    // whose listener re-pushes the tab — return that freshly-cached state.
    ignoreAnnotation(msg.index);
    return lastReviewTabState;
  }
  if (msg.type === "resolveAnnotation") {
    // ADR 0063 §3: Resolve is no longer triage — it hands the concern to the
    // assistant. Two halves, in this order: mark it, so the tab has already
    // moved the row by the time the task's first frame arrives, then send the
    // prompt through `handleComposerSend`, the SAME entry point a typed
    // message takes. Going through that one function is the point — it is
    // where session creation, the busy/steering rule and the Sessions-view
    // refresh live, and a second path into the session would be a second place
    // for all three to be got wrong.
    //
    // Invariant 3 is untouched: this sends a message, and anything the
    // assistant proposes off the back of it goes through the same approval as
    // any other edit. Nothing here writes to the workspace.
    if (!extContext || msg.prompt.trim() === "") return undefined;
    handAnnotationToAssistant(msg.index);
    const outcome = handleComposerSend(
      extContext,
      msg.prompt,
      postSessionEvent,
    );
    void outcome.finally(() => refreshSessionsView());
    return outcome;
  }
  if (msg.type === "selectReview") {
    // ADR 0062 §1: a different review of this window. Also pure state.
    selectReview(msg.id);
    return lastReviewTabState;
  }
  if (msg.type === "choosePaperEntry") {
    // ADR 0062 §2: the header's affordance runs the ordinary command, so the
    // palette and the tab reach the same picker and cannot drift.
    return vscode.commands.executeCommand("lemmaria.selectPaperEntry");
  }
  if (msg.type === "runReviewPanel") {
    // ADR 0065 §2: the launcher starts a DETACHED panel. It used to send the
    // literal `/review` through `handleComposerSend`, which made the panel a
    // task of the active chat — the coupling this milestone removed. Typing
    // `/review` now reaches the same function, because §4 intercepts it at the
    // top of `handleComposerSend`, so the two routes still meet at one
    // implementation and the grammar still has one home.
    //
    // ADR 0064 §3's steering exception is GONE with the path that needed it:
    // a review is no longer a message, so it can no longer become steering,
    // and `isTaskInFlight()` is not consulted here. The refusal that remains
    // is `startReviewRun`'s own — one panel at a time.
    if (!extContext) return undefined;
    return startReviewRun(extContext);
  }
  if (msg.type === "runReviewPdf") {
    // V4 (ADR 0081 §7): the launcher's second button — the `/review-pdf` a
    // user would type, reaching the same detached run by the same function.
    if (!extContext) return undefined;
    return startReviewRun(extContext, undefined, { pdfOnly: true });
  }
  if (msg.type === "stopReview") {
    // ADR 0065 §3: the tab's Stop, which is NOT the composer's. The panel is
    // not this conversation's task, so `interruptSessionTask` would stop the
    // wrong thing — and while a chat runs beside it, would stop the chat.
    stopReviewRun();
    return undefined;
  }
  if (msg.type === "requestCompile") {
    return pushCompileState();
  }
  if (msg.type === "revealFinding") {
    return vscode.commands.executeCommand("lemmaria.revealFinding", msg.index);
  }
  if (msg.type === "fixFinding") {
    // A fix re-enters the ordinary Accept-gated diff (invariant 3) — and
    // Accepting it re-runs nothing (ADR 0013).
    return vscode.commands.executeCommand("lemmaria.fixFinding", msg.index);
  }
  if (msg.type === "fixAllFindings") {
    return vscode.commands.executeCommand("lemmaria.fixAllFindings");
  }
  if (msg.type === "ignoreFinding") {
    // Ignore is pure triage state (no edit). The flip fires onCompileChanged,
    // whose listener re-pushes the tab — return that freshly-cached state.
    ignoreFinding(msg.index);
    return lastCompileTabState;
  }
  if (msg.type === "newFromVenue") {
    // Fire-and-forget: the command runs its own interactive picker + progress
    // UI; the webview only needs to know the intent was routed.
    void vscode.commands.executeCommand("lemmaria.newFromVenue");
    return "lemmaria.newFromVenue";
  }
  return undefined;
}

/** Build + push the C2 display state from the cached results. */
function pushCitationsC2(
  status: CitationsC2State["status"],
  endpoints: string[],
): CitationsC2State {
  const state: CitationsC2State = {
    status,
    results: lastC2Results.map(
      (r): CitationKeyResult => ({
        key: r.key,
        status: r.status,
        source: r.source,
        detail: describeC2Detail(r, endpoints),
        hasCorrection: r.correction !== undefined,
      }),
    ),
    endpoints,
  };
  lastC2State = state;
  postToWebview({
    type: "citationsC2",
    state,
  } satisfies HostToWebview);
  return state;
}

/**
 * After an adopted correction is accepted (written to the .bib), re-read the
 * paper and re-verify ONLY that key, so the tab's status flips instead of
 * keeping the stale mismatch. The single-key lookup is the tail of the user's
 * explicit Run check → Apply correction → Accept chain (metadata only), not a
 * new egress surface.
 */
async function refreshAdoptedCitation(realUri: vscode.Uri): Promise<void> {
  const key = pendingAdoptKeys.get(realUri.toString());
  if (!key) return;
  pendingAdoptKeys.delete(realUri.toString());
  if (!lastCitationUri) return;
  const c1 = await computeCitationC1(lastCitationUri);
  if (!c1.available) return;
  lastCitationRoot = c1.root;
  lastCitationEntries = c1.entries;
  const entry = c1.entries.find((e) => e.key === key);
  if (!entry) return;
  const c2 = await runCitationC2([entry]);
  const updated = c2.results[0];
  if (!updated) return;
  lastC2Results = lastC2Results.map((r) => (r.key === key ? updated : r));
  pushCitationsC2("checked", c2.endpoints);
}

/**
 * A1a: start a fresh thread — the ONE implementation behind both the
 * `lemmaria.newSession` command and the header ＋ button (`newSession`
 * message). Aborts any live task, drops the active session, clears the
 * webview transcript (Codex `/new` / Claude Code `/clear`).
 */
function newSession(): void {
  startNewSession();
  postToWebview({
    type: "sessionReset",
  } satisfies HostToWebview);
  // A5: the previous session stops being the active row (it stays listed).
  refreshSessionsView();
}

/**
 * Test seam (A2), the `setApiKeyPromptForTests` precedent: replaces the resume
 * quick-pick so an ext-host test can drive the REAL inbound router — the A1a
 * lesson that a button can be dead while a handler-level test stays green.
 */
let sessionPicker:
  | ((choices: { id: string; label: string }[]) => string | undefined)
  | undefined;

export function setSessionPickerForTests(
  picker?: (choices: { id: string; label: string }[]) => string | undefined,
): void {
  sessionPicker = picker;
}

/** The session event sink for the live webview (the composerSend shape). */
function postSessionEvent(event: SessionEvent): void {
  postToWebview({
    type: "sessionEvent",
    event,
  } satisfies HostToWebview);
}

/**
 * A2 (ADR 0021): the ONE resume flow behind both `lemmaria.resumeSession` and
 * the header ⟲ button — a bare quick-pick over the persisted sessions. A5
 * builds the real Sessions view; A1a's bare New Session command is the
 * precedent for shipping the engine's affordance as a command first.
 */
async function pickAndResumeSession(): Promise<void> {
  if (!extContext) return;
  const zh = currentLocale() === "zh";
  if (refuseResumeWhileBusy()) return;
  const sessions = await listSessions(extContext);
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(
      zh
        ? "Lemmaria：还没有可恢复的会话。"
        : "Lemmaria: no saved sessions yet.",
    );
    return;
  }
  const choices = sessions.map(({ meta }) => ({
    label: meta.title,
    description: new Date(meta.updatedAt).toLocaleString(
      zh ? "zh-CN" : "en-US",
    ),
    id: meta.id,
  }));
  const pickedId = sessionPicker?.(choices);
  const picked = sessionPicker
    ? choices.find((c) => c.id === pickedId)
    : await vscode.window.showQuickPick(choices, {
        title: zh ? "恢复一个会话" : "Resume a session",
        placeHolder: zh ? "选择要继续的会话" : "Pick the session to continue",
      });
  if (!picked) return;
  await resumeSessionById(picked.id);
}

/**
 * Resuming while a task runs would misroute the user's next message into the
 * dying task's steering queue (A2 review) — refuse the way Compact Session
 * does. Returns true when the caller must stop.
 */
function refuseResumeWhileBusy(): boolean {
  if (!isTaskInFlight()) return false;
  void vscode.window.showWarningMessage(
    currentLocale() === "zh"
      ? "Lemmaria：任务进行中，请先停止（◼）再恢复其他会话。"
      : "Lemmaria: stop the running task (◼) before resuming another session.",
  );
  return true;
}

/**
 * A5: THE resume operation — one implementation behind every entry point (the
 * Sessions view row, the ⟲ header button's quick-pick, the palette command), so
 * a second path cannot drift from it (the A1a inbound-allowlist lesson).
 */
export async function resumeSessionById(id: string): Promise<boolean> {
  if (!extContext) return false;
  if (refuseResumeWhileBusy()) return false;
  // Load FIRST, then clear: a failed load used to leave the user with a warning
  // over an empty panel, having thrown away the transcript they still had.
  // `resumeSession` replays through `postEvent`, so the reset must land before
  // those events — hence the deferred sink below rather than an early reset.
  const replayed: SessionEvent[] = [];
  const meta = await resumeSession(extContext, id, (event) => {
    replayed.push(event);
  });
  if (meta) {
    postToWebview({ type: "sessionReset" } satisfies HostToWebview);
    for (const event of replayed) postSessionEvent(event);
    // `resumeSession` pushes grants + restore points SYNCHRONOUSLY, before it
    // returns — i.e. before the reset above, which clears both in the webview.
    // Re-push them, or a resumed session shows no granted-folder chips while
    // the host still serves those grants to the model (an active read
    // permission must never be invisible — ADR 0019).
    postToWebview({
      type: "grantsState",
      grants: activeSessionGrants(),
    } satisfies HostToWebview);
    // The permission pill needs the same treatment, and ADR 0057 is what made
    // it urgent: `resetTranscript()` sets the webview's copy back to `review`,
    // and a REWIND now goes through this resume with the host's policy
    // deliberately preserved (D10). Without this push a writer in `auto_apply`
    // gets a host that applies without asking and a composer that says it will
    // ask — the misreport D10 exists to prevent, one layer up. The `ready`
    // handshake is the only other producer, and a resume is not one.
    postToWebview({
      type: "editPolicy",
      policy: currentEditPolicy(),
    } satisfies HostToWebview);
    pushRestorePoints();
  }
  if (!meta) {
    void vscode.window.showWarningMessage(
      currentLocale() === "zh"
        ? "Lemmaria：该会话无法读取。"
        : "Lemmaria: that session could not be read.",
    );
    return false;
  }
  refreshSessionsView();
  // `sessionReset` cleared the webview's readout; the resumed session's real
  // spend is in its own JSONL, so show that rather than a false zero.
  await pushSessionCost();
  return true;
}

/*
 * ADR 0057 DELETED `switchToBranchById` and `switchToBranchForTests` from
 * here, with the `lemmaria.switchBranch` registration below.
 *
 * They were the Sessions view's branch-row command: resume the session, then
 * move its leaf, restoring that branch's files on the way (ADR 0031 s5). That
 * section is superseded — a session switch moves no files — and the rows the
 * command served no longer exist. `resumeSessionById` remains THE one resume
 * path, and a forked session is reached through it like any other.
 */

/**
 * The SINGLE inbound-message router — the provider's `onDidReceiveMessage`
 * body, also the test seam. The `ready`/`echoed` handshake needs the live view
 * closure state (readyResolvers/echoResolver); every other message is a plain
 * command routed to `handleWebviewMessage`. There is deliberately NO second
 * allow-list here: a hand-maintained one silently dropped `interruptTask` (and
 * would have dropped `newSession`) once it drifted out of sync with the
 * handler. `handleWebviewMessage` already ignores any type it does not know.
 */
function routeInboundMessage(msg: WebviewToHost): void {
  if (msg.type === "ready") {
    readyFired = true;
    for (const r of readyResolvers) r();
    readyResolvers = [];
    postToWebview({
      type: "init",
      ...computeInitState(),
    } satisfies HostToWebview);
    postToWebview({
      type: "selection",
      state: computeSelectionState(),
    } satisfies HostToWebview);
    // A1b: seed the composer's permission-mode selector with the live policy.
    postToWebview({
      type: "editPolicy",
      policy: currentEditPolicy(),
    } satisfies HostToWebview);
    // A4: seed the granted-folder chips with the live grant set.
    postToWebview({
      type: "grantsState",
      grants: activeSessionGrants(),
    } satisfies HostToWebview);
    // E2 (ADR 0049): seed the composer's `/` menu with the loaded catalogue.
    // Activation registers skills before the webview, so this is populated by
    // the time `ready` arrives.
    postSkillsCatalogue(currentSkills());
    // E3 (ADR 0052): seed the composer's `@` menu. Not awaited — a filesystem
    // walk must not sit in front of the transcript replay below, and the menu
    // is closed at `ready` by construction, so nothing is waiting for it.
    void postContextPaths();
    // ADR 0064 §1: seed the Review tab's launcher. Before this the tab was
    // pushed only when a review ran, so a window that had run none rendered a
    // bare hint with no way to start one — the whole point of the launcher is
    // that it is there BEFORE the first review. Pushed synchronously with what
    // is known now (an empty entry on the very first `ready`, the cached one
    // afterwards); the refresh below fills it in and re-pushes when it lands.
    pushReviewState(false);
    void refreshNextPaperEntry();
    // ADR 0065 §3: and the run, if one is in flight. A webview that was
    // re-created mid-panel (a tab switch away and back) would otherwise show a
    // launcher offering to start the panel that is already running.
    pushReviewRun();
    pushRestorePoints();
    // A5: a re-created webview lost its transcript but the host still holds the
    // live session — hand back what it already persisted, plus the last
    // measured occupancy (only ever pushed on a turn boundary before now).
    void replayActiveTranscript();
  } else if (msg.type === "echoed") {
    const resolve = echoResolver;
    echoResolver = undefined;
    resolve?.(msg.text);
  } else if (msg.type === "probed") {
    // T2 (ADR 0043): a REPLY, like `echoed` — it needs the pending-request map,
    // which `handleWebviewMessage` (a command handler) has no access to. An
    // unknown id is dropped rather than throwing: a reply arriving after its
    // request timed out is late, not corrupt.
    const pending = probeResolvers.get(msg.requestId);
    probeResolvers.delete(msg.requestId);
    pending?.resolve(msg.results);
  } else {
    void handleWebviewMessage(msg);
  }
}

class LemmariaWebviewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    current = view;
    readyFired = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = getWebviewContent(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      routeInboundMessage(msg),
    );
    view.onDidDispose(() => {
      if (current === view) current = undefined;
    });
  }
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const n = nonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.css"),
  );
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Lemmaria</title>
</head>
<body>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function registerWebview(
  context: vscode.ExtensionContext,
  actions: LoadedAction[],
): void {
  loadedActions = actions;
  extContext = context;
  // ADR 0031: a task ending (or a branch moving) re-pushes both point sets, so
  // the control appears on the bubble as soon as that turn is branchable.
  onRestorePointsChanged(pushRestorePoints);
  // A4: a grant change re-pushes the chips AND lands the grant_update card in
  // the live transcript (the persisted event reaches the fold the same way).
  // A2 (ADR 0021): the composer's context ring — measured occupancy only.
  onContextUsage((usage) => {
    postToWebview({
      type: "contextUsage",
      ...usage,
    } satisfies HostToWebview);
  });
  // A5: the agentic path joins the M9 accounting the quick actions already use
  // — before this, a whole composer session cost nothing anywhere on screen.
  onTurnUsage((usage, model) => {
    recordUsage({ ...usage, model });
    void pushSessionCost();
  });
  // The X6 review round: a panel is ONE run charged in several parts, so the
  // status bar's *this run* is the whole panel, not its last request.
  onRunUsage((parts) => {
    recordRun(parts.map((p) => ({ ...p.usage, model: p.model })));
    void pushSessionCost();
  });
  onGrantsChanged((grantList, item) => {
    postToWebview({
      type: "grantsState",
      grants: grantList,
    } satisfies HostToWebview);
    // E3 (ADR 0052): `@` gets wider when the user grants a folder and narrower
    // when they revoke one — design §5's stated consequence, and what makes
    // the grant chips mean more than they did. This sink also fires on a new
    // session and on a resume (`resetForNewSession` / `adoptResumedGrants`
    // both notify), so it is the one place the set has to be re-pushed from.
    void postContextPaths();
    if (item) {
      postToWebview({
        type: "sessionEvent",
        event: { type: "item.completed", item },
      } satisfies HostToWebview);
    }
  });
  // ADR 0018, as superseded by ADR 0027 and then by ADR 0057: whichever entry
  // point runs a restore, the host SWITCHES to the session the fork created and
  // the composer gets the message back. Switching rather than posting a rewind
  // event is what let the webview's hand-rolled truncation mirror be deleted —
  // the live fold has no rewind rule to keep in step with the harness one,
  // which ADR 0018 called out as the cheapest place to introduce a divergence
  // bug. The resume is a full reset-and-replay, so nothing of the session just
  // left can survive on screen; that is what retired `transcriptReplay`'s
  // `authoritative` flag, whose only producers were the two moves.
  onSessionRestore({
    onForked: (childId) => resumeSessionById(childId),
    // E6 (D8): the restore-only arm moved files and left the conversation
    // alone, so there is no transcript change to make and no session to switch
    // to. What must happen is that the Sessions view re-reads disk: the active
    // session's leaf now names bytes that are no longer there, and its row has
    // to say so (ADR 0058 §7). The ⟲ counts are pushed for the same reason
    // they are after every other rewind — the plan is a fold over the log, so
    // this recomputes to the same numbers, and asking is cheaper than
    // reasoning about when it would not.
    onRestored: () => {
      refreshSessionsView();
      pushRestorePoints();
    },
    onRewound: (text) => {
      postToWebview({
        type: "composerPrefill",
        text,
      } satisfies HostToWebview);
      // D10's second half, and it has to be HERE rather than in the resume:
      // `rewindConversation` restores the policy AFTER `onForked` returns, so
      // at resume time the host still holds the reset `review` and the resume's
      // own push would carry the wrong value. By the time this runs the restore
      // has happened, so this is the first moment the panel can be told the
      // truth. Without it the host auto-applies while the pill promises to ask.
      postToWebview({
        type: "editPolicy",
        policy: currentEditPolicy(),
      } satisfies HostToWebview);
      pushRestorePoints();
    },
  });
  const provider = new LemmariaWebviewProvider(context.extensionUri);
  // B7 (ADR 0028): how `Lemmaria: Use a Writing Skill` reaches the composer.
  // Injected rather than imported, so `skills-ui` does not depend on this
  // module (which already imports plenty of it) — the U5 cycle lesson.
  setComposerPrefill((text) => {
    postToWebview({ type: "composerPrefill", text } satisfies HostToWebview);
  });
  // E2 (ADR 0049): the same injected-sink shape, for the composer's `/` menu.
  // The catalogue is PUSHED on every change rather than polled, because E1's
  // runtime toggle moves the enabled set while the panel is open.
  setSkillsChanged((skills) => postSkillsCatalogue(skills));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Editor-title logo button (and palette entry) — opens the secondary-
    // sidebar Assistant, the Claude Code / Codex affordance.
    vscode.commands.registerCommand("lemmaria.openAssistant", () =>
      revealWebview(),
    ),
    // A1a (ADR 0015): a fresh thread — config carries over, no summary does.
    vscode.commands.registerCommand("lemmaria.newSession", () => newSession()),
    // A2 (ADR 0021): resume a persisted session (A5 builds the Sessions view).
    vscode.commands.registerCommand("lemmaria.resumeSession", () =>
      pickAndResumeSession(),
    ),
    // A5: the Sessions view's row command — the same resume, addressed by id.
    vscode.commands.registerCommand(
      "lemmaria.resumeSessionById",
      (id: unknown) =>
        typeof id === "string" ? resumeSessionById(id) : Promise.resolve(false),
    ),
    // A2 (ADR 0021): compact the conversation now (Claude Code's /compact).
    vscode.commands.registerCommand("lemmaria.compactSession", () =>
      extContext
        ? compactActiveSession(extContext, postSessionEvent)
        : Promise.resolve(false),
    ),
    // Selection-awareness (U1): push the live selection so the webview can
    // enable/disable the action tiles and update the context chip.
    vscode.window.onDidChangeTextEditorSelection(() => pushSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => pushSelection()),
    // Citations tab: when an adopted correction lands (Accept), re-verify that
    // key so the tab shows the new status instead of the stale mismatch.
    onProposalAccepted.event((e) => {
      void refreshAdoptedCitation(e.realUri);
    }),
    // ADR 0064 §1: the launcher's *main file* line must follow the setting, and
    // the setting can move without any review running — from the picker, from
    // Settings, or from another window editing the same `.vscode/settings.json`.
    // Watched here rather than only after the picker, because the picker is not
    // the only writer.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lemmaria.paperEntry"))
        void refreshNextPaperEntry();
    }),
  );
  // Models tab (revised U3): the ModelStore is the only writer of the list, and
  // every add/remove/setActive/updateModelKey dispatch re-pushes — so no
  // settings/secrets listener is needed here.
  // After every recorded run, re-push so the usage table updates live (U3 D3).
  onUsageRecorded(() => {
    void pushModelsState();
  });
  // A completed review reveals the Assistant webview on its Review tab (U5
  // round 2). Await ready first — a push before the client listens is lost.
  onReviewCompleted(() => {
    void (async () => {
      try {
        await revealWebview();
      } catch {
        // Reveal can reject during shutdown; still cache the state below.
      }
      pushReviewState(true);
    })();
  });
  // A finding's triage status changed (adopt accepted / ignored) — re-push the
  // tab in place, without re-revealing it (the user is already looking at it).
  onReviewChanged(() => {
    pushReviewState(false);
  });
  // ADR 0065 §3: the detached panel's progress goes to the Review tab, and
  // NEVER through `postSessionEvent` — a `review` item on that path would
  // redraw the transcript card this milestone removed.
  onReviewRunChanged(() => {
    pushReviewRun();
  });
  // A completed Compile Check reveals the Assistant webview on its Compile tab
  // (X1). Await ready first — a push before the client listens is lost.
  onCompileCompleted(() => {
    void (async () => {
      try {
        await revealWebview();
      } catch {
        // Reveal can reject during shutdown; still cache the state below.
      }
      pushCompileState(true);
    })();
  });
  // A finding's triage status changed (fix accepted / ignored) — re-push the
  // tab in place, without re-revealing it (the user is already looking at it).
  onCompileChanged(() => {
    pushCompileState(false);
  });
}

/** Focus the view (resolving it) and await the webview's `ready`. */
export async function revealWebview(): Promise<void> {
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  if (readyFired) return;
  await new Promise<void>((resolve) => {
    // Don't hang the suite if the view never loads; clear the timer on ready.
    const timer = setTimeout(resolve, 10000);
    readyResolvers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Test seam: `revealWebview` under its API-seam name. */
export const revealWebviewForTests = revealWebview;

/** Test seam: the SelectionState the host would push for the active editor. */
export const computeSelectionStateForTests = computeSelectionState;

/** Test seam: the init payload the host pushes on `ready`. */
export const computeInitStateForTests = computeInitState;

/** Test seam: run the host message handler as if the webview posted `msg`. */
export const dispatchWebviewMessageForTests = handleWebviewMessage;

/**
 * Test seam: deliver `msg` through the provider's REAL inbound router — the
 * path a live webview view drives — so tests cover the actual dispatch (the
 * whitelist that once dropped `interruptTask`), not just `handleWebviewMessage`.
 */
export const routeInboundMessageForTests = routeInboundMessage;

/**
 * Test seam (A5): everything the host has posted to the webview, oldest first.
 * The outbound counterpart of `routeInboundMessageForTests` — it proves what a
 * live view would actually receive, not what a handler returned.
 */
export const postedToWebviewForTests = (): readonly HostToWebview[] => [
  ...postedToWebview,
];

/**
 * Test seam (A5): empty the posted log. The log is a bounded ring, so a test
 * that remembers an index into it can be silently invalidated by eviction —
 * clear it, then assert on what arrives.
 */
export function clearPostedToWebviewForTests(): void {
  postedToWebview.length = 0;
}

/** Test seam: the last SelectionState the host pushed to the webview. */
export const lastPushedSelectionForTests = (): SelectionState | undefined =>
  lastPushedSelection;

/** Test seam: the last C2 display state the host built/pushed. */
export const lastCitationsC2ForTests = (): CitationsC2State | undefined =>
  lastC2State;

/** Test seam: the ModelsState the host would push (U3). */
export const computeModelsStateForTests = computeModelsState;

/** Test seam: the last ModelsState the host built/pushed. */
export const lastModelsStateForTests = (): ModelsState | undefined =>
  lastModelsState;

/** Test seam (U4): compute the Venue tab state from the live editor. */
export const computeVenueStateForTests = computeVenueState;

/** Test seam: the last VenueState the host built/pushed. */
export const lastVenueStateForTests = (): VenueState | undefined =>
  lastVenueState;

/** Test seam (U5): the last ReviewTabState the host built/pushed. */
export const lastReviewTabStateForTests = (): ReviewTabState | undefined =>
  lastReviewTabState;

/** Test seam (X1): the last CompileTabState the host built/pushed. */
export const lastCompileTabStateForTests = (): CompileTabState | undefined =>
  lastCompileTabState;

/**
 * Test seam (T2, ADR 0043): drive a gesture and measure the result, in the
 * REAL webview — real layout engine, so `offsetWidth` is a number and a
 * container query resolves. This is the coarse instrument that sits beside
 * ADR 0037's jsdom project; it answers *is it wired, and what does the layout
 * engine do with it*, never *does this pure module compute the right thing*.
 *
 * **It rejects on timeout, deliberately — unlike `revealWebview`, which
 * resolves.** That asymmetry is ADR 0043 §D6's distinguishing signal: a broken
 * channel must be a REJECTION, so it can never be mistaken for a measurement,
 * while a wrong DOM resolves with a value that fails an assertion. Copying
 * `revealWebview`'s anti-hang resolve here would make a dead channel read as a
 * pass, which is exactly the circularity [ADR 0037] §4 objected to.
 *
 * **It awaits ready itself**, so a caller cannot forget to pair it with a
 * reveal — `roundTripForTests` requires that pairing by convention alone.
 *
 * **It bypasses `postToWebview`**, as `roundTripForTests` does, so probe
 * traffic never enters the `postedToWebviewForTests()` ring. Five suites assert
 * against that log and instrumentation must not appear in it.
 */
export async function probeWebviewForTests(
  steps: ProbeStep[],
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult[]> {
  // Reveal only when there is nothing to probe yet. `revealWebview` runs the
  // view's `.focus` command, and a probe issued MID-TASK would otherwise pull
  // focus out of the editor the write path is proposing against — the
  // instrument changing the thing it measures.
  if (!current || !readyFired) await revealWebview();
  const view = current;
  if (!view) throw new Error("webview not resolved");
  const requestId = `probe-${++probeSeq}`;
  return new Promise<ProbeResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      probeResolvers.delete(requestId);
      reject(new Error(`probe ${requestId}: no reply from the webview`));
    }, opts.timeoutMs ?? 10000);
    // Only `resolve` is stored: the sole rejection path is the timeout above,
    // which rejects directly. A `reject` in this map would never be called, and
    // an unused escape hatch is a thing a later reader assumes something calls
    // (`parts/frame.ts` refuses a `cancel()` for the same reason).
    probeResolvers.set(requestId, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
    });
    view.webview.postMessage({
      type: "probe",
      requestId,
      steps,
    } satisfies HostToWebview);
  });
}

/** Test seam: post an echo to the webview, resolve with its reply (both directions). */
export function roundTripForTests(text: string): Promise<string> {
  const view = current;
  if (!view) return Promise.reject(new Error("webview not resolved"));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no echo reply")), 10000);
    echoResolver = (t) => {
      clearTimeout(timer);
      resolve(t);
    };
    view.webview.postMessage({ type: "echo", text } satisfies HostToWebview);
  });
}
