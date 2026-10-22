export const ADAPTERS_PACKAGE_NAME = "@lemmaria/adapters";

export {
  LatexAdapter,
  type LatexVerifyBinding,
  loadLatexAdapter,
} from "./latex/adapter.js";
export { MarkdownAdapter, loadMarkdownAdapter } from "./markdown/adapter.js";
export { loadAdapterFor } from "./load.js";
export { MarkdownDocument } from "./markdown/document.js";
export {
  buildMarkdownStructure,
  citeKeysIn,
} from "./markdown/structure.js";
export { collectMarkdownProtectedSpans } from "./markdown/protected-spans.js";
export { resolveMarkdownSelection } from "./markdown/selection.js";
export { applyEditIn } from "./latex/apply-edit.js";
export { type BibEntry, parseBibtex, resolveBibPaths } from "./latex/bib.js";
export {
  type CompileLogSource,
  parseCompileLog,
  parseOutputPages,
  warningId,
} from "./latex/compile-log.js";
export { countWords } from "./latex/count-words.js";
export {
  detectBibliographyStyle,
  detectLatexFeatures,
  type LatexFeatures,
} from "./latex/detect.js";
export { type FileReader, LatexProject } from "./latex/project.js";
export { collectProtectedSpans } from "./latex/protected-spans.js";
export { manuscriptGraphFor } from "./manuscript-graph.js";
export type { ProtectedSpanOptions } from "./protected-options.js";
export {
  protectedSpansForFile,
  protectedSpansIn,
} from "./protected-fragment.js";
export { resolveSelectionIn } from "./latex/selection.js";
export { buildStructure } from "./latex/structure.js";
export { type ScriptRunResult, spawnScript } from "./script/run-script.js";
// The PDF renderer (V3, ADR 0080 §9). `wasm-path.ts` is deliberately NOT here:
// it reads `import.meta.url`, and keeping it on its own subpath export means
// the extension's CJS bundle never contains one of Lemmaria's own.
export { createPdfiumRenderer } from "./pdf/pdfium-renderer.js";
export { bgraToRgba, encodeRgbaPng } from "./pdf/png.js";
