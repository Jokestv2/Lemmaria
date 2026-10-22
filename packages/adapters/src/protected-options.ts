/**
 * How a protected-span collector should treat nesting (X3, ADR 0036).
 *
 * It lives here, above both format collectors, because both take it and
 * `protected-fragment.ts` — the one caller that turns it on — imports both. A
 * copy in each collector would be a one-field type in two places, which is the
 * shape that drifts.
 */
export interface ProtectedSpanOptions {
  /**
   * Surface candidates nested inside a CONTAINER span as spans of their own.
   *
   * **Off by default, which is the `protected_spans: freeze` view.**
   * `freezeUnit` substitutes `⟦Pn⟧` by offset, so overlapping spans would
   * corrupt it — and it does not need them, because freezing the outermost span
   * protects everything inside it more strongly.
   *
   * **On for the agentic path**, where [ADR 0033](../../../Lemmaria-design-doc/docs/adr/0033-edit-intent-and-protected-content.md)
   * §3 freed a container's PROSE and so has to say which parts of that prose
   * are not free after all. Measured before X3: a `$…$` inside `\textbf{}`, a
   * `\cite{}` inside `\footnote{}` and a `\label{}` inside `\section{}` were
   * each droppable with no refusal at all.
   */
  nested?: boolean;
}
