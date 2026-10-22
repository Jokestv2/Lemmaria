// Gives the CJS bundle a working `import.meta.url` (V3, ADR 0080 §9).
//
// esbuild lowers `import.meta.url` to `{}` when it bundles ESM to CJS — and it
// SUPPRESSES the warning for code under `node_modules`, so a vendored package
// whose glue reads it fails at runtime with nothing said at build time.
// `@embedpdf/pdfium`'s loader is exactly that: it reads `import.meta.url` to
// locate itself and throws `Cannot read properties of undefined (reading
// 'startsWith')` from `init`.
//
// `esbuild.options.mjs` pairs `define: {"import.meta.url": "__lemmaria_file_url"}`
// with `inject: ["./file-url-shim.mjs"]`, so every lowered read resolves to the
// identifier this module exports. S6 measured this fix; `test-bundle/` is the
// guard that it stays applied.
import { pathToFileURL } from "node:url";

export const __lemmaria_file_url = pathToFileURL(__filename).href;
