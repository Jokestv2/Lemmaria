import { describe, expect, it } from "vitest";
import { createInMemorySessionStore } from "../../src/session/child-store.js";

describe("createInMemorySessionStore (A3)", () => {
  it("loads empty, then round-trips appended events without touching disk", async () => {
    const store = createInMemorySessionStore();
    expect((await store.load("child-1")).entries).toEqual([]);
    await store.append("child-1", { type: "task.started" });
    await store.append("child-1", {
      type: "task.completed",
      status: "completed",
    });
    const entries = (await store.load("child-1")).entries;
    expect(entries.map((e) => e.event.type)).toEqual([
      "task.started",
      "task.completed",
    ]);
  });

  it("returns a copy so a caller cannot mutate the backing log", async () => {
    const store = createInMemorySessionStore();
    await store.append("c", { type: "task.started" });
    const first = (await store.load("c")).entries;
    first.push({
      id: "x",
      event: { type: "task.completed", status: "completed" },
    });
    expect((await store.load("c")).entries).toHaveLength(1);
  });
});
