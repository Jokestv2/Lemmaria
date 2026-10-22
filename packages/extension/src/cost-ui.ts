/**
 * M9 cumulative cost display: every engine run's usage folds into a
 * globalState-persisted CostState (harness `accrueUsage` — run / today /
 * total). Shown in a status-bar item and the Lemmaria sidebar Cost view per
 * `lemmaria.cost.display`. Unpriced runs (unknown models) accrue token counts
 * and are flagged, never given a fabricated dollar figure (ADR 0002/0009).
 */

import type { CostBucket, CostState } from "@lemmaria/harness";
import {
  accrueUsage,
  costAsOf,
  emptyCostState,
  formatCostBucket,
  localDateString,
  runCost,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

const STATE_KEY = "lemmaria.cost.v1";

interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** The bound model id this run used (U3 session-usage attribution). */
  model?: string;
}

// LOCAL calendar date — "today" follows the user's wall clock, not UTC.
const todayString = (): string => localDateString();

class CostTracker {
  private state: CostState;
  /** *This run*: every part of the last run, as one bucket. */
  lastRun: CostBucket | undefined;
  /** The last globalState write — awaited by the persistence test seam. */
  flushed: Thenable<void> = Promise.resolve();

  constructor(private readonly globalState: vscode.Memento) {
    this.state =
      globalState.get<CostState>(STATE_KEY) ?? emptyCostState(todayString());
  }

  /** As STORED — `today` may be an earlier day's until the next run rolls
   *  it over. Every display reads `shown` instead. */
  get current(): CostState {
    return this.state;
  }

  /** As it reads NOW: an earlier day's bucket is not today's spend (the X5
   *  and X6 review rounds — the status bar showed yesterday's as today's). */
  get shown(): CostState {
    return costAsOf(this.state, todayString());
  }

  /** One run, in as many parts as it was charged in — a panel is charged per
   *  reviewer, cross-review and pre-run check, each to its own model. */
  record(parts: readonly RunUsage[]): void {
    this.lastRun = runCost(parts);
    for (const usage of parts)
      this.state = accrueUsage(this.state, usage, todayString());
    this.flushed = this.globalState.update(STATE_KEY, this.state);
  }

  reset(): void {
    this.seed(emptyCostState(todayString()));
  }

  seed(state: CostState): void {
    this.state = state;
    this.lastRun = undefined;
    this.flushed = this.globalState.update(STATE_KEY, this.state);
  }
}

let tracker: CostTracker | undefined;
let memento: vscode.Memento | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let provider: CostTreeProvider | undefined;

/** U3 Models tab: per-model token tally since this window opened ("this
 *  session"). In-memory only — the persisted CostState stays aggregate (the
 *  M9 design; see the U3 plan's D1). */
const sessionUsage = new Map<
  string,
  { inputTokens: number; outputTokens: number }
>();
/** Listeners notified after each recorded run (the Models tab push trigger). */
const usageListeners: Array<() => void> = [];

/** Register a callback fired after every recordUsage (and cost reset).
 *  Process-lifetime: there is no unsubscribe — register once from activation
 *  only (registerWebview does), never per-webview or per-test. */
export function onUsageRecorded(listener: () => void): void {
  usageListeners.push(listener);
}

/** Per-model session rows, insertion-ordered. */
export function sessionUsageRows(): Array<{
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  return [...sessionUsage.entries()].map(([model, tally]) => ({
    model,
    ...tally,
  }));
}

/** The live cost state (today/total aggregates) for display — as it reads
 *  today, so an earlier day's bucket reads as today's empty one. */
export function currentCostState(): CostState | undefined {
  return tracker?.shown;
}

/**
 * Fold one engine run's usage into the persisted display (all run sites).
 *
 * A5 note: an agentic session calls this once per completed TURN (and once per
 * subtask fan-out), where a quick action calls it once per run — so `unpriced`
 * counts unpriced MODEL CALLS, not user-visible operations. Tokens and dollars
 * stay exact either way; only the run counter reads differently across the two
 * surfaces.
 */
export function recordUsage(usage: RunUsage): void {
  recordRun([usage]);
}

/**
 * Fold one run charged in several parts — a review panel's reviewers,
 * cross-review and pre-run check, each attributed to the model it ran on.
 * Each part accrues and gets its per-model row exactly as `recordUsage` would
 * give it; what differs is *this run*, which is all of them. Charged one part
 * at a time, it was whichever part came last: the pre-run check, so a $0.08
 * panel read `$0.000` in the status bar (the X6 review round).
 */
