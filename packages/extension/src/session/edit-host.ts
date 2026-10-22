import { resolve as resolvePath } from "node:path";
import {
  type EditDecision,
  type EditProposalItem,
  type FileManifest,
  type ProposedEdit,
  type SessionEditHost,
  type SessionEditPolicy,
  branchPoints,
  createdFilesSince,
  cutBeforeItem,
  foldFileStates,
  groupEditsByFile,
  manifestAt,
  restorePlan,
  spliceEditsForFile,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import {
  openDocumentFor,
  readThroughBuffer,
  writeThroughBuffer,
} from "./buffer-io";
import { currentSession, currentStore, isTaskInFlight } from "./session-state";

/**
 * The write path over VS Code buffers (ADR 0016/0031) — proposals, the review
 * pause, and the branch queries the transcript draws its control from (B1 split
 * of `session-host.ts`).
 *
 * The loop owns policy branching, validation, revalidation and persistence;
 * this provides IO + the approval UI.
 */

/** A1b (ADR 0016): the session's edit policy — review (ask before edit) by
 *  default; switchable mid-session from the composer permission selector. */
let editPolicy: SessionEditPolicy = "review";
/** A1b: the pending review pause — the webview resolves it with per-edit
 *  decisions (or the loop's abort race resolves it undefined). */
let pendingDecision:
  | { itemId: string; resolve: (d: EditDecision[] | undefined) => void }
  | undefined;
/**
 * A1b: proposals by id, each WITH the workspace root its task ran against —
 * the diff-on-demand source. The root is captured here rather than re-derived
 * from `vscode.window.activeTextEditor` at diff time: opening a diff makes the
 * DIFF the active editor, which broke every subsequent "View diff" in the
 * batch (finding 2a). Storing it per proposal, not globally, also keeps a
 * later task over a different paper from re-rooting an older proposal.
 */
const proposalsById = new Map<
  string,
  { item: EditProposalItem; root: string }
>();
/** Set by the view layer so the branch-point faces can be pushed eagerly. */
let notifyRestorePoints: (() => void) | undefined;
export function onRestorePointsChanged(notify: () => void): void {
  notifyRestorePoints = notify;
}
/** Called when a task ends: the branch may safely move again. */
export function pushRestorePoints(): void {
  notifyRestorePoints?.();
}

/**
 * The write-path host (ADR 0016) over VS Code buffers. All paths are
 * workspace-relative to `root`; open dirty buffers win over disk (the ADR 0002
 * layering). No active paper → no host, and the session stays read-only.
 */
export function buildSessionEditHost(
  root: string,
  sessionId: string,
): SessionEditHost {
  const absOf = (file: string): vscode.Uri =>
    vscode.Uri.file(resolvePath(root, file));
  return {
    policy: () => editPolicy,
    // Both halves are the shared buffer seam (`buffer-io.ts`), which the
    // restore path uses too — the open-buffer-beats-disk rule must be one
    // implementation, or the write path and the undo path disagree about
    // what the file says.
    readFile: (file) => readThroughBuffer(absOf(file)),
    writeFile: (file, content) => writeThroughBuffer(absOf(file), content),
    fileExists: async (file) => {
      try {
        await vscode.workspace.fs.stat(absOf(file));
        return true;
      } catch {
        return false;
      }
    },
    requestDecisions: (item) => {
      proposalsById.set(item.id, { item, root });
      return new Promise<EditDecision[] | undefined>((resolve) => {
        // A newer pause supersedes an older unresolved one (defensive; the loop
        // is single-flight): resolve the stale one as no-decision.
        pendingDecision?.resolve(undefined);
        pendingDecision = { itemId: item.id, resolve };
      });
    },
    // ADR 0031 removed `ensureCheckpoint` from `SessionEditHost`: the write
    // host takes no snapshot of its own. Every applied write is content-
    // addressed into the blob store as it lands, and what the files did is
    // read back off the session log — so there is no git ref, and therefore no
    // git repository, anywhere on this path.
  };
}

/**
 * Fires once per edit the agentic write path actually LANDED on disk, under
 * either policy. The Edits view (`sidebar-ui.ts`) is its only listener.
 *
 * That view was wired to `onProposalAccepted` alone — the M4 quick-action
 * inline-diff Accept — so every `propose_edit` write since A1b was invisible
 * to it (D4 manual round, checklist item 7). The two write paths now report
 * through the affordance invariant 3 promises the user: one place that lists
 * every change Lemmaria made, and offers to roll the newest one back.
 */
export const onSessionEditApplied = new vscode.EventEmitter<{
  fsPath: string;
  file: string;
  /** 1-based; the replacement's position, or 1 when it cannot be located. */
  line: number;
}>();

/**
 * Which `${itemId}#${index}` pairs have already been reported. `recordProposal`
 * is called for the pending record AND the terminal one, and a review pause
 * re-emits the same item — without this the reviewer's single Accept would add
 * the row twice.
 */
const reportedEdits = new Set<string>();

/**
 * The 1-based line an applied edit landed on, when we can know it cheaply.
 *
 * The file has already been written, so the anchor is gone and the REPLACEMENT
 * is what is there now. An open document can be searched synchronously; a file
 * that is not open falls back to line 1 rather than paying an async read on the
 * event path — the row's job is to name the change and open the file, and a
 * created file starts at line 1 anyway.
 */
function appliedLine(uri: vscode.Uri, edit: ProposedEdit): number {
  const needle = edit.kind === "create" ? undefined : edit.replacement;
  if (needle === undefined || needle === "") return 1;
  const open = openDocumentFor(uri);
  if (!open) return 1;
  const at = open.getText().indexOf(needle);
  return at < 0 ? 1 : open.positionAt(at).line + 1;
}

/** Keep the diff-on-demand source current for every proposal a task emits. */
export function recordProposal(item: EditProposalItem, root: string): void {
  proposalsById.set(item.id, { item, root });
  for (const [i, edit] of item.edits.entries()) {
    if (edit.status !== "applied") continue;
    const key = `${item.id}#${i}`;
    if (reportedEdits.has(key)) continue;
    reportedEdits.add(key);
    const uri = vscode.Uri.file(resolvePath(root, edit.file));
    onSessionEditApplied.fire({
      fsPath: uri.fsPath,
      file: edit.file,
      line: appliedLine(uri, edit),
    });
  }
}

/** A1b: the composer permission selector switches the session's edit policy. */
export function setEditPolicy(policy: SessionEditPolicy): void {
  editPolicy = policy;
}

/** A1b: the current edit policy (pushed to the webview on ready/change). */
export function currentEditPolicy(): SessionEditPolicy {
  return editPolicy;
}

/**
 * A1b: the webview submits the pending proposal's per-edit decisions. Returns
 * false for a stale/duplicate id (the review pause already resolved) — never
 * throws.
 */
export function submitEditDecisions(
  itemId: string,
  decisions: EditDecision[],
): boolean {
  if (!pendingDecision || pendingDecision.itemId !== itemId) return false;
  const resolve = pendingDecision.resolve;
  pendingDecision = undefined;
  resolve(decisions);
  return true;
}

/** The proposal this host is currently parked on, for the snapshot path. */
export function livePendingProposal(): EditProposalItem | undefined {
  if (!pendingDecision) return undefined;
  return proposalsById.get(pendingDecision.itemId)?.item;
}

/**
 * A1b: the on-demand diff source — the file's current content (left) and the
 * proposed content (right: the splice for a replace, the new content for a
 * create), for a read-only side-by-side (webview showEditDiff). undefined when
 * the id/index is unknown, there is no active paper, or the anchor no longer
 * locates (the edit is stale — nothing meaningful to diff).
 */
export async function proposalFileDiffFor(
  itemId: string,
  file: string,
): Promise<{ file: string; current: string; proposed: string } | undefined> {
  const record = proposalsById.get(itemId);
  if (!record) return undefined;
  // The root is the one THIS proposal's edit host was built on, never the
  // active tab — the first diff steals focus and would strand the rest
  // (finding 2a) — and never a later task's root either.
  const { item, root } = record;
  const group = groupEditsByFile(item.edits).find((g) => g.file === file);
  if (!group) return undefined;
  // Preview exactly what a decision would apply: the still-pending edits.
  // Including an `invalid` sibling would make one bad anchor refuse the whole
  // file — reintroducing the very "cannot be previewed" toast this fixed.
  const edits = group.indices.flatMap((i) => {
    const edit = item.edits[i];
    return edit && edit.status === "pending" ? [edit] : [];
  });
  if (edits.length === 0) return undefined;
  const host = buildSessionEditHost(root, item.id);
  // A batch that creates the file has no "current" side to read.
  const current = edits.some((e) => e.kind === "create")
    ? ""
    : await host.readFile(file);
  if (current === undefined) return undefined;
  const proposed = spliceEditsForFile(current, edits);
  if (proposed === undefined) return undefined;
  return { file, current, proposed };
}

/**
 * A1b: the files this session CREATED and applied — from the persisted
 * `applied` create events (bookkeeping, not filesystem archaeology).
 */
export async function sessionCreatedFiles(turnKey?: string): Promise<string[]> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return [];
  const loaded = await store.load(session.id);
  // Restoring ONE turn deletes only what that turn (and later ones) created —
  // a file made two turns ago survives, exactly as its edits do.
  if (turnKey !== undefined) return createdFilesSince(loaded.items, turnKey);
  const first = loaded.items.find((i) => i.type === "user_message");
  return first ? createdFilesSince(loaded.items, first.id) : [];
}

