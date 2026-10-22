import type { OutlineNode } from "@lemmaria/harness";
import type * as Ast from "@unified-latex/unified-latex-types";
import { countWords } from "./count-words.js";
import type { LatexProject } from "./project.js";
import { CITE_MACROS } from "./project.js";
import { extractProse } from "./prose.js";
import { argText } from "./span-utils.js";
import { walkAll } from "./walk.js";

export const HEADING_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
};

interface HeadingItem {
  index: number;
  level: number;
  node: Ast.Macro;
  file: string;
}

/** Section tree across \input — the CM2 Repo Map source (contract OutlineNode). */
export function buildStructure(project: LatexProject): OutlineNode[] {
  const stream = project.flatten();
  const headings: HeadingItem[] = [];
  stream.forEach(({ file, node }, index) => {
    if (
      node.type === "macro" &&
      Object.hasOwn(HEADING_LEVELS, node.content) &&
      node.position
    ) {
      headings.push({
        index,
        level: HEADING_LEVELS[node.content] as number,
        node,
        file,
      });
    }
  });

  const buildRange = (h: HeadingItem, endIndex: number): OutlineNode => {
    const rangeNodes: Ast.Node[] = [];
    let endLine = h.node.position?.end.line ?? 1;
    for (let i = h.index; i < endIndex; i++) {
      const item = stream[i] as { file: string; node: Ast.Node };
      if (i > h.index) rangeNodes.push(item.node);
      // Trailing blank lines before the next heading are not section content.
      const isBlank =
        item.node.type === "parbreak" || item.node.type === "whitespace";
      if (item.file === h.file && item.node.position && !isBlank) {
        endLine = Math.max(endLine, item.node.position.end.line);
      }
    }
    const labels: string[] = [];
    const citations: string[] = [];
    walkAll(rangeNodes, (n) => {
      if (n.type !== "macro") return;
      if (n.content === "label") labels.push(argText(n, -1).trim());
      if (Object.hasOwn(CITE_MACROS, n.content)) {
        for (const key of argText(n, -1).split(",")) {
          const trimmed = key.trim();
          if (trimmed && !citations.includes(trimmed)) citations.push(trimmed);
        }
      }
    });
    return {
      title: argText(h.node, -1),
      file: h.file,
      startLine: h.node.position?.start.line ?? 1,
      endLine,
      wordCount: countWords(extractProse(rangeNodes)).count,
      labels,
      citations,
      children: [],
    };
  };

  const roots: OutlineNode[] = [];
  const parents: Array<{ level: number; node: OutlineNode }> = [];
  headings.forEach((h, hi) => {
    const next = headings.slice(hi + 1).find((other) => other.level <= h.level);
    const node = buildRange(h, next ? next.index : stream.length);
    while (
      parents.length > 0 &&
      (parents.at(-1) as { level: number }).level >= h.level
    ) {
      parents.pop();
    }
    const parent = parents.at(-1);
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    parents.push({ level: h.level, node });
  });
  return roots;
}
