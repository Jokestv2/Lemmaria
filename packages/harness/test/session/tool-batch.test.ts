import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ImagePart,
  SessionItem,
  ToolCall,
} from "../../src/contracts/index.js";
import { ok, toolFail } from "../../src/contracts/results.js";
import type { ToolName } from "../../src/contracts/tools.js";
import type { ToolExecutor } from "../../src/engine/tools.js";
import {
  MAX_PARALLEL_TOOLS,
  evictImagesBefore,
  failTruncatedToolBatch,
  planBatchExecution,
  resolveExecutionMode,
  runToolBatch,
} from "../../src/session/tool-batch.js";

const executor = (
  name: ToolName,
  invoke: ToolExecutor["invoke"],
  extra: Partial<Pick<ToolExecutor, "category" | "executionMode">> = {},
): ToolExecutor => ({
  name,
  category: "analysis",
  spec: { name, description: "", parameters: {} },
  invoke,
  ...extra,
});

/** A tool that does nothing, declared however the case under test needs it. */
const stub = (
  name: ToolName,
  extra: Partial<Pick<ToolExecutor, "category" | "executionMode">> = {},
): ToolExecutor => executor(name, async () => ok({}), extra);

const registryOf = (...tools: ToolExecutor[]): Map<ToolName, ToolExecutor> =>
  new Map(tools.map((t) => [t.name, t]));

const call = (name: string, id = `c-${name}`): ToolCall => ({
  id,
  name: name as ToolName,
  args: {},
});

function bed(registry: Map<ToolName, ToolExecutor>, allowed: ToolName[]) {
  const items: SessionItem[] = [];
  const messages: ChatMessage[] = [];
  let counted = 0;
  return {
    items,
    messages,
    counted: () => counted,
    run: (calls: ToolCall[], signal?: AbortSignal) =>
      runToolBatch({
        calls,
        registry,
        allowedTools: allowed,
        callItemIds: calls.map(() => undefined),
        emitItem: async (i) => void items.push(i),
        pushMessage: (m) => void messages.push(m),
        countCall: () => {
          counted += 1;
        },
        emitInterrupted: async () =>
          void items.push({ id: "int", type: "interrupted" }),
        ...(signal ? { signal } : {}),
      }),
  };
}

const errorOf = (json: string | undefined): { code: string; message: string } =>
  JSON.parse(json ?? "{}").error;

describe("resolveExecutionMode (B3, ADR 0025)", () => {
  it("defaults to sequential when a tool declares nothing (D1: deny-by-default)", () => {
    expect(resolveExecutionMode(stub("read_span"))).toBe("sequential");
  });

  it("honours an explicit parallel declaration on a read tool", () => {
    expect(
      resolveExecutionMode(stub("read_span", { executionMode: "parallel" })),
    ).toBe("parallel");
  });

  it("forces a mutation tool sequential even when it declares parallel (invariant 3)", () => {
    // D2: the category is the guard, the declaration is only an optimisation.
    // A tool author who sets this wrongly must not be able to defeat it.
    expect(
      resolveExecutionMode(
        stub("propose_edit", {
          category: "mutation",
          executionMode: "parallel",
        }),
      ),
    ).toBe("sequential");
  });
});

