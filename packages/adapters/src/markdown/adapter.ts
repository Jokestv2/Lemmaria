/**
 * The Markdown DocumentAdapter (M8): heading-tree structure, protected spans
 * (math handled as LaTeX), bilingual word counting (reused from the LaTeX
 * adapter — pure text), pandoc-style citations backed by the frontmatter
 * `bibliography:` (the M7 BibTeX parser), offset-splice applyEdit, and a
 * PURE structural parse-check verify (the product does not render Markdown;
 * there is no compile step — product-design "Markdown projects").
 * Like the LatexAdapter, an instance is an immutable snapshot of the project
 * at load time; hosts reload after an accepted edit.
 */

import { createHash } from "node:crypto";
import type {
  DocumentAdapter,
  OutlineNode,
  ProtectedSpan,
  SemanticUnit,
  SourceSpan,
  Warning,
  WordCount,
} from "@lemmaria/harness";
import { type BibEntry, parseBibtex } from "../latex/bib.js";
import { countWords } from "../latex/count-words.js";
import type { FileReader } from "../latex/project.js";
import { MarkdownDocument } from "./document.js";
import { collectMarkdownProtectedSpans } from "./protected-spans.js";
import { resolveMarkdownSelection } from "./selection.js";
import { buildMarkdownStructure, citeKeysIn } from "./structure.js";

interface LoadedBib {
  path: string;
  entries: BibEntry[];
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinRel(dir: string, rel: string): string {
  if (dir === "" || rel.startsWith("/")) return rel.replace(/^\//, "");
  const parts = `${dir}/${rel}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function warningId(code: string, file: string, message: string): string {
  return createHash("sha1").update(`${code}|${file}|${message}`).digest("hex");
}

export class MarkdownAdapter implements DocumentAdapter {
  readonly kind = "markdown" as const;

  private constructor(
    private readonly doc: MarkdownDocument,
    private readonly bibs: LoadedBib[],
    private readonly missingBibs: string[],
  ) {}

  static async load(
    reader: FileReader,
    entryFile: string,
  ): Promise<MarkdownAdapter> {
    const doc = await MarkdownDocument.load(reader, entryFile);
    const bibs: LoadedBib[] = [];
    const missing: string[] = [];
    for (const rel of doc.frontmatter?.bibliography ?? []) {
      // Paths resolve against the entry file's directory (matching the M7
      // LaTeX fix — the document's own dir, not the workspace root).
      const path = joinRel(dirOf(entryFile), rel);
      try {
        bibs.push({ path, entries: parseBibtex(await reader.readFile(path)) });
      } catch {
        missing.push(path);
      }
    }
    return new MarkdownAdapter(doc, bibs, missing);
  }

  parseStructure(): Promise<OutlineNode[]> {
    return Promise.resolve(buildMarkdownStructure(this.doc));
  }

  resolveSelection(
    selection: SourceSpan,
    scope: SemanticUnit["scope"],
  ): SemanticUnit {
    return resolveMarkdownSelection(this.doc, selection, scope);
  }

  protectedSpans(unit: SemanticUnit): ProtectedSpan[] {
    return collectMarkdownProtectedSpans(this.doc, unit);
  }

  countWords(text: string): WordCount {
    return countWords(text);
  }

  /**
   * Structural parse-check — Markdown has no compile step, so verify() needs
   * no engine binding and never touches the network: an unclosed fence is an
   * error; odd display-math delimiters and unresolvable frontmatter
   * bibliography files are warnings. Same unified Warning shape as compile.
   */
  verify(): Promise<{ ok: boolean; warnings: Warning[] }> {
    const warnings: Warning[] = [];
    const file = this.doc.entryFile;
    for (const f of this.doc.fences) {
      if (!f.unclosed) continue;
      const message = `code fence opened on line ${f.startLine} is never closed`;
      warnings.push({
        id: warningId("unclosed-fence", file, message),
        source: "markdown",
        severity: "error",
        code: "unclosed-fence",
        message,
        file,
        line: f.startLine,
      });
    }
    // Display math outside fences: an odd number of $$ marks an open block.
    const outsideFences = this.doc.lines
      .map((line, i) =>
        this.doc.fences.some(
          (f) => i + 1 >= f.startLine && i + 1 <= f.endLine,
        ) || i + 1 <= (this.doc.frontmatter?.endLine ?? 0)
          ? ""
          : line,
      )
      .join("\n");
    if ((outsideFences.match(/\$\$/g) ?? []).length % 2 === 1) {
      const message = "unbalanced $$ display-math delimiters";
      warnings.push({
        id: warningId("unclosed-display-math", file, message),
        source: "markdown",
        severity: "warning",
        code: "unclosed-display-math",
        message,
        file,
      });
    }
    for (const path of this.missingBibs) {
      const message = `frontmatter bibliography "${path}" was not found`;
      warnings.push({
        id: warningId("missing-bibliography-file", file, message),
        source: "markdown",
        severity: "warning",
        code: "missing-bibliography-file",
        message,
        file,
      });
    }
    return Promise.resolve({
      ok: warnings.every((w) => w.severity !== "error"),
      warnings,
    });
  }

  /**
   * The bibliography files this document declares, workspace-relative and
   * already resolved against the entry's directory — in front-matter order
   * (X5, ADR 0074 §4).
   *
   * Exposed because the manuscript graph needs the paths themselves, not the
   * entries parsed out of them: `LatexProject.bibliographies` is public for
   * the same reason, and this is the Markdown side of that parity.
   */
  bibliographyPaths(): string[] {
    return this.bibs.map((b) => b.path);
  }

  /** Declared bibliographies that did not read — reported, never thrown. */
  missingBibliographies(): string[] {
    return [...this.missingBibs];
  }

  /** Every parsed .bib entry with file+line attribution (C1 parity with LaTeX). */
  bibEntries(): Array<{
    key: string;
    type: string;
    fields: Record<string, string>;
    file: string;
    line: number;
  }> {
    return this.bibs.flatMap((b) =>
      b.entries.map((e) => ({
        key: e.key,
        type: e.type,
        fields: e.fields,
        file: b.path,
        line: e.line,
      })),
    );
  }

  /** Pandoc cite keys used in the document, outside fences, document order. */
  citedKeys(): string[] {
    const outside = this.doc.lines
      .map((line, i) =>
        this.doc.fences.some((f) => i + 1 >= f.startLine && i + 1 <= f.endLine)
          ? ""
          : line,
      )
      .join("\n");
    return citeKeysIn(outside);
  }

  citations(): Promise<{ key: string; fields: Record<string, string> }[]> {
    return Promise.resolve(
      this.bibEntries().map(({ key, fields }) => ({ key, fields })),
    );
  }

  applyEdit(unit: SemanticUnit, replacement: string): { newText: string } {
    const current = this.doc.text.slice(
      unit.span.startOffset,
      unit.span.endOffset,
    );
    if (current !== unit.text) {
      throw new Error(
        "MarkdownAdapter.applyEdit: the unit's content anchor no longer matches the document (stale unit — reload the adapter)",
      );
    }
    return {
      newText:
        this.doc.text.slice(0, unit.span.startOffset) +
        replacement +
        this.doc.text.slice(unit.span.endOffset),
    };
  }
}

export const loadMarkdownAdapter = MarkdownAdapter.load.bind(MarkdownAdapter);
