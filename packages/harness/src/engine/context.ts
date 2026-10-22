/**
 * Lifecycle steps 2–3 (Acquire inputs → Build context): resolve the semantic
 * unit (with scope fallback), collect and freeze protected spans, gather
 * neighbors / glossary / profile / outline, and produce the full §5 template
 * variable set. Every §5 variable is always declared — inapplicable ones are
 * empty strings — so templates only warn on genuine typos.
 */

import type { ActionDefinition } from "../contracts/actions.js";
import type {
  DocumentAdapter,
  ProtectedSpan,
  SemanticUnit,
  SourceSpan,
  WordCount,
  Workspace,
} from "../contracts/adapters.js";
import type { OutlineNode } from "../contracts/tools.js";
import { ActionEngineError } from "./errors.js";
import { type MemoryInput, resolveMemory } from "./memory.js";
import { serializeOutline } from "./outline.js";
import { type GlossaryEntry, formatGlossary } from "./paper.js";
import {
  type FrozenUnit,
  freezeUnit,
  spansToFreeze,
  stripTokens,
} from "./spans.js";

export interface BuiltContext {
  unit: SemanticUnit;
  frozen: FrozenUnit;
  /** Spans the protected_spans policy protects (the freeze set). */
  protectedSpans: ProtectedSpan[];
  vars: Record<string, unknown>;
  knownLabels: Set<string>;
  knownCitations: Set<string>;
  glossary: GlossaryEntry[];
  wordCount: WordCount;
  /** The parsed structure tree (CM2) — feeds the retrieval-tool registry. */
  outline: OutlineNode[];
}

export async function buildContext(opts: {
  action: ActionDefinition;
  adapter: DocumentAdapter;
  workspace: Workspace;
  selection: SourceSpan;
  params: Record<string, unknown>;
  /** CM1 memory layers (global MEMORY.md / project / directory PAPER.md). */
  memory?: MemoryInput;
}): Promise<BuiltContext> {
  const { action, adapter, workspace, selection, params } = opts;

  let scope = action.input?.scope ?? "selection";
  if (scope === "selection" && selection.startOffset === selection.endOffset) {
    scope = action.input?.scope_fallback ?? "paragraph";
  }
  const unit = adapter.resolveSelection(selection, scope);

  const minChars = action.input?.min_chars ?? 1;
  if (unit.text.length < minChars) {
    throw new ActionEngineError(
      "input_too_short",
      `input is ${unit.text.length} chars, minimum ${minChars}`,
    );
  }
  const maxChars = action.input?.max_chars;
  if (maxChars !== undefined && unit.text.length > maxChars) {
    throw new ActionEngineError(
      "input_too_long",
      `input is ${unit.text.length} chars, maximum ${maxChars}`,
    );
  }

  const allSpans = adapter.protectedSpans(unit);
  const protectedSpans = spansToFreeze(
    allSpans,
    action.context?.protected_spans ?? "freeze",
  );
  const frozen = freezeUnit(unit, protectedSpans);

  const outline = await adapter.parseStructure();
  const knownLabels = new Set<string>();
  const knownCitations = new Set<string>();
  collectKeys(outline, knownLabels, knownCitations);
  // M7: a \cite to any bib-defined key is "known" even if not yet cited in the
  // document, closing the M3 no_new_undefined_refs over-flagging (a new but valid
  // cite was conservatively rejected). Best-effort — a project without a .bib (or
  // an adapter without bib support) simply adds nothing.
  try {
    for (const entry of await adapter.citations())
      knownCitations.add(entry.key);
  } catch {
    // no bibliography / unsupported adapter — leave knownCitations as-is
  }

  // Language/unit/count reflect the editable PROSE: protected-span source
  // (`\citep{...}`, math) must not make a zh paragraph read as "mixed".
  const prose = stripTokens(frozen.text, frozen.tokens);
  const wordCount = adapter.countWords(prose.trim() === "" ? unit.text : prose);
  const fileText = await workspace.readFile(unit.span.file);
  const neighbors = buildNeighbors(
    adapter,
    fileText,
    unit,
    action.context?.neighbors ?? 0,
  );

  const paper = resolveMemory(opts.memory ?? {});
  const include = new Set(action.context?.include_profile ?? []);
  const profile = {
    contribution: include.has("contribution") ? paper.profile.contribution : "",
    audience: include.has("audience") ? paper.profile.audience : "",
    claims: include.has("claims") ? paper.profile.claims : "",
    outline: include.has("outline") ? paper.profile.outline : "",
    style: include.has("style") ? paper.profile.style : "",
    venue: include.has("venue") ? paper.profile.venue : "",
  };

  const startLine = 1 + countNewlines(fileText, unit.span.startOffset);
  const vars: Record<string, unknown> = {
    selection: frozen.text,
    selection_raw: unit.text,
    language: wordCount.language,
    unit: wordCount.unit,
    counts: { current: wordCount.count },
    neighbors,
    glossary: action.context?.include_glossary ? formatGlossary(paper) : "",
    profile,
    outline: action.context?.include_outline ? serializeOutline(outline) : "",
    doc: { kind: adapter.kind },
    // Detected template/class name per schema §5 (e.g. "acmart"); adapters
    // without the concept (Markdown) omit the member and render "" (ADR 0010).
    venue: adapter.documentClass?.()?.name ?? "",
    section: sectionPath(outline, unit.span.file, startLine),
    params,
  };

  return {
    unit,
    frozen,
    protectedSpans,
    vars,
    knownLabels,
    knownCitations,
    glossary: paper.glossary,
    wordCount,
    outline,
  };
}

