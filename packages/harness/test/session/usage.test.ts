import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/contracts/sessions.js";
import { SessionStore } from "../../src/session/store.js";
import { sumSessionUsage } from "../../src/session/usage.js";
import { linearEntries } from "../support/entries.js";

/**
 * The fold reads a session's ENTRIES, which since ADR 0057 is its whole
 * conversation. The fork cases — what a child inherits, and what stays charged
 * to the parent — are the last two tests in this file.
 */
const sumEvents = (events: readonly SessionEvent[]) =>
  sumSessionUsage(linearEntries(events));

/** A `turn.completed` carrying `usage` — the only per-turn usage carrier. */
function turn(
  n: number,
  inputTokens: number,
  outputTokens: number,
  costUsd?: number,
): SessionEvent {
  return {
    type: "turn.completed",
    turn: n,
    usage: {
      inputTokens,
      outputTokens,
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

describe("sumSessionUsage (A5)", () => {
  it("sums the turns' tokens", () => {
    expect(sumEvents([turn(1, 10, 5), turn(2, 7, 3)])).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      unpricedCalls: 2,
    });
  });

  it("omits costUsd when no turn priced one (BYOK/unknown pricing, ADR 0002)", () => {
    // A zeroed cost would read as "this was free"; absent reads as "unknown",
    // which is the truth. Same rule as sumUsage in session/subtasks.ts.
    const total = sumEvents([turn(1, 10, 5), turn(2, 7, 3)]);
    expect(total.costUsd).toBeUndefined();
    expect(Object.hasOwn(total, "costUsd")).toBe(false);
  });

  it("sums the priced turns when at least one reported a cost", () => {
    // A partial total is still worth showing — the UI labels it, it is not
    // silently presented as complete.
    expect(sumEvents([turn(1, 10, 5, 0.02), turn(2, 7, 3)])).toEqual({
      inputTokens: 17,
      outputTokens: 8,
      costUsd: 0.02,
      unpricedCalls: 1,
    });
  });

  it("counts the unpriced calls, so a partial $ total can be marked partial", () => {
    // The number the UI needs: $0.02 over a session that ALSO made two
    // unpriced calls is not the session's cost, and showing it bare would
    // understate the bill by an unknown amount. Zero means the total is whole.
    expect(
      sumEvents([turn(1, 1, 1, 0.01), turn(2, 1, 1, 0.01)]),
    ).toHaveProperty("unpricedCalls", 0);
    expect(
      sumEvents([turn(1, 1, 1, 0.02), turn(2, 1, 1), turn(3, 1, 1)])
        .unpricedCalls,
    ).toBe(2);
  });

  it("includes what a compaction cost — a paid call outside every turn", () => {
    // Summarizing reads the WHOLE conversation, so it is rarely cheap; it
    // reaches no turn.completed, so a turn-only fold reported it as free.
    const events: SessionEvent[] = [
      turn(1, 10, 5, 0.02),
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "compaction",
          summary: "…",
          trigger: "auto",
          retainedItemIds: [],
          tokensBefore: 90_000,
          usage: { inputTokens: 90_000, outputTokens: 800, costUsd: 0.3 },
          at: new Date().toISOString(),
        },
      },
    ];
    expect(sumEvents(events)).toEqual({
      inputTokens: 90_010,
      outputTokens: 805,
      costUsd: 0.32,
      unpricedCalls: 0,
    });
  });

  it("ignores every event that is not a completed turn", () => {
    const events: SessionEvent[] = [
      { type: "task.started", task: 1 },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "user_message",
          text: "hi",
          at: new Date().toISOString(),
        },
      },
      turn(1, 4, 2),
      { type: "task.completed", task: 1, status: "completed" },
    ];
    expect(sumEvents(events)).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      unpricedCalls: 1,
    });
  });

  it("includes a fan-out's children, whose usage never reaches a turn event", () => {
    // turn.completed carries only the PARENT model call's usage (run.ts).
    // A subagent fan-out's cost is accrued into the task total and persisted on
    // the subtask ITEM — so a turn-only fold silently under-reports every
    // session that fanned out, which is exactly the kind of number this project
    // refuses to show.
    const events: SessionEvent[] = [
      turn(1, 10, 5),
      {
        type: "item.completed",
        item: {
          id: "s1",
          type: "subtask",
          status: "completed",
          reports: [],
          usage: { inputTokens: 100, outputTokens: 50 },
          at: new Date().toISOString(),
        },
      },
      turn(2, 3, 2),
    ];
    expect(sumEvents(events)).toEqual({
      inputTokens: 113,
      outputTokens: 57,
      unpricedCalls: 3,
    });
  });

  it("counts a subtask's cost once, from the item, not from the parent turn", () => {
    const events: SessionEvent[] = [
      {
        type: "item.completed",
        item: {
          id: "s1",
          type: "subtask",
          status: "completed",
          reports: [],
          usage: { inputTokens: 8, outputTokens: 4, costUsd: 0.01 },
          at: new Date().toISOString(),
        },
      },
      turn(1, 2, 1, 0.02),
    ];
    expect(sumEvents(events)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.03,
      unpricedCalls: 0,
    });
  });

  it("is zero for an empty stream, never undefined", () => {
    expect(sumEvents([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      unpricedCalls: 0,
    });
  });
});

