import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  type RestoreStep,
  type SessionLocale,
  cutBeforeItem,
  manifestAt,
  restoreBaselines,
  restorePlan,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { type ChromeKey, tr } from "./chrome-strings";
import { currentLocale } from "./i18n";
import {
  branchPointsOf,
  isTaskInFlight,
  noteActivePaper,
  proposalFileDiffFor,
  rewindConversation,
} from "./session-host";
import {
  proposedEditTitle,
  restoreFailedLine,
  withCaveats,
} from "./session-labels";
import { sessionStoreDir } from "./session/lifecycle";
import { sessionEditRoot } from "./session/registry";
import {
  currentSession,
  currentStore,
  sessionStoreFor,
  snapshotStore,
} from "./session/session-state";
import { guardedRestore, previewRestore } from "./session/snapshot-host";

/**
 * A1b (ADR 0016, revised by ADR 0031): the session write-path UI seams that
 * live outside the webview — the on-demand read-only diff for one FILE of a
 * proposal, and the branch control. Approval/rejection and the ⟲ affordance
 * itself live in the webview transcript; this is the "view diff" and "move the
 * files with the conversation" side.
 */

const DIFF_SCHEME = "lemmaria-session-edit";

/**
 * How a restore reaches the live UI. Registered by the view layer so the
 * palette command and the transcript's ⟲ share ONE restore path — otherwise
 * the palette reverts files and rewinds the store while the open transcript
 * keeps showing turns the model can no longer see (round-2 review I2).
 */
interface RestoreSink {
  /** Switch the host to the session the fork created (ADR 0057). */
  onForked: (childId: string) => Promise<boolean>;
  onRewound: (text: string) => void;
  /**
   * E6 (D8): the worktree moved and the conversation did NOT — the
   * restore-only arm. The panel has no transcript change to make; what it must
   * do is re-read what the Sessions view says about disk, because the active
   * session's leaf now names bytes that are no longer there (ADR 0058 §7).
   */
  onRestored: () => void;
}

let restoreSink: RestoreSink | undefined;

export function onSessionRestore(sink: RestoreSink): void {
  restoreSink = sink;
}
/** id → text for the two virtual sides of a pending diff. */
const diffContents = new Map<string, string>();

/** One chrome string in the reader's language (D4; invariant 6 rule 2,
 *  ADR 0034). Re-read per call: `currentLocale()` is not a constant. */
const chrome = (key: ChromeKey): string => tr(currentLocale(), key);

/**
 * Open a read-only side-by-side diff for ONE FILE of a proposal — all of that
 * file's edits combined, because the file is the approval unit (finding 2b).
 */
export async function showSessionEditDiff(
  itemId: string,
  file: string,
): Promise<void> {
  const sides = await proposalFileDiffFor(itemId, file);
  if (!sides) {
    void vscode.window.showInformationMessage(chrome("editPreviewGone"));
    return;
  }
  const base = `${itemId}-${encodeURIComponent(file)}`;
  const leftUri = vscode.Uri.parse(
    `${DIFF_SCHEME}:${encodeURIComponent(sides.file)}?${base}-current`,
  );
  const rightUri = vscode.Uri.parse(
    `${DIFF_SCHEME}:${encodeURIComponent(sides.file)}?${base}-proposed`,
  );
  diffContents.set(leftUri.toString(), sides.current);
  diffContents.set(rightUri.toString(), sides.proposed);
  const title = proposedEditTitle(sides.file, currentLocale());
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    title,
    { preview: true },
  );
}

/**
 * Which halves of a rewind the user asked for (E6, D8, ADR 0058 §4).
 *
 * ADR 0057 treated a rewind as one indivisible act, and ADR 0031 before it. The
 * operator's round found that this is two operations wearing one name: *fork
 * the conversation from here* and *put the code back to here* are separately
 * wanted, and the pair together is E5's behaviour unchanged. So the control
 * offers three arms, and this type is what it offers.
 */
export type RewindArm = "fork" | "restore" | "both";

