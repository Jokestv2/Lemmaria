/**
 * The extension bundle's esbuild options, in a module of their own (V3, ADR
 * 0080 §9) so a TEST can bundle with exactly the same ones.
 *
 * That matters because of `define` + `inject` below: a smoke test that bundled
 * with its own options would prove something about its own options, not about
 * what ships. `test-bundle/bundle-renders.test.ts` imports this, swaps only
 * `entryPoints` and `outfile`, and runs the result under plain Node.
 */

/** @type {import("esbuild").BuildOptions} */
export const extensionBuildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  format: "cjs",
  loader: { ".yaml": "text" },
  platform: "node",
  target: "node20",
  sourcemap: true,
  metafile: true,
  // V3 (ADR 0080 §9): `import.meta.url` in a CJS bundle.
  //
  // esbuild lowers it to `{}` and **suppresses the warning under
  // `node_modules`**, so `@embedpdf/pdfium`'s loader — which reads it to find
  // itself — fails at runtime with nothing said at build time. This pair is
  // S6's measured fix: every lowered read resolves to the identifier
  // `file-url-shim.mjs` exports, which is a real `file://` URL for the bundle.
  //
  // Removing either half breaks `test-bundle/bundle-renders.test.ts`, which
  // exists for exactly that reason (watched by hand once, at T10).
  define: { "import.meta.url": "__lemmaria_file_url" },
  inject: ["./file-url-shim.mjs"],
};
