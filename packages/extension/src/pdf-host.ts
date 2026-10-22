import { createPdfiumRenderer } from "@lemmaria/adapters";
import type { PdfRenderer } from "@lemmaria/harness";
import * as vscode from "vscode";

/**
 * The `PdfRenderer` inside the extension host (V3, ADR 0080 §9).
 *
 * The WASM ships as a copied asset at `dist/pdfium.wasm` and is read through
 * the VS Code file API from `context.extensionUri` — never `__dirname`, and
 * never the package's own subpath, because the extension runs from a bundle
 * and `import.meta.url` is not available to it (ADR 0028's lesson, the third
 * time). This is the same route `skills-ui.ts` and `venue-ui.ts` take for
 * their assets.
 *
 * Memoised: the bytes are ~2 MiB and PDFium's module is process-global, so a
 * second read would buy nothing. The read is lazy — nothing calls this during
 * activation, so activation cost is unchanged.
 *
 * **Exported for V4**, which is the milestone that hands a renderer to a
 * review. V3 wires it to no task; it is proven here and from the CLI.
 */
let cached: Promise<PdfRenderer> | undefined;

export function pdfRendererFor(
  context: vscode.ExtensionContext,
): Promise<PdfRenderer> {
  if (!cached) {
    cached = (async () => {
      const uri = vscode.Uri.joinPath(
        context.extensionUri,
        "dist",
        "pdfium.wasm",
      );
      const bytes = await vscode.workspace.fs.readFile(uri);
      return createPdfiumRenderer(bytes);
    })();
  }
  return cached;
}

/** Test seam: forget the memoised renderer so a case can read the asset again. */
export function resetPdfRendererForTests(): void {
  cached = undefined;
}