/**
 * A restore plan the user has been shown and not yet answered.
 *
 * **Why it is held rather than recomputed.** The plan and its `expected` shas
 * are what the consent surface NAMED; applying anything else would be asking
 * about one thing and doing another. This is the same compute-once-apply-that
 * window the OS modal had — a modal is a promise awaited inline, and moving
 * the question into the webview is what turns that promise into a map entry.
 */
interface PendingRewind {
  readonly messageId: string;
  readonly arm: "restore" | "both";
  readonly plan: readonly RestoreStep[];
  readonly expected: ReadonlyMap<string, string | null>;
}

/**
 * The plans awaiting an answer, by nonce.
 *
 * **Cleared on every new question, from either route**, which is what makes a
 * superseded plan un-applicable rather than merely unlikely: there is one
 * popover and one palette command, so at most one question is live, and a
 * decision that arrives for an older one is an answer to a question the user
 * replaced. The palette route clears it too (E6 code review) — it computes and
 * applies its own plan without ever storing one, so a card left open in the
 * panel would otherwise still be confirmable afterwards, against a worktree
 * the palette command had already moved. Deleted at the moment of use, BEFORE
 * the async restore, so a duplicate arriving mid-flight cannot apply the same
 * plan twice.
 */
const pendingRewinds = new Map<string, PendingRewind>();

/** What a consent surface has to name before anything is written. */
export interface RewindPreview {
  nonce: string;
  messageId: string;
  withFork: boolean;
  /** Workspace-relative paths whose contents would be rewritten. */
  files: string[];
  /** Workspace-relative paths that would be removed from disk. */
  deletions: string[];
}

/** The restore plan for one message, or `undefined` when there is nothing to cut. */
async function planFor(messageId: string): Promise<
  | {
      plan: RestoreStep[];
      expected: ReadonlyMap<string, string | null>;
    }
  | undefined
> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return undefined;
  let loaded: Awaited<ReturnType<typeof store.load>>;
  try {
    loaded = await store.load(session.id);
  } catch {
    return undefined;
  }
  const cut = cutBeforeItem(loaded.entries, messageId);
  // ADR 0018's rule, carried forward onto every arm: an unresolvable target
  // refuses rather than widening the move. `=== undefined`, never `!cut`: 0 is
  // a legitimate cut (ADR 0057).
  if (cut === undefined) return undefined;
  // Two manifests over ONE session (ADR 0057 §8): where the files are now, and
  // where they were before that message. No leaf, no tree, no second history.
  const here = manifestAt(loaded.entries);
  const target = manifestAt(loaded.entries.slice(0, cut));
  return {
    plan: restorePlan(here, target),
    expected: restoreBaselines(here, target),
  };
}

/**
 * Step one of a restoring arm: compute the plan, hold it, and describe it.
 *
 * Writes nothing. The caller puts what this returns in front of the user, and
 * the answer comes back to {@link decideRewind}.
 */
export async function previewRewind(
  messageId: string,
  withFork: boolean,
): Promise<RewindPreview | undefined> {
  if (isTaskInFlight()) {
    void vscode.window.showInformationMessage(chrome("rewindBusy"));
    return undefined;
  }
  const computed = await planFor(messageId);
  if (computed === undefined) {
    // The one refusal on this path that used to say nothing at all (E6 code
    // review). The webview gets its arms back either way — see the
    // `rewindPreviewRefused` push — but a menu that quietly re-arms is still a
    // click that did nothing, so name the reason.
    void vscode.window.showInformationMessage(chrome("rewindNoPlan"));
    return undefined;
  }
  const { plan, expected } = computed;
  const preview = await previewRestore(sessionEditRoot(), plan, expected);
  // No workspace folder, and files to place, is refused HERE rather than
  // consented to and then failed: `guardedRestore` aborts on it anyway, and
  // the arm that does work for a user with no folder open — fork only — is one
  // row above in the same menu. An EMPTY plan is not this case: a zero-file
  // rewind succeeds with no root, and refusing it would take away something E5
  // could do.
  if (plan.length > 0 && preview === undefined) {
    void vscode.window.showInformationMessage(chrome("rewindNoWorkspace"));
    return undefined;
  }
  // One question live at a time. See `pendingRewinds`.
  pendingRewinds.clear();
  const nonce = randomUUID();
  pendingRewinds.set(nonce, {
    messageId,
    arm: withFork ? "both" : "restore",
    plan,
    expected,
  });
  return {
    nonce,
    messageId,
    withFork,
    files: preview?.rewritten ?? [],
    deletions: preview?.deleted ?? [],
  };
}

