// A0 acceptance suite (composer = session entry point, ADR 0014), extended by
// A1a (ADR 0015): composerSend now runs the streamed multi-turn task loop —
// item deltas stream to the webview, a send during a live task becomes
// steering, interruptTask aborts cleanly, and Lemmaria: New Session starts a
// fresh thread. Quick actions must never touch the session store.
import * as assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface SessionApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  clearModelsForTests(): Promise<void>;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  routeInboundMessageForTests(msg: WebviewToHost): void;
  sessionEventsForTests(): SessionEvent[];
  sessionStoreDirForTests(): string | undefined;
  resetSessionForTests(): void;
  /** A5: destroy this host's in-memory session state the way a window reload
   *  does, then re-run the activation restore. */
  simulateWindowReloadForTests(): Promise<boolean>;
  addGrantForTests(folderPath: string): Promise<{ id: string }>;
  activeSessionGrantsForTests(): { id: string }[];
  // A2 (ADR 0021): compaction + resume seams.
  listSessionsForTests(): Promise<
    { meta: { id: string; title: string }; files: Record<string, string> }[]
  >;
  resumeSessionForTests(id: string): Promise<boolean>;
  activeSessionIdForTests(): string | undefined;
  compactSessionForTests(): Promise<boolean>;
  setSessionPickerForTests(
    picker?: (choices: { id: string; label: string }[]) => string | undefined,
  ): void;
  branchPointsForTests(): Promise<string[]>;
  lastContextUsageForTests(): { occupied?: number; window: number } | undefined;
  sessionItemsForTests(): Promise<{ type: string }[]>;
  // A5: the outbound counterpart of routeInboundMessageForTests.
  postedToWebviewForTests(): readonly {
    type: string;
    [k: string]: unknown;
  }[];
  clearPostedToWebviewForTests(): void;
}

interface TestTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

/**
 * Deterministic streaming model: turn i streams turns[i] (sticks on last).
 * An optional `gate` promise holds the stream open mid-turn so tests can
 * steer or interrupt deterministically.
 */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(
    private readonly turns: TestTurn[],
    private readonly gate?: () => Promise<void>,
  ) {}

  private nextTurn(): TestTurn {
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)] ?? {};
    this.i += 1;
    return turn;
  }

  private result(turn: TestTurn): GenerateResult {
    const toolCalls = turn.toolCalls ?? [];
    return {
      text: turn.text ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve(this.result(this.nextTurn()));
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    const turn = this.nextTurn();
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    if (turn.text) yield { type: "text_delta", text: turn.text };
    if (this.gate) await this.gate();
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: call.id,
        name: call.name,
        argsDelta: JSON.stringify(call.args ?? {}),
      };
      if (req.signal?.aborted) {
        yield { type: "aborted" };
        return;
      }
    }
    yield { type: "completed", result: this.result(turn) };
  }
}

/**
 * A model that dispatches on the exact last user message content, so one
 * adapter drives the parent task and each spawn_subtask child (A3) — the
 * children are separate ephemeral sessions whose only user message is the goal,
 * and they run in parallel, so a shared sequential cursor would be nondeterministic.
 */
class KeyedModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private readonly cursors = new Map<string, number>();
  constructor(private readonly scripts: Record<string, TestTurn[]>) {}
  private keyFor(req: GenerateRequest): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    return typeof lastUser?.content === "string" ? lastUser.content : "";
  }
  private nextTurn(key: string): TestTurn {
    const turns = this.scripts[key] ?? [{ text: "unscripted" }];
    const i = this.cursors.get(key) ?? 0;
    const turn = turns[Math.min(i, turns.length - 1)] ?? {};
    this.cursors.set(key, i + 1);
    return turn;
  }
  private result(turn: TestTurn): GenerateResult {
    const toolCalls = turn.toolCalls ?? [];
    return {
      text: turn.text ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve(this.result(this.nextTurn(this.keyFor(req))));
  }
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    const turn = this.nextTurn(this.keyFor(req));
    if (turn.text) yield { type: "text_delta", text: turn.text };
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: call.id,
        name: call.name,
        argsDelta: JSON.stringify(call.args ?? {}),
      };
    }
    yield { type: "completed", result: this.result(turn) };
  }
}

async function getApi(): Promise<SessionApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as SessionApi;
}

