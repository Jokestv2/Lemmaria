/**
 * The span rule, in one home (V5, ADR 0087 §4).
 *
 * Two positions in a manuscript overlap when they sit in the same file — by
 * the harness's own path rule — and their line ranges intersect. That is ADR
 * 0070 §2's rule verbatim. It used to live twice in the CLI's eval instrument
 * and nowhere in the engine, because nothing but a measurement read it; the
 * scorecard's *distinct issues* now read it too, and the tab's host (V6), the
 * CLI and the eval tier must count an issue the same way, so it moved here.
 * The measurements themselves stay in the CLI (ADR 0070 §6 stands for them):
 * the eval's `touches` — claim OR evidence pointer, its measured definition —
 * and `overlaps` against a manifest are built on `spansOverlap`.
 *
 * Named `review-spans.ts` because `engine/spans.ts` already holds the
 * protected-span freeze/thaw.
 */

import type { ReviewAnnotation, ReviewSpan } from "../contracts/data.js";

/**
 * Minimal path normalization, the SAME in every mode (ADR 0060 §2): exact
 * match, else one leading `./` stripped and `\` converted to `/`. Nothing else,
 * and deliberately **no basename fallback** — a basename that matches
 * `sections/a.tex` and `old/a.tex` alike is a guess, and a guess is a supplied
 * position.
 */
export function normalizePath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}

/** The last line a span covers — an absent `endLine` means the one line. */
export function endOf(span: ReviewSpan): number {
  return span.endLine ?? span.line;
}

/** Same normalised file, and the two line ranges intersect. Symmetric. */
export function spansOverlap(a: ReviewSpan, b: ReviewSpan): boolean {
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  return a.line <= endOf(b) && b.line <= endOf(a);
}

/**
 * Concerns of ONE dimension whose CLAIM spans overlap, transitively, are one
 * issue (design §7): two reviewers on one line are one issue, and a `clarity`
 * and a `language` concern on one line are two. Evidence is not read — an
 * issue is what is claimed, not what supports it.
 *
 * Input is any list; output groups it without reordering: groups come in the
 * order of their first member, members in input order. Union-find over the
 * pairs, so a chain that only its middle member joins is still one group.
 */
export function distinctIssues(
  annotations: readonly ReviewAnnotation[],
): ReviewAnnotation[][] {
  const parent = annotations.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    // Path compression, so a long chain stays cheap.
    let at = i;
    while (parent[at] !== root) {
      const next = parent[at] as number;
      parent[at] = root;
      at = next;
    }
    return root;
  };
  for (let i = 0; i < annotations.length; i++) {
    const a = annotations[i] as ReviewAnnotation;
    for (let j = i + 1; j < annotations.length; j++) {
      const b = annotations[j] as ReviewAnnotation;
      if (a.dimension !== b.dimension) continue;
      if (!spansOverlap(a.span, b.span)) continue;
      const ra = find(i);
      const rb = find(j);
      // The earlier index is the root, so a group's first member is its root.
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  }
  const groups = new Map<number, ReviewAnnotation[]>();
  for (let i = 0; i < annotations.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group === undefined)
      groups.set(root, [annotations[i] as ReviewAnnotation]);
    else group.push(annotations[i] as ReviewAnnotation);
  }
  return [...groups.values()];
}
