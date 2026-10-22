import { describe, expect, it } from "vitest";
import type { ProtectedSpan, SpanKind } from "../../src/contracts/adapters.js";
import {
  missingProtectedSpan,
  undeclarableRemoval,
} from "../../src/session/protected-edits.js";

/**
 * The pure rule behind `propose_edit`'s refusal (D1, ADR 0032), as revised by
 * X2 (ADR 0033): every protected span found in the ANCHOR must occur in the
 * REPLACEMENT at least as many times — unless the edit DECLARES that it is
 * removing it.
 *
 * D1's escape was different: an anchor that *was* one span's raw text passed
 * automatically. That carve-out is withdrawn, and its withdrawal is pinned
 * below, because the operator's manual round showed it was a route around the
 * rule rather than a way through it.
 */

const span = (kind: SpanKind, raw: string, at = 0): ProtectedSpan => ({
  file: "main.tex",
  startOffset: at,
  endOffset: at + raw.length,
  kind,
  token: "⟦P0⟧",
  raw,
});

describe("missingProtectedSpan", () => {
  it("catches a comment dropped from the replacement", () => {
    const anchor = "The result holds. % TODO: verify this";
    const hit = missingProtectedSpan(anchor, "The result holds firmly.", [
      span("comment", "% TODO: verify this", 18),
    ]);
    expect(hit?.kind).toBe("comment");
    expect(hit?.raw).toBe("% TODO: verify this");
  });

  it("catches ONE of two identical citations being dropped (the count rule)", () => {
    // `includes` would pass this — the raw text still appears. Counting is
    // what makes the rule mean "nothing was lost".
    const anchor = "Shown in \\cite{a}, and again in \\cite{a}.";
    const hit = missingProtectedSpan(anchor, "Shown in \\cite{a}.", [
      span("cite", "\\cite{a}", 9),
      span("cite", "\\cite{a}", 32),
    ]);
    expect(hit?.kind).toBe("cite");
  });

  it("passes a replacement that reorders but keeps everything", () => {
    const anchor = "As \\cite{a} shows, $x > 0$ holds.";
    expect(
      missingProtectedSpan(anchor, "$x > 0$ holds, as \\cite{a} shows.", [
        span("cite", "\\cite{a}", 3),
        span("math", "$x > 0$", 19),
      ]),
    ).toBeUndefined();
  });

  it("passes a replacement that ADDS a copy — the harm is loss, not duplication", () => {
    const anchor = "Per \\cite{a}.";
    expect(
      missingProtectedSpan(anchor, "Per \\cite{a}; see also \\cite{a}.", [
        span("cite", "\\cite{a}", 4),
      ]),
    ).toBeUndefined();
  });

  it("REFUSES an anchor that is exactly the span, with no declaration (ADR 0033)", () => {
    // D1's carve-out is WITHDRAWN, and this pins the withdrawal — nothing else
    // would notice it coming back. It used to pass automatically, which is how
    // "drop the leftover TODO note" walked around the rule in the operator's
    // round: one edit anchored the comment alone and deleted it, a second
    // rewrote the paragraph, and both halves passed independently.
    expect(
      missingProtectedSpan("\\cite{old}", "\\cite{new}", [
        span("cite", "\\cite{old}"),
      ])?.raw,
    ).toBe("\\cite{old}");
  });

  it("passes that same edit once the removal is DECLARED", () => {
    // The replacement for the carve-out: intent travels as data, so it shows
    // up in the proposal row instead of hiding in a narrowed anchor.
    expect(
      missingProtectedSpan(
        "\\cite{old}",
        "\\cite{new}",
        [span("cite", "\\cite{old}")],
        ["\\cite{old}"],
      ),
    ).toBeUndefined();
  });

  it("matches a declaration through surrounding whitespace", () => {
    // unified-latex's comment node carries the whitespace and newline around
    // it, so an untrimmed comparison would make the declaration unhittable for
    // the very construct the rule is named after (D1 review, Important 5).
    expect(
      missingProtectedSpan(
        "  % TODO: verify\n",
        "",
        [span("comment", "\n  % TODO: verify\n")],
        ["% TODO: verify"],
      ),
    ).toBeUndefined();
  });

  it("declaring ONE removal does not waive the others (ADR 0033)", () => {
    // The operator's step-7 shape: "no formula and no citation" must declare
    // both. Declaring only the math still refuses on the citation.
    const math = span("math", "$x$", 0);
    const cite = span("cite", "\\cite{a}", 8);
    expect(
      missingProtectedSpan(
        "$x$ and \\cite{a}",
        "plain prose",
        [math, cite],
        ["$x$"],
      )?.kind,
    ).toBe("cite");
    expect(
      missingProtectedSpan(
        "$x$ and \\cite{a}",
        "plain prose",
        [math, cite],
        ["$x$", "\\cite{a}"],
      ),
    ).toBeUndefined();
  });

  it("refuses an undeclared span inside an anchor that also holds prose", () => {
    const hit = missingProtectedSpan(
      "as \\cite{old} shows",
      "as \\cite{new} shows",
      [span("cite", "\\cite{old}", 3)],
    );
    expect(hit?.raw).toBe("\\cite{old}");
  });

  it("counts PROTECTED occurrences, not textual ones", () => {
    // Review, Minor 15: the same text may also sit at an unprotected position
    // in the anchor. Requiring two copies because the string appears twice
    // refuses a legitimate rewrite of the unprotected one.
    const anchor = "the token \\alpha is written \\alpha in the macro";
    expect(
      missingProtectedSpan(anchor, "written \\alpha in the macro", [
        span("markup", "\\alpha", 28),
      ]),
    ).toBeUndefined();
  });

  it("passes an empty span list", () => {
    expect(missingProtectedSpan("plain", "prose", [])).toBeUndefined();
  });

  it("reports the FIRST loss in source order, so the note is stable", () => {
    const anchor = "% note\nProse with $x$ and \\cite{a}.";
    const hit = missingProtectedSpan(anchor, "Prose.", [
      span("comment", "% note", 0),
      span("math", "$x$", 18),
      span("cite", "\\cite{a}", 26),
    ]);
    expect(hit?.kind).toBe("comment");
  });

  it("holds for Chinese prose (invariant 6 rule 1: content is language-neutral)", () => {
    const anchor = "准确率为 $94.7\\%$，见 \\cite{he2015}。";
    expect(
      missingProtectedSpan(anchor, "准确率很高。", [
        span("math", "$94.7\\%$", 5),
        span("cite", "\\cite{he2015}", 18),
      ])?.kind,
    ).toBe("math");
    expect(
      missingProtectedSpan(
        anchor,
        "我们观察到 $94.7\\%$ 的准确率，见 \\cite{he2015}。",
        [span("math", "$94.7\\%$", 5), span("cite", "\\cite{he2015}", 18)],
      ),
    ).toBeUndefined();
  });
});

