import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Grace period before an unreferenced blob becomes eligible for sweeping
 * (round-1 review, Critical 2): `applyRestorePlan` (`session/snapshot-host.ts`
 * in the extension) captures a user's hand-edited bytes into the store
 * BEFORE overwriting or deleting them, and tells the user, in both languages,
 * that "those contents were saved first" — but that capture is nobody's turn
 * output. It is written into NO session log, so the reference set (which is
 * defined entirely over the logs Task 7 folds) can never contain its sha. A
 * sweep running the moment after such a capture would free it right back out
 * from under the promise the UI just made.
 *
 * The design this store replaced (`git stash`) faces the identical problem —
 * unreachable objects that may be about to become reachable — and does not
 * prune on sight: `gc.pruneExpire` defaults to two weeks. Inheriting that
 * answer is well-founded here for the same reason the rest of this design
 * inherits it. One week rather than two: a blob is one file's one version,
 * not a whole object graph, and every later activation gets another chance to
 * free it, so the cost of erring long is bounded and repeats.
 */
export const SNAPSHOT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Content-addressed blob store (ADR 0031) — one immutable copy of one version
 * of one file, named by the SHA-256 of its bytes.
 *
 * Location-agnostic exactly like `SessionStore`: the extension roots it in
 * globalStorage, a future CLI in `~/.lemmaria/`. Sharded by the hash's first
 * byte so a long session does not put tens of thousands of entries in one
 * directory.
 *
 * Content-addressing is what makes a rewind-then-redo free: two branches
 * holding the same draft hold one blob.
 */
export class SnapshotStore {
  constructor(readonly rootDir: string) {}

  private pathFor(sha: string): string {
    return join(this.rootDir, sha.slice(0, 2), sha);
  }

  /** Store `content`, returning its sha. Idempotent: re-putting is a no-op write. */
  async put(content: string): Promise<string> {
    const sha = createHash("sha256").update(content, "utf8").digest("hex");
    const file = this.pathFor(sha);
    await mkdir(join(this.rootDir, sha.slice(0, 2)), { recursive: true });
    // Content-addressed, so an existing file is byte-identical by construction
    // and rewriting it is harmless — cheaper than a stat to find out.
    await writeFile(file, content, "utf8");
    return sha;
  }

  /** The content for `sha`, or undefined if this store does not hold it. */
  async get(sha: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(sha), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Delete every blob whose sha is NOT in `referenced` AND whose mtime is
   * older than the grace period (`SNAPSHOT_GRACE_MS` by default); returns how
   * many went.
   *
   * The caller is responsible for `referenced` being COMPLETE — see the
   * fail-closed rule in Task 7. This function cannot tell a genuinely
   * unreferenced blob from one whose only reference could not be read, and
   * deleting the second kind destroys a draft with nothing underneath to
   * recover it from. The grace period is a SECOND, independent guard for the
   * one case that is unreferenced by design rather than by a read failure —
   * see `SNAPSHOT_GRACE_MS`'s doc comment.
   *
   * `opts.now`/`opts.graceMs` are a test seam for driving both sides of the
   * grace boundary without sleeping; production leaves both at their
   * defaults.
   *
   * A rejected `stat`/`rm` (vanished between `readdir` and `stat`, or an
   * EPERM/EBUSY — ordinary on Windows) skips that one blob rather than
   * propagating: this is downstream of the reference set either way, so the
   * failure can only make a sweep free FEWER blobs than it might have, never
   * the wrong one — and the activation-time caller (Task 7) must not fail on
   * it, which staying silent here guarantees regardless of who calls this.
   */
  async sweep(
    referenced: ReadonlySet<string>,
    opts?: { now?: number; graceMs?: number },
  ): Promise<number> {
    const now = opts?.now ?? Date.now();
    const graceMs = opts?.graceMs ?? SNAPSHOT_GRACE_MS;
    let freed = 0;
    let shards: string[];
    try {
      shards = await readdir(this.rootDir);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      let blobs: string[];
      try {
        blobs = await readdir(join(this.rootDir, shard));
      } catch {
        continue;
      }
      for (const sha of blobs) {
        if (referenced.has(sha)) continue;
        const path = join(this.rootDir, shard, sha);
        try {
          const { mtimeMs } = await stat(path);
          if (now - mtimeMs < graceMs) continue; // too young — may be about to become reachable
          await rm(path, { force: true });
        } catch {
          continue;
        }
        freed += 1;
      }
    }
    return freed;
  }
}
