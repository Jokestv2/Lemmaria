import { defineConfig } from "vitest/config";

/**
 * The webview's vitest project (D2, ADR 0037).
 *
 * `packages/extension` has two disjoint test suites and they must never meet:
 *
 * - `test/` compiles via `tsconfig.test.json` to `out/` and runs under mocha
 *   inside a real VS Code instance (`@vscode/test-cli`). Those files `require`
 *   the `vscode` module, which does not exist outside the extension host, so
 *   vitest collecting even one of them fails the run. Hence the explicit
 *   `exclude` below — an `include` alone is not enough insurance, because a
 *   future default could widen.
 * - `test-webview/` is this project: pure, exported modules under
 *   `src/webview/parts/`, asserted against a real DOM.
 *
 * jsdom rather than a source-level assertion: a `<details open>` and a
 * `textContent`-vs-`innerHTML` choice are DOM facts, and reading the source
 * that builds them asserts the code, not the DOM.
 *
 * `test-bundle/` joins this project at V3 (ADR 0080 §9) rather than getting a
 * project of its own. It is one file, it requires no `vscode`, and it declares
 * `// @vitest-environment node` in its own docblock — so it runs beside the
 * jsdom files without a second config to keep in step.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test-webview/**/*.test.ts", "test-bundle/**/*.test.ts"],
    exclude: [
      "test/**",
      "out/**",
      "dist/**",
      ".vscode-test/**",
      "node_modules/**",
    ],
  },
});