/**
 * ADR 0031: every message the conversation can branch at. Empty while a task
 * is live — the branch must not move under a running task.
 */
export async function branchPointsOf(): Promise<string[]> {
  const store = currentStore();
  const session = currentSession();
  if (isTaskInFlight() || !store || !session) return [];
  try {
    return branchPoints((await store.load(session.id)).items);
  } catch {
    return [];
  }
}

/*
 * E4 (ADR 0054) DELETED `writingBranchPoints()` from here — the subset of
 * `branchPointsOf` whose branch point had file changes after it, which existed
 * solely to pick the ⟲ glyph over the ⑂ one. One face now serves every branch
 * point, so the only consumer is gone; per the no-backward-compatibility-burden
 * convention it is removed rather than left unread. What it computed is still
 * computed where it is acted on: `branchFromMessage` builds the same
 * `restorePlan` and `previewRestore` names its files in the confirm modal.
 *
 * E7 (ADR 0055) buys the FOLD back — and only the fold — as
 * `rewindPointsOf()` below. The boolean it produced does not return: a face is
 * not what the operator's J1 round asked for, a number is.
 */

/** E7 (ADR 0055): one branch point, and what clicking it would cost. */
export interface RewindPoint {
  /** The `user_message` id the conversation can branch at. */
  id: string;
  /**
   * How many files `branchFromMessage(id)` would change, counted from the
   * CURRENT leaf — never from what this message's own turn wrote. The two
   * differ the moment a later turn writes, which is the whole reason the
   * operator chose this rule (ADR 0055 §1).
   */
  files: number;
}

