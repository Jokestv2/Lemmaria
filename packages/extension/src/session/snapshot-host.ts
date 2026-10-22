import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  RestoreStep,
  SessionLocale,
  SnapshotStore,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import {
  caveatDrifted,
  caveatMissingSnapshots,
  caveatNoWorkspace,
  caveatRestoreThrew,
} from "../session-labels";
import {
  deleteThroughBuffer,
  readThroughBuffer,
  writeThroughBuffer,
} from "./buffer-io";

export interface RestoreOutcome {
  written: string[];
  deleted: string[];
  /** On-disk bytes were not what Lemmaria last wrote. Captured before overwrite. */
  drifted: string[];
  /** The step's blob is gone from the store; the file was left untouched. */
  missing: string[];
}

/**
 * The one content-identity function on the extension side.
 *
 * Exported because the Sessions view's out-of-sync marker (ADR 0058 §7) asks
 * the SAME question this module's drift check asks — *does this file still
 * hold what Lemmaria wrote?* — and two hashes of the same bytes computed two
 * ways is a divergence nothing would catch until a row lied.
 */
export const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

/**
 * Execute a `restorePlan` against the worktree (ADR 0031).
 *
 * Five rules the caller depends on:
 *
 *  - **Nothing outside `root` is ever touched.** A step whose path escapes it
 *    is skipped, not clamped — ADR 0018's containment, carried forward.
 *  - **A step whose file already holds the target bytes does nothing**, and is
 *    named in no outcome list. The plan is a fold over the LOG, so taking the
 *    same arm twice builds the same plan both times — the worktree is the only
 *    thing that moved, and this is where that is noticed. It is the rule the
 *    `sha: null` branch has always had (a file already gone is not a deletion),
 *    stated for the rewrite branch, which used to write regardless: a second
 *    rewind re-wrote every file with its own contents, bumping mtimes and
 *    pushing an undo stop into every open editor to reach a state already
 *    reached. Compared against `step.sha` — where we are GOING — and never
 *    against `expected`, which answers the different question below.
 *  - **Every read, write and delete goes through the open buffer when there is
 *    one** (`buffer-io.ts`, the same seam `buildSessionEditHost` writes
 *    through). The first cut used `node:fs` directly: restoring a file the
 *    user had open with unsaved changes rewrote the disk correctly and left
 *    the stale buffer on screen, under a modal that had just promised the file
 *    was restored, with the next save putting the stale text back over it —
 *    and the drift check, reading disk, neither reported the unsaved hand edit
 *    nor captured it.
 *  - **A file whose bytes are not what Lemmaria last wrote is captured into
 *    the store before being overwritten**, and named in `drifted` so the caller
 *    can tell the user. The git mechanism this replaces discarded such edits
 *    with only a generic warning; here they are recoverable.
 *  - **`expected` is what Lemmaria believes is on disk** (`restoreBaselines`):
 *    primarily what the branch being LEFT last wrote, and — for a file that
 *    branch never touched — what the TARGET started from, because the fork
 *    that made that branch put the file back to exactly that sha. A file
 *    holding what the agent left there is not drift even though it differs
 *    from where we are going; a file `expected` does not name at all IS drift,
 *    because we are about to overwrite something we never wrote. A recorded
 *    `null` means "should not exist yet", which a file present anyway
 *    contradicts — so `null` is drift while a MISSING key is a different
 *    statement from `null` and both are distinguishable from a sha.
 *    REQUIRED, never optional. An optional `expected` lets a caller silently
 *    forget it and lose drift detection — which is precisely the hazard of
 *    clobbering a user's hand edit that this argument exists to prevent. Pass
 *    an empty Map when a caller genuinely knows nothing was written.
 *
 * A missing blob leaves the file alone rather than truncating it: half a
 * restore is worse than none, and `missing` is how the caller says so.
 */
