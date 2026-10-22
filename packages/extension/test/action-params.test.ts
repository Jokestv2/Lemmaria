/**
 * D4 / QA-3 (ADR 0041): an enum parameter's picker offers display labels and
 * returns the enum VALUE.
 *
 * The mapping is a pure exported function precisely so it can be asserted here
 * without driving a real quick pick — the ADR 0037 §4 shape applied to the host
 * side. What is deliberately NOT asserted is the `showQuickPick` call itself:
 * mocking the VS Code API to observe it would assert the mock.
 */
import * as assert from "node:assert/strict";
import { actionLabel, enumPickItems } from "../src/action-run";
import { currentLocale, pickLocaleLabel } from "../src/i18n";

const param = {
  id: "target_language",
  name: { en: "Target language", zh: "目标语言" },
  type: "enum" as const,
  enum: ["en", "zh"],
  enum_labels: {
    en: { en: "English", zh: "英文" },
    zh: { en: "Simplified Chinese", zh: "简体中文" },
  },
};

suite("D4 enum parameter labels", () => {
  test("offers the English display name under the en locale", () => {
    assert.deepStrictEqual(
      enumPickItems(param, "en").map((i) => i.label),
      ["English", "Simplified Chinese"],
    );
  });

  test("offers the Chinese display name under the zh locale", () => {
    assert.deepStrictEqual(
      enumPickItems(param, "zh").map((i) => i.label),
      ["英文", "简体中文"],
    );
  });

  test("returns the raw enum VALUE, not the label", () => {
    // engine/params.ts validates the supplied value against `enum` membership,
    // so a label sent in its place would throw.
    for (const locale of ["en", "zh"] as const) {
      assert.deepStrictEqual(
        enumPickItems(param, locale).map((i) => i.value),
        ["en", "zh"],
      );
    }
  });

  test("a value with no label falls back to the value itself", () => {
    const partial = { ...param, enum_labels: { en: { en: "English" } } };
    const items = enumPickItems(partial, "en");
    assert.deepStrictEqual(
      items.map((i) => i.label),
      ["English", "zh"],
    );
    assert.deepStrictEqual(
      items.map((i) => i.value),
      ["en", "zh"],
    );
  });

  test("a parameter with no labels at all still offers every value", () => {
    const bare = { id: "x", type: "enum" as const, enum: ["a", "b"] };
    assert.deepStrictEqual(
      enumPickItems(bare, "en").map((i) => i.label),
      ["a", "b"],
    );
  });

  /**
   * D4: `actionLabel` was `def.name.en ?? …` — English-only, so a Chinese
   * editor named the action in English in every progress title and toast while
   * the CodeLens row beside it named it in Chinese.
   *
   * Asserted through the PURE picker `actionLabel` now delegates to. An
   * assertion on `actionLabel` itself cannot fail: it reads
   * `vscode.env.language`, which is fixed at launch, so `["Polish", "润色"]
   * .includes(...)` passes under either locale — and would have passed against
   * the pre-D4 English-only version too. Found by D4's code review.
   */
  test("a label resolves to each locale, falling back across them", () => {
    const name = { en: "Polish", zh: "润色" };
    assert.strictEqual(pickLocaleLabel(name, "polish", "en"), "Polish");
    assert.strictEqual(pickLocaleLabel(name, "polish", "zh"), "润色");
    // A one-sided name falls back rather than rendering the id.
    assert.strictEqual(
      pickLocaleLabel({ en: "Only EN" }, "x", "zh"),
      "Only EN",
    );
    assert.strictEqual(
      pickLocaleLabel({ zh: "只有中文" }, "x", "en"),
      "只有中文",
    );
    assert.strictEqual(
      pickLocaleLabel(undefined, "fallback-id", "en"),
      "fallback-id",
    );
  });

  test("actionLabel goes through that picker", () => {
    const def = {
      id: "polish",
      name: { en: "Polish", zh: "润色" },
    } as Parameters<typeof actionLabel>[0];
    assert.strictEqual(
      actionLabel(def),
      pickLocaleLabel(def.name, def.id, currentLocale()),
    );
  });
});
