export default [
  "packages/harness",
  "packages/adapters",
  "packages/cli",
  // D2 (ADR 0037): the webview's jsdom project. Its config narrows collection
  // to `test-webview/` — `packages/extension/test/` is the mocha ext-host
  // suite and must not be collected here.
  "packages/extension",
];
