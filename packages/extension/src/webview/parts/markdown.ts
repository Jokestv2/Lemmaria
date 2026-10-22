/**
 * The Markdown subset renderer (D3 / CHAT-2, ADR 0039).
 *
 * `agent_message` was inserted as a raw text node, so every heading, list,
 * emphasis, inline code span and fenced block a model wrote arrived as literal
 * syntax. This renders them — and **nothing else**.
 *
 * Two measured facts shape the whole module:
 *
 * 1. The webview always holds the COMPLETE text, never a fragment:
 *    `session/loop.ts` accumulates `agentItem.text += ev.text` and emits the
 *    whole string on every `item.updated`.
 * 2. The transcript rebuilds its DOM wholesale on every delta
 *    (`replaceChildren` in `main.ts`'s `render()`).
 *
 * So this is a pure function of a growing prefix, with no cross-render state
 * and nothing to undo — which is what makes "degrade to plain text rather than
 * flicker" cheap rather than clever.
 *
 * It cannot import `el()` from `main.ts`: that module exports nothing and
 * calling into it would fire `acquireVsCodeApi()` at module scope. Nodes are
 * built with `document.createElement` + `textContent`, as `script-card.ts` and
 * `removals.ts` already do.
 */
import type { SessionLocale } from "@lemmaria/harness";
import { isSafeLink } from "./links.js";
import { tr } from "./strings.js";

/**
 * A slice of source text, and whether the Markdown passes may look at it.
 *
 * `latex` and `code` are both **opaque**: emit these bytes verbatim and scan
 * them for nothing. They are distinguished only because a code span is also a
 * construct that renders (`<code>`, backticks stripped), while LaTeX is
 * content that renders as itself.
 *
 * `text` is always the source slice, for every kind — which is what makes the
 * round-trip property below hold.
 */
export interface Span {
  readonly kind: "text" | "latex" | "code";
  readonly text: string;
}

/** A blank line: the boundary inline math may not cross. */
const BLANK_LINE = /^\n[ \t]*\n/;
/** The same, searched from an offset. Stateful (`g`): set `lastIndex` first. */
const BLANK_LINE_ANYWHERE = /\n[ \t]*\n/g;

/**
 * Per-scan memos of what is already known to be absent ahead.
 *
 * Both rest on the same fact: `scanOpaque` advances monotonically, so a later
 * opener searches a subset of an earlier one's range — absent once, absent
 * always. Each removes an O(n²) that only degenerate repetition provokes, and
 * degenerate repetition is a real model failure mode on a parser that runs at
 * every streamed delta.
 */
interface ScanMemo {
  /** `\begin{env}` names with no `\end` ahead. */
  readonly unclosedEnv: Set<string>;
  /** Closer strings (`\)`, `\]`, `$$`, `$`) with no occurrence ahead. */
  readonly absentCloser: Set<string>;
}

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));

/** The length of the run of `ch` starting at `i`. */
function runLength(source: string, i: number, ch: string): number {
  let n = 0;
  while (source[i + n] === ch) n++;
  return n;
}

/**
 * `runLength`, but it stops counting at `cap`.
 *
 * Used where only "is this run at least 2 long?" is being asked. Measuring the
 * true length there is what made a degenerate `"*".repeat(n)` quadratic: the
 * whole message is re-parsed on every streamed delta, so an O(n²) pass over it
 * is O(n³) across the stream, and degenerate token repetition is a known model
 * failure mode rather than a purely adversarial input.
 */
function runAtLeast(
  source: string,
  i: number,
  ch: string,
  cap: number,
): number {
  let n = 0;
  while (n < cap && source[i + n] === ch) n++;
  return n;
}

/**
 * The end of a balanced `{…}` / `[…]` group starting at `i`, or `undefined`
 * when it never closes.
 *
 * Nesting is counted rather than matched to the first closer, because
 * `\textbf{\emph{x}}` is exactly the shape X3 found the harness getting wrong.
 */
function groupEnd(
  source: string,
  i: number,
  open: string,
  close: string,
): number | undefined {
  if (source[i] !== open) return undefined;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    // A backslash escapes the next character, so `\}` never closes a group.
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return undefined;
}

/**
 * The end of a `\begin{env}…\end{env}` block, or `undefined` if it is unclosed.
 *
 * `unclosed` is a per-scan memo of environment names already known to have no
 * `\end` anywhere ahead. The scan only ever moves forward, so a name absent
 * once is absent for every later opener — and without the memo a message of
 * repeated unclosed `\begin{}`s costs a scan to end-of-input **each**, which
 * measured 3.1 s at 20 000 openers.
 */
function environmentEnd(
  source: string,
  i: number,
  nameEnd: number,
  memo: ScanMemo,
): number | undefined {
  const braceEnd = groupEnd(source, nameEnd, "{", "}");
  if (braceEnd === undefined) return undefined;
  const env = source.slice(nameEnd + 1, braceEnd - 1);
  if (env === "" || memo.unclosedEnv.has(env)) return undefined;
  const closer = `\\end{${env}}`;
  const at = source.indexOf(closer, braceEnd);
  if (at === -1) {
    memo.unclosedEnv.add(env);
    return undefined;
  }
  return at + closer.length;
}

/**
 * The end of the LaTeX token starting at the backslash at `i`.
 *
 * Every branch here returns a region that includes the backslash, which is the
 * property that makes the divergence from both references structural: there is
 * no code path in this module that removes one. Codex renders pulldown-cmark's
 * decoded text and Pi sets `preserveBackslashEscapes` on its user-message path
 * only, so `\_` becomes `_` in both.
 */
function latexEnd(
  source: string,
  i: number,
  memo: ScanMemo,
): number | undefined {
  const next = source[i + 1];
  if (next === undefined) return undefined; // a trailing lone backslash
  if (next === "(") {
    const at = closerBefore(source, i + 2, "\\)", memo);
    return at === undefined ? undefined : at + 2;
  }
  if (next === "[") {
    const at = closerBefore(source, i + 2, "\\]", memo);
    return at === undefined ? undefined : at + 2;
  }
  // `\%`, `\_`, `\&`, `\#`, `\$`, `\{`, `\\` — typography, and the `$` or `{`
  // it carries must not go on to open something of its own.
  if (!isLetter(next)) return i + 2;

  let j = i + 1;
  while (isLetter(source[j])) j++;
  if (source[j] === "*") j++; // \section*, \cite*
  const name = source.slice(i + 1, j);

  if (name === "begin") {
    const end = environmentEnd(source, i, j, memo);
    // An unclosed environment falls through to the ordinary command path, so
    // `\begin{equation}` mid-stream is opaque on its own and the body it has
    // not finished is still scannable prose. Under-render, never swallow.
    if (end !== undefined) return end;
  }

  // Argument groups, in whatever order they appear: `\sqrt[3]{x}`.
  for (;;) {
    const c = source[j];
    if (c !== "{" && c !== "[") break;
    const end = groupEnd(source, j, c, c === "{" ? "}" : "]");
    if (end === undefined) break;
    j = end;
  }
  return j;
}