describe("undeclarableRemoval (ADR 0033 §2)", () => {
  it("accepts a declaration naming a real span of this anchor", () => {
    expect(
      undeclarableRemoval([span("cite", "\\cite{a}")], ["\\cite{a}"]),
    ).toBeUndefined();
  });

  it("rejects a declaration naming something the anchor does not protect", () => {
    // Without this the declaration would be a blanket waiver: a model could
    // disarm the rule by listing text it had never read.
    expect(
      undeclarableRemoval([span("cite", "\\cite{a}")], ["\\cite{elsewhere}"]),
    ).toBe("\\cite{elsewhere}");
  });

  it("is a no-op when nothing is declared", () => {
    expect(
      undeclarableRemoval([span("cite", "\\cite{a}")], []),
    ).toBeUndefined();
  });
});

describe("container vs opaque spans (ADR 0033 §3)", () => {
  it("lets a rewrite change the PROSE inside \\textbf{…}", () => {
    // D1's item 7, driven by the operator and found unliveable: the words that
    // need to move are often exactly the ones inside the emphasis.
    expect(
      missingProtectedSpan(
        "the method \\textbf{stops working} here",
        "the method \\textbf{fails} here",
        [span("markup", "\\textbf{stops working}", 11)],
      ),
    ).toBeUndefined();
  });

  it("still refuses a rewrite that drops the \\textbf{} command itself", () => {
    expect(
      missingProtectedSpan(
        "the method \\textbf{stops working} here",
        "the method fails here",
        [span("markup", "\\textbf{stops working}", 11)],
      )?.kind,
    ).toBe("markup");
  });

  it("protects a \\footnote{}'s command while freeing its prose", () => {
    expect(
      missingProtectedSpan(
        "shown\\footnote{See the appendix for the full derivation.}",
        "shown\\footnote{See the appendix.}",
        [
          span(
            "markup",
            "\\footnote{See the appendix for the full derivation.}",
            5,
          ),
        ],
      ),
    ).toBeUndefined();
  });

  it("counts container skeletons, so dropping ONE of two \\textbf{} is caught", () => {
    expect(
      missingProtectedSpan("\\textbf{a} and \\textbf{b}", "\\textbf{a} and b", [
        span("markup", "\\textbf{a}", 0),
        span("markup", "\\textbf{b}", 15),
      ])?.kind,
    ).toBe("markup");
  });

  it("keeps math OPAQUE — the whole formula, not a skeleton", () => {
    // The split must not leak: an opaque span has no prose to free.
    expect(
      missingProtectedSpan("we get $x + 1$ here", "we get $x + 2$ here", [
        span("math", "$x + 1$", 7),
      ])?.kind,
    ).toBe("math");
  });

  it("protects a bare \\item with no braces", () => {
    expect(
      missingProtectedSpan("\\item first point", "first point", [
        span("markup", "\\item", 0),
      ])?.kind,
    ).toBe("markup");
    expect(
      missingProtectedSpan("\\item first point", "\\item a tighter point", [
        span("markup", "\\item", 0),
      ]),
    ).toBeUndefined();
  });

  it("declares a container removal by its RAW text, not its skeleton", () => {
    // What the model read and what the proposal row shows is the raw span, so
    // that is what a declaration names.
    expect(
      missingProtectedSpan(
        "the method \\textbf{stops working} here",
        "the method fails here",
        [span("markup", "\\textbf{stops working}", 11)],
        ["\\textbf{stops working}"],
      ),
    ).toBeUndefined();
  });
});