function jsonlFiles(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // store dir not created yet
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface TaskOutcome {
  status: string;
  items: { type: string; text?: string; status?: string }[];
}

suite("A0/A1a: composer agentic session", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // NOTE: globalStorage persists across test runs, so file assertions identify
  // THIS run's session by a unique message (or use before/after deltas), never
  // absolute counts.
  test("composerSend round-trips an agent_message, streams deltas, persists JSONL", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "Hello from the model" }]));
    const unique = `hi lemmaria ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.deepStrictEqual(
        outcome.items.map((i) => i.type),
        ["user_message", "agent_message"],
      );

      const events = api.sessionEventsForTests();
      assert.ok(
        events.some(
          (e) =>
            e.type === "item.completed" &&
            e.item.type === "agent_message" &&
            e.item.text === "Hello from the model",
        ),
        "an agent_message item.completed event streamed to the webview",
      );
      // A1a: the task boundary events frame the stream.
      assert.strictEqual(events[0]?.type, "task.started");
      assert.deepStrictEqual(events.at(-1), {
        type: "task.completed",
        status: "completed",
      });

      const dir = api.sessionStoreDirForTests();
      assert.ok(dir, "session store dir resolved");
      const mine = jsonlFiles(dir).filter((f) => {
        const firstLine = readFileSync(path.join(dir, f), "utf8").split(
          "\n",
        )[0];
        const parsed = JSON.parse(firstLine ?? "{}") as {
          kind?: string;
          meta?: { title?: string };
        };
        return parsed.kind === "meta" && parsed.meta?.title === unique;
      });
      assert.strictEqual(
        mine.length,
        1,
        "exactly one session file for this turn",
      );
      // sessions live under globalStorage (ADR 0014 Q2), never the paper repo
      assert.ok(
        dir.replace(/\\/g, "/").includes("/sessions/"),
        `session dir is the globalStorage sessions home: ${dir}`,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a second composerSend appends to the same session (no new file)", async () => {
    const api = await getApi();
    const model = new TestModel([{ text: "again" }]);
    api.setModelForTests(model);
    const before = jsonlFiles(api.sessionStoreDirForTests()).length;
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "more please",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      // the prior conversation rides along as history
      const roles = model.requests[0]?.messages.map((m) => m.role) ?? [];
      assert.deepStrictEqual(roles, ["system", "user", "assistant", "user"]);
      assert.strictEqual(
        jsonlFiles(api.sessionStoreDirForTests()).length,
        before,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a composerSend during a live task becomes steering, run as a follow-up (A1a)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    let firstCall = true;
    // Only the FIRST streamed turn is held open; the steered follow-up task
    // must run through.
    const gate = () => {
      if (!firstCall) return Promise.resolve();
      firstCall = false;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    const model = new TestModel(
      [{ text: "first answer" }, { text: "steered answer" }],
      gate,
    );
    api.setModelForTests(model);
    try {
      const p1 = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "task one",
      });
      await waitFor(() => release !== undefined, "the stream to open");
      const o2 = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "and also this",
      })) as { status: string };
      assert.strictEqual(o2.status, "steered");
      release?.();
      const o1 = (await p1) as TaskOutcome;
      assert.strictEqual(o1.status, "completed");
      // The steered text ran as its own follow-up task on the same session.
      const events = api.sessionEventsForTests();
      const userTexts = events
        .filter(
          (e) => e.type === "item.completed" && e.item.type === "user_message",
        )
        .map((e) =>
          e.type === "item.completed" && e.item.type === "user_message"
            ? e.item.text
            : "",
        );
      assert.deepStrictEqual(userTexts, ["task one", "and also this"]);
      assert.deepStrictEqual(events.at(-1), {
        type: "task.completed",
        status: "completed",
      });
    } finally {
      api.clearModelForTests();
    }
  });

  test("interruptTask aborts the live task cleanly (A1a)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    const gate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const model = new TestModel([{ text: "long running answer" }], gate);
    api.setModelForTests(model);
    try {
      const p = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "do something long",
      });
      await waitFor(() => release !== undefined, "the stream to open");
      await api.dispatchWebviewMessageForTests({ type: "interruptTask" });
      release?.();
      const outcome = (await p) as TaskOutcome;
      assert.strictEqual(outcome.status, "interrupted");
      const events = api.sessionEventsForTests();
      assert.ok(
        events.some(
          (e) => e.type === "item.completed" && e.item.type === "interrupted",
        ),
        "the interrupted item is first-class in the stream",
      );
      assert.deepStrictEqual(events.at(-1), {
        type: "task.completed",
        status: "interrupted",
      });
    } finally {
      api.clearModelForTests();
    }
  });

  test("interruptTask through the provider inbound router aborts the task (real path, not the whitelist)", async () => {
    // The webview's Stop posts { type: "interruptTask" }; before this fix the
    // provider's hand-maintained inbound whitelist omitted that type, so it was
    // silently dropped in the real extension while the dispatch-seam test stayed
    // green. Deliver it through the SAME router the provider view uses.
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    const gate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const model = new TestModel([{ text: "long running answer" }], gate);
    api.setModelForTests(model);
    try {
      const p = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "do something long",
      });
      await waitFor(() => release !== undefined, "the stream to open");
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "interruptTask" });
      release?.();
      const outcome = (await p) as TaskOutcome;
      assert.strictEqual(outcome.status, "interrupted");
      // A5: the composer's Stop button only reverts to Send when the webview
      // sees task.completed — assert the UI actually receives that signal, not
      // just that the host-side promise settled.
      const posted = api.postedToWebviewForTests();
      const completed = posted.some(
        (m) =>
          m.type === "sessionEvent" &&
          (m.event as { type?: string }).type === "task.completed",
      );
      assert.ok(completed, "the webview is told the task ended");
      const interrupted = posted.some(
        (m) =>
          m.type === "sessionEvent" &&
          (m.event as { type?: string; item?: { type?: string } }).item
            ?.type === "interrupted",
      );
      assert.ok(interrupted, "the transcript gets its ⏹ interrupted item");
    } finally {
      api.clearModelForTests();
    }
  });

  // D2 (CHAT-6) moved ＋ New out of the global header into the Assistant tab's
  // own strip. The message it posts is unchanged, which is what this covers.
  test("the ＋ New Session button (webview newSession) starts a fresh thread through the inbound router", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "reply" }]));
    try {
      const first = `first thread ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: first,
      });
      const before = jsonlFiles(api.sessionStoreDirForTests()).length;
      // The ＋ button posts { type: "newSession" } — it must reach
      // startNewSession through the provider's real inbound path (command parity).
      api.routeInboundMessageForTests({ type: "newSession" });
      const second = `second thread ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: second,
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.strictEqual(
        jsonlFiles(api.sessionStoreDirForTests()).length,
        before + 1,
      );
      assert.deepStrictEqual(
        outcome.items.map((i) => i.type),
        ["user_message", "agent_message"],
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a live read-tool task streams tool_call items over the active paper (A1a)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const doc =
      "\\documentclass{article}\n\\begin{document}\nHello world of sessions.\n\\end{document}\n";
    const uri = vscode.Uri.file(
      path.join(
        os.tmpdir(),
        `lemmaria-a1a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "paper.tex",
      ),
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
    const opened = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(opened);

    const model = new TestModel([
      {
        toolCalls: [
          {
            id: "c1",
            name: "read_span",
            args: { start_line: 1, end_line: 4 },
          },
        ],
      },
      { text: "The paper greets the world." },
    ]);
    api.setModelForTests(model);
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "what does the paper say?",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      const call = outcome.items.find((i) => i.type === "tool_call");
      assert.ok(call, "a tool_call item landed in the transcript");
      assert.strictEqual(call?.status, "completed");
      assert.strictEqual(
        outcome.items.at(-1)?.text,
        "The paper greets the world.",
      );
      // The tool result reached the model on turn 2.
      const turn2 = model.requests[1]?.messages ?? [];
      assert.strictEqual(turn2.at(-1)?.role, "tool");
      assert.ok(
        String(turn2.at(-1)?.content).includes("Hello world"),
        "the read_span result carries the paper text",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a spawn_subtask fan-out round-trips a subtask item with ordered reports (A3)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const doc =
      "\\documentclass{article}\n\\begin{document}\nHello world of subtasks.\n\\end{document}\n";
    const uri = vscode.Uri.file(
      path.join(
        os.tmpdir(),
        `lemmaria-a3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "paper.tex",
      ),
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
    const opened = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(opened);

    const model = new KeyedModel({
      "survey both prior arts": [
        {
          toolCalls: [
            {
              id: "s0",
              name: "spawn_subtask",
              args: { children: [{ goal: "survey A" }, { goal: "survey B" }] },
            },
          ],
        },
        { text: "Synthesis: A and B both matter." },
      ],
      "survey A": [{ text: "A: three findings" }],
      "survey B": [{ text: "B: one finding" }],
    });
    api.setModelForTests(model);
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "survey both prior arts",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      const subtask = outcome.items.find((i) => i.type === "subtask") as
        | {
            type: string;
            reports: { goal: string; summary: string; status: string }[];
          }
        | undefined;
      assert.ok(subtask, "a subtask item landed in the transcript");
      assert.deepStrictEqual(
        subtask?.reports.map((r) => [r.goal, r.summary]),
        [
          ["survey A", "A: three findings"],
          ["survey B", "B: one finding"],
        ],
      );
      // The subtask item.completed also reached the webview event stream.
      const events = api.sessionEventsForTests();
      assert.ok(
        events.some(
          (e) => e.type === "item.completed" && e.item.type === "subtask",
        ),
        "the subtask item reached the webview stream",
      );
      // The parent synthesized after the fan-out.
      assert.strictEqual(
        outcome.items.at(-1)?.text,
        "Synthesis: A and B both matter.",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("Lemmaria: New Session starts a fresh thread (A1a)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "reply" }]));
    try {
      const first = `first thread ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: first,
      });
      const before = jsonlFiles(api.sessionStoreDirForTests()).length;
      await vscode.commands.executeCommand("lemmaria.newSession");
      const second = `second thread ${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: second,
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      // A new JSONL file, and the fresh task carries no prior history.
      assert.strictEqual(
        jsonlFiles(api.sessionStoreDirForTests()).length,
        before + 1,
      );
      assert.deepStrictEqual(
        outcome.items.map((i) => i.type),
        ["user_message", "agent_message"],
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("New Session during a live task drops the dying task's events (review #1)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    const gate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const model = new TestModel([{ text: "doomed answer" }], gate);
    api.setModelForTests(model);
    try {
      const p = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "old thread task",
      });
      await waitFor(() => release !== undefined, "the stream to open");
      await vscode.commands.executeCommand("lemmaria.newSession");
      release?.();
      const outcome = (await p) as TaskOutcome;
      assert.strictEqual(outcome.status, "interrupted");
      // The fresh thread's event log must NOT carry the old task's death
      // rattle (interrupted / task.completed ghosts after the reset).
      assert.deepStrictEqual(api.sessionEventsForTests(), []);
    } finally {
      api.clearModelForTests();
    }
  });

  test("steering queued when a task is interrupted is discarded, never leaked into a later task (review #2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    let firstCall = true;
    const gate = () => {
      if (!firstCall) return Promise.resolve();
      firstCall = false;
      return new Promise<void>((r) => {
        release = r;
      });
    };
    const model = new TestModel(
      [{ text: "interrupted answer" }, { text: "fresh answer" }],
      gate,
    );
    api.setModelForTests(model);
    try {
      const p = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "task one",
      });
      await waitFor(() => release !== undefined, "the stream to open");
      const steered = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "queued while running",
      })) as { status: string };
      assert.strictEqual(steered.status, "steered");
      await api.dispatchWebviewMessageForTests({ type: "interruptTask" });
      release?.();
      const o1 = (await p) as TaskOutcome;
      assert.strictEqual(o1.status, "interrupted");
      // A later task must not resurrect the discarded steering text.
      const o2 = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fresh task",
      })) as TaskOutcome;
      assert.strictEqual(o2.status, "completed");
      const userTexts = api
        .sessionEventsForTests()
        .filter(
          (e) => e.type === "item.completed" && e.item.type === "user_message",
        )
        .map((e) =>
          e.type === "item.completed" && e.item.type === "user_message"
            ? e.item.text
            : "",
        );
      assert.deepStrictEqual(userTexts, ["fresh task"]);
    } finally {
      api.clearModelForTests();
    }
  });

  test("blank composer text is ignored (no session side effects)", async () => {
    const api = await getApi();
    const before = jsonlFiles(api.sessionStoreDirForTests()).length;
    const outcome = await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "   ",
    });
    assert.strictEqual(outcome, undefined);
    assert.strictEqual(
      jsonlFiles(api.sessionStoreDirForTests()).length,
      before,
    );
  });

  test("composerSend without a configured model reports no-model, creates nothing", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.clearModelForTests();
    await api.clearModelsForTests();
    // Materialize the store first: it is created lazily, so a count taken
    // while the directory is still unresolved reads 0 and any later resolution
    // looks like a creation. What must hold is "no NEW session file".
    await api.listSessionsForTests();
    const before = jsonlFiles(api.sessionStoreDirForTests()).length;
    const outcome = (await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "hi",
    })) as { status: string };
    assert.strictEqual(outcome.status, "no-model");
    assert.strictEqual(
      jsonlFiles(api.sessionStoreDirForTests()).length,
      before,
    );
  });

  test("quick actions never touch the session store (v0.2 direction)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "Polished sentence." }]));
    try {
      const doc =
        "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n";
      const uri = vscode.Uri.file(
        path.join(
          os.tmpdir(),
          `lemmaria-a0-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          "a0-quick.tex",
        ),
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
      const opened = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(opened);
      editor.selection = new vscode.Selection(2, 0, 2, 12);

      // Materialize the lazily-created store before measuring: a count taken
      // while the directory is still unresolved reads 0, and any later
      // resolution then looks like a creation. The invariant under test is "no
      // NEW session file", so both counts must be over the same resolved dir.
      await api.listSessionsForTests();
      const before = jsonlFiles(api.sessionStoreDirForTests()).length;
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "runQuickAction",
        actionId: "polish",
      })) as { status?: string; virtualUri?: vscode.Uri } | undefined;
      assert.strictEqual(outcome?.status, "proposed");
      if (outcome?.virtualUri) {
        await vscode.commands.executeCommand(
          "lemmaria.rejectProposal",
          outcome.virtualUri,
        );
      }
      assert.strictEqual(
        jsonlFiles(api.sessionStoreDirForTests()).length,
        before,
        "quick actions must not create or touch session files",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("resume reloads a previous session's transcript and continues it (A2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "first answer" }]));
    const unique = `resume me ${Date.now()}`;
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      const created = api.activeSessionIdForTests();
      assert.ok(created, "a session was created");

      // A fresh thread — the resumed session must come back from DISK.
      api.routeInboundMessageForTests({ type: "newSession" });
      assert.strictEqual(api.activeSessionIdForTests(), undefined);

      const listed = await api.listSessionsForTests();
      assert.ok(
        listed.some((s) => s.meta.id === created && s.meta.title === unique),
        "the session is listed with its title",
      );

      assert.strictEqual(await api.resumeSessionForTests(created), true);
      assert.strictEqual(api.activeSessionIdForTests(), created);

      const items = await api.sessionItemsForTests();
      assert.deepStrictEqual(
        items.map((i) => i.type),
        ["user_message", "agent_message"],
        "the resumed transcript is the persisted one",
      );

      // A second message continues the SAME session file (no new session).
      api.setModelForTests(new TestModel([{ text: "second answer" }]));
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "continue please",
      });
      assert.strictEqual(api.activeSessionIdForTests(), created);
      const after = await api.sessionItemsForTests();
      assert.strictEqual(after.length, 4, "two more items in the same session");
    } finally {
      api.clearModelForTests();
    }
  });

  test("resume restores the session's granted folders (A2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "ok" }]));
    const dir = path.join(
      os.tmpdir(),
      `lemmaria-a2-grant-${Date.now().toString(36)}`,
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    try {
      await api.addGrantForTests(dir);
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `granted resume ${Date.now()}`,
      });
      const created = api.activeSessionIdForTests();
      assert.ok(created);
      assert.strictEqual(api.activeSessionGrantsForTests().length, 1);

      api.routeInboundMessageForTests({ type: "newSession" });
      assert.strictEqual(api.activeSessionGrantsForTests().length, 0);

      assert.strictEqual(await api.resumeSessionForTests(created), true);
      const grants = api.activeSessionGrantsForTests();
      assert.strictEqual(
        grants.length,
        1,
        "the grant came back with the session",
      );
      assert.ok(grants[0]);
    } finally {
      api.clearModelForTests();
      api.resetSessionForTests();
    }
  });

  test("Compact Session appends a manual checkpoint the next task carries (A2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "drafted section three" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `compact me ${Date.now()}`,
      });

      api.setModelForTests(new TestModel([{ text: "HANDOFF SUMMARY" }]));
      assert.strictEqual(await api.compactSessionForTests(), true);
      const items = await api.sessionItemsForTests();
      assert.strictEqual(
        items.at(-1)?.type,
        "compaction",
        "a compaction checkpoint was appended",
      );

      // The next task sends the summary, not the pre-checkpoint draft.
      const model = new TestModel([{ text: "on to section four" }]);
      api.setModelForTests(model);
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "next section",
      });
      const sent = model.requests.at(-1)?.messages ?? [];
      assert.ok(
        sent.some((m) => m.content.includes("HANDOFF SUMMARY")),
        "the handoff summary reached the model",
      );
      assert.ok(
        !sent.some((m) => m.content === "drafted section three"),
        "the pre-checkpoint agent draft did not",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a turn pushes measured context occupancy to the webview (A2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "hi" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `ring ${Date.now()}`,
      });
      const usage = api.lastContextUsageForTests();
      assert.ok(usage, "context usage was pushed");
      assert.ok(
        typeof usage.occupied === "number" && usage.occupied > 0,
        "occupancy is the measured turn usage",
      );
      assert.ok(usage.window > 0, "the model's context window is reported");
    } finally {
      api.clearModelForTests();
    }
  });

  test("the ⟲ header button resumes through the REAL inbound router (A2, review)", async () => {
    // The A1a lesson: a handler-level test stayed green while the button was
    // dead, because the provider dropped the message. Drive the real router.
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "answer" }]));
    const unique = `router resume ${Date.now()}`;
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      const created = api.activeSessionIdForTests();
      assert.ok(created);
      api.routeInboundMessageForTests({ type: "newSession" });
      assert.strictEqual(api.activeSessionIdForTests(), undefined);

      let offered: { id: string; label: string }[] = [];
      api.setSessionPickerForTests((choices) => {
        offered = choices;
        return created;
      });
      api.routeInboundMessageForTests({ type: "resumeSession" });
      await waitFor(
        () => api.activeSessionIdForTests() === created,
        "the ⟲ message to reach the resume flow",
      );
      assert.ok(
        offered.some((c) => c.label === unique),
        "the picker was offered this session",
      );
    } finally {
      api.setSessionPickerForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("resuming the session that is already active keeps its branch points (A2, review)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "answer" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `same-session resume ${Date.now()}`,
      });
      const active = api.activeSessionIdForTests();
      assert.ok(active);
      const before = await api.branchPointsForTests();

      let picked = false;
      api.setSessionPickerForTests(() => {
        picked = true;
        return active;
      });
      api.routeInboundMessageForTests({ type: "resumeSession" });
      await waitFor(() => picked, "the picker to be offered");
      // Let the resume's async tail (store.load + replay) settle.
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(api.activeSessionIdForTests(), active);
      assert.deepStrictEqual(
        await api.branchPointsForTests(),
        before,
        "re-picking the active session must not reset what it can branch at",
      );
    } finally {
      api.setSessionPickerForTests(undefined);
      api.clearModelForTests();
    }
  });
});

