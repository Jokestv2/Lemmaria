import type { SemanticUnit } from "@lemmaria/harness";
import type { LatexProject } from "./project.js";

/**
 * Offset splice on the raw source (ADR 0004): anchor-checked, never re-stringified.
 * Returns the whole new file text; NEVER writes anywhere (the host owns the diff gate).
 */
export function applyEditIn(
  project: LatexProject,
  unit: SemanticUnit,
  replacement: string,
): { newText: string } {
  const file = project.file(unit.span.file);
  const src = file.source;
  const { startOffset, endOffset } = unit.span;
  // An inverted or out-of-bounds span would slice to "" and slip past the
  // anchor check below, then duplicate bytes on splice — refuse it outright.
  if (startOffset < 0 || endOffset > src.length || startOffset > endOffset) {
    throw new Error(
      `applyEdit: invalid span [${startOffset}, ${endOffset}) for ` +
        `"${unit.span.file}" (${src.length} chars)`,
    );
  }
  const current = src.slice(startOffset, endOffset);
  if (current !== unit.text) {
    throw new Error(
      `applyEdit: stale unit — "${unit.span.file}" changed under the proposal ` +
        `(expected ${unit.text.length} chars at [${unit.span.startOffset}, ${unit.span.endOffset}))`,
    );
  }
  return {
    newText:
      src.slice(0, unit.span.startOffset) +
      replacement +
      src.slice(unit.span.endOffset),
  };
}
