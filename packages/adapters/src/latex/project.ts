import type * as Ast from "@unified-latex/unified-latex-types";
import { attachMacroArgs } from "@unified-latex/unified-latex-util-arguments";
import { listNewcommands } from "@unified-latex/unified-latex-util-macros";
import { getParser } from "@unified-latex/unified-latex-util-parse";
import { type BibEntry, parseBibtex, resolveBibPaths } from "./bib.js";
import { argText } from "./span-utils.js";
import { walkAll } from "./walk.js";

/** Structural subset of the Workspace port — all I/O the adapter ever does. */
export interface FileReader {
  readFile(relPath: string): Promise<string>;
}

export interface LatexFile {
  path: string;
  source: string;
  ast: Ast.Root;
}

/** A discovered + parsed bibliography file (M7 citation checking). */
export interface BibFile {
  path: string;
  source: string;
  entries: BibEntry[];
}

/** natbib + biblatex + core cite commands ("s o o m" is a safe superset). */
export const CITE_MACROS: Record<string, { signature: string }> =
  Object.fromEntries(
    [
      "cite",
      "citep",
      "citet",
      "citealp",
      "citealt",
      "citeauthor",
      "citeyear",
      "citeyearpar",
      "Citep",
      "Citet",
      "parencite",
      "textcite",
      "autocite",
      "footcite",
    ].map((name) => [name, { signature: "s o o m" }]),
  );

export const REF_MACROS: Record<string, { signature: string }> =
  Object.fromEntries(
    ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref", "label"].map(
      (name) => [name, { signature: "m" }],
    ),
  );

const INPUT_MACROS: Record<string, { signature: string }> = {
  input: { signature: "m" },
  include: { signature: "m" },
};

/** Bibliography-declaration macros — their argument names the .bib file(s). */
const BIB_MACROS: Record<string, { signature: string }> = {
  bibliography: { signature: "m" },
  addbibresource: { signature: "o m" },
};

/**
 * Non-prose markup whose ARGUMENT text should freeze along with the command, so
 * a section title or bold run is neither counted by word_count nor rewritten by
 * shrink/translate (product feedback: "only focus on the content"). Registering
 * signatures lets attachMacroArgs bind the braces so macroFullSpan captures the
 * whole construct; macros absent here still freeze by name (their argument text
 * stays editable prose). "s o m" = optional star + optional short-title + title.
 */
export const NON_PROSE_MACROS: Record<string, { signature: string }> =
  Object.fromEntries([
    ...[
      "part",
      "chapter",
      "section",
      "subsection",
      "subsubsection",
      "paragraph",
      "subparagraph",
    ].map((name) => [name, { signature: "s o m" }]),
    ...["title", "author", "date", "thanks", "caption"].map((name) => [
      name,
      { signature: "o m" },
    ]),
    ...["footnote"].map((name) => [name, { signature: "o m" }]),
    ...[
      "textbf",
      "textit",
      "texttt",
      "textsf",
      "textrm",
      "textsl",
      "textup",
      "textmd",
      "textnormal",
      "textsc",
      "emph",
      "underline",
      "uppercase",
      "lowercase",
    ].map((name) => [name, { signature: "m" }]),
  ]);

/** Directory portion of a workspace-relative path ("" for a root-level file). */
function dirOf(p: string): string {
  const norm = p.replaceAll("\\", "/");
  const i = norm.lastIndexOf("/");
  return i < 0 ? "" : norm.slice(0, i);
}

/**
 * Join a child reference to its base directory and normalize `.`/`..` segments.
 * LaTeX resolves \input / \bibliography relative to the main document's
 * directory, so `paper/main.tex` declaring `\bibliography{refs}` reads
 * `paper/refs.bib` — not `refs.bib` at the workspace root (M7 fix).
 */
