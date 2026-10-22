import type { ProtectedSpan, SemanticUnit, SpanKind } from "@lemmaria/harness";
import { CONTAINER_SPAN_KINDS } from "@lemmaria/harness";
import type * as Ast from "@unified-latex/unified-latex-types";
import type { ProtectedSpanOptions } from "../protected-options.js";
import type { LatexProject } from "./project.js";
import { CITE_MACROS, REF_MACROS } from "./project.js";
import { macroFullSpan } from "./span-utils.js";
import { walkAll } from "./walk.js";

const CODE_ENVS = new Set(["lstlisting", "minted"]);

/** Frozen placeholders for `protected_spans: freeze` (invariant 3's raw material). */
export function collectProtectedSpans(
  project: LatexProject,
  unit: SemanticUnit,
  options: ProtectedSpanOptions = {},
): ProtectedSpan[] {
  const file = project.file(unit.span.file);
  const src = file.source;
  const customMacros = new Set(project.newcommands.map((nc) => nc.name));
  const candidates: Array<{
    start: number;
    end: number;
    kind: SpanKind;
    /**
     * May this candidate be surfaced from INSIDE a container (X3, ADR 0036 §3)?
     *
     * `false` for a single-character escape — `\%`, `\&`, `\_`, `\#`, `\$`,
     * `\{`. These parse as macros and classify as `markup`, and
     * `containerSkeleton` recognises neither shape, so it falls back to the
     * whole raw and enforces them **opaquely**. At the top level that is right
     * (turning `\%` into `%` comments out the rest of the line, and it is what
     * the quick-action freeze path has always done). Surfacing them from inside
     * a container is not: it makes rewriting `\emph{50\% of runs}` into
     * `\emph{half the runs}` a refusal, which is ordinary prose inside a
     * container's FREE prose — exactly what ADR 0033 §3 exists to permit.
     *
     * Only the nested path consults this, so the freeze set is untouched.
     */
    nestable?: boolean;
  }> = [];

  walkAll(file.ast.content, (node: Ast.Node) => {
    const pos = node.position;
    if (!pos) return;
    const within =
      pos.start.offset >= unit.span.startOffset &&
      pos.end.offset <= unit.span.endOffset;
    if (!within) return;
    switch (node.type) {
      case "inlinemath":
      case "displaymath":
      case "mathenv":
        candidates.push({
          start: pos.start.offset,
          end: pos.end.offset,
          kind: "math",
        });
        break;
      case "verbatim":
      case "verb":
        candidates.push({
          start: pos.start.offset,
          end: pos.end.offset,
          kind: "code",
        });
        break;
      case "environment":
        if (CODE_ENVS.has(String(node.env))) {
          candidates.push({
            start: pos.start.offset,
            end: pos.end.offset,
            kind: "code",
          });
        }
        break;
      case "comment":
        // Comments are never prose: freeze verbatim so they are neither counted
        // nor translated/shrunk (product feedback).
        candidates.push({
          start: pos.start.offset,
          end: pos.end.offset,
          kind: "comment",
        });
        break;
      case "macro": {
        // Every macro is non-prose markup: freeze it so its command name (and,
        // where the argument was bound — cite/ref/custom/NON_PROSE_MACROS — its
        // argument text) is neither counted nor rewritten. A macro whose args
        // aren't bound freezes by name only, leaving its argument as prose.
        const kind: SpanKind = Object.hasOwn(CITE_MACROS, node.content)
          ? "cite"
          : Object.hasOwn(REF_MACROS, node.content)
            ? "ref"
            : customMacros.has(node.content)
              ? "macro"
              : "markup";
        const span = macroFullSpan(src, node);
        candidates.push({
          ...span,
          kind,
          nestable: /^[A-Za-z@]+$/.test(node.content),
        });
        break;
      }
      default:
        break;
    }
  });

  // Sorted start-ascending, longest-first on a tie, so a container is always
  // seen before anything nested in it.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: typeof candidates = [];
  // The accepted spans still open at the current offset, innermost last. With
  // `nested` off nothing is ever accepted inside anything else, so the stack
  // never exceeds the partial-overlap depth the pre-X3 `outermost.at(-1)` test
  // already had — the two agree candidate for candidate.
  const open: typeof candidates = [];
  for (const c of candidates) {
    while (open.length > 0 && (open.at(-1)?.end ?? 0) <= c.start) open.pop();
    const enclosing = open.at(-1);
    if (enclosing && c.start >= enclosing.start && c.end <= enclosing.end) {
      // Contained. Pre-X3 this was always a drop. Since X3 a container's prose
      // is editable, so what is protected inside it has to be said out loud —
      // but only for a container: inside an OPAQUE span the whole raw is
      // required anyway, and a second entry would be noise (ADR 0036). A
      // candidate marked `nestable: false` is typography rather than content
      // and stays dropped — see the field's own comment.
      if (
        !options.nested ||
        !CONTAINER_SPAN_KINDS.has(enclosing.kind) ||
        c.nestable === false
      )
        continue;
    }
    accepted.push(c);
    open.push(c);
  }

  return accepted.map((c, i) => ({
    file: file.path,
    startOffset: c.start,
    endOffset: c.end,
    kind: c.kind,
    token: `⟦P${i}⟧`,
    raw: src.slice(c.start, c.end),
  }));
}
