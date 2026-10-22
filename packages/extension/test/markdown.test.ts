// M8: quick actions run on Markdown files through the MarkdownAdapter — the
// full Accept-gated flow (invariant 3) on a .md draft: proofread → diff tab →
// Accept splices and saves; the disk is untouched until Accept.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
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
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly text: string) {}
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    return Promise.resolve({
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

const PARA = "Thiss paragraph has a typo in it.";
const DOC = `# Draft

${PARA}

Second paragraph stays untouched.
`;

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

suite("M8: quick actions on Markdown", function () {
  this.timeout(20000);

  test("proofread a .md paragraph → Accept-gated diff → splice on Accept", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel("This paragraph has no typo in it."));
    try {
      const dir = path.join(
        os.tmpdir(),
        `lemmaria-m8-md-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const uri = vscode.Uri.file(path.join(dir, "draft.md"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const start = doc.positionAt(DOC.indexOf(PARA));
      const end = doc.positionAt(DOC.indexOf(PARA) + PARA.length);
      editor.selection = new vscode.Selection(start, end);

      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.proofread",
      )) as PolishOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      // Invariant 3: nothing on disk before Accept.
      const before = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(before, DOC, "disk changed before Accept");

      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");
      const after = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.ok(after.includes("This paragraph has no typo in it."));
      assert.ok(after.includes("Second paragraph stays untouched."));
      assert.ok(!after.includes("Thiss"));
    } finally {
      api.clearModelForTests();
    }
  });
});
