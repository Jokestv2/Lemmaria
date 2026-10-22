/**
 * What a live run can be asked about (T2, ADR 0043 §D7).
 *
 * The live tier's job is **response verification** — *what the model was asked,
 * what it did, and whether the outcome is the one the plan predicted*
 * ([ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
 * §2). Before T2 each scenario grew its own accessors, and the copies had
 * already drifted in ways that change what a test means:
 *
 * - `proposalsOf` existed twice, byte-identical.
 * - `assistantText` existed twice with **different join separators** (`"\n"`
 *   and `" "`), which silently changes whether a construct spanning two
 *   messages is found.
 * - the undeclared-loss predicate existed twice under two names, one trimming
 *   its marker and one not.
 * - the refusal prefixes were **hard-coded English literals**, copied from
 *   `protected-edits.ts`. A copied prefix stops matching the day the wording or
 *   the locale changes — and a live assertion that no longer matches anything
 *   passes, which is the worst way for a test to fail.
 *
 * So the refusal prefixes here are **derived from the product's own builders**
 * rather than copied from them. That is the one home rule applied to a test
 * helper, and it is not pedantry: T2's first finding was a live test whose
 * premise had quietly stopped holding, and this is the same failure mode one
 * level down.
 *
 * **What is deliberately NOT unified, so a later reader does not "finish the
 * job" and change what a test asserts.** `protected-comment.live.test.ts` and
 * `nested-markup.live.test.ts` keep their own `proposalsOf`, because theirs
 * returns `EditProposalItem[]` — the *proposal* — while this one flattens to
 * `ProposedEdit[]`. Their predicates ask questions about a proposal as a unit
 * (*did some edit of this proposal apply while another was refused*), which a
 * flattened list cannot express. Migrating them would mean rewriting those
 * predicates, and the plan's own instruction was to move the tests **without
 * changing what they assert**. The duplication that actually bites — a copied
 * English sentence and a divergent join separator — is gone; a second accessor
 * with a different return type is not that.
 */
import {
  type ProposedEdit,
  type ProtectedSpan,
  type SessionItem,
  type SpanKind,
  protectedSpanRefusal,
  undeclarableRemovalRefusal,
} from "@lemmaria/harness";
import { expect } from "vitest";

/**
 * A string no refusal sentence can contain, so the text before it is exactly
 * the builder's fixed prefix.
 *
 * **It carries no whitespace, deliberately.** `protected-edits.ts` normalises
 * its argument with `replace(/\s+/g, " ").trim()` before interpolating, so a
 * sentinel with a space in it would come back altered and `indexOf` would miss.
 * At 18 characters it is also well under that builder's 60-character elision
 * threshold, so it survives verbatim.
 */
const SENTINEL = "<<lemmaria-probe>>";

function prefixBefore(sentence: string, what: string): string {
  const at = sentence.indexOf(SENTINEL);
  if (at < 0) {
    throw new Error(
      `${what}: the sentinel did not survive the builder, so no prefix can be derived from it — the builder now transforms its argument and this helper must be rewritten rather than patched`,
    );
  }
  return sentence.slice(0, at);
}

/**
 * The fixed opening of the refusal `protectedSpanRefusal` emits for `kind`,
 * taken FROM that builder rather than copied from it.
 *
 * The kind is part of the prefix (*"…the comment \""*), which is why this takes
 * one: a test that means *"refused for dropping the comment"* would otherwise
 * also match a refusal about a `math` span.
 */
export function protectedRefusalPrefix(kind: SpanKind): string {
  const span: ProtectedSpan = {
    file: "probe.tex",
    startOffset: 0,
    endOffset: 0,
    kind,
    token: "",
    raw: SENTINEL,
  };
  return prefixBefore(
    protectedSpanRefusal(span),
    `protectedSpanRefusal(${kind})`,
  );
}

/** The same, for the refusal a dishonest `removes_protected` earns. */
export function undeclarableRefusalPrefix(): string {
  return prefixBefore(
    undeclarableRemovalRefusal(SENTINEL),
    "undeclarableRemovalRefusal",
  );
}

