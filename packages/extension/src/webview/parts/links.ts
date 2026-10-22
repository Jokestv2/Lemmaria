/**
 * What a link may point at — the one rule, in the one place both sides read.
 *
 * **Why this is its own module.** [ADR 0078](../../../../../Lemmaria-design-doc/docs/adr/0078-prior-work-is-located-too.md)
 * D12 asks the host to decide whether a `paper` evidence becomes a link using
 * the markdown renderer's own http(s) test, *"rather than a second pattern
 * living in the host"* — two rules for one judgement agree only until one of
 * them is edited. The named mechanism, exporting it from `parts/markdown.ts`,
 * does not compile: that module builds DOM nodes, the extension host is
 * typechecked with no `dom` lib (`tsconfig.json`), and importing it into
 * `review-ui.ts` pulls `document`, `Node` and `HTMLElement` into a program
 * that has never had them.
 *
 * So the rule moves down instead of sideways. This file holds no DOM, both
 * `tsconfig`s compile it, and the http(s) test still has exactly one home.
 */

/**
 * An http(s) URL, and nothing else.
 *
 * The narrow half of what a link may point at. It is what the HOST tests a
 * paper's URL against: that URL is third-party data — returned by a scholarly
 * index, copied by a model — so the tab is handed an `href` only when the
 * host has already judged the scheme.
 */
export const HTTP_SCHEME = /^https?:\/\//i;

/** `mailto:` is a link in prose, and never a paper's href. */
const MAILTO_SCHEME = /^mailto:/i;

/** What a MARKDOWN link may point at: the http(s) rule, plus `mailto:`. */
export function isSafeLink(url: string): boolean {
  return HTTP_SCHEME.test(url) || MAILTO_SCHEME.test(url);
}
