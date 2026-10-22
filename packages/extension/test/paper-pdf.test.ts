/**
 * V3 (O14, O17): `lemmaria.paperPdf` and the two new `Workspace` members,
 * inside the real extension host.
 *
 * The setting is read exactly as `lemmaria.paperEntry` is — normalised,
 * root-contained, and `stat`-verified on every read — so a path typed once and
 * since renamed degrades rather than sending a review after a file that is not
 * there. The port's `stat`/`readBinary` are what the PDF policy reads through.
 */
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "@lemmaria/harness";
import * as vscode from "vscode";

interface PaperPdfApi {
  configuredPaperPdfForTests(): Promise<string | undefined>;
  workspacePortForTests(root: string): Workspace;
}

async function api(): Promise<PaperPdfApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as PaperPdfApi;
}

/**
 * Set the setting, or clear it with `undefined`.
 *
 * `ConfigurationTarget.Global`, not `Workspace`: the ext-host suite runs with
 * no folder open, and writing a Workspace value throws there. What is under
 * test is how `configuredPaperPdf` READS the setting, which is the same either
 * way — the QuickPick that writes it at `Workspace` is `paperEntry`'s own,
 * already covered.
 */
async function setPaperPdf(value: string | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration("lemmaria")
    .update("paperPdf", value, vscode.ConfigurationTarget.Global);
}

suite("lemmaria.paperPdf (V3, ADR 0080 §8)", () => {
  let folder: string | undefined;

  suiteSetup(() => {
    folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  });

  teardown(async () => {
    await setPaperPdf(undefined);
  });

  test("empty by default — the setting changes nothing until it is set", async () => {
    const a = await api();
    assert.equal(await a.configuredPaperPdfForTests(), undefined);
  });

  test("a relative path to a file that EXISTS comes back root-relative", async () => {
    if (!folder) return; // no folder open: nothing to be relative to
    const dir = path.join(folder, "v3-pdf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "paper.pdf"), "%PDF-1.5\n");
    const a = await api();
    await setPaperPdf("v3-pdf/paper.pdf");
    assert.equal(await a.configuredPaperPdfForTests(), "v3-pdf/paper.pdf");
  });

  test("a backslash path is normalised to forward slashes", async () => {
    if (!folder) return;
    const dir = path.join(folder, "v3-pdf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "paper.pdf"), "%PDF-1.5\n");
    const a = await api();
    await setPaperPdf(`v3-pdf${String.fromCharCode(92)}paper.pdf`);
    assert.equal(await a.configuredPaperPdfForTests(), "v3-pdf/paper.pdf");
  });

  test("a MISSING file degrades to undefined, never to a path that is not there", async () => {
    const a = await api();
    await setPaperPdf("nowhere/gone.pdf");
    assert.equal(await a.configuredPaperPdfForTests(), undefined);
  });

  test("an ESCAPE is refused", async () => {
    const a = await api();
    for (const bad of ["../outside.pdf", "a/../../outside.pdf"]) {
      await setPaperPdf(bad);
      assert.equal(
        await a.configuredPaperPdfForTests(),
        undefined,
        `should refuse ${bad}`,
      );
    }
  });

  test("an ABSOLUTE path is refused", async () => {
    const a = await api();
    const abs = path.join(os.tmpdir(), "elsewhere.pdf");
    writeFileSync(abs, "%PDF-1.5\n");
    await setPaperPdf(abs);
    assert.equal(await a.configuredPaperPdfForTests(), undefined);
  });
});

suite("VscodeWorkspace.stat / readBinary (V3, ADR 0080 §8)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-wsport-"));
  suiteSetup(() => {
    mkdirSync(path.join(root, "out"), { recursive: true });
    writeFileSync(path.join(root, "main.tex"), "x");
    writeFileSync(path.join(root, "out", "main.pdf"), "%PDF-1.5\n");
  });

  test("stat reports an mtime in MILLISECONDS and a size", async () => {
    const ws = (await api()).workspacePortForTests(root);
    const s = await ws.stat?.("out/main.pdf");
    assert.equal(s?.size, 9);
    // vscode.workspace.fs.stat reports `mtime` in ms; the policy compares it
    // directly against a manuscript file's, so the unit matters.
    assert.ok((s?.mtimeMs ?? 0) > 1_600_000_000_000, "mtime should be ms");
  });

  test("stat returns undefined for a missing file rather than throwing", async () => {
    const ws = (await api()).workspacePortForTests(root);
    assert.equal(await ws.stat?.("out/nope.pdf"), undefined);
  });

  test("readBinary returns the raw bytes", async () => {
    const ws = (await api()).workspacePortForTests(root);
    const bytes = await ws.readBinary?.("out/main.pdf");
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  });

  test("both are ROOT-CONTAINED — the path can come from a user setting", async () => {
    const ws = (await api()).workspacePortForTests(root);
    await assert.rejects(() => ws.stat?.("../outside.pdf") as Promise<unknown>);
    await assert.rejects(
      () => ws.readBinary?.("../outside.pdf") as Promise<unknown>,
    );
  });
});
