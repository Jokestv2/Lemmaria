// U5 gate follow-up: drive the REAL Edits TreeView (visible in the test
// workbench) and assert VS Code actually re-pulls data after an accept. The
// manual test found rows arriving late/never — the store suites can't see
// that because they read the provider through seams, not through the live view.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CompileProjectOptions,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface PolishOutcome {
  status: string;
  message?: string;
  virtualUri?: vscode.Uri;
}
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>,
  ): void;
  clearCompileForTests(): void;
  getEditsForTests(): { rolledBack: boolean; action: string }[];
  dispatchWebviewMessageForTests(msg: {
    type: string;
    [k: string]: unknown;
  }): Promise<unknown>;
  resetSessionForTests(): void;
  activeSessionIdForTests(): string | undefined;
  viewPullsForTests(): {
    getChildren: number;
    getTreeItem: number;
    labels: string[];
    sessionsLabels: string[];
  };
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}
  private result(): GenerateResult {
    return {
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  generate(req: GenerateRequest): Promise<GenerateResult> {
    void req;
    return Promise.resolve(this.result());
  }
  // A1a (ADR 0015): the session loop streams; quick actions still use generate.
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    void req;
    yield { type: "text_delta", text: this.text };
    yield { type: "completed", result: this.result() };
  }
}

const PARA = "This paragraph is perfectly fine and clean.";
const DOC = `\\documentclass{article}\n\\begin{document}\n\n${PARA}\n\n\\end{document}\n`;

function cleanCompile(): Promise<{ ok: boolean; log: string }> {
  return Promise.resolve({ ok: true, log: "" });
}

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

/** A UNIQUE basename per call: other suites in this shared extension host
 *  also accept edits on files named main.tex, so only a unique label proves
 *  it was THIS test's newest entry that the live tree rendered. */
async function makeProject(): Promise<vscode.Uri> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(os.tmpdir(), `lemmaria-u5p-${stamp}`);
  const uri = vscode.Uri.file(path.join(dir, `paper-${stamp}.tex`));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  return uri;
}

async function polishAndAccept(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const at = doc.getText().indexOf(PARA);
  editor.selection = new vscode.Selection(
    doc.positionAt(at),
    doc.positionAt(at + PARA.length),
  );
  const outcome = (await vscode.commands.executeCommand(
    "lemmaria.polish",
  )) as PolishOutcome;
  assert.strictEqual(outcome.status, "proposed", outcome.message);
  const accepted = await vscode.commands.executeCommand(
    "lemmaria.acceptProposal",
    outcome.virtualUri,
  );
  assert.strictEqual(accepted, true, "accept failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await delay(50);
  }
  return pred();
}

suite("U5: live Edits view pipeline", function () {
  this.timeout(30000);

  test("with the view visible, an accepted edit makes the tree re-pull children and render the item", async () => {
    const api = await getApi();
    api.setCompileForTests(cleanCompile);
    api.setModelForTests(new TestModel("A neatly polished sentence."));
    try {
      // Make the real view visible — VS Code's initial render must pull roots.
      await vscode.commands.executeCommand("lemmariaVerifiedEdits.focus");
      const rendered = await waitFor(
        () => api.viewPullsForTests().getChildren > 0,
      );
      assert.ok(rendered, "the visible view never pulled its children");

      const uri = await makeProject();
      const before = api.viewPullsForTests();
      const entriesBefore = api.getEditsForTests().length;
      await polishAndAccept(uri);
      assert.strictEqual(
        api.getEditsForTests().length,
        entriesBefore + 1,
        "store did not record the accept",
      );

      // The live tree must react to the store change: re-pull children AND
      // render the accepted edit's row (what the user sees as "the row
      // appears"). The unique basename + the post-snapshot slice make this
      // provable only by THIS accept's entry actually rendering.
      const expected = `Polish · ${path.basename(uri.fsPath)}`;
      const repulled = await waitFor(() => {
        const now = api.viewPullsForTests();
        return (
          now.getChildren > before.getChildren &&
          now.labels.slice(before.labels.length).includes(expected)
        );
      });
      assert.ok(
        repulled,
        `live tree did not render the accepted edit (${expected}): before=${JSON.stringify(
          before,
        )} after=${JSON.stringify(api.viewPullsForTests())}`,
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("with the view visible, the Sessions tree renders a REAL session row (A5)", async () => {
    // U5 rendered the active editor as a pseudo-session here; A5 backs the view
    // with the real store, so what must render is a persisted conversation.
    const api = await getApi();
    api.resetSessionForTests();
    await vscode.commands.executeCommand("lemmariaSessions.focus");
    const before = api.viewPullsForTests().sessionsLabels.length;
    const unique = `pipeline session ${Date.now()}`;
    api.setModelForTests(new TestModel("ok"));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      assert.ok(
        api.activeSessionIdForTests(),
        "the composer created a session to render",
      );
      const rendered = await waitFor(() =>
        api.viewPullsForTests().sessionsLabels.slice(before).includes(unique),
      );
      assert.ok(
        rendered,
        `live Sessions tree never rendered the session row; pulled=${JSON.stringify(
          api.viewPullsForTests().sessionsLabels.slice(before),
        )}`,
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