/**
 * The first index at or after `from` where `closer` occurs, refusing to cross a
 * blank line.
 *
 * **No mathematics may contain a blank line** — in LaTeX it is an error, not a
 * style choice — so this costs nothing real and it is what stops a stray `$$`
 * or `\[` in prose from swallowing every paragraph break after it. Before this
 * was applied to the multi-character delimiters as well as to single `$`, the
 * asymmetry was invisible; once `renderTextRegion` began suppressing the
 * blank-line split for a covered line, `"The GPU costs $$5.\n\nThe CPU costs
 * $$10."` collapsed a whole document into one paragraph.
 */
function closerBefore(
  source: string,
  from: number,
  closer: string,
  memo: ScanMemo,
): number | undefined {
  if (memo.absentCloser.has(closer)) return undefined;
  // `indexOf` plus one regex probe, both native. Hand-walking this made an
  // existing `\(` / `\[` quadratic 2–10x more expensive on the repaint path,
  // which is the opposite of what adding the guard was for.
  const at = source.indexOf(closer, from);
  if (at === -1) {
    memo.absentCloser.add(closer);
    return undefined;
  }
  BLANK_LINE_ANYWHERE.lastIndex = from;
  const blank = BLANK_LINE_ANYWHERE.exec(source);
  return blank !== null && blank.index < at ? undefined : at;
}

/** The end of the `$…$` / `$$…$$` region starting at `i`, or `undefined`. */
function mathEnd(
  source: string,
  i: number,
  memo: ScanMemo,
): number | undefined {
  if (source[i + 1] === "$") {
    const at = closerBefore(source, i + 2, "$$", memo);
    return at === undefined ? undefined : at + 2;
  }
  const at = closerBefore(source, i + 1, "$", memo);
  return at === undefined ? undefined : at + 1;
}

/** The end of the code span starting at the backtick run at `i`, or `undefined`. */
function codeSpanEnd(source: string, i: number): number | undefined {
  const open = runLength(source, i, "`");
  for (let j = i + open; j < source.length; j++) {
    // An inline code span does not cross a paragraph break, for the same
    // reason inline math does not: otherwise one stray backtick turns the rest
    // of the message into a single `<code>` block, headings and lists included.
    if (source[j] === "\n" && BLANK_LINE.test(source.slice(j)))
      return undefined;
    if (source[j] !== "`") continue;
    const run = runLength(source, j, "`");
    // CommonMark's rule: a code span closes only on a run of equal length, so
    // ``a ` b`` is one span containing a backtick.
    if (run === open) return j + run;
    j += run - 1;
  }
  return undefined;
}

/**
 * The end of whatever opaque region starts at `i`, or `undefined` if none does.
 *
 * There is deliberately NO precedence table between LaTeX and code spans: the
 * left-to-right scan in `scanOpaque` decides, so `` `$x$` `` is a code span and
 * `` $`x`$ `` is math. One rule instead of two, and a directly testable one.
 */
function opaqueEnd(
  source: string,
  i: number,
  memo: ScanMemo,
): { end: number; kind: "latex" | "code" } | undefined {
  const c = source[i];
  if (c === "`") {
    const end = codeSpanEnd(source, i);
    return end === undefined ? undefined : { end, kind: "code" };
  }
  if (c === "$") {
    const end = mathEnd(source, i, memo);
    return end === undefined ? undefined : { end, kind: "latex" };
  }
  if (c === "\\") {
    const end = latexEnd(source, i, memo);
    return end === undefined ? undefined : { end, kind: "latex" };
  }
  return undefined;
}

/**
 * Split `source` into the regions the Markdown passes may scan and the regions
 * they may not.
 *
 * **The safety property of the whole design is that this is loss-free**:
 * `scanOpaque(s).map(x => x.text).join("") === s` for every input. An opaque
 * span is emitted verbatim as a Text node, so a false positive — `"costs $5
 * and $10"`, where `$5 and $` looks precisely like inline math — costs the
 * formatting inside that span and never a character on screen. The scanner can
 * under-render; it cannot corrupt.
 */