/**
 * Step two: the answer to one consent card.
 *
 * An unknown nonce is dropped SILENTLY — no toast. It means the plan was
 * superseded, already answered, or declined by a webview that closed its card
 * (a transcript re-render does exactly that), and none of those is news the
 * user needs. A decline is the same drop, with the entry released.
 */
export async function decideRewind(
  context: vscode.ExtensionContext,
  nonce: string,
  confirmed: boolean,
): Promise<boolean> {
  const pending = pendingRewinds.get(nonce);
  // Spent before the await, never after: a duplicate confirm arriving while
  // `guardedRestore` runs would otherwise apply the same plan twice.
  pendingRewinds.delete(nonce);
  if (pending === undefined || !confirmed) return false;
  return await rewindFromMessage(context, pending.messageId, pending.arm, {
    consented: { plan: pending.plan, expected: pending.expected },
  });
}

/**
 * Test seam (D9), the `setSessionPickerForTests` precedent: replace the
 * rewind QuickPicks so an ext-host test can drive the palette command's REAL
 * path — the A1a lesson that a handler-level test stays green over a dead
 * button. Returns the label picked, or `undefined` for Esc.
 */
let rewindPicker:
  | ((
      items: readonly vscode.QuickPickItem[],
      title: string,
    ) => string | undefined)
  | undefined;

export function setRewindPickerForTests(
  picker?: (
    items: readonly vscode.QuickPickItem[],
    title: string,
  ) => string | undefined,
): void {
  rewindPicker = picker;
}

async function pick(
  items: vscode.QuickPickItem[],
  title: string,
  placeHolder: string,
): Promise<string | undefined> {
  if (rewindPicker) return rewindPicker(items, title);
  const chosen = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
  });
  return chosen?.label;
}

/**
 * The palette command's consent surface (D9).
 *
 * A QuickPick and not the card, because this command can fire with no panel
 * open — and VS Code-native rather than an OS modal, which is what the
 * operator asked for when they asked the chime to go. **Every path is a row**,
 * so the same promise the card makes holds here with no cap at all: invariant
 * 3 is names-every-file-before-consent, and a list the user scrolls names more
 * of them than a sentence can. Taking any row is the consent; Esc is the
 * refusal, which is the native gesture for exactly that.
 */
async function confirmByQuickPick(
  plan: readonly RestoreStep[],
  expected: ReadonlyMap<string, string | null>,
  arm: "restore" | "both",
): Promise<boolean> {
  const locale = currentLocale();
  // One question live at a time, whichever route asked it. See
  // `pendingRewinds`: this route stores nothing, so clearing is all it owes.
  pendingRewinds.clear();
  const preview = await previewRestore(sessionEditRoot(), plan, expected);
  if (plan.length > 0 && preview === undefined) {
    void vscode.window.showInformationMessage(chrome("rewindNoWorkspace"));
    return false;
  }
  const rows: vscode.QuickPickItem[] = [
    ...(preview?.rewritten ?? []).map((file) => ({
      label: file,
      description: chrome("rewindWillRestore"),
    })),
    ...(preview?.deleted ?? []).map((file) => ({
      label: file,
      description: chrome("rewindWillDelete"),
    })),
  ];
  // An empty plan still asks, and needs a row to be answerable with: consent
  // proceeds uniformly, because a plan that turns out to change nothing is a
  // fact about the worktree rather than a reason to skip the question.
  if (rows.length === 0) rows.push({ label: chrome("rewindNoFiles") });
  // Spelled out rather than folded into one `chrome(cond ? a : b)`: the
  // chrome-strings reachability test reads the SOURCE for `chrome("key")`, and
  // a key it cannot see there is a key it reports as unused.
  const question =
    arm === "both" ? chrome("rewindAskBoth") : chrome("rewindAskRestore");
  return (
    (await pick(rows, question, chrome("rewindPickConfirm"))) !== undefined
  );
}

