/**
 * Edit fidelity on the agentic write path (D1, ADR 0032).
 *
 * The quick-action path freezes comments, math, citations and macros to
 * `⟦Pn⟧` placeholders before the model ever sees them (`engine/spans.ts`), so
 * "polish this sentence" cannot touch the comment above it. `propose_edit`
 * reads raw source and had no equivalent: a `%` comment was just more text the
 * model might rewrite.
 *
 * This is the write half of closing that gap. `read_span` MARKS (the model can
 * see the rule); this REFUSES (the rule is true rather than hopeful). Both run
 * the same injected `ProtectedSpanReader`, so what the model is told and what
 * it is judged by cannot drift apart.
 *
 * **Why the check lives at proposal time and not at apply time.** The anchor is
 * a verbatim substring of the file occurring exactly once, so the protected
 * spans "inside the edited region" are exactly the protected spans OF THE
 * ANCHOR — and whether they survived is answered by the anchor and the
 * replacement alone, with no reference to the file. Between a proposal and its
 * apply the file may change, but `applyOne` already re-locates the anchor and
 * turns the edit `stale` when it no longer matches exactly once; if it does
 * still match, those bytes are unchanged and so is this answer. One check,
 * before any approval, that can only ever refuse.
 */

import type { ProtectedSpan, SpanKind } from "../contracts/adapters.js";
import { CONTAINER_SPAN_KINDS } from "../contracts/adapters.js";
import type { SessionLocale } from "../contracts/sessions.js";

/**
 * The part of a container span that must survive: its command and opening
 * delimiter (`\textbf{`), or the bare command token when it has none (`\item`,
 * `##`). Falls back to the whole raw when neither shape matches, which fails
 * safe — an unrecognised container is treated exactly as D1 treated it.
 */
