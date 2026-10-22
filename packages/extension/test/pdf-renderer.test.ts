/**
 * V3 (O18): the PDF renderer works INSIDE the extension host, from the WASM
 * that ships in `dist/`.
 *
 * This is the one test that exercises asset delivery the way a user's install
 * does: `pdfRendererFor` reads `dist/pdfium.wasm` through the VS Code file API
 * off `context.extensionUri`. A renderer that works under plain vitest but
 * cannot find its WASM here would ship broken, and nothing else would notice.
 *
 * (What it does NOT cover is the BUNDLE — the ext-host suite runs `out/`,
 * compiled from source, not `dist/extension.cjs`. That is `test-bundle/`'s
 * job, and it is a recorded limit that the two never meet in one runner.)
 */
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { PdfRenderer } from "@lemmaria/harness";
import * as vscode from "vscode";

interface PdfApi {
  pdfRendererForTests(): Promise<PdfRenderer>;
}

function extensionRoot(): string {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return ext.extensionPath;
}

async function api(): Promise<PdfApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  return (await ext.activate()) as PdfApi;
}

/** The adapters' committed fixture — a one-page pdfTeX PDF. */
function fixturePdf(): Uint8Array {
  const p = path.join(
    extensionRoot(),
    "..",
    "adapters",
    "test",
    "fixtures",
    "simple-en",
    "main.pdf",
  );
  return new Uint8Array(readFileSync(p));
}

suite("pdfRendererFor — the shipped WASM (V3, ADR 0080 §9)", () => {
  test("renders page 1 of the fixture from dist/pdfium.wasm", async () => {
    const render = await (await api()).pdfRendererForTests();
    const doc = await render(fixturePdf());
    assert.ok(doc, "the renderer should open a real PDF");
    assert.equal(doc.pageCount, 1);

    const page = await doc.renderPage(1, { width: 400 });
    assert.equal(page.width, 400);
    assert.ok(page.height > 400, "a letter page is taller than it is wide");
    assert.deepEqual(
      [...page.png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      "should be a real PNG",
    );
    doc.close();
  });

  test("degrades honestly on bytes that are not a PDF", async () => {
    const render = await (await api()).pdfRendererForTests();
    assert.equal(await render(new Uint8Array([1, 2, 3])), undefined);
  });

  test("is memoised — a second call does not re-read the asset", async () => {
    const a = await api();
    const one = await a.pdfRendererForTests();
    const two = await a.pdfRendererForTests();
    assert.equal(one, two, "the renderer should be the same object");
  });
});