describe("planBatchExecution (B3, ADR 0025)", () => {
  const plan = (
    names: string[],
    registry: Map<ToolName, ToolExecutor>,
    allowed: ToolName[],
  ) =>
    planBatchExecution(
      names.map((n) => call(n)),
      registry,
      allowed,
    );

  const readTools = registryOf(
    stub("read_span", { executionMode: "parallel" }),
    stub("grep_project", { executionMode: "parallel" }),
  );
  const readAllowed: ToolName[] = ["read_span", "grep_project"];

  it("plans parallel when every call resolves to a parallel tool", () => {
    expect(plan(["read_span", "grep_project"], readTools, readAllowed)).toBe(
      "parallel",
    );
  });

  it("one mutation call anywhere makes the WHOLE batch sequential (invariant 3)", () => {
    const registry = registryOf(
      ...readTools.values(),
      stub("propose_edit", { category: "mutation" }),
    );
    const allowed: ToolName[] = [...readAllowed, "propose_edit"];
    // Every position, because `.some` over the batch is the rule — not "the
    // first call decides" and not "a trailing write is fine".
    expect(plan(["propose_edit", "read_span"], registry, allowed)).toBe(
      "sequential",
    );
    expect(plan(["read_span", "propose_edit"], registry, allowed)).toBe(
      "sequential",
    );
    expect(
      plan(["read_span", "propose_edit", "grep_project"], registry, allowed),
    ).toBe("sequential");
  });

  it("a spawn_subtask call makes the batch sequential (invariant 5)", () => {
    // Two overlapping carves would each read the same REMAINING budget and
    // over-allocate; `spawn_subtask` is its own concurrency pool besides.
    const registry = registryOf(...readTools.values(), stub("spawn_subtask"));
    expect(
      plan(["read_span", "spawn_subtask"], registry, [
        ...readAllowed,
        "spawn_subtask",
      ]),
    ).toBe("sequential");
  });

  it("a call outside the allowlist makes the batch sequential (D3: unresolvable ⇒ sequential)", () => {
    expect(plan(["read_span", "run_script"], readTools, readAllowed)).toBe(
      "sequential",
    );
  });

  it("a call with no executor makes the batch sequential", () => {
    expect(
      plan(["read_span", "list_files"], readTools, [
        ...readAllowed,
        "list_files",
      ]),
    ).toBe("sequential");
  });

  it("an empty batch plans parallel — degenerate, and never reached", () => {
    // `shouldStopAfterTurn` ends the task on a turn with no tool calls, so
    // runToolBatch is never handed an empty batch. Pinned anyway because
    // `.every([])` is true and a reader should not have to work that out.
    expect(plan([], readTools, readAllowed)).toBe("parallel");
  });
});

describe("runToolBatch (B1)", () => {
  it("a tool outside the allowlist is `denied` and never looked up", async () => {
    const b = bed(new Map(), ["read_span"]);
    await b.run([call("run_script")]);
    expect(errorOf(b.messages[0]?.content).code).toBe("denied");
    expect(b.items[0]).toMatchObject({ type: "tool_call", status: "failed" });
  });

  it("an allowlisted tool with no executor is `unavailable`", async () => {
    const b = bed(new Map(), ["read_span"]);
    await b.run([call("read_span")]);
    expect(errorOf(b.messages[0]?.content).code).toBe("unavailable");
  });

  it("a tool that throws is reported `unavailable`, not propagated", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "read_span",
        executor("read_span", async () => {
          throw new Error("boom");
        }),
      ],
    ]);
    const b = bed(registry, ["read_span"]);
    await expect(b.run([call("read_span")])).resolves.toEqual({
      interrupted: false,
    });
    const err = errorOf(b.messages[0]?.content);
    expect(err.code).toBe("unavailable");
    expect(err.message).toBe("boom");
  });

  it("the transcript row and the model message carry the SAME bytes, in call order", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      ["read_span", executor("read_span", async () => ok({ text: "one" }))],
      [
        "grep_project",
        executor("grep_project", async () =>
          toolFail("not_found", "nothing here"),
        ),
      ],
    ]);
    const b = bed(registry, ["read_span", "grep_project"]);
    await b.run([call("read_span"), call("grep_project")]);
    expect(b.messages.map((m) => m.toolCallId)).toEqual([
      "c-read_span",
      "c-grep_project",
    ]);
    for (const [i, item] of b.items.entries()) {
      if (item.type !== "tool_call") continue;
      expect(item.resultJson).toBe(b.messages[i]?.content);
    }
    expect(b.counted()).toBe(2);
    expect(errorOf(b.messages[1]?.content).code).toBe("not_found");
  });

  it("caps a huge result identically in the row and the message", async () => {
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "read_span",
        executor("read_span", async () => ok({ text: "x".repeat(200_000) })),
      ],
    ]);
    const b = bed(registry, ["read_span"]);
    await b.run([call("read_span")]);
    const row = b.items[0];
    if (row?.type !== "tool_call") throw new Error("expected a tool_call row");
    expect(row.resultJson?.length).toBeLessThan(200_000);
    expect(row.resultJson).toBe(b.messages[0]?.content);
  });

  it("an already-aborted signal runs nothing, and says so per call (B3 D6)", async () => {
    // Superseding B1's "…emits `interrupted` and runs nothing", whose exact
    // `items`/`messages` assertions encoded the DROP that B3 replaces. The
    // substance it guarded — nothing executes — is re-asserted here.
    const registry = new Map<ToolName, ToolExecutor>([
      [
        "read_span",
        executor("read_span", async () => {
          throw new Error("must not run");
        }),
      ],
    ]);
    const b = bed(registry, ["read_span"]);
    const outcome = await b.run([call("read_span")], AbortSignal.abort());
    expect(outcome).toEqual({ interrupted: true });
    // Nothing ran…
    expect(b.counted()).toBe(0);
    // …but the row the stream opened is closed honestly rather than left
    // reading "running" forever, and the model gets one result per call id so
    // the conversation stays legal for the provider (ADR 0026 decision 7).
    expect(b.items).toEqual([
      expect.objectContaining({
        type: "tool_call",
        tool: "read_span",
        status: "failed",
      }),
      { id: "int", type: "interrupted" },
    ]);
    expect(b.messages.map((m) => m.toolCallId)).toEqual(["c-read_span"]);
    const err = errorOf(b.messages[0]?.content);
    expect(err.code).toBe("unavailable");
    expect(err.message).toMatch(/NOT executed/);
    expect(err.message).toMatch(/interrupted/);
  });
});