function joinRel(baseDir: string, rel: string): string {
  const parts = `${baseDir}/${rel.replaceAll("\\", "/")}`.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function resolveInputPath(baseDir: string, raw: string): string {
  const trimmed = raw.trim();
  const withExt = /\.[^/\\.]+$/.test(trimmed) ? trimmed : `${trimmed}.tex`;
  return joinRel(baseDir, withExt);
}

/**
 * Discover `.bib` files declared by \bibliography / \addbibresource across every
 * parsed .tex, read + parse them. A missing/unreadable .bib is recorded, never
 * thrown (M7 citation checking must degrade gracefully on a broken project).
 */
async function loadBibliographies(
  reader: FileReader,
  files: Map<string, LatexFile>,
  entryDir: string,
): Promise<{ bibliographies: BibFile[]; missingBibs: string[] }> {
  const paths: string[] = [];
  for (const file of files.values()) {
    walkAll(file.ast.content, (node) => {
      if (node.type !== "macro") return;
      const kind =
        node.content === "bibliography"
          ? "bibliography"
          : node.content === "addbibresource"
            ? "addbibresource"
            : undefined;
      if (!kind) return;
      for (const p of resolveBibPaths(argText(node, -1), kind)) {
        const resolved = joinRel(entryDir, p);
        if (!paths.includes(resolved)) paths.push(resolved);
      }
    });
  }
  const bibliographies: BibFile[] = [];
  const missingBibs: string[] = [];
  for (const path of paths) {
    let source: string;
    try {
      source = await reader.readFile(path);
    } catch {
      missingBibs.push(path);
      continue;
    }
    bibliographies.push({ path, source, entries: parseBibtex(source) });
  }
  return { bibliographies, missingBibs };
}

export class LatexProject {
  private constructor(
    readonly entryFile: string,
    readonly files: Map<string, LatexFile>,
    readonly missingInputs: string[],
    readonly newcommands: Array<{ name: string; signature: string }>,
    readonly bibliographies: BibFile[],
    readonly missingBibs: string[],
  ) {}

  static async load(
    reader: FileReader,
    entryFile: string,
  ): Promise<LatexProject> {
    const parser = getParser();
    const entryDir = dirOf(entryFile);
    const files = new Map<string, LatexFile>();
    const missing: string[] = [];
    const queue = [entryFile];
    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (files.has(path)) continue;
      let source: string;
      try {
        source = await reader.readFile(path);
      } catch {
        if (path !== entryFile) {
          missing.push(path);
          continue;
        }
        throw new Error(`LatexProject: cannot read entry file "${path}"`);
      }
      const ast = parser.parse(source);
      attachMacroArgs(ast, { ...INPUT_MACROS, ...BIB_MACROS });
      files.set(path, { path, source, ast });
      walkAll(ast.content, (node) => {
        if (
          node.type === "macro" &&
          (node.content === "input" || node.content === "include")
        ) {
          queue.push(resolveInputPath(entryDir, argText(node, -1)));
        }
      });
    }

    const newcommands: Array<{ name: string; signature: string }> = [];
    for (const file of files.values()) {
      for (const nc of listNewcommands(file.ast)) {
        newcommands.push({ name: nc.name, signature: nc.signature });
      }
    }
    const signatures: Record<string, { signature: string }> = {
      ...CITE_MACROS,
      ...REF_MACROS,
      ...NON_PROSE_MACROS,
    };
    for (const nc of newcommands)
      signatures[nc.name] = { signature: nc.signature };
    for (const file of files.values()) attachMacroArgs(file.ast, signatures);

    const { bibliographies, missingBibs } = await loadBibliographies(
      reader,
      files,
      entryDir,
    );

    return new LatexProject(
      entryFile,
      files,
      missing,
      newcommands,
      bibliographies,
      missingBibs,
    );
  }

  /** Every \cite-family key used anywhere in the project (document order, deduped). */
  citedKeys(): string[] {
    const seen = new Set<string>();
    for (const { node } of this.flatten()) {
      walkAll([node], (n) => {
        if (n.type === "macro" && Object.hasOwn(CITE_MACROS, n.content)) {
          for (const key of argText(n, -1).split(",")) {
            const k = key.trim();
            if (k) seen.add(k);
          }
        }
      });
    }
    return [...seen];
  }

  file(path: string): LatexFile {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(
        `LatexProject: "${path}" is not part of this project (entry ${this.entryFile})`,
      );
    }
    return file;
  }

  /**
   * Document-order stream: \input/\include splice their target file's items;
   * the `document` environment is transparent; everything else is atomic.
   */
  /**
   * Every file of this project in **reading order** — the order a person
   * reads the paper, not the order the loader happened to discover it
   * (ADR 0074 §4).
   *
   * `files` is BFS order, which for `main → {intro, method}` where `intro`
   * itself `\input`s `defs` puts `method` before `defs`. Document order is
   * recoverable from `flatten()`, whose depth-first splice at each `\input`
   * site makes each file's FIRST appearance its position in the paper — it was
   * simply never exposed as a path list.
   *
   * Three groups, concatenated and de-duplicated:
   *  1. the entry, always first — it is the seat's `defaultFile`;
   *  2. every other file in first-appearance order of `flatten()`;
   *  3. any `files` key `flatten()` never emitted, in `files` order. A file
   *     that contributes no AST node — empty, or only comments — is real and
   *     included, and it is the one thing `flatten()` structurally cannot see;
   *  4. the bibliographies, last. They are not prose and nothing `\input`s
   *     them, but a concern about a `.bib` entry quotes the `.bib`.
   */
  readingOrder(): string[] {
    const order: string[] = [this.entryFile];
    const seen = new Set(order);
    const add = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      order.push(path);
    };
    for (const { file } of this.flatten()) add(file);
    for (const path of this.files.keys()) add(path);
    for (const bib of this.bibliographies) add(bib.path);
    return order;
  }

  flatten(): Array<{ file: string; node: Ast.Node }> {
    const entryDir = dirOf(this.entryFile);
    const items: Array<{ file: string; node: Ast.Node }> = [];
    const visiting = new Set<string>();
    const emit = (path: string, nodes: Ast.Node[]): void => {
      for (const node of nodes) {
        if (
          node.type === "macro" &&
          (node.content === "input" || node.content === "include")
        ) {
          const target = resolveInputPath(entryDir, argText(node, -1));
          if (this.files.has(target) && !visiting.has(target)) {
            visiting.add(target);
            emit(target, this.file(target).ast.content);
            visiting.delete(target);
          }
          continue;
        }
        if (node.type === "environment" && String(node.env) === "document") {
          emit(path, node.content as Ast.Node[]);
          continue;
        }
        items.push({ file: path, node });
      }
    };
    visiting.add(this.entryFile);
    emit(this.entryFile, this.file(this.entryFile).ast.content);
    return items;
  }
}
