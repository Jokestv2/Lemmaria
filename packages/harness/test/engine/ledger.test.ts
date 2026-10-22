import { describe, expect, it } from "vitest";
import type { LiteratureResult } from "../../src/engine/literature.js";
import {
  IMPRESSION_CONTRADICTION_FLOOR,
  type LedgerInput,
  type SeatOutcome,
  assembleReview,
  describeLedgerProblems,
  interpretAnnotations,
  interpretLedger,
  interpretSynthesis,
  mergeLedgerCorrection,
  setAsideConcerns,
} from "../../src/engine/review.js";

// The manuscript a seat reads WHOLE (ADR 0060 §2), in two files. Three shapes
// are deliberate and each is load-bearing below:
//   · "The method is described below." appears in BOTH files — unique within
//     each, so each locates in its own file and neither is ambiguous.
//   · "A fixed seed was used." is unique in main.tex and appears TWICE in
//     sections/method.tex — the anchor that locates or not depending on which
//     file the model named.
//   · "Each figure is reproducible." is unique to sections/method.tex and
//     absent from main.tex — the anchor that reaches the manuscript-wide
//     fallback (ADR 0074 §1) and is counted `relocated`.
//   · A bare basename still never PICKS a file: it resolves to no key, so the
//     fallback runs, and two files holding the quote are ambiguous rather than
//     a guess (`SHARED` below is what proves it).
const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "The method is described below.",
  "We report no baseline for the headline claim.",
  "A fixed seed was used.",
  "Results follow in Section 4.",
  "\\end{document}",
  "",
].join("\n");

const METHOD = [
  "\\section{Method}",
  "The method is described below.",
  "A fixed seed was used. A fixed seed was used.",
  "Each figure is reproducible.",
  "",
].join("\n");

const FILES = new Map([
  ["main.tex", MAIN],
  ["sections/method.tex", METHOD],
]);

/** A sentence that exists in more than one manuscript file — the case a
 *  manuscript-wide fallback must refuse rather than guess at (ADR 0074 §1). */
const SHARED = "This sentence lives in two files at once.";

/** A throwaway section file holding one sentence, for the multi-file cases. */
function sectionHolding(title: string, sentence: string): string {
  return [`\\section{${title}}`, sentence, ""].join("\n");
}

function ledger(over: Partial<LedgerInput> = {}): LedgerInput {
  return {
    answer: "",
    reviewer: "claims",
    files: FILES,
    defaultFile: "main.tex",
    suggestEdits: true,
    ...over,
  };
}

/** One wire concern, with the ledger's two required fields defaulted. */
function concern(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: "claims",
    severity: "major",
    anchor: "We report no baseline for the headline claim.",
    message: "The headline claim is asserted without a comparison.",
    evidence: "missing",
    ...over,
  };
}

function wire(...entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ annotations: entries });
}

describe("interpretLedger — whole-file location (ADR 0060 §2)", () => {
  it("locates a bare anchor in defaultFile and stamps a seat-prefixed id", () => {
    const out = interpretLedger(ledger({ answer: wire(concern()) }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]).toEqual({
      id: "claims-1",
      reviewer: "claims",
      dimension: "claims",
      severity: "major",
      span: { file: "main.tex", line: 4 },
      message: "The headline claim is asserted without a comparison.",
      evidence: { kind: "missing" },
    });
    expect(out.result?.limits).toBeUndefined();
  });

  it("locates in the file the model named, with lines from that file at offset 0", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor: "Each figure is reproducible.",
            file: "sections/method.tex",
          }),
        ),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.span).toEqual({
      file: "sections/method.tex",
      line: 4,
    });
  });

  it("normalizes a backslash path and a leading ./ , and nothing else", () => {
    for (const file of ["sections\\method.tex", "./sections/method.tex"]) {
      const out = interpretLedger(
        ledger({
          answer: wire(
            concern({ anchor: "Each figure is reproducible.", file }),
          ),
        }),
      );
      expect(out.failure, file).toBeUndefined();
      // The span carries the map's OWN key, not the string the model wrote.
      expect(out.result?.annotations[0]?.span.file, file).toBe(
        "sections/method.tex",
      );
    }
  });

  it("searches PAST a file the manuscript does not have, and locates a quote that is unique (X5 O3)", () => {
    // Before X5 a `file` the map lacked ended location outright. It no longer
    // does — but the basename is NOT what picked the file: the quote's
    // uniqueness in the manuscript is, which the next test is what proves.
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor: "Each figure is reproducible.",
            file: "method.tex",
          }),
        ),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.span).toEqual({
      file: "sections/method.tex",
      line: 4,
    });
    expect(out.result?.limits).toBeUndefined();
    expect(out.counts?.relocated).toBe(1);
  });

  it("a named file the manuscript lacks, with a quote that is nowhere, drops unknown_file carrying the model's own string (X5 O3)", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor: "No sentence of this manuscript reads like this.",
            file: "method.tex",
          }),
        ),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "claims",
        anchors: [
          {
            anchor: "No sentence of this manuscript reads like this.",
            file: "method.tex",
            role: "claim",
            reason: "unknown_file",
          },
        ],
      },
    ]);
  });

  it("a BASENAME never picks a file: two files sharing one, cited by it, are ambiguous (X5 O2)", () => {
    // The rule ADR 0060 set and ADR 0074 §1 keeps. `a.tex` names neither
    // `sections/a.tex` nor `old/a.tex`, so the fallback runs — and finds the
    // quote in both, which is exactly the guess the harness refuses to make.
    const out = interpretLedger(
      ledger({
        files: new Map([
          ["main.tex", MAIN],
          ["sections/a.tex", sectionHolding("A", SHARED)],
          ["old/a.tex", sectionHolding("Old", SHARED)],
        ]),
        answer: wire(concern({ anchor: SHARED, file: "a.tex" })),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.result?.limits?.[0]).toEqual({
      kind: "anchors_dropped",
      reviewer: "claims",
      // No `file`: the ambiguity is manuscript-wide, not inside one file.
      anchors: [{ anchor: SHARED, role: "claim", reason: "ambiguous" }],
    });
  });

  it("a bare anchor absent from the entry locates in the one other file that holds it (X5 O1)", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ anchor: "Each figure is reproducible." })),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.span).toEqual({
      file: "sections/method.tex",
      line: 4,
    });
    expect(out.result?.limits).toBeUndefined();
    expect(out.counts).toEqual({
      entries: 1,
      located: 1,
      relocated: 1,
      dropped: 0,
      rejected: 0,
    });
  });

  it("a bare anchor present in more than one OTHER file is ambiguous, with no file (X5 O2)", () => {
    const out = interpretLedger(
      ledger({
        files: new Map([
          ["main.tex", MAIN],
          ["sections/method.tex", METHOD],
          ["sections/extra.tex", sectionHolding("Extra", SHARED)],
          ["sections/more.tex", sectionHolding("More", SHARED)],
        ]),
        answer: wire(concern({ anchor: SHARED })),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.limits?.[0]).toEqual({
      kind: "anchors_dropped",
      reviewer: "claims",
      anchors: [{ anchor: SHARED, role: "claim", reason: "ambiguous" }],
    });
  });

  it("a quote in NO file of the manuscript is not_found, naming where the search started (X5 O1)", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor: "No sentence of this manuscript reads like this.",
          }),
        ),
      }),
    );
    expect(out.result?.limits?.[0]).toEqual({
      kind: "anchors_dropped",
      reviewer: "claims",
      anchors: [
        {
          anchor: "No sentence of this manuscript reads like this.",
          file: "main.tex",
          role: "claim",
          reason: "not_found",
        },
      ],
    });
  });

  it("a quote located where the search started is NOT counted relocated", () => {
    const out = interpretLedger(ledger({ answer: wire(concern()) }));
    expect(out.counts).toEqual({
      entries: 1,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
  });

  it("the same passage in two files locates within whichever one is named", () => {
    const anchor = "The method is described below.";
    const inMain = interpretLedger(
      ledger({ answer: wire(concern({ anchor })) }),
    );
    expect(inMain.result?.annotations[0]?.span).toEqual({
      file: "main.tex",
      line: 3,
    });
    const inMethod = interpretLedger(
      ledger({
        answer: wire(concern({ anchor, file: "sections/method.tex" })),
      }),
    );
    expect(inMethod.result?.annotations[0]?.span).toEqual({
      file: "sections/method.tex",
      line: 2,
    });
  });

  it("an anchor unique in one file but repeated in the named one is ambiguous, with the file recorded", () => {
    const anchor = "A fixed seed was used.";
    expect(
      interpretLedger(ledger({ answer: wire(concern({ anchor })) })).result
        ?.annotations,
    ).toHaveLength(1);
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ anchor, file: "sections/method.tex" })),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "claims",
        anchors: [
          {
            anchor,
            file: "sections/method.tex",
            role: "claim",
            reason: "ambiguous",
          },
        ],
      },
    ]);
  });

  it("a multi-line anchor yields an endLine from the named file", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor:
              "We report no baseline for the headline claim.\nA fixed seed was used.",
          }),
        ),
      }),
    );
    expect(out.result?.annotations[0]?.span).toEqual({
      file: "main.tex",
      line: 4,
      endLine: 5,
    });
  });

  it("THROWS on a defaultFile outside the files map — a driver bug, not a model error", () => {
    // Not a `failure`: that is the MODEL's channel, which R3 may hand back to a
    // seat as retry feedback and which assembleReview files as
    // `seat_missing / unparsed` — saying *this reviewer failed to write a
    // ledger* about a reviewer that did. Same call as the duplicate-seat throw.
    expect(() =>
      interpretLedger(
        ledger({ answer: wire(concern()), defaultFile: "nope.tex" }),
      ),
    ).toThrow(/nope\.tex/);
  });
});

