import { createRequire } from "node:module";

/**
 * Where `@embedpdf/pdfium`'s WASM binary sits on disk (V3, ADR 0080 §9).
 *
 * **Exported ONLY as the subpath `@lemmaria/adapters/pdfium-wasm`**, never from
 * the package barrel — the harness's `bundledSkillsDir()` precedent (ADR 0028).
 * The reason is mechanical: this module reads `import.meta.url`, and esbuild
 * lowers that to `{}` in the extension's CJS bundle. Keeping it off the barrel
 * means the bundle never contains an `import.meta.url` of Lemmaria's OWN, so
 * the shim in `esbuild.mjs` only ever has to cover the vendored glue.
 *
 * The CLI and the extension's build script call this; the extension at RUNTIME
 * reads its copied `dist/pdfium.wasm` through the VS Code file API instead.
 *
 * `./pdfium.wasm` is the package's only exported wasm subpath —
 * `./dist/pdfium.wasm` raises ERR_PACKAGE_PATH_NOT_EXPORTED (S6).
 */
export function pdfiumWasmPath(): string {
  return createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm");
}
