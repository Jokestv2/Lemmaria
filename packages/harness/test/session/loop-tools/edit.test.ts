import { describe, expect, it } from "vitest";
import type {
  EditDecision,
  EditProposalItem,
  SessionEditHost,
  SessionEditPolicy,
  SessionItem,
} from "../../../src/contracts/index.js";
import { createProposeEditTool } from "../../../src/session/loop-tools/edit.js";

function fakeHost(
  files: Record<string, string>,
  policy: SessionEditPolicy,
  decide?: (item: EditProposalItem) => Promise<EditDecision[] | undefined>,
): SessionEditHost {
  return {
    policy: () => policy,
    readFile: async (f) => files[f],
    writeFile: async (f, c) => {
      files[f] = c;
    },
    fileExists: async (f) => f in files,
    requestDecisions: async (item) => (decide ? decide(item) : undefined),
  };
}

function sink() {
  const items: SessionItem[] = [];
  return {
    items,
    emit: async () => {},
    emitItem: async (i: SessionItem) => void items.push(i),
    emitNotice: async () => {},
  };
}

describe("createProposeEditTool (B1)", () => {
  it("is `mutation` and declares NO execution mode — the category is the guard (invariant 3)", async () => {
    // ADR 0025 decision 2: `resolveExecutionMode` forces every mutation tool
    // sequential regardless of declaration, so this tool must not carry one —
    // a field here would imply the field is what protects the write path.
    const s = sink();
    const { tool } = createProposeEditTool({
      editHost: fakeHost({ "paper.tex": "a" }, "review"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
    });
    expect(tool.category).toBe("mutation");
    expect(tool.executionMode).toBeUndefined();
  });

  it("auto_apply writes and records the file in the ledger", async () => {
    const files = { "paper.tex": "alpha beta gamma" };
    const s = sink();
    const { tool, applied } = createProposeEditTool({
      editHost: fakeHost(files, "auto_apply"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
    });
    const out = await tool.invoke({
      edits: [{ file: "paper.tex", anchor: "beta", replacement: "BETA" }],
    });
    expect(out.ok).toBe(true);
    expect(files["paper.tex"]).toBe("alpha BETA gamma");
    expect(applied.drain()).toEqual([
      { file: "paper.tex", edits: 1, created: false },
    ]);
    // Drained: a second turn must not re-report the same file.
    expect(applied.drain()).toEqual([]);
  });

  it("review with a rejection writes nothing and hands the note back", async () => {
    const files = { "paper.tex": "alpha beta gamma" };
    const s = sink();
    const { tool, applied } = createProposeEditTool({
      editHost: fakeHost(files, "review", async () => [
        { accept: false, note: "too formal" },
      ]),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
    });
    const out = await tool.invoke({
      edits: [{ file: "paper.tex", anchor: "beta", replacement: "BETA" }],
    });
    expect(files["paper.tex"]).toBe("alpha beta gamma");
    expect(applied.drain()).toEqual([]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual({
        decisions: [
          { file: "paper.tex", status: "rejected", note: "too formal" },
        ],
      });
    }
  });

  it("an interrupted pause leaves the batch stale and writes nothing", async () => {
    const files = { "paper.tex": "alpha beta gamma" };
    const s = sink();
    const controller = new AbortController();
    const { tool } = createProposeEditTool({
      editHost: fakeHost(
        files,
        "review",
        () =>
          new Promise<EditDecision[] | undefined>(() => {
            // Never resolves: the abort race is what must end this call.
            controller.abort();
          }),
      ),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
      signal: controller.signal,
    });
    const out = await tool.invoke({
      edits: [{ file: "paper.tex", anchor: "beta", replacement: "BETA" }],
    });
    expect(files["paper.tex"]).toBe("alpha beta gamma");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        decisions: [{ file: "paper.tex", status: "stale" }],
      });
    }
  });

  it("an unparseable batch is an `invalid` ToolError and emits no proposal", async () => {
    const s = sink();
    const { tool } = createProposeEditTool({
      editHost: fakeHost({}, "review"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
    });
    const out = await tool.invoke({ edits: "not an array" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("invalid");
    expect(s.items).toEqual([]);
  });

  it("advertises the allowlisted name and the mutation category", () => {
    const s = sink();
    const { tool } = createProposeEditTool({
      editHost: fakeHost({}, "review"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
    });
    expect(tool.name).toBe("propose_edit");
    expect(tool.category).toBe("mutation");
  });
});

/**
 * D1 (ADR 0032): the refusal reaches the tool, under BOTH policies, and writes
 * nothing. Asserted against the fake host's file bytes rather than the returned
 * status — invariant 3 is about what landed on disk.
 */
describe("createProposeEditTool — protected spans (D1)", () => {
  const source = "The result holds. % TODO: verify this\n";
  const spanReader = (file: string, text: string) =>
    Promise.resolve(
      [...text.matchAll(/%[^\n]*/g)].map((m) => ({
        file,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        kind: "comment" as const,
        token: "⟦P0⟧",
        raw: m[0],
      })),
    );

  it("auto_apply writes NOTHING when the replacement drops a comment", async () => {
    const files = { "paper.tex": source };
    const s = sink();
    const { tool } = createProposeEditTool({
      editHost: fakeHost(files, "auto_apply"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
      protectedSpans: spanReader,
    });
    const result = await tool.invoke({
      edits: [
        {
          file: "paper.tex",
          anchor: "The result holds. % TODO: verify this",
          replacement: "The result holds firmly.",
        },
      ],
    });
    expect(files["paper.tex"]).toBe(source);
    const decisions = (
      result as { ok: true; value: { decisions: { status: string }[] } }
    ).value.decisions;
    expect(decisions[0]?.status).toBe("invalid");
  });

  it("under review, a violating edit is never offered — even in a batch the user accepts wholesale", async () => {
    // Deliberately a MIXED batch. With a single violating edit the tool returns
    // early (`anyValid === false`) and never reaches the policy branch at all,
    // so "the user was not asked" would be true for the wrong reason. Here the
    // batch DOES pause — for the clean edit — and the user accepts everything;
    // the violating edit must still not be written.
    const files = { "paper.tex": source, "notes.tex": "plain prose here\n" };
    const s = sink();
    let offered: string[] = [];
    const { tool } = createProposeEditTool({
      editHost: fakeHost(files, "review", async (item) => {
        offered = item.edits
          .filter((e) => e.status === "pending")
          .map((e) => e.file);
        return item.edits.map(() => ({ accept: true }));
      }),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
      protectedSpans: spanReader,
    });
    const result = await tool.invoke({
      edits: [
        {
          file: "paper.tex",
          anchor: "The result holds. % TODO: verify this",
          replacement: "The result holds firmly.",
        },
        {
          file: "notes.tex",
          anchor: "plain prose here",
          replacement: "plainer prose here",
        },
      ],
    });
    // The user was shown only the clean edit as a decision.
    expect(offered).toEqual(["notes.tex"]);
    expect(files["paper.tex"]).toBe(source);
    expect(files["notes.tex"]).toBe("plainer prose here\n");
    const decisions = (
      result as { ok: true; value: { decisions: { status: string }[] } }
    ).value.decisions;
    expect(decisions.map((d) => d.status)).toEqual(["invalid", "applied"]);
  });

  it("applies the same edit once the comment is reproduced", async () => {
    const files = { "paper.tex": source };
    const s = sink();
    const { tool } = createProposeEditTool({
      editHost: fakeHost(files, "auto_apply"),
      emit: s.emit,
      emitItem: s.emitItem,
      emitNotice: s.emitNotice,
      userMessageId: "u1",
      protectedSpans: spanReader,
    });
    await tool.invoke({
      edits: [
        {
          file: "paper.tex",
          anchor: "The result holds. % TODO: verify this",
          replacement: "The result holds firmly. % TODO: verify this",
        },
      ],
    });
    expect(files["paper.tex"]).toBe(
      "The result holds firmly. % TODO: verify this\n",
    );
  });
});