describe("interpretLedger — no quota; one malformed entry costs one entry (ADR 0074 §3)", () => {
  it("an empty ledger is a valid result with no limits", () => {
    const out = interpretLedger(ledger({ answer: '{"annotations": []}' }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toEqual([]);
    expect(out.result?.limits).toBeUndefined();
  });

  it("every anchor dropped is a RESULT with a limit, not a failure", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ anchor: "no such passage" }),
          concern({ anchor: "nor this one" }),
        ),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toEqual([]);
    expect(out.result?.limits?.[0]).toMatchObject({
      kind: "anchors_dropped",
      reviewer: "claims",
    });
    expect(
      (out.result?.limits?.[0] as { anchors: unknown[] }).anchors,
    ).toHaveLength(2);
  });

  it("evidence is REQUIRED — absent is a shape failure naming it", () => {
    const answer = JSON.stringify({
      annotations: [
        {
          dimension: "claims",
          severity: "major",
          anchor: "We report no baseline for the headline claim.",
          message: "x",
        },
      ],
    });
    const out = interpretLedger(ledger({ answer }));
    // X5: the ledger survives; the entry does not.
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(0);
    const rejected = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.kind === "entries_rejected" && rejected.entries).toEqual([
      { index: 1, reason: expect.stringContaining('"evidence"') },
    ]);
  });

  it("a Minor that blocks costs THAT entry, and the rest of the ledger survives (X5 O4)", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern(), concern({ severity: "minor", blocking: true })),
      }),
    );
    expect(out.failure).toBeUndefined();
    // The valid concern is kept, with its id dense over what located.
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.id).toBe("claims-1");
    expect(out.result?.limits).toEqual([
      {
        kind: "entries_rejected",
        reviewer: "claims",
        entries: [
          { index: 2, reason: expect.stringContaining('only on a "major"') },
        ],
      },
    ]);
    expect(out.counts).toEqual({
      entries: 2,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 1,
    });
  });

  it("a bad dimension and a bad severity are rejections, not failures (X5 O4)", () => {
    const out = interpretLedger(
      ledger({
        allowedDimensions: ["claims"],
        answer: wire(
          concern(),
          concern({ dimension: "vibes" }),
          concern({ severity: "catastrophic" }),
        ),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
    const rejected = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    expect(
      rejected?.kind === "entries_rejected" &&
        rejected.entries.map((e) => e.index),
    ).toEqual([2, 3]);
  });

  it("an entry's index is its 1-based WIRE position, so a drop before it does not shift it", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ anchor: "nowhere in this manuscript" }),
          concern({ severity: "minor", blocking: true }),
        ),
      }),
    );
    const rejected = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    expect(
      rejected?.kind === "entries_rejected" && rejected.entries[0]?.index,
    ).toBe(2);
    expect(out.counts).toEqual({
      entries: 2,
      located: 0,
      relocated: 0,
      dropped: 1,
      rejected: 1,
    });
  });

  it("the identity entries === located + dropped + rejected holds over a mixed ledger (X5 O4)", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern(),
          concern({ anchor: "Each figure is reproducible." }),
          concern({ anchor: "nowhere in this manuscript" }),
          concern({ severity: "minor", blocking: true }),
          concern({ message: "   " }),
        ),
      }),
    );
    const c = out.counts;
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.entries).toBe(5);
    expect(c.located + c.dropped + c.rejected).toBe(c.entries);
    expect(c.relocated).toBeLessThanOrEqual(c.located);
    expect(c).toEqual({
      entries: 5,
      located: 2,
      relocated: 1,
      dropped: 1,
      rejected: 2,
    });
  });

  it("unparseable JSON is a shape failure", () => {
    const out = interpretLedger(ledger({ answer: "I could not review this." }));
    expect(out.result).toBeUndefined();
    expect(out.failure).toMatch(/JSON/);
  });

  it("exactly one of result / failure is ever set", () => {
    // The five answers are unchanged, and so is what this asserts. What X5
    // moved is which SIDE two of them land on: a blocking Info and an
    // unlocatable anchor are now results carrying a limit, not failures.
    for (const answer of [
      wire(concern()),
      '{"annotations": []}',
      wire(concern({ anchor: "absent" })),
      "not json at all",
      wire(concern({ severity: "info", blocking: false })),
    ]) {
      const out = interpretLedger(ledger({ answer }));
      expect(
        (out.result === undefined) !== (out.failure === undefined),
        answer,
      ).toBe(true);
    }
  });
});

