/**
 * XML escaping for author-written text that Lemmaria embeds in a delimited
 * prompt block.
 *
 * **Why this is a `text/` utility and not a local helper.** It has two callers
 * that must agree exactly — `session/prompt.ts`, which RENDERS the skill
 * catalogue, and `skills/budget.ts`, which COSTS it. When the escaping lived
 * beside only one of them the other measured raw strings, so a description
 * quoting markup could cost six rendered characters per apostrophe and one
 * modelled (found in E1's review). One definition removes the class of bug,
 * not just the instance.
 *
 * It also keeps the character-class regexes below out of any file that carries
 * localized prose, which matters for a reason worth stating: the invariant-6
 * backstop (`scripts/check-mixed-language-strings.mjs`) extracts string
 * literals with a rough regex, and a `/'/` regex literal starts a phantom
 * single-quoted string for it. In a file that also holds Chinese message text
 * the phantom literal spans both languages and the guard reports a false
 * positive. Keeping the escaper here is the cheap half of that; the guard's
 * tokenizer is recorded in `open-questions.md`.
 */

/** `&`, `<`, `>`, `"` and `'` — the five XML predefined entities. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
