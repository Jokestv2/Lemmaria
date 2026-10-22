/**
 * The stateless fragment protected-span detector (D1, ADR 0032).
 *
 * `DocumentAdapter.protectedSpans(unit)` is bound to a LOADED project: the
 * LaTeX implementation calls `project.file(unit.span.file)`, which throws for
 * any path not reachable from the entry, and its AST is a snapshot taken at
 * load time. Neither property survives the agentic path, where `propose_edit`
 * may target any workspace file and an earlier edit in the same task has
 * already changed the bytes underneath.
 *
 * So this takes TEXT and nothing else. It parses what it is handed, over a
 * throwaway single-file project, and delegates to the same two collectors the
 * quick-action path uses — so the answer is the quick-action answer, minus the
 * surrounding project.
 *
 * **What that costs, recorded (ADR 0032):** a `\newcommand` declared in a
 * preamble the fragment does not contain classifies as `markup` rather than
 * `macro`. Both kinds freeze, so no protection is lost — only the label
 * differs. A fragment cut mid-construct parses as whatever tolerant
 * unified-latex makes of it; the failure mode is a SPURIOUS span, i.e. a
 * refusal the model self-corrects from, never a missed one.
 *
 * **It never throws.** A detector that threw would turn an unparseable
 * fragment into a dead session; an empty result degrades to "no marking, no
 * enforcement", which is the honest answer for text we could not analyse.
 */

import type { DocKind, ProtectedSpan, SemanticUnit } from "@lemmaria/harness";
import { LatexProject } from "./latex/project.js";
import { collectProtectedSpans } from "./latex/protected-spans.js";
import { MarkdownDocument } from "./markdown/document.js";
import { collectMarkdownProtectedSpans } from "./markdown/protected-spans.js";

/** The synthetic entry path per kind — never touches a real filesystem. */
const FRAGMENT_ENTRY: Record<DocKind, string> = {
  latex: "fragment.tex",
  markdown: "fragment.md",
};

/**
 * A reader that knows exactly one file. Every other path REJECTS, which is
 * what makes an `\input{...}` or a `\bibliography{...}` inside the fragment
 * resolve to "missing" rather than recursing into the fragment itself.
 */
function fragmentReader(
  entry: string,
  text: string,
): { readFile: (path: string) => Promise<string> } {
  return {
    readFile: (path: string) =>
      path === entry
        ? Promise.resolve(text)
        : Promise.reject(new Error(`not part of this fragment: ${path}`)),
  };
}

/** The whole fragment as one unit — offsets come back fragment-relative. */
function wholeFragment(entry: string, text: string): SemanticUnit {
  return {
    scope: "document",
    text,
    span: { file: entry, startOffset: 0, endOffset: text.length },
  };
}

/**
 * The `ProtectedSpanReader` every real host wires (D1, ADR 0032) — the file's
 * extension chooses the adapter, and an extension no adapter covers answers
 * `undefined`, which the harness reads as "enforce nothing here".
 *
 * It lives beside the detector rather than in each host so the extension, the
 * CLI eval driver and the tests cannot disagree about which files are guarded.
 */
export function protectedSpansForFile(
  file: string,
  text: string,
): Promise<ProtectedSpan[] | undefined> {
  if (/\.(tex|latex|sty|cls)$/i.test(file))
    return protectedSpansIn("latex", text);
  if (/\.(md|markdown)$/i.test(file)) return protectedSpansIn("markdown", text);
  return Promise.resolve(undefined);
}

export async function protectedSpansIn(
  kind: DocKind,
  text: string,
): Promise<ProtectedSpan[]> {
  if (text === "") return [];
  const entry = FRAGMENT_ENTRY[kind];
  const reader = fragmentReader(entry, text);
  const unit = wholeFragment(entry, text);
  try {
    // `nested: true` is what makes this reader differ from the quick-action
    // freeze view, and it is the ONLY caller that asks for it (X3, ADR 0036).
    // ADR 0033 §3 freed a container's prose; freeing the prose without saying
    // what is protected INSIDE it freed a nested formula, citation and label
    // too — measured, not theorised. Freeze cannot take the same view: it
    // substitutes `⟦Pn⟧` by offset, and it does not need to, because freezing
    // the outermost span protects everything inside it more strongly.
    if (kind === "markdown") {
      const doc = await MarkdownDocument.load(reader, entry);
      return collectMarkdownProtectedSpans(doc, unit, { nested: true });
    }
    const project = await LatexProject.load(reader, entry);
    return collectProtectedSpans(project, unit, { nested: true });
  } catch {
    return [];
  }
}
