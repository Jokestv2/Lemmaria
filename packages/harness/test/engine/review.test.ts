import { describe, expect, it } from "vitest";
import {
  type AnnotationsInput,
  interpretAnnotations,
} from "../../src/engine/review.js";

const FILE = "main.tex";
// The reviewed unit does NOT start at the file head: two newlines precede it,
// so the unit's first line is file line 3.
const PRE = "\\documentclass{article}\n\\begin{document}\n";
const UNIT =
  "First sentence stays.\nThe claim lacks a baseline.\nFinal thought here.";
const POST = "\n\\end{document}\n";
const CONTENT = PRE + UNIT + POST;

function input(over: Partial<AnnotationsInput> = {}): AnnotationsInput {
  return {
    answer: "",
    unitText: UNIT,
    unitStartOffset: PRE.length,
    fileContent: CONTENT,
    file: FILE,
    reviewer: "writing",
    suggestEdits: true,
    ...over,
  };
}

const VALID = JSON.stringify({
  annotations: [
    {
      dimension: "rigor",
      severity: "major",
      anchor: "The claim lacks a baseline.",
      message: "Define the baseline this claim is measured against.",
      suggestion: "The claim lacks a baseline; we define one in Section 4.",
    },
    {
      dimension: "clarity",
      severity: "info",
      anchor: "Final thought here.",
      message: "Consider tightening the closing sentence.",
    },
  ],
});

