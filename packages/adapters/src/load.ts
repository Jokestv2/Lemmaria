/**
 * Adapter factory (M8): pick the DocumentAdapter by the entry file's
 * extension. Both adapters share the citation surface (`citedKeys`,
 * `bibEntries`) beyond the DocumentAdapter contract, so citation checking is
 * doc-kind-agnostic at the call site.
 */

import {
  type LatexAdapter,
  type LatexVerifyBinding,
  loadLatexAdapter,
} from "./latex/adapter.js";
import type { FileReader } from "./latex/project.js";
import {
  type MarkdownAdapter,
  loadMarkdownAdapter,
} from "./markdown/adapter.js";

export function loadAdapterFor(
  reader: FileReader,
  entryFile: string,
  latexVerify?: LatexVerifyBinding,
): Promise<LatexAdapter | MarkdownAdapter> {
  return /\.(md|markdown)$/i.test(entryFile)
    ? loadMarkdownAdapter(reader, entryFile)
    : loadLatexAdapter(reader, entryFile, latexVerify);
}
