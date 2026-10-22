import { cp, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { extensionBuildOptions } from "./esbuild.options.mjs";

// `metafile` is what `scripts/generate-third-party-notices.mjs` reads to learn
// which third-party packages actually ended up INSIDE the bundles. Walking
// package.json dependencies instead would over-report (devDependencies that
// never ship) and under-report (transitive packages pulled in by a deep
// import), and the notices file has to name exactly what is redistributed.
// `.esbuild-meta.json` is excluded from the .vsix by .vscodeignore's deny-all.
// The options live in `esbuild.options.mjs` so `test-bundle/` can bundle with
// exactly the same ones — a smoke test on its own options would prove nothing
// about what ships (V3, ADR 0080 §9).
const extensionBuild = await build(extensionBuildOptions);

// The webview runs in a browser iframe (ADR 0011): browser target, IIFE, no
// `vscode` external. Importing styles.css emits a sibling dist/webview.css.
const webviewBuild = await build({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  metafile: true,
});

await writeFile(
  ".esbuild-meta.json",
  JSON.stringify({
    inputs: {
      ...extensionBuild.metafile.inputs,
      ...webviewBuild.metafile.inputs,
    },
  }),
);

// The bundled venue set ships as REAL files (dist/venues/) — the scaffolder
// materializes them to disk, and import.meta.url does not survive the CJS
// bundle (ADR 0010; the recorded M3/M4 lesson).
await cp(
  new URL("../harness/venues/", import.meta.url),
  new URL("./dist/venues/", import.meta.url),
  { recursive: true },
);

// The bundled Writing Skill set ships as REAL files too (dist/skills/, ADR
// 0028): venue-carried skills live under dist/venues/<id>/skills/ and in the
// ~/.lemmaria/venues overlay, so they must be read from disk anyway — inlining
// only the bundled set would mean two reading mechanisms for one concept.
await cp(
  new URL("../harness/skills/", import.meta.url),
  new URL("./dist/skills/", import.meta.url),
  { recursive: true },
);

// PDFium's WASM ships as a copied asset (V3, ADR 0080 §9), for exactly the
// reason the two copies above exist: it has to be a real file the extension
// can read at runtime, and `import.meta.url` does not survive the CJS bundle.
// The extension reads it back through `context.extensionUri` (pdf-host.ts),
// never `__dirname`. Resolved through the adapters' own subpath export, which
// is where the package lives.
const { pdfiumWasmPath } = await import("@lemmaria/adapters/pdfium-wasm");
await cp(pdfiumWasmPath(), new URL("./dist/pdfium.wasm", import.meta.url), {
  recursive: false,
});
