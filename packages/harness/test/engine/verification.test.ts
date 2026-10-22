import { describe, expect, it } from "vitest";
import type {
  ReviewAnnotation,
  ReviewVerification,
} from "../../src/contracts/data.js";
import { manuscriptLocator } from "../../src/engine/review.js";
import {
  VERIFICATION_NOTE_CHARS,
  type VerificationReading,
  applyVerification,
  countVerification,
  interpretVerification,
  isBlocking,
  isWithdrawn,
  mergeVerificationCorrection,
} from "../../src/engine/verification.js";

/**
 * V1 (ADR 0076 §3): the verifier's reply, read. O1–O5 of the plan's tier table.
 *
 * The manuscript is two files, built the way `ledger.test.ts` builds its own —
 * one quotable anchor per line — so each locator outcome a counter-quote can
 * meet is one line of fixture:
 *   · "Table 3 compares against two strong baselines." — unique in main.tex.
 *   · "The ablation over block size is in Appendix B." — only in
 *     sections/method.tex, so a counter that names no file reaches the
 *     manuscript-wide fallback (ADR 0074 §1).
 *   · "The results hold." — twice on one line of main.tex: ambiguous.
 */
const MAIN = [
  "\\documentclass{article}",
  "\\begin{document}",
  "We report no baseline for the headline claim.",
  "Table 3 compares against two strong baselines.",
  "The results hold. The results hold.",
  "\\end{document}",
  "",
].join("\n");

const METHOD = [
  "\\section{Method}",
  "The ablation over block size is in Appendix B.",
  "We never vary the block size.",
  "",
].join("\n");

const FILES = new Map([
  ["main.tex", MAIN],
  ["sections/method.tex", METHOD],
]);

const locate = manuscriptLocator(FILES, "main.tex");

/** Three located concerns across two reviewers and both files. */
const A1: ReviewAnnotation = {
  id: "reviewer_a-1",
  reviewer: "reviewer_a",
  dimension: "soundness",
  severity: "major",
  span: { file: "main.tex", line: 3 },
  message: "No baseline is reported for the headline claim.",
  blocking: true,
  evidence: { kind: "missing" },
};
const A2: ReviewAnnotation = {
  id: "reviewer_a-2",
  reviewer: "reviewer_a",
  dimension: "clarity",
  severity: "minor",
  span: { file: "main.tex", line: 5 },
  message: "The results sentence is repeated.",
  evidence: { kind: "span", file: "main.tex", line: 5 },
  suggestedEdit: {
    original: "The results hold. The results hold.",
    replacement: "The results hold.",
  },
};
const B1: ReviewAnnotation = {
  id: "reviewer_b-1",
  reviewer: "reviewer_b",
  dimension: "soundness",
  severity: "major",
  span: { file: "sections/method.tex", line: 3 },
  message: "The block size is never ablated.",
  blocking: true,
  evidence: { kind: "missing" },
};
/**
 * A concern whose claim line and evidence line are DIFFERENT — the shape
 * V1's J1 round found the verifier answering with its own evidence line
 * (report item 1c). `CONCERNS` deliberately does not hold it: the counts
 * asserted above are over the three.
 */
const B2: ReviewAnnotation = {
  id: "reviewer_b-2",
  reviewer: "reviewer_b",
  dimension: "soundness",
  severity: "minor",
  span: { file: "sections/method.tex", line: 3 },
  message: "The ablation's block size is never varied.",
  evidence: { kind: "span", file: "sections/method.tex", line: 2 },
};
const CONCERNS = [A1, A2, B1];

const reply = (entries: unknown[]): string =>
  JSON.stringify({ verifications: entries });

const read = (answer: string, concerns = CONCERNS): VerificationReading =>
  interpretVerification({ answer, concerns, locate });

/** Every concern answered `upheld` — the reply with nothing to feed back. */
const ALL_UPHELD = [
  { id: "reviewer_a-1", kind: "absence", outcome: "upheld" },
  { id: "reviewer_a-2", kind: "judgment", outcome: "unverifiable" },
  { id: "reviewer_b-1", kind: "absence", outcome: "upheld" },
];

