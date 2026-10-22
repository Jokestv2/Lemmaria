import type { ProposedEdit, SessionLocale } from "@lemmaria/harness";
import { tr } from "./strings.js";

/**
 * Naming a declared removal (D2 deliverable 8, X2's task T6).
 *
 * [ADR 0033](../../../../../Lemmaria-design-doc/docs/adr/0033-edit-intent-and-protected-content.md)
 * §2 withdrew D1's anchor carve-out **because** a declared removal would be
 * "legible in the proposal row". It was not: `removesProtected` reached no
 * file under `packages/extension/src`, so the stated advantage of the
 * mechanism over the one it replaced did not exist.
 *
 * Nothing in the protocol had to change for this — the field has always
 * travelled to the webview on the `edit_proposal` item, verbatim. What was
 * missing was the two lines that render it.
 */

/**
 * The declared removals for ONE per-file group, deduped in first-appearance
 * order.
 *
 * Per-file because that is the approval unit (A1b's manual-test finding): a
 * row covers several edits, so a row's claim about what is being removed must
 * cover all of them. Deduped because two edits declaring the same span removed
 * one thing.
 */
export function declaredRemovals(
  edits: readonly ProposedEdit[],
  indices: readonly number[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of indices) {
    for (const raw of edits[i]?.removesProtected ?? []) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * The line that names them, or `undefined` when there is nothing to name —
 * which is nearly every edit, and an empty line would be noise on all of them.
 *
 * The spans are rendered as **text**: they are document source the model
 * quoted back, so they pass through unaltered (invariant 6 rule 1) and they
 * are never markup the DOM should interpret. Only the label is localized.
 */
export function removalLine(
  removals: readonly string[],
  locale: SessionLocale,
): HTMLElement | undefined {
  if (removals.length === 0) return undefined;
  const line = document.createElement("div");
  line.className = "lm-proposal__note-line lm-proposal__removes";
  line.textContent = `⊘ ${tr(locale, "editRemovesProtected")} ${removals.join(" · ")}`;
  return line;
}
