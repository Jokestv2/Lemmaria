// U5/X1 acceptance suite: the primary-sidebar Edits store + views (session
// log of accepted edits — no compile status is stamped here since X1,
// ADR 0013). Drives the REAL bundled extension with a deterministic model +
// injected compile (the M5/U4 pattern); TreeView pixels are covered by the
// manual checklist — these tests assert the providers' model and items.
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
} from "@lemmaria/harness";
import * as vscode from "vscode";

interface PolishOutcome {
  status: string;
  message?: string;
  virtualUri?: vscode.Uri;
}
interface EditEntry {
  fsPath: string;
  file: string;
  action: string;
  line: number;
  acceptedAt: number;
  rolledBack: boolean;
}
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>,
  ): void;
  clearCompileForTests(): void;
  getEditsForTests(): EditEntry[];
  editsItemForTests(
    index: number,
  ):
    | { label?: unknown; description?: unknown; contextValue?: string }
    | undefined;
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  private i = 0;
  constructor(private readonly texts: string[]) {}
  generate(req: GenerateRequest): Promise<GenerateResult> {
    void req;
    const text = this.texts[Math.min(this.i, this.texts.length - 1)] ?? "";
    this.i += 1;
    return Promise.resolve({
      text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}

function compileRule(
  opts: CompileProjectOptions,
): Promise<{ ok: boolean; log: string }> {
  const staged = opts.workingCopies.get(opts.entry);
  const content =
    staged ??
    (() => {
      try {
        return fs.readFileSync(path.join(opts.root, opts.entry), "utf8");
      } catch {
        return "";
      }
    })();
  if (content.includes("BADMACRO")) {
    return Promise.resolve({
      ok: false,
      log: "! Undefined control sequence.\nl.4 \\BADMACRO\n",
    });
  }
  if (content.includes("OVERFULLWORD")) {
    return Promise.resolve({
      ok: true,
      log: "\nOverfull \\hbox (300.0pt too wide) in paragraph at lines 4--4\n",
    });
  }
  return Promise.resolve({ ok: true, log: "" });
}

const PARA = "This paragraph is perfectly fine and clean.";
const DOC = `\\documentclass{article}\n\\begin{document}\n\n${PARA}\n\n\\end{document}\n`;

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

async function makeProject(): Promise<vscode.Uri> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-u5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const uri = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  return uri;
}

async function polishAndAccept(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(DOC.indexOf(PARA));
  const end = doc.positionAt(DOC.indexOf(PARA) + PARA.length);
  editor.selection = new vscode.Selection(start, end);
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

suite("U5: Edits store", function () {
  this.timeout(30000);

  test("an accepted edit lands in the session store with its action label", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    api.setModelForTests(new TestModel(["A neatly polished sentence."]));
    const before = api.getEditsForTests().length;
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      const entries = api.getEditsForTests();
      assert.strictEqual(entries.length, before + 1);
      const e = entries[0];
      assert.ok(e, "no entry recorded");
      assert.strictEqual(e.action, "Polish");
      assert.strictEqual(e.file, "main.tex");
      assert.strictEqual(e.fsPath, uri.fsPath);
      assert.strictEqual(e.line, 4); // PARA sits on line 4 of DOC
      assert.strictEqual(e.rolledBack, false);
      assert.ok(Math.abs(Date.now() - e.acceptedAt) < 60_000);
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("a rollback marks the file's newest entry rolled back", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    api.setModelForTests(new TestModel(["A neatly polished sentence."]));
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      assert.strictEqual(api.getEditsForTests()[0]?.rolledBack, false);
      const ok = await vscode.commands.executeCommand(
        "lemmaria.rollbackEdit",
        uri,
      );
      assert.strictEqual(ok, true, "rollback failed");
      assert.strictEqual(api.getEditsForTests()[0]?.rolledBack, true);
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });
});

suite("U5: Edits view", function () {
  this.timeout(30000);

  test("the manifest contributes both primary-sidebar views in the lemmaria container", async () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext);
    const views = (
      ext.packageJSON as {
        contributes: { views: Record<string, { id: string }[]> };
      }
    ).contributes.views.lemmaria;
    const ids = views?.map((v) => v.id);
    assert.ok(ids?.includes("lemmariaVerifiedEdits"), `got ${ids}`);
    assert.ok(ids?.includes("lemmariaSessions"), `got ${ids}`);
  });

  test("the Edits view is titled Edits (English UI, NLS-resolved), not Verified Edits", async () => {
    // The name is now a %view.edits% NLS placeholder; VS Code resolves it in
    // packageJSON. The ext-host runner is English, so it resolves to "Edits"
    // (a Chinese UI would render "Edits / 修改" from package.nls.zh-cn.json).
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext);
    const views = (
      ext.packageJSON as {
        contributes: { views: Record<string, { id: string; name: string }[]> };
      }
    ).contributes.views.lemmaria;
    const view = views?.find((v) => v.id === "lemmariaVerifiedEdits");
    assert.strictEqual(view?.name, "Edits");
  });

  // Review placement (user feedback round 2): Review is a TAB inside the
  // Assistant webview, not a contributed view — pinned by review-tab.test.ts.

  test("lemmaria.rollbackVerifiedEdit rolls back that entry and drops its affordance", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    const REPLACEMENT = "A neatly polished sentence.";
    api.setModelForTests(new TestModel([REPLACEMENT]));
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      const ok = await vscode.commands.executeCommand(
        "lemmaria.rollbackVerifiedEdit",
        0,
      );
      assert.strictEqual(ok, true, "rollback command failed");
      assert.strictEqual(api.getEditsForTests()[0]?.rolledBack, true);
      assert.notStrictEqual(
        api.editsItemForTests(0)?.contextValue,
        "rollbackable",
      );
      const restored = fs.readFileSync(uri.fsPath, "utf8");
      assert.ok(restored.includes(PARA), "pre-edit text not restored");
      assert.ok(!restored.includes(REPLACEMENT), "replacement still present");
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });
});

