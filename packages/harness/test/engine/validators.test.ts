import { describe, expect, it } from "vitest";
import type { ProtectedSpan } from "../../src/contracts/adapters.js";
import {
  type ValidatorContext,
  runValidators,
} from "../../src/engine/validators.js";

/** EN/zh word counter good enough for validator tests. */
function countWords(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const hasHan = /\p{Script=Han}/u.test(text);
  return {
    language: (hasHan ? "zh" : "en") as "en" | "zh" | "mixed",
    unit: (hasHan ? "字" : "words") as "字" | "words",
    count: hasHan
      ? [...text].filter((c) => /\p{Script=Han}/u.test(c)).length
      : words,
  };
}

function ctx(overrides: Partial<ValidatorContext> = {}): ValidatorContext {
  return {
    countWords,
    unitText: "",
    currentProseCount: 0,
    frozen: { text: "", tokens: new Map() },
    protectedSpans: [],
    knownLabels: new Set(["sec:intro"]),
    knownCitations: new Set(["v17"]),
    glossary: [],
    params: {},
    ...overrides,
  };
}

describe("word_count", () => {
  it("passes within target±tolerance (fraction) and resolves templated config", () => {
    const c = ctx({ params: { target: 6, tolerance: 0.5 } });
    const out = runValidators(
      [
        {
          type: "word_count",
          target: "{{params.target}}",
          tolerance: "{{params.tolerance}}",
        },
      ],
      "one two three four five",
      c,
    );
    expect(out[0]).toMatchObject({ type: "word_count", pass: true });
  });
  it("resolves the target from reduce_by against the current prose count", () => {
    // "reduce BY 8" from a 20-word selection => target 12 (±0).
    const c = ctx({ currentProseCount: 20, params: { reduce_by: 8 } });
    const out = runValidators(
      [{ type: "word_count", reduce_by: "{{params.reduce_by}}", tolerance: 0 }],
      "one two three four five six seven eight nine ten eleven twelve",
      c,
    );
    expect(out[0]).toMatchObject({ type: "word_count", pass: true });
  });
  it("clamps a reduce_by larger than the selection to a target of at least 1", () => {
    const c = ctx({ currentProseCount: 5, params: { reduce_by: 100 } });
    const out = runValidators(
      [{ type: "word_count", reduce_by: "{{params.reduce_by}}", tolerance: 0 }],
      "one",
      c,
    );
    expect(out[0]).toMatchObject({ type: "word_count", pass: true });
  });
  it("resolves the target from grow_by against the current prose count", () => {
    // "grow BY 4" from an 8-word selection => target 12 (±0). The expand mirror
    // of reduce_by: academics think in deltas ("add 60 words"), not lengths.
    const c = ctx({ currentProseCount: 8, params: { add_words: 4 } });
    const out = runValidators(
      [{ type: "word_count", grow_by: "{{params.add_words}}", tolerance: 0 }],
      "one two three four five six seven eight nine ten eleven twelve",
      c,
    );
    expect(out[0]).toMatchObject({ type: "word_count", pass: true });
  });
  it("prefers grow_by over an absolute target, as reduce_by does", () => {
    const c = ctx({ currentProseCount: 8, params: { add_words: 4 } });
    const out = runValidators(
      [
        {
          type: "word_count",
          grow_by: "{{params.add_words}}",
          target: 3,
          tolerance: 0,
        },
      ],
      "one two three four five six seven eight nine ten eleven twelve",
      c,
    );
    expect(out[0]).toMatchObject({ type: "word_count", pass: true });
  });
  it("fails outside tolerance with the counts in the reason", () => {
    const out = runValidators(
      [{ type: "word_count", target: 100, tolerance: 0.05 }],
      "way too short",
      ctx(),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/3/);
    expect(out[0]?.reason).toMatch(/100/);
  });
});

