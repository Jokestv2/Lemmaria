import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_GRACE_MS,
  SnapshotStore,
} from "../../src/session/snapshot-store.js";

const freshStore = (): SnapshotStore =>
  new SnapshotStore(mkdtempSync(join(tmpdir(), "lemmaria-blobs-")));

describe("SnapshotStore", () => {
  it("round-trips content through its hash", async () => {
    const store = freshStore();
    const sha = await store.put("First … Second …\n");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(sha)).toBe("First … Second …\n");
  });

  it("deduplicates identical content", async () => {
    const store = freshStore();
    const a = await store.put("draft one");
    const b = await store.put("draft one");
    expect(a).toBe(b);
    // One blob on disk, not two: the shard directory holds a single file.
    expect(readdirSync(join(store.rootDir, a.slice(0, 2)))).toHaveLength(1);
  });

  it("returns undefined for a sha it does not hold", async () => {
    expect(await freshStore().get("0".repeat(64))).toBeUndefined();
  });

  it("sweeps only unreferenced blobs", async () => {
    const store = freshStore();
    const keep = await store.put("keep me");
    const drop = await store.put("drop me");
    // Both blobs are only moments old; the grace period would otherwise
    // protect `drop` too (its own boundary is what the two tests below
    // cover) — push `now` well past it so this test isolates
    // referenced-vs-not from age.
    const now = Date.now() + SNAPSHOT_GRACE_MS + 60_000;
    expect(await store.sweep(new Set([keep]), { now })).toBe(1);
    expect(await store.get(keep)).toBe("keep me");
    expect(await store.get(drop)).toBeUndefined();
  });

  // --- Round-1 review, Critical 2: the grace period. `applyRestorePlan`
  // captures a hand-edited file into the store before overwriting it, and
  // that capture is written into no session log — so it is unreferenced by
  // DESIGN, not by a read failure, and a sweep running moments later must not
  // free it. See `SNAPSHOT_GRACE_MS`'s doc comment for the full case. ---

  it("does not free an unreferenced blob still inside the grace period", async () => {
    const store = freshStore();
    const drop = await store.put("too young to sweep");
    // No `now` override: the blob's real mtime is "just now", so the
    // DEFAULT grace period alone must protect it even though nothing
    // references it.
    expect(await store.sweep(new Set())).toBe(0);
    expect(await store.get(drop)).toBe("too young to sweep");
  });

  it("frees an unreferenced blob once the grace period has passed", async () => {
    const store = freshStore();
    const drop = await store.put("aged out");
    const now = Date.now() + SNAPSHOT_GRACE_MS + 60_000;
    expect(await store.sweep(new Set(), { now })).toBe(1);
    expect(await store.get(drop)).toBeUndefined();
  });
});
