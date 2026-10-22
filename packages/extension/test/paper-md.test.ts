// M8 CM1: the "Lemmaria: Create PAPER.md" command auto-drafts the project
// memory file from the document structure (the user then refines it), opens an
// existing one instead of overwriting (invariant 3: never clobber user
// content), and never writes without the explicit command.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const MAIN = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}

Some introductory prose about attention.

\\subsection{Motivation}

Why this matters.

\\section{Method}

The method paragraph.

\\end{document}
`;

interface PaperMdOutcome {
  status: string;
  message?: string;
  path?: string;
}

async function makeProject(): Promise<{ dir: string; main: vscode.Uri }> {
  const dir = path.join(
    os.tmpdir(),
    `lemmaria-m8-paper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const main = vscode.Uri.file(path.join(dir, "main.tex"));
  await vscode.workspace.fs.writeFile(main, Buffer.from(MAIN, "utf8"));
  return { dir, main };
}

suite("M8: PAPER.md auto-draft command", function () {
  this.timeout(20000);

  test("creates a structure-seeded draft and opens it", async () => {
    const { dir, main } = await makeProject();
    const doc = await vscode.workspace.openTextDocument(main);
    await vscode.window.showTextDocument(doc);
    const outcome = (await vscode.commands.executeCommand(
      "lemmaria.createPaperMd",
    )) as PaperMdOutcome;
    assert.strictEqual(outcome.status, "created", outcome.message);
    const paperUri = vscode.Uri.file(path.join(dir, "PAPER.md"));
    const content = Buffer.from(
      await vscode.workspace.fs.readFile(paperUri),
    ).toString("utf8");
    assert.ok(content.includes("## Outline"), "draft has an Outline section");
    assert.ok(
      content.includes("- Introduction"),
      "outline seeded from structure",
    );
    assert.ok(content.includes("  - Motivation"), "nested outline entry");
    assert.ok(content.includes("## Glossary"), "draft has a Glossary section");
    // The draft is opened for the user to refine.
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      paperUri.fsPath,
    );
  });

  test("drafts from a Markdown paper's heading tree (adapter picked by extension)", async () => {
    const dir = path.join(
      os.tmpdir(),
      `lemmaria-m8-paper-md-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const main = vscode.Uri.file(path.join(dir, "draft.md"));
    const MD = `# My Paper

## Background

Some prose.

### Related Work

More prose.

## Approach

The approach paragraph.
`;
    await vscode.workspace.fs.writeFile(main, Buffer.from(MD, "utf8"));
    const doc = await vscode.workspace.openTextDocument(main);
    await vscode.window.showTextDocument(doc);
    const outcome = (await vscode.commands.executeCommand(
      "lemmaria.createPaperMd",
    )) as PaperMdOutcome;
    assert.strictEqual(outcome.status, "created", outcome.message);
    const content = Buffer.from(
      await vscode.workspace.fs.readFile(
        vscode.Uri.file(path.join(dir, "PAPER.md")),
      ),
    ).toString("utf8");
    assert.ok(
      content.includes("- Background"),
      `outline seeded from the .md heading tree, got:\n${content}`,
    );
    assert.ok(content.includes("- Related Work"), "nested .md heading");
    assert.ok(content.includes("- Approach"), "second .md heading");
  });

  test("does not overwrite an existing PAPER.md", async () => {
    const { dir, main } = await makeProject();
    const paperUri = vscode.Uri.file(path.join(dir, "PAPER.md"));
    const sentinel = "# Hand-written\n\n## Style\n- keep me\n";
    await vscode.workspace.fs.writeFile(
      paperUri,
      Buffer.from(sentinel, "utf8"),
    );
    const doc = await vscode.workspace.openTextDocument(main);
    await vscode.window.showTextDocument(doc);
    const outcome = (await vscode.commands.executeCommand(
      "lemmaria.createPaperMd",
    )) as PaperMdOutcome;
    assert.strictEqual(outcome.status, "opened_existing", outcome.message);
    const content = Buffer.from(
      await vscode.workspace.fs.readFile(paperUri),
    ).toString("utf8");
    assert.strictEqual(content, sentinel, "existing PAPER.md untouched");
  });
});