export function scanOpaque(source: string): Span[] {
  const spans: Span[] = [];
  const memo: ScanMemo = {
    unclosedEnv: new Set(),
    absentCloser: new Set(),
  };
  let textStart = 0;
  let i = 0;
  while (i < source.length) {
    const hit = opaqueEnd(source, i, memo);
    if (hit === undefined || hit.end <= i) {
      // A backtick run that does not close is skipped WHOLE, which is both
      // CommonMark's rule (a partial run is not an opener — the backtick string
      // is literal and scanning resumes after it) and what keeps this loop
      // linear: retrying at each character of a long run re-measures the run
      // each time, which is quadratic in the run's length.
      i += source[i] === "`" ? runLength(source, i, "`") : 1;
      continue;
    }
    if (i > textStart) {
      spans.push({ kind: "text", text: source.slice(textStart, i) });
    }
    spans.push({ kind: hit.kind, text: source.slice(i, hit.end) });
    i = hit.end;
    textStart = hit.end;
  }
  if (source.length > textStart) {
    spans.push({ kind: "text", text: source.slice(textStart) });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// The inline pass
// ---------------------------------------------------------------------------

/**
 * The only URL schemes a rendered link may carry.
 *
 * Model output is untrusted input to a DOM. `enableCommandUris` is not set on
 * the webview, so VS Code already refuses `command:` — but deny-by-default is
 * the posture invariant 2 takes everywhere else, and a renderer that would
 * emit `javascript:` if the host permitted it is one option flip from a
 * defect. Anything not on this list renders as literal text.
 */
/**
 * A length-preserving mask in which every opaque region is `\0`.
 *
 * Adapted from Pi, whose `marked` masks code spans and links out of the source
 * before the emphasis scanner runs (`blockSkip`). Masking rather than
 * per-span scanning is what lets emphasis span an opaque region — the opening
 * `**` and the closing `**` of ``**a `code` b**`` sit in different text spans,
 * and scanning each in isolation would drop the emphasis. Because the mask has
 * the same length as the source, every index found in it slices the original.
 */
interface Masked {
  readonly source: string;
  readonly masked: string;
  /** The opaque span covering each index, for the indices one covers. */
  readonly cover: readonly (Span | undefined)[];
  /**
   * For each `[`, the index of the `]` that balances it, or -1.
   *
   * Computed once with a stack, because doing it per bracket is quadratic on
   * the shape that provokes it: `"[".repeat(n) + "]".repeat(n)` made every
   * opener re-scan to the end of the string looking for its partner.
   */
  readonly bracket: Int32Array;
  /** The last `)` in the whole string, so a hopeless `(` search is skipped. */
  readonly lastParen: number;
}

function matchBrackets(masked: string): Int32Array {
  const match = new Int32Array(masked.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "[") open.push(i);
    else if (masked[i] === "]") {
      const at = open.pop();
      if (at !== undefined) match[at] = i;
    }
  }
  return match;
}

function mask(source: string): Masked {
  const cover = new Array<Span | undefined>(source.length);
  let masked = "";
  let at = 0;
  for (const span of scanOpaque(source)) {
    if (span.kind === "text") {
      masked += span.text;
    } else {
      masked += "\0".repeat(span.text.length);
      for (let k = 0; k < span.text.length; k++) cover[at + k] = span;
    }
    at += span.text.length;
  }
  return {
    source,
    masked,
    cover,
    bracket: matchBrackets(masked),
    lastParen: masked.lastIndexOf(")"),
  };
}

/** The rendered form of one opaque span. */
function opaqueNode(span: Span): Node {
  if (span.kind !== "code") return document.createTextNode(span.text);
  const run = runLength(span.text, 0, "`");
  let body = span.text.slice(run, span.text.length - run);
  // CommonMark: one space is stripped from each end when both are present and
  // the content is not all spaces, so `` ` `` renders a lone backtick.
  if (
    body.length > 2 &&
    body.startsWith(" ") &&
    body.endsWith(" ") &&
    body.trim() !== ""
  ) {
    body = body.slice(1, -1);
  }
  const code = document.createElement("code");
  code.className = "lm-md__code";
  code.textContent = body;
  return code;
}

/**
 * The index at which an emphasis run of `want` closes, or `undefined`.
 *
 * A `*` closer must be a run of exactly one and a `**` closer a run of at least
 * two, so `*a **b** c*` does not close its `em` on the first `*` of the inner
 * `**` — which is the mis-render, not merely under-render, that a naive
 * `indexOf` produces.
 */
function emphasisClose(
  m: Masked,
  from: number,
  to: number,
  want: 1 | 2,
): number | undefined {
  for (let j = from; j < to; j++) {
    if (m.masked[j] !== "*") continue;
    // Ask the cheap question first. Measuring the true length before deciding
    // is what kept `"*".repeat(n)` quadratic even after the call site was
    // capped: a 20 000-long run answers "is it at least 2?" in two reads and
    // "how long is it?" in twenty thousand.
    const atLeast = runAtLeast(m.masked, j, "*", 2);
    if (want === 2 ? atLeast >= 2 : atLeast === 1) return j;
    // Only now is the full length needed, and paying for it is amortised: the
    // cost is the run's length and `j` advances by exactly that much.
    j += runLength(m.masked, j, "*") - 1;
  }
  return undefined;
}

interface ParsedLink {
  readonly textFrom: number;
  readonly textTo: number;
  readonly url: string;
  readonly end: number;
}

/** `[text](url)` starting at the `[` at `i`, or `undefined` if it is not one. */
function parseLink(m: Masked, i: number, to: number): ParsedLink | undefined {
  const close = m.bracket[i] ?? -1;
  if (close < 0 || close >= to) return undefined;
  if (m.masked[close + 1] !== "(") return undefined;
  // No `)` anywhere ahead means none for this link or any later one either.
  if (m.lastParen < close + 2) return undefined;
  const paren = m.masked.indexOf(")", close + 2);
  if (paren === -1 || paren >= to) return undefined;
  return {
    textFrom: i + 1,
    textTo: close,
    url: m.source.slice(close + 2, paren),
    end: paren + 1,
  };
}

/**
 * How deeply emphasis and links may nest before the renderer gives up and emits
 * the rest as text.
 *
 * `emit` recurses once per nesting level, and its input is model output on the
 * webview's repaint path. `"[".repeat(k) + "a" + "](https://x)".repeat(k)`
 * overflows the stack at k≈10 000 — and because `renderItem` runs INSIDE
 * `render()` before `replaceChildren`, a throw would leave the panel frozen on
 * the previous frame for every subsequent delta, not just the offending one.
 * Falling back to literal text past the cap is under-rendering, which is the
 * direction this renderer is allowed to fail in.
 */
const MAX_NESTING = 24;

function emit(m: Masked, from: number, to: number, depth = 0): Node[] {
  const out: Node[] = [];
  let textStart = from;
  let i = from;

  if (depth > MAX_NESTING) {
    return from < to ? [document.createTextNode(m.source.slice(from, to))] : [];
  }

  const flush = (end: number): void => {
    if (end > textStart) {
      out.push(document.createTextNode(m.source.slice(textStart, end)));
    }
  };

  // No `[` at or after the last `]` can open a link, so a run of unmatched
  // brackets costs one scan rather than one per bracket. Without this,
  // `"[".repeat(n)` re-scans to `to` for every one of them.
  const lastClose = to > 0 ? m.masked.lastIndexOf("]", to - 1) : -1;

  while (i < to) {
    const c = m.masked[i];

    if (c === "\0") {
      const span = m.cover[i];
      if (span === undefined) {
        i++;
        continue;
      }
      flush(i);
      out.push(opaqueNode(span));
      i += span.text.length;
      textStart = i;
      continue;
    }

    // An image renders as literal text — the CSP is `default-src 'none'`, so an
    // <img> would be a guaranteed broken icon. Skipping the whole construct
    // (rather than only the `!`) is what stops the `[` from becoming a link.
    if (c === "!" && m.masked[i + 1] === "[" && lastClose > i + 1) {
      const link = parseLink(m, i + 1, to);
      i = link === undefined ? i + 1 : link.end;
      continue;
    }

    if (c === "[" && lastClose > i) {
      const link = parseLink(m, i, to);
      if (link !== undefined && isSafeLink(link.url)) {
        flush(i);
        const a = document.createElement("a");
        a.className = "lm-md__link";
        a.setAttribute("href", link.url);
        for (const node of emit(m, link.textFrom, link.textTo, depth + 1)) {
          a.append(node);
        }
        out.push(a);
        i = link.end;
        textStart = i;
        continue;
      }
      // A refused scheme falls through as text, whole: advancing past the
      // construct keeps its own `[` from being retried as a fresh link.
      i = link === undefined ? i + 1 : link.end;
      continue;
    }

    if (c === "*") {
      // Only "one, or two-or-more" is being asked, so the run is measured no
      // further than that — see `runAtLeast`.
      const want = runAtLeast(m.masked, i, "*", 2) >= 2 ? 2 : 1;
      const close = emphasisClose(m, i + want, to, want);
      // Empty emphasis is not a construct: `****` is four literal asterisks,
      // not two nested empty ones. Skipping it also stops a degenerate run
      // from building thousands of empty elements, which is a real cost even
      // once the scan itself is linear.
      if (close !== undefined && close > i + want) {
        flush(i);
        const box = document.createElement(want === 2 ? "strong" : "em");
        for (const node of emit(m, i + want, close, depth + 1))
          box.append(node);
        out.push(box);
        i = close + want;
        textStart = i;
        continue;
      }
      i += want;
      continue;
    }

    i++;
  }

  flush(to);
  return out;
}

/**
 * Render one run of inline Markdown to DOM nodes.
 *
 * Every construct renders only when its closer is present (D3-2): an unclosed
 * `**`, backtick or `[t](` is the literal characters, because nothing arriving
 * later can be undone once it has been rendered as something else.
 */
export function inlineNodes(source: string): Node[] {
  return emit(mask(source), 0, source.length);
}

// ---------------------------------------------------------------------------
// The block pass
// ---------------------------------------------------------------------------

/** ATX only, one to six, and the space is required. Setext headings are out. */
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const UNORDERED = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE_OPEN = /^```(.*)$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const BLANK = /^[ \t]*$/;
/**
 * A LaTeX block opener alone on its line: `$$`, `\[`, `\begin{env}`.
 *
 * Only matched when `scanOpaque` did NOT already cover the line, in which case
 * the construct is unterminated. Requiring it to be alone on the line is what
 * keeps ordinary prose out — `"the GPU costs $$5 an hour"` is not an opener.
 */
const BLOCK_OPENER = /^[ \t]*(?:\$\$|\\\[|\\begin\{[^}\n]*\})[ \t]*$/;

/**
 * A delimiter row's alphabet (X4, ADR 0044).
 *
 * Deliberately a character class rather than a full grammar: it is the cheap
 * gate that runs on every line, and it costs nothing to be generous here
 * because `alignments()` re-checks each cell properly. None of the four
 * characters can open an opaque region, which is why a delimiter row is the one
 * row that may be split against itself instead of against a mask.
 */
const DELIMITER_LINE = /^[ \t|:-]+$/;
/** One delimiter cell, with the colons that set the column's alignment. */
const DELIMITER_CELL = /^(:?)-+(:?)$/;
/**
 * A quoted line. Up to three leading spaces, the marker, and ONE optional space
 * after it — a second space is content, or a nested indented list inside a quote
 * loses its indentation.
 */
const QUOTE_LINE = /^[ \t]{0,3}>[ \t]?(.*)$/;

/**
 * How deep quotes may nest before the markers are left on screen as text.
 *
 * The same posture as `MAX_NESTING`: degrade to literal characters rather than
 * recurse without bound, because this runs inside `render()` on the repaint
 * path and a throw would freeze the panel on the previous frame.
 */
const MAX_QUOTE_DEPTH = 8;

/**
 * The most cells one table may build before it stops being a table.
 *
 * Columns and rows are both unbounded and padding builds a cell for every
 * product, so the cost is quadratic in two independent directions: a **4 KB**
 * message of 500 columns by 500 one-cell rows measured 250,500 cells and 3.4 s
 * — on a parser that re-runs inside `render()` at every streamed delta, where
 * ADR 0039's own guard exists because an O(n²) pass is O(n³) across a stream.
 *
 * Past the budget the lines are left as prose, which keeps every character on
 * screen. 4096 is a 4-column table of 1024 rows, or a 64-column one of 63:
 * past either, a transcript bubble is not the surface for the data.
 */
const MAX_TABLE_CELLS = 4096;

/** Where a table column's text sits, from the delimiter row's colons. */
type Align = "left" | "center" | "right";

interface ListItem {
  readonly indent: number;
  readonly ordered: boolean;
  /** The number the author wrote, so `3.` does not render as `1.`. */
  readonly start: number;
  readonly text: string;
}

/** One source line, and whether the block pass is allowed to classify it. */
interface Line {
  readonly text: string;
  /**
   * True when this line begins inside a MULTI-LINE opaque span — a `$$…$$`
   * block, a `\begin{env}…\end{env}` body.
   *
   * Without this the block pass would classify lines that `scanOpaque` had
   * already claimed, and `$$\n- a_1\n$$` would render as a paragraph, a list
   * and another paragraph with the `- ` **deleted**. That is corruption rather
   * than under-rendering — the one failure mode ADR 0039 §3 says is
   * structurally impossible — and it was possible because the scanner runs
   * per-paragraph, i.e. one layer BELOW where the damage was done.
   */
  readonly protectedSpan: boolean;
  /**
   * True when this line is followed by a newline in the source — i.e. it is not
   * the growing tail of the stream.
   *
   * Only ONE construct reads it, and it is the reason the field exists (X4-2,
   * [ADR 0044](../../../../../Lemmaria-design-doc/docs/adr/0044-tables-and-blockquotes-in-the-transcript.md)):
   * a table's marker is its **delimiter row**, on the second line, and unlike a
   * `#` or a `- ` at a line start, something arriving later can still change
   * what that line means — `|---|---|-` is a three-cell delimiter row and
   * `|---|---|- x` is not one. So ADR 0039 §2's end-of-line-or-end-of-text
   * relaxation does not transfer, and the table waits for the newline.
   */
  readonly terminated: boolean;
}

/** Tab-aware, because a model indenting with tabs is not a different list. */
const indentWidth = (lead: string): number => lead.replace(/\t/g, "  ").length;

function fill(parent: HTMLElement, nodes: Node[]): HTMLElement {
  for (const node of nodes) parent.append(node);
  return parent;
}

/**
 * One list level, consuming every item at `base` indentation and recursing on
 * the runs that sit deeper.
 *
 * A deeper run attaches to the `<li>` above it, which is what makes the
 * nesting a tree rather than a flat sequence of sibling lists.
 */
function renderList(
  items: readonly ListItem[],
  from: number,
  base: number,
): [HTMLElement, number] {
  const first = items[from];
  const ordered = first?.ordered === true;
  const list = document.createElement(ordered ? "ol" : "ul");
  list.className = "lm-md__list";
  // A list that does not begin at 1 must SAY so, or the number the author
  // wrote is replaced by a different one — the marker is consumed either way,
  // so without this `3. third` renders as "1. third" and `2024. The year we
  // started` loses the year outright.
  if (ordered && first !== undefined && first.start !== 1) {
    list.setAttribute("start", String(first.start));
  }
  let i = from;
  let last: HTMLElement | undefined;
  while (i < items.length) {
    const item = items[i];
    if (item === undefined || item.indent < base) break;
    if (item.indent > base) {
      const [nested, next] = renderList(items, i, item.indent);
      (last ?? list).append(nested);
      i = next;
      continue;
    }
    // A change of marker kind at the same level starts a new list rather than
    // silently adopting the first item's: `- a` then `1. b` is two lists, and
    // folding them into one would render the `1.` as a bullet.
    if (item.ordered !== ordered) break;
    const li = fill(document.createElement("li"), inlineNodes(item.text));
    list.append(li);
    last = li;
    i++;
  }
  return [list, i];
}

function paragraph(lines: readonly string[]): HTMLElement {
  const p = document.createElement("p");
  p.className = "lm-md__p";
  return fill(p, inlineNodes(lines.join("\n")));
}

/**
 * One line with every opaque region blanked to `\0`, at the same length.
 *
 * NOT `mask(line).masked`, which was the first shape here: that also builds a
 * `cover` array, an `Int32Array` of bracket matches and a `lastIndexOf(")")`,
 * and the row splitter throws all three away — on **every body row**, at every
 * streamed delta. Same definition of "opaque", one allocation.
 */
function maskOnly(source: string): string {
  let out = "";
  for (const span of scanOpaque(source)) {
    out += span.kind === "text" ? span.text : "\0".repeat(span.text.length);
  }
  return out;
}

/**
 * `[from, to)` with whitespace trimmed off both ends — read from the MASK.
 *
 * Reading the mask rather than the line is not a detail: `\ ` is a LaTeX forced
 * space, `scanOpaque` marks it opaque, and its second character IS the token.
 * Trimming the raw line turned `| x\ |` into `x\` — a character deleted from
 * the screen, which is the one thing ADR 0039 §3 says cannot happen. In the
 * mask that space is `\0`, so it is not whitespace and does not trim.
 */
function trimBounds(
  masked: string,
  from: number,
  to: number,
): [number, number] {
  let a = from;
  let b = to;
  while (a < b && (masked[a] === " " || masked[a] === "\t")) a++;
  while (b > a && (masked[b - 1] === " " || masked[b - 1] === "\t")) b--;
  return [a, b];
}

/**
 * GFM's row split — over the MASK, never over the raw text (X4-3).
 *
 * This extends [ADR 0039](../../../../../Lemmaria-design-doc/docs/adr/0039-markdown-subset-in-the-transcript.md)
 * §3 from *"the Markdown passes may not scan an opaque region"* to *"an opaque
 * region carries no structure either"*, and it is the one place this milestone
 * makes a trade rather than an addition.
 *
 * **What it buys:** `| $|x|$ | the norm |` keeps its mathematics. A raw split
 * shreds `$|x|$` across three cells — real mathematics destroyed on screen, in
 * a product whose users type `$x_1$`, which is the single failure §3 exists to
 * make structurally impossible.
 *
 * **What it costs:** a false-positive math span merges two cells. In
 * `| costs $5 | and $10 | ok |` the scanner reads `$5 | and $` as inline math,
 * so the row is two cells rather than three. Every character is still on
 * screen, in the wrong cell — under-rendering, the direction this renderer is
 * allowed to fail in, and the same false positive §3 already documents for
 * ordinary prose.
 *
 * **It also means no escape is decoded, for free.** GFM's `\|` is already an
 * opaque LaTeX token (a backslash plus a single non-letter), so it neither
 * splits a cell nor loses its backslash, and §3's *"no Markdown backslash
 * escape is ever decoded"* survives with no special case written for it.
 *
 * **`limit` is where this renderer parts company with GFM, deliberately.** GFM
 * *truncates* a row that has more cells than the header, and the first draft of
 * X4 adopted that as "GFM's own rule". It is wrong here and the review caught
 * it: `| A | B |` over `| 1 | 2 | 3 |` rendered `AB12` and the `3` was **gone
 * from the screen** — not under-rendered, deleted — and a Chinese row lost
 * `备注` the same way, which is invariant 6 rule 1 broken. GFM is a document
 * formatter and may discard; this renderer may not. So the last cell a `limit`
 * allows takes the **raw remainder of the line, separators and all**: the row
 * stays rectangular AND every character stays on screen.
 */
function splitRow(line: string, masked: string, limit?: number): string[] {
  let [from, to] = trimBounds(masked, 0, line.length);
  // One leading and one trailing pipe are chrome; GFM makes both optional.
  if (masked[from] === "|") from++;
  if (to > from && masked[to - 1] === "|") to--;
  const cells: string[] = [];
  const push = (a: number, b: number): void => {
    const [x, y] = trimBounds(masked, a, b);
    cells.push(line.slice(x, y));
  };
  let start = from;
  for (let i = from; i < to; i++) {
    if (masked[i] !== "|") continue;
    if (limit !== undefined && cells.length === limit - 1) break;
    push(start, i);
    start = i + 1;
  }
  push(start, to);
  return cells;
}

/**
 * The column alignments a delimiter row declares, or `undefined` if the line is
 * not a delimiter row at all.
 *
 * A pipe is REQUIRED, and that requirement is load-bearing rather than
 * pedantry: without it a bare `---` under a prose line becomes a one-column
 * table, which would silently reopen ADR 0039's deliberate exclusion of setext
 * headings through the back door.
 *
 * The colons are honoured rather than dropped, on this module's own precedent —
 * a list that does not begin at 1 carries `start`, because a marker that is
 * consumed and then ignored deletes something the author wrote.
 */
function alignments(line: string): (Align | undefined)[] | undefined {
  if (!DELIMITER_LINE.test(line) || !line.includes("|") || !line.includes("-"))
    return undefined;
  // The alphabet `DELIMITER_LINE` allows contains no opaque opener, so the line
  // is its own mask.
  const out: (Align | undefined)[] = [];
  for (const cell of splitRow(line, line)) {
    const m = DELIMITER_CELL.exec(cell);
    if (m === null) return undefined;
    const left = m[1] === ":";
    const right = m[2] === ":";
    out.push(
      left && right ? "center" : right ? "right" : left ? "left" : undefined,
    );
  }
  return out;
}

/** One `th` or `td`, with the column's alignment as a CLASS, never a style. */
function cellBox(
  tag: "th" | "td",
  text: string,
  align: Align | undefined,
): HTMLElement {
  const box = document.createElement(tag);
  // Never an inline `style`: the webview CSP carries no `'unsafe-inline'`, so
  // one would be dropped by the browser and the alignment lost silently.
  box.className =
    align === undefined ? "lm-md__cell" : `lm-md__cell lm-md__cell--${align}`;
  return fill(box, inlineNodes(text));
}

/**
 * One row, padded to the header's column count.
 *
 * Padding only ever ADDS empty cells. A row with more cells than the header
 * cannot reach here, because `splitRow`'s `limit` has already folded its
 * surplus into the last cell rather than dropping it.
 */
function tableRow(
  cells: readonly string[],
  count: number,
  tag: "th" | "td",
  aligns: readonly (Align | undefined)[],
): HTMLElement {
  const tr = document.createElement("tr");
  for (let i = 0; i < count; i++) {
    tr.append(cellBox(tag, cells[i] ?? "", aligns[i]));
  }
  return tr;
}

/**
 * A table, inside a wrapper that can scroll sideways (X4-7).
 *
 * The sidebar is ~366px and a four-column table is not. `.lm-md__pre`'s
 * `max-width: 100%; overflow: auto` is the same stylesheet's existing answer to
 * exactly this, and the wrapper is what gives the table a scroll container of
 * its own instead of widening the bubble.
 */
function renderTable(
  header: readonly string[],
  aligns: readonly (Align | undefined)[],
  bodies: readonly (readonly string[])[],
): HTMLElement {
  const count = header.length;
  const table = document.createElement("table");
  table.className = "lm-md__table";
  const head = document.createElement("thead");
  head.append(tableRow(header, count, "th", aligns));
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of bodies) body.append(tableRow(row, count, "td", aligns));
  table.append(body);
  const wrap = document.createElement("div");
  wrap.className = "lm-md__tablewrap";
  wrap.append(table);
  return wrap;
}

