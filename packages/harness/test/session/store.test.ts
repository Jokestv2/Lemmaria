import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/contracts/index.js";
import { branchPoints } from "../../src/session/edits.js";
import { SessionStore, sessionTitle } from "../../src/session/store.js";

const temps: string[] = [];
async function mkRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "lemmaria-session-test-"));
  temps.push(d);
  return join(d, "sessions");
}
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

const ev = (text: string): SessionEvent => ({
  type: "item.completed",
  item: { id: text, type: "agent_message", text },
});

/** A user message — a branch point unless it joined a running task. */
const user = (id: string, steered?: boolean): SessionEvent => ({
  type: "item.completed",
  item: { id, type: "user_message", text: id, ...(steered ? { steered } : {}) },
});

describe("SessionStore", () => {
  it("create → append → load replays to the same item list", async () => {
    const store = new SessionStore(await mkRoot());
    const meta = await store.create({
      title: "draft the intro\nplease",
      workspace: "/w",
    });
    expect(meta.title).toBe("draft the intro please");
    await store.append(meta.id, { type: "turn.started", turn: 1 });
    await store.append(meta.id, ev("hello"));
    const loaded = await store.load(meta.id);
    expect(loaded.meta.id).toBe(meta.id);
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.items).toEqual([
      { id: "hello", type: "agent_message", text: "hello" },
    ]);
    expect(loaded.skippedLines).toBe(0);
  });

  it("lists sessions newest-updated first and rebuilds a deleted index", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const a = await store.create({ title: "a", workspace: "/w" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ title: "b", workspace: "/w" });
    await new Promise((r) => setTimeout(r, 5));
    await store.append(a.id, ev("x")); // a becomes most recently updated
    let listed = await store.list();
    expect(listed.map((s) => s.meta.id)).toEqual([a.id, b.id]);
    await unlink(join(root, "index.json"));
    listed = await new SessionStore(root).list();
    expect(listed.map((s) => s.meta.id)).toEqual([a.id, b.id]);
  });

  it("list() repairs a valid-but-stale index missing a session (P2)", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const a = await store.create({ title: "a", workspace: "/w" });
    const stale = await readFile(join(root, "index.json"), "utf8"); // knows only a
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ title: "b", workspace: "/w" });
    // crash simulation: b's file landed but the index write never happened
    await writeFile(join(root, "index.json"), stale);
    const listed = await new SessionStore(root).list();
    expect(listed.map((s) => s.meta.id)).toEqual([b.id, a.id]);
  });

  it("list() repairs stale ordering after an append the index missed (P2)", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const a = await store.create({ title: "a", workspace: "/w" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ title: "b", workspace: "/w" });
    const stale = await readFile(join(root, "index.json"), "utf8"); // b newest
    await new Promise((r) => setTimeout(r, 5));
    await store.append(a.id, ev("x")); // a becomes newest on disk
    // crash simulation: the append's index update is lost
    await writeFile(join(root, "index.json"), stale);
    const listed = await new SessionStore(root).list();
    expect(listed.map((s) => s.meta.id)).toEqual([a.id, b.id]);
  });

  it("skips (and counts) a torn trailing line instead of failing the load", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, ev("ok"));
    await appendFile(
      join(root, `${meta.id}.jsonl`),
      '{"at":"2026-07-17T00:00:00.000Z","kind":"ev',
    );
    const loaded = await store.load(meta.id);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.skippedLines).toBe(1);
  });

  it("repairs a torn tail, so a resumed session's appends cannot fuse onto it", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, ev("intro"));
    // A crash mid-write: the file now ends WITHOUT its closing newline.
    await appendFile(
      join(root, `${meta.id}.jsonl`),
      '{"at":"2026-08-26T00:00:00.000Z","kind":"ev',
    );

    // The extension host restarts, and the resumed session writes on.
    const resumed = new SessionStore(root);
    await resumed.append(meta.id, ev("methods"));
    await resumed.append(meta.id, ev("results"));

    const loaded = await resumed.load(meta.id);
    // The torn record is lost — and it is the ONLY thing lost.
    expect(loaded.skippedLines).toBe(1);
    expect(loaded.items).toEqual([
      { id: "intro", type: "agent_message", text: "intro" },
      { id: "methods", type: "agent_message", text: "methods" },
      { id: "results", type: "agent_message", text: "results" },
    ]);
    // Nothing is orphaned: the log still reaches the whole history. Without
    // the repair the first post-crash append fuses into the torn line, losing
    // that record too.
    expect(loaded.entries).toHaveLength(3);
  });

  it("throws on a session file with no meta record", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    const file = join(root, `${meta.id}.jsonl`);
    const withoutMeta = (await readFile(file, "utf8"))
      .split("\n")
      .slice(1)
      .join("\n");
    await rm(file);
    await writeFile(file, withoutMeta);
    await expect(store.load(meta.id)).rejects.toThrow(/no meta/);
  });

  it("does not repair the tail of a file that is not a session", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    const file = join(root, `${meta.id}.jsonl`);
    await rm(file);
    // No meta record, and no closing newline: the load must refuse it rather
    // than write to it. The repair sits AFTER the meta check for this reason.
    const notASession = '{"kind":"event","id":"x"}';
    await writeFile(file, notASession);
    await expect(store.load(meta.id)).rejects.toThrow(/no meta/);
    expect(await readFile(file, "utf8")).toBe(notASession);
  });

  it("caps and one-lines the listing title", () => {
    expect(sessionTitle(`  ${"x".repeat(100)}  `)).toHaveLength(64);
    expect(sessionTitle("a\n\tb")).toBe("a b");
    // astral chars are never split into a lone surrogate by the cap
    const capped = sessionTitle("🙂".repeat(100));
    expect([...capped]).toHaveLength(64);
    expect(capped.at(-1)).toBe("…");
    expect(capped.includes("�")).toBe(false);
  });

  it("refuses a session file written in an older format (no migration)", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    const file = join(root, `${meta.id}.jsonl`);
    // exactly the pre-ADR-0027 shape: a meta record with no version
    await writeFile(
      file,
      `${JSON.stringify({
        at: meta.createdAt,
        kind: "meta",
        meta: { ...meta },
      })}\n`,
    );
    await expect(new SessionStore(root).load(meta.id)).rejects.toThrow(
      /unsupported session format/,
    );
    // and it is left OUT of the listing rather than breaking it
    expect(await new SessionStore(root).list()).toEqual([]);
  });

  it("refuses a literal `version: 3` file — the format E6 replaced", async () => {
    // The test above refuses a version-LESS record, i.e. the pre-ADR-0027
    // shape. ADR 0058's bump is about the version that actually exists on a
    // user's disk today, and the gate names it by hand; asserting the same
    // `!==` branch through the real predecessor is what makes the claim
    // "a v3 file is refused by a v4 load" a fact rather than an inference.
    const root = await mkRoot();
    const meta = await new SessionStore(root).create({
      title: "t",
      workspace: "/w",
    });
    await writeFile(
      join(root, `${meta.id}.jsonl`),
      `${JSON.stringify({
        at: meta.createdAt,
        kind: "meta",
        version: 3,
        meta: { ...meta },
      })}\n`,
    );
    // The v3 index goes with the v3 file, because that is the state a real
    // upgrade finds: a store written by the previous version has BOTH. It
    // matters — `list()` trusts a cached entry whose byte size still matches,
    // and `version: 3` is the same width as `version: 4`, so a v4 index over a
    // v3 file would serve the stale meta and never reach `load` at all.
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({ version: 3, entries: [{ meta, bytes: 1 }] }),
    );
    await expect(new SessionStore(root).load(meta.id)).rejects.toThrow(
      /unsupported session format \(expected 4, got 3\)/,
    );
    expect(await new SessionStore(root).list()).toEqual([]);
  });

  it("a stale v3 index.json cannot shadow the refusal, or the listing", async () => {
    // The second half of the same decision (ADR 0057 §3, re-applied by ADR
    // 0058): the index's own version moved with the format. A v3 index left
    // behind must be DISCARDED and rebuilt, not trusted — trusting it would
    // serve a cached listing of sessions whose files `load` now refuses, which
    // is the silent regression §3 says nobody notices. Asserted because
    // nothing else can see it: a stale index produces no error, only a wrong
    // answer.
    const root = await mkRoot();
    const store = new SessionStore(root);
    const live = await store.create({ title: "still here", workspace: "/w" });
    await writeFile(
      join(root, "index.json"),
      JSON.stringify({
        version: 3,
        entries: [
          {
            meta: { ...live, title: "a stale title the v3 index remembers" },
            bytes: 999999,
          },
          {
            meta: { ...live, id: "ghost", title: "a session with no file" },
            bytes: 1,
          },
        ],
      }),
    );
    const listed = await new SessionStore(root).list();
    expect(listed.map((s) => s.meta.id)).toEqual([live.id]);
    expect(listed[0]?.meta.title).toBe("still here");
  });

  it("append to an unknown session id throws instead of creating an orphan file", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    await store.create({ title: "t", workspace: "/w" });
    await expect(store.append("no-such-id", ev("x"))).rejects.toThrow(
      /unknown session/,
    );
    expect((await store.list()).map((s) => s.meta.title)).toEqual(["t"]);
  });
});

