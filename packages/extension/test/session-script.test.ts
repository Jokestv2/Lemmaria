// A4b acceptance suite (ADR 0020): the agentic session gains run_script — an
// approval-gated tool that runs [interpreter, script, ...args] in a granted
// folder, captures output, and denies with the user's note as steering. Every
// message travels the REAL inbound router; the script is spawned for real
// (node — hermetic, no python dependency).
import * as assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  GrantedRoot,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  SessionItem,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface ScriptApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  routeInboundMessageForTests(msg: WebviewToHost): void;
  sessionEventsForTests(): SessionEvent[];
  resetSessionForTests(): void;
  addGrantForTests(folderPath: string): Promise<GrantedRoot>;
  setScriptInterpretersForTests(list?: string[]): void;
}

interface TestTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly turns: TestTurn[]) {}

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

async function getApi(): Promise<ScriptApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as ScriptApi;
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

/** A granted folder holding a tiny node script that prints a known token. */
function makeScriptGrant(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lemmaria-a4b-ext-"));
  writeFileSync(path.join(dir, "hello.js"), "console.log('A4B_OK')\n");
  return dir;
}

function scriptRunItems(
  events: SessionEvent[],
): Extract<SessionItem, { type: "script_run" }>[] {
  return events.flatMap((e) =>
    (e.type === "item.completed" || e.type === "item.updated") &&
    e.item.type === "script_run"
      ? [e.item]
      : [],
  );
}

function pendingScriptId(events: SessionEvent[]): string | undefined {
  return scriptRunItems(events).find((i) => i.status === "pending")?.id;
}

suite("A4b: run_script execution", function () {
  this.timeout(30000);
  // Under the VS Code extension host (Electron), process.execPath is Code.exe,
  // not node — so the interpreter is bare "node", resolved via PATH (present in
  // the dev/CI environment that launches the runner).
  const NODE = "node";

  test("approve: a run_script round-trips and captures the script output", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setScriptInterpretersForTests(["node"]);
    const dir = makeScriptGrant();
    const grant = await api.addGrantForTests(dir);
    const model = new TestModel([
      {
        toolCalls: [
          {
            id: "c1",
            name: "run_script",
            args: { root: grant.id, command: [NODE, "hello.js"] },
          },
        ],
      },
      { text: "the script printed A4B_OK" },
    ]);
    api.setModelForTests(model);
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "run hello.js",
      }) as Promise<{ status: string }>;
      await waitFor(
        () => pendingScriptId(api.sessionEventsForTests()) !== undefined,
        "the pending script_run event",
      );
      const itemId = pendingScriptId(api.sessionEventsForTests());
      assert.ok(itemId);
      api.routeInboundMessageForTests({
        type: "scriptDecision",
        itemId,
        approve: true,
      });
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
      const done = scriptRunItems(api.sessionEventsForTests()).find(
        (i) => i.status === "completed",
      );
      assert.ok(done, "a completed script_run item streamed");
      assert.ok(
        (done.stdout ?? "").includes("A4B_OK"),
        `the real spawn captured the output; got ${done.stdout}`,
      );
      // The model saw the output as the tool result.
      const toolMsg = model.requests[1]?.messages.find(
        (m) => m.role === "tool",
      );
      assert.ok(String(toolMsg?.content).includes("A4B_OK"));
    } finally {
      api.clearModelForTests();
      api.setScriptInterpretersForTests(undefined);
    }
  });

  test("deny: nothing runs and the note reaches the model as steering", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setScriptInterpretersForTests(["node"]);
    const dir = makeScriptGrant();
    const grant = await api.addGrantForTests(dir);
    const model = new TestModel([
      {
        toolCalls: [
          {
            id: "c1",
            name: "run_script",
            args: { root: grant.id, command: [NODE, "hello.js"] },
          },
        ],
      },
      { text: "ok, I won't run it" },
    ]);
    api.setModelForTests(model);
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "run hello.js",
      }) as Promise<{ status: string }>;
      await waitFor(
        () => pendingScriptId(api.sessionEventsForTests()) !== undefined,
        "the pending script_run event",
      );
      const itemId = pendingScriptId(api.sessionEventsForTests());
      assert.ok(itemId);
      api.routeInboundMessageForTests({
        type: "scriptDecision",
        itemId,
        approve: false,
        note: "please don't, it's not ready",
      });
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
      const denied = scriptRunItems(api.sessionEventsForTests()).find(
        (i) => i.status === "denied",
      );
      assert.ok(denied, "a denied script_run item streamed");
      const toolMsg = model.requests[1]?.messages.find(
        (m) => m.role === "tool",
      );
      assert.ok(
        String(toolMsg?.content).includes("please don't, it's not ready"),
        "the denial note returned to the model as steering",
      );
    } finally {
      api.clearModelForTests();
      api.setScriptInterpretersForTests(undefined);
    }
  });
});
