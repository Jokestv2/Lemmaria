/**
 * U6 — the Glossary bottom panel.
 *
 * The panel renders the SAME glossary the `glossary_consistent` validator
 * enforces (resolveMemory over the PAPER.md layers), so these tests drive real
 * PAPER.md files on disk through the real loader.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface GlossaryRow {
  term: string;
  zh: string;
  abbrev: string;
}

interface GlossaryApi {
  computeGlossaryForTests(uri: vscode.Uri | undefined): Promise<GlossaryRow[]>;
  refreshGlossaryForTests(): Promise<void>;
  glossaryTreeForTests(): {
    children: GlossaryRow[];
    items: { label: string; description: string }[];
    message: string | undefined;
    badge: number | undefined;
  };
}

async function getApi(): Promise<GlossaryApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as GlossaryApi;
}

/** A paper dir with a PAPER.md carrying the given content. */
function writePaper(paperMd: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-gloss-"));
  fs.writeFileSync(
    path.join(dir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nWe study the large language model here.\n\\end{document}\n",
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "PAPER.md"), paperMd, "utf8");
  return vscode.Uri.file(path.join(dir, "main.tex"));
}

const GLOSSARY_PAPER = [
  "# Paper",
  "",
  "## Glossary",
  "",
  "| Term | 中文 | Abbrev |",
  "| --- | --- | --- |",
  "| large language model | 大语言模型 | LLM |",
  "| retrieval-augmented generation | 检索增强生成 | RAG |",
  "| fine-tuning | 微调 | |",
  "",
].join("\n");

suite("U6: the Glossary panel", function () {
  this.timeout(30000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("it lists the parsed PAPER.md terms in source order", async () => {
    const api = await getApi();
    const uri = writePaper(GLOSSARY_PAPER);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const rows = await api.computeGlossaryForTests(uri);
    assert.deepStrictEqual(
      rows.map((r) => r.term),
      ["large language model", "retrieval-augmented generation", "fine-tuning"],
    );
    assert.strictEqual(rows[0]?.zh, "大语言模型");
    assert.strictEqual(rows[0]?.abbrev, "LLM");
    // An empty abbrev stays empty in the model; the em-dash is a render concern.
    assert.strictEqual(rows[2]?.abbrev, "");
  });

  test("a paper with no glossary section yields an empty list, not an error", async () => {
    const api = await getApi();
    const uri = writePaper("# Paper\n\n## Contribution\n\nA method.\n");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    assert.deepStrictEqual(await api.computeGlossaryForTests(uri), []);
  });

  test("no paper open yields an empty list", async () => {
    const api = await getApi();
    assert.deepStrictEqual(await api.computeGlossaryForTests(undefined), []);
  });

  test("the tree provider renders every row, with the mockup's em-dash for a missing abbrev", async () => {
    // The U5 round-1 lesson (quoted in glossary-ui.ts): a provider can be
    // "correct" and render nothing — computeGlossary passing is not evidence
    // that getChildren/getTreeItem do. Drive the provider itself.
    const api = await getApi();
    const uri = writePaper(GLOSSARY_PAPER);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await api.refreshGlossaryForTests();

    const tree = api.glossaryTreeForTests();
    assert.strictEqual(
      tree.children.length,
      3,
      "all 3 rows must be handed out",
    );
    assert.deepStrictEqual(
      tree.items.map((i) => i.label),
      ["large language model", "retrieval-augmented generation", "fine-tuning"],
    );
    assert.strictEqual(tree.items[0]?.description, "大语言模型 · LLM");
    // Empty abbrev renders as an em-dash, not a blank (mockup).
    assert.strictEqual(tree.items[2]?.description, "微调 · —");
    assert.strictEqual(tree.badge, 3);
    assert.ok(
      tree.message?.includes("glossary_consistent"),
      `the enforcement banner should name the validator, got: ${tree.message}`,
    );
  });

  test("clicking a term reveals its first use in the paper", async () => {
    const api = await getApi();
    const uri = writePaper(GLOSSARY_PAPER);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    await vscode.commands.executeCommand("lemmaria.revealGlossaryTerm", {
      term: "large language model",
      zh: "大语言模型",
      abbrev: "LLM",
    });

    const active = vscode.window.activeTextEditor;
    assert.ok(active);
    // The body line ("We study the large language model here.") is 0-based 2.
    assert.strictEqual(active.selection.start.line, 2);
    assert.strictEqual(
      active.document.getText(active.selection),
      "large language model",
    );
  });
});