/*
 * ADR 0057 DELETED "SessionStore — the session tree (ADR 0027)" from here: nine
 * tests about a leaf pointer, a `moveTo`, and the sibling branches they made.
 * Their subject is gone, and where each assertion went is recorded rather than
 * left for a reader to reconstruct:
 *
 *  - "a rewind LEAVES the abandoned branch readable — the headline" → the fork
 *    suite below ("copies the event records VERBATIM up to the cut"), which
 *    asserts the same headline against a second FILE and additionally proves
 *    the source's bytes are untouched.
 *  - "survives a reload: the leaf comes back" and "a cold store appends onto
 *    the leaf" → deleted with the leaf. A cold store has nothing to derive:
 *    append writes to the end of the file, which is where the file ends.
 *  - "moveTo(null) empties the branch" and "moveTo refuses an entry id the
 *    session does not carry" → deleted with `moveTo`. Its refusal survives as
 *    the fork's ("refuses an unknown source and an unresolvable cut").
 *  - "a `leaf` record is never a node" → deleted with the record kind.
 *  - "two concurrent appends chain, they do not fork the branch" and "a failed
 *    mutation does not wedge the session's later writes" → KEPT, rewritten
 *    below against what the write queue still guards (`serialized`).
 *  - "nodeBeforeItem resolves the id the restore affordance holds" → moved to
 *    `cut.test.ts`, which asserts the successor over the same case.
 */

