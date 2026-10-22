/**
 * How a set of workspace-relative paths is ordered for a human to scan.
 *
 * **Its own module, with ZERO imports, and that is the point.** The comparator
 * is shared by the harness's paper probe (`engine/workspace-utils.ts`) and by
 * the extension's `@` menu (`webview/parts/context-paths.ts`), and the webview
 * is bundled for a browser — so it cannot reach the package barrel, which
 * re-exports the model adapters and through them `node:fs`. `model-floor` is
 * the same shape for the same reason: a narrow subpath export carrying one fact
 * the UI needs, rather than a copy of it kept in step by hand.
 */

/**
 * Depth first, then alphabetical — a root `main.tex` beats `styles/demo.tex`.
 *
 * Shallowest-wins is what keeps a vendored template's sample file from beating
 * the project's own root in `discoverPaperEntry`, and it is what puts the files
 * a user is most likely to mean at the top of the `@` menu.
 */
export function byShallowest(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  return depth !== 0 ? depth : a.localeCompare(b);
}
