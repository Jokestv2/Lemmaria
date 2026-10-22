// M4 acceptance suite: select → polish → diff review → Accept/Reject/Retry,
// nothing written without Accept (invariant 3). Drives the REAL bundled
// extension (engine + LatexAdapter) with a deterministic in-test model injected
// through the extension's exports API.
import * as assert from "node:assert";
import * as fs from "node:fs";
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

/** Deterministic in-test model: replies texts[i] on call i (sticks on last). */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(private readonly texts: string[]) {}
  generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
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

const PARA = "This paragarph is quite bad and has a typo.";
const POLISHED = "This paragraph is well written.";
const DOC = `\\documentclass{article}\n\\begin{document}\n\n${PARA}\n\n\\end{document}\n`;

async function getApi(): Promise<LemmariaApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as LemmariaApi;
}

async function makeProject(): Promise<vscode.Uri> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-m4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const uri = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(DOC, "utf8"));
  return uri;
}

async function selectParagraphAndRun(uri: vscode.Uri): Promise<PolishOutcome> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const start = doc.positionAt(DOC.indexOf(PARA));
  const end = doc.positionAt(DOC.indexOf(PARA) + PARA.length);
  editor.selection = new vscode.Selection(start, end);
  return (await vscode.commands.executeCommand(
    "lemmaria.polish",
  )) as PolishOutcome;
}

async function readDisk(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

function tabOpenFor(virtualUri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some(
      (t) =>
        t.input instanceof vscode.TabInputTextDiff &&
        t.input.modified.toString() === virtualUri.toString(),
    ),
  );
}

