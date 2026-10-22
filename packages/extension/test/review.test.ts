// M9: the single-model review panel — annotations are read-only (invariant 3):
// running Review populates the panel model and never touches buffer or disk.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ReviewResult,
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface ReviewOutcome {
  status: string;
  message?: string;
}
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  getReviewForTests(): ReviewResult | undefined;
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}
  generate(_req: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve({
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

const DOC = [
  "\\documentclass{article}", // line 1
  "\\begin{document}", // 2
  "\\section{Intro}", // 3
  "", // 4
  "Attention mechanisms is very useful for modeling.", // 5
  "", // 6
  "They has been adopted widely.", // 7
  "", // 8
  "\\end{document}", // 9
  "",
].join("\n");

const ANSWER = JSON.stringify({
  annotations: [
    {
      dimension: "language",
      severity: "minor",
      anchor: "mechanisms is very useful",
      message: "Subject–verb agreement.",
    },
    {
      dimension: "language",
      severity: "major",
      anchor: "They has been adopted",
      message: "Subject–verb agreement.",
      suggestion: "They have been adopted",
    },
  ],
});

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

async function openFixture(): Promise<{
  uri: vscode.Uri;
  doc: vscode.TextDocument;
  editor: vscode.TextEditor;
}> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-m9-review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const uri = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(DOC.indexOf("Attention"));
  const end = doc.positionAt(DOC.indexOf("widely.") + "widely.".length);
  editor.selection = new vscode.Selection(start, end);
  return { uri, doc, editor };
}

suite("M9: single-model review panel", function () {
  this.timeout(20000);

  test("review populates the panel model and writes nothing", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const { uri, doc } = await openFixture();
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as ReviewOutcome;
      assert.strictEqual(outcome.status, "reviewed", outcome.message);

      const review = api.getReviewForTests();
      assert.ok(review, "no review stored");
      assert.strictEqual(review.annotations.length, 2);
      assert.strictEqual(review.annotations[0]?.reviewer, "writing");
      assert.strictEqual(review.annotations[0]?.span.line, 5);
      assert.strictEqual(review.annotations[1]?.span.line, 7);
      assert.deepStrictEqual(review.annotations[1]?.suggestedEdit, {
        original: "They has been adopted",
        replacement: "They have been adopted",
      });

      // Invariant 3: review never writes — buffer AND disk byte-identical.
      assert.strictEqual(doc.getText(), DOC, "buffer changed");
      const onDisk = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(onDisk, DOC, "disk changed");
    } finally {
      api.clearModelForTests();
    }
  });

  test("adopt-a-suggestion enters the Accept-gated diff; Accept splices exactly the anchor", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const { uri } = await openFixture();
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as ReviewOutcome;
      assert.strictEqual(outcome.status, "reviewed", outcome.message);

      // Annotation index 1 carries the suggestion (the command also accepts
      // the annotation element; tests address it by index).
      const adopt = (await vscode.commands.executeCommand(
        "lemmaria.adoptSuggestion",
        1,
      )) as { status: string; message?: string; virtualUri?: vscode.Uri };
      assert.strictEqual(adopt.status, "proposed", adopt.message);
      assert.ok(adopt.virtualUri, "no diff opened");

      // Nothing written before Accept.
      const before = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(before, DOC, "disk changed before Accept");

      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        adopt.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");
      const after = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      assert.strictEqual(
        after,
        DOC.replace("They has been adopted", "They have been adopted"),
        "adopt must splice exactly the anchored span",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("adopt disambiguates an anchor that repeats OUTSIDE the reviewed unit by its line", async () => {
    const DUP = "This duplicated sentence appears twice.";
    const DOC2 = [
      "\\documentclass{article}", // 1
      "\\begin{document}", // 2
      "", // 3
      DUP, // 4 — the reviewed selection covers only this one
      "", // 5
      DUP, // 6 — outside the selection, must stay untouched
      "", // 7
      "\\end{document}", // 8
      "",
    ].join("\n");
    const api = await getApi();
    api.setModelForTests(
      new TestModel(
        JSON.stringify({
          annotations: [
            {
              dimension: "clarity",
              severity: "minor",
              anchor: DUP,
              message: "Repetitive.",
              suggestion: "This sentence appears once.",
            },
          ],
        }),
      ),
    );
    try {
      const dir = path.join(
        os.tmpdir(),
        `lemmaria-m9-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const uri = vscode.Uri.file(path.join(dir, "main.tex"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC2, "utf8"));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const start = doc.positionAt(DOC2.indexOf(DUP));
      const end = doc.positionAt(DOC2.indexOf(DUP) + DUP.length);
      editor.selection = new vscode.Selection(start, end);

      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as ReviewOutcome;
      assert.strictEqual(outcome.status, "reviewed", outcome.message);

      const adopt = (await vscode.commands.executeCommand(
        "lemmaria.adoptSuggestion",
        0,
      )) as { status: string; message?: string; virtualUri?: vscode.Uri };
      assert.strictEqual(adopt.status, "proposed", adopt.message);
      const accepted = await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        adopt.virtualUri,
      );
      assert.strictEqual(accepted, true, "accept failed");
      const after = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8");
      const lines = after.split("\n");
      assert.strictEqual(lines[3], "This sentence appears once.");
      assert.strictEqual(lines[5], DUP, "the out-of-unit occurrence changed");
    } finally {
      api.clearModelForTests();
    }
  });

  test("adopting after the anchor changed refuses with a message, no diff", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel(ANSWER));
    try {
      const { doc, editor } = await openFixture();
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as ReviewOutcome;
      assert.strictEqual(outcome.status, "reviewed", outcome.message);

      // Mutate the anchored text so the suggestion is stale.
      const at = doc.getText().indexOf("They has been adopted");
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(doc.positionAt(at), doc.positionAt(at + 4)),
          "These",
        ),
      );

      const adopt = (await vscode.commands.executeCommand(
        "lemmaria.adoptSuggestion",
        1,
      )) as { status: string };
      assert.strictEqual(adopt.status, "stale");
    } finally {
      api.clearModelForTests();
    }
  });

  test("re-running review replaces the panel model", async () => {
    const api = await getApi();
    const single = JSON.stringify({
      annotations: [
        {
          dimension: "clarity",
          severity: "info",
          anchor: "very useful for modeling",
          message: "Vague.",
        },
      ],
    });
    api.setModelForTests(new TestModel(single));
    try {
      await openFixture();
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.review",
      )) as ReviewOutcome;
      assert.strictEqual(outcome.status, "reviewed", outcome.message);
      assert.strictEqual(api.getReviewForTests()?.annotations.length, 1);
    } finally {
      api.clearModelForTests();
    }
  });
});