describe("SessionStore — the write queue (ADR 0027, kept by ADR 0057)", () => {
  it("two concurrent appends both land, in order, neither lost", async () => {
    // Before this was serialized, both calls read the SAME leaf and stamped
    // the same parent, and the later write won — silently leaving the other
    // record off-branch. ADR 0057 deletes that critical section, and the queue
    // stays for the two that outlive it: `index.json` is a read-modify-write,
    // and callers rely on records landing in the order they made them.
    // Reachable in the extension, where a `grant_update` appended from a
    // webview message races the task loop's own emits.
    const store = new SessionStore(await mkRoot());
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, ev("one"));
    await Promise.all([
      store.append(meta.id, ev("task")),
      store.append(meta.id, ev("grant")),
    ]);
    const loaded = await store.load(meta.id);
    expect(loaded.entries).toHaveLength(3);
    expect(loaded.items.map((i) => i.id).sort()).toEqual([
      "grant",
      "one",
      "task",
    ]);
    // ...and the index agrees, which is the half the queue still guards.
    expect((await new SessionStore(store.rootDir).list()).length).toBe(1);
  });

  it("a failed mutation does not wedge the session's later writes (review)", async () => {
    const store = new SessionStore(await mkRoot());
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, ev("one"));
    await expect(store.append("no-such-id", ev("x"))).rejects.toThrow();
    // the chain continues through a rejection
    await store.append(meta.id, ev("two"));
    expect((await store.load(meta.id)).items.map((i) => i.id)).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("SessionStore.fork — session lineage (ADR 0057)", () => {
  /** The raw JSONL lines of a session file, for the verbatim assertions. */
  const linesOf = async (root: string, id: string): Promise<string[]> =>
    (await readFile(join(root, `${id}.jsonl`), "utf8"))
      .split("\n")
      .filter((l) => l.trim() !== "");

  it("copies the event records VERBATIM up to the cut, ids and stamps intact", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "two ways", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    await store.append(parent.id, { type: "turn.started", turn: 2 });
    await store.append(parent.id, ev("two"));

    const before = await linesOf(root, parent.id);
    const child = await store.fork(parent.id, { cutBeforeItemId: "two" });
    const after = await linesOf(root, parent.id);
    // The source is NEVER written. This is what makes "non-destructive" a
    // fact rather than a claim (ADR 0057, superseding ADR 0027 §2's leaf).
    expect(after).toEqual(before);

    const childLines = await linesOf(root, child.id);
    // Line 0 is the child's OWN meta; every line after it is the source's,
    // byte for byte — same record ids, same `at` stamps.
    expect(childLines.slice(1)).toEqual(before.slice(1, 3));

    const loadedParent = await store.load(parent.id);
    const loadedChild = await store.load(child.id);
    expect(loadedChild.entries.map((e) => e.id)).toEqual(
      loadedParent.entries.slice(0, 2).map((e) => e.id),
    );
    expect(loadedChild.items.map((i) => i.id)).toEqual(["one"]);
    // ...and the parent still holds its whole conversation.
    expect(loadedParent.items.map((i) => i.id)).toEqual(["one", "two"]);
  });

  it("copies the WHOLE session when no cut is given", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    await store.append(parent.id, ev("two"));
    const child = await store.fork(parent.id, {});
    expect((await store.load(child.id)).items.map((i) => i.id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("copies NOTHING when the cut is the first record (cut 0)", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    const child = await store.fork(parent.id, { cutBeforeItemId: "one" });
    const loaded = await store.load(child.id);
    // 0 is a cut, not a refusal — an empty child that is still a real session.
    expect(loaded.entries).toEqual([]);
    expect(loaded.items).toEqual([]);
    await store.append(child.id, ev("fresh"));
    expect((await store.load(child.id)).items.map((i) => i.id)).toEqual([
      "fresh",
    ]);
  });

  it("records the lineage on the child's meta, visible through list()", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    await store.append(parent.id, ev("two"));
    const cut = await store.fork(parent.id, { cutBeforeItemId: "two" });
    const end = await store.fork(parent.id, {});

    expect(cut.forkedFrom).toEqual({
      sessionId: parent.id,
      cutBeforeItemId: "two",
      // Any cut carries an ordinal (ADR 0058), and this session's entries are
      // agent messages, so no branch point precedes the cut: 0 + 1. The ⟲
      // controls only ever cut before a user message, which is the case the
      // ordinal is rendered for.
      atMessage: 1,
    });
    // `null` = forked at the END (what /fork will do, E6).
    expect(end.forkedFrom).toEqual({
      sessionId: parent.id,
      cutBeforeItemId: null,
    });
    expect(parent.forkedFrom).toBeUndefined();

    // Through list(), i.e. through the index — the Sessions view nests on
    // this without opening a file (ADR 0057).
    const listed = new Map(
      (await new SessionStore(root).list()).map((s) => [s.meta.id, s.meta]),
    );
    expect(listed.get(cut.id)?.forkedFrom?.sessionId).toBe(parent.id);
    expect(listed.get(end.id)?.forkedFrom?.cutBeforeItemId).toBe(null);
  });

  it("inherits the parent's title, or takes the one it is given", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "the intro", workspace: "/w" });
    expect((await store.fork(parent.id, {})).title).toBe("the intro");
    // Capped and one-lined like any other title (E6 passes a user's name here).
    expect((await store.fork(parent.id, { title: "second\ntry" })).title).toBe(
      "second try",
    );
  });

  it("carries the parent's workspace, and mints its own id and timestamps", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    const child = await store.fork(parent.id, {});
    expect(child.workspace).toBe("/w");
    expect(child.id).not.toBe(parent.id);
    expect(child.createdAt >= parent.createdAt).toBe(true);
  });

  it("a fresh fork lists AHEAD of its parent, not behind it (updatedAt)", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "parent", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    // Touched AFTER the parent and BEFORE the fork: this is what the child has
    // to sort ahead of, and what a copied-tail stamp would put it behind.
    const other = await store.create({ title: "other", workspace: "/w" });
    await store.append(other.id, ev("two"));
    const child = await store.fork(parent.id, {});
    // The copied tail's `at` predates the fork, so a naive `updatedAt = last
    // record's at` would bury the child mid-list — and the child is the
    // session the user is now in. Asserted through a COLD store, because
    // `load` is where the recovery happens.
    expect(
      (await new SessionStore(root).list()).map((s) => s.meta.title),
    ).toEqual(["parent", "other", "parent"]);
    expect((await new SessionStore(root).load(child.id)).meta.updatedAt).toBe(
      child.createdAt,
    );
  });

  it("refuses an unknown source and an unresolvable cut, writing nothing", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    await expect(store.fork("no-such-id", {})).rejects.toThrow(
      /unknown session/,
    );
    // ADR 0018's rule: an unresolvable target refuses rather than widening.
    await expect(
      store.fork(parent.id, { cutBeforeItemId: "never-said" }),
    ).rejects.toThrow(/unknown session item/);
    expect((await store.list()).map((s) => s.meta.title)).toEqual(["t"]);
  });

  it("a fork of a fork keeps its IMMEDIATE parent, and the chain is walkable", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const a = await store.create({ title: "a", workspace: "/w" });
    await store.append(a.id, ev("one"));
    const b = await store.fork(a.id, {});
    await store.append(b.id, ev("two"));
    const c = await store.fork(b.id, {});
    expect(c.forkedFrom?.sessionId).toBe(b.id);
    expect(b.forkedFrom?.sessionId).toBe(a.id);
    // The copy is transitive without the chain being stored: c holds a's turn.
    expect((await store.load(c.id)).items.map((i) => i.id)).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("SessionStore — appendable titles (ADR 0058)", () => {
  it("folds title records latest-wins, and load() counts none as skipped", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "", workspace: "/w" });
    expect(meta.title).toBe("");
    await store.setTitle(meta.id, "first  attempt");
    await store.setTitle(meta.id, "the\nsecond");
    const loaded = await store.load(meta.id);
    expect(loaded.meta.title).toBe("the second");
    // Load-bearing, not incidental: the blob-GC sweep abandons itself on any
    // skippedLines > 0, so a record kind it cannot parse would silently stop
    // reclaiming every snapshot blob in the store (session-edit-ui.ts).
    expect(loaded.skippedLines).toBe(0);
  });

  it("setTitle is served by list() from the index, without a load()", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "", workspace: "/w" });
    await store.list(); // warm the index cache, as a running view has

    let loads = 0;
    const real = store.load.bind(store);
    store.load = async (id: string) => {
      loads += 1;
      return real(id);
    };

    await store.setTitle(meta.id, "fix the lemma");
    const listed = await store.list();
    expect(listed.find((s) => s.meta.id === meta.id)?.meta.title).toBe(
      "fix the lemma",
    );
    // `refreshIndexAfterAppend` reuses the CACHED meta and `list()` trusts a
    // cache entry whose byte count matches — so a title that is not upserted
    // into the index is served stale for as long as the cache survives.
    expect(loads).toBe(0);
  });

  it("caps a set title exactly as a created one is capped", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "", workspace: "/w" });
    await store.setTitle(meta.id, "x".repeat(100));
    expect((await store.load(meta.id)).meta.title).toBe(`${"x".repeat(63)}…`);
  });

  it("a fork copies no title records, so a child cannot resurrect old ones", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "", workspace: "/w" });
    await store.append(parent.id, ev("one"));
    await store.setTitle(parent.id, "the parent's name");
    const child = await store.fork(parent.id, { title: "" });
    // Born untitled (D3): the rewind child has no message of its own yet.
    expect(child.title).toBe("");
    const raw = await readFile(join(root, `${child.id}.jsonl`), "utf8");
    expect(raw).not.toContain('"kind":"title"');
    // ...and it stays untitled through a reload, i.e. no inherited record
    // folds over it.
    expect((await store.load(child.id)).meta.title).toBe("");
    // The parent keeps its own folded title, and an unnamed fork inherits it.
    expect((await store.fork(parent.id, {})).title).toBe("the parent's name");
  });

  it("setTitle on an unknown session throws instead of creating an orphan", async () => {
    const store = new SessionStore(await mkRoot());
    await store.create({ title: "t", workspace: "/w" });
    await expect(store.setTitle("no-such-id", "x")).rejects.toThrow(
      /unknown session/,
    );
  });
});