/** Like polishAndAccept but selects `needle` in the CURRENT document text. */
async function polishSelectionAndAccept(
  uri: vscode.Uri,
  needle: string,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const text = doc.getText();
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `needle not found: ${needle}`);
  editor.selection = new vscode.Selection(
    doc.positionAt(at),
    doc.positionAt(at + needle.length),
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

suite("U5: multi-entry-per-file semantics", function () {
  this.timeout(30000);

  test("two edits on one file: newest-only rollback affordance; rollback leaves NO affordance", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    const R1 = "First polished sentence, quite unique.";
    const R2 = "Second polished sentence, also unique.";
    try {
      const uri = await makeProject();
      api.setModelForTests(new TestModel([R1]));
      await polishSelectionAndAccept(uri, PARA);
      api.setModelForTests(new TestModel([R2]));
      await polishSelectionAndAccept(uri, R1);

      // Two entries for the same file, newest first.
      const entries = api.getEditsForTests();
      assert.strictEqual(entries[0]?.fsPath, uri.fsPath);
      assert.strictEqual(entries[1]?.fsPath, uri.fsPath);

      // Only the newest carries the rollback affordance (M5: one lastAccepted per file).
      assert.strictEqual(
        api.editsItemForTests(0)?.contextValue,
        "rollbackable",
      );
      assert.notStrictEqual(
        api.editsItemForTests(1)?.contextValue,
        "rollbackable",
      );

      // Roll back the newest. The backend now has NOTHING to roll back for this
      // file — no remaining entry may advertise the affordance (honest shells).
      const rolled = await vscode.commands.executeCommand(
        "lemmaria.rollbackVerifiedEdit",
        0,
      );
      assert.strictEqual(rolled, true, "rollback of the newest entry failed");
      assert.strictEqual(api.getEditsForTests()[0]?.rolledBack, true);
      assert.strictEqual(api.getEditsForTests()[1]?.rolledBack, false);
      assert.notStrictEqual(
        api.editsItemForTests(1)?.contextValue,
        "rollbackable",
        "older entry must not offer a rollback the backend cannot honor",
      );
      const attempted = await vscode.commands.executeCommand(
        "lemmaria.rollbackVerifiedEdit",
        1,
      );
      assert.strictEqual(
        attempted,
        false,
        "wrapper must refuse the older entry",
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });
});