describe("runToolBatch — an interrupted batch reports its unrun calls (B3, D6)", () => {
  /**
   * A tool that aborts the run from inside its own invocation — the shape of a
   * user hitting ◼ Stop while the batch is part-way through.
   */
  const abortingTool = (name: ToolName, controller: AbortController) =>
    executor(
      name,
      async () => {
        controller.abort();
        return ok({ from: name });
      },
      { executionMode: "parallel" },
    );

  const unrunOf = (b: ReturnType<typeof bed>) =>
    b.messages
      .filter((m) => errorOf(m.content)?.message?.includes("NOT executed"))
      .map((m) => m.toolCallId);

  it("a SEQUENTIAL batch keeps what ran, reports what did not, and counts only what ran", async () => {
    const controller = new AbortController();
    const registry = registryOf(
      abortingTool("read_span", controller), // runs, then aborts
      executor("grep_project", async () => ok({ hit: true })), // never reached
      executor("list_files", async () => ok({ files: [] })), // never reached
    );
    const b = bed(registry, ["read_span", "grep_project", "list_files"]);
    const outcome = await b.run(
      [call("read_span"), call("grep_project"), call("list_files")],
      controller.signal,
    );
    expect(outcome).toEqual({ interrupted: true });
    // The one that ran keeps its real result and is charged for.
    expect(b.messages[0]?.content).toContain("read_span");
    expect(b.counted()).toBe(1);
    // Invariant 5: budgets count what was SPENT, never what was refused.
    expect(unrunOf(b)).toEqual(["c-grep_project", "c-list_files"]);
    // Every call has exactly one result, and the designed item still closes it.
    expect(b.messages).toHaveLength(3);
    expect(b.items.at(-1)).toEqual({ id: "int", type: "interrupted" });
  });

  it("a call already IN FLIGHT when the abort lands still completes and is counted", async () => {
    // The interesting interleaving, and the one the two tests around it miss:
    // `invoke` takes no AbortSignal (ADR 0024's boundary), so an abort cannot
    // cancel work already started — it must therefore not DISCARD it either.
    // A read the user paid for is a read the transcript owes them.
    const controller = new AbortController();
    let release!: () => void;
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    // The whole first wave blocks, so the pool stays saturated and the fifth
    // call is genuinely still queued when the abort lands. (Tools that
    // returned immediately would free a slot and let it start first.)
    const blocking = (name: ToolName, value: string) =>
      executor(
        name,
        async () => {
          await inFlight;
          return ok({ text: value });
        },
        { executionMode: "parallel" },
      );
    const registry = registryOf(
      blocking("read_span", "finished anyway"),
      blocking("grep_project", "also finished"),
      blocking("list_files", "also finished"),
      blocking("get_outline", "also finished"),
      // Beyond the width of 4 — queued, and never started once aborted.
      executor("list_labels", async () => ok({ labels: [] }), {
        executionMode: "parallel",
      }),
    );
    const names: ToolName[] = [
      "read_span",
      "grep_project",
      "list_files",
      "get_outline",
      "list_labels",
    ];
    const b = bed(registry, names);
    const running = b.run(
      names.map((n) => call(n)),
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 5)); // let the first wave start
    controller.abort();
    release();
    const outcome = await running;

    expect(outcome).toEqual({ interrupted: true });
    // The in-flight read survived the abort with its real result.
    expect(b.messages[0]?.content).toContain("finished anyway");
    // The queued fifth call never started and says so.
    expect(unrunOf(b)).toContain("c-list_labels");
    // Counted = ran, and every call still has exactly one result in order.
    expect(b.counted()).toBe(names.length - unrunOf(b).length);
    expect(b.messages.map((m) => m.toolCallId)).toEqual(
      names.map((n) => `c-${n}`),
    );
  });

  it("a PARALLEL batch does the same for the calls the pool never started", async () => {
    const controller = new AbortController();
    // `abortingTool` aborts synchronously inside its own `invoke`, which runs
    // during the pool's synchronous spin-up — so here almost nothing gets
    // started. The complementary case (an abort landing while a call is in
    // flight) is the test above.
    const names: ToolName[] = [
      "read_span",
      "grep_project",
      "list_files",
      "get_outline",
      "list_labels",
      "count_words",
    ];
    const registry = registryOf(
      abortingTool(names[0] as ToolName, controller),
      ...names.slice(1).map((n) =>
        executor(n, async () => ok({ from: n }), {
          executionMode: "parallel",
        }),
      ),
    );
    const b = bed(registry, names);
    const outcome = await b.run(
      names.map((n) => call(n)),
      controller.signal,
    );
    expect(outcome).toEqual({ interrupted: true });
    expect(b.messages).toHaveLength(names.length); // one result per call id
    expect(unrunOf(b).length).toBeGreaterThan(0); // some were never started
    // Counted = ran. The unrun ones are not charged (invariant 5).
    expect(b.counted()).toBe(names.length - unrunOf(b).length);
    expect(b.items.at(-1)).toEqual({ id: "int", type: "interrupted" });
    // Ordering survives the interrupt: results are still in call order.
    expect(b.messages.map((m) => m.toolCallId)).toEqual(
      names.map((n) => `c-${n}`),
    );
  });
});