describe("O1 — a reply's entries are recorded by id, or named as problems", () => {
  it("records one entry per concern, and has nothing to feed back", () => {
    const r = read(reply(ALL_UPHELD));
    expect(r.failure).toBeUndefined();
    expect(r.problems).toBeUndefined();
    expect([...r.entries.keys()]).toEqual([
      "reviewer_a-1",
      "reviewer_a-2",
      "reviewer_b-1",
    ]);
    expect(r.entries.get("reviewer_a-1")).toEqual({
      outcome: "upheld",
      kind: "absence",
    });
  });

  it("tolerates a fenced reply and prose around it", () => {
    const r = read(
      `Here is my check.\n\`\`\`json\n${reply(ALL_UPHELD)}\n\`\`\`\nDone.`,
    );
    expect(r.failure).toBeUndefined();
    expect(r.entries.size).toBe(3);
  });

  it("an id outside the brief is a problem and records nothing", () => {
    const r = read(
      reply([
        ...ALL_UPHELD,
        { id: "reviewer_c-9", kind: "absence", outcome: "upheld" },
      ]),
    );
    expect(r.entries.has("reviewer_c-9")).toBe(false);
    expect(r.entries.size).toBe(3);
    expect(r.problems).toContain("reviewer_c-9");
    expect(r.problems).toContain("cite only ids from your brief");
  });

  it("a second entry for an id is a problem, and the FIRST stands", () => {
    const r = read(
      reply([
        ...ALL_UPHELD,
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "unverifiable",
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")?.outcome).toBe("upheld");
    expect(r.problems).toContain("reviewer_a-1");
  });

  it("a bad kind, a bad outcome, a non-object or a non-string id records nothing", () => {
    const r = read(
      reply([
        { id: "reviewer_a-1", kind: "opinion", outcome: "upheld" },
        { id: "reviewer_a-2", kind: "judgment", outcome: "partly" },
        "reviewer_b-1",
        { id: 7, kind: "absence", outcome: "upheld" },
      ]),
    );
    expect(r.entries.size).toBe(0);
    expect(r.problems).toContain('"kind" must be one of');
    expect(r.problems).toContain('"outcome" must be one of');
    expect(r.problems).toContain('a string "id"');
  });

  it("names every concern left without an entry", () => {
    const r = read(reply([ALL_UPHELD[0]]));
    expect(r.entries.size).toBe(1);
    expect(r.problems).toContain("no entry for");
    expect(r.problems).toContain("reviewer_a-2");
    expect(r.problems).toContain("reviewer_b-1");
  });

  it("a reply with no JSON object, or no verifications array, is a whole failure", () => {
    for (const answer of [
      "I checked them all and they stand.",
      JSON.stringify([ALL_UPHELD]),
      JSON.stringify({ results: ALL_UPHELD }),
      JSON.stringify({ verifications: "all upheld" }),
    ]) {
      const r = read(answer);
      expect(r.failure, answer).toBeDefined();
      expect(r.entries.size, answer).toBe(0);
    }
  });
});

describe("O2 — refuted is recorded only with a harness-located counter", () => {
  it("records the counter's located span, in the file it was found in", () => {
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "Table 3 compares against two strong baselines." },
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")).toEqual({
      outcome: "refuted",
      kind: "absence",
      counter: { file: "main.tex", line: 4 },
    });
  });

  it("finds a counter in another file through the ledger's own fallback", () => {
    const r = read(
      reply([
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "refuted",
          counter: {
            anchor: "The ablation over block size is in Appendix B.",
          },
        },
      ]),
    );
    expect(r.entries.get("reviewer_b-1")?.counter).toEqual({
      file: "sections/method.tex",
      line: 2,
    });
  });

  it("honours a named file, normalized as the ledger normalizes it", () => {
    const r = read(
      reply([
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "refuted",
          counter: {
            anchor: "The ablation over block size is in Appendix B.",
            file: "./sections\\method.tex",
          },
        },
      ]),
    );
    expect(r.entries.get("reviewer_b-1")?.outcome).toBe("refuted");
  });

  it.each([
    ["no counter at all", undefined],
    ["a counter that is not an object", "Table 3"],
    ["an empty anchor", { anchor: "" }],
    ["a non-string anchor", { anchor: 42 }],
    ["a non-string file", { anchor: "Table 3", file: 3 }],
    ["an anchor found nowhere", { anchor: "Appendix C proves it." }],
    ["an ambiguous anchor", { anchor: "The results hold." }],
    [
      "a file the manuscript lacks, holding nothing",
      { anchor: "Appendix C proves it.", file: "appendix.tex" },
    ],
  ])("%s → unverifiable, downgraded, and fed back", (_label, counter) => {
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          ...(counter !== undefined ? { counter } : {}),
        },
      ]),
    );
    const entry = r.entries.get("reviewer_a-1");
    expect(entry).toEqual({
      outcome: "unverifiable",
      kind: "absence",
      downgraded: "counter_not_found",
    });
    expect(r.problems).toContain("reviewer_a-1");
  });

  it("feeds back the first 80 characters of a quote it could not find, and why", () => {
    const long = `${"x".repeat(90)} is nowhere in this paper.`;
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: long },
        },
      ]),
    );
    expect(r.problems).toContain(`"${"x".repeat(80)}…"`);
    expect(r.problems).not.toContain(long);
    expect(r.problems).toContain("was not found");
  });

  it("no other outcome ever carries a counter, located or not", () => {
    const counter = {
      anchor: "Table 3 compares against two strong baselines.",
    };
    const r = read(
      reply([
        { id: "reviewer_a-1", kind: "absence", outcome: "upheld", counter },
        {
          id: "reviewer_b-1",
          kind: "contradiction",
          outcome: "unverifiable",
          counter,
        },
      ]),
    );
    for (const e of r.entries.values()) expect(e.counter).toBeUndefined();
  });
});

