// M9: cumulative cost accrues across runs and persists (globalState). The stub
// model is unpriced, so the display falls back to token counts (ADR 0002).
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CostState,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  getCostForTests(): CostState | undefined;
  resetCostForTests(): void;
  /** Replace the stored state, as if a window opened on it (X6 round). */
  seedCostForTests(state: CostState): void;
  /** The cost status-bar item's text (X6 round). */
  costStatusForTests(): string | undefined;
  computeModelsStateForTests(): Promise<{
    today: { date: string; usd: number; inputTokens: number };
    total: { usd: number; inputTokens: number };
  }>;
  /** Re-reads the persisted state fresh from globalState. */
  reloadCostForTests(): Promise<CostState | undefined>;
  // A5: the agentic path must reach the same accounting the quick actions use.
  resetSessionForTests(): void;
  dispatchWebviewMessageForTests(msg: {
    type: string;
    [k: string]: unknown;
  }): Promise<unknown>;
  sessionUsageForTests(): Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  sessionCostForTests(): Promise<{
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    unpricedCalls: number;
  }>;
  compactSessionForTests(): Promise<boolean>;
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  private result(): GenerateResult {
    return {
      text: "Polished text.",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
  generate(_req: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.result());
  }
  // A1a (ADR 0015): the session loop streams.
  async *generateStream(
    _req: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "text_delta", text: "Polished text." };
    yield { type: "completed", result: this.result() };
  }
}

const DOC =
  "\\documentclass{article}\n\\begin{document}\nHello world here.\n\\end{document}\n";

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

async function runPolishOnce(): Promise<void> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-m9-cost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const uri = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(DOC.indexOf("Hello"));
  const end = doc.positionAt(DOC.indexOf("here.") + "here.".length);
  editor.selection = new vscode.Selection(start, end);
  const outcome = (await vscode.commands.executeCommand("lemmaria.polish")) as {
    status: string;
    message?: string;
    virtualUri?: vscode.Uri;
  };
  assert.strictEqual(outcome.status, "proposed", outcome.message);
  // Clean up the pending proposal so runs stay independent.
  await vscode.commands.executeCommand(
    "lemmaria.rejectProposal",
    outcome.virtualUri,
  );
}

