import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  CompactionItem,
  GrantedRoot,
  SessionEvent,
  SessionItem,
  SubtaskItem,
} from "../../src/contracts/index.js";
import { activeGrants, replayEntries } from "../../src/session/replay.js";
import { SessionStore } from "../../src/session/store.js";
import { linearEntries } from "../support/entries.js";

/** ADR 0027: the fold reads a BRANCH. A session that was never rewound is one
 *  straight branch, so these pre-tree fixtures wrap and assert unchanged. */
const replay = (events: readonly SessionEvent[]): SessionItem[] =>
  replayEntries(linearEntries(events));

describe("replayEntries", () => {
  it("normalizes an unsettled subtask to failed on replay (A3)", () => {
    const running: SubtaskItem = {
      id: "s1",
      type: "subtask",
      status: "running",
      reports: [
        {
          goal: "explore",
          status: "interrupted",
          summary: "…",
          allowedTools: ["read_span"],
        },
      ],
    };
    const [item] = replay([{ type: "item.completed", item: running }]);
    expect(item?.type === "subtask" && item.status).toBe("failed");
  });

  it("leaves a completed subtask untouched on replay (A3)", () => {
    const done: SubtaskItem = {
      id: "s2",
      type: "subtask",
      status: "completed",
      reports: [],
    };
    const [item] = replay([{ type: "item.completed", item: done }]);
    expect(item).toEqual(done);
  });

  it("folds started→updated→completed into one item, last event wins", () => {
    const events: SessionEvent[] = [
      { type: "turn.started", turn: 1 },
      {
        type: "item.started",
        item: { id: "a", type: "agent_message", text: "" },
      },
      {
        type: "item.updated",
        item: { id: "a", type: "agent_message", text: "Hel" },
      },
      {
        type: "item.completed",
        item: { id: "a", type: "agent_message", text: "Hello" },
      },
      {
        type: "turn.completed",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const items = replay(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: "a", type: "agent_message", text: "Hello" });
  });

  it("preserves first-appearance order across interleaved items", () => {
    const events: SessionEvent[] = [
      {
        type: "item.started",
        item: { id: "a", type: "agent_message", text: "" },
      },
      {
        type: "item.completed",
        item: { id: "b", type: "user_message", text: "hi" },
      },
      {
        type: "item.completed",
        item: { id: "a", type: "agent_message", text: "yo" },
      },
    ];
    expect(replay(events).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns [] for an empty or turn-only stream", () => {
    expect(replay([])).toEqual([]);
    expect(replay([{ type: "turn.started", turn: 1 }])).toEqual([]);
  });

  it("two item.completed events with one id replay to the second (upsert pin)", () => {
    const events: SessionEvent[] = [
      {
        type: "item.completed",
        item: { id: "a", type: "agent_message", text: "first" },
      },
      {
        type: "item.completed",
        item: { id: "a", type: "agent_message", text: "second" },
      },
    ];
    const items = replay(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "second" });
  });

  it("normalizes non-terminal edit_proposal statuses to stale on replay (ADR 0016)", () => {
    const events: SessionEvent[] = [
      {
        type: "item.completed",
        item: {
          id: "p1",
          type: "edit_proposal",
          policy: "review",
          edits: [
            {
              file: "a.tex",
              kind: "replace",
              anchor: "x",
              replacement: "y",
              status: "pending",
            },
            {
              file: "a.tex",
              kind: "replace",
              anchor: "q",
              replacement: "r",
              status: "accepted",
            },
            {
              file: "a.tex",
              kind: "replace",
              anchor: "m",
              replacement: "n",
              status: "applied",
            },
            {
              file: "a.tex",
              kind: "replace",
              anchor: "s",
              replacement: "t",
              status: "rejected",
              note: "no",
            },
            {
              file: "b.tex",
              kind: "create",
              content: "c",
              status: "invalid",
              note: "already exists",
            },
          ],
        },
      },
    ];
    const [item] = replay(events);
    if (item?.type !== "edit_proposal") throw new Error("expected proposal");
    expect(item.edits.map((e) => e.status)).toEqual([
      "stale",
      "stale",
      "applied",
      "rejected",
      "invalid",
    ]);
  });

  it("says WHY a normalized edit went stale, and keeps a note it already had", () => {
    // "stale" renders as "the file changed", which is the wrong story for a
    // proposal the user never got to answer: the file is untouched, the window
    // went away. A terminal note that was already there is the real reason and
    // must survive (this fold also runs over edits normalized once before).
    const events: SessionEvent[] = [
      {
        type: "item.completed",
        item: {
          id: "p2",
          type: "edit_proposal",
          policy: "review",
          edits: [
            {
              file: "a.tex",
              kind: "replace",
              anchor: "x",
              replacement: "y",
              status: "pending",
            },
            {
              file: "a.tex",
              kind: "replace",
              anchor: "q",
              replacement: "r",
              status: "pending",
              note: "task interrupted before a decision",
            },
          ],
        },
      },
    ];
    const [item] = replay(events);
    if (item?.type !== "edit_proposal") throw new Error("expected proposal");
    expect(item.edits[0]?.note).toBe("session ended before a decision");
    expect(item.edits[1]?.note).toBe("task interrupted before a decision");
  });
});

describe("a rewind forks, it does not truncate (ADR 0057)", () => {
  // These four cases are ADR 0018's four rewind cases, restated against the
  // tree. The behaviour of the first three deliberately CHANGED: what left the
  // transcript is now off-branch rather than gone, and each assertion below
  // now also pins that it is still reachable. The fourth is unchanged in
  // effect (a bad target never empties a transcript) but moved from a silent
  // no-op in the fold to a refusal at the store, per ADR 0018's own
  // "an unresolvable target refuses instead of widening".
  const roots: string[] = [];
  afterAll(async () => {
    for (const dir of roots) await rm(dir, { recursive: true, force: true });
  });
  async function store(): Promise<{ store: SessionStore; id: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-rewind-test-"));
    roots.push(dir);
    const s = new SessionStore(join(dir, "sessions"));
    const meta = await s.create({ title: "t", workspace: "/w" });
    return { store: s, id: meta.id };
  }
  const msg = (id: string, text: string): SessionEvent => ({
    type: "item.completed",
    item: { id, type: "user_message", text },
  });
  const reply = (id: string, text: string): SessionEvent => ({
    type: "item.completed",
    item: { id, type: "agent_message", text },
  });
  /** "Rewind to before this message", the way the ⟲ control asks (ADR 0057). */
  const rewind = async (
    s: SessionStore,
    id: string,
    itemId: string,
  ): Promise<string> => (await s.fork(id, { cutBeforeItemId: itemId })).id;

  it("takes the rewound message and everything after it out of the CHILD — and keeps them in the parent", async () => {
    const { store: s, id } = await store();
    for (const e of [
      msg("u1", "first"),
      reply("a1", "sure"),
      msg("u2", "second"),
      reply("a2", "done"),
    ])
      await s.append(id, e);
    const child = await rewind(s, id, "u2");

    // The conversation continues from before "second" — so the model is not
    // told about a turn whose file changes have just been reverted.
    expect((await s.load(child)).items.map((i) => i.id)).toEqual(["u1", "a1"]);
    // ...and, unlike ADR 0018, the work is not destroyed. ADR 0027 kept it as
    // a sibling branch inside one file; ADR 0057 keeps it where it was
    // written, which is why this assertion needs no walk at all.
    expect((await s.load(id)).items.map((i) => i.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("keeps items appended after the rewind (the thread continues, in the child)", async () => {
    const { store: s, id } = await store();
    for (const e of [msg("u1", "first"), msg("u2", "second")])
      await s.append(id, e);
    const child = await rewind(s, id, "u2");
    for (const e of [msg("u3", "second, rephrased"), reply("a3", "ok")])
      await s.append(child, e);
    expect((await s.load(child)).items.map((i) => i.id)).toEqual([
      "u1",
      "u3",
      "a3",
    ]);
  });

  it("applies successive rewinds, each relative to the session that remains", async () => {
    const { store: s, id } = await store();
    for (const e of [msg("u1", "first"), msg("u2", "second")])
      await s.append(id, e);
    const second = await rewind(s, id, "u2");
    await s.append(second, msg("u3", "third"));
    const third = await rewind(s, second, "u3");
    expect((await s.load(third)).items.map((i) => i.id)).toEqual(["u1"]);
    // Each generation is still on disk, holding what it held.
    expect((await s.load(second)).items.map((i) => i.id)).toEqual(["u1", "u3"]);
    expect((await s.load(id)).items.map((i) => i.id)).toEqual(["u1", "u2"]);
  });

  it("refuses a rewind to an unknown id rather than writing a wrong session", async () => {
    const { store: s, id } = await store();
    await s.append(id, msg("u1", "first"));
    await expect(rewind(s, id, "nope")).rejects.toThrow(/unknown session item/);
    expect((await s.load(id)).items.map((i) => i.id)).toEqual(["u1"]);
  });
});

describe("activeGrants (ADR 0019)", () => {
  const tmpRoots: string[] = [];
  afterAll(async () => {
    for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true });
  });

  const g = (id: string, path: string): GrantedRoot => ({
    id,
    path,
    label: id,
  });
  const update = (
    itemId: string,
    action: "added" | "revoked",
    grant: GrantedRoot,
  ): SessionItem => ({ id: itemId, type: "grant_update", action, grant });

  it("folds add/add/revoke into the surviving grant set, in grant order", () => {
    const items: SessionItem[] = [
      update("i1", "added", g("g1", "/a")),
      update("i2", "added", g("g2", "/b")),
      update("i3", "revoked", g("g1", "/a")),
    ];
    expect(activeGrants(items)).toEqual([g("g2", "/b")]);
  });

  it("ignores a duplicate add for an already-active id and a revoke for an unknown id", () => {
    const items: SessionItem[] = [
      update("i1", "added", g("g1", "/a")),
      update("i2", "added", g("g1", "/elsewhere")),
      update("i3", "revoked", g("g9", "/nope")),
    ];
    expect(activeGrants(items)).toEqual([g("g1", "/a")]);
  });

  it("returns [] with no grant_update items and skips other item types", () => {
    const items: SessionItem[] = [
      { id: "u1", type: "user_message", text: "hi" },
    ];
    expect(activeGrants(items)).toEqual([]);
  });

  it("grants persist with the session: a store round-trip replays the active set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-grants-"));
    tmpRoots.push(dir);
    const store = new SessionStore(dir);
    const session = await store.create({ title: "t", workspace: "/w" });
    await store.append(session.id, {
      type: "item.completed",
      item: update("i1", "added", g("g1", "/codebase")),
    });
    await store.append(session.id, {
      type: "item.completed",
      item: update("i2", "added", g("g2", "/results")),
    });
    await store.append(session.id, {
      type: "item.completed",
      item: update("i3", "revoked", g("g2", "/results")),
    });
    const loaded = await store.load(session.id);
    expect(activeGrants(loaded.items)).toEqual([g("g1", "/codebase")]);
  });
});