/**
 * V1's J1 round (2026-09-19): **three of three** withdrawals cited a line the
 * concern itself already points at — twice its own claim span, once its own
 * evidence line — and one of the three was a planted defect from the
 * fixture's own answer key, withdrawn on a note that states the defect. The
 * harness located each quote and asked nothing further, so ADR 0076 §3 gains
 * a third downgrade: a passage the concern already cites answers nothing.
 */
describe("J1 — a counter that IS the concern's own line withdraws nothing", () => {
  const SELF_SPAN = {
    id: "reviewer_a-1",
    kind: "contradiction",
    outcome: "refuted",
    counter: { anchor: "We report no baseline for the headline claim." },
  };

  it("a counter located to the concern's own claim line is downgraded, not refuted", () => {
    const r = read(
      reply([{ ...SELF_SPAN, note: "The setup reports no baseline." }]),
    );
    expect(r.entries.get("reviewer_a-1")).toEqual({
      outcome: "unverifiable",
      kind: "contradiction",
      downgraded: "counter_is_the_concern",
      note: "The setup reports no baseline.",
    });
    expect(r.problems).toContain("reviewer_a-1");
  });

  it("a counter located to the concern's own evidence line is downgraded too", () => {
    const r = read(
      reply([
        {
          id: "reviewer_b-2",
          kind: "contradiction",
          outcome: "refuted",
          counter: {
            anchor: "The ablation over block size is in Appendix B.",
            file: "sections/method.tex",
          },
        },
      ]),
      [B2],
    );
    expect(r.entries.get("reviewer_b-2")).toEqual({
      outcome: "unverifiable",
      kind: "contradiction",
      downgraded: "counter_is_the_concern",
    });
  });

  it("names the line and asks for a different passage, so the one re-ask can answer", () => {
    const r = read(reply([SELF_SPAN]));
    expect(r.problems).toContain("`main.tex:3`");
    expect(r.problems).toContain("a refutation needs a DIFFERENT passage");
  });

  it("the same line number in a DIFFERENT file is a real refutation", () => {
    // reviewer_a-1's claim is at main.tex:3; this quote locates to
    // sections/method.tex:3. The line numbers collide; the files do not.
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "We never vary the block size." },
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")).toEqual({
      outcome: "refuted",
      kind: "absence",
      counter: { file: "sections/method.tex", line: 3 },
    });
  });

  it("compares the span alone when the concern's evidence is `missing`", () => {
    expect(A1.evidence).toEqual({ kind: "missing" });
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "Table 3 compares against two strong baselines." },
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")?.outcome).toBe("refuted");
  });

  it("counts as unverifiable and as downgraded, and is never withdrawn", () => {
    const r = read(reply([SELF_SPAN]), [A1]);
    expect(countVerification([A1], r.entries)).toEqual({
      concerns: 1,
      upheld: 0,
      refuted: 0,
      unverifiable: 1,
      downgraded: 1,
      unanswered: 0,
    });
    expect(applyVerification([A1], r.entries).filter(isWithdrawn)).toEqual([]);
  });

  it("the one re-ask repairs it with another passage, never with the same one", () => {
    const first = read(reply([SELF_SPAN]), [A1]);
    const again = mergeVerificationCorrection(
      first,
      read(reply([SELF_SPAN]), [A1]),
    );
    expect(again.entries.get("reviewer_a-1")?.downgraded).toBe(
      "counter_is_the_concern",
    );
    const repaired = mergeVerificationCorrection(
      first,
      read(
        reply([
          {
            ...SELF_SPAN,
            counter: {
              anchor: "Table 3 compares against two strong baselines.",
            },
          },
        ]),
        [A1],
      ),
    );
    expect(repaired.entries.get("reviewer_a-1")).toEqual({
      outcome: "refuted",
      kind: "contradiction",
      counter: { file: "main.tex", line: 4 },
    });
  });
});

