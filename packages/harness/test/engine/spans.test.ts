import { describe, expect, it } from "vitest";
import type {
  ProtectedSpan,
  SemanticUnit,
} from "../../src/contracts/adapters.js";
import {
  checkTokensIntact,
  freezeUnit,
  spansToFreeze,
  stripTokens,
  thawText,
} from "../../src/engine/spans.js";

const FILE = "main.tex";
/** Build a unit at absolute offset `base` and spans positioned inside it. */
function unitWith(text: string, base = 100): SemanticUnit {
  return {
    scope: "paragraph",
    text,
    span: { file: FILE, startOffset: base, endOffset: base + text.length },
  };
}
function span(
  kind: ProtectedSpan["kind"],
  token: string,
  start: number,
  end: number,
  raw: string,
  base = 100,
): ProtectedSpan {
  return {
    kind,
    token,
    raw,
    file: FILE,
    startOffset: base + start,
    endOffset: base + end,
  };
}

describe("freezeUnit / thawText", () => {
  const text = "Cost is $O(n^2)$ per \\citep{v17} token.";
  const spans = [
    span("math", "⟦P0⟧", 8, 16, "$O(n^2)$"),
    span("cite", "⟦P1⟧", 21, 32, "\\citep{v17}"),
  ];

  it("replaces spans with tokens and remembers raws", () => {
    const frozen = freezeUnit(unitWith(text), spans);
    expect(frozen.text).toBe("Cost is ⟦P0⟧ per ⟦P1⟧ token.");
    expect(frozen.tokens.get("⟦P0⟧")).toBe("$O(n^2)$");
    expect(frozen.tokens.get("⟦P1⟧")).toBe("\\citep{v17}");
  });

  it("thaw restores every token", () => {
    const frozen = freezeUnit(unitWith(text), spans);
    expect(thawText(frozen.text, frozen.tokens)).toBe(text);
  });

  it("clamps spans that extend past the unit boundary (M2 known issue)", () => {
    const frozen = freezeUnit(unitWith(text), [
      span("cite", "⟦P0⟧", 21, 60, "\\citep{v17} token. EXTRA"),
    ]);
    expect(frozen.text).toBe("Cost is $O(n^2)$ per ⟦P0⟧");
    expect(frozen.tokens.get("⟦P0⟧")).toBe("\\citep{v17} token.");
  });
});

describe("checkTokensIntact", () => {
  const tokens = new Map([
    ["⟦P0⟧", "$x$"],
    ["⟦P1⟧", "\\ref{a}"],
  ]);
  it("passes when every token appears exactly once", () => {
    expect(checkTokensIntact("a ⟦P0⟧ b ⟦P1⟧", tokens)).toEqual({
      missing: [],
      duplicated: [],
    });
  });
  it("reports missing and duplicated tokens", () => {
    expect(checkTokensIntact("a ⟦P0⟧ b ⟦P0⟧", tokens)).toEqual({
      missing: ["⟦P1⟧"],
      duplicated: ["⟦P0⟧"],
    });
  });
});

describe("stripTokens", () => {
  it("removes tokens so only editable prose remains (for language/count detection)", () => {
    const tokens = new Map([
      ["⟦P0⟧", "$O(n^2)$"],
      ["⟦P1⟧", "\\citep{vaswani2017attention}"],
    ]);
    expect(stripTokens("代价为 ⟦P0⟧，见 ⟦P1⟧。", tokens)).toBe(
      "代价为 ，见 。",
    );
  });
});

describe("spansToFreeze", () => {
  const spans = [
    span("math", "⟦P0⟧", 0, 1, "$x$"),
    span("cite", "⟦P1⟧", 2, 3, "\\cite{k}"),
  ];
  it("freeze keeps all; allow_edit keeps none; freeze_except filters", () => {
    expect(spansToFreeze(spans, "freeze")).toHaveLength(2);
    expect(spansToFreeze(spans, "allow_edit")).toHaveLength(0);
    expect(
      spansToFreeze(spans, { mode: "freeze_except", allow: ["cite"] }).map(
        (s) => s.kind,
      ),
    ).toEqual(["math"]);
  });
});
