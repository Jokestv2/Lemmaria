import type * as Ast from "@unified-latex/unified-latex-types";
import { printRaw } from "@unified-latex/unified-latex-util-print-raw";
import { walkAll } from "./walk.js";

/**
 * Braces opened in `text` and never closed, ignoring `\`-escapes and
 * `%`-comments. A `\{` is ordinary text; an unescaped `%` runs to end of line
 * and may hide a brace, so both have to be skipped or the count is wrong in
 * the direction that MOVES a span's end.
 *
 * **Braces only — `[`/`]` are deliberately NOT counted.** In LaTeX a bracket is
 * an argument delimiter only where a macro's signature says so; everywhere else
 * it is ordinary text, and unmatched ones are common (`$[0,1)$`, a half-open
 * interval, is one bracket and one parenthesis). Counting them here made
 * `\footnote{\textbf{range $[0,1)$}}` record the `\textbf` span as
 * `\textbf{range $[0,1)$}}` — it consumed the FOOTNOTE's closing brace,
 * moving a span's bounds, which is a worse failure than the one X3 fixes.
 * A genuinely pending `]` is already covered by `pendingArgClosers`, which
 * reads the parser's own `closeMark`s instead of guessing from characters.
 *
 * Never goes below zero: a fragment cut mid-construct (the ordinary case for
 * an anchor) can start inside a group, and a negative running total would then
 * mask a genuinely unclosed brace later in the same slice.
 */
function unclosedBraces(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "\\") {
      // `\verb<delim>…<delim>` is literal: a brace or a percent inside it is
      // text, not structure. Without this, `\footnote{\textbf{\verb|{|}}` reads
      // as one brace short and consumes the FOOTNOTE's closer. The delimiter is
      // the first non-letter, non-space character, so `\verbatim` cannot be
      // mistaken for `\verb` with delimiter `a`.
      const verb = /^verb\*?([^A-Za-z\s])/.exec(text.slice(i + 1));
      if (verb) {
        const from = i + 1 + verb[0].length;
        const close = text.indexOf(verb[1] as string, from);
        i = close < 0 ? text.length : close;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "%") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Closers the macro's OWN arguments still owe after the last positioned
 * descendant — the pre-X3 rule, kept verbatim because it is the only part that
 * knows about `[`/`]`.
 *
 * Close marks of args BEFORE the last positioned descendant (e.g. the `]` of an
 * optional arg followed by a positioned mandatory arg) already lie inside the
 * span; counting them would swallow delimiters of ENCLOSING structures. Only
 * closers from the arg holding the last positioned descendant onward are still
 * pending.
 */
function pendingArgClosers(macro: Ast.Macro): number {
  const args = macro.args ?? [];
  let lastPositionedArg = -1;
  args.forEach((arg, i) => {
    walkAll(arg.content, (n) => {
      if (n.position) lastPositionedArg = Math.max(lastPositionedArg, i);
    });
  });
  return lastPositionedArg === -1
    ? 0
    : args.slice(lastPositionedArg).filter((a) => a.closeMark).length;
}

/**
 * Full source span of a macro including its arguments (S2 rule): the macro
 * node's position covers the NAME only; arg content keeps positions, and the
 * args' closing delimiters follow the last positioned descendant.
 *
 * **The closers are consumed in two passes** (X3, ADR 0036). Pass 1 is the
 * pre-X3 rule unchanged — `pendingArgClosers`, the macro's OWN pending
 * `closeMark`s, which is the only part that can tell an argument `]` from a
 * bracket in ordinary text. Pass 2 then keeps consuming `}` while the slice
 * still has an unclosed BRACE, which is what pass 1 alone could not do: it
 * counts only the ROOT macro's args and so misses the closers a NESTED macro
 * still owes. In `\textbf{\emph{x}}` the last positioned descendant is `x`,
 * pass 1 consumes one `}`, and pre-X3 the span stopped there as the unbalanced
 * `\textbf{\emph{x}`.
 *
 * Pass 2 preserves the property pass 1 was hand-maintaining — an enclosing
 * structure's `}` is never swallowed — because a slice that is already balanced
 * has depth 0, so nothing is consumed.
 */
export function macroFullSpan(
  src: string,
  macro: Ast.Macro,
): { start: number; end: number } {
  const pos = macro.position;
  if (!pos) throw new Error(`macro \\${macro.content} has no position`);
  const start = pos.start.offset;
  let end = pos.end.offset;
  walkAll([macro], (n) => {
    if (n.position) end = Math.max(end, n.position.end.offset);
  });
  let i = end;
  const consumeCloser = (allowBracket: boolean): boolean => {
    let j = i;
    while (j < src.length && /\s/.test(src.charAt(j))) j += 1;
    const ch = src.charAt(j);
    if (ch !== "}" && !(allowBracket && ch === "]")) return false;
    i = j + 1;
    end = i;
    return true;
  };
  for (let owed = pendingArgClosers(macro); owed > 0; owed -= 1) {
    if (!consumeCloser(true)) break;
  }
  while (unclosedBraces(src.slice(start, end)) > 0) {
    if (!consumeCloser(false)) break;
  }
  return { start, end };
}

/** Raw text of the arg at `index` (negative counts from the end). */
export function argText(macro: Ast.Macro, index: number): string {
  const args = macro.args ?? [];
  const arg = index < 0 ? args[args.length + index] : args[index];
  if (!arg) return "";
  return printRaw(arg.content);
}
