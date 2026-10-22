import { describe, expect, it } from "vitest";
import { loadBuiltinActions } from "../../src/actions/builtin.js";

describe("built-in actions", () => {
  it("polish loads, validates, and is an L0 edit action with frozen spans", async () => {
    const { actions, errors } = await loadBuiltinActions();
    expect(errors).toEqual([]);
    const polish = actions.find((a) => a.definition.id === "polish");
    expect(polish).toBeDefined();
    expect(polish?.source).toBe("built-in");
    const def = polish?.definition;
    expect(def?.kind).toBe("edit");
    expect(def?.routing?.level).toBe("L0");
    expect(def?.context?.protected_spans).toBe("freeze");
    expect(def?.name.zh).toBeTruthy(); // bilingual is first-class (invariant 6)
    expect(def?.name.en).toBeTruthy();
    expect(def?.output?.validators?.map((v) => v.type)).toEqual([
      "protected_spans_intact",
      "latex_balanced",
      "no_new_undefined_refs",
      "layout_preserved",
      "glossary_consistent",
    ]);
    expect(def?.output?.on_validation_fail).toEqual({
      strategy: "retry_with_feedback",
      max_retries: 2,
    });
  });

  it("expand loads as an L1 edit action driven by a grow_by word target (A5)", async () => {
    const { actions, errors } = await loadBuiltinActions();
    expect(errors).toEqual([]);
    const expand = actions.find((a) => a.definition.id === "expand");
    expect(expand).toBeDefined();
    const def = expand?.definition;
    expect(def?.kind).toBe("edit");
    expect(def?.routing?.level).toBe("L1");
    // L1 earns its name through the count_words self-check loop (the shrink
    // precedent) — and through nothing else: invariant 2 keeps the tool list
    // to what the action declares.
    expect(def?.routing?.tools).toEqual(["count_words"]);
    expect(def?.requires?.tools).toEqual(["count_words"]);
    expect(def?.context?.protected_spans).toBe("freeze");
    expect(def?.output?.contract).toBe("replace_selection");
    expect(def?.name.zh).toBeTruthy();
    expect(def?.name.en).toBeTruthy();
    const wordCount = def?.output?.validators?.find(
      (v) => v.type === "word_count",
    );
    // The delta, not an absolute length: "add N words" is how the prompt asks.
    expect(wordCount?.grow_by).toBe("{{params.add_words}}");
    expect(wordCount?.soft).toBe(true); // a length goal is a soft goal (M6)
    expect(def?.output?.validators?.map((v) => v.type)).toEqual([
      "word_count",
      "protected_spans_intact",
      "no_new_undefined_refs",
      "layout_preserved",
      "glossary_consistent",
    ]);
    // One prompted box (the delta) + a non-prompted tolerance, exactly the
    // shrink-to-target shape.
    expect(def?.parameters?.map((p) => p.id)).toEqual([
      "add_words",
      "tolerance",
    ]);
    expect(def?.parameters?.[0]?.prompt_on_invoke).toBe(true);
    expect(def?.parameters?.[1]?.prompt_on_invoke ?? false).toBe(false);
    expect(def?.parameters?.[1]?.default).toBe(0.15);
  });

  /**
   * D1 (ADR 0032). Asserted over the whole prose set rather than per action:
   * `shrink-to-target`, `proofread` and `translate` have no builtin.test
   * coverage of their own, so a per-action array would have left three of the
   * five declarations unguarded.
   */
  const PROSE_ACTIONS = [
    "polish",
    "proofread",
    "shrink-to-target",
    "expand",
    "translate",
  ] as const;

  it("every prose action declares layout_preserved, soft (D1)", async () => {
    const { actions, errors } = await loadBuiltinActions();
    expect(errors).toEqual([]);
    for (const id of PROSE_ACTIONS) {
      const def = actions.find((a) => a.definition.id === id)?.definition;
      const layout = def?.output?.validators?.find(
        (v) => v.type === "layout_preserved",
      );
      expect(`${id}:${layout?.type}`).toBe(`${id}:layout_preserved`);
      // Soft: a legitimate merge during a shrink must retry with feedback,
      // not discard an otherwise good rewrite.
      expect(`${id}:${layout?.soft}`).toBe(`${id}:true`);
    }
  });

  it("every prose action declares glossary_consistent (D1 resolves the U6 question)", async () => {
    // open-questions.md's U6 entry asked whether polish/proofread/shrink should
    // declare it — making the product-design "enforced, not a hint" claim true —
    // or whether the doc should narrow to Translate. D1 extends the validator,
    // and widens the U6 list by one: `expand` writes prose too, and narrowing
    // the doc to four of five actions would have been the odd outcome. The
    // Glossary panel needs no change; it already derives its enforcing list.
    const { actions } = await loadBuiltinActions();
    for (const id of PROSE_ACTIONS) {
      const def = actions.find((a) => a.definition.id === id)?.definition;
      const glossary = def?.output?.validators?.find(
        (v) => v.type === "glossary_consistent",
      );
      expect(`${id}:${glossary?.type}`).toBe(`${id}:glossary_consistent`);
      // Hard on translate, where glossary fidelity IS the deliverable; soft on
      // the rest, where a casing nit must not discard a good rewrite.
      const expected = id === "translate" ? "undefined" : "true";
      expect(`${id}:${glossary?.soft}`).toBe(`${id}:${expected}`);
    }
  });

  it("numbers_retained is declared where it belongs, hard on shrink (D1)", async () => {
    // Hard on shrink deliberately (review, Critical 2): as a SOFT validator it
    // could never change which attempt ships, because the engine picks the
    // emitted candidate by summing soft distances and word_count's distance is
    // in words while this one counts missing figures. Soft on translate, where
    // a small count may legitimately be localized ("3 sites" → "三个站点").
    const { actions } = await loadBuiltinActions();
    const declared = (id: string) =>
      actions
        .find((a) => a.definition.id === id)
        ?.definition.output?.validators?.find(
          (v) => v.type === "numbers_retained",
        );
    expect(`shrink:${declared("shrink-to-target")?.soft}`).toBe(
      "shrink:undefined",
    );
    expect(`translate:${declared("translate")?.soft}`).toBe("translate:true");
    // Not declared where it would only add noise: polish/proofread/expand do
    // not compress, so they have no incentive to drop a figure.
    for (const id of ["polish", "proofread", "expand"]) {
      expect(`${id}:${declared(id)}`).toBe(`${id}:undefined`);
    }
  });

  it("review declares no glossary_consistent — it annotates, it does not rewrite", async () => {
    const { actions } = await loadBuiltinActions();
    const def = actions.find((a) => a.definition.id === "review")?.definition;
    expect(def?.output?.validators ?? []).toEqual([]);
  });

  it("every prose action's prompt states the layout rule too (D1)", async () => {
    // A validator that fires with no prompt telling the model what to do is a
    // retry the model cannot learn from.
    const { actions } = await loadBuiltinActions();
    for (const id of PROSE_ACTIONS) {
      const def = actions.find((a) => a.definition.id === id)?.definition;
      const prompt = `${def?.prompt?.system ?? ""} ${def?.prompt?.user ?? ""}`;
      expect(`${id}:${/blank line/.test(prompt)}`).toBe(`${id}:true`);
    }
  });

  it("review loads as a single-model L0 review action (annotations, M9)", async () => {
    const { actions, errors } = await loadBuiltinActions();
    expect(errors).toEqual([]);
    const review = actions.find((a) => a.definition.id === "review");
    expect(review).toBeDefined();
    const def = review?.definition;
    expect(def?.kind).toBe("review");
    expect(def?.routing?.level).toBe("L0");
    expect(def?.output?.contract).toBe("annotations");
    expect(def?.model?.fan_out ?? []).toEqual([]); // single-model MVP
    expect(def?.requires?.harness).toBe(">=0.2.0");
    // The reviewer must see the real text, not frozen tokens.
    expect(def?.context?.protected_spans).toBe("allow_edit");
    expect(def?.review_schema?.dimensions).toEqual([
      "clarity",
      "rigor",
      "structure",
      "language",
    ]);
    expect(def?.review_schema?.suggest_edits).toBe(true);
    expect(def?.review_ui?.mode).toBe("side_panel");
    expect(def?.name.zh).toBeTruthy();
    expect(def?.name.en).toBeTruthy();
    expect(def?.output?.validators ?? []).toEqual([]);
  });
});