function containerSkeleton(raw: string): string {
  const braced = raw.match(/^\s*(\\[A-Za-z@]+\s*(?:\[[^\]]*\])?\s*\{)/);
  if (braced?.[1]) return braced[1];
  const token = raw.match(/^\s*(\\[A-Za-z@]+|#{1,6})/);
  return token?.[1] ?? raw;
}

/**
 * What this span requires the replacement to still contain — the whole raw for
 * an opaque kind, the skeleton for a container.
 *
 * The split itself is [`CONTAINER_SPAN_KINDS`](../contracts/adapters.ts), which
 * is where it moved at X3 (ADR 0036): `@lemmaria/adapters` needs the same set
 * to decide which nested candidates to surface, and two copies of it could
 * drift — a drift that silently *un*protects.
 *
 * A container's skeleton is only PART of what its region protects. Anything
 * protected nested inside it arrives as a span of its own (ADR 0036), so the
 * rest of this module needs no special case for it.
 *
 * D1 protected both shapes alike, which made every `\textbf{}` and
 * `\footnote{}` in a paragraph immutable on the agentic path and left "polish
 * this paragraph" unsatisfiable when the words that needed to move sat inside
 * one. No HTML-aware editor treats the text in `<strong>text</strong>` that way
 * — the tag is structure, the text is content — and neither does this.
 */
function requiredText(span: ProtectedSpan): string {
  return CONTAINER_SPAN_KINDS.has(span.kind)
    ? containerSkeleton(span.raw)
    : span.raw;
}

/**
 * The form a declaration and a span's raw are compared in (X3, ADR 0036 §2):
 * trimmed, whitespace-collapsed, and **brace-balanced** — missing closers
 * appended, unmatched ones dropped.
 *
 * X2 compared trimmed raws exactly, and the operator's round showed what that
 * costs: the detector recorded `\textbf{\emph{x}}` as the unbalanced
 * `\textbf{\emph{x}`, so the only declaration the check accepted looked like a
 * typo. The model quoted the balanced text — the reasonable thing to do with
 * what looks like malformed LaTeX — and was told its escape was DISHONEST.
 * ADR 0036 §1 fixes that raw at the detector; this fixes the class, since an
 * unbalanced raw can still arrive from `containerSkeleton`'s fallback, from
 * Markdown, or from a fragment cut mid-construct.
 *
 * **Normalized, not substring.** The obvious wider rule — accept a declaration
 * that *contains* the raw — is satisfied by the whole anchor text, which is the
 * blanket waiver ADR 0033 §2 forbids and `undeclarableRemoval` exists to catch.
 * Normalizing accepts a model that tidied its own quotation and nothing else.
 */
function normalizeForMatch(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const wanted: string[] = [];
  let out = "";
  for (let i = 0; i < collapsed.length; i += 1) {
    const c = collapsed.charAt(i);
    if (c === "\\") {
      // An escaped delimiter is ordinary text, never structure.
      out += c + collapsed.charAt(i + 1);
      i += 1;
      continue;
    }
    if (c === "{" || c === "[") {
      wanted.push(c === "{" ? "}" : "]");
      out += c;
      continue;
    }
    if (c === "}" || c === "]") {
      if (wanted.at(-1) === c) {
        wanted.pop();
        out += c;
      }
      // An unmatched closer cannot belong to this text; drop it.
      continue;
    }
    out += c;
  }
  while (wanted.length > 0) out += wanted.pop();
  return out;
}

/** Occurrences of `needle` in `haystack`, non-overlapping. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

/**
 * The first protected span the replacement loses, or `undefined` when nothing
 * was lost.
 *
 * **The rule.** Every protected span in `anchor` must occur in `replacement`
 * at least as many times as it occurs in `anchor`. "At least", not "exactly":
 * the reported harm is LOSS — a dropped comment, a deleted citation, a
 * vanished `$…$`. Duplicating one is not that harm and is occasionally
 * legitimate (splitting a sentence that cites the same work twice). Counting
 * rather than testing `includes` is what catches two identical `\cite{x}`
 * where one is dropped — a hole in `protected_spans_intact`'s no-token
 * fallback, which only ever asks whether the raw text appears at all.
 *
 * **The escape is a DECLARATION** (X2, ADR 0033 §2). A span whose raw text the
 * model listed in `removes_protected` is being removed on purpose, and passes.
 *
 * D1's escape was different and is **withdrawn**: an anchor that *was* one
 * span's raw text used to pass automatically. That failed three ways — it
 * could express only one removal per edit (so "drop the formula and the
 * citation" forced a two-edit batch that walked straight around the rule), it
 * read as the workaround it was, and it put the intent nowhere the user could
 * see it. A declaration scales, is legible in the proposal row, and cannot be
 * reached by accident.
 *
 * Reports the FIRST loss in source order so the note a model reads twice is
 * the same note.
 */
export function missingProtectedSpan(
  anchor: string,
  replacement: string,
  spans: readonly ProtectedSpan[],
  /** Raw texts this edit declares it is deliberately removing (ADR 0033). */
  removesProtected: readonly string[] = [],
): ProtectedSpan | undefined {
  if (spans.length === 0) return undefined;
  // Compared normalized, for the same reason D1's carve-out had to be trimmed:
  // a LaTeX comment node's `raw` carries its own surrounding whitespace and
  // newline ("\n  % TODO: verify\n"), so a literal comparison would make the
  // declaration unhittable for the very construct this rule is named after.
  const declared = new Set(removesProtected.map(normalizeForMatch));
  // A declaration names the span's RAW text — what the model read and what the
  // proposal row shows the user — even for a container, whose enforced text is
  // only its skeleton.
  const declaredSpans = spans.filter((s) =>
    declared.has(normalizeForMatch(s.raw)),
  );
  // **Two tiers, because normalizing is lossy.** Collapsing whitespace and
  // dropping unmatched closers can make two DISTINCT spans normalize alike —
  // `\emph{a $x$ b}` and `\emph{a $x$  b}`, or `\textbf{a]b}` and
  // `\textbf{ab}`. That tolerance is wanted for waiving the span the model
  // meant; it must not also hand it the second span's whole REGION. So only an
  // exact (trimmed) match earns the transitive waiver below; a fuzzy match
  // waives nothing but itself.
  const exact = new Set(removesProtected.map((r) => r.trim()));
  const exactlyDeclared = declaredSpans.filter((s) => exact.has(s.raw.trim()));
  // Removing a region removes what is inside it, so declaring a container
  // waives the spans nested in it (X3, ADR 0036 §4). Without this, "remove the
  // bold entirely" costs a second round trip: the model declares
  // `\textbf{\emph{x}}` and is then refused for the `\emph{}` it could not
  // possibly have kept.
  //
  // **The transitive half is conditional on the container actually being gone**,
  // or the declaration becomes a lever: declare `\footnote{See \cite{x}.}`,
  // KEEP the footnote, drop the `\cite{x}` inside it, and both would be waived
  // — a silent loss reached through a declaration that named something else.
  // A container the replacement still contains has removed nothing, so it
  // waives nothing but itself. Deliberately conservative: with two `\textbf{}`
  // where one is declared and the other kept, the skeleton still occurs and the
  // nested spans of the removed one must be declared too. Over-protection is
  // the direction this rule fails in on purpose — the cost is a round trip, and
  // the alternative is the loss it exists to prevent.
  const stillPresent = (d: ProtectedSpan): boolean =>
    countOccurrences(replacement, requiredText(d)) > 0;
  const waived = (s: ProtectedSpan): boolean =>
    declaredSpans.includes(s) ||
    exactlyDeclared.some(
      (d) =>
        d !== s &&
        s.startOffset >= d.startOffset &&
        s.endOffset <= d.endOffset &&
        !stillPresent(d),
    );
  const enforced = spans.filter((s) => !waived(s));
  const required = new Map<string, number>();
  for (const s of enforced) {
    // How many PROTECTED occurrences there are, not how many times the text
    // happens to appear: the same string may also sit at an unprotected
    // position in the anchor, and over-counting refuses a legitimate rewrite of
    // that copy (review, Minor 15). Counted over the ENFORCED spans only, or a
    // waived one inflates the requirement for a sibling that shares its key —
    // two `\textbf{}` where one is declared would refuse the other.
    const key = requiredText(s);
    required.set(key, (required.get(key) ?? 0) + 1);
  }
  const ordered = [...enforced].sort((a, b) => a.startOffset - b.startOffset);
  for (const s of ordered) {
    const key = requiredText(s);
    const need = required.get(key) ?? 0;
    if (countOccurrences(replacement, key) < need) return s;
  }
  return undefined;
}

/**
 * A declared removal naming something that is NOT a protected span of this
 * anchor (X2, ADR 0033 §2).
 *
 * The declaration is a statement about *this edit*, never a blanket waiver:
 * without this check a model could disarm the rule by listing a span it had
 * not read, or by listing text from a different part of the file. Returns the
 * first offending entry, or `undefined` when every entry is honest.
 */
export function undeclarableRemoval(
  spans: readonly ProtectedSpan[],
  removesProtected: readonly string[],
): string | undefined {
  if (removesProtected.length === 0) return undefined;
  // The SAME normalization `missingProtectedSpan` waives by (X3, ADR 0036 §2).
  // A declaration accepted by one and refused by the other is the deadlock the
  // operator observed: the model is told its escape is dishonest and has
  // nowhere left to go.
  const known = new Set(spans.map((s) => normalizeForMatch(s.raw)));
  return removesProtected.find((r) => !known.has(normalizeForMatch(r)));
}

/**
 * The refusal a lost span becomes, **in one language** (X2, ADR 0034).
 *
 * It used to return `` `${en} / ${zh}` `` — both at once, on a reading of
 * invariant 6 that mistook "the product is bilingual" for "every string is".
 * A reader whose display language is English cannot be assumed to read
 * Chinese; the note resolves to the session's locale and stops there.
 *
 * It names the escape as well as the failure: a message that only says "no"
 * leaves the model to guess, and the guess it reaches for is a narrower anchor
 * — which, since ADR 0033 withdrew D1's carve-out, is refused again. So it
 * names `removes_protected`, which is now the only way through.
 */
export function protectedSpanRefusal(
  span: ProtectedSpan,
  locale: SessionLocale = "en",
): string {
  // Collapsed to one line: a comment span's `raw` carries its own newline, and
  // interpolating it raw split the sentence across three lines in the proposal
  // row the user reads and in the decision the model reads back.
  const oneLine = span.raw.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
  if (locale === "zh") {
    return `受保护内容不可被无声删除：锚点中的${SPAN_KIND_ZH[span.kind]}“${shown}”未出现在替换文本中——请原样保留；若用户明确要求删除它，请在该条编辑的 removes_protected 中列出它。`;
  }
  return `protected content cannot be dropped silently: the ${span.kind} "${shown}" is in the anchor but not in the replacement — reproduce it unchanged, or, if the request asks you to remove it, list it in this edit's removes_protected.`;
}

/** The refusal a dishonest declaration becomes (ADR 0033 §2). */
export function undeclarableRemovalRefusal(
  raw: string,
  locale: SessionLocale = "en",
): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
  if (locale === "zh") {
    return `removes_protected 中的“${shown}”不是该锚点内的受保护内容——只能声明删除本次编辑锚点中实际存在的受保护内容。`;
  }
  return `removes_protected names "${shown}", which is not a protected span of this edit's anchor — you may only declare the removal of protected content the anchor actually contains.`;
}

/**
 * The six span kinds in the reader's language (invariant 6). An exhaustive
 * `Record`, so a `SpanKind` added later fails `pnpm typecheck` rather than
 * printing an English word inside a Chinese sentence.
 */
const SPAN_KIND_ZH: Record<SpanKind, string> = {
  math: "公式",
  cite: "引用",
  ref: "交叉引用",
  code: "代码",
  macro: "自定义命令",
  markup: "标记命令",
  comment: "注释",
};
