// A4 acceptance suite (ADR 0019): session folder grants — the picker-backed
// add/revoke flow persists grant_update events, the granted root reaches the
// task's tool registry (list_files/read_span with `root`), the deny-read list
// is live end-to-end, literature_search is offered through injected providers,
// and New Session clears grants + resets the literature budget.
import * as assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  GrantedRoot,
  LiteratureProvider,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  SessionItem,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { ResolvedReviewPanel } from "../src/model";
import type { SharedTaskOptions } from "../src/session/task-options";
import type { WebviewToHost } from "../src/webview-protocol";

interface GrantsApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  routeInboundMessageForTests(msg: WebviewToHost): void;
  sessionEventsForTests(): SessionEvent[];
  sessionStoreDirForTests(): string | undefined;
  resetSessionForTests(): void;
  sessionItemsForTests(): Promise<SessionItem[]>;
  addGrantForTests(folderPath: string): Promise<GrantedRoot>;
  revokeGrantForTests(id: string): Promise<boolean>;
  activeSessionGrantsForTests(): GrantedRoot[];
  literatureBudgetForTests(): { remaining: number };
  setLiteratureProvidersForTests(providers?: LiteratureProvider[]): void;
  sharedTaskOptionsForTests(
    paper: { root: string; entry: string } | undefined,
    panel?: ResolvedReviewPanel,
  ): Promise<SharedTaskOptions>;
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

async function getApi(): Promise<GrantsApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as GrantsApi;
}

function makeCodebase(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lemmaria-grant-ext-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src", "train.py"),
    "def load(path):\n    return 42\n",
  );
  writeFileSync(path.join(dir, ".env"), "SECRET=1");
  return dir;
}

function toolItems(
  events: SessionEvent[],
): { tool: string; resultJson?: string; status: string }[] {
  return events.flatMap((e) =>
    e.type === "item.completed" && e.item.type === "tool_call"
      ? [
          {
            tool: e.item.tool as string,
            status: e.item.status,
            ...(e.item.resultJson !== undefined
              ? { resultJson: e.item.resultJson }
              : {}),
          },
        ]
      : [],
  );
}