describe("protected_spans_intact", () => {
  const tokens = new Map([["⟦P0⟧", "\\citep{v17}"]]);
  it("passes when each token appears exactly once", () => {
    const out = runValidators(
      [{ type: "protected_spans_intact" }],
      "kept ⟦P0⟧ here",
      ctx({ frozen: { text: "", tokens } }),
    );
    expect(out[0]?.pass).toBe(true);
  });
  it("fails naming the missing token", () => {
    const out = runValidators(
      [{ type: "protected_spans_intact" }],
      "dropped it",
      ctx({ frozen: { text: "", tokens } }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("⟦P0⟧");
  });
  it("without tokens, checks the policy-protected raw spans survive in the thawed output", () => {
    const spans: ProtectedSpan[] = [
      {
        kind: "cite",
        token: "⟦P0⟧",
        raw: "\\citep{v17}",
        file: "main.tex",
        startOffset: 0,
        endOffset: 11,
      },
    ];
    const passing = runValidators(
      [{ type: "protected_spans_intact" }],
      "still \\citep{v17} here",
      ctx({ protectedSpans: spans }),
    );
    expect(passing[0]?.pass).toBe(true);
    const failing = runValidators(
      [{ type: "protected_spans_intact" }],
      "gone",
      ctx({ protectedSpans: spans }),
    );
    expect(failing[0]?.pass).toBe(false);
  });
  it("does NOT enforce a span the policy allows editing (freeze_except / allow_edit)", () => {
    // The unit had a \BADMACRO span, but the action's policy allowed editing it,
    // so it is absent from protectedSpans. A fix that removes it must pass —
    // this is what lets fix-compile-error repair broken markup.
    const badmacro: ProtectedSpan = {
      kind: "markup",
      token: "⟦P0⟧",
      raw: "\\BADMACRO",
      file: "main.tex",
      startOffset: 0,
      endOffset: 9,
    };
    const out = runValidators(
      [{ type: "protected_spans_intact" }],
      "A cleanly fixed line.",
      ctx({ protectedSpans: [] }),
    );
    expect(out[0]?.pass).toBe(true);
    // Sanity: if it WERE policy-protected, removing it would fail.
    const enforced = runValidators(
      [{ type: "protected_spans_intact" }],
      "A cleanly fixed line.",
      ctx({ protectedSpans: [badmacro] }),
    );
    expect(enforced[0]?.pass).toBe(false);
  });
});

describe("no_new_undefined_refs", () => {
  it("passes for known labels/citations and pre-existing breakage", () => {
    const c = ctx({ unitText: "old \\ref{sec:gone}" });
    const out = runValidators(
      [{ type: "no_new_undefined_refs" }],
      "see \\ref{sec:intro}, \\citep{v17}, \\ref{sec:gone}",
      c,
    );
    expect(out[0]?.pass).toBe(true);
  });
  it("fails on a newly invented ref or cite key", () => {
    const out = runValidators(
      [{ type: "no_new_undefined_refs" }],
      "see \\ref{sec:made-up} and \\cite{ghost2024}",
      ctx(),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("sec:made-up");
    expect(out[0]?.reason).toContain("ghost2024");
  });
  it("catches biblatex citation macros too (\\textcite/\\parencite/\\autocite)", () => {
    const out = runValidators(
      [{ type: "no_new_undefined_refs" }],
      "as \\textcite{ghost2024} argues, see \\parencite{phantom}",
      ctx(),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("ghost2024");
    expect(out[0]?.reason).toContain("phantom");
  });
});

describe("language_is", () => {
  it("passes/fails against countWords language", () => {
    expect(
      runValidators(
        [{ type: "language_is", expected: "zh" }],
        "注意力机制",
        ctx(),
      )[0]?.pass,
    ).toBe(true);
    expect(
      runValidators(
        [{ type: "language_is", expected: "zh" }],
        "attention",
        ctx(),
      )[0]?.pass,
    ).toBe(false);
  });

  it("counts prose only: zh output keeping its frozen tokens is still zh (invariant 6)", () => {
    const c = ctx({
      frozen: {
        text: "",
        tokens: new Map([["⟦P0⟧", "\\citep{vaswani2017attention}"]]),
      },
    });
    const out = runValidators(
      [{ type: "language_is", expected: "zh" }],
      "注意力机制见 ⟦P0⟧。",
      c,
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("resolves a templated expected against params (translate target_language)", () => {
    const c = ctx({ params: { target_language: "zh" } });
    expect(
      runValidators(
        [{ type: "language_is", expected: "{{params.target_language}}" }],
        "注意力机制",
        c,
      )[0]?.pass,
    ).toBe(true);
    expect(
      runValidators(
        [{ type: "language_is", expected: "{{params.target_language}}" }],
        "attention",
        c,
      )[0]?.pass,
    ).toBe(false);
  });
});

describe("word_count counts prose, not protected-span source", () => {
  it("matches the {{counts.current}} basis (tokens excluded)", () => {
    const c = ctx({
      frozen: {
        text: "",
        tokens: new Map([["⟦P0⟧", "\\citep{a2024} and $x=1$ stuff"]]),
      },
    });
    // prose = "one two three" (3 words); the thawed text would add macro tokens
    const out = runValidators(
      [{ type: "word_count", target: 3, tolerance: 0 }],
      "one two three ⟦P0⟧",
      c,
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("fails loudly on a mistyped templated config instead of treating it as 0", () => {
    const out = runValidators(
      [{ type: "word_count", target: "{{params.tagret}}", tolerance: 0 }],
      "one two",
      ctx({ params: { target: 2 } }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/missing|invalid/);
  });
});

describe("glossary_consistent", () => {
  const glossary = [{ term: "self-attention", zh: "自注意力", abbrev: "—" }];
  it("accepts canonical and sentence-case; rejects other casings", () => {
    const ok = runValidators(
      [{ type: "glossary_consistent" }],
      "Self-attention and self-attention.",
      ctx({ glossary }),
    );
    expect(ok[0]?.pass).toBe(true);
    const bad = runValidators(
      [{ type: "glossary_consistent" }],
      "SELF-ATTENTION is used.",
      ctx({ glossary }),
    );
    expect(bad[0]?.pass).toBe(false);
    expect(bad[0]?.reason).toContain("self-attention");
  });

  it("enforces the canonical zh translation when translating to zh (hard constraint)", () => {
    const c = ctx({
      glossary,
      params: { target_language: "zh" },
      unitText: "We use self-attention here.",
    });
    // Output uses the canonical 自注意力 → pass.
    expect(
      runValidators(
        [{ type: "glossary_consistent" }],
        "我们在这里使用自注意力。",
        c,
      )[0]?.pass,
    ).toBe(true);
    // Output uses a non-canonical translation → fail with the required term.
    const bad = runValidators(
      [{ type: "glossary_consistent" }],
      "我们在这里使用自我注意。",
      c,
    );
    expect(bad[0]?.pass).toBe(false);
    expect(bad[0]?.reason).toContain("自注意力");
  });

  it("does not fire on a term that only appears mid-word (no false positive)", () => {
    // "gan" is a substring of "elegant" but not a glossary term occurrence.
    const c = ctx({
      glossary: [{ term: "gan", zh: "生成对抗网络", abbrev: "GAN" }],
      params: { target_language: "zh" },
      unitText: "An elegant and organic argument.",
    });
    // No canonical zh term in the output, yet the constraint must NOT fire.
    expect(
      runValidators(
        [{ type: "glossary_consistent" }],
        "一个优雅而自然的论证。",
        c,
      )[0]?.pass,
    ).toBe(true);
  });

  it("still matches an English term across a plural inflection", () => {
    const c = ctx({
      glossary: [{ term: "attention mechanism", zh: "注意力机制", abbrev: "" }],
      params: { target_language: "zh" },
      unitText: "We study attention mechanisms here.",
    });
    // Source has the plural "mechanisms"; output omits the canonical zh → fail.
    const bad = runValidators(
      [{ type: "glossary_consistent" }],
      "我们在此研究注意力。",
      c,
    );
    expect(bad[0]?.pass).toBe(false);
    expect(bad[0]?.reason).toContain("注意力机制");
  });

  it("enforces the canonical EN term when translating to en (hard constraint)", () => {
    const c = ctx({
      glossary,
      params: { target_language: "en" },
      unitText: "我们使用自注意力。",
    });
    expect(
      runValidators(
        [{ type: "glossary_consistent" }],
        "We use self-attention here.",
        c,
      )[0]?.pass,
    ).toBe(true);
    const bad = runValidators(
      [{ type: "glossary_consistent" }],
      "We use self attention mechanisms here.",
      c,
    );
    expect(bad[0]?.pass).toBe(false);
    expect(bad[0]?.reason).toContain("self-attention");
  });
});

describe("latex_balanced", () => {
  it("passes balanced text incl. escaped braces and comments", () => {
    const out = runValidators(
      [{ type: "latex_balanced" }],
      "a \\{ b \\} {ok} % }}}\n\\begin{itemize}\\end{itemize}",
      ctx(),
    );
    expect(out[0]?.pass).toBe(true);
  });
  it("fails on unbalanced braces and mismatched environments", () => {
    expect(
      runValidators([{ type: "latex_balanced" }], "{{once}", ctx())[0]?.pass,
    ).toBe(false);
    const env = runValidators(
      [{ type: "latex_balanced" }],
      "\\begin{a}\\end{b}",
      ctx(),
    );
    expect(env[0]?.pass).toBe(false);
    expect(env[0]?.reason).toMatch(/a.*b|b.*a/);
  });
});

describe("document_structure_intact", () => {
  it("passes a normal prose fix with no document delimiters in the region", () => {
    const out = runValidators(
      [{ type: "document_structure_intact" }],
      "In this paper we introduce a novel approach.",
      ctx({ unitText: "In this paper we introducc a novel approach." }),
    );
    expect(out[0]).toMatchObject({
      type: "document_structure_intact",
      pass: true,
    });
  });

  it("fails when the fix drops an \\end{document} that was in the region", () => {
    const out = runValidators(
      [{ type: "document_structure_intact" }],
      "\\section{Introduction}\\label{sec:intro}\nIn this paper we introduce it.",
      ctx({
        unitText:
          "\\section{Introduction}\\label{sec:intro\nIn this paper we introducc it.\n\n\\end{document}",
      }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("\\end{document}");
  });

  it("fails when the fix hallucinates a new \\begin{document}", () => {
    const out = runValidators(
      [{ type: "document_structure_intact" }],
      "\\begin{document}\nOops an extra opener.",
      ctx({ unitText: "Just a paragraph of prose." }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("\\begin{document}");
  });

  it("passes when the region's delimiter is preserved unchanged", () => {
    const region =
      "\\section{Introduction}\\label{sec:intro}\nSome prose.\n\n\\end{document}";
    const out = runValidators(
      [{ type: "document_structure_intact" }],
      region,
      ctx({ unitText: region.replace("prose", "prse") }),
    );
    expect(out[0]?.pass).toBe(true);
  });
});

describe("regex_must / regex_must_not", () => {
  it("enforces presence and absence", () => {
    expect(
      runValidators(
        [{ type: "regex_must", pattern: "\\\\section" }],
        "\\section{x}",
        ctx(),
      )[0]?.pass,
    ).toBe(true);
    expect(
      runValidators(
        [{ type: "regex_must_not", pattern: "TODO" }],
        "has TODO left",
        ctx(),
      )[0]?.pass,
    ).toBe(false);
  });
  it("fails (not throws) on an invalid or oversized pattern", () => {
    expect(
      runValidators([{ type: "regex_must", pattern: "(" }], "x", ctx())[0]
        ?.pass,
    ).toBe(false);
    expect(
      runValidators(
        [{ type: "regex_must", pattern: "a".repeat(300) }],
        "x",
        ctx(),
      )[0]?.pass,
    ).toBe(false);
  });
});

describe("unknown validator type", () => {
  it("fails with a reason instead of passing silently", () => {
    const out = runValidators([{ type: "quantum_check" }], "x", ctx());
    expect(out[0]).toMatchObject({ type: "quantum_check", pass: false });
  });
});

/**
 * D1 (ADR 0032). The reported harm is a LOST blank line silently merging two
 * paragraphs — in LaTeX a semantic change to the document, not a formatting
 * one. So the check is ONE-SIDED: structure must not decrease. Gaining a
 * paragraph is not that harm and is legitimate during `expand`, which is what
 * lets one declaration serve all five prose actions.
 */
describe("layout_preserved", () => {
  const two = "First paragraph here.\n\nSecond paragraph here.";

  it("passes when the paragraph breaks survive", () => {
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "First paragraph, revised.\n\nSecond paragraph, revised.",
      ctx({ unitText: two }),
    );
    expect(out[0]).toMatchObject({ type: "layout_preserved", pass: true });
  });

  it("fails when a blank line is lost and two paragraphs merge", () => {
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "First paragraph, revised. Second paragraph, revised.",
      ctx({ unitText: two }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/paragraph/);
    // Without a distance every failing attempt ties at the default 1 and the
    // engine silently keeps the FIRST — translate's language_is has exactly
    // that latent flaw. This one measures the drop.
    expect(out[0]?.distance).toBe(1);
  });

  it("passes when a paragraph is ADDED — the rule is one-sided", () => {
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "First paragraph.\n\nA new middle paragraph.\n\nSecond paragraph.",
      ctx({ unitText: two }),
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("fails when Markdown list items are dropped", () => {
    const list = "Setup:\n\n- alpha\n- beta\n- gamma\n- delta\n";
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "Setup:\n\n- alpha\n- beta\n",
      ctx({ unitText: list }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/list/);
    expect(out[0]?.distance).toBe(2);
  });

  it("counts ordered Markdown items and LaTeX \\item alike", () => {
    const md = "1. alpha\n2. beta\n";
    expect(
      runValidators(
        [{ type: "layout_preserved" }],
        "1. alpha\n",
        ctx({ unitText: md }),
      )[0]?.pass,
    ).toBe(false);
    const tex = "\\begin{itemize}\n\\item alpha\n\\item beta\n\\end{itemize}";
    expect(
      runValidators(
        [{ type: "layout_preserved" }],
        "\\begin{itemize}\n\\item alpha\n\\end{itemize}",
        ctx({ unitText: tex }),
      )[0]?.pass,
    ).toBe(false);
  });

  it("reports BOTH losses in one reason when structure and lists both drop", () => {
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "Intro. - alpha",
      ctx({ unitText: "Intro.\n\n- alpha\n- beta\n" }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/paragraph/);
    expect(out[0]?.reason).toMatch(/list/);
  });

  it("holds for Chinese prose (invariant 6)", () => {
    const zh = "第一段内容。\n\n第二段内容。";
    expect(
      runValidators(
        [{ type: "layout_preserved" }],
        "修订后的第一段。\n\n修订后的第二段。",
        ctx({ unitText: zh }),
      )[0]?.pass,
    ).toBe(true);
    const merged = runValidators(
      [{ type: "layout_preserved" }],
      "修订后的第一段。修订后的第二段。",
      ctx({ unitText: zh }),
    );
    expect(merged[0]?.pass).toBe(false);
    expect(merged[0]?.reason).toMatch(/paragraph/);
  });

  it("treats a whitespace-only line as a paragraph separator", () => {
    // A model that emits "\n   \n" has not merged anything.
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "First paragraph.\n   \nSecond paragraph.",
      ctx({ unitText: two }),
    );
    expect(out[0]?.pass).toBe(true);
  });
});

/**
 * D1 (ADR 0032), EDIT-1. Shrink's only enforcement was a SOFT `word_count`, so
 * the cheapest way to satisfy "compress without changing the meaning" is
 * deletion — which is what the model does, and it costs precision. This guards
 * content rather than length.
 *
 * Honestly named: it checks NUMBERS. Citations are already retained (every cite
 * macro is a frozen protected span, so `protected_spans_intact` catches a
 * dropped one), and claim-level retention is not mechanically checkable — a
 * validator called `claims_retained` that checked numbers would be a lie in the
 * schema, in the Glossary panel's derived list, and in the retry feedback.
 */
describe("numbers_retained", () => {
  const unit =
    "We reach 94.7% accuracy over 1,024 samples, improving on the 3 prior baselines.";

  it("passes when every figure survives the rewrite", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Accuracy reaches 94.7% on 1,024 samples, beating 3 baselines.",
      ctx({ unitText: unit }),
    );
    expect(out[0]).toMatchObject({ type: "numbers_retained", pass: true });
  });

  it("fails naming the figure a shrink deleted", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Accuracy is high over 1,024 samples, beating 3 baselines.",
      ctx({ unitText: unit }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("94.7");
    expect(out[0]?.distance).toBe(1);
  });

  it("counts every missing figure in the distance", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Accuracy is high and we beat the baselines.",
      ctx({ unitText: unit }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.distance).toBe(3);
  });

  it("fails a REFORMATTED figure — a rewrite has no business restating one", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Accuracy reaches 94.7% on 1024 samples, beating 3 baselines.",
      ctx({ unitText: unit }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("1,024");
  });

  it("passes when the unit carries no figures at all", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Anything at all.",
      ctx({ unitText: "Prose with no figures in it." }),
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("holds for Chinese prose (invariant 6)", () => {
    const zh = "准确率为 94.7%，样本量 1,024。";
    expect(
      runValidators(
        [{ type: "numbers_retained" }],
        "在 1,024 个样本上达到 94.7% 的准确率。",
        ctx({ unitText: zh }),
      )[0]?.pass,
    ).toBe(true);
    const dropped = runValidators(
      [{ type: "numbers_retained" }],
      "准确率很高。",
      ctx({ unitText: zh }),
    );
    expect(dropped[0]?.pass).toBe(false);
    expect(dropped[0]?.reason).toContain("94.7");
  });

  it("ignores digits inside a protected span it cannot be blamed for", () => {
    // `\cite{he2015}` and `$O(n^2)$` are frozen; their digits are not the
    // author's figures, and reporting them would be noise on every retry.
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Shorter prose.",
      ctx({
        unitText: "As cite{he2015} shows, $O(n^2)$ holds.",
        protectedSpans: [
          {
            kind: "cite",
            token: "⟦P0⟧",
            raw: "cite{he2015}",
            file: "main.tex",
            startOffset: 3,
            endOffset: 16,
          },
          {
            kind: "math",
            token: "⟦P1⟧",
            raw: "$O(n^2)$",
            file: "main.tex",
            startOffset: 23,
            endOffset: 31,
          },
        ],
      }),
    );
    expect(out[0]?.pass).toBe(true);
  });
});

/**
 * Regressions from D1's code review. Every one of these shipped as a false
 * POSITIVE on ordinary prose — the worst failure mode for a validator, because
 * it costs the user retries on text that was never wrong.
 */
describe("layout_preserved / numbers_retained — review regressions", () => {
  it("numbers_retained does not read sentence punctuation as part of a figure", () => {
    // Critical 1: `[\d,]*` swallowed the comma, so "In 2015, we ran" yielded the
    // figure "2015," — which then "vanished" from any rewrite that moved the
    // number away from the comma, and from EVERY Chinese translation, where the
    // comma is "，". An invariant-6 defect as much as a false positive.
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "We sampled 3 sites in 2015 and 4 more later.",
      ctx({ unitText: "In 2015, we sampled 3 sites, and 4 more later." }),
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("numbers_retained survives a Chinese translation of the same sentence", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "我们在 2015 年采样了 3 个站点，之后又增加了 4 个。",
      ctx({ unitText: "In 2015, we sampled 3 sites, and 4 more later." }),
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("numbers_retained still groups a thousands separator into one figure", () => {
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "Over 1024 runs.",
      ctx({ unitText: "Over 1,024 runs." }),
    );
    // Verbatim comparison: reformatting a figure is still a change.
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("1,024");
  });

  it("numbers_retained excludes protected spans on BOTH sides", () => {
    // Important 4: stripping only the `before` side let a \cite key left in the
    // OUTPUT satisfy a prose figure the rewrite had actually dropped.
    const cite = {
      kind: "cite" as const,
      token: "⟦P0⟧",
      raw: "\\cite{he2015}",
      file: "main.tex",
      startOffset: 19,
      endOffset: 32,
    };
    const out = runValidators(
      [{ type: "numbers_retained" }],
      "We ran trials \\cite{he2015}.",
      ctx({
        unitText: "We ran 2015 trials \\cite{he2015}.",
        protectedSpans: [cite],
      }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toContain("2015");
  });

  it("layout_preserved sees paragraphs in a CRLF document", () => {
    // Important 3: splitting on a LF-only paragraph break finds nothing in a
    // CRLF file, so on a Windows-authored paper the paragraph half was silently
    // inert — and since model output is LF, the one-sided rule could never fire.
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "First paragraph revised. Second paragraph revised.",
      ctx({ unitText: "First paragraph.\r\n\r\nSecond paragraph." }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/paragraph/);
  });

  it("layout_preserved does not read a hard-wrapped sentence as an ordered list", () => {
    // Important 6: source prose is wrapped at ~80 columns, so a sentence broken
    // before a year gives a line beginning "2015. Later work…" — counted as a
    // list item, then "lost" by any reflowing rewrite.
    const wrapped =
      "The method was first published in\n2015. Later work extends it in\n2020. We build on both.";
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "The method was published in 2015; later work extends it in 2020, and we build on both.",
      ctx({ unitText: wrapped }),
    );
    expect(out[0]?.pass).toBe(true);
  });

  it("layout_preserved still counts a real ordered list", () => {
    const list = "Steps:\n\n1. alpha\n2. beta\n3. gamma\n";
    const out = runValidators(
      [{ type: "layout_preserved" }],
      "Steps:\n\n1. alpha\n",
      ctx({ unitText: list }),
    );
    expect(out[0]?.pass).toBe(false);
    expect(out[0]?.reason).toMatch(/list/);
    expect(out[0]?.distance).toBe(2);
  });
});