/**
 * A pair of instrumented tools that record how many of them were in flight at
 * once. The concurrency PEAK is the real guard for B3: a wall-clock assertion
 * can be satisfied by a fast machine, but a peak of 1 is proof that nothing
 * overlapped and a peak of 2 is proof that something did.
 */
function overlapProbe() {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const make = (
    name: ToolName,
    delayMs: number,
    extra: Partial<Pick<ToolExecutor, "category" | "executionMode">> = {
      executionMode: "parallel",
    },
  ): ToolExecutor =>
    executor(
      name,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`end:${name}`);
        active -= 1;
        return ok({ from: name });
      },
      extra,
    );
  return { make, peak: () => peak, order };
}

describe("runToolBatch — the parallel path (B3, ADR 0025)", () => {
  it("overlaps a batch of declared-parallel reads", async () => {
    const probe = overlapProbe();
    const registry = registryOf(
      probe.make("read_span", 20),
      probe.make("grep_project", 20),
    );
    const b = bed(registry, ["read_span", "grep_project"]);
    await b.run([call("read_span"), call("grep_project")]);
    expect(probe.peak()).toBe(2);
  });

  it("emits rows and messages in CALL order even when the first call is slowest", async () => {
    const probe = overlapProbe();
    const registry = registryOf(
      probe.make("read_span", 40), // slow, called first
      probe.make("grep_project", 1), // fast, called second
    );
    const b = bed(registry, ["read_span", "grep_project"]);
    await b.run([call("read_span"), call("grep_project")]);
    // The fast tool genuinely finished first…
    expect(probe.order.indexOf("end:grep_project")).toBeLessThan(
      probe.order.indexOf("end:read_span"),
    );
    // …and the record the user and the model read is still call order.
    expect(b.messages.map((m) => m.toolCallId)).toEqual([
      "c-read_span",
      "c-grep_project",
    ]);
    expect(
      b.items.map((i) => (i.type === "tool_call" ? i.tool : i.type)),
    ).toEqual(["read_span", "grep_project"]);
    // B1's invariant, unchanged by the new path.
    for (const [i, item] of b.items.entries()) {
      if (item.type !== "tool_call") continue;
      expect(item.resultJson).toBe(b.messages[i]?.content);
    }
    expect(b.counted()).toBe(2);
  });

  it("never runs more than MAX_PARALLEL_TOOLS at once", async () => {
    const probe = overlapProbe();
    const names: ToolName[] = [
      "read_span",
      "grep_project",
      "list_files",
      "get_outline",
      "list_labels",
      "count_words",
      "glossary_lookup",
      "list_citations",
    ];
    const registry = registryOf(...names.map((n) => probe.make(n, 10)));
    const b = bed(registry, names);
    await b.run(names.map((n) => call(n)));
    expect(names.length).toBeGreaterThan(MAX_PARALLEL_TOOLS);
    expect(probe.peak()).toBeLessThanOrEqual(MAX_PARALLEL_TOOLS);
    expect(b.messages).toHaveLength(names.length); // the rest queued, none dropped
  });

  it("one tool throwing does not lose its siblings' results (D8)", async () => {
    // `mapWithConcurrency` joins with Promise.all, so a worker that rejected
    // would discard every sibling — including calls already charged to the
    // budget. ADR 0024's `unavailable` backstop must live INSIDE the worker.
    const registry = registryOf(
      executor("read_span", async () => ok({ text: "kept" }), {
        executionMode: "parallel",
      }),
      executor(
        "grep_project",
        async () => {
          throw new Error("boom");
        },
        { executionMode: "parallel" },
      ),
      executor("list_files", async () => ok({ files: [] }), {
        executionMode: "parallel",
      }),
    );
    const b = bed(registry, ["read_span", "grep_project", "list_files"]);
    await expect(
      b.run([call("read_span"), call("grep_project"), call("list_files")]),
    ).resolves.toEqual({ interrupted: false });
    expect(b.messages).toHaveLength(3);
    expect(b.messages[0]?.content).toContain("kept");
    expect(errorOf(b.messages[1]?.content).code).toBe("unavailable");
    expect(b.messages[2]?.content).toContain("files");
  });

  /**
   * The batch is the whole point of these three: a planner that returns
   * "sequential" is not the guarantee — an observed concurrency peak of 1 is.
   */
  const runMixedBatch = async (
    other: ToolName,
    extra: Partial<Pick<ToolExecutor, "category" | "executionMode">>,
  ) => {
    const probe = overlapProbe();
    const registry = registryOf(
      probe.make("read_span", 20),
      probe.make("grep_project", 20),
      probe.make(other, 20, extra),
    );
    const b = bed(registry, ["read_span", "grep_project", other]);
    await b.run([call("read_span"), call(other), call("grep_project")]);
    return { probe, b };
  };

  it("a batch containing propose_edit executes STRICTLY sequentially (invariant 3)", async () => {
    const { probe, b } = await runMixedBatch("propose_edit", {
      category: "mutation",
    });
    expect(probe.peak()).toBe(1);
    // Strictly one at a time, in call order — no start before the previous end.
    expect(probe.order).toEqual([
      "start:read_span",
      "end:read_span",
      "start:propose_edit",
      "end:propose_edit",
      "start:grep_project",
      "end:grep_project",
    ]);
    expect(b.messages.map((m) => m.toolCallId)).toEqual([
      "c-read_span",
      "c-propose_edit",
      "c-grep_project",
    ]);
  });

  it("a batch containing run_script executes STRICTLY sequentially (invariant 3)", async () => {
    const { probe } = await runMixedBatch("run_script", {
      category: "mutation",
    });
    expect(probe.peak()).toBe(1);
  });

  it("a mutation tool that WRONGLY declares parallel is still serialized (invariant 3)", async () => {
    // The category is the guard; the declaration is only an optimisation.
    const { probe } = await runMixedBatch("propose_edit", {
      category: "mutation",
      executionMode: "parallel",
    });
    expect(probe.peak()).toBe(1);
  });

  it("a batch containing spawn_subtask executes STRICTLY sequentially (invariant 5)", async () => {
    // Two overlapping carves would each read the same remaining budget.
    const { probe } = await runMixedBatch("spawn_subtask", {
      category: "analysis",
      executionMode: "sequential",
    });
    expect(probe.peak()).toBe(1);
  });

  it("a parallel read batch is measurably faster than the sequential path", async () => {
    const DELAY = 60;
    const names: ToolName[] = [
      "read_span",
      "grep_project",
      "list_files",
      "get_outline",
    ];
    const build = (mode: "parallel" | "sequential") =>
      registryOf(
        ...names.map((n) =>
          executor(
            n,
            async () => {
              await new Promise((r) => setTimeout(r, DELAY));
              return ok({ from: n });
            },
            { executionMode: mode },
          ),
        ),
      );
    const timed = async (mode: "parallel" | "sequential") => {
      const b = bed(build(mode), names);
      const started = Date.now();
      await b.run(names.map((n) => call(n)));
      return Date.now() - started;
    };
    const sequentialMs = await timed("sequential");
    const parallelMs = await timed("parallel");
    // Four 60 ms tools: ~240 ms serial against ~60 ms with a width of 4.
    // Generous margins deliberately — this asserts the shape of the win, and
    // the peak assertions above are what pin the mechanism.
    expect(sequentialMs).toBeGreaterThanOrEqual(DELAY * names.length * 0.8);
    expect(parallelMs).toBeLessThan(sequentialMs / 2);
    // An absolute bound as well as a relative one: the relative assertion
    // alone could be satisfied by a stall in the SEQUENTIAL leg on a loaded
    // machine, which would hide a parallel path that had stopped overlapping.
    expect(parallelMs).toBeLessThan(DELAY * 2);
  });
});

