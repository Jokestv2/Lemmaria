// B6r Task 7 (ADR 0031, design §9): fail-closed blob GC — the one
// unrecoverable operation in the whole design. See `sweepSnapshotBlobs`'s doc
// comment in `../src/session-edit-ui.ts` for why ANY read/parse failure
// anywhere in the enumeration must abandon the sweep entirely, rather than
// skip the one session it came from: a deleted blob has no object database
// underneath it to recover from, unlike B6's git stash.
//
// This suite drives `sweepSnapshotBlobs` directly against the extension's own
// session-state module rather than through the activated extension singleton
// (`vscode.extensions.getExtension(...)`), because that singleton's
// globalStorage is the REAL ext-host test profile shared by every suite in one
// `pnpm test:ext` run — writing a torn `.jsonl` into it, or deleting its
// session directory outright (some tests below), would corrupt or nuke
// sessions other suites created. Each test here instead gets its own
// throwaway store: a fake `ExtensionContext` rooted at a fresh temp dir, with
// `resetSessionState()` dropping the module's cached store/blob singletons so
// the next `sessionStoreFor`/`snapshotStore` call rebuilds against it.
//
// Round-1 review, Critical 2: `SnapshotStore.sweep` now protects any
// unreferenced blob younger than `SNAPSHOT_GRACE_MS` (default 7 days),
// regardless of the reference set — see its doc comment for why. That default
// would otherwise defeat every "this orphan gets freed" assertion below,
// since `store.put` stamps a brand-new mtime. `ageBlob` backdates a blob's
// mtime past the grace window so those assertions test the REFERENCE logic,
// not the grace period (which has its own dedicated tests, plus coverage in
// `packages/harness/test/session/snapshot-store.test.ts`).
import * as assert from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_FORMAT_VERSION, SNAPSHOT_GRACE_MS } from "@lemmaria/harness";
import * as vscode from "vscode";
import { sweepSnapshotBlobs } from "../src/session-edit-ui";
import {
  resetSessionState,
  sessionStoreFor,
  snapshotStore,
} from "../src/session/session-state";

/**
 * A fake context whose `globalStorageUri` is a fresh temp directory.
 * `sessionStoreFor`/`snapshotStore` read only that one field (verified from
 * `session-state.ts`), so this satisfies them without pulling in the rest of
 * the real `vscode.ExtensionContext` surface.
 */
function fakeContext(): vscode.ExtensionContext {
  const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-gc-"));
  return {
    globalStorageUri: vscode.Uri.file(root),
  } as unknown as vscode.ExtensionContext;
}

/** Backdate a blob's mtime past the grace window (see the header comment). */
function ageBlob(rootDir: string, sha: string): void {
  const file = path.join(rootDir, sha.slice(0, 2), sha);
  const past = new Date(Date.now() - SNAPSHOT_GRACE_MS - 60_000);
  utimesSync(file, past, past);
}

/** A minimal valid session file whose one applied batch references `sha`. */
function writeSession(dir: string, id: string, sha: string): void {
  const meta = {
    at: "t",
    kind: "meta",
    version: SESSION_FORMAT_VERSION,
    meta: { id, title: "t", workspace: "w", createdAt: "t", updatedAt: "t" },
  };
  const event = {
    at: "t",
    kind: "event",
    id: "n1",
    event: {
      type: "item.completed",
      item: {
        id: "i1",
        type: "edit_proposal",
        policy: "auto_apply",
        edits: [],
        fileStates: [{ file: "c.tex", before: null, after: sha }],
      },
    },
  };
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${JSON.stringify(meta)}\n${JSON.stringify(event)}\n`,
    "utf8",
  );
}

/**
 * A session file whose LAST line is a torn tail write: valid meta, one valid
 * event referencing `sha`, then an incomplete trailing line with no closing
 * brace and no newline.
 *
 * Round-1 review, Critical 1: `SessionStore.load` tolerates exactly this on
 * purpose — the line fails `JSON.parse`, `skippedLines` increments, and
 * `load()` resolves normally instead of throwing (`packages/harness/src/session/store.ts`,
 * and pinned directly in `packages/harness/test/session/store.test.ts`,
 * "skips (and counts) a torn trailing line instead of failing the load"). So
 * this fixture is NOT the same failure as `writeUnparseableSession` below
 * (which throws): it exercises the path where `store.load` succeeds and the
 * sweep has to notice `skippedLines > 0` itself.
 */
function writeTornTailSession(dir: string, id: string, sha: string): void {
  const meta = {
    at: "t",
    kind: "meta",
    version: SESSION_FORMAT_VERSION,
    meta: { id, title: "t", workspace: "w", createdAt: "t", updatedAt: "t" },
  };
  const event = {
    at: "t",
    kind: "event",
    id: "n1",
    event: {
      type: "item.completed",
      item: {
        id: "i1",
        type: "edit_proposal",
        policy: "auto_apply",
        edits: [],
        fileStates: [{ file: "c.tex", before: null, after: sha }],
      },
    },
  };
  const tornTail = '{"at":"t","kind":"ev';
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${JSON.stringify(meta)}\n${JSON.stringify(event)}\n${tornTail}`,
    "utf8",
  );
}

