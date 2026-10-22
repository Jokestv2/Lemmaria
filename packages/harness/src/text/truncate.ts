/**
 * B4 (ADR 0029) — the harness's one text-truncation primitive.
 *
 * A6 gave the loop a single backstop: `capToolResult`, a 32 000-character HEAD
 * cut over the already-serialized payload. It is the right last line of defence
 * and stays, but it cannot be the policy — it cannot say how big the thing it
 * cut was in the tool's own terms, and it keeps the head even for a failing
 * script, whose error is at the end.
 *
 * Adapted from Pi's `harness/utils/truncate.ts` (MIT), with four deliberate
 * divergences recorded in ADR 0029:
 *
 * 1. The second limit is estimated TOKENS, not bytes. Bytes are a transport
 *    measure; the resource being spent is the context window, and a byte cap is
 *    not bilingual-neutral — the same content costs roughly three times as many
 *    bytes in Chinese as in English, so a byte budget would silently hand a
 *    Chinese paper a third of what an English one gets (invariant 6).
 *    `estimateTokens` lives here for that reason: it is the harness's single
 *    idea of what text costs, shared with A2's compaction retention budget.
 * 2. The names say which end is KEPT. Pi's `truncateHead` keeps the head; read
 *    cold at a call site, the name says the opposite of what it does.
 * 3. A single over-budget line yields a bounded partial line at either end,
 *    where Pi's head form returns nothing. In LaTeX and Markdown a whole
 *    paragraph is routinely ONE line, so returning nothing would make
 *    `read_span` useless on exactly the documents Lemmaria exists for.
 * 4. Fewer fields, and `shown*` rather than `output*` — matching the
 *    `shownChars` vocabulary `capToolResult` already puts in front of the model.
 */

function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
    (cp >= 0x3000 && cp <= 0x303f) || // CJK punctuation （，。《》）
    (cp >= 0x3040 && cp <= 0x30ff) || // kana
    (cp >= 0x3400 && cp <= 0x9fff) || // CJK ideographs (incl. ext-A)
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms （？！：）
    (cp >= 0x20000 && cp <= 0x2ffff) // ext-B and beyond
  );
}

export function isCjk(ch: string): boolean {
  return isCjkCodepoint(ch.codePointAt(0) ?? 0);
}

/**
 * Rough token estimate — CJK codepoints count as one token each, other text at
 * ~4 characters per token. Deliberately NOT a tokenizer: it sizes budgets, and
 * every trigger that must be exact (context occupancy, ADR 0015/0021) uses the
 * provider's measured usage instead. Moved here from `session/compaction.ts` at
 * B4, when truncation became its second consumer (B1's precedent).
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export interface TruncationLimits {
  maxLines: number;
  maxTokens: number;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  /** Which limit fired. `null` ⇔ `truncated === false`. */
  truncatedBy: "lines" | "tokens" | null;
  /** The size of the ORIGINAL — what the model is missing, not what it got. */
  totalLines: number;
  totalTokens: number;
  totalBytes: number;
  shownLines: number;
  shownTokens: number;
  /** True only when a single line alone exceeded the whole token budget. */
  partialLine: boolean;
}

/**
 * Split for counting: a trailing newline terminates the last line rather than
 * starting an empty one, so "a\nb\n" is two lines, not three.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The cost of one line, charging the newline that joins it to its neighbour. */
function lineCost(line: string, isFirstKept: boolean): number {
  return estimateTokens(line) + (isFirstKept ? 0 : 1);
}

/** Keep at most `maxTokens` worth of the start of one line, whole codepoints. */
function prefixToTokens(line: string, maxTokens: number): string {
  let cjk = 0;
  let other = 0;
  let out = "";
  for (const ch of line) {
    if (isCjk(ch)) cjk += 1;
    else other += 1;
    if (cjk + Math.ceil(other / 4) > maxTokens) break;
    out += ch;
  }
  return out;
}

/** Keep at most `maxTokens` worth of the END of one line, whole codepoints. */
function suffixToTokens(line: string, maxTokens: number): string {
  const chars = [...line];
  let cjk = 0;
  let other = 0;
  let take = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i] as string;
    if (isCjk(ch)) cjk += 1;
    else other += 1;
    if (cjk + Math.ceil(other / 4) > maxTokens) break;
    take += 1;
  }
  return chars.slice(chars.length - take).join("");
}

function totalsFor(text: string, lines: readonly string[]) {
  return {
    totalLines: lines.length,
    totalTokens: estimateTokens(text),
    totalBytes: Buffer.byteLength(text, "utf8"),
  };
}