/**
 * A blockquote, whose stripped content is rendered as a REGION (X4-6).
 *
 * Recursing into `renderTextRegion` rather than into a line classifier is what
 * lets a quote hold paragraphs, headings, lists, tables and further quotes for
 * one call's worth of code. `tailOpen` is inherited from the run's last line:
 * the quoted content is still growing exactly when the outer line was.
 */
function quoteBox(text: string, tailOpen: boolean, depth: number): HTMLElement {
  const box = document.createElement("blockquote");
  box.className = "lm-md__quote";
  const kids: Node[] = [];
  renderTextRegion(text, kids, tailOpen, depth + 1);
  return fill(box, kids);
}

/** A run of lines with no blank line in it, classified line by line. */
function renderGroup(lines: readonly Line[], out: Node[], depth: number): void {
  let prose: string[] = [];
  let items: ListItem[] = [];
  /**
   * The first index at which a table may still start.
   *
   * A run this pass has already scanned and rejected on the cell budget is not
   * a table, and neither is any header candidate inside it — so re-deriving
   * that line by line is pure quadratic. Same shape and same justification as
   * `ScanMemo` above: the scan only ever moves forward, so a run settled once
   * is settled for every later candidate. Without it, 10,000 lines of
   * `| a | b |` / `|---|---|` re-scanned the whole tail at every second line —
   * 3.9 s for 100 KB, on the repaint path.
   */
  let noTableBefore = 0;

  const flushProse = (): void => {
    if (prose.length > 0) out.push(paragraph(prose));
    prose = [];
  };
  const flushItems = (): void => {
    let i = 0;
    while (i < items.length) {
      const [list, next] = renderList(items, i, items[i]?.indent ?? 0);
      out.push(list);
      i = next > i ? next : i + 1;
    }
    items = [];
  };

  for (let n = 0; n < lines.length; n++) {
    const entry = lines[n];
    if (entry === undefined) continue;
    const { text: line, protectedSpan } = entry;
    if (protectedSpan) {
      // Inside a multi-line opaque span: no classification, ever. The prose
      // run keeps these lines contiguous, so the span reassembles intact when
      // the paragraph reaches `inlineNodes`.
      flushItems();
      prose.push(line);
      continue;
    }

    // A BLOCKQUOTE (X4-6): a run of lines each carrying the marker. No lazy
    // continuation — a line without one ends the quote. GFM would absorb it,
    // and absorbing it means guessing; guessing wrong pulls a paragraph into a
    // quote box, which is a mis-render rather than an under-render.
    //
    // Checked BEFORE the table, so `> a | b` over `> |---|---|` is a quote
    // containing a table rather than a table whose first cell is `"> a"`.
    if (depth < MAX_QUOTE_DEPTH && QUOTE_LINE.test(line)) {
      const quoted: string[] = [];
      let m = n;
      let tailOpen = false;
      while (m < lines.length) {
        const l = lines[m];
        if (l === undefined || l.protectedSpan) break;
        const q = QUOTE_LINE.exec(l.text);
        if (q === null) break;
        quoted.push(q[1] ?? "");
        tailOpen = !l.terminated;
        m++;
      }
      // A run of bare markers quotes nothing, and an empty `<blockquote>` is a
      // bordered rectangle with nothing in it. Leave those lines as text —
      // and consume the WHOLE run while doing it. Falling through one line at
      // a time re-scanned the rest of the run at every line, which measured
      // 5.6 s at the 20,000 characters this module's own hang guard uses. The
      // output is byte-identical either way: a line whose quoted content is
      // blank is `spaces > spaces`, which no other classifier can claim.
      if (quoted.some((q) => !BLANK.test(q))) {
        flushProse();
        flushItems();
        out.push(quoteBox(quoted.join("\n"), tailOpen, depth));
        n = m - 1;
        continue;
      }
      flushItems();
      for (let k = n; k < m; k++) prose.push(lines[k]?.text ?? "");
      n = m - 1;
      continue;
    }

    // A TABLE (X4-2). This line is the header only if the NEXT one is a
    // terminated delimiter row with the same cell count. `line.includes("|")`
    // first: it is the cheap gate that keeps every ordinary prose line out
    // before any masking happens.
    const next = lines[n + 1];
    if (
      n >= noTableBefore &&
      next?.terminated === true &&
      !next.protectedSpan &&
      line.includes("|")
    ) {
      const aligns = alignments(next.text);
      const masked = aligns === undefined ? "" : maskOnly(line);
      // A header row needs a pipe of its OWN, unmasked — otherwise a one-cell
      // prose line above a `|---|` would pass the count check.
      if (aligns !== undefined && masked.includes("|")) {
        const header = splitRow(line, masked);
        if (header.length === aligns.length) {
          // The body run, found before anything is built. A row must carry an
          // unmasked pipe of its own: without that rule the table swallows
          // whatever follows it, so `# Head` on the next line became a cell
          // with its `#` on screen — the literal-syntax defect D3 exists to
          // remove, reappearing. GFM breaks a table at the next block
          // structure for the same reason.
          const run: { text: string; masked: string }[] = [];
          let m = n + 2;
          while (m < lines.length) {
            const row = lines[m];
            // A protected line ends the table rather than becoming a row:
            // calling one a row IS classifying it, which ADR 0039 §3's
            // block-pass rule forbids outright.
            if (row === undefined || row.protectedSpan) break;
            if (!row.text.includes("|")) break;
            const rowMask = maskOnly(row.text);
            if (!rowMask.includes("|")) break;
            run.push({ text: row.text, masked: rowMask });
            m++;
          }
          // Two unbounded quantities multiply here — columns and rows — and
          // padding builds a cell for every product. A 4 KB message of 500
          // columns by 500 one-cell rows measured 250,500 cells and 3.4 s, on
          // a parser that re-runs at every streamed delta. Past the budget
          // this is not a table: the lines stay prose, every character on
          // screen, which is what this module does at `MAX_NESTING` and
          // `MAX_QUOTE_DEPTH` too.
          if (header.length * (run.length + 1) <= MAX_TABLE_CELLS) {
            flushProse();
            flushItems();
            out.push(
              renderTable(
                header,
                aligns,
                run.map((r) => splitRow(r.text, r.masked, header.length)),
              ),
            );
            n = m - 1;
            continue;
          }
          // Over budget. The lines fall through and render as prose, one at a
          // time and classified normally — but no line this run covered may be
          // re-examined as a header candidate, or the scan above runs again at
          // every second line.
          noTableBefore = m;
        }
      }
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushProse();
      flushItems();
      const level = heading[1]?.length ?? 1;
      const box = document.createElement(`h${level}`);
      box.className = "lm-md__h";
      out.push(fill(box, inlineNodes(heading[2] ?? "")));
      continue;
    }
    const unordered = UNORDERED.exec(line);
    const ordered = unordered === null ? ORDERED.exec(line) : null;
    const item = unordered ?? ordered;
    if (item !== null) {
      flushProse();
      items.push({
        indent: indentWidth(item[1] ?? ""),
        ordered: unordered === null,
        start: ordered === null ? 1 : Number(ordered[2] ?? "1"),
        text: (unordered === null ? item[3] : item[2]) ?? "",
      });
      continue;
    }
    flushItems();
    prose.push(line);
  }
  flushProse();
  flushItems();
}