describe("interpretAnnotations", () => {
  it("locates anchors, stamps the reviewer, and computes file line numbers", () => {
    const out = interpretAnnotations(input({ answer: VALID }));
    expect(out.failure).toBeUndefined();
    expect(out.dropped).toEqual([]);
    const anns = out.result?.annotations;
    expect(anns).toHaveLength(2);
    expect(anns?.[0]).toEqual({
      id: "writing-1",
      reviewer: "writing",
      dimension: "rigor",
      severity: "major",
      span: { file: FILE, line: 4 },
      message: "Define the baseline this claim is measured against.",
      suggestedEdit: {
        original: "The claim lacks a baseline.",
        replacement: "The claim lacks a baseline; we define one in Section 4.",
      },
    });
    expect(anns?.[1]?.id).toBe("writing-2");
    expect(anns?.[1]?.span).toEqual({ file: FILE, line: 5 });
    expect(anns?.[1]?.suggestedEdit).toBeUndefined();
    expect(out.result?.synthesis).toBeUndefined();
    // Nothing dropped ⇒ no honesty record at all (ADR 0060): a clean quick
    // action's result is byte-identical to the pre-R2 one except for `id`.
    expect(out.result?.limits).toBeUndefined();
  });

  it("a model-supplied id is ignored; the harness stamps its own", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          id: "M7",
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "x",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.id).toBe("writing-1");
  });

  it("accepts the JSON wrapped in a code fence", () => {
    const out = interpretAnnotations(
      input({ answer: `\`\`\`json\n${VALID}\n\`\`\`` }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(2);
  });

  it("a multi-line anchor yields an endLine", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "structure",
          severity: "minor",
          anchor: "The claim lacks a baseline.\nFinal thought here.",
          message: "These two sentences belong in separate paragraphs.",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.result?.annotations[0]?.span).toEqual({
      file: FILE,
      line: 4,
      endLine: 5,
    });
  });

  it("unparseable answers are a hard failure mentioning JSON", () => {
    const out = interpretAnnotations(input({ answer: "Sure! Here goes…" }));
    expect(out.result).toBeUndefined();
    expect(out.failure).toMatch(/JSON/);
  });

  it("a missing or empty annotations array is a hard failure", () => {
    expect(
      interpretAnnotations(input({ answer: '{"foo": 1}' })).failure,
    ).toBeDefined();
    expect(
      interpretAnnotations(input({ answer: '{"annotations": []}' })).failure,
    ).toBeDefined();
  });

  it("an invalid severity is a hard failure naming the allowed values", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "catastrophic",
          anchor: "Final thought here.",
          message: "x",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toMatch(/info.*minor.*major/);
  });

  it("a severity outside the action's allowed subset is a hard failure", () => {
    const out = interpretAnnotations(
      input({ answer: VALID, allowedSeverities: ["major"] }),
    );
    expect(out.failure).toMatch(/major/);
  });

  it("a dimension outside review_schema.dimensions is a hard failure naming them", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "novelty",
          severity: "info",
          anchor: "Final thought here.",
          message: "x",
        },
      ],
    });
    const out = interpretAnnotations(
      input({ answer, allowedDimensions: ["clarity", "rigor"] }),
    );
    expect(out.failure).toMatch(/clarity/);
    expect(out.failure).toMatch(/rigor/);
  });

  it("dimension matching is case-insensitive and keeps the model's casing", () => {
    const out = interpretAnnotations(
      input({ answer: VALID, allowedDimensions: ["Rigor", "CLARITY"] }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.dimension).toBe("rigor");
  });

  it("an unlocatable anchor is dropped; the rest survive", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "major",
          anchor: "text that is not in the unit",
          message: "x",
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.dropped).toEqual(["text that is not in the unit"]);
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.message).toBe("y");
    // Identity is dense over the LOCATED annotations: the dropped first entry
    // consumes no number, so the survivor is writing-1, not writing-2 (D1).
    expect(out.result?.annotations[0]?.id).toBe("writing-1");
    // The drop is a fact the result carries, not only a retry signal (D6).
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [
          {
            anchor: "text that is not in the unit",
            role: "claim",
            reason: "not_found",
          },
        ],
      },
    ]);
  });

  it("an anchor that is ambiguous within the unit is dropped, recorded as ambiguous", () => {
    // "Fi" occurs in BOTH "First" and "Final" — genuinely ambiguous. The old
    // anchor here was "the", which occurs nowhere in the unit in lower case, so
    // this case was asserting `not_found` under an "ambiguous" name; only
    // `dropped` was checked, which cannot tell the two reasons apart.
    const answer = JSON.stringify({
      annotations: [
        { dimension: "rigor", severity: "info", anchor: "Fi", message: "x" },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.dropped).toEqual(["Fi"]);
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [{ anchor: "Fi", role: "claim", reason: "ambiguous" }],
      },
    ]);
  });

  it("all anchors unlocatable is a hard failure listing them", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "info",
          anchor: "absent text",
          message: "x",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.result).toBeUndefined();
    expect(out.failure).toMatch(/absent text/);
  });

  it("thaws frozen tokens in anchors and suggestions before locating", () => {
    // The prompt showed the model "…lacks a ⟦P0⟧." for "…lacks a baseline.";
    // a copied anchor must still locate against the RAW unit text.
    const thaw = (text: string) => text.replaceAll("⟦P0⟧", "baseline");
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "minor",
          anchor: "lacks a ⟦P0⟧.",
          message: "x",
          suggestion: "lacks a ⟦P0⟧ (see §4).",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer, thaw }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.suggestedEdit).toEqual({
      original: "lacks a baseline.",
      replacement: "lacks a baseline (see §4).",
    });
  });

  it("caps a flooding model at 50 annotations (defensive)", () => {
    const answer = JSON.stringify({
      annotations: Array.from({ length: 60 }, () => ({
        dimension: "clarity",
        severity: "info",
        anchor: "Final thought here.",
        message: "x",
      })),
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(50);
  });

  it("the cap counts ENTRIES, before location", () => {
    // 60 entries of which the first 20 cannot locate. Capping entries keeps the
    // head of 50 and yields 40 located; capping the located ones would yield
    // 50. The sibling case above cannot tell those apart — every one of its
    // anchors locates — so the ordering the tier table claims is asserted here.
    const answer = JSON.stringify({
      annotations: [
        ...Array.from({ length: 20 }, (_, i) => ({
          dimension: "clarity",
          severity: "info",
          anchor: `absent anchor ${i}`,
          message: "x",
        })),
        ...Array.from({ length: 40 }, () => ({
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        })),
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(30);
    expect(out.dropped).toHaveLength(20);
  });

  it("suggestEdits: false strips suggestions but keeps annotations", () => {
    const out = interpretAnnotations(
      input({ answer: VALID, suggestEdits: false }),
    );
    expect(out.result?.annotations).toHaveLength(2);
    expect(out.result?.annotations[0]?.suggestedEdit).toBeUndefined();
  });
});

// ── blocking, evidence, file: the R2 fields on the quick action's path ───────
// (ADR 0060 D2/D3/D4). The quick action's own prompt asks for none of them, so
// every rule below is about accepting what a model volunteers — and refusing
// what the protocol forbids.

/** One wire entry, with the two required fields defaulted. */
function entry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    annotations: [
      {
        dimension: "rigor",
        severity: "major",
        anchor: "The claim lacks a baseline.",
        message: "x",
        ...over,
      },
    ],
  });
}