describe("SessionStore.fork — the fork ordinal (ADR 0058)", () => {
  it("atMessage is the cut message's 1-based place among the branch points", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    // Steered messages are NOT branch points (they joined a running task), so
    // they must not move the count the operator reads off the ⟲ controls.
    await store.append(parent.id, user("m1"));
    await store.append(parent.id, ev("a1"));
    await store.append(parent.id, user("s1", true));
    await store.append(parent.id, user("m2"));
    await store.append(parent.id, ev("a2"));
    await store.append(parent.id, user("s2", true));
    await store.append(parent.id, user("m3"));

    const { items } = await store.load(parent.id);
    const points = branchPoints(items);
    expect(points).toEqual(["m1", "m2", "m3"]);
    // The population the ⟲ controls render over IS the spec: whatever the
    // store counts internally, a fork cut before the i-th point must report
    // i + 1, because that is the number on screen.
    for (const [i, id] of points.entries()) {
      const child = await store.fork(parent.id, { cutBeforeItemId: id });
      expect(child.forkedFrom?.atMessage).toBe(i + 1);
    }
  });

  it("a fork at the end records no ordinal", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, user("m1"));
    const child = await store.fork(parent.id, {});
    expect(child.forkedFrom).toEqual({
      sessionId: parent.id,
      cutBeforeItemId: null,
    });
    expect(child.forkedFrom?.atMessage).toBeUndefined();
  });

  it("carries the ordinal through list(), so a row needs no parent log", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, user("m1"));
    await store.append(parent.id, user("m2"));
    const child = await store.fork(parent.id, { cutBeforeItemId: "m2" });
    const listed = await new SessionStore(root).list();
    expect(
      listed.find((s) => s.meta.id === child.id)?.meta.forkedFrom?.atMessage,
    ).toBe(2);
  });

  it("counts a user message once even if its record were to repeat", async () => {
    // `edit_proposal`, `script_run` and `subtask` items are each persisted
    // TWICE (pending, then terminal). A user message is not — but the ordinal
    // must be a count of DISTINCT messages either way, or the number on the
    // row drifts from the number of ⟲ controls above it.
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, user("m1"));
    await store.append(parent.id, user("m1"));
    await store.append(parent.id, user("m2"));
    const child = await store.fork(parent.id, { cutBeforeItemId: "m2" });
    // m2 is the SECOND message, not the third: counting records rather than
    // distinct ids would say 3, and the row would name a message the reader
    // cannot find a ⟲ control for.
    expect(child.forkedFrom?.atMessage).toBe(2);
  });
});