describe("interpretLedger — evidence, and the shared rules (ADR 0060 §3)", () => {
  it("a located evidence quote becomes a span in its own file", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            evidence: {
              anchor: "Each figure is reproducible.",
              file: "sections/method.tex",
            },
          }),
        ),
      }),
    );
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "span",
      file: "sections/method.tex",
      line: 4,
    });
  });

  it("a bare evidence quote locates where the claim did", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ evidence: { anchor: "Results follow in Section 4." } }),
        ),
      }),
    );
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "span",
      file: "main.tex",
      line: 6,
    });
  });

  it("an unlocatable evidence quote drops the concern, counted as role: evidence", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ evidence: { anchor: "nowhere in the paper" } })),
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toEqual([]);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "claims",
        anchors: [
          {
            anchor: "nowhere in the paper",
            file: "main.tex",
            role: "evidence",
            reason: "not_found",
          },
        ],
      },
    ]);
  });

  it("blocking rides on a major, and ids stay dense over what located", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ anchor: "absent from the manuscript" }),
          concern({ blocking: true }),
        ),
      }),
    );
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.id).toBe("claims-1");
    expect(out.result?.annotations[0]?.blocking).toBe(true);
  });

  it("tolerates a fence and surrounding prose, exactly as the quick action does", () => {
    const out = interpretLedger(
      ledger({
        answer: `Here is my ledger.\n\n\`\`\`json\n${wire(concern())}\n\`\`\`\n\nI hope it helps.`,
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(1);
  });

  it("honours allowedDimensions, allowedSeverities and suggestEdits", () => {
    // X5: the constraints are unchanged and so are the sentences that name
    // them — what moved is where they land. In a LEDGER a violating entry is
    // rejected and recorded rather than failing the whole report, so the
    // interpreter's own words are read off `entries_rejected` instead of off
    // `failure`. The quick action still fails whole, and `review.test.ts`
    // asserts these same two strings there, unedited.
    const reasonFor = (
      over: Partial<LedgerInput>,
      wireOver: object,
    ): string => {
      const out = interpretLedger(
        ledger({ answer: wire(concern(wireOver)), ...over }),
      );
      expect(out.failure).toBeUndefined();
      const limit = out.result?.limits?.find(
        (l) => l.kind === "entries_rejected",
      );
      return limit?.kind === "entries_rejected"
        ? (limit.entries[0]?.reason ?? "")
        : "";
    };
    expect(
      reasonFor(
        { allowedDimensions: ["claims", "soundness"] },
        {
          dimension: "novelty",
        },
      ),
    ).toMatch(/claims/);
    expect(
      reasonFor(
        { allowedSeverities: ["minor", "major"] },
        { severity: "info" },
      ),
    ).toMatch(/minor.*major/);
    const stripped = interpretLedger(
      ledger({
        answer: wire(concern({ suggestion: "Add a baseline." })),
        suggestEdits: false,
      }),
    );
    expect(stripped.result?.annotations[0]?.suggestedEdit).toBeUndefined();
  });

  it("caps a flooding seat at 50 concerns", () => {
    const answer = JSON.stringify({
      annotations: Array.from({ length: 60 }, () => concern()),
    });
    const out = interpretLedger(ledger({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(50);
    expect(out.result?.annotations[49]?.id).toBe("claims-50");
  });

  it("the cap counts ENTRIES, before location", () => {
    // 60 entries, the first 20 unlocatable. Capping entries keeps the head of
    // 50 and yields 30 located; capping the LOCATED ones would yield 40. The
    // sibling case above cannot tell those apart, because every one of its
    // anchors locates — so the ordering the tier table claims is asserted here.
    const answer = JSON.stringify({
      annotations: [
        ...Array.from({ length: 20 }, (_, i) =>
          concern({ anchor: `absent ${i}` }),
        ),
        ...Array.from({ length: 40 }, () => concern()),
      ],
    });
    const out = interpretLedger(ledger({ answer }));
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations).toHaveLength(30);
    expect(
      (out.result?.limits?.[0] as { anchors: unknown[] }).anchors,
    ).toHaveLength(20);
  });
});

// ── The panel's two assemblers (ADR 0060 §§6–7) ─────────────────────────────
// Built over REAL ids: each seat's ledger runs through interpretLedger, so a
// synthesis test can never cite an id the harness would not have stamped.

function seatLedger(reviewer: string, anchor: string) {
  return interpretLedger(
    ledger({ reviewer, answer: wire(concern({ anchor })) }),
  );
}

const CLAIMS = seatLedger(
  "claims",
  "We report no baseline for the headline claim.",
);
const SOUNDNESS = seatLedger("soundness", "A fixed seed was used.");
const CLARITY = seatLedger("clarity", "Results follow in Section 4.");
const PANEL = [
  ...(CLAIMS.result?.annotations ?? []),
  ...(SOUNDNESS.result?.annotations ?? []),
  ...(CLARITY.result?.annotations ?? []),
];

describe("interpretSynthesis (ADR 0060 §6)", () => {
  it("resolves valid entries and keeps the model's notes", () => {
    const answer = JSON.stringify({
      consensus: [
        {
          ids: ["claims-1", "soundness-1"],
          note: "Both seats want a baseline.",
        },
      ],
      disagreements: [
        { ids: ["claims-1", "clarity-1"], note: "They differ on severity." },
      ],
    });
    const out = interpretSynthesis({ answer, annotations: PANEL });
    expect(out.failure).toBeUndefined();
    expect(out.synthesis).toEqual({
      consensus: [
        {
          ids: ["claims-1", "soundness-1"],
          note: "Both seats want a baseline.",
        },
      ],
      disagreements: [
        { ids: ["claims-1", "clarity-1"], note: "They differ on severity." },
      ],
    });
  });

  it("an id no ledger carries is a failure naming it", () => {
    const answer = JSON.stringify({
      consensus: [{ ids: ["claims-1", "ghost-9"], note: "n" }],
      disagreements: [],
    });
    const out = interpretSynthesis({ answer, annotations: PANEL });
    expect(out.synthesis).toBeUndefined();
    expect(out.failure).toMatch(/ghost-9/);
  });

  it("an entry with no ids is a failure", () => {
    const answer = JSON.stringify({
      consensus: [{ ids: [], note: "n" }],
      disagreements: [],
    });
    expect(interpretSynthesis({ answer, annotations: PANEL }).failure).toMatch(
      /"ids"/,
    );
  });

  it("an entry citing one reviewer only is a failure — that is not consensus", () => {
    const answer = JSON.stringify({
      consensus: [{ ids: ["claims-1"], note: "n" }],
      disagreements: [],
    });
    const out = interpretSynthesis({ answer, annotations: PANEL });
    expect(out.synthesis).toBeUndefined();
    expect(out.failure).toMatch(/two different reviewers/);
  });

  it("an empty note is a failure", () => {
    const answer = JSON.stringify({
      consensus: [{ ids: ["claims-1", "clarity-1"], note: "   " }],
      disagreements: [],
    });
    expect(interpretSynthesis({ answer, annotations: PANEL }).failure).toMatch(
      /"note"/,
    );
  });

  it("empty consensus and disagreements are valid — no quota", () => {
    const out = interpretSynthesis({
      answer: '{"consensus": [], "disagreements": []}',
      annotations: PANEL,
    });
    expect(out.failure).toBeUndefined();
    expect(out.synthesis).toEqual({ consensus: [], disagreements: [] });
  });

  it("tolerates a fence, and refuses a non-array side", () => {
    const body = JSON.stringify({
      consensus: [{ ids: ["claims-1", "soundness-1"], note: "n" }],
      disagreements: [],
    });
    expect(
      interpretSynthesis({
        answer: `\`\`\`json\n${body}\n\`\`\``,
        annotations: PANEL,
      }).failure,
    ).toBeUndefined();
    expect(
      interpretSynthesis({
        answer: '{"consensus": "none", "disagreements": []}',
        annotations: PANEL,
      }).failure,
    ).toMatch(/"consensus"/);
  });

  it("a synthesis carries no severity, anchor or message of its own", () => {
    const out = interpretSynthesis({
      answer: JSON.stringify({
        consensus: [
          {
            ids: ["claims-1", "soundness-1"],
            note: "n",
            severity: "major",
            anchor: "A fixed seed was used.",
          },
        ],
        disagreements: [],
      }),
      annotations: PANEL,
    });
    // The extra keys are ignored, exactly like an entry's `id` — the shape a
    // synthesis can express is what stops it restating a concern.
    expect(out.synthesis?.consensus[0]).toEqual({
      ids: ["claims-1", "soundness-1"],
      note: "n",
    });
  });
});

describe("assembleReview (ADR 0060 §7)", () => {
  it("concatenates in seat order, keeping each seat's prefixed ids", () => {
    const review = assembleReview({
      seats: [
        { reviewer: "claims", ledger: CLAIMS },
        { reviewer: "soundness", ledger: SOUNDNESS },
        { reviewer: "clarity", ledger: CLARITY },
      ],
    });
    expect(review.annotations.map((a) => a.id)).toEqual([
      "claims-1",
      "soundness-1",
      "clarity-1",
    ]);
    expect(review.limits).toBeUndefined();
    expect(review.synthesis).toBeUndefined();
  });

  it("carries each seat's anchors_dropped record", () => {
    const dropped = interpretLedger(
      ledger({
        reviewer: "positioning",
        answer: wire(concern({ anchor: "absent" })),
      }),
    );
    const review = assembleReview({
      seats: [
        { reviewer: "claims", ledger: CLAIMS },
        { reviewer: "positioning", ledger: dropped },
      ],
    });
    expect(review.annotations).toHaveLength(1);
    expect(review.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "positioning",
        anchors: [
          {
            anchor: "absent",
            file: "main.tex",
            role: "claim",
            reason: "not_found",
          },
        ],
      },
    ]);
  });

  it("a seat that never reported becomes seat_missing with its status", () => {
    for (const missing of ["failed", "interrupted"] as const) {
      const review = assembleReview({
        seats: [
          { reviewer: "claims", ledger: CLAIMS },
          { reviewer: "soundness", missing },
        ],
      });
      expect(review.limits).toEqual([
        { kind: "seat_missing", reviewer: "soundness", reason: missing },
      ]);
    }
  });

  it("a seat whose ledger did not parse becomes seat_missing unparsed, with the failure as detail", () => {
    const unparsed = interpretLedger(
      ledger({ reviewer: "soundness", answer: "I could not review this." }),
    );
    const review = assembleReview({
      seats: [
        { reviewer: "claims", ledger: CLAIMS },
        { reviewer: "soundness", ledger: unparsed },
      ],
    });
    expect(review.annotations).toHaveLength(1);
    expect(review.limits?.[0]).toMatchObject({
      kind: "seat_missing",
      reviewer: "soundness",
      reason: "unparsed",
    });
    expect((review.limits?.[0] as { detail?: string }).detail).toMatch(/JSON/);
  });

  it("attaches the synthesis as given", () => {
    const synthesis = {
      consensus: [{ ids: ["claims-1", "soundness-1"], note: "n" }],
      disagreements: [],
    };
    const review = assembleReview({
      seats: [
        { reviewer: "claims", ledger: CLAIMS },
        { reviewer: "soundness", ledger: SOUNDNESS },
      ],
      synthesis,
    });
    expect(review.synthesis).toEqual(synthesis);
  });

  it("THROWS on a duplicate seat name — a driver bug, not a model error", () => {
    const seats: SeatOutcome[] = [
      { reviewer: "claims", ledger: CLAIMS },
      { reviewer: "claims", ledger: CLAIMS },
    ];
    expect(() => assembleReview({ seats })).toThrow(/duplicate reviewer/);
  });
});

describe("interpretSynthesis — malformed input never crashes", () => {
  it("refuses a non-object entry, a non-string id, and a top-level array", () => {
    const cases: Array<[string, RegExp]> = [
      ['{"consensus": ["just a string"], "disagreements": []}', /entry/],
      [
        '{"consensus": [{"ids": ["claims-1", 7], "note": "n"}], "disagreements": []}',
        /"ids"/,
      ],
      ["[1, 2, 3]", /JSON object/],
      ['{"disagreements": []}', /"consensus"/],
    ];
    for (const [answer, pattern] of cases) {
      const out = interpretSynthesis({ answer, annotations: PANEL });
      expect(out.synthesis, answer).toBeUndefined();
      expect(out.failure, answer).toMatch(pattern);
    }
  });
});

describe("assembleReview — the seat name and the stamped reviewer must agree", () => {
  it("THROWS when a driver passed interpretLedger a different reviewer", () => {
    // The duplicate-name guard keys on `seat.reviewer`, but the ids are stamped
    // from whatever interpretLedger was given. A driver that let the two
    // disagree would slip past that guard and still collide.
    expect(() =>
      assembleReview({
        seats: [{ reviewer: "positioning", ledger: CLAIMS }],
      }),
    ).toThrow(/must be the same string/);
  });

  it("an empty ledger contributes nothing and throws nothing", () => {
    const empty = interpretLedger(
      ledger({ reviewer: "clarity", answer: '{"annotations": []}' }),
    );
    const review = assembleReview({
      seats: [
        { reviewer: "claims", ledger: CLAIMS },
        { reviewer: "clarity", ledger: empty },
      ],
    });
    expect(review.annotations.map((a) => a.id)).toEqual(["claims-1"]);
    expect(review.limits).toBeUndefined();
  });
});

describe("describeLedgerProblems — the one re-ask's feedback (X5 O5, ADR 0074 §5)", () => {
  it("is undefined for a result with nothing to say", () => {
    const out = interpretLedger(ledger({ answer: wire(concern()) }));
    expect(out.result).toBeDefined();
    if (out.result === undefined) return;
    expect(describeLedgerProblems(out.result, "claims")).toBeUndefined();
  });

  it("names every rejected entry and every unlocated quote, and asks for corrections only", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern(),
          concern({ severity: "minor", blocking: true }),
          concern({
            anchor: "No sentence of this manuscript reads like this.",
          }),
        ),
      }),
    );
    expect(out.result).toBeDefined();
    if (out.result === undefined) return;
    const text = describeLedgerProblems(out.result, "claims");
    expect(text).toBeDefined();
    if (text === undefined) return;

    // The rejected entry, by its wire position and the interpreter's own words.
    expect(text).toContain("entry 2:");
    expect(text).toContain('only on a "major"');
    // The quote that is nowhere — said as "not in that file OR anywhere else",
    // because that is what the manuscript-wide search now means (§1).
    expect(text).toContain(
      '"No sentence of this manuscript reads like this." was not found in `main.tex` or in any other file of the manuscript',
    );
    // Corrections only, and once — the two load-bearing instructions.
    expect(text).toContain("ONLY your corrections");
    expect(text).toContain("the only correction round");
    expect(text).toContain("do not send it again");
  });

  it("says which quotes are ambiguous, and where", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({
            anchor: "A fixed seed was used.",
            file: "sections/method.tex",
          }),
        ),
      }),
    );
    if (out.result === undefined) return;
    const text = describeLedgerProblems(out.result, "claims") ?? "";
    expect(text).toContain("appears more than once in `sections/method.tex`");
  });

  it("says when a quote is ambiguous across the manuscript rather than in one file", () => {
    const out = interpretLedger(
      ledger({
        files: new Map([
          ["main.tex", MAIN],
          ["sections/a.tex", sectionHolding("A", SHARED)],
          ["old/a.tex", sectionHolding("Old", SHARED)],
        ]),
        answer: wire(concern({ anchor: SHARED, file: "a.tex" })),
      }),
    );
    if (out.result === undefined) return;
    const text = describeLedgerProblems(out.result, "claims") ?? "";
    expect(text).toContain("more than one other file of the manuscript");
  });

  it("marks an EVIDENCE quote as one, so the model corrects the right field", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ evidence: { anchor: "not a sentence of this paper" } }),
        ),
      }),
    );
    if (out.result === undefined) return;
    const text = describeLedgerProblems(out.result, "claims") ?? "";
    expect(text).toContain("the evidence quote");
  });

  it("cuts a long quote at 80 characters so the feedback stays readable", () => {
    const out = interpretLedger(
      ledger({ answer: wire(concern({ anchor: "x".repeat(200) })) }),
    );
    if (out.result === undefined) return;
    const text = describeLedgerProblems(out.result, "claims") ?? "";
    expect(text).toContain(`"${"x".repeat(80)}…"`);
    expect(text).not.toContain("x".repeat(81));
  });
});

describe("mergeLedgerCorrection — what located is frozen (ADR 0074 §5)", () => {
  /** A parsed first pass, narrowed the way the driver narrows it. */
  function parsed(answer: string) {
    const out = interpretLedger(ledger({ answer }));
    if (out.result === undefined || out.counts === undefined) {
      throw new Error("fixture: expected a parsed ledger");
    }
    return {
      result: out.result,
      counts: out.counts,
      relocatedIds: out.relocatedIds ?? new Set<string>(),
    };
  }

  const FIRST = wire(
    concern(),
    concern({ anchor: "No sentence of this manuscript reads like this." }),
  );

  it("keeps the first pass's annotations and appends the correction with a dense id", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      interpretLedger(
        ledger({
          answer: wire(concern({ anchor: "Results follow in Section 4." })),
        }),
      ),
    );
    expect(merged.result.annotations.map((a) => a.id)).toEqual([
      "claims-1",
      "claims-2",
    ]);
    // The first pass's drop is gone — it was answered. Asserted on the KEY,
    // not the value: `toEqual` ignores an undefined-valued key, so a merged
    // result carrying `limits: undefined` would pass `toBeUndefined()` while
    // breaking `ReviewResult`'s "present only when non-empty" rule.
    expect(merged.result.limits).toBeUndefined();
    expect(Object.hasOwn(merged.result, "limits")).toBe(false);
    expect(JSON.parse(JSON.stringify(merged.result))).not.toHaveProperty(
      "limits",
    );
    expect(merged.counts).toEqual({
      entries: 2,
      located: 2,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
  });

  it("skips a re-sent entry, so a model that resends its whole ledger is harmless", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      interpretLedger(
        ledger({
          answer: wire(
            // The one that already located, sent again…
            concern(),
            // …beside the genuine correction.
            concern({ anchor: "Results follow in Section 4." }),
          ),
        }),
      ),
    );
    expect(merged.result.annotations.map((a) => a.id)).toEqual([
      "claims-1",
      "claims-2",
    ]);
    expect(merged.result.annotations).toHaveLength(2);
  });

  it("returns the first pass unchanged when the correction cannot be read", () => {
    const first = parsed(FIRST);
    const merged = mergeLedgerCorrection(
      first,
      interpretLedger(
        ledger({ answer: "Sorry — here is some prose instead." }),
      ),
    );
    expect(merged.result).toEqual(first.result);
    expect(merged.counts).toEqual(first.counts);
    // The first pass's drop is still on the record: nothing answered it.
    expect(merged.result.limits?.[0]?.kind).toBe("anchors_dropped");
  });

  it("takes its limits from the SECOND pass — the first pass's were answered", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      interpretLedger(
        ledger({ answer: wire(concern({ anchor: "still nowhere at all" })) }),
      ),
    );
    expect(merged.result.annotations).toHaveLength(1);
    const dropped = merged.result.limits?.find(
      (l) => l.kind === "anchors_dropped",
    );
    expect(
      dropped?.kind === "anchors_dropped" && dropped.anchors[0]?.anchor,
    ).toBe("still nowhere at all");
    expect(merged.counts).toEqual({
      entries: 2,
      located: 1,
      relocated: 0,
      dropped: 1,
      rejected: 0,
    });
  });

  it("counts a relocated correction, and keeps the identity", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      interpretLedger(
        ledger({
          answer: wire(concern({ anchor: "Each figure is reproducible." })),
        }),
      ),
    );
    expect(merged.counts.relocated).toBe(1);
    expect(
      merged.counts.located + merged.counts.dropped + merged.counts.rejected,
    ).toBe(merged.counts.entries);
  });

  it("a WITHDRAWN entry DROPS OUT of `entries`, which is why D14 also prints the conservative rate", () => {
    // The second answer omits the unlocatable entry rather than fixing it —
    // its author withdrew it when told the quote could not be found, and a
    // withdrawal is not a recorded drop. The final `entries` therefore falls
    // from 2 to 1, so `located / entries` RISES without a single correction
    // having been made. That is exactly why the instrument reports final
    // `located` over FIRST-PASS `entries` beside it (ADR 0074 §10).
    const merged = mergeLedgerCorrection(parsed(FIRST), {
      result: { annotations: [] },
      counts: {
        entries: 0,
        located: 0,
        relocated: 0,
        dropped: 0,
        rejected: 0,
      },
      relocatedIds: new Set(),
    });
    expect(merged.result.annotations).toHaveLength(1);
    expect(merged.counts).toEqual({
      entries: 1,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
  });
});

