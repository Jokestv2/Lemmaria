import { afterAll, describe, expect, it } from "vitest";
import type { ToolName } from "../../src/contracts/index.js";
import { ok } from "../../src/contracts/results.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  cleanupSessionHarnesses,
  createSessionHarness,
} from "../support/session-harness.js";

afterAll(cleanupSessionHarnesses);

/** A minimal read-tool registry (the engine-test stubbing discipline). */
function readRegistry(): Map<ToolName, ToolExecutor> {
  const registry = new Map<ToolName, ToolExecutor>();
  registry.set("read_span", {
    name: "read_span",
    category: "retrieval",
    spec: {
      name: "read_span",
      description: "read a section",
      parameters: { type: "object" },
    },
    invoke: async (args) =>
      ok({
        content: `content of ${(args as { section?: string }).section ?? "?"}`,
      }),
  });
  return registry;
}

describe("createSessionHarness (B0)", () => {
  it("runs a one-turn task in three lines", async () => {
    const h = await createSessionHarness({ turns: [{ text: "Hello!" }] });
    const result = await h.run({ text: "hi" });
    expect(result.status).toBe("completed");
    expect(h.itemTypes(result)).toEqual(["user_message", "agent_message"]);
  });

  it("collects the live event stream and persists the same transcript", async () => {
    const h = await createSessionHarness({ turns: [{ text: "yo" }] });
    const result = await h.run({ text: "hi" });
    expect(h.events[0]?.type).toBe("task.started");
    expect(h.events.at(-1)).toEqual({
      type: "task.completed",
      status: "completed",
    });
    expect((await h.store.load(h.session.id)).items).toEqual(result.items);
  });

  it("binds a VERIFIED model by default, so no test trips the floor notice", async () => {
    // ADR 0023's `model.unverified` notice is an assertion hazard for every
    // loop test that does not mean to exercise it. The default removes it.
    const h = await createSessionHarness({ turns: [{ text: "yo" }] });
    const result = await h.run({ text: "hi" });
    expect(
      result.items.some(
        (i) => i.type === "notice" && i.code === "model.unverified",
      ),
    ).toBe(false);
  });

  it("wires a supplied tool registry through to the loop", async () => {
    const h = await createSessionHarness({
      turns: [
        {
          toolCalls: [
            { id: "r1", name: "read_span", args: { section: "Intro" } },
          ],
        },
        { text: "done" },
      ],
      registry: readRegistry(),
    });
    const result = await h.run({ text: "read the intro" });
    expect(h.itemTypes(result)).toEqual([
      "user_message",
      "tool_call",
      "agent_message",
    ]);
  });

  // ── The two paths that had no adapter-driven coverage before B0 ──────────

  it("a scripted mid-stream abort ends the task interrupted, nothing partial persisted", async () => {
    const h = await createSessionHarness({
      turns: [{ text: "a long answer", abortAfterDeltas: 1 }],
    });
    const result = await h.run({ text: "go" });
    expect(result.status).toBe("interrupted");
    expect(h.itemTypes(result)).toEqual(["user_message", "interrupted"]);
    const loaded = await h.store.load(h.session.id);
    for (const { event } of loaded.entries) {
      expect(
        event.type === "item.started" || event.type === "item.updated",
      ).toBe(false);
    }
  });

  it("a script that runs out fails LOUDLY, naming the script, not a provider blip", async () => {
    const h = await createSessionHarness({
      // Asks for a turn 2 that does not exist.
      turns: [
        {
          toolCalls: [
            { id: "r1", name: "read_span", args: { section: "Intro" } },
          ],
        },
      ],
      registry: readRegistry(),
    });
    const result = await h.run({ text: "go" });
    // The loop never throws (its own contract), but the failure must name the
    // script rather than read as a retryable provider failure — that is how an
    // over-run script would otherwise slip through green.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/script ran out/);
  });
});