/**
 * ADR 0031, as re-routed by ADR 0057 and decomposed by ADR 0058 §4: take one
 * arm of a rewind at a message.
 *
 * - **fork** — cut, fork, resume, prefill. Writes no user file, so invariant 3
 *   asks nothing of it and it needs no consent surface at all.
 * - **restore** — the plan only. No fork, no resume, no prefill: the transcript
 *   stays exactly where it is, still holding the message whose write was
 *   undone, and the Sessions view is refreshed because the active session's
 *   leaf no longer matches disk (ADR 0058 §7).
 * - **both** — E5's sequence, unchanged: restore the files while THIS session
 *   is still current, then fork, then switch to the child. Its four aborts and
 *   its drift semantics are the same; the order is ADR 0057 §2's, and it is
 *   still the only order.
 *
 * Consent for the two restoring arms is the CALLER's, given either as a
 * `consented` plan (the webview card, answered through `decideRewind`) or by
 * the QuickPick above (the palette command). `skipConfirm` is E5's test seam,
 * preserved on the refactored function.
 */
export async function rewindFromMessage(
  context: vscode.ExtensionContext,
  messageId: string,
  arm: RewindArm,
  opts?: {
    skipConfirm?: boolean;
    /** A plan already consented to, applied EXACTLY as it was named. */
    consented?: {
      plan: readonly RestoreStep[];
      expected: ReadonlyMap<string, string | null>;
    };
    onForked?: (childId: string) => Promise<boolean>;
    onRewound?: (text: string) => void;
  },
): Promise<boolean> {
  // A consented plan already passed this check at preview time; the one that
  // matters for it is the post-consent re-check below, whose message says so.
  if (!opts?.consented && isTaskInFlight()) {
    void vscode.window.showInformationMessage(chrome("rewindBusy"));
    return false;
  }
  const locale = currentLocale();

  // The fork-only arm builds no plan: there is nothing to restore, and
  // `rewindConversation` performs the same unresolvable-target refusal.
  if (arm === "fork") return await forkAndPrefill(messageId, opts, [], false);

  let plan: readonly RestoreStep[];
  let expected: ReadonlyMap<string, string | null>;
  if (opts?.consented) {
    ({ plan, expected } = opts.consented);
  } else {
    const computed = await planFor(messageId);
    if (computed === undefined) return false;
    plan = computed.plan;
    expected = computed.expected;
    if (!opts?.skipConfirm && !(await confirmByQuickPick(plan, expected, arm)))
      return false;
  }

  // Re-check after consent: a task started meanwhile would have its files
  // moved under it (B6 round-2 review I4, same hazard, same fix). Preserved
  // exactly where the modal had it.
  if (isTaskInFlight()) {
    void vscode.window.showInformationMessage(chrome("rewindBusyAfterConsent"));
    return false;
  }

  // Guarded: a missing workspace root and a rejected write are both reported,
  // never swallowed (`guardedRestore`). The files move BEFORE the conversation,
  // while THIS session is still the current one — so the drift baseline is what
  // it last wrote (ADR 0031 §6).
  const restore = await guardedRestore({
    root: sessionEditRoot(),
    plan,
    store: snapshotStore(context),
    expected,
    locale,
  });
  if (!restore.complete && restore.outcome === undefined) {
    // The restore did not run, or threw part-way. Do NOT fork on top of it:
    // leaving the conversation where it is keeps the two halves recoverable —
    // the plan is a fold over the log, so taking the arm again recomputes it
    // and re-applies whatever did not land. Forking now would move the user
    // into a session whose prefix does not match the half-applied files, and
    // there is no second control that puts THAT back.
    void vscode.window.showErrorMessage(
      restoreFailedLine(restore.caveats, arm, locale),
    );
    return false;
  }

  if (arm === "restore") {
    // The worktree moved and the conversation did not — so there is nothing to
    // prefill and nobody to switch to, and the one thing that MUST happen is
    // that the Sessions view stops claiming this session matches disk.
    restoreSink?.onRestored();
    void vscode.window.showInformationMessage(
      withCaveats(chrome("rewindRestored"), restore.caveats, locale),
    );
    return true;
  }
  return await forkAndPrefill(messageId, opts, restore.caveats, true);
}

