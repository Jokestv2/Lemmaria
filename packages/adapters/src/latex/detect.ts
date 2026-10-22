import type { DocumentClass } from "@lemmaria/harness";
import { printRaw } from "@unified-latex/unified-latex-util-print-raw";
import type { LatexFile, LatexProject } from "./project.js";
import { argText } from "./span-utils.js";
import { walkAll } from "./walk.js";

export interface LatexFeatures {
  ctex: boolean;
  xecjk: boolean;
  /** Engine hint for Compile Check's engine routing (Chinese projects need xelatex). */
  engine: "xelatex" | "pdflatex";
}

const CTEX_CLASSES = new Set(["ctexart", "ctexrep", "ctexbook", "ctexbeamer"]);

export function detectLatexFeatures(project: LatexProject): LatexFeatures {
  let ctex = false;
  let xecjk = false;
  for (const file of project.files.values()) {
    walkAll(file.ast.content, (node) => {
      if (node.type !== "macro") return;
      if (
        node.content === "documentclass" &&
        CTEX_CLASSES.has(argText(node, -1).trim())
      ) {
        ctex = true;
      }
      if (node.content === "usepackage") {
        const packages = argText(node, -1)
          .split(",")
          .map((p) => p.trim());
        if (packages.includes("ctex")) ctex = true;
        if (packages.includes("xeCJK")) xecjk = true;
      }
    });
  }
  return { ctex, xecjk, engine: ctex || xecjk ? "xelatex" : "pdflatex" };
}

/**
 * The ENTRY file's \documentclass[options]{class} — venue/template detection
 * (schema §5 {{venue}}, ADR 0010). \input children are deliberately ignored:
 * only the main document declares the class LaTeX actually uses.
 */
export function detectDocumentClass(
  project: LatexProject,
): DocumentClass | undefined {
  const entry = project.files.get(project.entryFile);
  if (!entry) return undefined;
  let found: DocumentClass | undefined;
  walkAll(entry.ast.content, (node) => {
    if (found || node.type !== "macro" || node.content !== "documentclass")
      return;
    const args = node.args ?? [];
    const classArg = args.find((a) => a.openMark === "{") ?? args.at(-1);
    const name = classArg ? printRaw(classArg.content).trim() : "";
    if (name === "") return;
    const optArg = args.find((a) => a.openMark === "[");
    const options = optArg
      ? printRaw(optArg.content)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : [];
    found = { name, options };
  });
  return found;
}

/**
 * The project's \bibliographystyle{...} argument — entry file first, then the
 * other parsed files; first hit wins; comment lines ignored. Deliberately a
 * source-text scan, NOT an AST walk: unified-latex has no signature bound for
 * \bibliographystyle, and binding one would change protected-span goldens.
 * biblatex (`\usepackage[style=…]{biblatex}`) is a recorded limit — the venue
 * library is .bst-based.
 */
export function detectBibliographyStyle(
  project: LatexProject,
): string | undefined {
  const ordered: LatexFile[] = [];
  const entry = project.files.get(project.entryFile);
  if (entry) ordered.push(entry);
  for (const file of project.files.values()) {
    if (file !== entry) ordered.push(file);
  }
  for (const file of ordered) {
    for (const rawLine of file.source.split("\n")) {
      const m = stripComment(rawLine).match(
        /\\bibliographystyle\s*\{([^}]*)\}/,
      );
      const style = m?.[1]?.trim();
      if (style) return style;
    }
  }
  return undefined;
}

/** Text before the first unescaped %. */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%" && line[i - 1] !== "\\") return line.slice(0, i);
  }
  return line;
}
