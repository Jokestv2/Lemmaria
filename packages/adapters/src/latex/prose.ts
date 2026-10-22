import type * as Ast from "@unified-latex/unified-latex-types";
import { CITE_MACROS, REF_MACROS } from "./project.js";

/** Macros whose args are NOT prose (keys, paths, URLs, preamble config). */
const SKIP_ARGS = new Set([
  ...Object.keys(CITE_MACROS),
  ...Object.keys(REF_MACROS),
  "input",
  "include",
  "includegraphics",
  "url",
  "href",
  "bibliography",
  "bibliographystyle",
  "usepackage",
  "documentclass",
  "newcommand",
  "renewcommand",
  "newenvironment",
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "begin",
  "end",
]);

/**
 * Natural-language text of a node range, for word counting: strings count;
 * math/verbatim/comments don't; styled macros contribute their arg text,
 * reference-like macros contribute nothing.
 */
export function extractProse(nodes: Ast.Node[]): string {
  const parts: string[] = [];
  const walk = (node: Ast.Node): void => {
    switch (node.type) {
      case "string":
        parts.push(node.content);
        break;
      case "whitespace":
      case "parbreak":
        parts.push(" ");
        break;
      case "group":
        for (const child of node.content) walk(child);
        break;
      case "environment":
        for (const child of node.content) walk(child);
        break;
      case "macro":
        if (!SKIP_ARGS.has(node.content)) {
          for (const arg of node.args ?? []) {
            for (const child of arg.content) walk(child);
          }
        }
        break;
      default:
        break; // inlinemath, displaymath, mathenv, verbatim, verb, comment
    }
  };
  for (const node of nodes) walk(node);
  return parts.join("");
}
