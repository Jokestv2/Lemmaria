import { describe, expect, it } from "vitest";
import {
  declaredRemovals,
  removalLine,
} from "../src/webview/parts/removals.js";

const edit = (over: Record<string, unknown> = {}) =>
  ({
    file: "main.tex",
    kind: "replace",
    anchor: "a",
    replacement: "b",
    status: "pending",
    ...over,
  }) as Parameters<typeof declaredRemovals>[0][number];

describe("declaredRemovals (X2's T6 / D2 deliverable 8)", () => {
  it("is empty when nothing was declared", () => {
    expect(declaredRemovals([edit(), edit()], [0, 1])).toEqual([]);
  });

  it("unions across the indices of ONE per-file group", () => {
    // The approval unit is the file (A1b), so the row covers several edits.
    const edits = [
      edit({ removesProtected: ["% TODO"] }),
      edit({ removesProtected: ["$x^2$"] }),
    ];
    expect(declaredRemovals(edits, [0, 1])).toEqual(["% TODO", "$x^2$"]);
  });

  it("reads only the indices it was given", () => {
    const edits = [
      edit({ file: "a.tex", removesProtected: ["% mine"] }),
      edit({ file: "b.tex", removesProtected: ["% theirs"] }),
    ];
    expect(declaredRemovals(edits, [1])).toEqual(["% theirs"]);
  });

  it("dedupes, keeping first-appearance order", () => {
    const edits = [
      edit({ removesProtected: ["\\cite{a}", "% TODO"] }),
      edit({ removesProtected: ["% TODO"] }),
    ];
    expect(declaredRemovals(edits, [0, 1])).toEqual(["\\cite{a}", "% TODO"]);
  });
});

describe("removalLine", () => {
  it("renders nothing when nothing was declared", () => {
    expect(removalLine([], "en")).toBeUndefined();
  });

  it("names each declared span, verbatim, in English", () => {
    const node = removalLine(["$x^2$", "\\cite{smith}"], "en");
    const text = node?.textContent ?? "";
    expect(text).toContain("$x^2$");
    expect(text).toContain("\\cite{smith}");
    expect(text).toMatch(/remov/i);
  });

  it("names them in Chinese under zh, with no English label", () => {
    // Invariant 6 rule 2, asserted as a SEPARATE case against a separate
    // string. The declared spans themselves are document content and pass
    // through unaltered (rule 1) — only the label is localized.
    const node = removalLine(["$x^2$"], "zh");
    const text = node?.textContent ?? "";
    expect(text).toMatch(/[一-鿿]/);
    expect(text).toContain("$x^2$");
    expect(text).not.toMatch(/\bremoved\b|\bdeclared\b/i);
  });

  it("writes the spans as text, never as markup", () => {
    // A declared span is text the MODEL produced, quoting document source.
    const node = removalLine(["<script>x</script>"], "en");
    expect(node?.textContent).toContain("<script>x</script>");
    expect(node?.querySelector("script")).toBeNull();
  });

  it("uses the note line's class, so it sits under the row like a note", () => {
    expect(removalLine(["% TODO"], "en")?.className).toContain(
      "lm-proposal__note-line",
    );
  });
});