/**
 * X3 (ADR 0036). The observed deadlock: asked to drop the bold from
 * `\textbf{\emph{measurement decision}}`, the model was refused for undeclared
 * loss, declared the balanced text, was refused as DISHONEST, retried
 * undeclared, was refused again, and gave up. The only declaration the matcher
 * accepted was the detector's unbalanced `\textbf{\emph{measurement decision}`
 * — which looks like a typo, so a model that tidies its own quotation could
 * never reach it.
 *
 * X3 fixes the raw at the detector (ADR 0036 §1) AND makes the matcher
 * tolerant here, because those are independent failures: an unbalanced raw can
 * still arise from `containerSkeleton`'s fallback, from Markdown, or from a
 * fragment cut mid-construct, and a model quoting with different internal
 * spacing is ordinary.
 *
 * **Normalized, deliberately NOT substring.** A rule that accepted any
 * declaration CONTAINING the span's raw is satisfied by the whole anchor, which
 * is the blanket waiver ADR 0033 §2 forbids and `undeclarableRemoval` exists to
 * catch. Both are asserted below; the containment one is the load-bearing
 * negative.
 */
describe("declaration matching is normalized (X3, ADR 0036)", () => {
  const UNBALANCED = "\\textbf{\\emph{measurement decision}";
  const BALANCED = "\\textbf{\\emph{measurement decision}}";
  const ANCHOR = `We record the ${BALANCED} in full.`;

  it("accepts a declaration that brace-COMPLETES the recorded raw", () => {
    expect(
      missingProtectedSpan(
        ANCHOR,
        "We record the measurement decision in full.",
        [span("markup", UNBALANCED, 14)],
        [BALANCED],
      ),
    ).toBeUndefined();
  });

  it("accepts it on the undeclarable check too, or the two would disagree", () => {
    // A declaration accepted by one and refused by the other is the deadlock:
    // the model is told its escape is dishonest and has nowhere left to go.
    expect(
      undeclarableRemoval([span("markup", UNBALANCED, 14)], [BALANCED]),
    ).toBeUndefined();
  });

  it("accepts a declaration differing only in internal whitespace", () => {
    expect(
      undeclarableRemoval([span("cite", "\\cite{a,  b}")], ["\\cite{a, b}"]),
    ).toBeUndefined();
  });

  it("REFUSES a declaration that merely CONTAINS the span (blanket waiver)", () => {
    expect(
      undeclarableRemoval(
        [span("cite", "\\cite{a}", 9)],
        ["Shown in \\cite{a} and elsewhere."],
      ),
    ).toBe("Shown in \\cite{a} and elsewhere.");
  });

  it("REFUSES a declaration that is a strict substring of the span", () => {
    expect(
      undeclarableRemoval([span("cite", "\\cite{a,b}")], ["\\cite{a"]),
    ).toBe("\\cite{a");
  });

  it("still refuses a declaration naming a span of a different anchor", () => {
    expect(
      undeclarableRemoval([span("cite", "\\cite{a}")], ["\\cite{elsewhere}"]),
    ).toBe("\\cite{elsewhere}");
  });
});