describe("sumSessionUsage stays WHOLE-SESSION across a rewind (ADR 0027)", () => {
  const temps: string[] = [];
  afterAll(async () => {
    for (const d of temps) await rm(d, { recursive: true, force: true });
  });

  it("still counts a rewound branch's tokens — rewinding is not free", async () => {
    // ADR 0018: "rewinding does not un-charge tokens already spent — cost
    // history is deliberately not rewritten." A spend readout that quietly
    // shrank when the user rewound would be the one failure it cannot afford.
    //
    // ADR 0027 kept that true by refusing to branch-scope this ONE fold.
    // ADR 0057 keeps it true a different way and `sumSessionUsage` is
    // unchanged: the parent still holds the expensive turn, and the child
    // inherits its own copied prefix's cost, so nothing vanishes from every
    // surface. What each session shows is the cost of producing the
    // conversation it holds — Codex's rule.
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-usage-branch-"));
    temps.push(dir);
    const store = new SessionStore(join(dir, "sessions"));
    const meta = await store.create({ title: "t", workspace: "/w" });
    await store.append(meta.id, {
      type: "item.completed",
      item: { id: "u1", type: "user_message", text: "the expensive ask" },
    });
    await store.append(meta.id, turn(1, 1000, 200, 0.05));
    // Rewind past the expensive turn, then spend a little in the child.
    const child = await store.fork(meta.id, { cutBeforeItemId: "u1" });
    await store.append(child.id, turn(2, 10, 5, 0.01));

    // The child carries only what it holds: the cheap turn.
    const childTotal = sumSessionUsage((await store.load(child.id)).entries);
    expect(childTotal).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(childTotal.costUsd).toBeCloseTo(0.01, 10);
    // ...and the expensive turn is still charged, where it was paid.
    const parentTotal = sumSessionUsage((await store.load(meta.id)).entries);
    expect(parentTotal).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      unpricedCalls: 0,
    });
    expect(parentTotal.costUsd).toBeCloseTo(0.05, 10);
  });
});

describe("a fork inherits its prefix's spend (ADR 0057 §7)", () => {
  const forkTemps: string[] = [];
  afterAll(async () => {
    for (const dir of forkTemps)
      await rm(dir, { recursive: true, force: true });
  });

  it("charges the child for the conversation it holds, prefix included", async () => {
    // Codex's rule: "seed usage info from the recorded rollout". A fork at the
    // END copies every record, `usage` with them, so the child's readout is
    // what producing that conversation cost — not zero, and not a number that
    // only makes sense next to its parent's.
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-usage-fork-"));
    forkTemps.push(dir);
    const store = new SessionStore(join(dir, "sessions"));
    const parent = await store.create({ title: "t", workspace: "/w" });
    await store.append(parent.id, turn(1, 1000, 200, 0.05));
    const child = await store.fork(parent.id, {});
    await store.append(child.id, turn(2, 10, 5, 0.01));

    const childTotal = sumSessionUsage((await store.load(child.id)).entries);
    expect(childTotal).toMatchObject({ inputTokens: 1010, outputTokens: 205 });
    expect(childTotal.costUsd).toBeCloseTo(0.06, 10);
    // The parent is unchanged by the fork — its file was never written.
    const parentTotal = sumSessionUsage((await store.load(parent.id)).entries);
    expect(parentTotal).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });
});