/**
 * D4 / QA-3 (ADR 0041): `translate` is the tree's only enum parameter, and it
 * is the one the user meets — the picker offered the raw values "en" and "zh".
 */
describe("translate's target_language carries display labels (D4)", () => {
  it("labels every enum value in both locales", async () => {
    const { actions } = await loadBuiltinActions();
    const translate = actions.find(
      (a) => a.definition.id === "translate",
    )?.definition;
    const param = translate?.parameters?.find(
      (p) => p.id === "target_language",
    );
    expect(param?.enum).toEqual(["en", "zh"]);
    const labels = param?.enum_labels;
    expect(labels).toBeDefined();
    for (const value of param?.enum ?? []) {
      const l = labels?.[String(value)];
      expect(l?.en, `no en label for ${String(value)}`).toBeTruthy();
      expect(l?.zh, `no zh label for ${String(value)}`).toBeTruthy();
    }
  });

  it("labels are display names, never the raw value", async () => {
    const { actions } = await loadBuiltinActions();
    const param = actions
      .find((a) => a.definition.id === "translate")
      ?.definition.parameters?.find((p) => p.id === "target_language");
    expect(param?.enum_labels?.en?.en).not.toBe("en");
    expect(param?.enum_labels?.zh?.en).not.toBe("zh");
  });
});