/**
 * Fork the conversation at `messageId`, switch to the child, and hand the
 * message back to the composer — the half both forking arms share.
 *
 * `caveats` is what the restore, if there was one, could not do; it rides the
 * success toast rather than replacing it, which is ADR 0057's honest
 * degradation: name what did not go to plan instead of reporting a clean
 * success over it.
 */
async function forkAndPrefill(
  messageId: string,
  opts:
    | {
        onForked?: (childId: string) => Promise<boolean>;
        onRewound?: (text: string) => void;
      }
    | undefined,
  caveats: readonly string[],
  restored: boolean,
): Promise<boolean> {
  const locale = currentLocale();
  let text: string | undefined;
  try {
    text = await rewindConversation(
      messageId,
      opts?.onForked ?? restoreSink?.onForked,
    );
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    // ADR 0057, and now in two forms because the arms fail differently. After
    // a restore the two halves DISAGREE — the files moved and the session in
    // front of the user still holds that message — which is what `rewindStuck`
    // reports, and why it tells them to try again or start fresh. The
    // fork-only arm moved no file, so nothing disagrees: it is a plain
    // refusal. It still SPEAKS (E6 code review) — `rewindConversation` returns
    // nothing for a failed fork and a failed SWITCH as well as for an id no
    // message carries, so "the click did nothing and said nothing" was
    // reachable without a corrupt log.
    void vscode.window.showWarningMessage(
      restored ? chrome("rewindStuck") : chrome("forkFailed"),
    );
    return false;
  }
  (opts?.onRewound ?? restoreSink?.onRewound)?.(text);
  void vscode.window.showInformationMessage(
    withCaveats(chrome("rewindForked"), caveats, locale),
  );
  return true;
}

/**
 * Activation hygiene (ADR 0031), replacing B6's git-ref sweep.
 *
 * FAIL CLOSED. To know a blob is unreferenced you must read EVERY session log
 * and collect every sha in every `fileStates`. If any log cannot be read — an
 * I/O error, a session being appended to right now — or cannot be read IN
 * FULL — a torn tail write — the reference set is silently missing shas, and
 * sweeping on it destroys drafts with no object database underneath to
 * recover them from (unlike B6's git stash, which `git fsck --dangling`
 * could still find).
 *
 * This is the B6 review's Critical (`listSessions` returning `[]` on an
 * unreadable store, and an empty keep-list meaning "keep nothing") in a place
 * where the consequence is worse: there `list()` degrading is a fine UI
 * fallback, but reusing that degradation here would delete every reachable
 * blob. So: ANY failure anywhere abandons the sweep for this activation.
 *
 * Round-1 review, Critical 1: `SessionStore.load` tolerates a torn tail write
 * on purpose (an unparseable trailing line, or one with a non-string id, is
 * counted into `skippedLines` and skipped, not thrown — see `store.ts`). That
 * is the right behavior for every OTHER reader of a session, which wants the
 * lines that DID parse. It is exactly wrong here: `applyOne` `put`s a batch's
 * blobs before appending the item that names them in `fileStates`
 * (`loop-tools/edit.ts`), so a host killed mid-append of that one line is the
 * torn-tail case — and a `load()` that resolves without throwing must not be
 * read as "this session's shas are complete." Any `skippedLines > 0`
 * abandons the sweep exactly like a throw does.
 */