describe("failTruncatedToolBatch (B2, ADR 0026)", () => {
  const run = async (calls: ToolCall[]) => {
    const items: SessionItem[] = [];
    const messages: ChatMessage[] = [];
    const outcome = await failTruncatedToolBatch({
      calls,
      callItemIds: [],
      emitItem: async (i) => void items.push(i),
      pushMessage: (m) => void messages.push(m),
    });
    return { items, messages, outcome };
  };

  it("fails every call with `invalid` and tells the model to re-issue it", async () => {
    const { items, messages } = await run([
      call("read_span", "c1"),
      call("propose_edit", "c2"),
    ]);
    expect(items).toHaveLength(2);
    for (const item of items) {
      if (item.type !== "tool_call")
        throw new Error("expected a tool_call row");
      expect(item.status).toBe("failed");
      const parsed = JSON.parse(item.resultJson ?? "{}");
      expect(parsed.error.code).toBe("invalid");
      expect(parsed.error.message).toMatch(/Re-issue the call/);
    }
    // One result per call id: the pairing that keeps the conversation legal
    // for the provider, and therefore what makes continuing possible at all.
    expect(messages.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    expect(messages.every((m) => m.role === "tool")).toBe(true);
  });

  it("never reports itself interrupted — nothing ran, so nothing was cut off", async () => {
    const { outcome } = await run([call("read_span")]);
    expect(outcome).toEqual({ interrupted: false });
  });

  it("does nothing at all for an empty batch", async () => {
    const { items, messages } = await run([]);
    expect(items).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe("images on a tool result (V3, ADR 0080 §4–§5)", () => {
  const png = (label: string, data = "iVBORw0KGgo="): ImagePart => ({
    mimeType: "image/png",
    data,
    label,
  });

  const seeing = (
    name: ToolName,
    images: readonly ImagePart[],
  ): ToolExecutor => ({
    name,
    category: "retrieval",
    spec: { name, description: "", parameters: {} },
    invoke: async () => ({ ...ok({ pages: [1] }), images }),
  });

  it("attaches the executor's images to the pushed tool message and to NOTHING it emits", async () => {
    const b = bed(registryOf(seeing("view_pdf_pages", [png("page 1")])), [
      "view_pdf_pages",
    ]);
    await b.run([call("view_pdf_pages")]);

    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]?.images).toEqual([png("page 1")]);
    // The transcript row is the choke point's OTHER consumer, and it carries
    // no pixel — by construction, so nothing persisted can (ADR 0080 §1).
    expect(b.items).toHaveLength(1);
    expect(JSON.stringify(b.items)).not.toContain("iVBORw0KGgo");
    expect("images" in (b.items[0] as object)).toBe(false);
    // The message text and the row's resultJson are still the SAME bytes.
    const row = b.items[0] as { resultJson?: string };
    expect(b.messages[0]?.content).toBe(row.resultJson);
  });

  it("a tool that returns no images pushes a message with no `images` key at all", async () => {
    const b = bed(registryOf(stub("read_span")), ["read_span"]);
    await b.run([call("read_span")]);
    expect("images" in (b.messages[0] as object)).toBe(false);
  });

  it("images never enter the capped JSON, and a huge result still caps", async () => {
    const big = "x".repeat(40_000);
    const tool: ToolExecutor = {
      name: "view_pdf_pages",
      category: "retrieval",
      spec: { name: "view_pdf_pages", description: "", parameters: {} },
      invoke: async () => ({ ...ok({ blob: big }), images: [png("page 1")] }),
    };
    const b = bed(registryOf(tool), ["view_pdf_pages"]);
    await b.run([call("view_pdf_pages")]);
    expect(b.messages[0]?.content.length ?? 0).toBeLessThan(40_000);
    expect(b.messages[0]?.images).toEqual([png("page 1")]);
  });
});

describe("evictImagesBefore (V3, ADR 0080 §5)", () => {
  const live = (label: string): ImagePart => ({
    mimeType: "image/png",
    data: "AAA=",
    label,
  });

  it("strips data from every earlier part, keeping mimeType and label", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "tool",
        content: "a",
        toolCallId: "c1",
        images: [live("page 1")],
      },
      { role: "assistant", content: "seen" },
      {
        role: "tool",
        content: "b",
        toolCallId: "c2",
        images: [live("page 2")],
      },
    ];
    const evicted = evictImagesBefore(messages, 3);
    expect(evicted).toBe(1);
    expect(messages[1]?.images).toEqual([
      { mimeType: "image/png", label: "page 1" },
    ]);
    // The latest batch keeps its pixels.
    expect(messages[3]?.images?.[0]?.data).toBe("AAA=");
  });

  it("changes NO message's content — the byte-identity rule run.ts states", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "tool",
        content: "a",
        toolCallId: "c1",
        images: [live("page 1")],
      },
      {
        role: "tool",
        content: "b",
        toolCallId: "c2",
        images: [live("page 2")],
      },
    ];
    const before = messages.map((m) => m.content);
    evictImagesBefore(messages, 2);
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it("is idempotent, and reports zero when there was nothing live to evict", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "a",
        toolCallId: "c1",
        images: [live("page 1")],
      },
      { role: "user", content: "next" },
    ];
    expect(evictImagesBefore(messages, 1)).toBe(1);
    expect(evictImagesBefore(messages, 1)).toBe(0);
  });

  it("leaves a history with no images alone", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", content: "a", toolCallId: "c1" },
    ];
    expect(evictImagesBefore(messages, 2)).toBe(0);
    expect(messages[1]?.images).toBeUndefined();
  });
});