describe("SessionStore — the index leaf file manifest (ADR 0058)", () => {
  /** An applied batch that leaves `file` holding `after`. */
  const wrote = (
    id: string,
    file: string,
    before: string | null,
    after: string,
  ): SessionEvent => ({
    type: "item.completed",
    item: {
      id,
      type: "edit_proposal",
      policy: "auto_apply",
      edits: [],
      fileStates: [{ file, before, after }],
    },
  });

  const filesOf = async (root: string, id: string) =>
    (await new SessionStore(root).list()).find((s) => s.meta.id === id)?.files;

  it("a session that wrote nothing carries an empty manifest", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, ev("just a question"));
    expect(await filesOf(root, meta.id)).toEqual({});
  });

  it("an append folds its file states into the entry, latest write winning", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, wrote("e1", "a.tex", null, "sha-a1"));
    await store.append(meta.id, wrote("e2", "b.tex", null, "sha-b1"));
    await store.append(meta.id, wrote("e3", "a.tex", "sha-a1", "sha-a2"));
    expect(await filesOf(root, meta.id)).toEqual({
      "a.tex": "sha-a2",
      "b.tex": "sha-b1",
    });
  });

  it("a fork's manifest is its COPIED PREFIX's, not the whole parent's", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, wrote("e1", "a.tex", null, "sha-a1"));
    await store.append(parent.id, user("m2"));
    await store.append(parent.id, wrote("e2", "a.tex", "sha-a1", "sha-a2"));
    const cut = await store.fork(parent.id, { cutBeforeItemId: "m2" });
    const end = await store.fork(parent.id, {});
    expect(await filesOf(root, cut.id)).toEqual({ "a.tex": "sha-a1" });
    expect(await filesOf(root, end.id)).toEqual({ "a.tex": "sha-a2" });
    expect(await filesOf(root, parent.id)).toEqual({ "a.tex": "sha-a2" });
  });

  it("the incrementally-maintained manifest equals the one rebuilt from JSONL", async () => {
    // The whole reason the Sessions view may stay a pure index reader is that
    // the index carries this. An incremental fold that drifts from the rebuild
    // is invisible until a marker lies about a row, so the equality IS the
    // spec — not the fold rule that happens to implement it today.
    const root = await mkRoot();
    const store = new SessionStore(root);
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, wrote("e1", "a.tex", null, "sha-a1"));
    await store.append(parent.id, user("m2"));
    await store.append(parent.id, wrote("e2", "b.tex", null, "sha-b1"));
    await store.append(parent.id, wrote("e3", "a.tex", "sha-a1", "sha-a2"));
    const child = await store.fork(parent.id, { cutBeforeItemId: "m2" });
    await store.append(child.id, wrote("e4", "c.tex", null, "sha-c1"));

    const incremental = await new SessionStore(root).list();
    await unlink(join(root, "index.json"));
    const rebuilt = await new SessionStore(root).list();
    expect(rebuilt.map((s) => [s.meta.id, s.files])).toEqual(
      incremental.map((s) => [s.meta.id, s.files]),
    );
    expect(rebuilt.find((s) => s.meta.id === child.id)?.files).toEqual({
      "a.tex": "sha-a1",
      "c.tex": "sha-c1",
    });
  });

  it("records no deletion, because a session cannot express one", async () => {
    // A13. `ProposedEdit.kind` is `replace | create` and `FileState.after` is
    // a plain string, so nothing a session can persist puts a file into the
    // manifest as *gone*. That matters because the marker (ADR 0058 §7) reads
    // a missing file as OUT of sync — which would be wrong for a file the
    // session itself deleted, and is right precisely because that case cannot
    // arise.
    //
    // Pinned against the CONTRACT and not against a manifest value (E6 code
    // review): `files` is a `Record<string, string>`, so "every value is a
    // string" is true by construction and would still pass on the day a
    // `delete` kind arrived. The contract's own text is what would change
    // then, so that is what this reads — and it is the tripwire the rule needs,
    // since a new kind must land in the union before it can reach the fold.
    const contract = await readFile(
      new URL("../../src/contracts/sessions.ts", import.meta.url),
      "utf8",
    );
    expect(contract).toContain('kind: "replace" | "create";');
    expect(contract).toMatch(/interface FileState \{[^}]*after: string;/s);
    expect(contract).not.toMatch(/kind:[^;]*"delete"/);

    // And the fold agrees with it today: a written file is present, by sha.
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, wrote("e1", "a.tex", null, "sha-a1"));
    expect(await filesOf(root, meta.id)).toEqual({ "a.tex": "sha-a1" });
  });

  it("a session appended to after the index was written still lists its files", async () => {
    const root = await mkRoot();
    const store = new SessionStore(root);
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.list(); // warm the cache with the empty manifest
    await store.append(meta.id, wrote("e1", "a.tex", null, "sha-a1"));
    expect(await filesOf(root, meta.id)).toEqual({ "a.tex": "sha-a1" });
  });
});