/**
 * Which offsets of `text` lie inside a MULTI-LINE opaque span.
 *
 * This is the bridge between the two passes. `scanOpaque` already marks a
 * `$$…$$` block or a `\begin{env}…\end{env}` body as one region, but the block
 * pass runs FIRST and used to shred it into lines before any scanner saw it.
 * Single-line spans need no protection: they never reach a line classifier as
 * anything but the middle of a line.
 */
function multilineOpaque(text: string): Uint8Array {
  const covered = new Uint8Array(text.length);
  let at = 0;
  for (const span of scanOpaque(text)) {
    if (span.kind !== "text" && span.text.includes("\n")) {
      covered.fill(1, at, at + span.text.length);
    }
    at += span.text.length;
  }
  return covered;
}

/**
 * Everything between two fenced blocks: blank-line grouping, then per-line
 * classification — with the lines a multi-line opaque span owns exempt from
 * both, including from the blank-line split (a `$$…$$` block may contain one).
 *
 * `tailOpen` says whether this region's LAST line is still growing, which is
 * true only for the region that ends the source. `depth` is the blockquote
 * nesting level — a quote renders its own content by calling back in here.
 */
function renderTextRegion(
  text: string,
  out: Node[],
  tailOpen: boolean,
  depth: number,
): void {
  if (text === "") return;
  const covered = multilineOpaque(text);
  const lines = text.split("\n");
  let group: Line[] = [];
  let at = 0;
  const flush = (): void => {
    if (group.length > 0) renderGroup(group, out, depth);
    group = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    // Coverage is read at the first NON-BLANK column as well as the first.
    // A span begins at its delimiter, so on an indented opener — display math
    // under a numbered step, a routine academic shape — `covered[at]` lands on
    // the indent, which no span covers, and the block would be treated as
    // unterminated even though it closes perfectly well.
    const lead = line.length - line.trimStart().length;
    const protectedSpan = covered[at] === 1 || covered[at + lead] === 1;
    // A block-level LaTeX opener alone on its line that `scanOpaque` did NOT
    // cover is an opener whose closer has not arrived — the display-math and
    // environment analogue of an unclosed fence, and overwhelmingly the
    // streaming case, since the webview re-renders at every delta. The rest of
    // the region degrades to verbatim text, exactly as the fence does.
    //
    // This is not "guessing that a closer is coming": it is declining to
    // classify. Classifying is what deleted the `- ` from `$$\n- a_1`, and a
    // marker deleted from the screen is corruption in the one direction ADR
    // 0039 §3 says is impossible — whereas leaving the line as text merely
    // under-renders, which is the direction this renderer is allowed to fail.
    if (!protectedSpan && BLOCK_OPENER.test(line)) {
      flush();
      out.push(verbatimParagraph(lines.slice(n).join("\n")));
      return;
    }
    at += line.length + 1;
    if (BLANK.test(line) && !protectedSpan) {
      flush();
      continue;
    }
    group.push({
      text: line,
      protectedSpan,
      terminated: !(tailOpen && n === lines.length - 1),
    });
  }
  flush();
}