suite("M9: cumulative cost display", function () {
  this.timeout(30000);

  test("cost accrues across runs, persists, and showCost resolves", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel());
    api.resetCostForTests();
    try {
      await runPolishOnce();
      const s1 = api.getCostForTests();
      assert.ok(s1, "no cost state");
      assert.strictEqual(s1.today.unpricedRuns, 1);
      assert.strictEqual(s1.today.inputTokens, 100);
      assert.strictEqual(s1.total.outputTokens, 20);

      await runPolishOnce();
      const s2 = api.getCostForTests();
      assert.strictEqual(s2?.today.unpricedRuns, 2);
      assert.strictEqual(s2?.total.inputTokens, 200);

      // Persistence: a fresh read of globalState sees the same totals.
      // globalState echoes writes back asynchronously, so poll until settled.
      let persisted: CostState | undefined;
      for (let i = 0; i < 20; i++) {
        persisted = await api.reloadCostForTests();
        if (JSON.stringify(persisted?.total) === JSON.stringify(s2?.total)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepStrictEqual(persisted?.total, s2?.total);

      await vscode.commands.executeCommand("lemmaria.showCost");
    } finally {
      api.clearModelForTests();
    }
  });

  test("a stored day's spend is not shown as today's (X5 and X6 review rounds)", async () => {
    // At 23:43 on 2026-09-17, before any run that day, the Models tab read
    // `Today (2026-09-16) · 9.3K in / 170 out · $0.002` and the status bar
    // `$0.002 today`: the bucket rolls over when a run is RECORDED, and both
    // displays read it as it stood. A window opening on an older day's bucket
    // is exactly that state.
    const api = await getApi();
    const spent = {
      usd: 0.002,
      inputTokens: 9300,
      outputTokens: 170,
      unpricedRuns: 0,
    };
    api.seedCostForTests({
      today: { date: "2000-01-01", ...spent },
      total: spent,
    });
    try {
      const models = await api.computeModelsStateForTests();
      assert.notStrictEqual(models.today.date, "2000-01-01");
      assert.strictEqual(models.today.usd, 0);
      assert.strictEqual(models.today.inputTokens, 0);
      // The total is not a day's, and keeps what was spent.
      assert.strictEqual(models.total.usd, 0.002);
      assert.strictEqual(models.total.inputTokens, 9300);
      // No run yet this window, so the status bar has no *this run* either.
      assert.strictEqual(api.costStatusForTests(), "$(graph) $0.000 Today");
    } finally {
      api.resetCostForTests();
    }
  });

  test("an agentic session task records its usage too (A5)", async () => {
    // Before A5 the composer path was cost-BLIND: handleComposerSend returned
    // the task usage and the caller discarded it, so agentic tokens reached
    // neither the status bar, the Cost view, nor the Models usage table.
    const api = await getApi();
    api.setModelForTests(new TestModel());
    api.resetSessionForTests();
    try {
      // A DELTA, not an absolute: globalState echoes writes back
      // asynchronously (the U4 lost-persist quirk), so a total measured right
      // after resetCostForTests() can still be repopulated by the previous
      // test's in-flight write. What this test is about is what the SESSION
      // path contributes.
      const before = api.getCostForTests();
      const beforeIn = before?.total.inputTokens ?? 0;
      const beforeOut = before?.total.outputTokens ?? 0;
      const beforeUsd = before?.total.usd ?? 0;
      const beforeUnpriced = before?.today.unpricedRuns ?? 0;
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `cost-accrual ${Date.now()}`,
      });
      const state = api.getCostForTests();
      assert.ok(state, "no cost state");
      assert.strictEqual(state.total.inputTokens - beforeIn, 100);
      assert.strictEqual(state.total.outputTokens - beforeOut, 20);
      // Unpriced model ⇒ tokens counted, no dollars invented (ADR 0002).
      assert.strictEqual(state.total.usd - beforeUsd, 0);
      assert.strictEqual(state.today.unpricedRuns - beforeUnpriced, 1);
      // The per-model window tally (Models tab) sees it as well.
      const rows = api.sessionUsageForTests();
      assert.ok(
        rows.some((r) => r.inputTokens >= 100),
        `the model row carries the session task's tokens; got ${JSON.stringify(rows)}`,
      );
      // And the composer's own per-SESSION readout is the folded turn usage.
      const session = await api.sessionCostForTests();
      assert.strictEqual(session.inputTokens, 100);
      assert.strictEqual(session.outputTokens, 20);
      assert.strictEqual(session.costUsd, undefined, "no price invented");
    } finally {
      api.clearModelForTests();
    }
  });

  test("compacting records what the summarization cost (A5 review)", async () => {
    // Compaction is a paid model call that reads the WHOLE conversation, and
    // it reaches no turn.completed event — so it used to be the one way to
    // spend money in this extension that no cost surface ever reported.
    const api = await getApi();
    api.setModelForTests(new TestModel());
    api.resetSessionForTests();
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `compaction-cost ${Date.now()}`,
      });
      const beforeIn = api.getCostForTests()?.total.inputTokens ?? 0;
      const before = await api.sessionCostForTests();

      assert.strictEqual(
        await api.compactSessionForTests(),
        true,
        "the compaction ran",
      );

      // The cumulative (M9) record.
      const afterIn = api.getCostForTests()?.total.inputTokens ?? 0;
      assert.strictEqual(afterIn - beforeIn, 100, "the summarization call");
      // And this session's own folded spend, read back from its JSONL.
      const after = await api.sessionCostForTests();
      assert.strictEqual(after.inputTokens - before.inputTokens, 100);
      assert.strictEqual(after.outputTokens - before.outputTokens, 20);
    } finally {
      api.clearModelForTests();
    }
  });
});
