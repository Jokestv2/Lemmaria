// X1 acceptance suite (supersedes M5): compiling is a report the user asks
// for, never a trigger of an Accept. An accepted edit never compiles on its
// own; lemmaria.verifyNow (a fake compile is injected — the ext-host runner
// has no TeX) reports EVERY warning present, not just ones a baseline diff
// would call "new"; and content-anchored rollback is unaffected. Drives the
// REAL bundled extension with a deterministic in-test model + compile
// injected through the exports API.
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
interface LemmariaApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  setCompileForTests(
    fn: (opts: CompileProjectOptions) => Promise<{ ok: boolean; log: string }>,
  ): void;
  clearCompileForTests(): void;
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

/** Fake compile: reads the staged/overlaid or on-disk entry and branches on content. */
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
    `lemmaria-m5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

suite("X1: Compile Check in the editor", function () {
  this.timeout(20000); // activation + compile + polling headroom

  test("a clean project reports no diagnostics via lemmaria.verifyNow", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    api.setModelForTests(new TestModel(["A neatly polished sentence."]));
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      // Compiling is never implicit — ask for it explicitly.
      // (verifyNow reads the ACTIVE editor — re-focus the paper deterministically,
      // since Accept applies a WorkspaceEdit without stealing focus from the diff.)
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uri),
      );
      await vscode.commands.executeCommand("lemmaria.verifyNow");
      assert.strictEqual(
        vscode.languages.getDiagnostics(uri).length,
        0,
        "clean compile should produce no diagnostics",
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("lemmaria.verifyNow reports ALL warnings as diagnostics", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    api.setModelForTests(
      new TestModel([
        "A line with OVERFULLWORD that is flagged only at compile.",
      ]),
    );
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      // X1: no baseline diff — every finding present at compile time is
      // reported, whether or not the latest edit is what introduced it.
      // (verifyNow reads the ACTIVE editor — re-focus the paper deterministically.)
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uri),
      );
      await vscode.commands.executeCommand("lemmaria.verifyNow");
      const ok = await waitFor(
        () => vscode.languages.getDiagnostics(uri).length > 0,
      );
      assert.ok(ok, "expected a diagnostic for the overfull warning");
      const diags = vscode.languages.getDiagnostics(uri);
      assert.match(diags[0]?.message ?? "", /overfull-hbox/);
      assert.strictEqual(diags[0]?.range.start.line, 3); // line 4 → 0-based 3
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("rollback restores the pre-edit text by content anchor", async () => {
    const api = await getApi();
    api.setCompileForTests(compileRule);
    const REPLACEMENT = "A neatly polished sentence.";
    api.setModelForTests(new TestModel([REPLACEMENT]));
    try {
      const uri = await makeProject();
      await polishAndAccept(uri);
      // the accepted edit is on disk
      const afterAccept = fs
        .readFileSync(uri.fsPath, "utf8")
        .includes(REPLACEMENT);
      assert.ok(afterAccept, "edit not written");
      const rolledBack = await vscode.commands.executeCommand(
        "lemmaria.rollbackEdit",
        uri,
      );
      assert.strictEqual(rolledBack, true, "rollback reported failure");
      const restored = fs.readFileSync(uri.fsPath, "utf8");
      assert.ok(restored.includes(PARA), "pre-edit text not restored");
      assert.ok(!restored.includes(REPLACEMENT), "replacement still present");
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("rollback reverts the edited occurrence, not a duplicate of the same text", async () => {
    // The replacement equals text that ALSO appears earlier in the doc. A blind
    // indexOf would revert the earlier (wrong) copy; the offset anchor must not.
    const api = await getApi();
    api.setCompileForTests(compileRule);
    const SHARED = "An identical shared sentence here.";
    api.setModelForTests(new TestModel([SHARED]));
    try {
      const dir = path.join(
        os.tmpdir(),
        `lemmaria-m5dup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const uri = vscode.Uri.file(path.join(dir, "main.tex"));
      const doc2 = `\\documentclass{article}\n\\begin{document}\n\n${SHARED}\n\n${PARA}\n\n\\end{document}\n`;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(doc2, "utf8"));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const s = doc.positionAt(doc2.indexOf(PARA));
      const e = doc.positionAt(doc2.indexOf(PARA) + PARA.length);
      editor.selection = new vscode.Selection(s, e);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.polish",
      )) as PolishOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      );
      // Both paragraphs now read SHARED.
      assert.strictEqual(
        fs.readFileSync(uri.fsPath, "utf8").split(SHARED).length - 1,
        2,
      );
      const ok = await vscode.commands.executeCommand(
        "lemmaria.rollbackEdit",
        uri,
      );
      assert.strictEqual(ok, true, "rollback failed");
      const restored = fs.readFileSync(uri.fsPath, "utf8");
      // The edited (second) paragraph is back to PARA; the first SHARED is intact.
      assert.ok(restored.includes(PARA), "edited paragraph not restored");
      assert.ok(
        restored.indexOf(SHARED) < restored.indexOf(PARA),
        "rolled back the wrong occurrence",
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });

  test("an accepted edit triggers NO compile (X1: nothing compiles unless asked)", async function () {
    this.timeout(30000);
    const api = await getApi();
    let compiles = 0;
    api.setCompileForTests((opts) => {
      compiles += 1;
      return compileRule(opts);
    });
    api.setModelForTests(new TestModel(["Polished sentence."]));
    try {
      // Drive the real polish → diff → Accept flow, exactly as the existing
      // accept-path cases in this file do.
      const uri = await makeProject();
      await polishAndAccept(uri);

      // M5 debounced auto-verify by 1500 ms. Wait past that window: if any
      // timer survived the X1 deletion, this is where it would fire.
      await new Promise((r) => setTimeout(r, 2500));
      assert.strictEqual(
        compiles,
        0,
        "Accept must not compile — X1: compilation is a report the user asks for",
      );
    } finally {
      api.clearModelForTests();
      api.clearCompileForTests();
    }
  });
});
