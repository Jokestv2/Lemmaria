/**
 * The Markdown structure tree (CM2, M8): ATX headings nested by level. A
 * node's `wordCount` and `citations` cover its DIRECT content (the lines
 * between its heading and its first child heading) — children carry their own.
 * `labels` is always empty: Markdown has no \label (recorded M8 limit).
 */

import type { OutlineNode } from "@lemmaria/harness";
import { countWords } from "../latex/count-words.js";
import type { MarkdownDocument } from "./document.js";

/** Pandoc-style citation keys in a text slice: [@key], [@a; @b], bare @key.
 *  NOTE: a bare `@word` is inherently ambiguous in pandoc — prose like
 *  "contact @alice" reads as a cite key. We accept the false positive: it errs
 *  toward freezing/reporting, never toward corrupting. */
export function citeKeysIn(text: string): string[] {
  const keys: string[] = [];
  const push = (k: string | undefined) => {
    if (k && !keys.includes(k)) keys.push(k);
  };
  // Bracketed groups first: [@a; see @b, p. 3]
  for (const group of text.matchAll(/\[([^\]]*@[^\]]*)\]/g)) {
    for (const m of (group[1] ?? "").matchAll(
      /@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/g,
    )) {
      push(m[1]);
    }
  }
  // Bare keys: start-of-line/whitespace/( before @key
  const stripped = text.replace(/\[([^\]]*@[^\]]*)\]/g, " ");
  for (const m of stripped.matchAll(
    /(?:^|[\s(])@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/gm,
  )) {
    push(m[1]);
  }
  return keys;
}

export function buildMarkdownStructure(doc: MarkdownDocument): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Array<{ node: OutlineNode; level: number }> = [];
  const lastLine = doc.lines.length;

  const headings = doc.headings;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h) continue;
    // End = line before the next same-or-higher heading (or EOF).
    let endLine = lastLine;
    for (let j = i + 1; j < headings.length; j++) {
      const next = headings[j];
      if (next && next.level <= h.level) {
        endLine = next.line - 1;
        break;
      }
    }
    // Direct content = up to the FIRST child heading (any deeper level).
    const nextAny = headings[i + 1];
    const directEnd =
      nextAny && nextAny.line <= endLine ? nextAny.line - 1 : endLine;
    const direct = directContent(doc, h.line, directEnd);

    const node: OutlineNode = {
      title: h.title,
      file: doc.entryFile,
      startLine: h.line,
      endLine,
      wordCount: countWords(direct).count,
      labels: [],
      citations: citeKeysIn(direct),
      children: [],
    };
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= h.level) {
      stack.pop();
    }
    const parent = stack.at(-1)?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ node, level: h.level });
  }
  return roots;
}

/** The node's own prose: its lines minus the heading line and fenced blocks. */
function directContent(
  doc: MarkdownDocument,
  headingLine: number,
  endLine: number,
): string {
  const out: string[] = [];
  for (let line = headingLine + 1; line <= endLine; line++) {
    const inFence = doc.fences.some(
      (f) => line >= f.startLine && line <= f.endLine,
    );
    if (!inFence) out.push(doc.lines[line - 1] ?? "");
  }
  return out.join("\n");
}
