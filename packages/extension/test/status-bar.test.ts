/**
 * U6 — the enriched status bar.
 *
 * Counts use the ENGINE's prose basis (protected spans stripped), so the
 * assertions below deliberately include LaTeX markup that must NOT be counted.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface StatusBarApi {
  computeCountsForTests(
    editor: vscode.TextEditor,
  ): Promise<{ en: number; zh: number } | undefined>;
  statusBarTextsForTests(): Record<string, string | undefined>;
  refreshStatusBarForTests(): Promise<void>;
  gitBranchForTests(root: string): string | undefined;
}

async function getApi(): Promise<StatusBarApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as StatusBarApi;
}

function writeTexWith(name: string, body: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-sb-"));
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`,
    "utf8",
  );
  return vscode.Uri.file(file);
}

suite("U6: status-bar counts", function () {
  this.timeout(30000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("EN words count the prose, not the LaTeX markup", async () => {
    const api = await getApi();
    // Prose = "We propose a fast method  with ." -> We/propose/a/fast/method/with
    // = 6. \citep{fast2020} and $x^2$ are protected spans and must NOT be
    // counted: an unstripped count of this same line is 10 (citep, fast2020, x,
    // 2 would join in), so 6 is what proves the engine's prose basis is used.
    const uri = writeTexWith(
      "counts.tex",
      "We propose a fast method \\citep{fast2020} with $x^2$.",
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.lineAt(2);
    editor.selection = new vscode.Selection(line.range.start, line.range.end);

    const counts = await api.computeCountsForTests(editor);
    assert.ok(counts, "counts should be available for a .tex selection");
    assert.strictEqual(counts.en, 6);
    assert.strictEqual(counts.zh, 0);
  });

  test("a selection that is ALL protected span counts zero, never its markup", async () => {
    // Regression (gate review, Critical 1): selecting only \citep{...} freezes
    // and strips to "", and a fallback to the raw unit text would score
    // `citep` + `fast2020` = EN 2 w — fabricating words for a selection with no
    // prose at all, the exact dishonesty this module exists to prevent.
    const api = await getApi();
    const uri = writeTexWith("counts-allfrozen.tex", "\\citep{fast2020}");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.lineAt(2);
    editor.selection = new vscode.Selection(line.range.start, line.range.end);

    const counts = await api.computeCountsForTests(editor);
    assert.ok(counts);
    assert.strictEqual(counts.en, 0);
    assert.strictEqual(counts.zh, 0);

    await api.refreshStatusBarForTests();
    assert.strictEqual(api.statusBarTextsForTests().en, "EN 0 w");
  });

  test("CN counts by character and EN by word in one mixed selection (invariant 6)", async () => {
    const api = await getApi();
    // "我们提出一个方法" = 8 Han chars; "fast method" = 2 EN words.
    const uri = writeTexWith(
      "counts-mixed.tex",
      "我们提出一个方法 fast method",
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.lineAt(2);
    editor.selection = new vscode.Selection(line.range.start, line.range.end);

    const counts = await api.computeCountsForTests(editor);
    assert.ok(counts);
    assert.strictEqual(counts.zh, 8);
    assert.strictEqual(counts.en, 2);
  });

  test("an empty selection yields no counts, rather than a wrong document total", async () => {
    // The counts are a SELECTION affordance (the CodeLens bar / U1 D4 rule).
    //
    // A whole-document total is deliberately NOT computed: `resolveSelection`'s
    // "document" scope returns the whole FILE (selection.ts:83), and plain
    // environment delimiters are not protected spans (the recorded M6 limit) —
    // so the preamble plus the words begin/document/end/document all score as
    // prose. This very paper counts 7 that way, for 3 real words. Hiding is the
    // honest answer; an accurate document total needs an adapter primitive
    // (see progress.md -> Design deltas / U6).
    const api = await getApi();
    const uri = writeTexWith("counts-doc.tex", "Alpha beta gamma.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    assert.strictEqual(await api.computeCountsForTests(editor), undefined);
    await api.refreshStatusBarForTests();
    const texts = api.statusBarTextsForTests();
    assert.strictEqual(texts.en, undefined, "EN item must be hidden");
    assert.strictEqual(texts.zh, undefined, "CN item must be hidden");
  });

  test("the items render both languages and update with the selection", async () => {
    const api = await getApi();
    const uri = writeTexWith("counts-live.tex", "Alpha beta gamma delta.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    editor.selection = new vscode.Selection(2, 0, 2, 11); // "Alpha beta "
    await api.refreshStatusBarForTests();
    let texts = api.statusBarTextsForTests();
    assert.strictEqual(texts.en, "EN 2 w");
    assert.strictEqual(texts.zh, "中文 0 字"); // both always render (invariant 6)

    editor.selection = new vscode.Selection(2, 0, 2, 23); // the whole sentence
    await api.refreshStatusBarForTests();
    texts = api.statusBarTextsForTests();
    assert.strictEqual(texts.en, "EN 4 w");
  });

  test("a non-paper file yields no counts", async () => {
    const api = await getApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-sb-txt-"));
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "Alpha beta.\n", "utf8");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 10);

    assert.strictEqual(await api.computeCountsForTests(editor), undefined);
  });
});

suite("U6: status-bar tier, branch, engine, mark", function () {
  this.timeout(30000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the engine item names Lemmaria's resolved format and the file encoding", async () => {
    const api = await getApi();
    const uri = writeTexWith("engine.tex", "Alpha.");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await api.refreshStatusBarForTests();
    assert.strictEqual(api.statusBarTextsForTests().engine, "LaTeX · UTF-8");
  });

  test("a Markdown paper renders the Markdown adapter's format", async () => {
    const api = await getApi();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-md-"));
    const file = path.join(dir, "paper.md");
    fs.writeFileSync(file, "# Title\n\nAlpha beta.\n", "utf8");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    await api.refreshStatusBarForTests();
    assert.strictEqual(api.statusBarTextsForTests().engine, "Markdown · UTF-8");
  });

  test("the branch item reads a real branch and hides outside a repo", async () => {
    const api = await getApi();
    // This repo IS a git checkout, so the reader must return a real name.
    const here = api.gitBranchForTests(process.cwd());
    assert.ok(
      typeof here === "string" && here.length > 0,
      `expected a branch name for the repo at ${process.cwd()}, got ${here}`,
    );
    // A bare temp dir is not a repo — honest hide, never a fabricated "main".
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "lemmaria-u6-nogit-"),
    );
    assert.strictEqual(api.gitBranchForTests(outside), undefined);
  });

  test("the Lemmaria mark renders", async () => {
    const api = await getApi();
    await api.refreshStatusBarForTests();
    assert.strictEqual(api.statusBarTextsForTests().mark, "◆ Lemmaria");
  });
});

/**
 * D4 / CHROME-2: the `L0 routed` badge is DELETED, not hidden.
 *
 * The routing tier is an internal detail a user has no decision to make with,
 * and the backlog's argument for deleting rather than hiding was that a code
 * path rendering nothing is worse than none. This is a source-level sweep for
 * the same reason `check-vscode-imports.mjs` is one: what must be true is that
 * the symbols are ABSENT, and an absent symbol has no behaviour to observe.
 */
suite("D4: the routed-tier badge is gone", () => {
  const sources = (): string => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts"))
          out.push(`${full}\n${fs.readFileSync(full, "utf8")}`);
      }
    };
    walk(path.join(ext.extensionPath, "src"));
    return out.join("\n");
  };

  test("no recordRoutedTier / resetRoutedTierForTests / tierItem survives in src", () => {
    const all = sources();
    for (const symbol of [
      "recordRoutedTier",
      "resetRoutedTierForTests",
      "tierItem",
      "lastRouted",
      "renderTier",
    ]) {
      assert.ok(!all.includes(symbol), `${symbol} still referenced in src/`);
    }
  });

  test("the status bar no longer exposes a tier text", async () => {
    const api = await getApi();
    await api.refreshStatusBarForTests();
    assert.ok(
      !("tier" in api.statusBarTextsForTests()),
      "statusBarTextsForTests still reports a tier item",
    );
  });
});
