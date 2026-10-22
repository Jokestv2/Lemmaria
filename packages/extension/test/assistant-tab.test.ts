// U1 acceptance suite: the Assistant webview tab wired to the existing
// quick-action + Accept-gated-diff backend. Drives the REAL bundled extension
// (engine + LatexAdapter) with a deterministic in-test model injected through
// the exports API. Webview *rendering* is covered by the manual checklist + the
// retained U0 round-trip; these tests exercise the host-side seams U1 adds.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type {
  BudgetInfo,
  ModelInfo,
  QuickActionInfo,
  SelectionState,
  WebviewToHost,
} from "../src/webview-protocol";

interface ActionOutcome {
  status: string;
  message?: string;
  virtualUri?: vscode.Uri;
}

interface AssistantApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  revealWebviewForTests(): Promise<void>;
  computeSelectionStateForTests(): SelectionState;
  computeInitStateForTests(): {
    locale: "en" | "zh";
    quickActions: QuickActionInfo[];
    model: ModelInfo;
    budget: BudgetInfo;
  };
  dispatchWebviewMessageForTests(
    msg: WebviewToHost,
  ): Promise<ActionOutcome | undefined>;
  lastPushedSelectionForTests(): SelectionState | undefined;
}

/** Deterministic in-test model: replies texts[i] on call i (sticks on last). */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly texts: string[]) {}
  private nextResult(): GenerateResult {
    const text = this.texts[Math.min(this.i, this.texts.length - 1)] ?? "";
    this.i += 1;
    return {
      text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve(this.nextResult());
  }
  // A1a (ADR 0015): the session loop streams; quick actions still use generate.
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    const result = this.nextResult();
    if (result.text) yield { type: "text_delta", text: result.text };
    yield { type: "completed", result };
  }
}

async function getApi(): Promise<AssistantApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as AssistantApi;
}

async function writeTexWith(
  name: string,
  body: string,
): Promise<{ uri: vscode.Uri; doc: string }> {
  const doc = `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const uri = vscode.Uri.file(
    path.join(
      os.tmpdir(),
      `lemmaria-u1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
    ),
  );
  await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
  return { uri, doc };
}

async function readDisk(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

suite("U1: Assistant selection state", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("no active editor → disabled/empty state", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const api = await getApi();
    const s = api.computeSelectionStateForTests();
    assert.strictEqual(s.docKind, null);
    assert.strictEqual(s.hasSelection, false);
    assert.strictEqual(s.file, "");
  });

  test("a .tex editor with a non-empty selection → populated state", async () => {
    const { uri } = await writeTexWith("u1-selection.tex", "Hello world.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    // line 2 (0-based) holds "Hello world."
    editor.selection = new vscode.Selection(2, 0, 2, 12);
    const api = await getApi();
    const s = api.computeSelectionStateForTests();
    assert.strictEqual(s.docKind, "tex");
    assert.strictEqual(s.hasSelection, true);
    assert.strictEqual(s.file, "u1-selection.tex");
    assert.strictEqual(s.startLine, 3); // 1-based
    assert.strictEqual(s.endLine, 3);
  });
});

suite("U1: Assistant init state", function () {
  this.timeout(30000);

  test("init lists the live quick actions with tiers from their definitions", async () => {
    const api = await getApi();
    const init = api.computeInitStateForTests();
    const ids = init.quickActions.map((q) => q.id).sort();
    assert.deepStrictEqual(ids, [
      "expand", // A5 — the fifth, un-shelled
      "polish",
      "proofread",
      "shrink-to-target",
      "translate",
    ]);
    const tier = (id: string) =>
      init.quickActions.find((q) => q.id === id)?.tier;
    assert.strictEqual(tier("polish"), "L0");
    assert.strictEqual(tier("proofread"), "L0");
    assert.strictEqual(tier("shrink-to-target"), "L1");
    assert.strictEqual(tier("expand"), "L1"); // count_words self-check loop
    assert.strictEqual(tier("translate"), "L1"); // NOT L0 — from the definition
    // every wired tile carries a non-empty label
    assert.ok(init.quickActions.every((q) => q.label.length > 0));
    assert.ok(init.budget.maxTokens > 0);
    assert.ok(init.budget.maxIterations > 0);
    assert.ok(init.locale === "en" || init.locale === "zh");
    assert.strictEqual(typeof init.model.configured, "boolean");
  });
});

