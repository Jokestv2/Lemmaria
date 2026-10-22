/**
 * The locale seam for rendered surfaces.
 *
 * Lemmaria's UI renders a **single language per display language** (VS Code best
 * practice — one language per locale, never two at once). Two mechanisms carry
 * it, split by where the string lives:
 *
 * - **Contributed `package.json` strings** (command titles, view/container
 *   names, welcome bodies, config descriptions) resolve through VS Code's NLS
 *   bundle — `package.nls.json` (English) and `package.nls.zh-cn.json`
 *   (Chinese) — via `%key%` placeholders. The `Lemmaria:` command prefix is the
 *   product name and stays as-is.
 *
 * - **Runtime-rendered surfaces** (webview strings, tree rows, CodeLens titles,
 *   status-bar text) resolve here against the editor's language, via
 *   `localeLabel` or a `currentLocale()` ternary.
 *
 * This governs how the chrome is *presented*. The three separable rules it
 * serves are invariant 6's, and their mechanism is ADR 0034 — link it, do not
 * restate it here. **MODEL OUTPUT** is a different decision, made once by
 * `resolvedLocale` below rather than inferred by the model (ADR 0031).
 *
 * D4 note: the runtime-rendered chrome's two renderings live in
 * `chrome-strings.ts`, a locale-keyed table this seam indexes. That is a
 * storage shape, not a second seam — `currentLocale()` is still the only place
 * a chrome locale is decided.
 */
import * as vscode from "vscode";

export function currentLocale(): "en" | "zh" {
  return vscode.env.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * ADR 0031: the locale that governs MODEL OUTPUT as well as chrome.
 *
 * `auto` follows the editor (`currentLocale()`); the explicit `lemmaria.language`
 * override exists for the bilingual academic who reads an English UI but
 * writes a Chinese paper. Every harness prompt call site in the extension
 * passes this — never `vscode.env.language` directly — so the language of a
 * session summary or system-prompt instruction is a decision this function
 * makes once, not one the model infers from a bilingual prompt.
 */
export function resolvedLocale(): "en" | "zh" {
  const setting = vscode.workspace
    .getConfiguration("lemmaria")
    .get<string>("language", "auto");
  if (setting === "en" || setting === "zh") return setting;
  return currentLocale();
}

/**
 * An action/venue/model `name` in a GIVEN locale, falling back to its id.
 *
 * Pure and exported so the resolution is assertable: `localeLabel` reads
 * `vscode.env.language`, which is fixed at launch, so a test of it can only
 * ever exercise the one arm the runner happens to be in — which is how D4's
 * first attempt at asserting `actionLabel` ended up unable to fail.
 */
export function pickLocaleLabel(
  name: { en?: string; zh?: string } | undefined,
  id: string,
  locale: "en" | "zh",
): string {
  if (locale === "zh") return name?.zh ?? name?.en ?? id;
  return name?.en ?? name?.zh ?? id;
}

/** An action/venue/model `name` in the editor locale, falling back to its id. */
export function localeLabel(
  name: { en?: string; zh?: string } | undefined,
  id: string,
): string {
  return pickLocaleLabel(name, id, currentLocale());
}
