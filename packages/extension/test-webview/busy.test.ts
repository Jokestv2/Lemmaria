import { describe, expect, it } from "vitest";
import {
  type BusyState,
  busyRowVisible,
  isStreamRetried,
  nextTurnStreamed,
  turnStreamedFromSnapshot,
} from "../src/webview/parts/busy.js";

const state = (over: Partial<BusyState> = {}): BusyState => ({
  sessionBusy: true,
  awaitsEditDecision: false,
  awaitsScript: false,
  turnStreamed: false,
  ...over,
});

describe("busyRowVisible (CHAT-3)", () => {
  it("shows while the task is busy and nothing has arrived yet", () => {
    expect(busyRowVisible(state())).toBe(true);
  });

  it("hides once the current turn has emitted its first agent_message delta", () => {
    // Codex hides the status row at the first committed stream cell, "to avoid
    // duplicate 'in progress' affordances". Pi keeps its spinner up for the
    // whole turn — which is the reported defect (ADR 0037 §5).
    expect(busyRowVisible(state({ turnStreamed: true }))).toBe(false);
  });

  it("still hides while an edit decision is pending (A1b regression)", () => {
    expect(busyRowVisible(state({ awaitsEditDecision: true }))).toBe(false);
  });

  it("still hides while a script approval is pending (A4b regression)", () => {
    expect(busyRowVisible(state({ awaitsScript: true }))).toBe(false);
  });

  it("hides when the task is not busy at all", () => {
    expect(busyRowVisible(state({ sessionBusy: false }))).toBe(false);
    expect(
      busyRowVisible(state({ sessionBusy: false, turnStreamed: true })),
    ).toBe(false);
  });

  it("returns on the next turn, once its streamed flag is reset", () => {
    // This is Codex's deferred restore, and Lemmaria gets it without a second
    // mechanism: `sessionBusy` is re-set on every `turn.started`, so resetting
    // `turnStreamed` at the same point is the whole of it.
    expect(busyRowVisible(state({ turnStreamed: true }))).toBe(false);
    expect(busyRowVisible(state({ turnStreamed: false }))).toBe(true);
  });

  it("lets a pending decision win over a streamed turn", () => {
    // Both suppress it; neither may resurrect it.
    expect(
      busyRowVisible(state({ turnStreamed: true, awaitsEditDecision: true })),
    ).toBe(false);
  });
});

describe("nextTurnStreamed", () => {
  it("clears at the start of a task and of every turn", () => {
    expect(nextTurnStreamed(true, { type: "task.started" })).toBe(false);
    expect(nextTurnStreamed(true, { type: "turn.started" })).toBe(false);
  });

  it("sets on any agent_message event, delta or completion", () => {
    for (const type of ["item.started", "item.updated", "item.completed"]) {
      expect(
        nextTurnStreamed(false, { type, item: { type: "agent_message" } }),
      ).toBe(true);
    }
  });

  it("recognises the retry notice through one shared, typed predicate", () => {
    // The same event is read twice — here, to clear the flag, and in main.ts,
    // to drop the uncompleted items. Two copies of the literal would let a
    // contract rename break one half with the suite still green.
    expect(
      isStreamRetried({
        type: "item.completed",
        item: { type: "notice", code: "stream.retried" },
      }),
    ).toBe(true);
    expect(
      isStreamRetried({
        type: "item.updated",
        item: { type: "notice", code: "stream.retried" },
      }),
    ).toBe(false);
    expect(
      isStreamRetried({
        type: "item.completed",
        item: { type: "agent_message" },
      }),
    ).toBe(false);
  });

  it("CLEARS on stream.retried, which discards the partial answer", () => {
    // The regression the code review caught. The retry loop is INSIDE the
    // turn, so no `turn.started` follows — but `dropUncompletedItems` has just
    // removed the partial answer from the transcript. Left set, the busy row
    // stays suppressed through the backoff and the retried attempt with
    // nothing on screen at all.
    expect(
      nextTurnStreamed(true, {
        type: "item.completed",
        item: { type: "notice", code: "stream.retried" },
      }),
    ).toBe(false);
  });

  it("does not clear on some other notice", () => {
    expect(
      nextTurnStreamed(true, {
        type: "item.completed",
        item: { type: "notice", code: "provider.quota" },
      }),
    ).toBe(true);
  });

  it("clears when the task ends", () => {
    expect(nextTurnStreamed(true, { type: "task.completed" })).toBe(false);
  });

  it("leaves the flag alone for everything else", () => {
    expect(
      nextTurnStreamed(true, {
        type: "item.completed",
        item: { type: "tool_call" },
      }),
    ).toBe(true);
    expect(
      nextTurnStreamed(false, {
        type: "item.completed",
        item: { type: "tool_call" },
      }),
    ).toBe(false);
    expect(nextTurnStreamed(true, { type: "turn.completed" })).toBe(true);
  });
});

describe("turnStreamedFromSnapshot (the reload path)", () => {
  it("is true when the newest item is the answer being written", () => {
    expect(
      turnStreamedFromSnapshot([
        { type: "user_message" },
        { type: "agent_message" },
      ]),
    ).toBe(true);
  });

  it("is false when the newest item is anything else", () => {
    expect(
      turnStreamedFromSnapshot([
        { type: "agent_message" },
        { type: "tool_call" },
      ]),
    ).toBe(false);
    expect(turnStreamedFromSnapshot([{ type: "user_message" }])).toBe(false);
  });

  it("is false for an empty transcript", () => {
    expect(turnStreamedFromSnapshot([])).toBe(false);
  });
});
