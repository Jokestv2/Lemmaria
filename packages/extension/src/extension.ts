import type {
  CitationSource,
  CompileProjectOptions,
  CostState,
  ModelAdapter,
  ModelBinding,
  ReviewResult,
  ScaffoldReport,
} from "@lemmaria/harness";
import type * as vscode from "vscode";
import { loadBundledActions } from "./builtin-actions";
import {
  type CitationC1Result,
  clearCitationSourcesForTests,
  computeCitationC1ForTests,
  registerCitations,
  setCitationSourcesForTests,
} from "./citation-ui";
import { registerCodeLens } from "./codelens-ui";
import { computeCompileTabState, registerCompile } from "./compile-ui";
import {
  costStatusForTests,
  getCostForTests,
  registerCost,
  reloadCostForTests,
  resetCostForTests,
  seedCostForTests,
  sessionUsageForTests,
} from "./cost-ui";
import { registerDiffReview } from "./diff-review";
import {
  computeGlossary,
  glossaryTreeForTests,
  refreshGlossaryForTests,
  registerGlossary,
} from "./glossary-ui";
import { registerGrants } from "./grants-ui";
import {
  clearApiKeyPromptForTests,
  clearModelForTests,
  clearModelsForTests,
  clearStoredApiKeyForTests,
  migrateLegacyModel,
  migrateLegacyModelForTests,
  modelStoreForTests,
  registerModels,
  registerSetApiKey,
  resolveModelForTests,
  resolveReviewPanelForTests,
  reviewRolesStore,
  setApiKeyPromptForTests,
  setModelForTests,
  setReviewPanelForTests,
  syncedGlobalKeysForTests,
} from "./model";
import { configuredPaperPdf, registerPaperEntry } from "./paper-entry";
import { registerPaperMd } from "./paper-md";
import { pdfRendererFor } from "./pdf-host";
import { registerQuickActionCommands } from "./polish-command";
import {
  getReviewForTests,
  initReviews,
  persistableReviewsForTests,
  registerReview,
} from "./review-ui";
import {
  type RewindArm,
  registerSessionEdit,
  rewindFromMessage,
  setRewindPickerForTests,
  sweepSnapshotBlobs,
} from "./session-edit-ui";
import {
  type RewindPoint,
  activeSessionGrants,
  activeSessionIdForTests,
  addGrant,
  branchPointsOf,
  compactActiveSession,
  currentEditPolicy,
  lastContextUsageForTests,
  listSessions,
  literatureBudgetForTests,
  proposalFileDiffFor,
  resetSessionForTests,
  restoreActiveSession,
  resumeSession,
  revokeGrant,
  rewindPointsOf,
  sessionCostForTests,
  sessionCreatedFiles,
  sessionEventsForTests,
  sessionItems,
  sessionStoreDirForTests,
  setLiteratureProvidersForTests,
  setScriptInterpretersForTests,
  simulateWindowReloadForTests,
} from "./session-host";
import { buildSessionRegistry } from "./session/registry";
import {
  allowScriptForTests,
  alwaysAllowedScriptsForTests,
} from "./session/script-host";
import { sharedTaskOptions } from "./session/task-options";
import {
  type SessionViewRow,
  contentReadsForTests,
  nestSessionRowsForTests,
  outOfSyncForTests,
  outOfSyncMarkerForTests,
  outOfSyncSetForTests,
  refreshSessionsView,
  registerSessionsView,
  sessionViewItemForTests,
  sessionViewRowsForTests,
  shaForTests,
} from "./sessions-view";
import type { EditEntry } from "./sidebar-ui";
import {
  editsItemForTests,
  getEditsForTests,
  registerSidebar,
  viewPullsForTests,
} from "./sidebar-ui";
import {
  currentSkills,
  disabledSkillsForTests,
  refreshSkillsForTests,
  registerSkills,
  skillsTreeForTests,
  userSkillsDir,
} from "./skills-ui";
import {
  type ChromeCounts,
  computeCounts,
  gitBranchFor,
  refreshStatusBarForTests,
  registerStatusBar,
  statusBarTextsForTests,
} from "./status-bar-ui";
import { getScaffoldReportForTests, registerVenues } from "./venue-ui";
import {
  type ProgressRunner,
  clearEngineProbeForTests,
  registerVerify,
  setEngineProbeForTests,
  setProgressRunnerForTests,
} from "./verify-ui";
import type {
  BudgetInfo,
  CitationsC2State,
  CompileTabState,
  HostToWebview,
  ModelInfo,
  ModelsState,
  ProbeResult,
  ProbeStep,
  QuickActionInfo,
  ReviewTabState,
  SelectionState,
  VenueState,
  WebviewToHost,
} from "./webview-protocol.js";
import {
  clearPostedToWebviewForTests,
  computeInitStateForTests,
  computeModelsStateForTests,
  computeSelectionStateForTests,
  computeVenueStateForTests,
  dispatchWebviewMessageForTests,
  lastCitationsC2ForTests,
  lastCompileTabStateForTests,
  lastModelsStateForTests,
  lastPushedSelectionForTests,
  lastReviewTabStateForTests,
  lastVenueStateForTests,
  postedToWebviewForTests,
  probeWebviewForTests,
  registerWebview,
  revealWebviewForTests,
  roundTripForTests,
  routeInboundMessageForTests,
  setSessionPickerForTests,
} from "./webview-view";
import {
  VscodeWorkspace,
  clearCompileForTests,
  lastCompilePages,
  setCompileForTests,
} from "./workspace";

