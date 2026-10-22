import type * as Ast from "@unified-latex/unified-latex-types";

/**
 * Depth-first walk over EVERY node — content, environment bodies, and macro
 * args (unified-latex's visit() arg handling is version-sensitive; this walk
 * is the single traversal the adapter trusts).
 */
export function walkAll(
  node: Ast.Node | Ast.Node[],
  fn: (n: Ast.Node) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walkAll(child, fn);
    return;
  }
  fn(node);
  if ("content" in node && Array.isArray(node.content)) {
    walkAll(node.content as Ast.Node[], fn);
  }
  if ("args" in node && Array.isArray(node.args)) {
    for (const arg of node.args) walkAll(arg.content, fn);
  }
}