describe("interpretAnnotations — blocking (ADR 0060 D3)", () => {
  it("carries true and false on a major", () => {
    for (const blocking of [true, false]) {
      const out = interpretAnnotations(input({ answer: entry({ blocking }) }));
      expect(out.failure).toBeUndefined();
      expect(out.result?.annotations[0]?.blocking).toBe(blocking);
    }
  });

  it("is a hard failure on a non-major, naming the rule and the severity", () => {
    const out = interpretAnnotations(
      input({ answer: entry({ severity: "minor", blocking: true }) }),
    );
    expect(out.result).toBeUndefined();
    expect(out.failure).toMatch(/only on a "major"/);
    expect(out.failure).toMatch(/minor/);
  });

  it("is a hard failure when it is not a boolean", () => {
    const out = interpretAnnotations(
      input({ answer: entry({ blocking: "yes" }) }),
    );
    expect(out.failure).toMatch(/"blocking"/);
  });

  it("absent stays absent", () => {
    const out = interpretAnnotations(input({ answer: entry() }));
    expect(out.result?.annotations[0]).not.toHaveProperty("blocking");
  });
});

describe("interpretAnnotations — evidence (ADR 0060 D2)", () => {
  it('"missing" passes through as the literal', () => {
    const out = interpretAnnotations(
      input({ answer: entry({ evidence: "missing" }) }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.evidence).toEqual({ kind: "missing" });
  });

  it("an anchor object is located like a claim anchor", () => {
    const out = interpretAnnotations(
      input({
        answer: entry({ evidence: { anchor: "First sentence stays." } }),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "span",
      file: FILE,
      line: 3,
    });
  });

  it("an evidence anchor naming the unit's own file is accepted", () => {
    const out = interpretAnnotations(
      input({
        answer: entry({
          evidence: { anchor: "First sentence stays.", file: "./main.tex" },
        }),
      }),
    );
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "span",
      file: FILE,
      line: 3,
    });
  });

  it("an unlocatable evidence anchor drops the WHOLE annotation, as role: evidence — never coerced to missing", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "major",
          anchor: "The claim lacks a baseline.",
          message: "x",
          evidence: { anchor: "not there" },
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.message).toBe("y");
    // The retry feedback names it, so a retry can correct the quote.
    expect(out.dropped).toEqual(["not there"]);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [
          { anchor: "not there", role: "evidence", reason: "not_found" },
        ],
      },
    ]);
  });

  it("an ambiguous evidence anchor drops the annotation, recorded as ambiguous", () => {
    // Two entries, so the survivor keeps the result alive and the limit is
    // observable — with one entry everything drops and the record is lost to
    // the quick action's all-dropped hard failure, which asserts nothing about
    // the ROLE or the REASON this row is actually about.
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "major",
          anchor: "The claim lacks a baseline.",
          message: "x",
          evidence: { anchor: "Fi" },
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.message).toBe("y");
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [{ anchor: "Fi", role: "evidence", reason: "ambiguous" }],
      },
    ]);
  });

  it("an evidence anchor that is the WHOLE annotation's only hope still hard-fails when nothing locates", () => {
    const out = interpretAnnotations(
      input({ answer: entry({ evidence: { anchor: "Fi" } }) }),
    );
    // One entry, dropped ⇒ the quick action's all-dropped hard failure, which
    // ADR 0060 §2 keeps for this mode and narrows away from a ledger.
    expect(out.result).toBeUndefined();
    expect(out.failure).toMatch(/no anchor could be located/);
  });

  it("malformed evidence is a hard failure", () => {
    for (const evidence of [
      42,
      {},
      { anchor: "" },
      { anchor: "x", file: 7 },
      null,
    ]) {
      const out = interpretAnnotations(input({ answer: entry({ evidence }) }));
      expect(out.result, JSON.stringify(evidence)).toBeUndefined();
      expect(out.failure, JSON.stringify(evidence)).toMatch(/"evidence"/);
    }
  });

  it("a paper is not one of the quick action's forms, and its sentence is unchanged (V2, O1)", () => {
    // V2 (ADR 0078 §2) gave the LEDGER a third wire form. The quick action
    // sets no `resolvePaper`, so `{"paper": …}` is just an evidence object
    // with no `anchor` — refused with the sentence it has given since ADR
    // 0060, byte for byte. Its prompt never asks for a paper and its reviewer
    // never searches, so a paper here would be a claim with nothing behind it.
    const out = interpretAnnotations(
      input({ answer: entry({ evidence: { paper: { title: "Adam" } } }) }),
    );
    expect(out.result).toBeUndefined();
    expect(out.failure).toBe(
      '"evidence" needs a non-empty "anchor" copied VERBATIM from the manuscript (or the literal "missing")',
    );
  });

  it("absent stays absent — the quick action never asks, so absent is not missing", () => {
    const out = interpretAnnotations(input({ answer: entry() }));
    expect(out.result?.annotations[0]).not.toHaveProperty("evidence");
  });

  it("thaws frozen tokens in an evidence anchor before locating", () => {
    const thaw = (text: string) => text.replaceAll("⟦P0⟧", "baseline");
    const out = interpretAnnotations(
      input({
        answer: entry({ evidence: { anchor: "lacks a ⟦P0⟧." } }),
        thaw,
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "span",
      file: FILE,
      line: 4,
    });
  });

  it("the 50-cap counts entries before location, evidence and all", () => {
    const answer = JSON.stringify({
      annotations: Array.from({ length: 60 }, () => ({
        dimension: "clarity",
        severity: "info",
        anchor: "Final thought here.",
        message: "x",
        evidence: { anchor: "First sentence stays." },
      })),
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(50);
  });
});

describe("interpretAnnotations — file on a claim (ADR 0060 D4, quick scope)", () => {
  it("accepts the unit's own file, exact or normalized", () => {
    // The backslash form matters here and not only in ledger mode: a model on
    // Windows writes `sections\intro.tex`, and normalization is shared code.
    for (const file of ["main.tex", "./main.tex", ".\\main.tex"]) {
      const out = interpretAnnotations(input({ answer: entry({ file }) }));
      expect(out.failure, file).toBeUndefined();
      expect(out.result?.annotations[0]?.span).toEqual({ file: FILE, line: 4 });
    }
  });

  it("drops any other file with reason unknown_file, recording the name the model wrote", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "major",
          anchor: "The claim lacks a baseline.",
          message: "x",
          file: "other.tex",
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "Final thought here.",
          message: "y",
        },
      ],
    });
    const out = interpretAnnotations(input({ answer }));
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [
          {
            anchor: "The claim lacks a baseline.",
            file: "other.tex",
            role: "claim",
            reason: "unknown_file",
          },
        ],
      },
    ]);
  });

  it("a non-string file is a hard failure", () => {
    const out = interpretAnnotations(input({ answer: entry({ file: 7 }) }));
    expect(out.failure).toMatch(/"file"/);
  });
});