describe("O3 — a judgment or a literature concern cannot be refuted", () => {
  it.each(["judgment", "literature"])(
    "refuted on %s → unverifiable + not_refutable, and fed back",
    (kind) => {
      const r = read(
        reply([
          {
            id: "reviewer_a-2",
            kind,
            outcome: "refuted",
            counter: {
              anchor: "Table 3 compares against two strong baselines.",
            },
          },
        ]),
      );
      expect(r.entries.get("reviewer_a-2")).toEqual({
        outcome: "unverifiable",
        kind,
        downgraded: "not_refutable",
      });
      expect(r.problems).toContain("reviewer_a-2");
      expect(r.problems).toContain("cannot be refuted");
    },
  );
});

describe("O4 — it cannot rewrite a concern", () => {
  it("ignores message, severity, suggestion, dimension and any other key", () => {
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "upheld",
          message: "A better-worded concern.",
          severity: "minor",
          suggestion: "Add Table 9.",
          dimension: "clarity",
          blocking: false,
          span: { file: "main.tex", line: 1 },
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")).toEqual({
      outcome: "upheld",
      kind: "absence",
    });
  });

  it("applyVerification changes no field but `verification`, and mutates nothing", () => {
    const before = structuredClone(CONCERNS);
    const entries = new Map<string, ReviewVerification>([
      [
        "reviewer_a-1",
        {
          outcome: "refuted",
          kind: "absence",
          counter: { file: "main.tex", line: 4 },
        },
      ],
      ["reviewer_b-1", { outcome: "upheld", kind: "absence", central: false }],
    ]);
    const after = applyVerification(CONCERNS, entries);
    expect(CONCERNS).toEqual(before);
    expect(after).toHaveLength(3);
    for (const [i, a] of after.entries()) {
      const { verification, ...rest } = a;
      expect(rest).toEqual(before[i]);
    }
    expect(after[0]?.verification?.outcome).toBe("refuted");
    // A concern with no entry carries no `verification` key at all.
    expect("verification" in (after[1] as object)).toBe(false);
    expect(after[2]?.verification?.central).toBe(false);
  });
});