export async function applyRestorePlan(
  root: string,
  plan: readonly RestoreStep[],
  store: SnapshotStore,
  /**
   * File → the sha Lemmaria believes is on disk (`restoreBaselines`). See the
   * function doc for how it is derived, why it is compared against rather than
   * the target sha, and why it is required rather than optional. `null` = "we
   * believe this file does not exist"; a missing key = "we never wrote it".
   */
  expected: ReadonlyMap<string, string | null>,
): Promise<RestoreOutcome> {
  const out: RestoreOutcome = {
    written: [],
    deleted: [],
    drifted: [],
    missing: [],
  };
  const rootAbs = resolve(root);
  for (const step of plan) {
    const abs = resolve(rootAbs, step.file);
    const rel = relative(rootAbs, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const uri = vscode.Uri.file(abs);

    // The buffer when one is open, so `current` is what the USER is looking at
    // rather than what was last flushed to disk.
    const current = await readThroughBuffer(uri);

    if (step.sha === null) {
      if (current !== undefined) {
        // Capture before deleting: a file the user edited by hand and that this
        // branch created is still their work.
        await store.put(current);
        await deleteThroughBuffer(uri);
        out.deleted.push(step.file);
      }
      continue;
    }

    // Already where we are going: no write, no drift, no capture, and nothing
    // in the outcome. Ahead of the blob read on purpose — a missing blob is
    // only news when the file was left NOT holding the target, and this one
    // holds it. `previewRestore` skips on the identical test, so the card can
    // never name a file this loop will leave alone.
    if (current !== undefined && sha256(current) === step.sha) continue;

    const content = await store.get(step.sha);
    if (content === undefined) {
      out.missing.push(step.file);
      continue;
    }
    if (current !== undefined && sha256(current) !== expected.get(step.file)) {
      out.drifted.push(step.file);
      await store.put(current);
    }
    await writeThroughBuffer(uri, content);
    out.written.push(step.file);
  }
  return out;
}

/** What a restore is about to do, in the three categories a user must consent to. */
export interface RestorePreview {
  /** Files whose contents will be replaced. */
  rewritten: string[];
  /** Files that will be REMOVED from disk — `sha: null` steps. */
  deleted: string[];
  /** Files not holding what Lemmaria wrote; their bytes are captured first. */
  drifted: string[];
}

/**
 * What `applyRestorePlan` would do, computed WITHOUT touching anything.
 *
 * Exists because ADR 0031 §6 promises the user is told which files changed
 * outside Lemmaria **in the confirm modal** — before they consent, not after.
 * The first cut discovered drift inside `applyRestorePlan`, i.e. strictly
 * after confirmation, and surfaced only a count, so the modal could not keep
 * the ADR's promise and the names it had already computed went unused.
 *
 * It also separates a DELETE from a REWRITE. Calling both "restored" is not a
 * wording nit: a `sha: null` step removes the file from disk, and a modal that
 * describes a deletion as a restore is asking for consent to something other
 * than what it is about to do — which is the one thing invariant 3's gate
 * cannot get wrong.
 *
 * Read-only and buffer-aware, so an unsaved hand edit is previewed exactly as
 * `applyRestorePlan` will see it. The two share the containment rule below;
 * a step outside the root is skipped in both, so neither can report a file the
 * other will not touch.
 */
export async function previewRestore(
  root: string | undefined,
  plan: readonly RestoreStep[],
  expected: ReadonlyMap<string, string | null>,
): Promise<RestorePreview | undefined> {
  // `undefined` = no workspace folder, so nothing can be placed. Reported as
  // its own state rather than as an empty preview: empty lists under a
  // non-empty plan would tell the user no file changes, which is the opposite
  // of the truth. `guardedRestore` refuses the same case for the same reason.
  if (root === undefined) return undefined;
  const out: RestorePreview = { rewritten: [], deleted: [], drifted: [] };
  const rootAbs = resolve(root);
  for (const step of plan) {
    const abs = resolve(rootAbs, step.file);
    const rel = relative(rootAbs, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    const current = await readThroughBuffer(vscode.Uri.file(abs));
    if (step.sha === null) {
      if (current !== undefined) out.deleted.push(step.file);
      continue;
    }
    // The same skip `applyRestorePlan` makes, so consent names exactly what
    // the executor will do. Found at E6's drive round: rewinding twice to one
    // message drew a card whose DELETED heading had honestly dropped its path
    // (the file was already gone) beside a RESTORED heading still naming a
    // file already restored — one surface answering the same question two
    // ways, and asking consent for a no-op.
    if (current !== undefined && sha256(current) === step.sha) continue;
    if (current !== undefined && sha256(current) !== expected.get(step.file))
      out.drifted.push(step.file);
    out.rewritten.push(step.file);
  }
  return out;
}

/*
 * E6 (D8, ADR 0058 §4) DELETED `describeRestore` from here — the PROSE form of
 * the preview, built for `showWarningMessage({ modal: true })`'s `detail` and
 * read by nothing else. Consent is a structured surface now: the webview's
 * card renders `rewritten` and `deleted` as its own list nodes, and the
 * palette command's QuickPick renders one row per path. Both take the preview
 * ABOVE, so this module still owns what a restore would do — it no longer owns
 * a sentence about it. Per the no-backward-compatibility-burden convention the
 * builder is removed rather than left unread; its two headings survive
 * verbatim as `rewindCardRestored` / `rewindCardDeleted` in the webview table,
 * so the two surfaces still cannot describe one plan two ways.
 *
 * The one thing the card does NOT carry over is the `drifted` LINE. A drifted
 * file is still named — it is in `rewritten`, so consent names it by path —
 * but the annotation *"changed outside Lemmaria; their current contents will
 * be saved first"* moves to the outcome caveats, which report it after the
 * fact. Recorded in `known-limits.md` as a deliberate narrowing.
 */

/** What a guarded restore actually did, and what to tell the user about it. */
export interface GuardedRestore {
  /**
   * The plan was carried out IN FULL. False means at least one file did not
   * follow the conversation, and the caller must say so rather than report a
   * clean success — a half-moved worktree is the files/conversation
   * disagreement this whole design exists to prevent.
   */
  complete: boolean;
  /** Absent when the plan was never attempted (no root, or it threw). */
  outcome?: RestoreOutcome;
  /**
   * Bilingual, already localized, ready to append to the caller's own success
   * or failure line. Empty = the restore was clean and there is nothing to add.
   */
  caveats: string[];
}

/**
 * `applyRestorePlan` with the two guards every caller needs, in ONE place so
 * the branch control and the branch switch cannot degrade differently.
 *
 * Both were missing after the ADR 0031 port and both are the same class of
 * defect — a promise made to the user that the code does not keep:
 *
 *  - **A missing root.** The port passed `sessionEditRoot() ?? ""`, and
 *    `resolve("")` is `process.cwd()` — the extension host's working
 *    directory, whose containment check then happily passes. A window with no
 *    workspace folder would have had plan files written into it. No root now
 *    means no file restore, said out loud.
 *  - **A rejection.** `store.put` during drift capture, and `mkdir`/write/
 *    delete, throw on EPERM/EBUSY (ordinary on Windows) or a full disk. B6
 *    wrapped its `restoreCheckpoint` in a try/catch with a bilingual message;
 *    the port dropped it, so the rejection escaped into a `void`-ed command
 *    handler and the user was told nothing at all.
 */
export async function guardedRestore(args: {
  root: string | undefined;
  plan: readonly RestoreStep[];
  store: SnapshotStore;
  expected: ReadonlyMap<string, string | null>;
  /** E6 (D13): a locale, not a `zh` boolean — the caveats it builds are
   *  templated, so they live in `session-labels.ts` where both renderings of
   *  each one are asserted. This file now holds no localization ternary. */
  locale: SessionLocale;
}): Promise<GuardedRestore> {
  const { root, plan, store, expected, locale } = args;
  // Nothing to do is not a failure: two branches holding identical files need
  // no writes, and no root is only a problem when there is work to place.
  if (plan.length === 0) return { complete: true, caveats: [] };
  if (root === undefined) {
    return {
      complete: false,
      caveats: [caveatNoWorkspace(plan.length, locale)],
    };
  }
  let outcome: RestoreOutcome;
  try {
    outcome = await applyRestorePlan(root, plan, store, expected);
  } catch (error) {
    return {
      complete: false,
      caveats: [caveatRestoreThrew((error as Error).message, locale)],
    };
  }
  const caveats: string[] = [];
  if (outcome.drifted.length > 0)
    caveats.push(caveatDrifted(outcome.drifted.length, locale));
  if (outcome.missing.length > 0)
    caveats.push(caveatMissingSnapshots(outcome.missing.length, locale));
  // "Complete" is about the plan being carried out, not about it being
  // non-empty. A drifted file DID follow the conversation — its old bytes were
  // saved first — so only a missing blob leaves one behind.
  return { complete: outcome.missing.length === 0, outcome, caveats };
}