/** The literal, unformatted rendering an incomplete construct degrades to. */
function verbatimParagraph(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "lm-md__p";
  p.textContent = text;
  return p;
}

/**
 * What a code block needs in order to offer a Copy button.
 *
 * Optional throughout: `blocks(source)` with no chrome is the pure content
 * renderer, and a Copy button with nothing wired to it would be a lie.
 */
export interface CodeBlockChrome {
  readonly locale: SessionLocale;
  /**
   * Called with the block's exact text. The HOST writes the clipboard, through
   * `vscode.env.clipboard` — `navigator.clipboard` inside a webview is gated on
   * a permission the webview host owns, nothing here has verified it is
   * granted, and a build session cannot verify it. One mechanism, not a
   * try-then-fall-back pair (ADR 0040 §4).
   */
  readonly onCopy: (text: string) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** How long the confirmation glyph stays — the reference's 2000 ms. */
const COPIED_MS = 2000;

/** Two overlapping sheets, and a tick. Authored here; no markup string. */
const COPY_PATHS = [
  "M6.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z",
  "M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5",
] as const;
const DONE_PATHS = ["M3.5 8.5 6.5 11.5 12.5 4.5"] as const;

/**
 * An icon, built node by node.
 *
 * `createElementNS` rather than a markup string: `check-webview-innerhtml.mjs`
 * is deny-by-default over this whole tree with no allowlist, and model output is
 * one sibling away. An `<svg>` also contributes no text node, which is what
 * keeps the button out of the bubble's `textContent`.
 */
function icon(paths: readonly string[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * The Copy affordance, adapted from the Claude Code VS Code extension's own
 * webview: absolutely positioned at the wrapper's top-right, revealed on hover
 * of the BLOCK, an icon with no text, and a confirmation that swaps the glyph on
 * a 2000 ms timer rather than writing a word into the block.
 *
 * The one divergence is the accessible label, which changes with the state: the
 * reference keeps `"Copy code"` throughout, so a screen reader is told nothing
 * about whether the copy happened.
 *
 * **It copies on PRESS, not on release, and that is load-bearing.** The
 * transcript rebuilds `document.body` once per animation frame while a response
 * streams, and a `click` is dispatched to the nearest common ancestor of the
 * press and the release — so a button detached between the two receives no
 * click at all. A human press lasts 50–150 ms and therefore straddles several
 * rebuilds, which would leave the affordance simply dead for the whole duration
 * of an answer. Copying on press is what survives a node that may not.
 *
 * That costs **three** activation arms rather than one, and each covers a route
 * the others cannot: `mousedown` for the pointer, `keydown` for the keyboard
 * (`mousedown` never fires for it, and the native Enter/Space activation it
 * would otherwise ride is itself a `click`), and a `detail: 0`-guarded `click`
 * for assistive technology, whose `Invoke` arrives as a synthetic click with no
 * press before it. Three arms for one property is a cost worth naming; the
 * alternative is a button that some real user cannot press.
 *
 * The confirmation does NOT survive a re-render — the transcript rebuilds
 * wholesale on every streamed delta, so a copy taken while an answer is arriving
 * may revert early. Remembering it would need cross-render state for a
 * two-second decoration, which is the cost D2 paid twice and ADR 0040 declines.
 */
function copyButton(body: string, chrome: CodeBlockChrome): HTMLButtonElement {
  const btn = document.createElement("button");
  const idle = tr(chrome.locale, "mdCopy");
  const done = tr(chrome.locale, "mdCopied");
  const dress = (label: string, paths: readonly string[]): void => {
    btn.setAttribute("title", label);
    btn.setAttribute("aria-label", label);
    btn.replaceChildren(icon(paths));
  };
  btn.type = "button";
  btn.className = "lm-md__copy";
  dress(idle, COPY_PATHS);
  // Owned, so a second press inside the window re-arms instead of being cut
  // short by the first press's timer.
  let revert: ReturnType<typeof setTimeout> | undefined;
  const activate = (): void => {
    chrome.onCopy(body);
    btn.className = "lm-md__copy lm-md__copy--done";
    dress(done, DONE_PATHS);
    if (revert !== undefined) clearTimeout(revert);
    revert = setTimeout(() => {
      revert = undefined;
      btn.className = "lm-md__copy";
      dress(idle, COPY_PATHS);
    }, COPIED_MS);
  };
  btn.addEventListener("mousedown", (ev) => {
    // Primary button only. A `click` listener was implicitly filtered this way;
    // `mousedown` is not, so without this a right-click would silently replace
    // the clipboard *and* open the context menu, i.e. take an action nobody
    // asked for and hide that it happened.
    if (ev.button !== 0) return;
    activate();
  });
  btn.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    // Space would scroll the transcript, and both keys would otherwise go on to
    // produce a `click` — which the arm below would then treat as a second
    // activation, since a native button's activation click carries `detail: 0`.
    ev.preventDefault();
    activate();
  });
  // The assistive-technology arm, and the reason it can coexist with the two
  // above. A UIA/MSAA `Invoke` — a screen reader activating the button — arrives
  // as a synthetic `click` with **no** preceding `mousedown` and no `keydown`,
  // exactly like `element.click()`, and it carries `detail: 0`. A real pointer
  // click carries `detail >= 1` and has already been handled on press, so
  // guarding on `detail` covers the one route the other two arms cannot reach
  // without double-firing on the one they can. Without this the button is
  // audible to a screen reader and impossible to press, which would make the two
  // string keys ADR 0040 spends on its label pointless.
  btn.addEventListener("click", (ev) => {
    if (ev.detail === 0) activate();
  });
  return btn;
}

/**
 * A fenced block.
 *
 * `open` is true while the closing fence has not arrived. It only ever adds a
 * marker class: [ADR 0040](../../../../../Lemmaria-design-doc/docs/adr/0040-streaming-fences-and-code-block-chrome.md)
 * §2 lifts the `max-height` clamp while a block is growing, so the block
 * behaves like ordinary streamed prose and the transcript's own
 * follow-the-bottom logic is the only scroll involved.
 *
 * With a `chrome`, the `<pre>` is wrapped so the Copy button has something to be
 * positioned against — the reference's shape exactly: a relatively-positioned
 * container with two children, the button first so it is reachable by keyboard
 * before the block it belongs to.
 */
function codeBlock(
  info: string,
  body: string,
  open: boolean,
  chrome?: CodeBlockChrome,
): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = open ? "lm-md__pre lm-md__pre--open" : "lm-md__pre";
  const code = document.createElement("code");
  const lang = info.trim().split(/[ \t]/)[0] ?? "";
  // `textContent`, never innerHTML: this is model output and the webview CSP
  // carries no 'unsafe-inline' to fall back on.
  code.textContent = body;
  code.className = lang === "" ? "lm-md__code" : `lm-md__code language-${lang}`;
  pre.append(code);
  if (chrome === undefined) return pre;
  const wrap = document.createElement("div");
  wrap.className = "lm-md__codeblock";
  wrap.append(copyButton(body, chrome), pre);
  return wrap;
}