// ── V2 (ADR 0078): a concern may rest on a paper ─────────────────────────────

/**
 * The results a seat's own searches returned, as the harness recorded them.
 * Deliberately varied: one ordinary paper with every optional field, one with
 * a title only, one CJK title (whose R4 key is empty), and a duplicate title
 * later in the list so *the first recorded match wins* is testable.
 */
const ADAM: LiteratureResult = {
  title: "Adam: A Method for Stochastic Optimization",
  authors: ["Diederik P. Kingma", "Jimmy Ba"],
  year: "2015",
  venue: "ICLR",
  doi: "10.48550/arXiv.1412.6980",
  url: "https://arxiv.org/abs/1412.6980",
  source: "arxiv",
};
const SPARSE: LiteratureResult = {
  title: "On the Convergence of Nothing in Particular",
  authors: [],
  source: "crossref",
};
const CJK: LiteratureResult = {
  title: "基于注意力的神经机器翻译",
  authors: ["张三"],
  source: "dblp",
};
/** Same title as ADAM, a different record — the second one recorded. */
const ADAM_AGAIN: LiteratureResult = {
  title: "ADAM - a method for stochastic optimization",
  authors: ["someone else"],
  source: "dblp",
};
const PAPERS = [ADAM, SPARSE, CJK, ADAM_AGAIN];

/** A wire concern citing a paper by title. */
const citing = (title: string, over: Record<string, unknown> = {}) =>
  concern({ evidence: { paper: { title } }, ...over });

describe("setAsideConcerns — a settled ledger, some of it set aside (ADR 0083 §2)", () => {
  /** A parsed ledger, narrowed the way the driver narrows it. */
  function parsed(answer: string, over: Partial<LedgerInput> = {}) {
    const out = interpretLedger(ledger({ answer, ...over }));
    if (out.result === undefined || out.counts === undefined) {
      throw new Error("fixture: expected a parsed ledger");
    }
    return {
      result: out.result,
      counts: out.counts,
      relocatedIds: out.relocatedIds ?? new Set<string>(),
    };
  }
  const ARGUMENT = (a: { dimension: string }) => a.dimension === "soundness";

  it("keeps the rest in order with dense ids, and records the count and what each said", () => {
    const settled = parsed(
      wire(
        concern({ dimension: "soundness", blocking: true }),
        // Relocated: unique to sections/method.tex, searched from main.tex.
        concern({
          anchor: "Each figure is reproducible.",
          dimension: "claims",
        }),
        concern({
          anchor: "Results follow in Section 4.",
          dimension: "soundness",
          message: "Section 4 is promised and never delivered.",
        }),
        concern({ anchor: "A fixed seed was used.", dimension: "clarity" }),
      ),
    );
    expect(settled.relocatedIds).toEqual(new Set(["claims-2"]));

    const out = setAsideConcerns(settled, ARGUMENT);
    expect(
      out.result.annotations.map((a) => [a.id, a.dimension, a.span.line]),
    ).toEqual([
      ["claims-1", "claims", 4],
      ["claims-2", "clarity", 5],
    ]);
    // The relocated set follows the concern to its new id.
    expect(out.relocatedIds).toEqual(new Set(["claims-1"]));
    expect(out.counts).toEqual({
      entries: 4,
      located: 2,
      relocated: 1,
      dropped: 0,
      rejected: 0,
      setAside: 2,
    });
    const { entries, located, dropped, rejected, setAside } = out.counts;
    expect(located + dropped + rejected + (setAside ?? 0)).toBe(entries);
    expect(out.result.limits).toEqual([
      {
        kind: "concerns_set_aside",
        reviewer: "claims",
        // ADR 0086: what each said, display-only — no id, no evidence but a
        // page, and `blocking` only where the seat set it.
        entries: [
          {
            dimension: "soundness",
            concern: {
              severity: "major",
              blocking: true,
              message: "The headline claim is asserted without a comparison.",
              span: { file: "main.tex", line: 4 },
            },
          },
          {
            dimension: "soundness",
            concern: {
              severity: "major",
              message: "Section 4 is promised and never delivered.",
              span: { file: "main.tex", line: 6 },
            },
          },
        ],
      },
    ]);
  });

  it("appends to the limits the ledger already carries", () => {
    const settled = parsed(
      wire(
        concern({ dimension: "soundness" }),
        concern({ anchor: "No sentence of this manuscript reads like this." }),
      ),
    );
    const out = setAsideConcerns(settled, ARGUMENT);
    expect(out.result.limits?.map((l) => l.kind)).toEqual([
      "anchors_dropped",
      "concerns_set_aside",
    ]);
    expect(out.counts).toMatchObject({ entries: 2, located: 0, dropped: 1 });
    expect(out.counts.setAside).toBe(1);
  });

  it("returns the ledger itself when nothing matches, so nothing changes shape", () => {
    const settled = parsed(wire(concern(), concern({ dimension: "clarity" })));
    const out = setAsideConcerns(settled, ARGUMENT);
    expect(out).toBe(settled);
    expect(Object.hasOwn(out.counts, "setAside")).toBe(false);
    expect(Object.hasOwn(out.result, "limits")).toBe(false);
  });
});

describe("interpretLedger — a paper as evidence (V2, ADR 0078 §3, O1–O3)", () => {
  it("records the RECORDED result's fields, not the model's typing of the title", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(citing("adam: a method for STOCHASTIC optimization")),
        papers: PAPERS,
      }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "paper",
      // The title is ADAM's, spelled as arXiv spelled it — not as the model
      // typed it. Everything else is the recorded result's too.
      title: "Adam: A Method for Stochastic Optimization",
      authors: ["Diederik P. Kingma", "Jimmy Ba"],
      year: "2015",
      venue: "ICLR",
      doi: "10.48550/arXiv.1412.6980",
      url: "https://arxiv.org/abs/1412.6980",
      source: "arxiv",
    });
    // An absent optional field stays absent rather than becoming empty.
    expect(out.result?.annotations[0]?.evidence).not.toHaveProperty("abstract");
  });

  it("keeps a result that carried only a title", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(citing("On the Convergence of Nothing in Particular")),
        papers: PAPERS,
      }),
    );
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "paper",
      title: "On the Convergence of Nothing in Particular",
      authors: [],
      source: "crossref",
    });
  });

  it("matches a CJK title, which R4's key alone could not", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(citing("基于注意力的神经机器翻译")),
        papers: PAPERS,
      }),
    );
    expect(out.result?.annotations[0]?.evidence).toMatchObject({
      kind: "paper",
      title: "基于注意力的神经机器翻译",
      source: "dblp",
    });
  });

  it("takes the FIRST recorded match when two results share a title", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(citing("Adam: A Method for Stochastic Optimization")),
        papers: PAPERS,
      }),
    );
    // ADAM is at index 0 and ADAM_AGAIN at index 3: the order the searches
    // returned them in is the order the harness trusts.
    expect(out.result?.annotations[0]?.evidence).toMatchObject({
      source: "arxiv",
    });
  });

  it("drops the WHOLE annotation when no search returned the paper", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(citing("A Paper That Nobody Ever Wrote")),
        papers: PAPERS,
      }),
    );
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "claims",
        anchors: [
          {
            // The title AS THE MODEL WROTE IT — that is what it has to fix.
            anchor: "A Paper That Nobody Ever Wrote",
            role: "evidence",
            reason: "not_in_results",
          },
        ],
      },
    ]);
    // No `file`: nothing was searched for in the manuscript at all.
    const limit = out.result?.limits?.[0];
    expect(
      limit?.kind === "anchors_dropped" ? limit.anchors[0] : undefined,
    ).not.toHaveProperty("file");
    // The identity still holds, and the drop consumed no id.
    expect(out.counts).toEqual({
      entries: 1,
      located: 0,
      relocated: 0,
      dropped: 1,
      rejected: 0,
    });
  });

  it("drops every paper when `papers` is absent — deny by default", () => {
    // A driver that forgot to pass the seat's results must not be able to
    // record a citation it never checked.
    const out = interpretLedger(
      ledger({
        answer: wire(citing("Adam: A Method for Stochastic Optimization")),
      }),
    );
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.counts?.dropped).toBe(1);
  });

  it("refuses a paper AND an anchor together, and a paper with no title", () => {
    const both = interpretLedger(
      ledger({
        answer: wire(
          concern({
            evidence: {
              anchor: "Results follow in Section 4.",
              paper: { title: "Adam: A Method for Stochastic Optimization" },
            },
          }),
        ),
        papers: PAPERS,
      }),
    );
    const rejected = both.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    expect(
      rejected?.kind === "entries_rejected" && rejected.entries[0],
    ).toEqual({
      index: 1,
      reason:
        '"evidence" is ONE thing: a manuscript passage {"anchor": …}, a paper {"paper": {"title": …}}, or the literal "missing" — not two of them',
    });
    for (const bad of [{}, { title: "" }, { title: 42 }, "Adam"]) {
      const out = interpretLedger(
        ledger({
          answer: wire(concern({ evidence: { paper: bad } })),
          papers: PAPERS,
        }),
      );
      const limit = out.result?.limits?.find(
        (l) => l.kind === "entries_rejected",
      );
      expect(
        limit?.kind === "entries_rejected" && limit.entries[0]?.reason,
        JSON.stringify(bad),
      ).toBe(
        '"evidence".paper needs a non-empty "title", copied exactly as one of your own searches returned it',
      );
    }
  });
});