describe("O5 — central, blocking, and the correction merge", () => {
  it("keeps central only as a boolean on a major", () => {
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "upheld",
          central: false,
        },
        {
          id: "reviewer_a-2",
          kind: "judgment",
          outcome: "unverifiable",
          central: true,
        },
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "upheld",
          central: "yes",
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")?.central).toBe(false);
    // A minor was never asked the question; an answer to it is dropped, and
    // silently — not worth a re-ask.
    expect(r.entries.get("reviewer_a-2")).not.toHaveProperty("central");
    expect(r.entries.get("reviewer_b-1")).not.toHaveProperty("central");
    expect(r.problems).toBeUndefined();
  });

  it("never touches `blocking`; isBlocking is false exactly when central is false", () => {
    const entries = new Map<string, ReviewVerification>([
      ["reviewer_a-1", { outcome: "upheld", kind: "absence", central: false }],
      ["reviewer_b-1", { outcome: "upheld", kind: "absence", central: true }],
    ]);
    const [a1, a2, b1] = applyVerification(CONCERNS, entries) as [
      ReviewAnnotation,
      ReviewAnnotation,
      ReviewAnnotation,
    ];
    expect(a1.blocking).toBe(true);
    expect(isBlocking(a1)).toBe(false);
    expect(isBlocking(b1)).toBe(true);
    // Unverified, the reviewer's own flag decides, as before V1.
    expect(isBlocking(B1)).toBe(true);
    expect(isBlocking(a2)).toBe(false);
  });

  it("isWithdrawn is exactly outcome === refuted", () => {
    const at = (v?: ReviewVerification): ReviewAnnotation => ({
      ...A1,
      ...(v ? { verification: v } : {}),
    });
    expect(isWithdrawn(at())).toBe(false);
    expect(isWithdrawn(at({ outcome: "upheld", kind: "absence" }))).toBe(false);
    expect(
      isWithdrawn(
        at({
          outcome: "unverifiable",
          kind: "absence",
          downgraded: "counter_not_found",
        }),
      ),
    ).toBe(false);
    expect(
      isWithdrawn(
        at({
          outcome: "refuted",
          kind: "absence",
          counter: { file: "main.tex", line: 4 },
        }),
      ),
    ).toBe(true);
  });

  it("keeps a note as a trimmed string, cut to the cap", () => {
    const r = read(
      reply([
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "upheld",
          note: "  Looked in §4.  ",
        },
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "upheld",
          note: "y".repeat(VERIFICATION_NOTE_CHARS + 50),
        },
        {
          id: "reviewer_a-2",
          kind: "judgment",
          outcome: "unverifiable",
          note: 5,
        },
      ]),
    );
    expect(r.entries.get("reviewer_a-1")?.note).toBe("Looked in §4.");
    expect(r.entries.get("reviewer_b-1")?.note).toHaveLength(
      VERIFICATION_NOTE_CHARS,
    );
    expect(r.entries.get("reviewer_a-2")).not.toHaveProperty("note");
  });

  it("the merge never replaces a good first entry, and repairs an absent or downgraded one", () => {
    const first = read(
      reply([
        { id: "reviewer_a-1", kind: "absence", outcome: "upheld" },
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "not in the paper" },
        },
      ]),
    );
    expect(first.entries.get("reviewer_b-1")?.downgraded).toBe(
      "counter_not_found",
    );
    const second = read(
      reply([
        // A change of mind about a settled concern is ignored.
        {
          id: "reviewer_a-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "Table 3 compares against two strong baselines." },
        },
        // The downgraded one is repaired.
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "The ablation over block size is in Appendix B." },
        },
        // The absent one is filled.
        { id: "reviewer_a-2", kind: "judgment", outcome: "unverifiable" },
      ]),
    );
    const merged = mergeVerificationCorrection(first, second);
    expect(merged.entries.get("reviewer_a-1")?.outcome).toBe("upheld");
    expect(merged.entries.get("reviewer_b-1")).toEqual({
      outcome: "refuted",
      kind: "absence",
      counter: { file: "sections/method.tex", line: 2 },
    });
    expect(merged.entries.get("reviewer_a-2")?.outcome).toBe("unverifiable");
  });

  it("a downgraded second answer fills an absence but never replaces a downgraded first", () => {
    const bad = {
      id: "reviewer_b-1",
      kind: "absence",
      outcome: "refuted",
      counter: { anchor: "still not in the paper" },
    };
    const first = read(reply([{ ...bad, counter: { anchor: "not here" } }]));
    const second = read(reply([bad, { ...bad, id: "reviewer_a-1" }]));
    const merged = mergeVerificationCorrection(first, second);
    expect(merged.entries.get("reviewer_b-1")?.downgraded).toBe(
      "counter_not_found",
    );
    expect(merged.entries.get("reviewer_a-1")?.downgraded).toBe(
      "counter_not_found",
    );
  });

  it("a second reading whose whole answer failed changes nothing", () => {
    const first = read(reply([ALL_UPHELD[0]]));
    const merged = mergeVerificationCorrection(first, read("not json"));
    expect(merged.entries).toEqual(first.entries);
  });

  it("counts every concern once — the identity holds", () => {
    const r = read(
      reply([
        { id: "reviewer_a-1", kind: "absence", outcome: "upheld" },
        {
          id: "reviewer_b-1",
          kind: "absence",
          outcome: "refuted",
          counter: { anchor: "nowhere at all" },
        },
      ]),
    );
    const counts = countVerification(CONCERNS, r.entries);
    expect(counts).toEqual({
      concerns: 3,
      upheld: 1,
      refuted: 0,
      unverifiable: 1,
      downgraded: 1,
      unanswered: 1,
    });
    expect(counts.concerns).toBe(
      counts.upheld + counts.refuted + counts.unverifiable + counts.unanswered,
    );
  });
});