/** Every edit of every proposal the run produced, flattened, in order. */
export function proposalsOf(items: readonly SessionItem[]): ProposedEdit[] {
  return items
    .filter(
      (i): i is Extract<SessionItem, { type: "edit_proposal" }> =>
        i.type === "edit_proposal",
    )
    .flatMap((i) => i.edits);
}

/**
 * Everything the assistant said, newline-joined.
 *
 * Newline and not space, settled here rather than per file: a model that ends
 * one message with `*` and starts the next with `*` has not written emphasis,
 * and a space-joined corpus would say it had.
 */
export function assistantText(items: readonly SessionItem[]): string {
  return items
    .filter(
      (i): i is Extract<SessionItem, { type: "agent_message" }> =>
        i.type === "agent_message",
    )
    .map((i) => i.text ?? "")
    .join("\n");
}

/** Every tool call the model made, with its raw arguments. */
export function toolCallsOf(
  items: readonly SessionItem[],
): { tool: string; argsJson: string; resultJson?: string }[] {
  return items
    .filter(
      (i): i is Extract<SessionItem, { type: "tool_call" }> =>
        i.type === "tool_call",
    )
    .map((i) => ({
      tool: i.tool as string,
      argsJson: i.argsJson,
      ...(i.resultJson !== undefined ? { resultJson: i.resultJson } : {}),
    }));
}

/** Edits the engine refused, with the note that says why. */
export function refusedEdits(items: readonly SessionItem[]): ProposedEdit[] {
  // `invalid` alone is NOT "protected refusal": it also covers anchor-not-found,
  // ambiguous anchors, bad paths and create-target-exists. A caller that wants
  // the protected kind pairs this with a note match.
  return proposalsOf(items).filter((e) => e.status === "invalid");
}

/** Edits that were applied to the working copy. */
export function appliedEdits(items: readonly SessionItem[]): ProposedEdit[] {
  return proposalsOf(items).filter((e) => e.status === "applied");
}

/** Every span the model declared it was removing on purpose, trimmed. */
export function declaredRemovals(items: readonly SessionItem[]): string[] {
  // Trimmed because a comment span's `raw` carries its own newline, and a
  // declaration is compared against what a model would naturally quote.
  return proposalsOf(items).flatMap((e) =>
    (e.removesProtected ?? []).map((r) => r.trim()),
  );
}

/**
 * Did any applied edit drop `marker` without declaring it?
 *
 * The one-sided assertion every protected-content scenario needs: the outcome
 * SET may be wide, but silent loss is never in it.
 */
export function undeclaredLoss(
  items: readonly SessionItem[],
  marker: string,
  lost: boolean,
): boolean {
  if (!lost) return false;
  return !declaredRemovals(items).some((d) => d.includes(marker.trim()));
}

/**
 * An outcome SET that says which branch held.
 *
 * [ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md)
 * §5 requires assertions to accept outcome sets, because with a live model "two
 * outcomes are both passes" is the normal case. The tier expressed that as
 * `expect(a || b).toBe(true)`, whose failure message is `expected false to be
 * true` — it names neither branch, in the one tier whose entire job is
 * reporting what the response actually was.
 *
 * This takes named branches, asserts that at least one held, and RETURNS the
 * name of the one that did, so a scenario can report it.
 */
export function oneOf(what: string, branches: Record<string, boolean>): string {
  const held = Object.entries(branches)
    .filter(([, ok]) => ok)
    .map(([name]) => name);
  expect(
    held.length > 0,
    `${what}: no acceptable outcome held. Expected one of [${Object.keys(branches).join(", ")}]`,
  ).toBe(true);
  return held.join(" + ");
}

/**
 * Report what a live run actually did, always — pass or fail.
 *
 * A green live run that prints nothing answers *"did it break?"* and not *"what
 * did the model do?"*, and the second is what this tier exists for. D3's gate
 * is the cautionary case: it sampled a model's Markdown once, the sample
 * contained no Markdown at all, and the run was green — so the question it was
 * meant to answer stayed open without anyone noticing.
 */
export function report(scenario: string, facts: Record<string, unknown>): void {
  const body = Object.entries(facts)
    .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  console.log(`[live] ${scenario}\n${body}`);
}