describe("interpretLedger — an originality concern needs a paper (V2, D4, O5)", () => {
  it("rejects one without a paper, and says what to do instead", () => {
    for (const dimension of ["originality", "ORIGINALITY", "Originality"]) {
      const out = interpretLedger(
        ledger({
          answer: wire(concern({ dimension, evidence: "missing" })),
          papers: PAPERS,
          allowedDimensions: ["claims", "originality", "positioning"],
        }),
      );
      expect(out.result?.annotations, dimension).toHaveLength(0);
      const limit = out.result?.limits?.find(
        (l) => l.kind === "entries_rejected",
      );
      expect(
        limit?.kind === "entries_rejected" && limit.entries[0]?.reason,
        dimension,
      ).toBe(
        'an "originality" concern must cite, as its evidence, a paper one of your own searches returned — {"paper": {"title": …}}. If you suspect the work exists but no search returned it, file the concern under "positioning" with the manuscript passage that makes the claim',
      );
    }
  });

  it("accepts one that cites a paper", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          citing("Adam: A Method for Stochastic Optimization", {
            dimension: "originality",
          }),
        ),
        papers: PAPERS,
        allowedDimensions: ["originality"],
      }),
    );
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.limits).toBeUndefined();
  });

  it("lets every OTHER dimension carry any of the three kinds", () => {
    for (const evidence of [
      "missing",
      { anchor: "Results follow in Section 4." },
      { paper: { title: "Adam: A Method for Stochastic Optimization" } },
    ]) {
      const out = interpretLedger(
        ledger({
          answer: wire(concern({ dimension: "positioning", evidence })),
          papers: PAPERS,
          allowedDimensions: ["positioning"],
        }),
      );
      expect(out.result?.annotations, JSON.stringify(evidence)).toHaveLength(1);
    }
  });
});

/**
 * V2's gate review, issue 4: the feedback a ledger seat gets must not teach
 * the omission that gets its next answer thrown away.
 *
 * The 中文 run lost a whole paid reviewer here. `reviewer_a` answered, the
 * answer did not parse, and the only sentence it got back was the one shared
 * with the quick action — whose example carries neither `file` nor
 * `evidence`, both of which a ledger requires. The second answer had no
 * `evidence` on any of its nine entries, all nine were rejected, and there is
 * no third round: `entries: 9, located: 0, rejected: 9`, and the panel ran
 * two-handed.
 *
 * These are unit assertions on the sentences themselves, because the sentence
 * IS the mechanism — nothing downstream can recover a seat that copied a bad
 * example.
 */
describe("a ledger's retry feedback shows what a LEDGER requires (V2 gate review)", () => {
  const failureFor = (answer: string): string | undefined =>
    interpretLedger(ledger({ answer, papers: PAPERS })).failure;

  it("the parse-failure example carries `file` and `evidence`", () => {
    const failure = failureFor("here are my concerns, in prose");
    expect(failure).toBeDefined();
    expect(failure).toContain('"file"');
    expect(failure).toContain('"evidence"');
    // And it still says the thing the old sentence said.
    expect(failure).toContain("pure JSON");
    expect(failure).toContain("no prose");
  });

  it("the parse-failure example offers all THREE evidence forms", () => {
    // A ledger always has a paper resolver, so all three are always open to
    // it — the same reason the interpreter's other messages name all three.
    const failure = failureFor("{{ not json");
    expect(failure).toContain('{"anchor"');
    expect(failure).toContain('{"paper"');
    expect(failure).toContain('"missing"');
  });

  it("the QUICK ACTION's sentence is unchanged, byte for byte", () => {
    // ADR 0074's measured located-rates were measured against this wording.
    // Widening it for the panel must not move the quick action.
    const out = interpretAnnotations({
      answer: "not json at all",
      unitText: MAIN,
      unitStartOffset: 0,
      fileContent: MAIN,
      file: "main.tex",
      reviewer: "writing",
      suggestEdits: false,
    });
    expect(out.failure).toBe(
      'the answer must be pure JSON like {"annotations": [{"dimension": "...", "severity": "...", "anchor": "...", "message": "..."}]} — no prose, no commentary',
    );
  });

  it("an ABSENT evidence is corrected toward a paper too, in paper mode", () => {
    // The second half of the same defect. This message still offered only
    // *passage or "missing"* — so an `originality` seat corrected by it is
    // steered at `"missing"`, which the paper-required check then rejects.
    // Two rounds, both spent telling the seat to do something forbidden.
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ dimension: "originality", evidence: undefined }),
        ),
        papers: PAPERS,
        allowedDimensions: ["originality"],
      }),
    );
    const limit = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    const reason =
      limit?.kind === "entries_rejected" ? limit.entries[0]?.reason : undefined;
    expect(reason).toContain('every concern needs "evidence"');
    expect(reason).toContain('{"paper"');
    expect(reason).toContain('"missing"');
  });

  it("names the paper form even when the seat searched NOTHING", () => {
    // The reachable edge of the same message. `interpretLedger` passes a
    // resolver unconditionally, so paper mode is on even with `papers` absent
    // — which is the case of a seat whose searches all failed. The sentence
    // it gets still offers the paper form, exactly as the neighbouring
    // non-object message has since V2: a seat is told what evidence CAN be,
    // and a title it cannot support then drops as `not_in_results`, which is
    // its own, separate and better-aimed feedback.
    const out = interpretLedger(
      ledger({ answer: wire(concern({ evidence: undefined })) }),
    );
    const limit = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    const reason =
      limit?.kind === "entries_rejected" ? limit.entries[0]?.reason : undefined;
    expect(reason).toContain('{"paper"');
  });
});

describe("the re-ask names an unreturned paper (V2, D3, O4)", () => {
  const problemsFor = (answer: string, papers = PAPERS) => {
    const out = interpretLedger(ledger({ answer, papers }));
    return describeLedgerProblems(out.result as never, "claims");
  };

  it("gives the paper its own sentence, and never says `undefined`", () => {
    const problems = problemsFor(
      wire(citing("A Paper That Nobody Ever Wrote")),
    );
    expect(problems).toContain(
      '- the paper "A Paper That Nobody Ever Wrote" is not among the results your own literature searches returned.',
    );
    expect(problems).not.toContain("undefined");
    // And the extra instruction, present because such a drop exists.
    expect(problems).toContain(
      "For a paper, cite it only by a title exactly as one of your searches showed it; you may search again before you reply, and if no search returns it, file the concern without it.",
    );
  });

  it("is byte-identical to before when no paper dropped", () => {
    // The whole point: a ledger that never cited a paper must get exactly the
    // feedback X5 measured its located rates against.
    const problems = problemsFor(
      wire(
        concern({ evidence: { anchor: "not anywhere in this manuscript" } }),
      ),
    );
    expect(problems).toBe(
      [
        "Some entries of your ledger could not be recorded. Each is listed with its reason.",
        "",
        '- the evidence quote "not anywhere in this manuscript" was not found in `main.tex` or in any other file of the manuscript.',
        "",
        "Reply once with one JSON ledger that holds ONLY your corrections to the entries listed above, each one complete. For a quote, open the file again and copy the passage exactly as it appears, from a single line — never describe it and never retype it from memory — and name the `file` you copied it from. Leave out any entry you withdraw. Every entry not listed above is already recorded: do not send it again. This is the only correction round.",
      ].join("\n"),
    );
  });
});

/**
 * V4 (ADR 0081 §4): a page of the compiled PDF is evidence — from a seat that
 * viewed pages, and only for a page it viewed. `presentation` requires one.
 */
describe("interpretLedger — a page as evidence (V4, ADR 0081 §4, O2)", () => {
  const VIEWED: ReadonlySet<number> = new Set([1, 2, 3]);
  const onPage = (page: unknown, over: Record<string, unknown> = {}) =>
    concern({ evidence: { page }, ...over });
  const rejectedReason = (out: ReturnType<typeof interpretLedger>) => {
    const limit = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    return limit?.kind === "entries_rejected"
      ? (limit.entries[0]?.reason ?? "")
      : "";
  };

  it("accepts a page the seat viewed, and stores only the number", () => {
    const out = interpretLedger(
      ledger({ answer: wire(onPage(2)), viewedPages: VIEWED }),
    );
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.annotations[0]?.evidence).toEqual({
      kind: "page",
      page: 2,
    });
    expect(out.result?.limits).toBeUndefined();
  });

  it("drops the WHOLE annotation for a page it did not view, and consumes no id", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          onPage(7),
          onPage(1, { anchor: "Results follow in Section 4." }),
        ),
        viewedPages: VIEWED,
      }),
    );
    expect(out.result?.annotations.map((a) => a.id)).toEqual(["claims-1"]);
    expect(out.result?.annotations[0]?.span.line).toBe(6);
    expect(out.result?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "claims",
        anchors: [
          { anchor: "page 7", role: "evidence", reason: "page_not_viewed" },
        ],
      },
    ]);
    expect(out.counts).toEqual({
      entries: 2,
      located: 1,
      relocated: 0,
      dropped: 1,
      rejected: 0,
    });
  });

  it("an EMPTY viewed set accepts no page at all", () => {
    const out = interpretLedger(
      ledger({ answer: wire(onPage(1)), viewedPages: new Set() }),
    );
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.counts?.dropped).toBe(1);
  });

  it("rejects a page that is not a positive whole number", () => {
    for (const bad of [0, -1, 2.5, "2", null]) {
      const out = interpretLedger(
        ledger({ answer: wire(onPage(bad)), viewedPages: VIEWED }),
      );
      expect(rejectedReason(out), JSON.stringify(bad)).toBe(
        '"evidence".page must be a positive whole number — a page of the compiled PDF you viewed',
      );
    }
  });

  it("refuses a page together with an anchor or a paper — evidence is ONE thing, of four", () => {
    for (const evidence of [
      { page: 1, anchor: "Results follow in Section 4." },
      {
        page: 1,
        paper: { title: "Adam: A Method for Stochastic Optimization" },
      },
    ]) {
      const out = interpretLedger(
        ledger({
          answer: wire(concern({ evidence })),
          viewedPages: VIEWED,
          papers: PAPERS,
        }),
      );
      expect(rejectedReason(out)).toBe(
        '"evidence" is ONE thing: a manuscript passage {"anchor": …}, a page you viewed {"page": N}, a paper {"paper": {"title": …}}, or the literal "missing" — not two of them',
      );
    }
  });

  it("a seat that cannot cite pages gets a violation for a page, never the page wording", () => {
    // Deny-by-default (ADR 0078 §3's rule for `papers`): no viewed set, no
    // page — whatever the model writes.
    const out = interpretLedger(ledger({ answer: wire(onPage(1)) }));
    expect(out.result?.annotations).toHaveLength(0);
    expect(out.counts?.rejected).toBe(1);
    expect(rejectedReason(out)).not.toContain('"page"');
  });

  it("names FOUR forms to a seat that may cite pages, and three to one that may not", () => {
    const reasonFor = (
      evidence: unknown,
      viewedPages?: ReadonlySet<number>,
    ): string =>
      rejectedReason(
        interpretLedger(
          ledger({
            answer: wire(concern({ evidence })),
            ...(viewedPages ? { viewedPages } : {}),
          }),
        ),
      );
    expect(reasonFor(undefined, VIEWED)).toContain('{"page": 3}');
    expect(reasonFor(undefined)).not.toContain('"page"');
    expect(reasonFor(42, VIEWED)).toContain('{"page": 3}');
    expect(reasonFor(42)).toBe(
      '"evidence" must be the literal "missing", an object like {"anchor": "verbatim passage"}, or a paper like {"paper": {"title": "exact title from your search"}}',
    );

    const notJson = (viewedPages?: ReadonlySet<number>) =>
      interpretLedger(
        ledger({
          answer: "prose, not json",
          ...(viewedPages ? { viewedPages } : {}),
        }),
      ).failure ?? "";
    expect(notJson(VIEWED)).toContain("ONE of four things");
    expect(notJson(VIEWED)).toContain('{"page": N}');
    expect(notJson()).toContain("ONE of three things");
    expect(notJson()).not.toContain('"page"');
  });
});

