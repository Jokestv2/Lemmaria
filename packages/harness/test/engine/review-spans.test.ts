import { describe, expect, it } from "vitest";
import type { ReviewAnnotation, ReviewSpan } from "../../src/contracts/data.js";
import {
  distinctIssues,
  endOf,
  normalizePath,
  spansOverlap,
} from "../../src/engine/review-spans.js";

/** A concern with only what the span rule reads; the rest is filler. */
function concern(
  id: string,
  dimension: string,
  span: ReviewSpan,
  severity: ReviewAnnotation["severity"] = "minor",
): ReviewAnnotation {
  return {
    id,
    reviewer: id.split("-")[0] as string,
    dimension,
    severity,
    span,
    message: `concern ${id}`,
  };
}

describe("the span rule has one home (V5, ADR 0087 §4)", () => {
  it("normalizePath: one leading ./ stripped and backslashes turned, nothing else", () => {
    expect(normalizePath("./main.tex")).toBe("main.tex");
    expect(normalizePath("sections\\method.tex")).toBe("sections/method.tex");
    expect(normalizePath(".\\main.tex")).toBe("main.tex");
    expect(normalizePath("main.tex")).toBe("main.tex");
    // No basename fallback — a basename is a guess (ADR 0060 §2).
    expect(normalizePath("sections/a.tex")).not.toBe(normalizePath("a.tex"));
  });

  it("endOf: the end line, or the line itself when the span is one line", () => {
    expect(endOf({ file: "a.tex", line: 4 })).toBe(4);
    expect(endOf({ file: "a.tex", line: 4, endLine: 7 })).toBe(7);
  });

  it("spansOverlap: the same normalised file and intersecting line ranges", () => {
    const a: ReviewSpan = { file: "main.tex", line: 10, endLine: 12 };
    expect(spansOverlap(a, { file: "main.tex", line: 12 })).toBe(true);
    expect(spansOverlap(a, { file: "./main.tex", line: 11 })).toBe(true);
    expect(spansOverlap(a, { file: "main.tex", line: 8, endLine: 10 })).toBe(
      true,
    );
    expect(spansOverlap(a, { file: "main.tex", line: 5, endLine: 20 })).toBe(
      true,
    );
    // Adjacent is not overlapping, and an absent endLine is the one line.
    expect(spansOverlap(a, { file: "main.tex", line: 13 })).toBe(false);
    expect(spansOverlap(a, { file: "main.tex", line: 9 })).toBe(false);
    // A different file never overlaps, whatever the lines.
    expect(spansOverlap(a, { file: "intro.tex", line: 11 })).toBe(false);
    // Symmetric.
    expect(spansOverlap({ file: "main.tex", line: 12 }, a)).toBe(true);
  });

  it("distinctIssues: overlapping claim spans in one dimension are one issue, transitively", () => {
    const x = concern("reviewer_a-1", "soundness", {
      file: "main.tex",
      line: 1,
      endLine: 2,
    });
    const y = concern("reviewer_b-1", "soundness", {
      file: "main.tex",
      line: 2,
      endLine: 3,
    });
    const z = concern("reviewer_c-1", "soundness", {
      file: "main.tex",
      line: 3,
      endLine: 4,
    });
    // x and z do not overlap, but y joins them: one issue.
    const groups = distinctIssues([x, z, y]);
    expect(groups.map((g) => g.map((a) => a.id))).toEqual([
      ["reviewer_a-1", "reviewer_c-1", "reviewer_b-1"],
    ]);
  });

  it("distinctIssues: two dimensions on one line are two issues, and order is kept", () => {
    const clarity = concern("reviewer_a-1", "clarity", {
      file: "main.tex",
      line: 5,
    });
    const language = concern("reviewer_a-2", "language", {
      file: "main.tex",
      line: 5,
    });
    const later = concern("reviewer_b-1", "clarity", {
      file: "main.tex",
      line: 5,
    });
    const elsewhere = concern("reviewer_b-2", "clarity", {
      file: "intro.tex",
      line: 5,
    });
    expect(
      distinctIssues([clarity, language, later, elsewhere]).map((g) =>
        g.map((a) => a.id),
      ),
    ).toEqual([
      ["reviewer_a-1", "reviewer_b-1"],
      ["reviewer_a-2"],
      ["reviewer_b-2"],
    ]);
    expect(distinctIssues([])).toEqual([]);
  });

  it("distinctIssues reads the claim span only, never the evidence", () => {
    const a: ReviewAnnotation = {
      ...concern("reviewer_a-1", "claims", { file: "main.tex", line: 1 }),
      evidence: { kind: "span", file: "main.tex", line: 40 },
    };
    const b = concern("reviewer_b-1", "claims", { file: "main.tex", line: 40 });
    expect(distinctIssues([a, b])).toHaveLength(2);
  });
});