describe("replayEvents script_run normalization (A4b)", () => {
  it("normalizes a mid-approval script_run to failed on replay", () => {
    const items = replay([
      {
        type: "item.completed",
        item: {
          id: "s1",
          type: "script_run",
          command: ["python", "plot.py"],
          rootId: "g1",
          rootLabel: "results",
          status: "pending",
        },
      },
    ]);
    const it0 = items[0];
    expect(it0?.type).toBe("script_run");
    if (it0?.type === "script_run") {
      expect(it0.status).toBe("failed");
      expect(it0.note).toBeDefined();
    }
  });

  it("leaves a completed script_run untouched on replay", () => {
    const items = replay([
      {
        type: "item.completed",
        item: {
          id: "s2",
          type: "script_run",
          command: ["python", "plot.py"],
          rootId: "g1",
          rootLabel: "results",
          status: "completed",
          exitCode: 0,
          stdout: "ok",
        },
      },
    ]);
    const it0 = items[0];
    expect(it0?.type === "script_run" && it0.status).toBe("completed");
  });

  it("replays a compaction checkpoint as an ordinary transcript item (A2)", () => {
    const item: CompactionItem = {
      id: "c1",
      type: "compaction",
      summary: "Drafted §3; the user prefers 'we' over 'the authors'.",
      trigger: "auto",
      retainedItemIds: ["u1"],
      tokensBefore: 118_000,
    };
    const items = replay([
      {
        type: "item.completed",
        item: { id: "u1", type: "user_message", text: "write §3" },
      },
      { type: "item.completed", item },
    ]);
    expect(items.map((i) => i.type)).toEqual(["user_message", "compaction"]);
    expect(items[1]).toEqual(item);
  });
});
