/**
 * A CJS entry that renders one PDF page, for `bundle-renders.test.ts` (V3,
 * ADR 0080 §9).
 *
 * It stands in for `src/extension.ts`: bundled with the SAME esbuild options
 * the extension is, it exercises the one thing about those options that has no
 * other guard — that `@embedpdf/pdfium`'s `import.meta.url` read survives the
 * lowering to CJS. The extension's own entry cannot serve, because it imports
 * `vscode` and only an extension host can provide that.
 *
 * `node probe.cjs <wasm> <pdf> <out.png>`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createPdfiumRenderer } from "@lemmaria/adapters";

async function main(): Promise<void> {
  const [wasmPath, pdfPath, outPath] = process.argv.slice(2);
  if (!wasmPath || !pdfPath || !outPath) {
    throw new Error("usage: probe.cjs <wasm> <pdf> <out.png>");
  }
  const render = createPdfiumRenderer(new Uint8Array(await readFile(wasmPath)));
  const doc = await render(new Uint8Array(await readFile(pdfPath)));
  if (!doc) throw new Error("the renderer refused the PDF");
  const page = await doc.renderPage(1, { width: 400 });
  await writeFile(outPath, page.png);
  doc.close();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