describe("interpretLedger — a presentation concern needs a page (V4, ADR 0081 §4, O2)", () => {
  const VIEWED: ReadonlySet<number> = new Set([1]);
  const reasonOf = (out: ReturnType<typeof interpretLedger>) => {
    const limit = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    return limit?.kind === "entries_rejected"
      ? limit.entries[0]?.reason
      : undefined;
  };

  it("rejects one without a page, and says what to do instead", () => {
    for (const evidence of [
      "missing",
      { anchor: "Results follow in Section 4." },
    ]) {
      const out = interpretLedger(
        ledger({
          answer: wire(concern({ dimension: "presentation", evidence })),
          viewedPages: VIEWED,
          allowedDimensions: ["presentation", "clarity"],
        }),
      );
      expect(out.result?.annotations).toHaveLength(0);
      expect(reasonOf(out)).toBe(
        'a "presentation" concern must carry, as its evidence, a page of the compiled PDF you viewed — {"page": N}. If what you see is in the source rather than on the rendered page, file the concern under "clarity" with the passage',
      );
    }
  });

  it("rejects one from a seat that cannot cite pages at all", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ dimension: "Presentation" })),
        allowedDimensions: ["presentation"],
      }),
    );
    expect(out.result?.annotations).toHaveLength(0);
    expect(reasonOf(out)).toContain('a "presentation" concern must carry');
  });

  it("accepts one that cites a page it viewed", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(
          concern({ dimension: "presentation", evidence: { page: 1 } }),
        ),
        viewedPages: VIEWED,
        allowedDimensions: ["presentation"],
      }),
    );
    expect(out.result?.annotations[0]).toMatchObject({
      dimension: "presentation",
      evidence: { kind: "page", page: 1 },
    });
  });

  it("lets any OTHER dimension cite a page", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ dimension: "claims", evidence: { page: 1 } })),
        viewedPages: VIEWED,
      }),
    );
    expect(out.result?.annotations).toHaveLength(1);
  });
});

describe("the re-ask names a page nobody viewed (V4, ADR 0081 §3, O2)", () => {
  it("says which page was cited and which were viewed", () => {
    const viewed = new Set([1, 2, 3, 5]);
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ evidence: { page: 7 } })),
        viewedPages: viewed,
      }),
    );
    const problems = describeLedgerProblems(
      out.result as never,
      "claims",
      viewed,
    );
    expect(problems).toContain(
      "- you cited page 7 as evidence but viewed pages 1–3, 5; view it, or cite a page you viewed.",
    );
    expect(problems).not.toContain("undefined");
  });

  it("says so when no page was viewed at all", () => {
    const out = interpretLedger(
      ledger({
        answer: wire(concern({ evidence: { page: 2 } })),
        viewedPages: new Set(),
      }),
    );
    expect(
      describeLedgerProblems(out.result as never, "claims", new Set()),
    ).toContain(
      "- you cited page 2 as evidence but viewed no page; view it, or cite a page you viewed.",
    );
  });
});

describe("the quick action never accepts a page (V4, stage-gate claim 9)", () => {
  it("is a failure, exactly as any evidence object without an anchor was", () => {
    const out = interpretAnnotations({
      answer: JSON.stringify({
        annotations: [
          {
            dimension: "clarity",
            severity: "minor",
            anchor: "Results follow in Section 4.",
            message: "m",
            evidence: { page: 1 },
          },
        ],
      }),
      unitText: MAIN,
      unitStartOffset: 0,
      fileContent: MAIN,
      file: "main.tex",
      reviewer: "writing",
      suggestEdits: false,
    });
    expect(out.result).toBeUndefined();
    expect(out.failure).toBe(
      '"evidence" needs a non-empty "anchor" copied VERBATIM from the manuscript (or the literal "missing")',
    );
  });
});

// ── V5 (ADR 0087): strengths, impressions, declarations ─────────────────────

/** The seven dimensions a text reviewer's brief lists (V4 D7): the panel's
 *  eight without `presentation`. */
const SEVEN = [
  "soundness",
  "claims",
  "clarity",
  "language",
  "positioning",
  "originality",
  "significance",
];

/** One wire strength — located like a concern, with no severity. */
function strength(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: "clarity",
    anchor: "The method is described below.",
    message: "The method is laid out before it is used.",
    ...over,
  };
}

/** A whole V5 reply: concerns, strengths, and the two scalar blocks. */
function v5wire(parts: {
  annotations?: Array<Record<string, unknown>>;
  strengths?: unknown;
  impressions?: unknown;
  not_assessed?: unknown;
}): string {
  return JSON.stringify({ annotations: [], ...parts });
}

const lostOf = (out: ReturnType<typeof interpretLedger>) => {
  const limit = out.result?.limits?.find((l) => l.kind === "strengths_lost");
  return limit?.kind === "strengths_lost" ? limit : undefined;
};