/**
 * X3 (ADR 0036 §3). A container and what is nested in it are now separate
 * spans, so "remove the bold entirely" would otherwise cost a second round
 * trip: the model declares the container, and is then refused for the
 * `\emph{}` it could not possibly have kept. Removal of a region removes what
 * is in it — the offsets say so exactly.
 */
describe("declaring a container waives what is nested in it (X3)", () => {
  const OUTER = "\\textbf{\\emph{measurement decision}}";
  const INNER = "\\emph{measurement decision}";
  const ANCHOR = `We record the ${OUTER} in full.`;
  const spans = [
    span("markup", OUTER, 14),
    span("markup", INNER, 14 + "\\textbf{".length),
  ];

  it("applies in ONE call when the container is declared", () => {
    expect(
      missingProtectedSpan(
        ANCHOR,
        "We record the measurement decision in full.",
        spans,
        [OUTER],
      ),
    ).toBeUndefined();
  });

  it("declaring only the INNER still refuses the loss of the outer", () => {
    expect(
      missingProtectedSpan(
        ANCHOR,
        "We record the measurement decision in full.",
        spans,
        [INNER],
      )?.raw,
    ).toBe(OUTER);
  });

  it("keeping the container while dropping the inner is refused", () => {
    // The measured under-protection, at the rule level.
    expect(
      missingProtectedSpan(
        ANCHOR,
        "We record the \\textbf{measurement decision} in full.",
        spans,
      )?.raw,
    ).toBe(INNER);
  });

  it("a FUZZY match waives only itself, never a twin's whole region", () => {
    // Review, I5. Normalizing is lossy — collapsing whitespace and dropping
    // unmatched closers can make two DISTINCT spans normalize alike. The
    // tolerance is wanted for waiving the span the model meant; handing it the
    // twin's region as well is how one declaration erases four spans.
    const first = span("markup", "\\emph{a $x$ b}", 0);
    const firstMath = span("math", "$x$", 8);
    const second = span("markup", "\\emph{a $x$  b}", 19);
    const secondMath = span("math", "$x$", 27);
    const anchor = "\\emph{a $x$ b} and \\emph{a $x$  b}";
    const hit = missingProtectedSpan(
      anchor,
      "gone",
      [first, firstMath, second, secondMath],
      ["\\emph{a $x$ b}"],
    );
    // The exactly-matched span and its interior go; the twin's math does not.
    expect(hit?.kind).toBe("math");
    expect(hit?.startOffset).toBe(27);
  });

  it("a declared container that the replacement KEEPS waives nothing but itself", () => {
    // Found while probing X3's own change. Without the "actually gone" test the
    // declaration becomes a lever: name the `\footnote{}`, keep the footnote,
    // drop the `\cite{}` inside it, and both are waived — a silent loss reached
    // through a declaration that named something else entirely.
    const anchor = "shown\\footnote{See \\cite{a} for the derivation.}";
    const outer = span(
      "markup",
      "\\footnote{See \\cite{a} for the derivation.}",
      5,
    );
    const inner = span("cite", "\\cite{a}", 19);
    expect(
      missingProtectedSpan(
        anchor,
        "shown\\footnote{See the appendix.}",
        [outer, inner],
        ["\\footnote{See \\cite{a} for the derivation.}"],
      )?.raw,
    ).toBe("\\cite{a}");
  });

  it("declaring one \\textbf{} does not refuse a SIBLING that shares its skeleton", () => {
    // The requirement is counted over the ENFORCED spans. Counting it over all
    // of them made a waived span inflate its sibling's need — two `\textbf{}`
    // where one is declared, one kept, would be refused for losing the other.
    // X3 makes this reachable often, since a container and a nested container
    // share the same key.
    const anchor = "\\textbf{a} and \\textbf{b}";
    expect(
      missingProtectedSpan(
        anchor,
        "a and \\textbf{b}",
        [span("markup", "\\textbf{a}", 0), span("markup", "\\textbf{b}", 15)],
        ["\\textbf{a}"],
      ),
    ).toBeUndefined();
  });

  it("a declared OPAQUE span waives nothing but itself", () => {
    const anchor = "we get $x$ and \\cite{a} here";
    expect(
      missingProtectedSpan(
        anchor,
        "we get more here",
        [span("math", "$x$", 7), span("cite", "\\cite{a}", 15)],
        ["$x$"],
      )?.kind,
    ).toBe("cite");
  });
});
