import type { SemanticUnit, SourceSpan } from "@lemmaria/harness";
import type * as Ast from "@unified-latex/unified-latex-types";
import type { LatexProject } from "./project.js";
import { macroFullSpan } from "./span-utils.js";
import { HEADING_LEVELS } from "./structure.js";
import { walkAll } from "./walk.js";

interface Range {
  start: number;
  end: number;
}

/**
 * A `\label{…}` trailing a heading on the same line belongs to the heading,
 * not to the paragraph below it — extend the boundary past such labels.
 */
function extendPastLabels(src: string, end: number): number {
  let i = end;
  for (;;) {
    let j = i;
    while (j < src.length && (src.charAt(j) === " " || src.charAt(j) === "\t"))
      j += 1;
    if (src.startsWith("\\label{", j)) {
      const close = src.indexOf("}", j + 7);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    }
    return i;
  }
}

/**
 * Offsets of an environment's inner content (between its `\begin{…}` and
 * `\end{…}` delimiters), from its first/last positioned child. Returns undefined
 * for an empty environment.
 */
function contentBounds(node: Ast.Environment): Range | undefined {
  const positioned = node.content.filter((c) => c.position);
  const first = positioned[0]?.position;
  const last = positioned.at(-1)?.position;
  if (!first || !last) return undefined;
  return { start: first.start.offset, end: last.end.offset };
}

function trimToContent(src: string, range: Range): Range {
  let { start, end } = range;
  while (start < end && /\s/.test(src.charAt(start))) start += 1;
  while (end > start && /\s/.test(src.charAt(end - 1))) end -= 1;
  return { start, end };
}

function unit(
  scope: SemanticUnit["scope"],
  file: string,
  src: string,
  range: Range,
): SemanticUnit {
  return {
    scope,
    text: src.slice(range.start, range.end),
    span: { file, startOffset: range.start, endOffset: range.end },
  };
}

/** Selection → smallest enclosing semantic unit (contract resolveSelection). */
export function resolveSelectionIn(
  project: LatexProject,
  selection: SourceSpan,
  scope: SemanticUnit["scope"],
): SemanticUnit {
  const file = project.file(selection.file);
  const src = file.source;
  // Hosts may deliver anchor/active inverted — normalize before any span math.
  const a = Math.max(0, Math.min(selection.startOffset, src.length));
  const b = Math.max(0, Math.min(selection.endOffset, src.length));
  const sel: Range = { start: Math.min(a, b), end: Math.max(a, b) };

  switch (scope) {
    case "selection":
      return unit(scope, file.path, src, sel);
    case "document":
      return unit(scope, file.path, src, { start: 0, end: src.length });
    case "environment": {
      let best: Ast.Node | undefined;
      walkAll(file.ast.content, (node) => {
        if (
          node.type !== "environment" &&
          node.type !== "mathenv" &&
          node.type !== "verbatim"
        ) {
          return;
        }
        // The document environment encloses everything; scope "document" covers it.
        if (node.type === "environment" && String(node.env) === "document")
          return;
        const pos = node.position;
        if (!pos) return;
        if (pos.start.offset <= sel.start && sel.end <= pos.end.offset) {
          if (
            !best?.position ||
            pos.end.offset - pos.start.offset <
              best.position.end.offset - best.position.start.offset
          ) {
            best = node;
          }
        }
      });
      const pos = best?.position;
      if (!pos) throw new Error("resolveSelection: no enclosing environment");
      return unit(scope, file.path, src, {
        start: pos.start.offset,
        end: pos.end.offset,
      });
    }
    case "section": {
      const headings: Array<Range & { level: number }> = [];
      walkAll(file.ast.content, (node) => {
        if (
          node.type === "macro" &&
          Object.hasOwn(HEADING_LEVELS, node.content) &&
          node.position
        ) {
          headings.push({
            ...macroFullSpan(src, node),
            level: HEADING_LEVELS[node.content] as number,
          });
        }
      });
      headings.sort((a, b) => a.start - b.start);
      const containing = [...headings]
        .reverse()
        .find((h) => h.start <= sel.start);
      if (!containing)
        return unit("document", file.path, src, { start: 0, end: src.length });
      // The last section must not swallow \end{document}: bound by the last
      // positioned node INSIDE the document environment, when there is one.
      let contentEnd = src.length;
      walkAll(file.ast.content, (node) => {
        if (node.type === "environment" && String(node.env) === "document") {
          for (const child of node.content) {
            if (child.position) contentEnd = child.position.end.offset;
          }
        }
      });
      // A section unit includes its subsections: it ends at the next heading
      // of the same or a higher rank, not at the first child heading.
      const next = headings.find(
        (h) => h.start > containing.start && h.level <= containing.level,
      );
      return unit(
        scope,
        file.path,
        src,
        trimToContent(src, {
          start: containing.start,
          end: next ? next.start : Math.max(contentEnd, containing.start),
        }),
      );
    }
    case "paragraph": {
      const boundaries: Range[] = [];
      walkAll(file.ast.content, (node) => {
        if (node.type === "parbreak" && node.position) {
          boundaries.push({
            start: node.position.start.offset,
            end: node.position.end.offset,
          });
        }
        if (
          node.type === "macro" &&
          Object.hasOwn(HEADING_LEVELS, node.content) &&
          node.position
        ) {
          const span = macroFullSpan(src, node);
          boundaries.push({
            start: span.start,
            end: extendPastLabels(src, span.end),
          });
        }
        // A paragraph must never cross the document environment's delimiters:
        // the blank lines hugging \begin{document}/\end{document} are absorbed
        // (no parbreak node), so without this a body with no interior boundary
        // (e.g. a typo'd heading) resolves to the WHOLE environment, delimiters
        // included — which lets an edit duplicate or drop \end{document}.
        if (
          node.type === "environment" &&
          String(node.env) === "document" &&
          node.position
        ) {
          const inner = contentBounds(node);
          if (inner) {
            boundaries.push({
              start: node.position.start.offset,
              end: inner.start,
            });
            boundaries.push({
              start: inner.end,
              end: node.position.end.offset,
            });
          }
        }
      });
      boundaries.sort((a, b) => a.start - b.start);
      let start = 0;
      let end = src.length;
      for (const b of boundaries) {
        if (b.end <= sel.start) start = Math.max(start, b.end);
        if (b.start >= sel.end) end = Math.min(end, b.start);
      }
      return unit(scope, file.path, src, trimToContent(src, { start, end }));
    }
  }
}
