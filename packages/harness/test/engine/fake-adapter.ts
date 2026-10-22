/**
 * A minimal in-harness DocumentAdapter/Workspace fake for engine tests —
 * paragraphs are blank-line-separated blocks, protected spans are \citep
 * occurrences. The harness must not depend on @lemmaria/adapters, so engine
 * unit tests stub the adapter contract instead (the CLI acceptance suite
 * exercises the real LatexAdapter).
 */

import type { ActionDefinition } from "../../src/contracts/actions.js";
import type {
  DocumentAdapter,
  ProtectedSpan,
  SemanticUnit,
  SourceSpan,
  Workspace,
} from "../../src/contracts/adapters.js";
import type { OutlineNode } from "../../src/contracts/tools.js";

export const FILE = "main.tex";
export const TEXT = [
  "\\section{Intro}\\label{sec:intro}", // line 1
  "",
  "First paragraph before.",
  "",
  "Target paragraph with \\citep{v17} inside.",
  "",
  "After paragraph one.",
  "",
].join("\n");

export const baseAction: ActionDefinition = {
  schema_version: "1",
  id: "polish",
  kind: "edit",
  version: "1.0.0",
  name: { en: "Polish" },
  prompt: { user: "{{selection}}" },
};

export function fakeAdapter(): DocumentAdapter {
  const paragraphs: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const block of TEXT.split("\n\n")) {
    paragraphs.push({ start: offset, end: offset + block.length });
    offset += block.length + 2;
  }
  return {
    kind: "latex",
    parseStructure(): Promise<OutlineNode[]> {
      return Promise.resolve([
        {
          title: "Intro",
          file: FILE,
          startLine: 1,
          endLine: 8,
          wordCount: 12,
          labels: ["sec:intro"],
          citations: ["v17"],
          children: [],
        },
      ]);
    },
    resolveSelection(
      selection: SourceSpan,
      scope: SemanticUnit["scope"],
    ): SemanticUnit {
      if (scope === "document") {
        return {
          scope,
          text: TEXT,
          span: { file: FILE, startOffset: 0, endOffset: TEXT.length },
        };
      }
      const p = paragraphs.find(
        (q) =>
          selection.startOffset >= q.start && selection.startOffset <= q.end,
      );
      if (!p) throw new Error("no paragraph at offset");
      return {
        scope: "paragraph",
        text: TEXT.slice(p.start, p.end),
        span: { file: FILE, startOffset: p.start, endOffset: p.end },
      };
    },
    protectedSpans(unit: SemanticUnit): ProtectedSpan[] {
      const spans: ProtectedSpan[] = [];
      let n = 0;
      for (const m of unit.text.matchAll(/\\citep\{[^}]*\}/g)) {
        const at = unit.span.startOffset + (m.index ?? 0);
        spans.push({
          kind: "cite",
          token: `⟦P${n}⟧`,
          raw: m[0],
          file: FILE,
          startOffset: at,
          endOffset: at + m[0].length,
        });
        n += 1;
      }
      return spans;
    },
    countWords(text: string) {
      return {
        language: "en" as const,
        unit: "words" as const,
        count: text.trim().split(/\s+/).filter(Boolean).length,
      };
    },
    verify: () => Promise.reject(new Error("M5")),
    citations: () => Promise.resolve([]),
    applyEdit: (_unit, replacement) => ({ newText: replacement }),
  };
}

export function fakeWorkspace(): Workspace {
  return {
    root: "/proj",
    readFile: () => Promise.resolve(TEXT),
    writeWorkingCopy: () => Promise.resolve(),
    listFiles: () => Promise.resolve([FILE]),
    compile: () => Promise.reject(new Error("M5")),
  };
}
