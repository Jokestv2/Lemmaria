/**
 * Markdown selection resolution (M8): map a cursor/selection to a semantic
 * unit. Paragraphs are blank-line-delimited runs of lines; a fenced code block
 * (and the frontmatter block) is ONE paragraph and never merges with prose; a
 * heading line is its own one-line block. `environment` maps to the enclosing
 * fence when inside one, else the paragraph (deliberate M8 mapping — Markdown
 * has no other environment notion; recorded in progress.md).
 */

import type { SemanticUnit, SourceSpan } from "@lemmaria/harness";
import type { MarkdownDocument } from "./document.js";

export function resolveMarkdownSelection(
  doc: MarkdownDocument,
  selection: SourceSpan,
  scope: SemanticUnit["scope"],
): SemanticUnit {
  switch (scope) {
    case "document":
      return unit(doc, "document", 0, doc.text.length);
    case "selection":
      return unit(doc, "selection", selection.startOffset, selection.endOffset);
    case "section":
      return sectionAt(doc, selection.startOffset);
    default:
      return paragraphAt(doc, selection.startOffset, scope);
  }
}

function unit(
  doc: MarkdownDocument,
  scope: SemanticUnit["scope"],
  start: number,
  end: number,
): SemanticUnit {
  return {
    scope,
    text: doc.text.slice(start, end),
    span: { file: doc.entryFile, startOffset: start, endOffset: end },
  };
}

function sectionAt(doc: MarkdownDocument, offset: number): SemanticUnit {
  const line = doc.lineOf(offset);
  let owner: (typeof doc.headings)[number] | undefined;
  for (const h of doc.headings) {
    if (h.line <= line) owner = h;
    else break;
  }
  if (!owner) return unit(doc, "document", 0, doc.text.length);
  let endLine = doc.lines.length;
  for (const h of doc.headings) {
    if (h.line > owner.line && h.level <= owner.level) {
      endLine = h.line - 1;
      break;
    }
  }
  return unit(doc, "section", owner.offset, endOfLine(doc, endLine));
}

function endOfLine(doc: MarkdownDocument, line: number): number {
  return doc.offsetOf(line) + (doc.lines[line - 1]?.length ?? 0);
}

function paragraphAt(
  doc: MarkdownDocument,
  offset: number,
  scope: SemanticUnit["scope"],
): SemanticUnit {
  const fenceHit = doc.fences.find(
    (f) => offset >= f.startOffset && offset <= f.endOffset,
  );
  if (fenceHit) {
    return unit(doc, scope, fenceHit.startOffset, fenceHit.endOffset);
  }

  const frontEnd = doc.frontmatter?.endLine ?? 0;
  const isBlock = (line: number): "blank" | "fence" | "heading" | "prose" => {
    if (line <= frontEnd) return "fence"; // frontmatter behaves like a fence
    if (doc.fences.some((f) => line >= f.startLine && line <= f.endLine)) {
      return "fence";
    }
    if ((doc.lines[line - 1] ?? "").trim() === "") return "blank";
    if (doc.headings.some((h) => h.line === line)) return "heading";
    return "prose";
  };

  let line = doc.lineOf(offset);
  // A cursor on a blank line resolves to the next block below (best-effort).
  while (line <= doc.lines.length && isBlock(line) === "blank") line += 1;
  if (line > doc.lines.length) {
    return unit(doc, scope, offset, offset);
  }
  const kind = isBlock(line);
  if (kind === "fence") {
    const f = doc.fences.find((q) => line >= q.startLine && line <= q.endLine);
    if (f) return unit(doc, scope, f.startOffset, f.endOffset);
    // frontmatter
    return unit(doc, scope, 0, endOfLine(doc, frontEnd));
  }
  if (kind === "heading") {
    return unit(doc, scope, doc.offsetOf(line), endOfLine(doc, line));
  }
  let start = line;
  while (start > 1 && isBlock(start - 1) === "prose") start -= 1;
  let end = line;
  while (end < doc.lines.length && isBlock(end + 1) === "prose") end += 1;
  return unit(doc, scope, doc.offsetOf(start), endOfLine(doc, end));
}