/**
 * ADR 0055: `branchPointsOf`, with the click's blast radius on each point.
 *
 * The number is `restorePlan(manifestAt(entries), manifestAt(entries.slice(0,
 * cut)))` counted — the same plan `branchFromMessage` will build and
 * `previewRestore` will describe by path in the confirm modal. `restorePlan`
 * reads NO filesystem and its two loops are disjoint, so this is a count of
 * distinct files that no drift can move, and the modal stays the gate: this is
 * a hint in front of it, never a substitute for it (invariant 3).
 *
 * **Deliberately not `previewRestore`.** That routine resolves every step
 * against the workspace root and reads each file through its buffer; running
 * it per branch point would put a per-file disk read on every push — on
 * resume, on the `ready` handshake, on every rewind and in every task's
 * `finally`. ADR 0055 §1 records the two narrow cases where the two numbers
 * differ, both of which leave the glyph reading HIGH rather than low.
 *
 * **ONE forward pass** (ADR 0057 §8). E7 shipped this as a fresh `restorePlan`
 * per point, and each of those rebuilt an index over every entry in the log
 * twice — O(points × total entries), recorded as a finding at E7's gate. A
 * linear file lets a single walk carry a running manifest and snapshot it at
 * each point, so the cost is O(entries × files). The number is unchanged: it
 * is the same fold rule (`foldFileStates`) against the same leaf manifest.
 */