/**
 * V2 (ADR 0078 §7, O17): a `literature` concern becomes answerable — but only
 * for one whose brief actually carried the abstract.
 *
 * This discharges ADR 0076's second deliberate limit, and it discharges it
 * narrowly. The verifier still refutes with a MANUSCRIPT passage: the abstract
 * says what the cited work is, and the counter has to be the sentence where
 * the manuscript cites, compares against or distinguishes it.
 */
describe("a literature concern can be answered, with an abstract (V2, O17)", () => {
  const paperConcern = (id: string): ReviewAnnotation => ({
    id,
    reviewer: "reviewer_a",
    dimension: "originality",
    severity: "major",
    span: { file: "main.tex", line: 3 },
    message: "the optimizer is not new",
    evidence: {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
      authors: ["Kingma", "Ba"],
      year: "2015",
      source: "arxiv",
    },
  });

  const refuting = (id: string, anchor: string) =>
    JSON.stringify({
      verifications: [
        { id, kind: "literature", outcome: "refuted", counter: { anchor } },
      ],
    });

  it("records `refuted` when the abstract was handed and the counter is elsewhere", () => {
    const out = interpretVerification({
      answer: refuting(
        "reviewer_a-1",
        "Table 3 compares against two strong baselines.",
      ),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
      abstractsHanded: new Set(["reviewer_a-1"]),
    });
    expect(out.entries.get("reviewer_a-1")).toEqual({
      outcome: "refuted",
      kind: "literature",
      counter: { file: "main.tex", line: 4 },
    });
    expect(out.problems).toBeUndefined();
  });

  it("downgrades when the SAME concern's abstract was not handed", () => {
    // The only difference from the case above is the id set. Without an
    // abstract the verifier has nothing to reason from about that work, and a
    // refutation would be a guess dressed as a finding.
    const out = interpretVerification({
      answer: refuting(
        "reviewer_a-1",
        "Table 3 compares against two strong baselines.",
      ),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
    });
    expect(out.entries.get("reviewer_a-1")).toEqual({
      outcome: "unverifiable",
      kind: "literature",
      downgraded: "not_refutable",
    });
  });

  it("still downgrades a `judgment` concern, abstract or not", () => {
    const out = interpretVerification({
      answer: JSON.stringify({
        verifications: [
          {
            id: "reviewer_a-1",
            kind: "judgment",
            outcome: "refuted",
            counter: {
              anchor: "Table 3 compares against two strong baselines.",
            },
          },
        ],
      }),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
      abstractsHanded: new Set(["reviewer_a-1"]),
    });
    expect(out.entries.get("reviewer_a-1")?.downgraded).toBe("not_refutable");
  });

  it("still refuses a counter that is the concern's OWN claim line (ADR 0077 §1)", () => {
    // V2 widens WHICH concerns may be refuted; it does not touch what makes a
    // refutation independent of the concern it answers.
    const out = interpretVerification({
      answer: refuting(
        "reviewer_a-1",
        "We report no baseline for the headline claim.",
      ),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
      abstractsHanded: new Set(["reviewer_a-1"]),
    });
    expect(out.entries.get("reviewer_a-1")).toMatchObject({
      outcome: "unverifiable",
      downgraded: "counter_is_the_concern",
    });
  });

  it("a paper evidence has no line, so it can never BE the concern's own line", () => {
    // `ownLineOf` reads a span evidence only: a paper is not in the manuscript,
    // so no counter can collide with it. Refuting on the concern's evidence
    // line is impossible here rather than merely unlikely.
    const out = interpretVerification({
      answer: refuting(
        "reviewer_a-1",
        "The ablation over block size is in Appendix B.",
      ),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
      abstractsHanded: new Set(["reviewer_a-1"]),
    });
    expect(out.entries.get("reviewer_a-1")?.outcome).toBe("refuted");
  });

  it("downgrades an UPHELD literature concern whose abstract was not handed", () => {
    // V2's gate review, issue 2. The no-abstract test guarded only the
    // `refuted` direction, so an `upheld` passed through untouched — and an
    // upheld concern wears NO mark, the same as a checked one, and the
    // synthesis builds consensus on it.
    //
    // The round watched it happen: `reviewer_c-5` rested a `positioning`
    // concern on a Crossref record with no abstract (Wakatani, Euromicro
    // 2002 — parallel-computing task scheduling, matched on the words "task
    // scheduling" alone), and the verifier upheld it with a note saying only
    // that the manuscript does not cite the work. Judging a candidate from
    // its title is the one thing the Grounding block forbids.
    const out = interpretVerification({
      answer: JSON.stringify({
        verifications: [
          {
            id: "reviewer_a-1",
            kind: "literature",
            outcome: "upheld",
            note: "the manuscript does not cite this work",
          },
        ],
      }),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
    });
    expect(out.entries.get("reviewer_a-1")).toEqual({
      outcome: "unverifiable",
      kind: "literature",
      downgraded: "no_abstract",
      note: "the manuscript does not cite this work",
    });
    // Fed back, so the one re-ask can answer it.
    expect(out.problems).toContain("reviewer_a-1");
  });

  it("leaves an upheld literature concern alone WHEN the abstract was handed", () => {
    const out = interpretVerification({
      answer: JSON.stringify({
        verifications: [
          { id: "reviewer_a-1", kind: "literature", outcome: "upheld" },
        ],
      }),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
      abstractsHanded: new Set(["reviewer_a-1"]),
    });
    expect(out.entries.get("reviewer_a-1")).toEqual({
      outcome: "upheld",
      kind: "literature",
    });
    expect(out.problems).toBeUndefined();
  });

  it("does not mark an already-`unverifiable` answer as downgraded", () => {
    // Nothing was downgraded: the verifier said what the protocol asks for.
    // `downgraded` means *the model answered X and we recorded Y*.
    const out = interpretVerification({
      answer: JSON.stringify({
        verifications: [
          { id: "reviewer_a-1", kind: "literature", outcome: "unverifiable" },
        ],
      }),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
    });
    expect(out.entries.get("reviewer_a-1")).toEqual({
      outcome: "unverifiable",
      kind: "literature",
    });
    expect(out.problems).toBeUndefined();
  });

  it("keeps `not_refutable` on the REFUTED direction, as ADR 0078 §7 has it", () => {
    // The two reasons name two different things and the refuted direction is
    // unchanged — V1's merged O3 row still reads as written.
    const out = interpretVerification({
      answer: refuting(
        "reviewer_a-1",
        "Table 3 compares against two strong baselines.",
      ),
      concerns: [paperConcern("reviewer_a-1")],
      locate,
    });
    expect(out.entries.get("reviewer_a-1")?.downgraded).toBe("not_refutable");
  });

  it("applyVerification leaves the paper evidence deep-equal", () => {
    const concern = paperConcern("reviewer_a-1");
    const [after] = applyVerification(
      [concern],
      new Map([
        ["reviewer_a-1", { outcome: "upheld", kind: "literature" } as const],
      ]),
    );
    expect(after?.evidence).toEqual(concern.evidence);
  });
});