/**
 * Render a whole message body to block-level nodes.
 *
 * Fences are resolved **before** any line is classified, or a `# comment`
 * inside a Python block becomes an `<h1>`.
 *
 * An unclosed fence renders as a code block **from its opening line**
 * ([ADR 0040](../../../../../Lemmaria-design-doc/docs/adr/0040-streaming-fences-and-code-block-chrome.md),
 * superseding D3-2 for fences only). Round 1 degraded the rest of the message
 * to verbatim text instead, which measured ~9 seconds of raw fence syntax on a
 * ≥40-line block at the operator's gate round. The trade Codex accepts and this
 * accepts with it: a fence that never closes styles the remainder as code.
 *
 * The reversal is **fences only**. An unclosed `**`, `` ` `` or `[t](` is still
 * literal, and an unclosed `$$` / `\[` / `\begin{env}` block opener still
 * degrades its region to verbatim text — a fence's opener states what kind of
 * thing it opens, and a bare `$$` does not.
 *
 * **What replaces round 1's withdrawn "no prefix renders anything but plain
 * text" is narrower than it first reads, and the exact wording matters because
 * it is this module's only remaining safety claim: no prefix loses a *body*
 * character.** The fence's own marker line is chrome and is not displayed — its
 * backticks, its language and any further info-string text all vanish the moment
 * three backticks make it an opener, exactly as they always have on the closed
 * path. Round 1 showed those characters while the fence was open; round 2 does
 * not, and that is the one deliberate loss. Everything after the marker line is
 * still present character for character at every prefix.
 */