describe("interpretLedger — a strength is located like a concern (V5, ADR 0087 §1, O2)", () => {
  it("locates it, stamps its own id namespace, and records no severity, blocking or suggestion", () => {
    const out = interpretLedger(
      ledger({
        allowedDimensions: SEVEN,
        answer: v5wire({
          annotations: [concern()],
          strengths: [
            strength({
              severity: "major",
              blocking: true,
              suggestion: "rewrite",
              id: "model-supplied",
            }),
            strength({
              dimension: "soundness",
              anchor: "Results follow in Section 4.",
              evidence: { anchor: "A fixed seed was used." },
            }),
          ],
          impressions: {},
        }),
      }),
    );
    expect(out.result?.annotations.map((a) => a.id)).toEqual(["claims-1"]);
    expect(out.result?.strengths).toEqual([
      {
        id: "claims-s1",
        reviewer: "claims",
        dimension: "clarity",
        span: { file: "main.tex", line: 3 },
        message: "The method is laid out before it is used.",
      },
      {
        id: "claims-s2",
        reviewer: "claims",
        dimension: "soundness",
        span: { file: "main.tex", line: 6 },
        message: "The method is laid out before it is used.",
        evidence: { kind: "span", file: "main.tex", line: 5 },
      },
    ]);
    expect(out.counts?.strengths).toEqual({
      entries: 2,
      located: 2,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
    // The concern identity never sees a strength.
    expect(out.counts?.entries).toBe(1);
    expect(lostOf(out)).toBeUndefined();
  });

  it("a ledger with no strengths key is complete, and carries no strengths and no count", () => {
    const out = interpretLedger(ledger({ answer: wire(concern()) }));
    expect(out.result).toBeDefined();
    expect(Object.hasOwn(out.result ?? {}, "strengths")).toBe(false);
    expect(out.counts?.strengths).toBeUndefined();
    const empty = interpretLedger(
      ledger({ answer: v5wire({ strengths: [] }) }),
    );
    expect(Object.hasOwn(empty.result ?? {}, "strengths")).toBe(false);
    expect(empty.counts?.strengths).toBeUndefined();
  });

  it("drops a strength whose quote or evidence does not locate, into one strengths_lost limit", () => {
    const out = interpretLedger(
      ledger({
        answer: v5wire({
          strengths: [
            strength({
              anchor: "No sentence of this manuscript reads like this.",
            }),
            strength({ evidence: { anchor: "nor this one" } }),
            strength(),
          ],
        }),
      }),
    );
    expect(out.result?.strengths?.map((s) => s.id)).toEqual(["claims-s1"]);
    expect(lostOf(out)).toEqual({
      kind: "strengths_lost",
      reviewer: "claims",
      dropped: [
        {
          anchor: "No sentence of this manuscript reads like this.",
          file: "main.tex",
          role: "claim",
          reason: "not_found",
        },
        {
          anchor: "nor this one",
          file: "main.tex",
          role: "evidence",
          reason: "not_found",
        },
      ],
      rejected: [],
    });
    // A lost strength is never a concern drop.
    expect(out.result?.limits?.some((l) => l.kind === "anchors_dropped")).toBe(
      false,
    );
    expect(out.counts?.strengths).toEqual({
      entries: 3,
      located: 1,
      relocated: 0,
      dropped: 2,
      rejected: 0,
    });
  });

  it("counts a relocated strength apart — never in the concerns' relocated or their ids", () => {
    const out = interpretLedger(
      ledger({
        answer: v5wire({
          annotations: [concern()],
          strengths: [strength({ anchor: "Each figure is reproducible." })],
        }),
      }),
    );
    expect(out.result?.strengths?.[0]?.span.file).toBe("sections/method.tex");
    expect(out.counts?.strengths?.relocated).toBe(1);
    expect(out.counts?.relocated).toBe(0);
    expect([...(out.relocatedIds ?? [])]).toEqual([]);
  });

  it("rejects a shape violation by its 1-based index in the strengths array", () => {
    const out = interpretLedger(
      ledger({
        allowedDimensions: SEVEN,
        answer: v5wire({
          annotations: [concern({ severity: "minor", blocking: true })],
          strengths: [
            strength(),
            strength({ anchor: "" }),
            strength({ message: " " }),
            strength({ dimension: "presentation" }),
            strength({ evidence: "missing" }),
            "not an object",
          ],
        }),
      }),
    );
    const lost = lostOf(out);
    expect(lost?.rejected.map((r) => r.index)).toEqual([2, 3, 4, 5, 6]);
    expect(lost?.rejected[2]?.reason).toContain(
      '"presentation" is not an allowed dimension',
    );
    expect(lost?.rejected[3]?.reason).toBe(
      'a strength\'s "evidence" is a verbatim passage {"anchor": …} or a paper {"paper": {"title": …}} — never "missing"; leave it out instead',
    );
    // The concern's own rejection is recorded as it always was, apart.
    const concerns = out.result?.limits?.find(
      (l) => l.kind === "entries_rejected",
    );
    expect(
      concerns?.kind === "entries_rejected" && concerns.entries.length,
    ).toBe(1);
    expect(out.counts?.strengths?.rejected).toBe(5);
  });

  it("a strengths value that is not a list costs the block, recorded as index 0", () => {
    const out = interpretLedger(
      ledger({ answer: v5wire({ strengths: { dimension: "clarity" } }) }),
    );
    expect(lostOf(out)?.rejected).toEqual([
      {
        index: 0,
        reason:
          '"strengths" must be a list of entries — use [] or leave it out if you found nothing done well',
      },
    ]);
    expect(out.counts?.strengths).toEqual({
      entries: 1,
      located: 0,
      relocated: 0,
      dropped: 0,
      rejected: 1,
    });
  });

  it("an originality or positioning strength must cite a paper this seat's search returned", () => {
    for (const dimension of ["originality", "positioning", "Positioning"]) {
      const out = interpretLedger(
        ledger({
          papers: PAPERS,
          answer: v5wire({
            strengths: [
              strength({ dimension }),
              strength({
                dimension,
                evidence: { anchor: "A fixed seed was used." },
              }),
              strength({
                dimension,
                evidence: { paper: { title: ADAM.title } },
              }),
              strength({
                dimension,
                evidence: {
                  paper: { title: "A Paper That Nobody Ever Wrote" },
                },
              }),
            ],
          }),
        }),
      );
      const lost = lostOf(out);
      expect(lost?.rejected.map((r) => r.index)).toEqual([1, 2]);
      expect(lost?.rejected[0]?.reason).toBe(
        'a strength under "originality" or "positioning" must cite, as its evidence, a paper one of your own searches returned — {"paper": {"title": …}}, the closest work — and its message must say what this manuscript does beyond it. If no search returned one, leave the strength out',
      );
      expect(lost?.dropped).toEqual([
        {
          anchor: "A Paper That Nobody Ever Wrote",
          role: "evidence",
          reason: "not_in_results",
        },
      ]);
      expect(out.result?.strengths?.[0]?.evidence).toEqual({
        kind: "paper",
        title: ADAM.title,
        authors: ADAM.authors,
        year: ADAM.year,
        venue: ADAM.venue,
        doi: ADAM.doi,
        url: ADAM.url,
        source: ADAM.source,
      });
    }
    // ADR 0078 §3 stands for CONCERNS: a positioning concern needs no paper.
    const concernOut = interpretLedger(
      ledger({ answer: wire(concern({ dimension: "positioning" })) }),
    );
    expect(concernOut.result?.annotations).toHaveLength(1);
  });

  it("from the seat that views pages, a strength needs a page it viewed under every dimension", () => {
    const VIEWED: ReadonlySet<number> = new Set([1, 2]);
    const out = interpretLedger(
      ledger({
        reviewer: "pdf_reviewer",
        viewedPages: VIEWED,
        answer: v5wire({
          strengths: [
            strength({ evidence: { page: 2 } }),
            strength({ dimension: "presentation", evidence: { page: 7 } }),
            strength({ dimension: "presentation" }),
            strength({ evidence: { anchor: "A fixed seed was used." } }),
            strength({ dimension: "originality", evidence: { page: 1 } }),
          ],
        }),
      }),
    );
    expect(out.result?.strengths).toEqual([
      {
        id: "pdf_reviewer-s1",
        reviewer: "pdf_reviewer",
        dimension: "clarity",
        span: { file: "main.tex", line: 3 },
        message: "The method is laid out before it is used.",
        evidence: { kind: "page", page: 2 },
      },
    ]);
    const lost = lostOf(out);
    expect(lost?.dropped).toEqual([
      { anchor: "page 7", role: "evidence", reason: "page_not_viewed" },
    ]);
    expect(lost?.rejected.map((r) => r.index)).toEqual([3, 4, 5]);
    expect(lost?.rejected[0]?.reason).toBe(
      'a strength you file must name the page on which what you praise is visible — {"page": N}, a page you viewed',
    );
    expect(lost?.rejected[2]?.reason).toBe(
      'a strength under "originality" or "positioning" needs a paper one of your own searches returned, and a strength you file needs a page you viewed — it cannot be both, so leave it out',
    );
  });

  it("a text reviewer's strength owes no page", () => {
    const out = interpretLedger(
      ledger({ answer: v5wire({ strengths: [strength()] }) }),
    );
    expect(out.result?.strengths).toHaveLength(1);
  });

  it("the quick action reads no strengths", () => {
    const out = interpretAnnotations({
      answer: JSON.stringify({
        annotations: [
          {
            dimension: "claims",
            severity: "major",
            anchor: "We report no baseline for the headline claim.",
            message: "m",
          },
        ],
        strengths: [strength()],
        impressions: { claims: 3 },
      }),
      unitText: MAIN,
      unitStartOffset: 0,
      fileContent: MAIN,
      file: "main.tex",
      reviewer: "writing",
      suggestEdits: false,
    });
    expect(out.result?.annotations).toHaveLength(1);
    expect(Object.keys(out.result ?? {}).sort()).toEqual(["annotations"]);
  });
});

describe("interpretLedger — impressions and declarations (V5, ADR 0087 §2, O3)", () => {
  const assess = (answer: string, over: Partial<LedgerInput> = {}) =>
    interpretLedger(ledger({ allowedDimensions: SEVEN, answer, ...over }));

  it("records one assessment per dimension the seat assesses, in its brief's order", () => {
    const out = assess(
      v5wire({
        impressions: {
          claims: 3,
          soundness: 10,
          clarity: null,
          language: 0,
          positioning: 7.5,
          originality: "7",
          presentation: 9,
          unknown: 4,
        },
      }),
    );
    expect(out.result?.assessments).toEqual([
      { reviewer: "claims", dimension: "soundness", impression: 10 },
      { reviewer: "claims", dimension: "claims", impression: 3 },
      { reviewer: "claims", dimension: "clarity", impression: null },
      { reviewer: "claims", dimension: "language", impression: null },
      { reviewer: "claims", dimension: "positioning", impression: null },
      { reviewer: "claims", dimension: "originality", impression: null },
      { reviewer: "claims", dimension: "significance", impression: null },
    ]);
  });

  it("keeps a declaration as authored, beside the impression and beside a filed concern", () => {
    const out = assess(
      v5wire({
        annotations: [concern()],
        impressions: { positioning: 5 },
        not_assessed: [
          { dimension: "positioning", reason: "Keine Quelle antwortete." },
          { dimension: "claims", reason: "The claims are out of my depth." },
          { dimension: "presentation", reason: "not mine" },
          { dimension: "clarity" },
          "not an object",
          { dimension: "claims", reason: "a second one is not read" },
        ],
      }),
    );
    const byDim = new Map(
      (out.result?.assessments ?? []).map((a) => [a.dimension, a]),
    );
    expect(byDim.get("positioning")).toEqual({
      reviewer: "claims",
      dimension: "positioning",
      impression: 5,
      notAssessed: "Keine Quelle antwortete.",
    });
    // Recorded, though the seat filed a concern under it — the derivation,
    // not the interpreter, decides what a declaration beside evidence means.
    expect(byDim.get("claims")?.notAssessed).toBe(
      "The claims are out of my depth.",
    );
    expect(byDim.has("presentation")).toBe(false);
    expect(byDim.get("clarity")?.notAssessed).toBeUndefined();
    // Nothing here is a limit, and no concern was rejected by a declaration.
    expect(out.result?.annotations).toHaveLength(1);
    expect(out.result?.limits).toBeUndefined();
  });

  it("assesses only what the seat is asked to assess — the PDF seat's presentation", () => {
    const out = interpretLedger(
      ledger({
        reviewer: "pdf_reviewer",
        allowedDimensions: [...SEVEN, "presentation"],
        assessedDimensions: ["presentation"],
        viewedPages: new Set([1]),
        answer: v5wire({ impressions: { presentation: 6, claims: 2 } }),
      }),
    );
    expect(out.result?.assessments).toEqual([
      { reviewer: "pdf_reviewer", dimension: "presentation", impression: 6 },
    ]);
  });

  it("a seat asked to assess nothing records no assessments", () => {
    const out = interpretLedger(
      ledger({ answer: v5wire({ impressions: { claims: 4 } }) }),
    );
    expect(Object.hasOwn(out.result ?? {}, "assessments")).toBe(false);
    expect(out.impressionProblems ?? []).toEqual([]);
  });
});

describe("the one re-ask names lost strengths, malformed impressions and one contradiction (V5, O4)", () => {
  const OLD_CLOSING =
    "Reply once with one JSON ledger that holds ONLY your corrections to the entries listed above, each one complete. For a quote, open the file again and copy the passage exactly as it appears, from a single line — never describe it and never retype it from memory — and name the `file` you copied it from. Leave out any entry you withdraw. Every entry not listed above is already recorded: do not send it again. This is the only correction round.";
  const SCALAR_CLAUSE =
    ' For an impression or a declaration, send the "impressions" or "not_assessed" block again with the values you now mean; a dimension you leave out keeps the value already recorded.';
  const IMPRESSION_ONLY_CLOSING =
    'Reply once with one JSON ledger: "annotations": [] and the "impressions" or "not_assessed" block with the values you now mean. Every entry is already recorded: do not send it again. This is the only correction round.';

  const reask = (answer: string, over: Partial<LedgerInput> = {}) => {
    const out = interpretLedger(
      ledger({ allowedDimensions: SEVEN, answer, ...over }),
    );
    if (out.result === undefined) throw new Error("fixture: expected a result");
    return describeLedgerProblems(
      out.result,
      over.reviewer ?? "claims",
      over.viewedPages,
      out.impressionProblems,
    );
  };

  it("exports the floor the contradiction rule reads", () => {
    expect(IMPRESSION_CONTRADICTION_FLOOR).toBe(8);
  });

  it("the parse-failure sentence a failed reviewer copies shows the three new keys (D13)", () => {
    const notJson = (viewedPages?: ReadonlySet<number>) =>
      interpretLedger(
        ledger({
          answer: "prose, not json",
          ...(viewedPages ? { viewedPages } : {}),
        }),
      ).failure ?? "";
    for (const text of [notJson(), notJson(new Set([1]))]) {
      expect(text).toContain('"strengths": [{');
      expect(text).toContain('"impressions": {');
      expect(text).toContain('"not_assessed": [{');
    }
    // V4's split stands: only the sentence for a reviewer that may cite pages
    // shows the page form.
    expect(notJson()).not.toContain('"page"');
    expect(notJson()).toContain("ONE of three things");
    expect(notJson(new Set([1]))).toContain("ONE of four things");
  });

  it("is BYTE-IDENTICAL to V4's for a ledger with no new problem", () => {
    expect(
      reask(
        v5wire({
          annotations: [
            concern({
              evidence: { anchor: "not anywhere in this manuscript" },
            }),
          ],
          strengths: [strength()],
          impressions: { claims: 4 },
        }),
      ),
    ).toBe(
      [
        "Some entries of your ledger could not be recorded. Each is listed with its reason.",
        "",
        '- the evidence quote "not anywhere in this manuscript" was not found in `main.tex` or in any other file of the manuscript.',
        "",
        OLD_CLOSING,
      ].join("\n"),
    );
  });

  it("an impressions block that is present — even {} — raises nothing", () => {
    expect(reask(v5wire({ impressions: {} }))).toBeUndefined();
    expect(
      reask(v5wire({ annotations: [concern()], impressions: { claims: 9 } })),
    ).toBeUndefined();
  });

  it("an ABSENT block, on its own, spends the re-ask — with a lead-in that claims no failed entry", () => {
    expect(reask(wire(concern()))).toBe(
      [
        "Every entry of your ledger was recorded. Before it is final:",
        "",
        '- your reply carries no "impressions" block; send one, with an integer 1–10 or null for each dimension your brief lists',
        "",
        IMPRESSION_ONLY_CLOSING,
      ].join("\n"),
    );
  });

  it("the PDF seat's absent-block line names presentation only", () => {
    const text = reask(wire(), {
      reviewer: "pdf_reviewer",
      allowedDimensions: [...SEVEN, "presentation"],
      assessedDimensions: ["presentation"],
      viewedPages: new Set([1]),
    });
    expect(text).toContain(
      '- your reply carries no "impressions" block; send one, with an integer 1–10 or null for "presentation"',
    );
    expect(text).not.toContain("each dimension your brief lists");
  });

  it("names each malformed impression and declaration, once", () => {
    const text = reask(
      v5wire({
        impressions: { soundness: 11, claims: "high", clarity: 5 },
        not_assessed: [{ dimension: "language" }],
      }),
    );
    expect(text).toBe(
      [
        "Every entry of your ledger was recorded. Before it is final:",
        "",
        '- your impression of "soundness" is not a whole number from 1 to 10; send it as one, or as null',
        '- your impression of "claims" is not a whole number from 1 to 10; send it as one, or as null',
        '- entry 1 of your "not_assessed" block is not {"dimension": "...", "reason": "one sentence why"}; send it in that shape, or leave it out',
        "",
        IMPRESSION_ONLY_CLOSING,
      ].join("\n"),
    );
    expect(reask(v5wire({ impressions: [3, 4] })) ?? "").toContain(
      '- your "impressions" block is not an object keyed by dimension; send one, with an integer 1–10 or null for each dimension your brief lists',
    );
    expect(
      reask(v5wire({ impressions: {}, not_assessed: "none" })) ?? "",
    ).toContain(
      '- your "not_assessed" block is not a list of {"dimension": "...", "reason": "..."}; send it as one, or leave it out',
    );
  });

  it("names the one contradiction — a high impression beside a blocking major — at the floor and above only", () => {
    const blocking = concern({ blocking: true });
    expect(
      reask(v5wire({ annotations: [blocking], impressions: { claims: 8 } })),
    ).toBe(
      [
        "Every entry of your ledger was recorded. Before it is final:",
        "",
        '- your impression of "claims" is 8, and you filed a blocking major under "claims". If both are as you meant them, send the impression again unchanged; otherwise send the one you now mean.',
        "",
        IMPRESSION_ONLY_CLOSING,
      ].join("\n"),
    );
    // Below the floor, and a major that does not block, say nothing.
    expect(
      reask(v5wire({ annotations: [blocking], impressions: { claims: 7 } })),
    ).toBeUndefined();
    expect(
      reask(v5wire({ annotations: [concern()], impressions: { claims: 10 } })),
    ).toBeUndefined();
  });

  it("names each lost strength after the concern lines, and keeps today's lead-in and closing", () => {
    const text = reask(
      v5wire({
        annotations: [concern({ anchor: "nowhere at all, this one" })],
        strengths: [
          strength(),
          strength({ message: "" }),
          strength({
            anchor: "No sentence of this manuscript reads like this.",
          }),
          strength({ evidence: { anchor: "not here either" } }),
        ],
        impressions: {},
      }),
    );
    expect(text).toBe(
      [
        "Some entries of your ledger could not be recorded. Each is listed with its reason.",
        "",
        '- the quote "nowhere at all, this one" was not found in `main.tex` or in any other file of the manuscript.',
        '- strength 2: "message" must be a non-empty string',
        '- the strength\'s quote "No sentence of this manuscript reads like this." was not found in `main.tex` or in any other file of the manuscript.',
        '- the strength\'s evidence quote "not here either" was not found in `main.tex` or in any other file of the manuscript.',
        "",
        OLD_CLOSING,
      ].join("\n"),
    );
  });

  it("a strength's unreturned paper gets its own sentence and its own instruction", () => {
    const text = reask(
      v5wire({
        strengths: [
          strength({
            dimension: "originality",
            evidence: { paper: { title: "A Paper That Nobody Ever Wrote" } },
          }),
        ],
        impressions: {},
      }),
      { papers: PAPERS },
    );
    expect(text).toContain(
      '- the strength\'s paper "A Paper That Nobody Ever Wrote" is not among the results your own literature searches returned.',
    );
    expect(text).toContain(
      "For a strength's paper, cite it only by a title exactly as one of your searches showed it; if no search returns it, leave the strength out.",
    );
    expect(text).not.toContain("file the concern without it");
  });

  it("a mixed re-ask keeps today's lead-in, and the closing gains the scalar clause", () => {
    const text = reask(wire(concern({ anchor: "nowhere at all, this one" })));
    expect(text).toBe(
      [
        "Some entries of your ledger could not be recorded. Each is listed with its reason.",
        "",
        '- the quote "nowhere at all, this one" was not found in `main.tex` or in any other file of the manuscript.',
        '- your reply carries no "impressions" block; send one, with an integer 1–10 or null for each dimension your brief lists',
        "",
        OLD_CLOSING + SCALAR_CLAUSE,
      ].join("\n"),
    );
  });
});

describe("mergeLedgerCorrection learns strengths and scalars (V5, ADR 0087 §2, O4, O20)", () => {
  function parsed(answer: string, over: Partial<LedgerInput> = {}) {
    const out = interpretLedger(
      ledger({ allowedDimensions: SEVEN, answer, ...over }),
    );
    if (out.result === undefined || out.counts === undefined) {
      throw new Error("fixture: expected a parsed ledger");
    }
    return {
      result: out.result,
      counts: out.counts,
      relocatedIds: out.relocatedIds ?? new Set<string>(),
    };
  }
  const second = (answer: string, over: Partial<LedgerInput> = {}) =>
    interpretLedger(ledger({ allowedDimensions: SEVEN, answer, ...over }));

  const FIRST = v5wire({
    annotations: [concern()],
    strengths: [
      strength(),
      strength({ anchor: "No sentence of this manuscript reads like this." }),
    ],
    impressions: { soundness: 4, claims: 3, clarity: 7 },
    not_assessed: [{ dimension: "positioning", reason: "first reason" }],
  });

  it("appends new strengths under their own key set, and a concern on the same span is not a re-send", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      second(
        v5wire({
          // The concern re-sent is skipped by the concerns' key…
          annotations: [concern()],
          strengths: [
            // …a strength re-sent is skipped by the strengths' key…
            strength(),
            // …a genuinely new one is appended, densely…
            strength({ anchor: "Each figure is reproducible." }),
            // …and a strength on the concern's own span is a strength.
            strength({
              dimension: "claims",
              anchor: "We report no baseline for the headline claim.",
            }),
          ],
        }),
      ),
    );
    expect(merged.result.annotations.map((a) => a.id)).toEqual(["claims-1"]);
    expect(merged.result.strengths?.map((s) => s.id)).toEqual([
      "claims-s1",
      "claims-s2",
      "claims-s3",
    ]);
    expect(merged.counts.strengths).toEqual({
      entries: 3,
      located: 3,
      relocated: 1,
      dropped: 0,
      rejected: 0,
    });
    // The concern identity is untouched by any of it.
    expect(merged.counts).toMatchObject({
      entries: 1,
      located: 1,
      relocated: 0,
      dropped: 0,
      rejected: 0,
    });
  });

  it("replaces an impression for every dimension the correction names, null included, and keeps the rest", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      second(v5wire({ impressions: { soundness: 6, claims: null } })),
    );
    const impression = (d: string) =>
      merged.result.assessments?.find((a) => a.dimension === d)?.impression;
    expect(impression("soundness")).toBe(6);
    expect(impression("claims")).toBeNull();
    expect(impression("clarity")).toBe(7);
    // No not_assessed block in the correction: the first's declaration stands.
    expect(
      merged.result.assessments?.find((a) => a.dimension === "positioning")
        ?.notAssessed,
    ).toBe("first reason");
    expect(merged.result.assessments).toHaveLength(7);
  });

  it("replaces a declaration per dimension the correction's block names", () => {
    const merged = mergeLedgerCorrection(
      parsed(FIRST),
      second(
        v5wire({
          not_assessed: [
            { dimension: "significance", reason: "second reason" },
          ],
        }),
      ),
    );
    const note = (d: string) =>
      merged.result.assessments?.find((a) => a.dimension === d)?.notAssessed;
    expect(note("significance")).toBe("second reason");
    expect(note("positioning")).toBe("first reason");
  });

  it("an unreadable correction leaves the first pass whole — strengths and assessments included", () => {
    const first = parsed(FIRST);
    const merged = mergeLedgerCorrection(
      first,
      second("Sorry — here is some prose instead."),
    );
    expect(merged.result).toEqual(first.result);
    expect(merged.counts).toEqual(first.counts);
  });

  it("with correction: true, a reply carrying only scalars reads as an empty ledger plus its blocks", () => {
    const reply = JSON.stringify({ impressions: { claims: 5 } });
    const read = second(reply, { correction: true });
    expect(read.failure).toBeUndefined();
    expect(read.result?.annotations).toEqual([]);
    const merged = mergeLedgerCorrection(parsed(FIRST), read);
    // Every first-pass concern and strength stays; the scalar is applied.
    expect(merged.result.annotations.map((a) => a.id)).toEqual(["claims-1"]);
    expect(merged.result.strengths?.map((s) => s.id)).toEqual(["claims-s1"]);
    expect(
      merged.result.assessments?.find((a) => a.dimension === "claims")
        ?.impression,
    ).toBe(5);
    expect(
      merged.result.assessments?.find((a) => a.dimension === "soundness")
        ?.impression,
    ).toBe(4);
    const declared = second(
      JSON.stringify({
        not_assessed: [{ dimension: "clarity", reason: "no text to read" }],
      }),
      { correction: true },
    );
    expect(declared.result?.assessments?.[2]?.notAssessed).toBe(
      "no text to read",
    );
  });

  it("the same scalar-only reply as a FIRST answer is still the parse failure", () => {
    const first = second(JSON.stringify({ impressions: { claims: 5 } }));
    expect(first.result).toBeUndefined();
    expect(first.failure).toBe(
      '"annotations" must be an array — use [] if you found no grounded concern',
    );
  });

  it("a correction with neither the array nor a block stays unreadable, and the first pass stands", () => {
    const read = second(JSON.stringify({ strengths: [] }), {
      correction: true,
    });
    expect(read.result).toBeUndefined();
    const first = parsed(FIRST);
    expect(mergeLedgerCorrection(first, read)).toEqual(first);
  });
});
