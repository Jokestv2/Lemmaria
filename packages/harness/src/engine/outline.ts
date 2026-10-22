/**
 * CM2 — the structure tree as a Repo Map (M8). One compact, depth-indented
 * line per section: title, file:line range, word count, contained labels and
 * cite keys. Serialized, a whole paper stays under ~1k tokens, giving L1/L2 a
 * resident map of "what the document looks like" without reading it all.
 * This is the `{{outline}}` template variable AND the `get_outline` tool body.
 */

import type { OutlineNode } from "../contracts/tools.js";

export function serializeOutline(nodes: OutlineNode[], depth = 0): string {
  return nodes
    .map((n) => {
      const labels =
        n.labels.length > 0 ? ` labels: ${n.labels.join(",")}` : "";
      const cites =
        n.citations.length > 0 ? ` cites: ${n.citations.join(",")}` : "";
      const line = `${"  ".repeat(depth)}- ${n.title} [${n.file}:${n.startLine}-${n.endLine}, ${n.wordCount}w]${labels}${cites}`;
      const children =
        n.children.length > 0
          ? `\n${serializeOutline(n.children, depth + 1)}`
          : "";
      return `${line}${children}`;
    })
    .join("\n");
}

/** Pre-order flattening — section lookup for read_span / list_labels. */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((n) => [n, ...flattenOutline(n.children)]);
}