suite("A4: session folder grants + literature wiring", function () {
  this.timeout(30000);

  const mockProvider: LiteratureProvider = {
    name: "crossref",
    endpoint: "https://api.crossref.org",
    search: async () => ({
      kind: "ok",
      results: [
        {
          title: "Attention Is All You Need",
          authors: ["Vaswani"],
          year: "2017",
          doi: "10.1/x",
          source: "crossref",
        },
      ],
    }),
  };

  teardown(async () => {
    const api = await getApi();
    api.clearModelForTests();
    api.setLiteratureProvidersForTests(undefined);
    api.resetSessionForTests();
  });

  test("a pre-session grant persists on first send, feeds real granted reads, and denies .env", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setLiteratureProvidersForTests([mockProvider]);
    const dir = makeCodebase();
    const grant = await api.addGrantForTests(dir);
    assert.strictEqual(grant.id, "g1");
    assert.strictEqual(grant.label, path.basename(dir));
    assert.deepStrictEqual(
      api.activeSessionGrantsForTests().map((g) => g.id),
      ["g1"],
    );

    const model = new TestModel([
      { toolCalls: [{ id: "c1", name: "list_files", args: { root: "g1" } }] },
      {
        toolCalls: [
          {
            id: "c2",
            name: "read_span",
            args: {
              root: "g1",
              file: "src/train.py",
              start_line: 1,
              end_line: 2,
            },
          },
        ],
      },
      {
        toolCalls: [
          { id: "c3", name: "read_span", args: { root: "g1", file: ".env" } },
        ],
      },
      { text: "done" },
    ]);
    api.setModelForTests(model);
    const outcome = (await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "read my codebase",
    })) as { status: string };
    assert.strictEqual(outcome.status, "completed");

    // The model was offered the A4 tools…
    const advertised = (model.requests[0]?.tools ?? []).map((t) => t.name);
    assert.ok(advertised.includes("list_files"), advertised.join(","));
    assert.ok(advertised.includes("literature_search"), advertised.join(","));
    // …the system prompt re-declared the grant…
    const system = model.requests[0]?.messages[0]?.content ?? "";
    assert.ok(system.includes("g1"), "grant id in envelope");
    // …and the real reads round-tripped, with the deny list live.
    const calls = toolItems(api.sessionEventsForTests());
    assert.ok(
      calls[0]?.resultJson?.includes("src/train.py"),
      `listing: ${calls[0]?.resultJson}`,
    );
    assert.ok(
      calls[1]?.resultJson?.includes("def load(path):"),
      `read: ${calls[1]?.resultJson}`,
    );
    assert.ok(
      calls[2]?.resultJson?.includes("excluded by default"),
      `deny: ${calls[2]?.resultJson}`,
    );

    // The grant_update event was flushed into the session JSONL.
    const items = await api.sessionItemsForTests();
    const updates = items.filter((i) => i.type === "grant_update");
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(
      updates[0]?.type === "grant_update" ? updates[0].grant.id : undefined,
      "g1",
    );
  });

  test("revoke appends the revoked event and the router handles revokeGrant", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const dir = makeCodebase();
    await api.addGrantForTests(dir);
    // A message creates the session (and flushes the added event).
    api.setModelForTests(new TestModel([{ text: "ok" }]));
    await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "hello",
    });
    // Revoke travels the REAL inbound router (the A1a lesson). The router is
    // fire-and-forget, so poll the PERSISTED record — the JSONL append is
    // asynchronous behind the synchronous in-memory removal.
    api.routeInboundMessageForTests({ type: "revokeGrant", id: "g1" });
    const start = Date.now();
    let actions: string[] = [];
    while (!actions.includes("revoked")) {
      if (Date.now() - start > 5000) {
        throw new Error(`revoke never persisted (saw: ${actions.join(",")})`);
      }
      await new Promise((r) => setTimeout(r, 10));
      const items = await api.sessionItemsForTests();
      actions = items.flatMap((i) =>
        i.type === "grant_update" ? [i.action] : [],
      );
    }
    assert.deepStrictEqual(actions, ["added", "revoked"]);
    assert.strictEqual(api.activeSessionGrantsForTests().length, 0);
  });

  test("a review runs on a literature budget of its own, and leaves the chat's untouched (V6's E1 round)", async () => {
    // The E1 window: three panels drew on the conversation's 25 searches, so
    // the third ran with none and its originality row blamed the literature.
    const api = await getApi();
    api.resetSessionForTests();
    api.setLiteratureProvidersForTests([mockProvider]);
    const child = {
      adapter: new TestModel([]),
      binding: {
        protocol: "anthropic" as const,
        endpoint: "",
        model: "claude-sonnet-4-5",
        apiKey: "k",
      },
    };
    const panel: ResolvedReviewPanel = {
      reviewers: [child],
      synthesis: child,
      verifier: "off",
      pdfReviewer: "off",
    };
    const search = async (opts: SharedTaskOptions) => {
      const tool = opts.registry?.get("literature_search");
      assert.ok(tool, "literature_search is offered");
      return tool.invoke({ query: "attention is all you need" });
    };
    // The conversation has spent its whole budget.
    api.literatureBudgetForTests().remaining = 0;

    const first = await search(
      await api.sharedTaskOptionsForTests(undefined, panel),
    );
    assert.ok(first.ok, "a review starts with a budget of its own");
    const second = await search(
      await api.sharedTaskOptionsForTests(undefined, panel),
    );
    assert.ok(second.ok, "and so does the next one, whatever the first spent");

    assert.strictEqual(
      api.literatureBudgetForTests().remaining,
      0,
      "neither review spent the conversation's searches",
    );
    const chat = await search(await api.sharedTaskOptionsForTests(undefined));
    assert.ok(!chat.ok, "the chat's own budget still binds the chat");
    assert.match(
      chat.ok ? "" : chat.error.message,
      /budget exhausted/,
      "and says so",
    );
  });

  test("New Session clears grants and resets the literature budget", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const dir = makeCodebase();
    await api.addGrantForTests(dir);
    assert.strictEqual(api.activeSessionGrantsForTests().length, 1);
    const budget = api.literatureBudgetForTests();
    budget.remaining = 3;
    api.routeInboundMessageForTests({ type: "newSession" });
    const start = Date.now();
    while (api.activeSessionGrantsForTests().length > 0) {
      if (Date.now() - start > 5000) throw new Error("grants never cleared");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      api.literatureBudgetForTests().remaining > 3,
      "budget reset to the session default",
    );
  });
});