function collectKeys(
  nodes: OutlineNode[],
  labels: Set<string>,
  citations: Set<string>,
): void {
  for (const node of nodes) {
    for (const l of node.labels) labels.add(l);
    for (const c of node.citations) citations.add(c);
    collectKeys(node.children, labels, citations);
  }
}

function countNewlines(text: string, until: number): number {
  let count = 0;
  for (let i = 0; i < until && i < text.length; i++) {
    if (text[i] === "\n") count += 1;
  }
  return count;
}

/** Deepest outline node containing the line, rendered as "A > B". */
function sectionPath(nodes: OutlineNode[], file: string, line: number): string {
  const path: string[] = [];
  let level: OutlineNode[] = nodes;
  for (;;) {
    const hit = level.find(
      (n) => n.file === file && line >= n.startLine && line <= n.endLine,
    );
    if (!hit) break;
    path.push(hit.title);
    level = hit.children;
  }
  return path.join(" > ");
}

/**
 * Best-effort neighbor paragraphs: walk whitespace-skipped offsets outward and
 * resolve `paragraph` units. Stops at file bounds or resolution failure.
 */
function buildNeighbors(
  adapter: DocumentAdapter,
  fileText: string,
  unit: SemanticUnit,
  n: number,
): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  const file = unit.span.file;
  let pos = unit.span.startOffset;
  for (let i = 0; i < n; i++) {
    while (pos > 0 && /\s/.test(fileText[pos - 1] ?? "")) pos -= 1;
    if (pos <= 0) break;
    let neighbor: SemanticUnit;
    try {
      neighbor = adapter.resolveSelection(
        { file, startOffset: pos - 1, endOffset: pos - 1 },
        "paragraph",
      );
    } catch {
      break;
    }
    if (
      neighbor.span.endOffset > unit.span.startOffset ||
      neighbor.text.trim() === ""
    )
      break;
    before.unshift(neighbor.text);
    pos = neighbor.span.startOffset;
  }
  pos = unit.span.endOffset;
  for (let i = 0; i < n; i++) {
    while (pos < fileText.length && /\s/.test(fileText[pos] ?? "")) pos += 1;
    if (pos >= fileText.length) break;
    let neighbor: SemanticUnit;
    try {
      neighbor = adapter.resolveSelection(
        { file, startOffset: pos, endOffset: pos },
        "paragraph",
      );
    } catch {
      break;
    }
    if (
      neighbor.span.startOffset < unit.span.endOffset ||
      neighbor.text.trim() === ""
    )
      break;
    after.push(neighbor.text);
    pos = neighbor.span.endOffset;
  }
  return { before: before.join("\n\n"), after: after.join("\n\n") };
}
