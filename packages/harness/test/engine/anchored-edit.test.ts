import { describe, expect, it } from "vitest";
import {
  extractJsonPayload,
  locateAnchor,
  parseAnchoredEdit,
} from "../../src/engine/anchored-edit.js";

describe("parseAnchoredEdit", () => {
  it("parses a plain JSON answer", () => {
    expect(
      parseAnchoredEdit(
        '{"anchor": "\\\\begin{doument}", "replacement": "\\\\begin{document}"}',
      ),
    ).toEqual({ anchor: "\\begin{doument}", replacement: "\\begin{document}" });
  });

  it("tolerates a ```json fence around the object", () => {
    const fenced = '```json\n{"anchor": "a{", "replacement": "a{}"}\n```';
    expect(parseAnchoredEdit(fenced)).toEqual({
      anchor: "a{",
      replacement: "a{}",
    });
  });

  // The single most common way a live L1 model violates the bare-JSON contract
  // is leaking a sentence of prose around the object — even when it found the
  // right fix. The engine must recover the object rather than discard the run
  // (the "no fix could be produced" report the compile-fix reliability hinges
  // on). See progress.md → Known issues → X1 fix-reliability.
  it("tolerates prose before a bare JSON object", () => {
    expect(
      parseAnchoredEdit(
        'I found the error on line 12. Here is the fix: {"anchor": "\\\\begin{documet}", "replacement": "\\\\begin{document}"}',
      ),
    ).toEqual({ anchor: "\\begin{documet}", replacement: "\\begin{document}" });
  });

  it("tolerates trailing prose after a bare JSON object", () => {
    expect(
      parseAnchoredEdit(
        '{"anchor": "x", "replacement": "y"} — this repairs the typo.',
      ),
    ).toEqual({ anchor: "x", replacement: "y" });
  });

  it("tolerates prose around a ```json fence", () => {
    const answer =
      'Sure, here is the repair:\n```json\n{"anchor": "a{", "replacement": "a{}"}\n```\nThat should compile now.';
    expect(parseAnchoredEdit(answer)).toEqual({
      anchor: "a{",
      replacement: "a{}",
    });
  });

  it("keeps an explicit file", () => {
    expect(
      parseAnchoredEdit(
        '{"anchor": "x", "replacement": "y", "file": "ch/a.tex"}',
      ),
    ).toEqual({ anchor: "x", replacement: "y", file: "ch/a.tex" });
  });

  it("rejects prose, missing anchor, empty anchor, and non-string replacement", () => {
    expect(parseAnchoredEdit("Sure! Here is the fix …")).toHaveProperty(
      "error",
    );
    expect(parseAnchoredEdit('{"replacement": "y"}')).toHaveProperty("error");
    expect(
      parseAnchoredEdit('{"anchor": "", "replacement": "y"}'),
    ).toHaveProperty("error");
    expect(
      parseAnchoredEdit('{"anchor": "x", "replacement": 3}'),
    ).toHaveProperty("error");
  });
});

describe("extractJsonPayload", () => {
  // review.ts parses a JSON ARRAY through this same helper — the tolerant
  // extraction must not break that (regression guard for the shared seam).
  it("recovers a bare array from surrounding prose (review's shape)", () => {
    expect(
      extractJsonPayload('Here are the issues:\n[{"a":1},{"b":2}]\nDone.'),
    ).toBe('[{"a":1},{"b":2}]');
  });

  it("returns the body unchanged when there is no JSON to find", () => {
    expect(extractJsonPayload("Sure! Here is the fix …")).toBe(
      "Sure! Here is the fix …",
    );
  });
});

describe("locateAnchor", () => {
  const text = "aaa \\label{sec:intro\nbbb ccc \\label{sec:other}\n";

  it("locates a unique occurrence", () => {
    expect(locateAnchor(text, "\\label{sec:intro\n")).toEqual({
      offset: text.indexOf("\\label{sec:intro\n"),
    });
  });

  it("reports not_found and ambiguous", () => {
    expect(locateAnchor(text, "zzz")).toEqual({ error: "not_found" });
    expect(locateAnchor(text, "\\label{sec:")).toEqual({ error: "ambiguous" });
  });
});