/** A session file with no parseable meta record at all — `load()` throws
 *  outright, a different failure from a torn TAIL write (see above), which
 *  `load()` tolerates. */
function writeUnparseableSession(dir: string, id: string): void {
  writeFileSync(path.join(dir, `${id}.jsonl`), "{not json\n", "utf8");
}

/**
 * Two sessions in one store, the second forked from the first: a shared root
 * batch, then a batch each. ADR 0057's replacement for the branching fixture —
 * B6 wrote one FILE with a sibling branch off the root, and an abandoned draft
 * is now a session of its own. The sweep's rule is unchanged and so is what it
 * protects: every blob any session on disk still names.
 */
function writeForkedSessions(
  dir: string,
  root: string,
  abandonedSha: string,
  currentSha: string,
): void {
  const meta = (id: string) => ({
    at: "t",
    kind: "meta",
    version: SESSION_FORMAT_VERSION,
    meta: { id, title: "t", workspace: "w", createdAt: "t", updatedAt: "t" },
  });
  const proposal = (nodeId: string, before: string | null, after: string) => ({
    at: "t",
    kind: "event",
    id: nodeId,
    event: {
      type: "item.completed",
      item: {
        id: `i-${nodeId}`,
        type: "edit_proposal",
        policy: "auto_apply",
        edits: [],
        fileStates: [{ file: "c.tex", before, after }],
      },
    },
  });
  const write = (id: string, lines: unknown[]) =>
    writeFileSync(
      path.join(dir, `${id}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf8",
    );
  // The session the user left, and the fork they are in now. `n1` is copied
  // verbatim into the child, ids and all — which is what a real fork writes.
  write("s-left", [
    meta("s-left"),
    proposal("n1", null, root),
    proposal("n2", root, abandonedSha),
  ]);
  write("s-now", [
    meta("s-now"),
    proposal("n1", null, root),
    proposal("n3", root, currentSha),
  ]);
}

suite("sweepSnapshotBlobs", () => {
  // Isolate not just from other suites (see the header comment) but from each
  // other too: a stale cached store from the previous test here would silently
  // reuse the previous test's temp directory.
  teardown(() => resetSessionState());

  test("frees a blob no session references", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const kept = await store.put("referenced draft");
    const orphan = await store.put("nobody's draft");
    ageBlob(store.rootDir, orphan);
    writeSession(dir, "s1", kept);

    assert.strictEqual(await sweepSnapshotBlobs(context), 1);
    assert.strictEqual(await store.get(kept), "referenced draft");
    assert.strictEqual(await store.get(orphan), undefined);
  });

  test("still sweeps across a session that carries a title record (ADR 0058)", async () => {
    // The `title` record is a PARSED kind, not an unknown one. If it were
    // counted into `skippedLines`, this sweep would fail closed on every
    // session a writer ever renamed — freeing nothing, for ever, with no
    // error anywhere. Nothing else in the build can see that, because a sweep
    // that frees nothing looks exactly like a sweep with nothing to free.
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const kept = await store.put("referenced draft");
    const orphan = await store.put("nobody's draft");
    ageBlob(store.rootDir, orphan);
    writeSession(dir, "s1", kept);
    await sessionStoreFor(context).setTitle("s1", "named after the fact");

    assert.strictEqual(
      (await sessionStoreFor(context).load("s1")).skippedLines,
      0,
    );
    assert.strictEqual(await sweepSnapshotBlobs(context), 1);
    assert.strictEqual(await store.get(kept), "referenced draft");
    assert.strictEqual(await store.get(orphan), undefined);
  });

  test("frees NOTHING when a session log has no meta record (load throws)", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const kept = await store.put("referenced draft");
    const orphan = await store.put("nobody's draft");
    ageBlob(store.rootDir, orphan);
    writeSession(dir, "s1", kept);
    writeUnparseableSession(dir, "s2");

    assert.strictEqual(
      await sweepSnapshotBlobs(context),
      0,
      "one unreadable session must abandon the whole sweep",
    );
    assert.strictEqual(
      await store.get(orphan),
      "nobody's draft",
      "a genuinely unreferenced blob must SURVIVE — the reference set was incomplete, " +
        "and we cannot tell which kind of orphan this is",
    );
    assert.strictEqual(await store.get(kept), "referenced draft");
  });

  // Round-1 review, Critical 1: a torn tail write does NOT make `load()`
  // throw (see `writeTornTailSession`'s doc comment) — this is the case the
  // test above does not reach, despite its old comment claiming it did.
  test("frees NOTHING when a session log ends in a torn tail write", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const kept = await store.put("referenced draft");
    const orphan = await store.put("nobody's draft");
    ageBlob(store.rootDir, orphan);
    writeSession(dir, "s1", kept);
    writeTornTailSession(dir, "s2", kept);

    assert.strictEqual(
      await sweepSnapshotBlobs(context),
      0,
      "a torn tail write must abandon the sweep even though SessionStore.load resolves without throwing",
    );
    assert.strictEqual(await store.get(orphan), "nobody's draft");
    assert.strictEqual(await store.get(kept), "referenced draft");
  });

  test("frees nothing when the session directory cannot be read", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const orphan = await store.put("nobody's draft");
    ageBlob(store.rootDir, orphan);
    // Point the store home at a path that does not exist.
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });

    assert.strictEqual(await sweepSnapshotBlobs(context), 0);
    assert.strictEqual(await store.get(orphan), "nobody's draft");
  });

  // --- Round-1 review, Important 2: the two Criticals the brief named
  // (entries-not-branch, and before-collection) were unguarded — every
  // fixture above is a single linear entry with `before: null`, so a
  // refactor to `.branch` or a dropped `before` collection kept all of them
  // green. These two are built to fail against exactly those regressions. ---

  test("keeps an abandoned session's blob — every session on disk is a reference", async () => {
    // B6's version of this asserted that an OFF-BRANCH sibling survived, which
    // is why `sweepSnapshotBlobs` walks `.entries` and not `.branch`. ADR 0057
    // deletes branches, so the property moves up a level and gets stronger:
    // the draft the user walked away from is a session of its own, and the
    // sweep protects it because it folds every session it can list.
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const root = await store.put("root draft");
    const abandoned = await store.put("the draft nobody went back to");
    const current = await store.put("the current session's draft");
    const orphan = await store.put("truly nobody's draft");
    for (const sha of [root, abandoned, current, orphan])
      ageBlob(store.rootDir, sha);
    writeForkedSessions(dir, root, abandoned, current);

    assert.strictEqual(
      await sweepSnapshotBlobs(context),
      1,
      "only the truly unreferenced blob should be freed",
    );
    assert.strictEqual(
      await store.get(abandoned),
      "the draft nobody went back to",
      "an abandoned session's blob must survive — the user can still resume it",
    );
    assert.strictEqual(await store.get(current), "the current session's draft");
    assert.strictEqual(await store.get(root), "root draft");
    assert.strictEqual(await store.get(orphan), undefined);
  });

  test("keeps a blob referenced only as a fileState's `before`", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const original = await store.put(
      "what was on disk before this session touched it",
    );
    const after = await store.put("the edited draft");
    const orphan = await store.put("nobody's draft");
    for (const sha of [original, after, orphan]) ageBlob(store.rootDir, sha);
    writeSession(dir, "s1", after);
    // `writeSession` sets `before: null`; overwrite s1 with a non-null
    // `before` that names `original` — never anyone's `after`, so its only
    // path into the reference set is the `before` collection itself.
    const meta = {
      at: "t",
      kind: "meta",
      version: SESSION_FORMAT_VERSION,
      meta: {
        id: "s1",
        title: "t",
        workspace: "w",
        createdAt: "t",
        updatedAt: "t",
      },
    };
    const event = {
      at: "t",
      kind: "event",
      id: "n1",
      event: {
        type: "item.completed",
        item: {
          id: "i1",
          type: "edit_proposal",
          policy: "auto_apply",
          edits: [],
          fileStates: [{ file: "c.tex", before: original, after }],
        },
      },
    };
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      `${JSON.stringify(meta)}\n${JSON.stringify(event)}\n`,
      "utf8",
    );

    assert.strictEqual(
      await sweepSnapshotBlobs(context),
      1,
      "only the true orphan should be freed",
    );
    assert.strictEqual(
      await store.get(original),
      "what was on disk before this session touched it",
      "a sha referenced ONLY as `before` must survive — a rewind restores TO it, " +
        "and dropping `before` collection would silently make the rewind a no-op",
    );
    assert.strictEqual(await store.get(after), "the edited draft");
    assert.strictEqual(await store.get(orphan), undefined);
  });

  // --- Round-1 review, Critical 2 (integration-level): the motivating case
  // in its natural shape — a blob nobody's session log references yet,
  // because it was `put` moments ago and not by a turn at all (this is what
  // `applyRestorePlan`'s drift capture looks like from the store's side).
  // The harness-level boundary tests live in
  // `packages/harness/test/session/snapshot-store.test.ts`; this one proves
  // the extension wiring inherits the same protection by NOT calling
  // `ageBlob`. ---

  test("does not free a blob still inside the grace period, even though nothing references it", async () => {
    resetSessionState();
    const context = fakeContext();
    const store = snapshotStore(context);
    const dir = sessionStoreFor(context).rootDir;
    mkdirSync(dir, { recursive: true });
    const kept = await store.put("referenced draft");
    const justCaptured = await store.put(
      "a hand edit just saved, unreferenced by any log",
    );
    writeSession(dir, "s1", kept);

    assert.strictEqual(
      await sweepSnapshotBlobs(context),
      0,
      "a brand-new unreferenced blob must survive its own activation",
    );
    assert.strictEqual(
      await store.get(justCaptured),
      "a hand edit just saved, unreferenced by any log",
    );
    assert.strictEqual(await store.get(kept), "referenced draft");
  });
});