suite("A5: the transcript survives a webview reload", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the ready handshake replays the ACTIVE session's items (A5)", async () => {
    // A disposed-and-recreated webview (window reload, moving the view between
    // containers) re-executes the bundle and loses its module-level transcript,
    // while the host keeps the live session. Before A5 the user was left with an
    // empty transcript over a running conversation; the items were persisted all
    // along, so the handshake replays them.
    const api = await getApi();
    api.resetSessionForTests();
    const unique = `reload replay ${Date.now()}`;
    api.setModelForTests(new TestModel([{ text: "answer before the reload" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      const active = api.activeSessionIdForTests();
      assert.ok(active, "a session was created");

      // The log is a bounded ring — clear it rather than remembering an index
      // that eviction can silently invalidate.
      api.clearPostedToWebviewForTests();
      // The reload: the fresh bundle handshakes through the REAL router.
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "a transcriptReplay to be posted on ready",
      );

      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | { sessionId: string; items: { type: string; text?: string }[] }
        | undefined;
      assert.ok(replay, "the replay message");
      assert.strictEqual(replay.sessionId, active);
      const kinds = replay.items.map((i) => i.type);
      assert.ok(kinds.includes("user_message"), `kinds: ${kinds.join(",")}`);
      assert.ok(kinds.includes("agent_message"), `kinds: ${kinds.join(",")}`);
      assert.ok(
        replay.items.some(
          (i) => i.type === "user_message" && i.text === unique,
        ),
        "the user's own message came back verbatim",
      );
      // The snapshot must BE the replayed transcript (store.load → replayEvents),
      // not a hand-rolled fold — that is what makes it inherit the rewind
      // truncation (ADR 0018) and the undecided-proposal normalization for free.
      // A divergence here is the bug those two behaviours would silently regress.
      assert.deepStrictEqual(
        replay.items.map((i) => i.type),
        (await api.sessionItemsForTests()).map((i) => i.type),
        "the replay is the persisted, replayed item list",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a reload MID-TASK replays with busy set, so Stop and any pending approval stay live (A5, review 2)", async () => {
    // The transcript came back but its buttons did not: the approval card and
    // the Stop affordance are both gated on the webview's busy flag, which a
    // fresh bundle has no way to know. A card that renders without its buttons
    // is worse than an empty panel — the loop waits for a decision forever.
    const api = await getApi();
    api.resetSessionForTests();
    let release: (() => void) | undefined;
    const gate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    api.setModelForTests(new TestModel([{ text: "still working" }], gate));
    let task: Promise<unknown> = Promise.resolve();
    try {
      task = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `busy replay ${Date.now()}`,
      });
      await waitFor(() => release !== undefined, "the stream to open");
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "the replay to arrive while the task runs",
      );
      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | { busy: boolean }
        | undefined;
      assert.ok(replay, "the replay message");
      assert.strictEqual(replay.busy, true, "the reload knows a task is live");
      // And the cost readout is re-pushed, which only turn boundaries did.
      //
      // WAITED FOR, not read straight after the replay (found flaky at E3's
      // gate, one failure in three runs). `pushSessionCost` is awaited AFTER
      // the replay is posted and does a disk read of its own, so the two are
      // ordered but not simultaneous, and the wait above returns the moment
      // the FIRST of them lands. Anything that adds work to the `ready` path
      // widens that window — E3's `void postContextPaths()` is one such thing
      // — but the window was always there, and reading the log one tick after
      // an unrelated message is not what the test means to assert. Waiting
      // does not weaken it: the post must still arrive, and `waitFor` fails
      // loudly if it does not.
      await waitFor(
        () =>
          api.postedToWebviewForTests().some((m) => m.type === "sessionCost"),
        "the handshake re-pushes this session's spend",
      );
    } finally {
      // ALWAYS release the gate and drain the task: an assertion throwing
      // above would otherwise leave a task in flight for the rest of the run,
      // and every later test that refuses "while a task is running" would fail
      // for reasons that have nothing to do with it.
      release?.();
      await task.catch(() => undefined);
      api.clearModelForTests();
    }
  });

  test("a resumed session shows ITS spend and keeps its grant chips (A5, review 2)", async () => {
    // Resuming posts sessionReset, which clears the webview's grants and cost.
    // Both must be re-pushed afterwards or an ACTIVE read permission goes
    // invisible while the host still serves it to the model (ADR 0019).
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "answer" }]));
    const dir = path.join(
      os.tmpdir(),
      `lemmaria-a5-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    try {
      await api.addGrantForTests(dir);
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `granted session ${Date.now()}`,
      });
      const id = api.activeSessionIdForTests();
      assert.ok(id);
      await vscode.commands.executeCommand("lemmaria.newSession");

      api.clearPostedToWebviewForTests();
      await vscode.commands.executeCommand("lemmaria.resumeSessionById", id);
      const posted = api.postedToWebviewForTests();
      const resetAt = posted.findIndex((m) => m.type === "sessionReset");
      assert.ok(resetAt >= 0, "the resume cleared the outgoing transcript");
      const grantsAfter = posted
        .slice(resetAt)
        .find((m) => m.type === "grantsState") as
        | { grants: { id: string }[] }
        | undefined;
      assert.ok(
        grantsAfter && grantsAfter.grants.length > 0,
        "the resumed session's grant chips are re-pushed AFTER the reset",
      );
      const cost = posted
        .slice(resetAt)
        .find((m) => m.type === "sessionCost") as
        | { inputTokens: number }
        | undefined;
      assert.ok(cost, "the resumed session's spend is re-pushed");
      assert.ok(cost.inputTokens > 0, "and it is the session's real spend");
    } finally {
      api.clearModelForTests();
    }
  });

  test("with no active session the handshake replays nothing (A5)", async () => {
    // New Session / a fresh window must not resurrect a previous transcript:
    // resume stays an explicit gesture (the stage's history-opt-in pin).
    const api = await getApi();
    api.resetSessionForTests();
    api.clearPostedToWebviewForTests();
    api.routeInboundMessageForTests({ type: "ready" });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      !api.postedToWebviewForTests().some((m) => m.type === "transcriptReplay"),
      "no replay without an active session",
    );
  });
});

suite("A5: the conversation survives a WINDOW reload", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a reload reopens the active session and replays it", async () => {
    // A window reload restarts the extension host, so the whole in-memory
    // session went with it and the handshake replay had nothing to replay —
    // the user landed on the welcome screen over a transcript that was safe on
    // disk the entire time. The active-session id is persisted per workspace,
    // and activation reopens it.
    const api = await getApi();
    api.resetSessionForTests();
    const unique = `window reload ${Date.now()}`;
    api.setModelForTests(new TestModel([{ text: "answer before the reload" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      const before = api.activeSessionIdForTests();
      assert.ok(before, "a session was created");

      assert.strictEqual(
        await api.simulateWindowReloadForTests(),
        true,
        "the reload restored a session",
      );
      assert.strictEqual(
        api.activeSessionIdForTests(),
        before,
        "and it is the SAME session, not a new thread",
      );

      // The rebuilt webview's handshake must now find something to replay —
      // and it must wait for the restore rather than racing it.
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "a transcriptReplay after the window reload",
      );
      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | {
            sessionId: string;
            busy: boolean;
            items: { type: string; text?: string }[];
          }
        | undefined;
      assert.ok(replay, "the replay message");
      assert.strictEqual(replay.sessionId, before);
      assert.strictEqual(
        replay.busy,
        false,
        "no task survives a host restart — the composer goes back to ↑",
      );
      assert.ok(
        replay.items.some(
          (i) => i.type === "user_message" && i.text === unique,
        ),
        "the pre-reload message came back",
      );
      // The ring is only ever pushed on a turn boundary, all of which this host
      // missed — it reads the last measured occupancy back out of the stream.
      const usage = api
        .postedToWebviewForTests()
        .find((m) => m.type === "contextUsage") as
        | { occupied?: number; window: number }
        | undefined;
      assert.ok(usage, "the context ring was seeded after the reload");
      assert.ok(
        (usage.occupied ?? 0) > 0,
        "with a real measured figure, not a blank",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("New Session before the reload means the reload comes back empty", async () => {
    // The pointer is bookkeeping, not history: a user who deliberately left a
    // conversation must not have it handed back by the next reload.
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel([{ text: "answered" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `abandoned ${Date.now()}`,
      });
      assert.ok(api.activeSessionIdForTests(), "a session was created");
      api.routeInboundMessageForTests({ type: "newSession" });
      assert.strictEqual(
        api.activeSessionIdForTests(),
        undefined,
        "New Session cleared the thread",
      );

      assert.strictEqual(
        await api.simulateWindowReloadForTests(),
        false,
        "nothing to restore",
      );
      assert.strictEqual(api.activeSessionIdForTests(), undefined);
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        !api
          .postedToWebviewForTests()
          .some((m) => m.type === "transcriptReplay"),
        "a fresh thread stays fresh across a reload",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a proposal left pending by the reload replays stale, and says why", async () => {
    // The counterpart of the view-move case: a real host restart genuinely
    // killed the loop, so there is no live pause to hand back. The card must
    // come back read-only — and it must not blame a file change it did not see.
    const api = await getApi();
    api.resetSessionForTests();
    // The write path is offered over the ACTIVE paper — open one first, or the
    // task runs read-only and there is no proposal to leave pending.
    const uri = vscode.Uri.file(
      path.join(
        os.tmpdir(),
        `lemmaria-a5-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        "paper.tex",
      ),
    );
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(
        "\\documentclass{article}\n\\begin{document}\nSay teh word here.\n\\end{document}\n",
        "utf8",
      ),
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    await waitFor(
      () => vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath,
      "the paper to become the active editor",
    );
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            {
              id: "w1",
              name: "propose_edit",
              args: {
                edits: [
                  {
                    file: "paper.tex",
                    anchor: "teh word",
                    replacement: "the word",
                  },
                ],
              },
            },
          ],
        },
        { text: "never reached" },
      ]),
    );
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      });
      await waitFor(
        () =>
          api
            .sessionEventsForTests()
            .some(
              (e) =>
                e.type === "item.completed" &&
                e.item.type === "edit_proposal" &&
                e.item.edits.some((x) => x.status === "pending"),
            ),
        "the pending proposal event",
      );
      // The host dies with the loop still parked on the decision.
      api.routeInboundMessageForTests({ type: "interruptTask" });
      await send;
      await api.simulateWindowReloadForTests();

      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "a transcriptReplay after the window reload",
      );
      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | {
            busy: boolean;
            items: {
              type: string;
              edits?: { status: string; note?: string }[];
            }[];
          }
        | undefined;
      assert.ok(replay, "the replay message");
      assert.strictEqual(replay.busy, false);
      const card = replay.items.find((i) => i.type === "edit_proposal");
      assert.ok(card, "the proposal came back");
      assert.ok(
        card.edits?.every((e) => e.status !== "pending"),
        "a dead pause is never decidable — nothing is listening for the answer",
      );
      assert.ok(
        card.edits?.some((e) => (e.note ?? "") !== ""),
        "and the card explains itself rather than reading as 'the file changed'",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