export interface LemmariaApi {
  /** Test seam (ext-host suites): inject a deterministic ModelAdapter. */
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  /** Test seam: inject a fake compile (the ext-host runner has no TeX).
   *  V4 (ADR 0081 §2): widened to `CompileResult`, so a fake may hand back
   *  the PDF a review asked for; `{ok, log}` still satisfies it. */
  setCompileForTests(
    fn: (
      opts: CompileProjectOptions,
    ) => Promise<import("@lemmaria/harness").CompileResult>,
  ): void;
  clearCompileForTests(): void;
  /** Test seam (X1): override the engine-availability probe. An injected compile
   *  makes the PATH probe moot, so this is the only way to drive the
   *  engine-absent guidance path. */
  setEngineProbeForTests(fn: (engine: string) => boolean): void;
  clearEngineProbeForTests(): void;
  /** Test seam (X1): the Compile tab's state after the last Compile Check. */
  compileTabStateForTests(): CompileTabState;
  /** Test seam (U4): page count recorded by the most recent compile of an entry. */
  lastCompilePagesForTests(entryFsPath: string): number | undefined;
  /** Test seam: inject mock C2 citation sources (the ext-host runner has no network). */
  setCitationSourcesForTests(sources: CitationSource[]): void;
  clearCitationSourcesForTests(): void;
  /** Test seam (U2): C1 + bib header for a uri (the Citations tab's always-on group). */
  computeCitationC1ForTests(uri: vscode.Uri): Promise<CitationC1Result>;
  /** Test seams (U6): the status bar's live EN/CN counts + what each item renders. */
  computeCountsForTests(
    editor: vscode.TextEditor,
  ): Promise<ChromeCounts | undefined>;
  statusBarTextsForTests(): Record<string, string | undefined>;
  /** Test seam (D4 / CHROME-4): how a long operation is shown. */
  setProgressRunnerForTests(runner?: ProgressRunner): void;
  refreshStatusBarForTests(): Promise<void>;
  /** Test seam (U6): the git-branch reader. */
  gitBranchForTests(root: string): string | undefined;
  /** Test seam (D4 / QA-1): each loaded action's `name` per locale, so the
   *  hand-maintained NLS command titles can be checked against the YAML they
   *  are supposed to mirror. Nothing else compares those two today. */
  actionNamesForTests(): Record<string, { en?: string; zh?: string }>;
  /** Test seam (U6): the Glossary panel's merged PAPER.md rows. */
  computeGlossaryForTests(
    uri: vscode.Uri | undefined,
  ): Promise<import("./glossary-ui").GlossaryRow[]>;
  refreshGlossaryForTests(): Promise<void>;
  glossaryTreeForTests(): {
    children: import("./glossary-ui").GlossaryRow[];
    items: { label: string; description: string }[];
    message: string | undefined;
    badge: number | undefined;
  };
  /** Test seams (B7): the Skills view, driven the way the glossary one is. */
  refreshSkillsForTests(): Promise<void>;
  skillsTreeForTests(): {
    children: unknown[];
    items: vscode.TreeItem[];
    message: string | undefined;
    badge: number | undefined;
  };
  /** Test seams (E1): the user source, and the persisted disabled selection. */
  userSkillsDirForTests(): string;
  disabledSkillsForTests(): unknown[];
  currentSkillsForTests(): { name: string; source: string }[];
  /** Test seam: the review panel's current model (M9). */
  getReviewForTests(): ReviewResult | undefined;
  /** Test seams: the cumulative cost display's persisted state (M9). */
  getCostForTests(): CostState | undefined;
  resetCostForTests(): void;
  reloadCostForTests(): Promise<CostState | undefined>;
  /** Test seams (X6 review round): replace the stored state, and read the
   *  status-bar item's text as the reader sees it. */
  seedCostForTests(state: CostState): void;
  costStatusForTests(): string | undefined;
  /** Test seam (A5): this session's folded spend (tokens; $ only when priced,
   *  with the count of calls that reported no price). */
  sessionCostForTests(): Promise<{
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    unpricedCalls: number;
  }>;
  /** Test seam (U3): per-model session usage rows. */
  sessionUsageForTests(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  /** Test seam: the last New-from-Venue scaffold's report (M10). */
  getScaffoldReportForTests(): ScaffoldReport | undefined;
  /** Test seams (U0): the webview round-trip pipeline. */
  revealWebviewForTests(): Promise<void>;
  roundTripForTests(text: string): Promise<string>;
  /**
   * Test seam (T2, ADR 0043): drive a gesture and measure the result in the
   * REAL webview — real layout engine, so `offsetWidth` is a number and a
   * container query resolves. Rejects if the channel is dead; resolves with a
   * per-step result otherwise (§D6's distinguishing signal).
   */
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  /** Test seam (U1): the SelectionState the host pushes for the active editor. */
  computeSelectionStateForTests(): SelectionState;
  /** Test seam (U1): the init payload the host pushes on `ready`. */
  computeInitStateForTests(): {
    locale: "en" | "zh";
    quickActions: QuickActionInfo[];
    model: ModelInfo;
    budget: BudgetInfo;
  };
  /** Test seam (U1): run the host message handler as if the webview posted it. */
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  /** Test seam (A1a): deliver a message through the provider's real inbound router. */
  routeInboundMessageForTests(msg: WebviewToHost): void;
  /** Test seam (A5): every H→W message the host has posted, oldest first. */
  postedToWebviewForTests(): readonly HostToWebview[];
  /** Test seam (A5): empty the (bounded) posted log before an assertion. */
  clearPostedToWebviewForTests(): void;
  /** Test seam (U1): the last SelectionState the host pushed to the webview. */
  lastPushedSelectionForTests(): SelectionState | undefined;
  /** Test seam (U2): the last C2 display state the host built/pushed. */
  lastCitationsC2ForTests(): CitationsC2State | undefined;
  /** Test seam (U3): the ModelsState the host would push. */
  computeModelsStateForTests(): Promise<ModelsState>;
  /** Test seam (U3): the last ModelsState the host built/pushed. */
  lastModelsStateForTests(): ModelsState | undefined;
  /** Test seam (U4): the VenueState the host would push. */
  computeVenueStateForTests(): Promise<VenueState>;
  /** Test seam (U4): the last VenueState the host built/pushed. */
  lastVenueStateForTests(): VenueState | undefined;
  /** Test seam (U5): the last ReviewTabState the host built/pushed. */
  lastReviewTabStateForTests(): ReviewTabState | undefined;
  /** Test seam (X5): exactly what the review store would be handed. */
  persistableReviewsForTests(): import("@lemmaria/harness").StoredReview[];
  /** Test seam (X1): the last CompileTabState the host built/pushed. */
  lastCompileTabStateForTests(): CompileTabState | undefined;
  /** Test seam (U3): delete the stored API key (hermetic key-presence tests). */
  clearStoredApiKeyForTests(): Promise<void>;
  /** Test seam (A0): events emitted by the last composerSend session turn. */
  sessionEventsForTests(): import("@lemmaria/harness").SessionEvent[];
  /** Test seam (A0): the on-disk session directory (undefined before first use). */
  sessionStoreDirForTests(): string | undefined;
  /** Test seam (A0): drop the cached session store + active session. */
  resetSessionForTests(): void;
  /**
   * Test seam (A5): destroy this host's in-memory session state the way a
   * window reload does, keeping only what is persisted, then re-run the
   * activation restore. Resolves true when a session came back.
   */
  simulateWindowReloadForTests(): Promise<boolean>;
  /** Test seam (ADR 0031): rewind at a message, consent step skipped. Kept on
   *  its E5 name and its E5 meaning — the whole rewind, files and all — which
   *  E6 (ADR 0058 §4) calls the `both` arm. */
  branchFromMessageForTests(messageId: string): Promise<boolean>;
  /** Test seam (E6, ADR 0058 §4): ONE arm of a rewind, consent skipped. */
  rewindFromMessageForTests(
    messageId: string,
    arm: RewindArm,
  ): Promise<boolean>;
  /** Test seam (E6, D9): replace the palette command's QuickPicks. */
  setRewindPickerForTests(
    picker?: (
      items: readonly vscode.QuickPickItem[],
      title: string,
    ) => string | undefined,
  ): void;
  /** Test seams (E6, D11): what a rewind does NOT carry — the `run_script`
   *  always-allow cache — made observable the way the policy it does carry is. */
  allowScriptForTests(hash: string): void;
  alwaysAllowedScriptsForTests(): number;
  /** Test seam (ADR 0031): the user_message ids the conversation can branch at. */
  branchPointsForTests(): Promise<string[]>;
  /** Test seam (E7, ADR 0055): the same set, each point carrying how many
   *  files clicking its control would change, from the current leaf. */
  rewindPointsForTests(): Promise<RewindPoint[]>;
  /** Test seam (A2): the persisted sessions for this workspace, newest first,
   *  each with the leaf file manifest the index carries (ADR 0058 §3). */
  listSessionsForTests(): Promise<import("@lemmaria/harness").SessionListing[]>;
  /** Test seam (A2): resume a persisted session by id. */
  resumeSessionForTests(id: string): Promise<boolean>;
  /** Test seam (ADR 0057): the standing edit policy, which a rewind carries
   *  across its fork while an ordinary session switch re-consents. */
  currentEditPolicyForTests(): "review" | "auto_apply";
  /** Test seam (A2): the active session's id (undefined for a fresh thread). */
  activeSessionIdForTests(): string | undefined;
  /** Test seam (A2): replace the resume quick-pick (undefined restores). */
  setSessionPickerForTests(
    picker?: (choices: { id: string; label: string }[]) => string | undefined,
  ): void;
  /** Test seam (A2): run a manual compaction on the active session. */
  compactSessionForTests(): Promise<boolean>;
  /** Test seam (A2): the last measured context occupancy pushed to the view. */
  lastContextUsageForTests(): { occupied?: number; window: number } | undefined;
  /** Test seam (A1b round 2): the persisted transcript with rewinds folded. */
  sessionItemsForTests(): Promise<import("@lemmaria/harness").SessionItem[]>;
  /** Test seam (A1b): the files the active session created and applied. */
  sessionCreatedFilesForTests(): Promise<string[]>;
  /** Test seam (A1b): the combined per-file diff sides for a proposal. */
  proposalFileDiffForTests(
    itemId: string,
    file: string,
  ): Promise<{ file: string; current: string; proposed: string } | undefined>;
  /** Test seam (A4): grant a folder to the session (the picker's backend). */
  addGrantForTests(
    folderPath: string,
  ): Promise<import("@lemmaria/harness").GrantedRoot>;
  /** Test seam (A4): revoke a grant by id. */
  revokeGrantForTests(id: string): Promise<boolean>;
  /** Test seam (A4): the live grant set. */
  activeSessionGrantsForTests(): import("@lemmaria/harness").GrantedRoot[];
  /** Test seam (A4): the host-owned per-session literature budget. */
  literatureBudgetForTests(): { remaining: number };
  /** Test seam (A4): replace the scholarly providers (undefined restores). */
  setLiteratureProvidersForTests(
    providers?: import("@lemmaria/harness").LiteratureProvider[],
  ): void;
  /** Test seam (A4b): override the run_script interpreter allowlist (undefined restores). */
  setScriptInterpretersForTests(list?: string[]): void;

  /** Test seam (V3, ADR 0080): the PDF the user named, as the policy sees it. */
  configuredPaperPdfForTests(): Promise<string | undefined>;
  /** Test seam (V3, ADR 0080 §9): the renderer built from the SHIPPED asset. */
  pdfRendererForTests(): Promise<import("@lemmaria/harness").PdfRenderer>;
  /** Test seam (V3, ADR 0080 §8): the workspace port's two new members. */
  workspacePortForTests(root: string): import("@lemmaria/harness").Workspace;
  /** Test seam (V4, O14): the options a review task is built with — the
   *  `reviewPanel` and `reviewPdf` it hands the harness. */
  sharedTaskOptionsForTests(
    paper: { root: string; entry: string } | undefined,
    panel?: import("./model").ResolvedReviewPanel,
  ): Promise<import("./session/task-options").SharedTaskOptions>;
  /** Test seam (V3, O8): the session registry, to prove what it does NOT hold. */
  sessionRegistryForTests(): Promise<
    Map<
      import("@lemmaria/harness").ToolName,
      import("@lemmaria/harness").ToolExecutor
    >
  >;

  modelStoreForTests(): import("./model-store").ModelStore | undefined;
  clearModelsForTests(): Promise<void>;
  resolveModelForTests(): Promise<ModelBinding | undefined>;
  /** Test seam (R9): the review roles store, the resolver, and the synced
   *  globalState keys — the three halves of §D8 a host test can reach. */
  reviewRolesStoreForTests():
    | import("./review-roles-store").ReviewRolesStore
    | undefined;
  resolveReviewPanelForTests(): Promise<
    import("./model").ReviewPanelResolution
  >;
  setReviewPanelForTests(
    panel: import("./model").ResolvedReviewPanel | undefined,
  ): void;
  syncedGlobalKeysForTests(): string[];
  migrateLegacyModelForTests(): Promise<
    import("./model-store").StoredModel | undefined
  >;
  /** Test seam (U3): override the interactive API-key prompt. */
  setApiKeyPromptForTests(value: string | undefined): void;
  clearApiKeyPromptForTests(): void;
  /** Test seam (U5/X1): the session's edits store, newest first. */
  getEditsForTests(): EditEntry[];
  /** Test seam (U5/X1): the rendered Edits tree item at `index`. */
  editsItemForTests(index: number): vscode.TreeItem | undefined;
  /** Test seam (A5): the Sessions view's rows, from the real session store —
   *  nested on lineage since E5 (ADR 0057), roots first. */
  sessionViewRowsForTests(): Promise<SessionViewRow[]>;
  /** Test seam (E5): the nesting rule alone, over metas the caller supplies. */
  nestSessionRowsForTests(
    metas: readonly import("@lemmaria/harness").SessionMeta[],
    activeId?: string,
    now?: number,
    stale?: ReadonlySet<string>,
  ): SessionViewRow[];
  /** Test seams (E6, ADR 0058 §7): the out-of-sync marker's rule, its glyph,
   *  the content identity it compares with, and the read count its cost bound
   *  is stated in. */
  outOfSyncSetForTests(
    root: string,
    listings: readonly {
      meta: { id: string };
      files: Record<string, string>;
    }[],
  ): Promise<Set<string>>;
  outOfSyncForTests(
    root: string,
    listings: readonly {
      meta: { id: string };
      files: Record<string, string>;
    }[],
  ): Promise<boolean>;
  outOfSyncMarkerForTests(): string;
  shaForTests(content: string): string;
  contentReadsForTests(): number;
  /** Test seam (A5): the rendered tree item for a session row. */
  sessionViewItemForTests(row: SessionViewRow): vscode.TreeItem;
  /** Test seam (U5): what VS Code's LIVE sidebar trees actually pulled/rendered. */
  viewPullsForTests(): {
    getChildren: number;
    getTreeItem: number;
    labels: string[];
    sessionsLabels: string[];
  };
}

export function activate(context: vscode.ExtensionContext): LemmariaApi {
  const actions = loadBundledActions();
  registerCost(context);
  registerDiffReview(context);
  registerSetApiKey(context);
  registerModels(context);
  void migrateLegacyModel(context);
  registerQuickActionCommands(context, actions);
  registerCodeLens(context, actions);
  registerStatusBar(context);
  registerGlossary(context, actions);
  registerReview(context, actions);
  // ADR 0065 §1: this workspace's review history, from before this window.
  // Fire-and-forget, like the session restore below and for the same reason —
  // nothing about activation may wait on the filesystem; the tab pushes itself
  // again when the load lands.
  void initReviews(context);
  // ADR 0062 §2: which document a blind panel reads as the whole paper.
  registerPaperEntry(context);
  registerVerify(context);
  registerCompile(context, actions);
  registerSidebar(context);
  registerSessionsView(context);
  registerCitations(context);
  registerPaperMd(context);
  registerVenues(context);
  registerSessionEdit(context);
  registerGrants(context);
  registerSkills(context);
  // A5 (reload survival): a window reload restarts this host, so reopen the
  // session this window was talking to. Started BEFORE the webview provider so
  // the handshake replay (which awaits `activeSessionReady`) always has a
  // restore in flight to wait on rather than a fresh-thread reading of the host.
  void restoreActiveSession(context).then((restored) => {
    if (restored) refreshSessionsView();
  });
  // ADR 0031: activation hygiene, replacing B6's git-ref sweep — bounds the
  // blob store's growth. Fire-and-forget like the restore above: carrying a
  // few extra megabytes for one more launch is free, so nothing here may
  // block or fail activation, and the sweep itself is fail-closed (Task 7).
  void sweepSnapshotBlobs(context);
  registerWebview(context, actions);
  return {
    setModelForTests,
    clearModelForTests,
    setCompileForTests,
    setProgressRunnerForTests,
    clearCompileForTests,
    setEngineProbeForTests,
    clearEngineProbeForTests,
    compileTabStateForTests: computeCompileTabState,
    lastCompilePagesForTests: lastCompilePages,
    setCitationSourcesForTests,
    clearCitationSourcesForTests,
    computeCitationC1ForTests,
    computeCountsForTests: computeCounts,
    statusBarTextsForTests,
    refreshStatusBarForTests,
    gitBranchForTests: gitBranchFor,
    actionNamesForTests: () =>
      Object.fromEntries(
        actions.map((a) => [a.definition.id, a.definition.name]),
      ),
    computeGlossaryForTests: computeGlossary,
    refreshGlossaryForTests,
    glossaryTreeForTests,
    refreshSkillsForTests: () => refreshSkillsForTests(context),
    skillsTreeForTests,
    userSkillsDirForTests: userSkillsDir,
    disabledSkillsForTests: () => disabledSkillsForTests(context),
    currentSkillsForTests: () =>
      currentSkills().map((s) => ({ name: s.name, source: s.source })),
    getReviewForTests,
    getCostForTests,
    resetCostForTests,
    reloadCostForTests,
    seedCostForTests,
    costStatusForTests,
    sessionUsageForTests,
    sessionCostForTests,
    getScaffoldReportForTests,
    revealWebviewForTests,
    roundTripForTests,
    probeWebviewForTests,
    computeSelectionStateForTests,
    computeInitStateForTests,
    dispatchWebviewMessageForTests,
    routeInboundMessageForTests,
    postedToWebviewForTests,
    clearPostedToWebviewForTests,
    lastPushedSelectionForTests,
    lastCitationsC2ForTests,
    computeModelsStateForTests,
    lastModelsStateForTests,
    computeVenueStateForTests,
    lastVenueStateForTests,
    lastReviewTabStateForTests,
    persistableReviewsForTests,
    lastCompileTabStateForTests,
    clearStoredApiKeyForTests,
    sessionEventsForTests,
    sessionStoreDirForTests,
    resetSessionForTests,
    simulateWindowReloadForTests: () => simulateWindowReloadForTests(context),
    branchFromMessageForTests: (messageId: string) =>
      rewindFromMessage(context, messageId, "both", { skipConfirm: true }),
    rewindFromMessageForTests: (messageId: string, arm: RewindArm) =>
      rewindFromMessage(context, messageId, arm, { skipConfirm: true }),
    setRewindPickerForTests,
    allowScriptForTests,
    alwaysAllowedScriptsForTests,
    branchPointsForTests: branchPointsOf,
    // E7 (ADR 0055): the same set, each point carrying what its click would cost.
    rewindPointsForTests: rewindPointsOf,
    listSessionsForTests: () => listSessions(context),
    resumeSessionForTests: async (id: string) =>
      (await resumeSession(context, id)) !== undefined,
    currentEditPolicyForTests: currentEditPolicy,
    activeSessionIdForTests,
    setSessionPickerForTests,
    compactSessionForTests: () => compactActiveSession(context),
    lastContextUsageForTests,
    sessionItemsForTests: sessionItems,
    sessionCreatedFilesForTests: sessionCreatedFiles,
    proposalFileDiffForTests: proposalFileDiffFor,
    addGrantForTests: (folderPath: string) => addGrant(context, folderPath),
    revokeGrantForTests: (id: string) => revokeGrant(context, id),
    activeSessionGrantsForTests: activeSessionGrants,
    literatureBudgetForTests,
    setLiteratureProvidersForTests,
    setScriptInterpretersForTests,
    setApiKeyPromptForTests,
    clearApiKeyPromptForTests,
    configuredPaperPdfForTests: () => configuredPaperPdf(),
    pdfRendererForTests: () => pdfRendererFor(context),
    workspacePortForTests: (root: string) => new VscodeWorkspace(root),
    sharedTaskOptionsForTests: (
      paper: { root: string; entry: string } | undefined,
      panel?: import("./model").ResolvedReviewPanel,
    ) => sharedTaskOptions(context, paper, panel),
    sessionRegistryForTests: () => buildSessionRegistry(context),
    modelStoreForTests,
    clearModelsForTests,
    resolveModelForTests,
    reviewRolesStoreForTests: reviewRolesStore,
    resolveReviewPanelForTests,
    setReviewPanelForTests,
    syncedGlobalKeysForTests,
    migrateLegacyModelForTests,
    getEditsForTests,
    editsItemForTests,
    nestSessionRowsForTests,
    outOfSyncSetForTests,
    outOfSyncForTests,
    outOfSyncMarkerForTests,
    shaForTests,
    contentReadsForTests,
    sessionViewItemForTests,
    sessionViewRowsForTests,
    viewPullsForTests: () => ({
      ...viewPullsForTests,
      labels: [...viewPullsForTests.labels],
      sessionsLabels: [...viewPullsForTests.sessionsLabels],
    }),
  };
}

export function deactivate(): void {}
