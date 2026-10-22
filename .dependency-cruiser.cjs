/** Invariant 1 (CLAUDE.md): no `vscode` import outside packages/extension;
 *  dependency direction is UI -> harness, never the reverse. */
module.exports = {
  forbidden: [
    {
      name: "no-vscode-outside-extension",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/extension/" },
      to: { path: "^vscode$" },
    },
    {
      // The extension's webview bundle runs in the browser context: it must
      // not import `vscode` (ADR 0011). The package-wide exemption above does
      // not cover it, so guard the webview sources explicitly.
      name: "no-vscode-in-webview",
      severity: "error",
      from: { path: "^packages/extension/src/webview" },
      to: { path: "^vscode$" },
    },
    {
      name: "no-reverse-dependency-on-extension",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/extension/" },
      to: { path: "^packages/extension/" },
    },
    {
      // The harness is the bottom layer: adapters/cli depend on it, never the
      // reverse (also keeps its engine stubs, not the real LatexAdapter).
      name: "no-harness-upward-dependency",
      severity: "error",
      from: { path: "^packages/harness/" },
      to: { path: "^packages/(adapters|cli)/|^@lemmaria/(adapters|cli)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // build/test artifacts, not source — .vscode-test is a full VS Code
    // download whose bundles OOM the cruiser if scanned
    exclude: { path: "(^|/)(\\.vscode-test|dist|out|node_modules)(/|$)" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
  },
};