suite("M4: polish flow in the editor", function () {
  // Match the other ext-host suites: mocha's default 2s flakes once the
  // session grows (extension activation + the diff round-trips are not free).
  this.timeout(30000);
  test("run → proposal in a diff tab; document untouched (invariant 3)", async () => {
    const api = await getApi();
    const model = new TestModel([POLISHED]);
    api.setModelForTests(model);
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri, "no virtualUri returned");

      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(
        tab?.input instanceof vscode.TabInputTextDiff,
        "not a diff tab",
      );
      const input = tab.input as vscode.TabInputTextDiff;
      assert.strictEqual(input.original.toString(), uri.toString());
      assert.strictEqual(
        input.modified.toString(),
        outcome.virtualUri.toString(),
      );

      const virtualDoc = await vscode.workspace.openTextDocument(
        outcome.virtualUri,
      );
      assert.ok(virtualDoc.getText().includes(POLISHED));
      assert.ok(!virtualDoc.getText().includes("paragarph"));

      // invariant 3: disk AND buffer untouched while pending
      assert.strictEqual(await readDisk(uri), DOC);
      const realDoc = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(realDoc.getText(), DOC);
      assert.strictEqual(realDoc.isDirty, false);

      // the engine saw the selected paragraph
      const sent =
        model.requests[0]?.messages.map((m) => m.content).join("\n") ?? "";
      assert.ok(sent.includes(PARA), "selection text not in prompt");

      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a second quick action (proofread) runs through the generalized command", async () => {
    const api = await getApi();
    const FIXED = "This paragraph has no typo.";
    api.setModelForTests(new TestModel([FIXED]));
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(
        doc.positionAt(DOC.indexOf(PARA)),
        doc.positionAt(DOC.indexOf(PARA) + PARA.length),
      );
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.proofread",
      )) as PolishOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);
      const virtualDoc = await vscode.workspace.openTextDocument(
        outcome.virtualUri,
      );
      assert.ok(virtualDoc.getText().includes(FIXED));
      // invariant 3: nothing written before Accept.
      assert.strictEqual(await readDisk(uri), DOC);
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("Accept writes exactly the proposed change and saves; tab closes", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);
      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(ok, true, "accept reported failure");
      assert.strictEqual(await readDisk(uri), DOC.replace(PARA, POLISHED));
      const doc = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(
        doc.isDirty,
        false,
        "document left dirty after accept",
      );
      assert.ok(!tabOpenFor(outcome.virtualUri), "diff tab still open");
    } finally {
      api.clearModelForTests();
    }
  });

  test("Reject leaves the file byte-identical; tab closes", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
      assert.strictEqual(await readDisk(uri), DOC);
      assert.ok(!tabOpenFor(outcome.virtualUri), "diff tab still open");
    } finally {
      api.clearModelForTests();
    }
  });

  test("Accept on a stale proposal refuses (content anchor)", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      // mutate the file behind the proposal's back
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(
            doc.positionAt(DOC.indexOf(PARA)),
            doc.positionAt(DOC.indexOf(PARA) + PARA.length),
          ),
          "Something entirely different.",
        ),
      );
      await doc.save();

      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(ok, false, "stale proposal was accepted");
      const onDisk = await readDisk(uri);
      assert.ok(onDisk.includes("Something entirely different."));
      assert.ok(!onDisk.includes(POLISHED), "stale replacement was written");
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("Retry with a note re-runs the action with the note and refreshes the diff", async () => {
    const api = await getApi();
    const model = new TestModel([POLISHED, "Second, shorter attempt."]);
    api.setModelForTests(model);
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      await vscode.commands.executeCommand(
        "lemmaria.retryProposal",
        outcome.virtualUri,
        "make it much shorter",
      );

      assert.strictEqual(
        model.requests.length,
        2,
        "retry did not re-run the model",
      );
      const secondRun = model.requests[1]?.messages ?? [];
      const last = secondRun[secondRun.length - 1];
      assert.strictEqual(last?.role, "user");
      assert.ok(
        last.content.includes("make it much shorter"),
        "note not sent to the model",
      );

      // the same virtual doc now shows the second attempt
      const virtualDoc = await vscode.workspace.openTextDocument(
        outcome.virtualUri,
      );
      for (
        let i = 0;
        i < 40 && !virtualDoc.getText().includes("Second, shorter attempt.");
        i++
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        virtualDoc.getText().includes("Second, shorter attempt."),
        "diff did not refresh",
      );

      assert.strictEqual(await readDisk(uri), DOC); // still nothing written
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("polish reads the unsaved buffer, not the stale disk state (ADR 0002 overlay)", async () => {
    const api = await getApi();
    const model = new TestModel([POLISHED]);
    api.setModelForTests(model);
    try {
      const uri = await makeProject();
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const bufferPara = "An unsaved paragarph, only in the buffer.";
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(
            doc.positionAt(DOC.indexOf(PARA)),
            doc.positionAt(DOC.indexOf(PARA) + PARA.length),
          ),
          bufferPara,
        ),
      );
      assert.ok(doc.isDirty);
      const start = doc.getText().indexOf(bufferPara);
      editor.selection = new vscode.Selection(
        doc.positionAt(start),
        doc.positionAt(start + bufferPara.length),
      );
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.polish",
      )) as PolishOutcome;
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      const sent =
        model.requests[0]?.messages.map((m) => m.content).join("\n") ?? "";
      assert.ok(
        sent.includes(bufferPara),
        "engine did not see the unsaved buffer",
      );

      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(ok, true, "accept failed on the dirty buffer");
      const onDisk = await readDisk(uri);
      assert.ok(onDisk.includes(POLISHED), "accepted replacement not on disk");
      assert.ok(!onDisk.includes(bufferPara), "buffer paragraph not replaced");
    } finally {
      api.clearModelForTests();
    }
  });

  test("arg-less Accept resolves the active diff tab (title-button path)", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      // the diff tab is active right after propose; no uri argument passed
      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
      )) as boolean;
      assert.strictEqual(ok, true, "arg-less accept did not resolve the tab");
      assert.strictEqual(await readDisk(uri), DOC.replace(PARA, POLISHED));
    } finally {
      api.clearModelForTests();
    }
  });

  test("manually closing the diff tab abandons the proposal", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      // user closes the tab with the X instead of Reject
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (
            tab.input instanceof vscode.TabInputTextDiff &&
            tab.input.modified.toString() === outcome.virtualUri.toString()
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
      // give the onDidChangeTabs listener a beat
      await new Promise((r) => setTimeout(r, 200));

      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(ok, false, "abandoned proposal was still acceptable");
      assert.strictEqual(await readDisk(uri), DOC, "file was modified");
    } finally {
      api.clearModelForTests();
    }
  });

  test("Retry refuses when the selection changed since the proposal (stale offsets)", async () => {
    const api = await getApi();
    const model = new TestModel([POLISHED, "second attempt"]);
    api.setModelForTests(model);
    try {
      const uri = await makeProject();
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      // shift the selected span by editing ABOVE it while the proposal is pending
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) =>
        b.insert(new vscode.Position(0, 0), "% new line\n"),
      );

      await vscode.commands.executeCommand(
        "lemmaria.retryProposal",
        outcome.virtualUri,
        "shorter please",
      );

      assert.strictEqual(
        model.requests.length,
        1,
        "retry re-ran the model on stale offsets",
      );
      await vscode.commands.executeCommand(
        "lemmaria.rejectProposal",
        outcome.virtualUri,
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("Accept reports failure and keeps the proposal when saving fails (read-only file)", async function () {
    if (process.platform !== "win32") this.skip(); // read-only attr semantics differ
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    let fileUri: vscode.Uri | undefined;
    try {
      const uri = await makeProject();
      fileUri = uri;
      const outcome = await selectParagraphAndRun(uri);
      assert.strictEqual(outcome.status, "proposed", outcome.message);
      assert.ok(outcome.virtualUri);

      fs.chmodSync(uri.fsPath, 0o444); // read-only: buffer edit applies, save fails

      const ok = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(
        ok,
        false,
        "accept claimed success despite failed save",
      );
      assert.strictEqual(
        await readDisk(uri),
        DOC,
        "read-only file changed on disk",
      );
      assert.ok(
        tabOpenFor(outcome.virtualUri),
        "diff tab closed despite failed save",
      );

      fs.chmodSync(uri.fsPath, 0o666);
      // proposal must still be acceptable once the file is writable again
      const okNow = (await vscode.commands.executeCommand(
        "lemmaria.acceptProposal",
        outcome.virtualUri,
      )) as boolean;
      assert.strictEqual(
        okNow,
        true,
        "proposal was not retained after failed save",
      );
      assert.strictEqual(await readDisk(uri), DOC.replace(PARA, POLISHED));
    } finally {
      if (fileUri) {
        try {
          fs.chmodSync(fileUri.fsPath, 0o666);
        } catch {
          // already writable
        }
      }
      api.clearModelForTests();
    }
  });

  test("non-.tex file → not_latex, no diff tab", async () => {
    const api = await getApi();
    api.setModelForTests(new TestModel([POLISHED]));
    try {
      const uri = vscode.Uri.file(
        path.join(os.tmpdir(), `lemmaria-m4-${Date.now()}.txt`),
      );
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from("plain text", "utf8"),
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const outcome = (await vscode.commands.executeCommand(
        "lemmaria.polish",
      )) as PolishOutcome;
      assert.strictEqual(outcome.status, "not_latex");
    } finally {
      api.clearModelForTests();
    }
  });
});
