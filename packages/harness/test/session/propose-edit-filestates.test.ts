import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EditProposalItem } from "../../src/contracts/index.js";
import { createProposeEditTool } from "../../src/session/loop-tools/edit.js";
import { SnapshotStore } from "../../src/session/snapshot-store.js";
import { stubEditHost } from "./helpers/edit-host.js";

describe("propose_edit records fileStates", () => {
  it("records before and after for a replace", async () => {
    const snapshots = new SnapshotStore(
      mkdtempSync(join(tmpdir(), "lemmaria-blobs-")),
    );
    const items: EditProposalItem[] = [];
    const host = stubEditHost({ "a.tex": "hello world" });
    const { tool } = createProposeEditTool({
      editHost: host,
      snapshots,
      emit: async () => {},
      emitItem: async (item) => {
        if (item.type === "edit_proposal") items.push(item);
      },
      emitNotice: async () => {},
      userMessageId: "m1",
    });

    await tool.invoke({
      edits: [{ file: "a.tex", anchor: "world", replacement: "there" }],
    });

    const states = items.at(-1)?.fileStates;
    expect(states).toHaveLength(1);
    const [state] = states ?? [];
    if (!state || state.before === null) {
      throw new Error("expected one file state with a before sha");
    }
    expect(await snapshots.get(state.before)).toBe("hello world");
    expect(await snapshots.get(state.after)).toBe("hello there");
  });

  it("records before: null for a create, so a rewind can delete it", async () => {
    const snapshots = new SnapshotStore(
      mkdtempSync(join(tmpdir(), "lemmaria-blobs-")),
    );
    const items: EditProposalItem[] = [];
    const { tool } = createProposeEditTool({
      editHost: stubEditHost({}),
      snapshots,
      emit: async () => {},
      emitItem: async (item) => {
        if (item.type === "edit_proposal") items.push(item);
      },
      emitNotice: async () => {},
      userMessageId: "m1",
    });

    await tool.invoke({
      edits: [{ file: "new.tex", create: true, content: "fresh" }],
    });

    const states = items.at(-1)?.fileStates;
    expect(states).toEqual([
      { file: "new.tex", before: null, after: expect.any(String) },
    ]);
    const [state] = states ?? [];
    if (!state) throw new Error("expected one file state");
    expect(await snapshots.get(state.after)).toBe("fresh");
  });

  it("keeps the FIRST before and the LAST after when a batch touches one file twice", async () => {
    const snapshots = new SnapshotStore(
      mkdtempSync(join(tmpdir(), "lemmaria-blobs-")),
    );
    const items: EditProposalItem[] = [];
    const { tool } = createProposeEditTool({
      editHost: stubEditHost({ "a.tex": "one two" }),
      snapshots,
      emit: async () => {},
      emitItem: async (item) => {
        if (item.type === "edit_proposal") items.push(item);
      },
      emitNotice: async () => {},
      userMessageId: "m1",
    });

    await tool.invoke({
      edits: [
        { file: "a.tex", anchor: "one", replacement: "1" },
        { file: "a.tex", anchor: "two", replacement: "2" },
      ],
    });

    const states = items.at(-1)?.fileStates;
    expect(states).toHaveLength(1);
    const [state] = states ?? [];
    if (!state || state.before === null) {
      throw new Error("expected one file state with a before sha");
    }
    expect(await snapshots.get(state.before)).toBe("one two");
    expect(await snapshots.get(state.after)).toBe("1 2");
  });

  it("does not leak one batch's files into the next batch of the same task", async () => {
    // createProposeEditTool runs ONCE per task; invoke runs per batch.
    const snapshots = new SnapshotStore(
      mkdtempSync(join(tmpdir(), "lemmaria-blobs-")),
    );
    const items: EditProposalItem[] = [];
    const { tool } = createProposeEditTool({
      editHost: stubEditHost({ "a.tex": "aa", "b.tex": "bb" }),
      snapshots,
      emit: async () => {},
      emitItem: async (item) => {
        if (item.type === "edit_proposal") items.push(item);
      },
      emitNotice: async () => {},
      userMessageId: "m1",
    });

    await tool.invoke({
      edits: [{ file: "a.tex", anchor: "aa", replacement: "AA" }],
    });
    await tool.invoke({
      edits: [{ file: "b.tex", anchor: "bb", replacement: "BB" }],
    });

    expect(items.at(-1)?.fileStates?.map((s) => s.file)).toEqual(["b.tex"]);
  });

  it("omits fileStates entirely from a later batch that applied nothing", async () => {
    const snapshots = new SnapshotStore(
      mkdtempSync(join(tmpdir(), "lemmaria-blobs-")),
    );
    const items: EditProposalItem[] = [];
    const { tool } = createProposeEditTool({
      editHost: stubEditHost({ "a.tex": "aa" }),
      snapshots,
      emit: async () => {},
      emitItem: async (item) => {
        if (item.type === "edit_proposal") items.push(item);
      },
      emitNotice: async () => {},
      userMessageId: "m1",
    });

    await tool.invoke({
      edits: [{ file: "a.tex", anchor: "aa", replacement: "AA" }],
    });
    // An anchor that no longer matches: nothing applies, so nothing is recorded.
    await tool.invoke({
      edits: [{ file: "a.tex", anchor: "aa", replacement: "XX" }],
    });

    expect(items.at(-1)?.fileStates).toBeUndefined();
  });
});
