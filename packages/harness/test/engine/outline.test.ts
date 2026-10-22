import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../../src/contracts/tools.js";
import { flattenOutline, serializeOutline } from "../../src/engine/outline.js";

const tree: OutlineNode[] = [
  {
    title: "Introduction",
    file: "main.tex",
    startLine: 3,
    endLine: 40,
    wordCount: 320,
    labels: ["sec:intro"],
    citations: ["smith2020", "doe2021"],
    children: [
      {
        title: "Motivation",
        file: "main.tex",
        startLine: 12,
        endLine: 40,
        wordCount: 150,
        labels: [],
        citations: [],
        children: [],
      },
    ],
  },
  {
    title: "Method",
    file: "sections/method.tex",
    startLine: 1,
    endLine: 55,
    wordCount: 700,
    labels: ["sec:method"],
    citations: [],
    children: [],
  },
];

describe("serializeOutline (CM2 repo map)", () => {
  it("renders one compact depth-indented line per node", () => {
    expect(serializeOutline(tree)).toBe(
      [
        "- Introduction [main.tex:3-40, 320w] labels: sec:intro cites: smith2020,doe2021",
        "  - Motivation [main.tex:12-40, 150w]",
        "- Method [sections/method.tex:1-55, 700w] labels: sec:method",
      ].join("\n"),
    );
  });

  it("is empty for an empty tree", () => {
    expect(serializeOutline([])).toBe("");
  });
});

describe("flattenOutline", () => {
  it("pre-order flattening", () => {
    expect(flattenOutline(tree).map((n) => n.title)).toEqual([
      "Introduction",
      "Motivation",
      "Method",
    ]);
  });
});
