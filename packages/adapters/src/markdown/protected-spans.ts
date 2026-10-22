/**
 * Markdown protected spans (M8): everything a writing action must not reword —
 * math (always LaTeX syntax, per the architecture: "math fragments are parsed
 * and protected per LaTeX syntax"), code (fences + inline), citations
 * ([@key] groups and bare @key), comments, and non-prose markup (headings
 * frozen whole per the M6 "freeze whole constructs" decision; links/images
 * frozen whole — finer text-editable linking is a recorded M8 limit).
 * Higher-priority block spans win; a candidate starting inside an accepted
 * span is dropped (a `$x$` inside a code fence is code, not math) — except
 * inside a CONTAINER when `nested` is on, where it is kept beside its
 * container (X3, ADR 0036), because a container's prose is editable and so
 * what is protected inside it has to be named separately.
 */

import type { ProtectedSpan, SemanticUnit, SpanKind } from "@lemmaria/harness";
import { CONTAINER_SPAN_KINDS } from "@lemmaria/harness";
import type { ProtectedSpanOptions } from "../protected-options.js";
import type { MarkdownDocument } from "./document.js";

interface Candidate {
  start: number;
  end: number;
  kind: SpanKind;
}

export function collectMarkdownProtectedSpans(
  doc: MarkdownDocument,
  unit: SemanticUnit,
  options: ProtectedSpanOptions = {},
): ProtectedSpan[] {
  const text = doc.text;
  const accepted: Candidate[] = [];
  const contains = (outer: Candidate, s: number, e: number): boolean =>
    s >= outer.start && e <= outer.end;
  /**
   * A clash a CONTAINER may keep (X3, ADR 0036). Candidates arrive in priority
   * order rather than in source order, so nesting shows up in both directions:
   * a heading scanned AFTER the `$x^2$` inside it (the measured case — the
   * heading was dropped and its `##` left unprotected), and a candidate found
   * inside a container already accepted. Either way only a container may hold
   * something; inside an opaque span the whole raw is required and a second
   * entry would be noise the model cannot act on.
   */
  const nestable = (start: number, end: number, kind: SpanKind): boolean => {
    if (options.nested !== true) return false;
    const clashing = accepted.filter((a) => start < a.end && end > a.start);
    if (CONTAINER_SPAN_KINDS.has(kind))
      return clashing.every((a) =>
        contains({ start, end, kind }, a.start, a.end),
      );
    return clashing.every(
      (a) => CONTAINER_SPAN_KINDS.has(a.kind) && contains(a, start, end),
    );
  };
  const overlaps = (start: number, end: number): boolean =>
    accepted.some((a) => start < a.end && end > a.start);
  const add = (start: number, end: number, kind: SpanKind): void => {
    if (end <= start) return;
    if (overlaps(start, end) && !nestable(start, end, kind)) return;
    accepted.push({ start, end, kind });
  };
  const scan = (re: RegExp, kind: SpanKind): void => {
    for (const m of text.matchAll(re)) {
      add(m.index ?? 0, (m.index ?? 0) + m[0].length, kind);
    }
  };

  // Priority order: block constructs first, then inline ones.
  if (doc.frontmatter) {
    add(0, doc.frontmatter.raw.length, "markup");
  }
  for (const f of doc.fences) add(f.startOffset, f.endOffset, "code");
  scan(/<!--[\s\S]*?-->/g, "comment");
  scan(/\$\$[\s\S]*?\$\$/g, "math");
  scan(/\\\[[\s\S]*?\\\]/g, "math");
  scan(/\$[^$\n]+\$/g, "math");
  scan(/\\\([\s\S]*?\\\)/g, "math");
  scan(/`[^`\n]+`/g, "code");
  scan(/!?\[[^\]\n]*\]\([^)\n]*\)/g, "markup"); // links + images, frozen whole
  scan(/^\[[^\]\n]+\]:\s+\S.*$/gm, "markup"); // reference definitions
  scan(/<https?:\/\/[^>\s]+>/g, "markup"); // autolinks
  for (const h of doc.headings) {
    add(h.offset, h.offset + (doc.lines[h.line - 1]?.length ?? 0), "markup");
  }
  scan(/\[[^\]\n]*@[^\]\n]*\]/g, "cite"); // [@key] groups (incl. [@a; @b])
  // Bare @key — the match includes one leading boundary char to strip.
  for (const m of text.matchAll(
    /(?:^|[\s(])(@[A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/gm,
  )) {
    const key = m[1] ?? "";
    const start = (m.index ?? 0) + m[0].length - key.length;
    add(start, start + key.length, "cite");
  }

  return (
    accepted
      .filter(
        (c) => c.start >= unit.span.startOffset && c.end <= unit.span.endOffset,
      )
      // Longest-first on a tie so a container precedes what is nested in it.
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .map((c, i) => ({
        kind: c.kind,
        token: `⟦P${i}⟧`,
        raw: text.slice(c.start, c.end),
        file: doc.entryFile,
        startOffset: c.start,
        endOffset: c.end,
      }))
  );
}