export function blocks(source: string, chrome?: CodeBlockChrome): Node[] {
  const out: Node[] = [];
  // A trailing CR is dropped per line rather than carried: a model quoting a
  // Windows file emits `\r\n`, and a closing fence of "```\r" would not match,
  // silently turning the whole rest of the message into verbatim text. `\r`
  // renders as nothing, so dropping it changes no visible character.
  const lines = source
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  // Non-fenced lines accumulate into a REGION, which is then scanned as one
  // string. A multi-line opaque span is only visible to a pass that looks at
  // more than one line at a time, and shredding it into lines first is how the
  // `- ` in `$$\n- a_1\n$$` used to be deleted.
  let region: string[] = [];
  // `tailOpen` is false for a region a fence flushed — every one of its
  // lines was followed by a newline in the source, or the fence line could
  // not have come after it. Only the region that ends the source has a line
  // that may still be growing, which is what X4-2's table gate reads.
  const flushRegion = (tailOpen: boolean): void => {
    renderTextRegion(region.join("\n"), out, tailOpen, 0);
    region = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (FENCE_CLOSE.test(lines[j] ?? "")) {
          close = j;
          break;
        }
      }
      flushRegion(false);
      if (close === -1) {
        // ADR 0040: render it from the opening line, Codex's shape
        // (`markdown.rs:86-88` — "an unclosed fence at end-of-input is
        // re-emitted with its opening line so partial streams degrade to code
        // display"). The rest of the message goes INTO the block.
        //
        // Nothing is trimmed. A trailing partial closer (`` ` ``, ``` `` ```)
        // stays on screen; Pi strips it to avoid a one-line grow-then-shrink
        // and ADR 0040 §2 records why that is refused here — the property that
        // survives the reversal is *no prefix loses a BODY character*, and a
        // trimmed closer is a body line losing one — it sits after the marker
        // line, which is the only part of a fence that is chrome.
        out.push(
          codeBlock(open[1] ?? "", lines.slice(i + 1).join("\n"), true, chrome),
        );
        return out;
      }
      out.push(
        codeBlock(
          open[1] ?? "",
          lines.slice(i + 1, close).join("\n"),
          false,
          chrome,
        ),
      );
      i = close;
      continue;
    }
    region.push(line);
  }
  flushRegion(true);
  return out;
}

/**
 * The whole agent-message bubble.
 *
 * This exists so that the line in `main.ts` is a delegation with no branch in
 * it. [ADR 0037](../../../../../Lemmaria-design-doc/docs/adr/0037-webview-dom-tests.md)
 * §3 accepts that a `parts/` module is asserted while its `main.ts` call site
 * is not, and the DEFERRED open question that records the cost names **D3** as
 * its revisit trigger. Refactoring `main.ts` is a B1-sized decomposition and
 * still out of scope for a surfaces milestone — but the untested surface can
 * at least be reduced from *a rendering decision* to *a delegation*, which is
 * what building the whole bubble here does. ADR 0039 §6 records that this
 * shrinks the gap rather than closing it.
 *
 * `lm-md` is what turns off `.lm-msg`'s `white-space: pre-wrap` (D3-7): with
 * block children, `pre-wrap` would also render the whitespace BETWEEN them as
 * blank lines. Each paragraph carries the rule itself instead, so a soft line
 * break inside one still shows.
 */
export function agentMessage(
  text: string,
  chrome?: CodeBlockChrome,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "lm-msg lm-msg-agent lm-md";
  return fill(box, blocks(text, chrome));
}