export async function rewindPointsOf(): Promise<RewindPoint[]> {
  const store = currentStore();
  const session = currentSession();
  if (isTaskInFlight() || !store || !session) return [];
  try {
    const loaded = await store.load(session.id);
    const points = branchPoints(loaded.items);
    const wanted = new Set(points);
    // The prefix manifest at each point's cut, taken BEFORE the entry that
    // carries the item is folded in — the first such entry, since an item can
    // be persisted twice (`cutBeforeItem`'s first-record rule).
    const cuts = new Map<string, FileManifest>();
    const running: FileManifest = new Map();
    for (const entry of loaded.entries) {
      const { event } = entry;
      if (
        event.type === "item.completed" &&
        wanted.has(event.item.id) &&
        !cuts.has(event.item.id)
      )
        cuts.set(event.item.id, new Map(running));
      foldFileStates(running, entry);
    }
    // `running` is now the leaf manifest — the same walk answers both sides.
    return points.map((id) => {
      const to = cuts.get(id);
      // `undefined` = no record carries that item, so a rewind would refuse
      // rather than widen the move (ADR 0018). Nothing would change: 0.
      //
      // The tooltip is then APPROXIMATE in that one sub-degenerate case: it
      // says "no file changes" where the click will refuse outright rather
      // than rewind cleanly. Reachable only from a torn log — `emitItem`
      // always emits `item.completed`, so every id `branchPoints` returns has
      // a record — and 0 is still the honest answer to *what would this
      // change*.
      return {
        id,
        files: to === undefined ? 0 : restorePlan(running, to).length,
      };
    });
  } catch {
    return [];
  }
}

/**
 * ADR 0018 as superseded by ADR 0027 and then by ADR 0057: **fork** the
 * session before `messageId`, so that message and everything after it leave
 * the conversation the user is in — and therefore leave the model's history,
 * since both are projections of the same entries. The thread genuinely
 * continues from that point instead of carrying turns whose file changes were
 * just reverted.
 *
 * What changed from ADR 0018 is what happens to what left: nothing is dropped.
 * What changed from ADR 0027 is *where* it stays — the abandoned turns are now
 * another SESSION, still listed, still loadable, still holding their own
 * `fileStates`, rather than a sibling branch inside one file. The source is
 * never written, which is what makes that true.
 *
 * `onForked` switches the host to the child, and is the caller's because a
 * resume drives the panel (`webview-view.ts`) and this module must not reach
 * up into it. It returns false when the switch did not happen.
 *
 * Returns the rewound message's text so the caller can hand it back to the
 * composer (the Codex convention). `undefined` = the conversation did NOT
 * move — no session, an id no user message carries, a failed fork, or a
 * failed switch. A refusal, never a widened move.
 */
export async function rewindConversation(
  messageId: string,
  onForked?: (childId: string) => Promise<boolean>,
): Promise<string | undefined> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return undefined;
  const loaded = await store.load(session.id);
  const message = loaded.items.find(
    (i) => i.id === messageId && i.type === "user_message",
  );
  if (!message || message.type !== "user_message") return undefined;
  // `=== undefined`, never `!cut`: 0 is a legitimate cut (the message is the
  // first record, and the child starts empty).
  if (cutBeforeItem(loaded.entries, messageId) === undefined) return undefined;
  let child: { id: string };
  try {
    // Untitled, deliberately (ADR 0058 §2): at this instant the child has no
    // message of its own — the one that would have named it is going back to
    // the composer — so inheriting the parent's title is what produced the
    // column of identical rows the operator reported. Its first send names it.
    child = await store.fork(session.id, {
      cutBeforeItemId: messageId,
      title: "",
    });
  } catch {
    // The source is untouched by a failed fork, so the conversation did not
    // move — and the caller must NOT be told that it did.
    return undefined;
  }
  if (!(await resumeCarryingPolicy(child.id, onForked))) return undefined;
  return message.text;
}