export function recordRun(parts: readonly RunUsage[]): void {
  if (parts.length === 0) return;
  tracker?.record(parts);
  for (const usage of parts) {
    const key = usage.model ?? "—";
    const tally = sessionUsage.get(key) ?? { inputTokens: 0, outputTokens: 0 };
    tally.inputTokens += usage.inputTokens;
    tally.outputTokens += usage.outputTokens;
    sessionUsage.set(key, tally);
  }
  refreshUi();
  for (const l of usageListeners) l();
}

export function getCostForTests(): CostState | undefined {
  return tracker?.current;
}

/** Test seam: replace the stored state, as a window opening on it would find
 *  it — the only way to reach a bucket stamped with an earlier day. */
export function seedCostForTests(state: CostState): void {
  tracker?.seed(state);
  refreshUi();
  for (const l of usageListeners) l();
}

/** Test seam: the status-bar item's text, as the reader sees it. */
export function costStatusForTests(): string | undefined {
  return statusItem?.text;
}

/** Test seam: the per-model session usage rows (U3 Models tab). */
export const sessionUsageForTests = sessionUsageRows;

export function resetCostForTests(): void {
  tracker?.reset();
  sessionUsage.clear();
  refreshUi();
  for (const l of usageListeners) l();
}

/** Reads the persisted state fresh from globalState (persistence probe),
 *  after the tracker's last write has flushed. */
export async function reloadCostForTests(): Promise<CostState | undefined> {
  await tracker?.flushed;
  return memento?.get<CostState>(STATE_KEY);
}

function costLines(): CostLine[] {
  if (!tracker) return [];
  const { today, total } = tracker.shown;
  return [
    {
      label: chrome("costThisRun"),
      value: tracker.lastRun ? formatCostBucket(tracker.lastRun) : "—",
    },
    {
      label: `${chrome("costToday")} (${today.date})`,
      value: formatCostBucket(today),
    },
    { label: chrome("costTotal"), value: formatCostBucket(total) },
  ];
}

interface CostLine {
  label: string;
  value: string;
}

// Tree elements are the line objects — never array indices: the ext host
// truthiness-filters (coalesce) getChildren results, so an index element of 0
// is dropped and the FIRST cost line would never render (U5 fix).
class CostTreeProvider implements vscode.TreeDataProvider<CostLine> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(element?: CostLine): CostLine[] {
    if (element !== undefined) return [];
    return costLines();
  }

  getTreeItem(line: CostLine): vscode.TreeItem {
    const item = new vscode.TreeItem(line.value);
    item.description = line.label;
    item.iconPath = new vscode.ThemeIcon("graph");
    return item;
  }
}

function refreshUi(): void {
  provider?.refresh();
  if (!statusItem || !tracker) return;
  const display = vscode.workspace
    .getConfiguration("lemmaria.cost")
    .get<string>("display", "both");
  if (display !== "statusbar" && display !== "both") {
    statusItem.hide();
    return;
  }
  const run = tracker.lastRun ? formatCostBucket(tracker.lastRun) : undefined;
  const today = formatCostBucket(tracker.shown.today);
  // The day in the reader's one language, like the tooltip beside it. It
  // read `today/今日` to every reader, which invariant 6 rule 2 rules out
  // (ADR 0034); the guard missed it because the slash had no spaces.
  statusItem.text = `$(graph) ${run ? `${run} · ` : ""}${today} ${chrome("costToday")}`;
  statusItem.tooltip = new vscode.MarkdownString(
    costLines()
      .map((l) => `**${l.label}:** ${l.value}`)
      .join("\n\n"),
  );
  statusItem.show();
}

function showCost(): void {
  const lines = costLines()
    .map((l) => `${l.label}: ${l.value}`)
    .join(" · ");
  void vscode.window.showInformationMessage(
    `${chrome("costTitle")} — ${lines}`,
  );
}

export function registerCost(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  tracker = new CostTracker(context.globalState);
  provider = new CostTreeProvider();
  statusItem = vscode.window.createStatusBarItem(
    "lemmaria.cost",
    vscode.StatusBarAlignment.Right,
    99,
  );
  statusItem.name = "Lemmaria Cost";
  statusItem.command = "lemmaria.showCost";
  context.subscriptions.push(
    statusItem,
    vscode.window.registerTreeDataProvider("lemmariaCost", provider),
    vscode.commands.registerCommand("lemmaria.showCost", showCost),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lemmaria.cost.display")) refreshUi();
    }),
  );
  refreshUi();
}