suite("U1: run quick action from webview", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("runQuickAction:polish opens the Accept-gated diff; disk unchanged", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(["Polished sentence."]));
    try {
      const { uri, doc: original } = await writeTexWith(
        "u1-run.tex",
        "Hello world.",
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 0, 2, 12);

      const outcome = await api.dispatchWebviewMessageForTests({
        type: "runQuickAction",
        actionId: "polish",
      });
      assert.strictEqual(outcome?.status, "proposed", outcome?.message);
      assert.ok(outcome?.virtualUri, "a proposal diff should have opened");

      // invariant 3: disk byte-identical until Accept
      assert.strictEqual(await readDisk(uri), original);

      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("runQuickAction with a shell/unknown id does nothing", async () => {
    const api = await getApi();
    // `rephrase` is one of the webview's disabled shell tiles: no definition,
    // no command. (`expand` was this test's id until A5 shipped it for real.)
    const outcome = await api.dispatchWebviewMessageForTests({
      type: "runQuickAction",
      actionId: "rephrase",
    });
    assert.strictEqual(outcome, undefined); // ignored, no diff
  });
});

suite(
  "A0: composer conversational session (supersedes U1 composerEdit)",
  function () {
    this.timeout(30000);
    suiteTeardown(async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    test("composerSend chats — no diff, no disk write (invariant 3 trivially holds)", async () => {
      const api = await getApi();
      api.setModelForTests(new TestModel(["A friendly reply."]));
      try {
        const { uri, doc: original } = await writeTexWith(
          "u1-composer.tex",
          "hi there.",
        );
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(2, 0, 2, 9);

        const outcome = (await api.dispatchWebviewMessageForTests({
          type: "composerSend",
          text: "make it formal",
        })) as { status?: string; items?: { type: string }[] } | undefined;
        assert.strictEqual(outcome?.status, "completed");
        assert.strictEqual(
          outcome?.items?.at(-1)?.type,
          "agent_message",
          "the session replies as a chat message (edits arrive with A1)",
        );
        assert.strictEqual(await readDisk(uri), original); // the A0 session never writes
      } finally {
        api.clearModelForTests();
      }
    });

    test("the composer message reaches the model verbatim", async () => {
      const api = await getApi();
      const model = new TestModel(["Bien sûr."]);
      api.setModelForTests(model);
      try {
        const outcome = (await api.dispatchWebviewMessageForTests({
          type: "composerSend",
          text: "translate to French",
        })) as { status?: string } | undefined;
        assert.strictEqual(outcome?.status, "completed");
        const sent =
          model.requests[0]?.messages.map((m) => m.content).join("\n") ?? "";
        assert.ok(
          sent.includes("translate to French"),
          "instruction not sent to the model",
        );
      } finally {
        api.clearModelForTests();
      }
    });

    test("empty composer text is ignored", async () => {
      const api = await getApi();
      const outcome = await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "   ",
      });
      assert.strictEqual(outcome, undefined);
    });
  },
);

suite("U1: live selection push", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("changing the selection pushes an updated state", async () => {
    const api = await getApi();
    await api.revealWebviewForTests();
    const { uri } = await writeTexWith("u1-live.tex", "Alpha beta gamma.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 0, 2, 5);
    // Poll (bounded) for the onDidChangeTextEditorSelection push: a fixed
    // sleep flakes under ext-host load; the asserted facts are unchanged.
    const start = Date.now();
    while (
      api.lastPushedSelectionForTests()?.hasSelection !== true &&
      Date.now() - start < 5000
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const s = api.lastPushedSelectionForTests();
    assert.strictEqual(s?.docKind, "tex");
    assert.strictEqual(s?.hasSelection, true);
    assert.strictEqual(s?.startLine, 3);
  });
});
