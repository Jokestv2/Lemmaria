import type {
  DocumentAdapter,
  DocumentClass,
  OutlineNode,
  ProtectedSpan,
  SemanticUnit,
  SourceSpan,
  Warning,
  WordCount,
  Workspace,
} from "@lemmaria/harness";
import { applyEditIn } from "./apply-edit.js";
import { type CompileLogSource, parseCompileLog } from "./compile-log.js";
import { countWords } from "./count-words.js";
import {
  type LatexFeatures,
  detectBibliographyStyle,
  detectDocumentClass,
  detectLatexFeatures,
} from "./detect.js";
import { type FileReader, LatexProject } from "./project.js";
import { collectProtectedSpans } from "./protected-spans.js";
import { resolveSelectionIn } from "./selection.js";
import { buildStructure } from "./structure.js";

/**
 * The LaTeX DocumentAdapter: an immutable snapshot of the project at load time.
 * After an accepted edit, the host loads a fresh adapter (offsets shift — ADR 0004).
 */
/**
 * Binds `verify()` to a host compile capability (M5). The host resolves the
 * engine (harness `resolveEngine`) and injects it with the Workspace; the
 * adapter compiles the current working-copy overlay and parses the log.
 */
export interface LatexVerifyBinding {
  workspace: Pick<Workspace, "compile">;
  engine: string;
}

export class LatexAdapter implements DocumentAdapter {
  readonly kind = "latex" as const;
  readonly features: LatexFeatures;

  private constructor(
    readonly project: LatexProject,
    private readonly verifyBinding?: LatexVerifyBinding,
  ) {
    this.features = detectLatexFeatures(project);
  }

  static async load(
    reader: FileReader,
    entryFile: string,
    verify?: LatexVerifyBinding,
  ): Promise<LatexAdapter> {
    return new LatexAdapter(await LatexProject.load(reader, entryFile), verify);
  }

  parseStructure(): Promise<OutlineNode[]> {
    return Promise.resolve(buildStructure(this.project));
  }

  resolveSelection(
    selection: SourceSpan,
    scope: SemanticUnit["scope"],
  ): SemanticUnit {
    return resolveSelectionIn(this.project, selection, scope);
  }

  protectedSpans(unit: SemanticUnit): ProtectedSpan[] {
    return collectProtectedSpans(this.project, unit);
  }

  countWords(text: string): WordCount {
    return countWords(text);
  }

  /**
   * Compile engines this project prefers, best first — the document half of
   * Compile Check's engine resolution. CJK projects (ctex/xeCJK) need a
   * Unicode engine; everything else routes to pdflatex. The host filters this
   * by binary availability (see harness `resolveEngine`).
   */
  preferredEngines(): string[] {
    return this.features.engine === "xelatex"
      ? ["xelatex", "lualatex"]
      : ["pdflatex"];
  }

  /** Venue/template detection (schema §5 {{venue}}, ADR 0010). */
  documentClass(): DocumentClass | undefined {
    return detectDocumentClass(this.project);
  }

  /** Non-contract (like bibEntries): the project's \bibliographystyle, if any (U4). */
  bibliographyStyle(): string | undefined {
    return detectBibliographyStyle(this.project);
  }

  /**
   * Compile the current working-copy overlay through the injected host engine
   * and parse the log into warnings (M5). Baseline-agnostic — the host calls
   * this directly as the Compile Check response to a user request (ADR 0013).
   * Throws if no compile capability was bound at load.
   */
  async verify(): Promise<{ ok: boolean; warnings: Warning[] }> {
    if (!this.verifyBinding) {
      throw new Error(
        "LatexAdapter.verify: no compile engine bound — load the adapter with a verify binding",
      );
    }
    const { workspace, engine } = this.verifyBinding;
    const { ok, log } = await workspace.compile(engine);
    const source: CompileLogSource =
      engine === "tectonic" ? "tectonic" : "latexmk";
    return {
      ok,
      warnings: parseCompileLog(log, {
        source,
        entryFile: this.project.entryFile,
      }),
    };
  }

  /**
   * Every parsed .bib entry, tagged with its source file + line (M7). Richer than
   * the contract `citations()`; C1 consistency checking needs the attribution.
   */
  bibEntries(): Array<{
    key: string;
    type: string;
    fields: Record<string, string>;
    file: string;
    line: number;
  }> {
    return this.project.bibliographies.flatMap((b) =>
      b.entries.map((e) => ({
        key: e.key,
        type: e.type,
        fields: e.fields,
        file: b.path,
        line: e.line,
      })),
    );
  }

  /** Every \cite-family key used across the project (deduped, document order). */
  citedKeys(): string[] {
    return this.project.citedKeys();
  }

  citations(): Promise<{ key: string; fields: Record<string, string> }[]> {
    return Promise.resolve(
      this.bibEntries().map(({ key, fields }) => ({ key, fields })),
    );
  }

  applyEdit(unit: SemanticUnit, replacement: string): { newText: string } {
    return applyEditIn(this.project, unit, replacement);
  }
}

export const loadLatexAdapter = LatexAdapter.load.bind(LatexAdapter);