/**
 * Switch to a session this host just forked, with the user's standing edit
 * policy carried across the switch (ADR 0057; E6 D11 makes it uniform).
 *
 * A resume calls `startNewSession`, which resets the policy to `review` —
 * right for a session switch, which is a change of subject, and WRONG for a
 * fork: the same conversation is continuing, from an earlier point or from
 * this one, and the design's *what survives untouched* keeps every write-path
 * decision (ADR 0016's two policies among them) exactly as it was. Silently
 * dropping someone out of auto-apply, through a control that says nothing
 * about it, would be changing an approval setting as a side effect.
 *
 * **Only this one.** The `run_script` always-allow cache deliberately does NOT
 * carry over: a resume already treats it as a re-consent rather than a loss
 * (ADR 0020), and executing is the one capability where the safe default is to
 * ask again. That asymmetry is asserted, not merely stated — see the D11 test
 * in `session-branches.test.ts`.
 *
 * **Extracted because E6 has three fork-then-resumes** where E5 had one — the
 * both arm, the fork-only arm and `/fork` — and a carry written at one of them
 * is a carry missing from the other two.
 */
async function resumeCarryingPolicy(
  childId: string,
  onForked?: (childId: string) => Promise<boolean>,
): Promise<boolean> {
  const policy = editPolicy;
  if (onForked && !(await onForked(childId))) return false;
  editPolicy = policy;
  return true;
}

/**
 * `/fork [name]` — fork the ACTIVE session at its end and continue in the child
 * (E6, D10; design §3).
 *
 * No cut, so no `atMessage` and no prefix on the row: the child holds the whole
 * conversation and differs from its parent only in what happens next. Files are
 * untouched — a sideways fork moves no worktree (ADR 0057 §5) — and the
 * composer is left as it is, because nothing was taken out of it.
 *
 * An unnamed fork inherits the parent's title, which is `store.fork`'s
 * `opts.title ?? source.title`. That is design §3 as approved, and it is
 * deliberately the shape ADR 0058 §2 refused for REWIND forks; D10 flags it for
 * the gate rather than deciding it here.
 *
 * `undefined` = the fork did not happen (no session, a failed write, a failed
 * switch). A refusal, never a partial move.
 */
export async function forkSessionAtEnd(
  name: string | undefined,
  onForked?: (childId: string) => Promise<boolean>,
): Promise<string | undefined> {
  const store = currentStore();
  const session = currentSession();
  if (!store || !session) return undefined;
  let child: { id: string };
  try {
    child = await store.fork(
      session.id,
      name === undefined ? {} : { title: name },
    );
  } catch {
    return undefined;
  }
  if (!(await resumeCarryingPolicy(child.id, onForked))) return undefined;
  return child.id;
}

/**
 * A1b: a fresh thread resets the edit policy to the safe default and drops
 * any pending decision (resolved as no-decision so a wedged loop unwinds).
 */
export function resetForNewSession(): void {
  editPolicy = "review";
  pendingDecision?.resolve(undefined);
  pendingDecision = undefined;
  proposalsById.clear();
  reportedEdits.clear();
}

/**
 * A reload is a process death: the loop and its pause promises go with it.
 *
 * ADR 0031 is what makes this a short function. B6 kept a git ref per turn and
 * per branch tip in memory here, so a reload lost every mapping and had to
 * rebuild it by reading refs back out of the repository. There is nothing to
 * rebuild now — what the files did is in the session log, and the bytes are in
 * the blob store, both of which outlive the window on their own.
 */
export function resetQuiet(): void {
  editPolicy = "review";
  pendingDecision = undefined;
  proposalsById.clear();
  reportedEdits.clear();
}

/** The hermetic-suite teardown: like `resetQuiet`, but unwedges a live pause. */
export function resetForTests(): void {
  editPolicy = "review";
  pendingDecision?.resolve(undefined);
  pendingDecision = undefined;
  proposalsById.clear();
  reportedEdits.clear();
}
