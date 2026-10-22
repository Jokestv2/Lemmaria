/**
 * Freezing protected spans into opaque tokens before prompting
 * (context.protected_spans policy, schema spec §3) and thawing model output
 * back to raw source. Token intactness is the `protected_spans_intact`
 * validator's core check.
 */

import type {
  ProtectedSpan,
  SemanticUnit,
  SpanKind,
} from "../contracts/adapters.js";

export type ProtectedSpanPolicy =
  | "freeze"
  | "allow_edit"
  | {
      mode: "freeze_except";
      allow: SpanKind[];
    };

export interface FrozenUnit {
  /** Unit text with each frozen span replaced by its token. */
  text: string;
  /** token → raw source, for thawing and intactness checks. */
  tokens: Map<string, string>;
}

export function spansToFreeze(
  spans: ProtectedSpan[],
  policy: ProtectedSpanPolicy,
): ProtectedSpan[] {
  if (policy === "allow_edit") return [];
  if (policy === "freeze") return spans;
  return spans.filter((s) => !policy.allow.includes(s.kind));
}

/**
 * Spans carry absolute file offsets; the unit's own span locates it in the same
 * file. Spans are clamped to the unit bounds (a protected span can extend
 * slightly past a mid-macro selection-scope boundary — M2 known issue).
 */
export function freezeUnit(
  unit: SemanticUnit,
  spans: ProtectedSpan[],
): FrozenUnit {
  const base = unit.span.startOffset;
  const sorted = [...spans].sort((a, b) => a.startOffset - b.startOffset);
  const tokens = new Map<string, string>();
  let out = "";
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(s.startOffset - base, cursor);
    const end = Math.min(s.endOffset - base, unit.text.length);
    if (end <= start) continue;
    out += unit.text.slice(cursor, start);
    tokens.set(s.token, unit.text.slice(start, end));
    out += s.token;
    cursor = end;
  }
  out += unit.text.slice(cursor);
  return { text: out, tokens };
}

export function checkTokensIntact(
  output: string,
  tokens: Map<string, string>,
): { missing: string[]; duplicated: string[] } {
  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const token of tokens.keys()) {
    const count = output.split(token).length - 1;
    if (count === 0) missing.push(token);
    else if (count > 1) duplicated.push(token);
  }
  return { missing, duplicated };
}

/**
 * Remove every token from a frozen text, leaving only the editable prose —
 * the honest input for language detection and `{{counts.current}}` (a zh
 * paragraph must not read as "mixed" because of `\citep{...}` / math source).
 */
export function stripTokens(text: string, tokens: Map<string, string>): string {
  let out = text;
  for (const token of tokens.keys()) out = out.replaceAll(token, "");
  return out;
}

export function thawText(text: string, tokens: Map<string, string>): string {
  let out = text;
  for (const [token, raw] of tokens) out = out.replaceAll(token, raw);
  return out;
}
