/**
 * U6 — the selection CodeLens action bar.
 *
 * Drives VS Code's REAL CodeLens pipeline (`vscode.executeCodeLensProvider`),
 * not the provider object, so the assertions cover what the editor actually
 * pulled — the U5 round-1 lesson (a provider can be "correct" and render
 * nothing).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { QUICK_ACTION_COMMAND, QUICK_ACTION_ORDER } from "../src/quick-actions";

function writeTexWith(name: string, body: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-lens-"));
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`,
    "utf8",
  );
  return vscode.Uri.file(file);
}

async function lensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    uri,
  );
  return lenses ?? [];
}

suite("U6: the selection CodeLens action bar", function () {
  this.timeout(30000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a non-empty selection shows the mockup's action row, anchored at its first line", async () => {
    const uri = writeTexWith("lens.tex", "Hello world.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 0, 2, 12);

    const lenses = await lensesFor(uri);
    // D4 / QA-1 + QA-2. The TITLES are written out, deliberately: they come
    // from the action definitions' `name:`, which `QUICK_ACTION_ORDER` does not
    // carry, so deriving them here would assert the code against itself. The
    // ORDER and the command ids ARE derived, below.
    assert.deepStrictEqual(
      lenses.map((l) => l.command?.title ?? ""),
      [
        "Lemmaria",
        "Proofread",
        "Polish",
        "Shrink By",
        "Expand By",
        "Translate",
        "More…",
      ],
    );
    // The brand mark is plain text (no command), the actions are live.
    assert.strictEqual(lenses[0]?.command?.command, "");
    assert.deepStrictEqual(
      lenses
        .slice(1, 1 + QUICK_ACTION_ORDER.length)
        .map((l) => l.command?.command),
      QUICK_ACTION_ORDER.map((id) => QUICK_ACTION_COMMAND[id]),
    );
    assert.strictEqual(lenses[6]?.command?.command, "lemmaria.moreActions");
    // No lens may advertise an unbuilt version (the A5 stale-shell rule).
    for (const lens of lenses) {
      assert.ok(
        !/\(v\d+\.\d+\)$/.test(lens.command?.title ?? ""),
        `lens still carries a version tag: ${lens.command?.title}`,
      );
    }
    // Anchored at the selection's first line (0-based line 2).
    for (const lens of lenses) {
      assert.strictEqual(lens.range.start.line, 2);
    }
  });

  test("an empty selection shows no lenses (the U1 D4 affordance rule)", async () => {
    const uri = writeTexWith("lens-empty.tex", "Hello world.");
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(2, 4, 2, 4);

    assert.deepStrictEqual(await lensesFor(uri), []);
  });

  test("a non-paper file gets no Lemmaria lenses", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemmaria-u6-lens-txt-"));
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "Hello world.\n", "utf8");
    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 5);

    assert.deepStrictEqual(await lensesFor(uri), []);
  });
});

/**
 * D4 / QA-2: `quick-actions.ts` is the ONE home for the order. Four of the five
 * former restatements now derive from it; `package.json` cannot, because VS
 * Code reads the manifest before any of our code runs — so it is asserted
 * against the list instead. That is what *One home per fact* asks for: one
 * source, plus a check that the one unavoidable restatement agrees with it.
 */
suite("D4: one home for the quick-action order", () => {
  const manifest = (): Record<string, unknown> => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    return JSON.parse(
      fs.readFileSync(path.join(ext.extensionPath, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  };

  test("the editor/context menu groups follow QUICK_ACTION_ORDER", () => {
    const pkg = manifest();
    const menus = (
      (pkg.contributes as { menus: Record<string, unknown[]> }).menus[
        "editor/context"
      ] as { command: string; group: string }[]
    ).filter((m) =>
      QUICK_ACTION_ORDER.some((id) => QUICK_ACTION_COMMAND[id] === m.command),
    );
    assert.strictEqual(
      menus.length,
      QUICK_ACTION_ORDER.length,
      "a quick action is missing from the context menu",
    );
    const byGroup = [...menus].sort((a, b) => a.group.localeCompare(b.group));
    assert.deepStrictEqual(
      byGroup.map((m) => m.command),
      QUICK_ACTION_ORDER.map((id) => QUICK_ACTION_COMMAND[id]),
      "context-menu group order disagrees with QUICK_ACTION_ORDER",
    );
  });

  /**
   * QA-1's real trap: the palette does NOT follow a YAML `name:` change. The
   * five titles are `%cmd.*%` keys in hand-maintained NLS bundles, and none of
   * `nls.test.ts`'s four structural guards would notice them drifting.
   */
  test("each cmd.* NLS title ends with the action's YAML name, per locale", async () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    const root = ext.extensionPath;
    const bundles = {
      en: JSON.parse(
        fs.readFileSync(path.join(root, "package.nls.json"), "utf8"),
      ) as Record<string, string>,
      zh: JSON.parse(
        fs.readFileSync(path.join(root, "package.nls.zh-cn.json"), "utf8"),
      ) as Record<string, string>,
    };
    const api = (await ext.activate()) as {
      actionNamesForTests(): Record<string, { en?: string; zh?: string }>;
    };
    const names = api.actionNamesForTests();
    for (const id of QUICK_ACTION_ORDER) {
      const def = names[id];
      assert.ok(def, `no definition loaded for ${id}`);
      const key = `cmd.${QUICK_ACTION_COMMAND[id].replace("lemmaria.", "")}`;
      for (const locale of ["en", "zh"] as const) {
        const title = bundles[locale][key];
        assert.ok(title, `${key} missing from the ${locale} bundle`);
        assert.ok(
          title.endsWith(def[locale] ?? ""),
          `${key} (${locale}) is "${title}" but the action is named "${def[locale]}"`,
        );
      }
    }
  });
  /**
   * D4 review, finding 10: the webview's FIRST-PAINT tile labels are a sixth
   * home for the same five names. They live in `webview/parts/strings.ts` with
   * a comment telling the next person to keep them equal to the YAML `name:`,
   * and nothing checked it — which is exactly the drift QA-2 removed, one file
   * over. `main.ts` cannot be imported under jsdom (ADR 0037 §3), so the check
   * lives here, where the loaded definitions are reachable.
   */
  test("the first-paint tile labels equal the action names, per locale", async () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    const api = (await ext.activate()) as {
      actionNamesForTests(): Record<string, { en?: string; zh?: string }>;
    };
    const names = api.actionNamesForTests();
    const src = fs.readFileSync(
      path.join(ext.extensionPath, "src", "webview", "parts", "strings.ts"),
      "utf8",
    );
    for (const id of QUICK_ACTION_ORDER) {
      const key = `tile${id
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("")}`;
      const found = [...src.matchAll(new RegExp(`${key}: "([^"]*)"`, "g"))].map(
        (m) => m[1],
      );
      assert.strictEqual(
        found.length,
        2,
        `${key} should appear once per locale, found ${found.length}`,
      );
      assert.deepStrictEqual(
        found,
        [names[id]?.en, names[id]?.zh],
        `${key} has drifted from ${id}'s YAML name`,
      );
    }
  });
});