describe("the batch copies an outcome's image parts (V3, ADR 0080 §4-§5)", () => {
  it("evicting the pushed message does NOT blank the buffer the tool returned", async () => {
    // Eviction mutates `data` IN PLACE. If report() attached the executor's
    // own ImagePart objects rather than copies, evicting a message would
    // reach back into whatever the tool still holds — a live tool keeping a
    // render cache would find its entries silently blanked.
    const held: ImagePart[] = [
      { mimeType: "image/png", data: "AAA=", label: "page 1" },
    ];
    const tool: ToolExecutor = {
      name: "view_pdf_pages",
      category: "retrieval",
      spec: { name: "view_pdf_pages", description: "", parameters: {} },
      invoke: async () => ({ ...ok({ pages: [1] }), images: held }),
    };
    const b = bed(registryOf(tool), ["view_pdf_pages"]);
    await b.run([call("view_pdf_pages")]);

    // The message got its own copy…
    expect(b.messages[0]?.images?.[0]).not.toBe(held[0]);
    expect(b.messages[0]?.images?.[0]?.data).toBe("AAA=");

    // …so evicting it leaves the tool's own array untouched.
    evictImagesBefore(b.messages, b.messages.length);
    expect(b.messages[0]?.images?.[0]?.data).toBeUndefined();
    expect(held[0]?.data).toBe("AAA=");
  });
});