export async function sweepSnapshotBlobs(
  context: vscode.ExtensionContext,
): Promise<number> {
  const referenced = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(sessionStoreDir(context)).filter((f) =>
      f.endsWith(".jsonl"),
    );
  } catch {
    return 0; // cannot enumerate → cannot know → free nothing
  }
  const store = sessionStoreFor(context);
  for (const file of files) {
    const id = file.slice(0, -".jsonl".length);
    let loaded: Awaited<ReturnType<typeof store.load>>;
    try {
      loaded = await store.load(id);
    } catch {
      return 0; // one unreadable session → abandon the whole sweep
    }
    // A torn tail resolves without throwing — see the doc comment above —
    // but a partially-read log is exactly as incomplete as one that threw.
    if (loaded.skippedLines > 0) return 0;
    // Every entry the session holds. An abandoned draft is another SESSION now
    // (ADR 0057) and is swept on its own pass, so what this guards is the
    // ordinary case: blobs an earlier turn of THIS session still names.
    for (const entry of loaded.entries) {
      const { event } = entry;
      if (event.type !== "item.completed") continue;
      const { item } = event;
      if (item.type !== "edit_proposal" || item.fileStates === undefined)
        continue;
      for (const state of item.fileStates) {
        // `before` is what a rewind restores TO — freeing it makes the
        // rewind silently a no-op.
        if (state.before !== null) referenced.add(state.before);
        referenced.add(state.after);
      }
    }
  }
  // Round-1 review, Important 1: this sweep is fire-and-forget from
  // activation, running concurrently with everything else that starts up —
  // including a task the user starts before the sweep finishes folding logs.
  // `applyOne` puts a batch's blobs before appending the item that names them
  // (see above), so a blob written after `referenced` was gathered but before
  // the shard read below is unreferenced by construction and would otherwise
  // be freed out from under the task that just wrote it. Re-check
  // immediately before sweeping rather than trusting the check at entry.
  if (isTaskInFlight()) return 0;
  return await snapshotStore(context).sweep(referenced);
}

/**
 * The palette entry (`Lemmaria: Restore Files to Before the Last Message`).
 * It has no message of its own, so it takes the newest branch point — which
 * IS the last message — and runs the one rewind path.
 *
 * B6 resolved this to "the session's most recent git snapshot", which in a
 * non-git workspace was always nothing at all: the command existed and could
 * never do anything. There is no such state now.
 *
 * E6 (D9): it offers the SAME three arms as the ⟲ menu, because a command that
 * could only do one of them would be a second, narrower rewind — and the two
 * routes are supposed to converge on `rewindFromMessage`, not to diverge in
 * what they can express.
 */
async function branchFromLastMessage(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  const last = (await branchPointsOf()).at(-1);
  if (last === undefined) {
    void vscode.window.showInformationMessage(chrome("rewindNoMessage"));
    return false;
  }
  const arms: { arm: RewindArm; label: string }[] = [
    { arm: "fork", label: chrome("rewindArmFork") },
    { arm: "restore", label: chrome("rewindArmRestore") },
    { arm: "both", label: chrome("rewindArmBoth") },
  ];
  const chosen = await pick(
    arms.map(({ label }) => ({ label })),
    chrome("rewindPickArm"),
    chrome("rewindPickArm"),
  );
  const arm = arms.find((a) => a.label === chosen)?.arm;
  if (arm === undefined) return false;
  return await rewindFromMessage(context, last, arm);
}

export function registerSessionEdit(context: vscode.ExtensionContext): void {
  noteActivePaper();
  context.subscriptions.push(
    // Keep the sticky paper current: the write path must not evaporate just
    // because a diff, the Assistant webview, or a settings tab took focus.
    vscode.window.onDidChangeActiveTextEditor(() => noteActivePaper()),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent: (uri) =>
        diffContents.get(uri.toString()) ?? "",
    }),
    vscode.commands.registerCommand("lemmaria.restoreSessionCheckpoint", () =>
      branchFromLastMessage(context),
    ),
  );
}