function untouched(text: string, lines: readonly string[]): TruncationResult {
  const totals = totalsFor(text, lines);
  return {
    text,
    truncated: false,
    truncatedBy: null,
    ...totals,
    shownLines: lines.length,
    shownTokens: totals.totalTokens,
    partialLine: false,
  };
}

/** Keep the BEGINNING — file reads, listings, search hits. */
export function truncateKeepingHead(
  text: string,
  limits: TruncationLimits,
): TruncationResult {
  const lines = splitLines(text);
  const totals = totalsFor(text, lines);
  if (lines.length <= limits.maxLines && totals.totalTokens <= limits.maxTokens)
    return untouched(text, lines);

  const kept: string[] = [];
  let spent = 0;
  let truncatedBy: "lines" | "tokens" = "lines";
  for (const line of lines) {
    if (kept.length >= limits.maxLines) break;
    const cost = lineCost(line, kept.length === 0);
    if (spent + cost > limits.maxTokens) {
      truncatedBy = "tokens";
      break;
    }
    kept.push(line);
    spent += cost;
  }
  // One line alone over the whole budget: keep a bounded prefix rather than
  // nothing, and say the line itself was cut (divergence 3).
  if (kept.length === 0) {
    const first = lines[0] ?? "";
    const partial = prefixToTokens(first, limits.maxTokens);
    return {
      text: partial,
      truncated: true,
      truncatedBy: "tokens",
      ...totals,
      shownLines: 1,
      shownTokens: estimateTokens(partial),
      partialLine: true,
    };
  }
  return {
    text: kept.join("\n"),
    truncated: true,
    truncatedBy,
    ...totals,
    shownLines: kept.length,
    // Measured over the kept text, not accumulated from `lineCost` (review,
    // Minor 5): the per-line cost rounds each line up and charges a whole
    // token per newline, which is the right conservative rule for the BUDGET
    // decision but would let the reported figure exceed `totalTokens`.
    shownTokens: estimateTokens(kept.join("\n")),
    partialLine: false,
  };
}

/** Keep the END — script output, where a failure's message is last. */
export function truncateKeepingTail(
  text: string,
  limits: TruncationLimits,
): TruncationResult {
  const lines = splitLines(text);
  const totals = totalsFor(text, lines);
  if (lines.length <= limits.maxLines && totals.totalTokens <= limits.maxTokens)
    return untouched(text, lines);

  const kept: string[] = [];
  let spent = 0;
  let truncatedBy: "lines" | "tokens" = "lines";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= limits.maxLines) break;
    const cost = lineCost(lines[i] as string, kept.length === 0);
    if (spent + cost > limits.maxTokens) {
      truncatedBy = "tokens";
      break;
    }
    kept.unshift(lines[i] as string);
    spent += cost;
  }
  if (kept.length === 0) {
    const last = lines[lines.length - 1] ?? "";
    const partial = suffixToTokens(last, limits.maxTokens);
    return {
      text: partial,
      truncated: true,
      truncatedBy: "tokens",
      ...totals,
      shownLines: 1,
      shownTokens: estimateTokens(partial),
      partialLine: true,
    };
  }
  return {
    text: kept.join("\n"),
    truncated: true,
    truncatedBy,
    ...totals,
    shownLines: kept.length,
    // Measured over the kept text, not accumulated from `lineCost` (review,
    // Minor 5): the per-line cost rounds each line up and charges a whole
    // token per newline, which is the right conservative rule for the BUDGET
    // decision but would let the reported figure exceed `totalTokens`.
    shownTokens: estimateTokens(kept.join("\n")),
    partialLine: false,
  };
}

/**
 * Marker for a line cut mid-way — a grep match, never a whole payload.
 *
 * **English, deliberately** (ADR 0034 consequence 2). It used to carry both
 * languages, on a D1 review finding (Minor 6) reasoning that an English-only
 * mark "would be an invariant-6 leak". That reading of invariant 6 was the
 * error the whole of X2 exists to correct: this mark is not a message to a
 * reader, it is a fact about a payload the MODEL reads, spliced into
 * `grep_project` output where no `SessionLocale` is in scope. Marking the cut
 * in one language is right; marking it in two put Chinese in front of readers
 * who may not read it, for no gain to either audience.
 */
export const LINE_TRUNCATION_MARK = "… [truncated]";

/**
 * Cap ONE line by characters. `grep_project` has cut match lines at 200
 * characters since M8 and said nothing about it, so a truncated match read as
 * a short one; the mark is the whole point.
 */
export function truncateLineTo(
  line: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const chars = [...line];
  if (chars.length <= maxChars) return { text: line, truncated: false };
  return {
    text: chars.slice(0, maxChars).join("") + LINE_TRUNCATION_MARK,
    truncated: true,
  };
}
