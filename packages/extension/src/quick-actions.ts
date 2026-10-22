/**
 * The quick actions, in the order the user meets them (D4 / QA-2).
 *
 * **This is the one home for that order.** Before D4 it was restated in five
 * places — `ACTION_COMMAND_BY_ID` (the tiles, via `computeInitState`'s key
 * iteration), `LENS_ORDER` (the CodeLens row), `MVP_FALLBACK` (the webview's
 * first paint), `package.json`'s `editor/context` group numbers, and `GRID`'s
 * tile interleave — and `MVP_FALLBACK` had already drifted from the others in
 * two ways at once, carrying hardcoded English labels that were also clipped
 * (`"Shrink"` where the action is named `Shrink By`).
 *
 * Four of the five now derive from this list. The fifth cannot: `package.json`
 * is static manifest data, read by VS Code before any of our code runs. It is
 * **asserted** against this list instead (`test/codelens.test.ts`), which is
 * what *One home per fact* actually asks for — one source, plus a check that
 * the one unavoidable restatement agrees with it.
 *
 * This module imports no `vscode`, so the webview bundle can import it too.
 * That is the whole reason it is a file of its own rather than an export from
 * `polish-command.ts`.
 */

/** Quick-action ids, in display order (QA-2: Proofread first, Translate last). */
export const QUICK_ACTION_ORDER = [
  "proofread",
  "polish",
  "shrink-to-target",
  "expand",
  "translate",
] as const;

export type QuickActionId = (typeof QUICK_ACTION_ORDER)[number];

/**
 * The VS Code command each id is surfaced as.
 *
 * `fix-compile-error` is deliberately absent — it is an internal Edits action
 * driven by the verify loop, not a user-invoked quick action. `review` has its
 * own command and result surface (`review-ui.ts`).
 */
export const QUICK_ACTION_COMMAND: Record<QuickActionId, string> = {
  proofread: "lemmaria.proofread",
  polish: "lemmaria.polish",
  "shrink-to-target": "lemmaria.shrinkToTarget",
  expand: "lemmaria.expand",
  translate: "lemmaria.translate",
};
