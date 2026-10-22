import type { SessionEntry } from "../contracts/index.js";

/**
 * What a run of entries knows about one file (ADR 0031): the sha it holds at
 * their end, and the sha it held before they first touched it.
 *
 * `first` is what makes a restore correct in the direction nobody thinks
 * about — leaving one history for another that never touched the file at all.
 * Without it the only options are "leave the departing work on disk" (wrong)
 * or "delete the file" (wrong whenever it existed before the session).
 */
export interface FileHistory {
  /** Content before the FIRST write in this run; `null` = did not exist. */
  first: string | null;
  /** Content after the LAST write in this run. */
  current: string;
}

/**
 * The world as of the end of a run of entries: file → its content identity.
 *
 * Named because ADR 0057 makes it a PARAMETER type and not only a return one:
 * `restorePlan` and `restoreBaselines` now take two of these, where they used
 * to take a session's entries plus two leaf ids and derive the manifests by
 * walking the tree. That walk was the tree's tax on a diff, and a diff of two
 * folds is all either of them ever computed with.
 */
export type FileManifest = Map<string, FileHistory>;

/**
 * A fold, never stored — ADR 0014's rebuildable-index reasoning, one level
 * down from where ADR 0030 applied it. An entry with no `fileStates` (a plain
 * question, or any session written before ADR 0031) contributes nothing, which
 * is why a pre-0031 session degrades to "no file state" instead of lying.
 */
export function manifestAt(entries: readonly SessionEntry[]): FileManifest {
  const manifest: FileManifest = new Map();
  for (const entry of entries) foldFileStates(manifest, entry);
  return manifest;
}

/**
 * Advance a manifest by ONE entry, in place — the fold rule `manifestAt` is
 * made of, exported so a caller that needs the manifest at many prefixes of
 * the same log can carry a running one instead of re-folding from the start.
 *
 * That is what the ⟲ control's file counts do (ADR 0057 §8): one forward pass
 * over the entries, snapshotting the running manifest at each rewind point,
 * instead of a fresh fold per point. Same rule, one implementation, so the
 * count a glyph shows and the plan its click builds cannot drift apart —
 * which is [ADR 0055]'s guarantee.
 */
export function foldFileStates(
  manifest: FileManifest,
  entry: SessionEntry,
): void {
  const { event } = entry;
  if (event.type !== "item.completed") return;
  const { item } = event;
  if (item.type !== "edit_proposal" || item.fileStates === undefined) return;
  for (const state of item.fileStates) {
    const existing = manifest.get(state.file);
    manifest.set(state.file, {
      first: existing ? existing.first : state.before,
      current: state.after,
    });
  }
}

/**
 * File → what Lemmaria believes is on disk right now, for every file a restore
 * from the `from` manifest to the `to` one could touch. The `expected`
 * argument of a restore: what "unchanged since the agent left it" means.
 *
 * `null` is a RECORDED BELIEF — "this file should not exist yet" — and is not
 * the same as a missing key, which means "we have no idea who wrote this".
 * Only the second is drift.
 *
 * Two sources, in priority order, and the second is the one the first cut
 * missed:
 *
 *  1. The DEPARTING manifest's `current`, where it wrote the file. Deliberately
 *     not its `first`: drift is about the bytes on disk now, so where the file
 *     started must not leak in, or a second edit to the same file would read
 *     as a hand edit.
 *  2. Otherwise the TARGET's `first`. A file the departing side never wrote
 *     still got its bytes from Lemmaria — the fork that created that history
 *     put it back to exactly this sha. Without this arm, "fork, try it another
 *     way, go back" — the workflow ADR 0031 exists for — reports every such
 *     file as changed outside Lemmaria, because the departing manifest is
 *     empty and everything compares against `undefined`.
 */
export function restoreBaselines(
  from: FileManifest,
  to: FileManifest,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [file, history] of to) out.set(file, history.first);
  for (const [file, history] of from) out.set(file, history.current);
  return out;
}

/** One file to rewrite, or — with `sha: null` — to delete. */
export interface RestoreStep {
  file: string;
  sha: string | null;
}

/**
 * What must change on disk to go from the world `from` describes to the world
 * `to` describes (ADR 0031, re-signed by ADR 0057).
 *
 * A rewind builds both from ONE session: `manifestAt(entries)` against
 * `manifestAt(entries.slice(0, cut))`. Nothing here knows about sessions,
 * forks or leaves — it is a diff of two folds, which is all it ever was.
 *
 * Two halves, and the second is the one a naive implementation forgets:
 *
 *  1. Every file the TARGET knows whose content differs from where we are —
 *     rewrite it.
 *  2. Every file we touched that the target does NOT know — put it back to
 *     what it was before we first touched it, which is a DELETE when it never
 *     existed. Skipping this leaves the departing work on disk, which is
 *     exactly the files/conversation disagreement ADR 0018 exists to prevent.
 *
 * Files neither side touched appear in no step, so a restore never reads,
 * writes or deletes anything the agent did not write.
 */
export function restorePlan(
  from: FileManifest,
  to: FileManifest,
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  for (const [file, target] of to) {
    if (from.get(file)?.current !== target.current)
      steps.push({ file, sha: target.current });
  }
  for (const [file, leaving] of from) {
    if (!to.has(file)) steps.push({ file, sha: leaving.first });
  }
  return steps;
}
