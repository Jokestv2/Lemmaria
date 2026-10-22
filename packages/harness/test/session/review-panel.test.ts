import { describe, expect, it } from "vitest";
import type {
  ModelAdapter,
  ModelBinding,
} from "../../src/contracts/adapters.js";
import type {
  ReviewAnnotation,
  ReviewResult,
} from "../../src/contracts/data.js";
import type { SessionItem } from "../../src/contracts/sessions.js";
import { MAX_FAN_OUT } from "../../src/session/loop-tools/subtask.js";
import type { PanelReviewer } from "../../src/session/review-panel.js";
import {
  DEFAULT_REVIEWER_COUNT,
  PANEL_DIMENSIONS,
  PANEL_SKILL,
  REVIEWER_NAMES,
  REVIEW_LENS,
  WRAP_COLUMN_THRESHOLD,
  collectManuscript,
  describeWrapping,
  literatureResultsOf,
  observeSeat,
  panelReviewers,
  parseReviewCommand,
  renderReviewForHistory,
  reviewerBrief,
  synthesisBrief,
} from "../../src/session/review-panel.js";

/**
 * R3 (ADR 0061): the pure half of the review panel — the composer verb's
 * grammar, the manuscript map every anchor is located against, the wrapping
 * hint R2's live row bought, and the three pieces of model-facing text.
 *
 * The driver itself is asserted in `review-panel-driver.test.ts`, against
 * scripted seats.
 */

/** A workspace port that serves an in-memory tree. */
function ws(files: Record<string, string>) {
  return {
    root: "/ws",
    async readFile(path: string): Promise<string> {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    async listFiles(): Promise<string[]> {
      return Object.keys(files);
    },
  };
}

describe("parseReviewCommand (O1)", () => {
  it("reads a bare command as a review with no focus", () => {
    expect(parseReviewCommand("/review")).toEqual({});
  });

  it("accepts the trailing space the insert-kind row leaves behind", () => {
    // The composer row inserts exactly `"/review "`; a user who presses Enter
    // without typing a focus lands here, and failing would send it as prose.
    expect(parseReviewCommand("/review ")).toEqual({});
    expect(parseReviewCommand("  /review\t")).toEqual({});
  });

  it("carries the focus verbatim, including its inner punctuation", () => {
    expect(parseReviewCommand("/review the statistics in §4")).toEqual({
      focus: "the statistics in §4",
    });
    expect(parseReviewCommand("/review   spaced   out  ")).toEqual({
      focus: "spaced   out",
    });
  });

  it("accepts a multi-line focus", () => {
    expect(
      parseReviewCommand("/review look at:\n- §3\n- the appendix"),
    ).toEqual({ focus: "look at:\n- §3\n- the appendix" });
  });

  it("refuses prose that merely contains the word", () => {
    expect(parseReviewCommand("we should /review this before submitting")).toBe(
      null,
    );
    expect(parseReviewCommand("please review the intro")).toBe(null);
    expect(parseReviewCommand("/reviewer notes")).toBe(null);
  });

  it("leaves a /skill: inside the focus alone — it is focus text", () => {
    // The branch that consumes this runs before the synthetic load exchanges,
    // and the driver equips the seats itself; a user's `/skill:` here is a
    // sentence about the paper, not a request to load anything.
    expect(
      parseReviewCommand("/review use /skill:related-work framing"),
    ).toEqual({ focus: "use /skill:related-work framing" });
  });
});

describe("collectManuscript — the include graph (X5 O9)", () => {
  /** A reader standing in for a resolved graph. */
  const graphOf =
    (files: string[], missing: string[] = []) =>
    async () => ({ files, missing });

  it("reads exactly the files the entry INCLUDES, in reading order", async () => {
    const m = await collectManuscript(
      ws({
        "main.tex": "documentclass{article}",
        "sections/method.tex": "method",
        "refs.bib": "@article{a,}",
        // Three files the glob used to sweep in and the graph does not:
        // another paper, the reviews of it, and Lemmaria's own memory file.
        "notes.md": "notes",
        "other-paper/main.tex": "someone else's paper",
        "PAPER.md": "Lemmaria's memory of this project",
      }),
      "main.tex",
      graphOf(["main.tex", "sections/method.tex", "refs.bib"]),
    );
    expect([...m.files.keys()]).toEqual([
      "main.tex",
      "sections/method.tex",
      "refs.bib",
    ]);
    expect(m.resolved).toBe("graph");
    expect(m.missing).toBe(0);
  });

  it("keeps the ENTRY a key even when the graph omits it", async () => {
    // The load-bearing line: interpretLedger THROWS on a defaultFile outside
    // the map, and that must stay unreachable whatever a reader returns.
    const m = await collectManuscript(
      ws({ "main.tex": "doc", "sections/a.tex": "a" }),
      "main.tex",
      graphOf(["sections/a.tex"]),
    );
    expect(m.files.has("main.tex")).toBe(true);
    expect(m.defaultFile).toBe("main.tex");
  });

  it("counts declared files that could not be read, without refusing", async () => {
    const m = await collectManuscript(
      ws({ "main.tex": "doc" }),
      "main.tex",
      graphOf(["main.tex"], ["sections/gone.tex", "refs.bib"]),
    );
    expect(m.missing).toBe(2);
    expect(m.resolved).toBe("graph");
  });

  it("falls back to the suffix glob when there is no reader, and says so", async () => {
    const m = await collectManuscript(
      ws({ "main.tex": "doc", "other.md": "other" }),
      "main.tex",
    );
    expect([...m.files.keys()].sort()).toEqual(["main.tex", "other.md"]);
    expect(m.resolved).toBe("glob");
  });

  it("treats a reader that answers undefined, or throws, exactly as none", async () => {
    for (const reader of [
      async () => undefined,
      async () => {
        throw new Error("the parser fell over");
      },
    ]) {
      const m = await collectManuscript(
        ws({ "main.tex": "doc", "other.md": "other" }),
        "main.tex",
        reader,
      );
      expect([...m.files.keys()].sort()).toEqual(["main.tex", "other.md"]);
      expect(m.resolved).toBe("glob");
    }
  });
});

describe("collectManuscript — the suffix glob, which survives as the fallback (O4)", () => {
  it("reads source and bibliography only, keyed workspace-relative", async () => {
    const m = await collectManuscript(
      ws({
        "main.tex": "\\documentclass{article}",
        "sections/method.tex": "method",
        "notes.md": "notes",
        "refs.bib": "@article{a,}",
        "figure.png": "binary",
        Makefile: "all:",
      }),
      "main.tex",
    );
    expect([...m.files.keys()].sort()).toEqual([
      "main.tex",
      "notes.md",
      "refs.bib",
      "sections/method.tex",
    ]);
    expect(m.files.get("sections/method.tex")).toBe("method");
    expect(m.defaultFile).toBe("main.tex");
  });

  it("skips the directories the project walk never descends into", async () => {
    const m = await collectManuscript(
      ws({
        "main.tex": "doc",
        "node_modules/pkg/a.tex": "vendored",
        ".git/x.md": "internal",
        "out/main.tex": "built",
        "sections/a.tex": "real",
      }),
      "main.tex",
    );
    expect([...m.files.keys()].sort()).toEqual(["main.tex", "sections/a.tex"]);
  });

  it("keeps the entry as a key even when the listing omits it", async () => {
    // `interpretLedger` THROWS when its defaultFile is not a key of `files` —
    // a driver bug by design. A listing that filtered the entry out must not
    // turn into that throw halfway through a paid fan-out.
    const files = { "main.tex": "the paper", "other.md": "x" };
    const port = {
      root: "/ws",
      readFile: async (p: string) => files[p as keyof typeof files],
      listFiles: async () => ["other.md"],
    };
    const m = await collectManuscript(port, "main.tex");
    expect(m.files.get("main.tex")).toBe("the paper");
    expect(m.files.has(m.defaultFile)).toBe(true);
  });

  it("survives a listing that throws, and still carries the entry", async () => {
    const port = {
      root: "/ws",
      readFile: async () => "the paper",
      listFiles: async (): Promise<string[]> => {
        throw new Error("no listing");
      },
    };
    const m = await collectManuscript(port, "main.tex");
    expect([...m.files.keys()]).toEqual(["main.tex"]);
  });

  it("skips one unreadable file rather than failing the whole review", async () => {
    const port = {
      root: "/ws",
      readFile: async (p: string) => {
        if (p === "broken.tex") throw new Error("EACCES");
        return "content";
      },
      listFiles: async () => ["main.tex", "broken.tex", "ok.md"],
    };
    const m = await collectManuscript(port, "main.tex");
    expect([...m.files.keys()].sort()).toEqual(["main.tex", "ok.md"]);
  });
});

describe("describeWrapping (O5)", () => {
  const hardWrapped = Array.from(
    { length: 40 },
    () =>
      "Attention mechanisms have been adopted widely across the literature,",
  ).join("\n");

  it("a hard-wrapped source asks for one whole line", () => {
    expect(describeWrapping(hardWrapped)).toContain("ONE WHOLE LINE");
  });

  it("a long-line source asks for a clause within one line", () => {
    const long = `${"word ".repeat(60)}\n${"more ".repeat(60)}`;
    expect(describeWrapping(long)).toContain("within ONE line");
    expect(describeWrapping(long)).not.toContain("ONE WHOLE LINE");
  });

  it("ignores comment lines, so a long % TODO does not unwrap a paper", () => {
    const withComment = `% ${"TODO ".repeat(60)}\n${hardWrapped}`;
    expect(describeWrapping(withComment)).toContain("ONE WHOLE LINE");
  });

  it("ignores blank lines, which a wrapped paragraph is full of", () => {
    const spaced = hardWrapped.split("\n").join("\n\n");
    expect(describeWrapping(spaced)).toContain("ONE WHOLE LINE");
  });

  it("a source of only short lines with a few long ones stays wrapped", () => {
    // The 90th percentile, not the mean: two long lines in forty must not
    // flip a wrapped document, and forty short ones must not flip a long one.
    const mostlyShort = [
      ...Array.from({ length: 38 }, () => "a short line of prose here,"),
      "x".repeat(400),
      "y".repeat(400),
    ].join("\n");
    expect(describeWrapping(mostlyShort)).toContain("ONE WHOLE LINE");
  });

  it("an empty document takes the wrapped hint rather than guessing", () => {
    expect(describeWrapping("")).toContain("ONE WHOLE LINE");
    expect(describeWrapping("\n\n\n")).toContain("ONE WHOLE LINE");
  });

  it("the threshold is a line length, and is the documented one", () => {
    expect(describeWrapping("x".repeat(WRAP_COLUMN_THRESHOLD))).toContain(
      "ONE WHOLE LINE",
    );
    expect(describeWrapping("x".repeat(WRAP_COLUMN_THRESHOLD + 1))).toContain(
      "within ONE line",
    );
  });
});

/** A `ChildModel` whose binding names `model`, for the "no brief names a
 *  model" assertions. The adapter is never called by a pure brief test. */
const childModel = (model: string) => ({
  adapter: { protocol: "anthropic" } as unknown as ModelAdapter,
  binding: {
    protocol: "anthropic",
    endpoint: "https://api.anthropic.com",
    model,
    apiKey: "k",
  } as ModelBinding,
});

describe("panelReviewers (O1)", () => {
  it("gives DEFAULT_REVIEWER_COUNT reviewers on the parent when asked for none", () => {
    // The harness's own default, so the CLI and the tests get the shipped
    // panel without restating the host's store.
    for (const specs of [undefined, []]) {
      const reviewers = panelReviewers(specs);
      expect(reviewers).toHaveLength(DEFAULT_REVIEWER_COUNT);
      expect(reviewers.map((r) => r.name)).toEqual([
        "reviewer_a",
        "reviewer_b",
        "reviewer_c",
      ]);
      // No model ⇒ the child inherits the parent's (D3).
      expect(reviewers.every((r) => r.model === undefined)).toBe(true);
    }
  });

  it("names N reviewers in order, one per spec", () => {
    const reviewers = panelReviewers([{}, {}, {}, {}, {}]);
    expect(reviewers.map((r) => r.name)).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_c",
      "reviewer_d",
      "reviewer_e",
    ]);
  });

  it("keeps two reviewers on ONE model distinct — identity is the ordinal", () => {
    // The whole reason a reviewer is not named after its model: two seats may
    // share one, and `assembleReview` throws on a duplicate reviewer name
    // because concern ids are reviewer-prefixed.
    const shared = childModel("gpt-5.6-luna");
    const reviewers = panelReviewers([
      { model: shared },
      { model: shared },
      {},
    ]);
    expect(reviewers.map((r) => r.name)).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_c",
    ]);
    expect(new Set(reviewers.map((r) => r.name)).size).toBe(3);
    expect(reviewers[0]?.model).toBe(shared);
    expect(reviewers[1]?.model).toBe(shared);
  });

  it("clamps a request above the ceiling — an action can only ask for LESS", () => {
    // Invariant 5. The driver additionally SAYS so, through
    // `review.reviewers_clamped`; here the arithmetic is what is pinned.
    const reviewers = panelReviewers(Array.from({ length: 9 }, () => ({})));
    expect(reviewers).toHaveLength(MAX_FAN_OUT);
    expect(reviewers[MAX_FAN_OUT - 1]?.name).toBe("reviewer_h");
  });

  it("has exactly one name per possible reviewer", () => {
    expect(REVIEWER_NAMES).toHaveLength(MAX_FAN_OUT);
    expect(new Set(REVIEWER_NAMES).size).toBe(MAX_FAN_OUT);
  });
});

describe("reviewerBrief (O2)", () => {
  const ctx = {
    entry: "main.tex",
    files: ["main.tex", "sections/method.tex"],
    wrapping: "The source is hard-wrapped: quote ONE WHOLE LINE.",
  };
  const first = (): PanelReviewer =>
    panelReviewers(undefined)[0] as PanelReviewer;

  it("opens with the forced protocol load, so the child parses it as one", () => {
    expect(
      reviewerBrief(first(), 3, ctx).startsWith(`/skill:${PANEL_SKILL}\n`),
    ).toBe(true);
  });

  it("names the reviewer and how many reviewers there are", () => {
    const brief = reviewerBrief(first(), 3, ctx);
    expect(brief).toContain("`reviewer_a`, one of 3 independent reviewers");
    expect(reviewerBrief(first(), 5, ctx)).toContain(
      "one of 5 independent reviewers",
    );
  });

  it("asks all three R3 questions, and says every reviewer searches", () => {
    // A referee is asked all of them; the lens is where you look hardest, not
    // a fence. The questions are kept verbatim from R3's seat table because a
    // topic is something a model restates and a question is something it has
    // to answer.
    const brief = reviewerBrief(first(), 3, ctx);
    expect(brief).toContain(REVIEW_LENS);
    expect(REVIEW_LENS).toContain(
      "Do the methods actually support the claims? Are the statistics, the proofs, or the arguments sound as given? What is missing that the central case needs in order to hold?",
    );
    expect(REVIEW_LENS).toContain(
      "Does every claim the abstract and the conclusion make follow from what the manuscript shows? Look for over-claims, unsupported generalisations, and results the text describes but never gives.",
    );
    expect(REVIEW_LENS).toContain(
      "Is the contribution stated against the right prior work? Is anything claimed as new that the literature already has, and is the related-work framing fair to it?",
    );
    expect(REVIEW_LENS).toContain(
      "Searching the literature is expected of every reviewer, not optional.",
    );
    expect(brief).toContain("a lens is where you look hardest, not a fence");
  });

  it("lists the manuscript's files IN READING ORDER and asks for the file of every quote (X5 O10)", () => {
    const brief = reviewerBrief(first(), 3, {
      ...ctx,
      files: ["main.tex", "sections/intro.tex", "sections/method.tex"],
    });
    // The order is the paper's, and it is stated as such — "read main.tex in
    // full" was an instruction to read a preamble on a split project.
    expect(brief).toContain(
      "The manuscript is these files, in reading order: `main.tex`, `sections/intro.tex`, `sections/method.tex`",
    );
    expect(brief).toContain("the first file may hold little of the prose");
    expect(brief).toContain("Name the `file` each quote was copied from");
    // And the sentence it replaced is gone.
    expect(brief).not.toContain("The manuscript's main file is");
    expect(brief).not.toContain("only when its anchor is not in the main file");
  });

  it("names the entry, the files and the dimensions, as a seat's brief did", () => {
    const brief = reviewerBrief(first(), 3, ctx);
    expect(brief).toContain("`main.tex`");
    expect(brief).toContain("`sections/method.tex`");
    for (const d of PANEL_DIMENSIONS) expect(brief).toContain(d);
    expect(brief).toContain(ctx.wrapping);
    expect(brief).toContain("exactly one JSON ledger and nothing else");
  });

  it("offers `language` as a dimension, and says what it is for (ADR 0063)", () => {
    // The dimension is not decorative: the Review tab reads it to tell a
    // mechanical fix from a substantive concern, so a reviewer that is never
    // told to reach for it makes the whole copyedit group unreachable.
    expect([...PANEL_DIMENSIONS]).toEqual([
      "soundness",
      "claims",
      "clarity",
      "language",
      "positioning",
      // V2 (ADR 0078, D9): the list is the contract's now, and it is seven.
      "originality",
      "significance",
    ]);
    const brief = reviewerBrief(first(), 3, ctx);
    expect(brief).toContain("A pure language error");
    // The two halves the surface depends on: which dimension, and that a
    // `language` concern must carry the replacement text.
    expect(brief).toContain("`language`");
    expect(brief).toContain("must carry a `suggestion`");
    // And the boundary in the other direction — a substantive problem does not
    // become a copyedit just because the reviewer has wording ready for it.
    expect(brief).toContain("without reading the argument");
  });

  it("lists all seven dimensions and distinguishes the two V2 added (O14)", () => {
    const brief = reviewerBrief(first(), 3, ctx);
    for (const d of PANEL_DIMENSIONS) {
      expect(`${d} offered: ${brief.includes(d)}`).toBe(`${d} offered: true`);
    }
    // The distinction is the load-bearing half. A reviewer that cannot tell
    // *this already exists* from *I suspect it does* files both as the first,
    // and only one of those is a finding it can support.
    expect(brief).toContain(
      "Use `originality` only with a paper one of your own searches returned as its evidence",
    );
    expect(brief).toContain(
      "use `significance` for whether the contribution would matter if every claim held",
    );
  });

  it("tells a single-file manuscript never to name a file", () => {
    const brief = reviewerBrief(first(), 3, { ...ctx, files: ["main.tex"] });
    expect(brief).toContain("never name `file`");
    expect(brief).toContain("The manuscript is one file");
  });

  it("carries the user's focus verbatim, and marks it as emphasis", () => {
    const focus = "the statistics in §4 — 統計 checks";
    const brief = reviewerBrief(first(), 3, { ...ctx, focus });
    expect(brief).toContain(focus);
    expect(brief).toContain("not as a fence");
  });

  it("omits the focus block entirely when there is none", () => {
    expect(reviewerBrief(first(), 3, ctx)).not.toContain(
      "The author asked the panel",
    );
  });

  it("every reviewer's brief is identical except its name", () => {
    // R3's *three lenses, not three copies* INVERTED, and deliberately: under
    // one whole-review lens the reviewers differ only in which model reads,
    // which is what makes their agreement mean something. A brief that
    // differed anywhere else would be a lens split wearing an ordinal's name.
    const reviewers = panelReviewers([{}, {}, {}]);
    const briefs = reviewers.map((r) => reviewerBrief(r, 3, ctx));
    expect(new Set(briefs).size).toBe(3);
    for (const [i, brief] of briefs.entries()) {
      const name = reviewers[i]?.name as string;
      expect(brief.split(`\`${name}\``).join("`X`")).toBe(
        (briefs[0] as string).split("`reviewer_a`").join("`X`"),
      );
    }
  });

  it("names no model — its own or another's", () => {
    // A reviewer told it is *the haiku one* reviews differently; the record
    // (D4) is where the fact belongs, not the brief.
    const reviewers = panelReviewers([
      { model: childModel("gpt-5.6-luna") },
      { model: childModel("claude-haiku-4-5-20251001") },
    ]);
    for (const r of reviewers) {
      const brief = reviewerBrief(r, 2, ctx);
      expect(brief).not.toContain("gpt-5.6-luna");
      expect(brief).not.toContain("claude-haiku-4-5-20251001");
    }
  });
});

const annotation = (
  over: Partial<ReviewAnnotation> & { id: string; reviewer: string },
): ReviewAnnotation => ({
  dimension: "soundness",
  severity: "major",
  span: { file: "main.tex", line: 12 },
  message: "the estimator is not defined",
  ...over,
});

describe("synthesisBrief (O3)", () => {
  const annotations = [
    annotation({ id: "reviewer_a-1", reviewer: "reviewer_a", blocking: true }),
    annotation({
      id: "reviewer_b-1",
      reviewer: "reviewer_b",
      severity: "minor",
      span: { file: "sections/a.tex", line: 3 },
      message: "the abstract over-claims",
    }),
  ];

  it("says how many reviewers read the manuscript", () => {
    // R3 hardcoded "Three"; N is now the user's to set, and a cross-review
    // told the wrong number is reasoning about a panel that did not run.
    expect(synthesisBrief(annotations, 2)).toContain(
      "2 reviewers have each read the same manuscript without seeing one another",
    );
    expect(synthesisBrief(annotations, 7)).toContain(
      "7 reviewers have each read",
    );
  });

  it("hands over the located concerns by id, never a reviewer's raw report", () => {
    const brief = synthesisBrief(annotations, 2);
    expect(brief).toContain("reviewer_a-1");
    expect(brief).toContain("reviewer_b-1");
    expect(brief).toContain("main.tex:12");
    expect(brief).toContain("sections/a.tex:3");
    expect(brief).toContain('"blocking":true');
  });

  it("states the two-reviewer rule the interpreter enforces", () => {
    expect(synthesisBrief(annotations, 2)).toContain(
      "at least two ids from DIFFERENT reviewers",
    );
  });

  it("says both arrays may be empty — no quota here either", () => {
    expect(synthesisBrief(annotations, 2)).toContain(
      "Both arrays may be empty",
    );
  });

  it("carries the focus when there is one, and nothing when there is not", () => {
    expect(synthesisBrief(annotations, 2, "the statistics")).toContain(
      "the statistics",
    );
    expect(synthesisBrief(annotations, 2)).not.toContain("The author asked");
  });

  it("is blind to the models — D6, and it is what makes R5 measurable", () => {
    // A synthesis that knew two agreeing reviewers were the same model would
    // discount their agreement by intuition, which is R5's *hivemind*
    // measurement done badly and invisibly. That measurement is the harness's,
    // taken from the record D4 writes.
    const brief = synthesisBrief(annotations, 3);
    expect(brief).not.toContain("gpt-5.6-luna");
    expect(brief).not.toContain("claude-haiku");
    expect(brief).not.toMatch(/\bmodel\b/);
  });
});

describe("renderReviewForHistory (O18's renderer)", () => {
  const result: ReviewResult = {
    annotations: [
      annotation({ id: "soundness-1", reviewer: "soundness", blocking: true }),
      annotation({
        id: "claims-1",
        reviewer: "claims",
        severity: "minor",
        message: "the abstract over-claims",
      }),
    ],
    synthesis: {
      consensus: [
        { ids: ["soundness-1", "claims-1"], note: "both read §4 as thin" },
      ],
      disagreements: [],
    },
    limits: [
      { kind: "seat_missing", reviewer: "positioning", reason: "unparsed" },
      { kind: "synthesis_missing", reason: "insufficient_seats" },
    ],
  };

  it("keeps every concern's id, severity, position and message", () => {
    const text = renderReviewForHistory(result);
    expect(text).toContain(
      "soundness-1 · major · blocking · soundness · main.tex:12 — the estimator is not defined",
    );
    expect(text).toContain("claims-1 · minor · soundness · main.tex:12 —");
    expect(text).not.toContain("claims-1 · minor · blocking");
  });

  it("keeps the synthesis by id and every limit as one line", () => {
    const text = renderReviewForHistory(result);
    expect(text).toContain(
      "consensus (soundness-1, claims-1) — both read §4 as thin",
    );
    expect(text).toContain("limit: seat_missing — positioning");
    expect(text).toContain("limit: synthesis_missing");
  });

  it("renders an empty review honestly rather than as nothing", () => {
    expect(renderReviewForHistory({ annotations: [] })).toContain(
      "0 located concern(s)",
    );
  });

  describe("V1 (ADR 0076 §6–§7): what verification found reaches the history", () => {
    const verified: ReviewResult = {
      annotations: [
        annotation({
          id: "reviewer_a-1",
          reviewer: "reviewer_a",
          blocking: true,
          verification: {
            outcome: "refuted",
            kind: "absence",
            counter: { file: "sections/a.tex", line: 40 },
          },
        }),
        annotation({
          id: "reviewer_a-2",
          reviewer: "reviewer_a",
          blocking: true,
          verification: { outcome: "upheld", kind: "absence", central: false },
        }),
        annotation({
          id: "reviewer_b-1",
          reviewer: "reviewer_b",
          blocking: true,
          verification: { outcome: "upheld", kind: "absence", central: true },
        }),
      ],
    };

    it("counts what was withdrawn in the opening line — by exception", () => {
      expect(renderReviewForHistory(verified)).toContain(
        "3 located concern(s), 1 withdrawn by verification.",
      );
      // Nothing withdrawn: the opening line reads exactly as before V1.
      expect(renderReviewForHistory(result)).toContain("2 located concern(s).");
    });

    it("marks a withdrawn concern with the passage that answered it", () => {
      expect(renderReviewForHistory(verified)).toContain(
        "reviewer_a-1 · major · blocking · soundness · main.tex:12 · withdrawn by verification (answered at sections/a.tex:40) — the estimator is not defined",
      );
    });

    it("prints blocking only when isBlocking says the badge shows", () => {
      const text = renderReviewForHistory(verified);
      // central: false — the verifier answered that the paper survives it.
      expect(text).toContain("reviewer_a-2 · major · soundness ·");
      expect(text).not.toContain("reviewer_a-2 · major · blocking");
      expect(text).toContain("reviewer_b-1 · major · blocking ·");
    });

    it("names the verifier's model beside the cross-review's", () => {
      const seat = (reviewer: string, model: string) => ({
        reviewer,
        status: "completed" as const,
        model,
      });
      const text = renderReviewForHistory(
        verified,
        [seat("reviewer_a", "m-a"), seat("reviewer_b", "m-b")],
        seat("synthesis", "m-s"),
        seat("verifier", "m-v"),
      );
      expect(text).toContain(
        "reviewers: reviewer_a=m-a, reviewer_b=m-b; synthesis=m-s; verifier=m-v",
      );
    });

    it("renders verification_missing as one line, with its cause", () => {
      const text = renderReviewForHistory({
        annotations: [],
        limits: [
          {
            kind: "verification_missing",
            reason: "failed",
            cause: { class: "quota", message: "credit balance too low" },
          },
        ],
      });
      expect(text).toContain(
        "limit: verification_missing — concerns were not checked against the manuscript (failed) — quota: credit balance too low",
      );
    });
  });

  it("names the entries a seat's report lost to its shape (X5 D3)", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        {
          kind: "entries_rejected",
          reviewer: "reviewer_a",
          entries: [
            { index: 2, reason: '"message" must be a non-empty string' },
            { index: 7, reason: '"blocking" must be true or false' },
          ],
        },
      ],
    });
    expect(text).toContain("limit: entries_rejected — 2 entry(ies) of");
    expect(text).toContain("reviewer_a");
  });

  it("names a seat's lost strengths by count, and renders no strength or impression (V5 O5)", () => {
    const text = renderReviewForHistory({
      annotations: [],
      strengths: [
        {
          id: "reviewer_b-s1",
          reviewer: "reviewer_b",
          dimension: "clarity",
          span: { file: "main.tex", line: 3 },
          message: "the method is laid out before it is used",
        },
      ],
      assessments: [
        { reviewer: "reviewer_b", dimension: "clarity", impression: 7 },
      ],
      limits: [
        {
          kind: "strengths_lost",
          reviewer: "reviewer_b",
          dropped: [
            {
              anchor: "a",
              file: "main.tex",
              role: "claim",
              reason: "not_found",
            },
          ],
          rejected: [{ index: 3, reason: "r" }],
        },
      ],
    });
    expect(text).toContain(
      "limit: strengths_lost — reviewer_b: 2 strength(s) not recorded",
    );
    // Strengths and impressions are not compaction material.
    expect(text).not.toContain("laid out before it is used");
    expect(text).not.toContain("impression");
  });

  it("tells the model WHY a seat died, not merely that it did (X5 D10)", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        {
          kind: "seat_missing",
          reviewer: "reviewer_b",
          reason: "failed",
          cause: {
            class: "quota",
            message: "Your credit balance is too low to access the API",
          },
        },
        {
          kind: "synthesis_missing",
          reason: "failed",
          cause: { class: "retryable", message: "socket hang up" },
        },
      ],
    });
    expect(text).toContain(
      "seat_missing — reviewer_b reported nothing usable (failed) — quota: Your credit balance is too low to access the API",
    );
    expect(text).toContain(
      "synthesis_missing — no synthesis (failed) — retryable: socket hang up",
    );
  });

  it("says nothing extra when a failed seat carried no cause", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        { kind: "seat_missing", reviewer: "reviewer_c", reason: "interrupted" },
      ],
    });
    expect(text).toContain(
      "seat_missing — reviewer_c reported nothing usable (interrupted)",
    );
    expect(text).not.toContain(" — quota:");
    expect(text).not.toContain(" — fatal:");
  });

  it("tells the model an unavailable source ran without a key (R4)", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        {
          kind: "source_unavailable",
          reviewer: "positioning",
          source: "semantic_scholar",
          status: "rate_limited",
          anonymous: true,
        },
        {
          kind: "source_unavailable",
          reviewer: "positioning",
          source: "dblp",
          status: "timeout",
        },
      ],
    });
    expect(text).toContain(
      "limit: source_unavailable — semantic_scholar did not answer positioning (rate_limited) (anonymous — an API key raises the limit)",
    );
    // A keyed source that failed anyway earns no pointer.
    expect(text).toContain(
      "limit: source_unavailable — dblp did not answer positioning (timeout)",
    );
    expect(text).not.toContain("dblp did not answer positioning (timeout) (");
  });
});

/**
 * V2 (ADR 0078 §3, O8): what a seat's own searches returned, read out of its
 * transient transcript.
 *
 * Deliberately forgiving, because a transcript is evidence and not a contract:
 * a failed call has no results, an unparseable row is skipped rather than
 * thrown on, and a row with no `results` key contributes nothing. A driver
 * that cannot read ONE search must still validate against the rest.
 */
describe("literatureResultsOf (V2, ADR 0078 §3, O8)", () => {
  const search = (
    over: Partial<{
      status: "completed" | "failed";
      resultJson: string | undefined;
    }> = {},
  ): SessionItem => ({
    id: `t${Math.random()}`,
    type: "tool_call",
    tool: "literature_search",
    argsJson: '{"query":"stochastic optimization"}',
    status: over.status ?? "completed",
    ...(over.resultJson !== undefined ? { resultJson: over.resultJson } : {}),
  });

  const report = (titles: string[], withheld?: number) =>
    JSON.stringify({
      sources: [{ name: "arxiv", endpoint: "e", status: "ok" }],
      ...(withheld !== undefined ? { withheld: { ownTitle: withheld } } : {}),
      results: titles.map((title) => ({
        title,
        authors: [],
        source: "arxiv",
      })),
    });

  it("returns results in CALL order, across calls", () => {
    const out = literatureResultsOf([
      search({ resultJson: report(["first", "second"]) }),
      search({ resultJson: report(["third"]) }),
    ]);
    expect(out.results.map((r) => r.title)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(out.ownTitleWithheld).toBe(0);
  });

  it("skips a failed call, an unparseable row and a row with no results", () => {
    const out = literatureResultsOf([
      search({
        status: "failed",
        resultJson: '{"error":{"code":"too_large"}}',
      }),
      search({ resultJson: "{ not json at all" }),
      search({ resultJson: undefined }),
      search({ resultJson: JSON.stringify({ sources: [] }) }),
      search({ resultJson: report(["the one that survived"]) }),
    ]);
    expect(out.results.map((r) => r.title)).toEqual(["the one that survived"]);
  });

  it("sums what was withheld, over every search", () => {
    const out = literatureResultsOf([
      search({ resultJson: report(["a"], 1) }),
      search({ resultJson: report(["b"]) }),
      search({ resultJson: report(["c"], 2) }),
    ]);
    expect(out.ownTitleWithheld).toBe(3);
  });

  it("ignores tool calls that are not literature searches", () => {
    const out = literatureResultsOf([
      {
        id: "x",
        type: "tool_call",
        tool: "read_span",
        argsJson: "{}",
        status: "completed",
        resultJson: report(["not a search result"]),
      },
      { id: "m", type: "agent_message", text: "hello" },
    ]);
    expect(out.results).toEqual([]);
  });

  it("the compaction history names the new limit (O19)", () => {
    // A handoff that omitted it would present a review whose searches could
    // have returned the paper itself as one that could not.
    const rendered = renderReviewForHistory({
      annotations: [],
      limits: [{ kind: "own_title_unguarded", reason: "no_title" }],
    });
    expect(rendered).toContain("own_title_unguarded");
    expect(rendered).toContain("no_title");
  });

  it("observeSeat carries both, beside what it already read", () => {
    const obs = observeSeat([
      search({ resultJson: report(["what the seat was shown"], 2) }),
      { id: "m", type: "agent_message", text: "the report" },
    ]);
    expect(obs.searchResults.map((r) => r.title)).toEqual([
      "what the seat was shown",
    ]);
    expect(obs.ownTitleWithheld).toBe(2);
    expect(obs.report).toBe("the report");
  });
});

describe("renderReviewForHistory — the PDF reviewer (V4, O9)", () => {
  const pdfSeat = {
    reviewer: "pdf_reviewer",
    status: "completed" as const,
    model: "model-p",
  };
  const pdfConcern = annotation({
    id: "pdf_reviewer-1",
    reviewer: "pdf_reviewer",
    dimension: "presentation",
  });

  it("renders the three limits, one line each", () => {
    const text = renderReviewForHistory({
      annotations: [],
      limits: [
        { kind: "pdf_unavailable", reason: "stale" },
        { kind: "visual_unavailable", reason: "no_renderer" },
        { kind: "pages_unviewed", viewed: 2, total: 3 },
      ],
    });
    expect(text).toContain(
      "limit: pdf_unavailable — the compiled PDF was not reviewed (stale)",
    );
    expect(text).toContain(
      "limit: visual_unavailable — the compiled PDF was not reviewed (no_renderer)",
    );
    expect(text).toContain(
      "limit: pages_unviewed — the PDF reviewer viewed 2 of 3 pages",
    );
  });

  it("names the count a panel set aside, so the kept concerns are not read as all of them (ADR 0083 §2, O36)", () => {
    const text = renderReviewForHistory({
      annotations: [pdfConcern],
      limits: [
        {
          kind: "concerns_set_aside",
          reviewer: "pdf_reviewer",
          entries: [
            // ADR 0086: what it said is kept for the reader — and never
            // reaches the history line, which carries the count.
            {
              dimension: "soundness",
              concern: {
                severity: "major",
                message: "SET-ASIDE PROSE",
                span: { file: "main.tex", line: 4 },
              },
            },
            { dimension: "claims" },
          ],
        },
      ],
    });
    expect(text).not.toContain("SET-ASIDE PROSE");
    expect(text).toContain(
      "limit: concerns_set_aside — 2 concern(s) of pdf_reviewer outside presentation cited no page and were set aside; the text reviewers review the argument",
    );
  });

  it("names each page cite the harness moved, so a later turn knows who placed it (ADR 0084, O39)", () => {
    const text = renderReviewForHistory({
      annotations: [pdfConcern],
      limits: [
        {
          kind: "pages_corrected",
          reviewer: "pdf_reviewer",
          entries: [{ id: "pdf_reviewer-1", cited: 6, page: 7 }],
        },
      ],
    });
    expect(text).toContain(
      "limit: pages_corrected — 1 page citation(s) of pdf_reviewer named a page other than the one the anchored figure or table sits on, and were moved to it (pdf_reviewer-1: 6 → 7)",
    );
  });

  it("names the seat's model beside the panel's, and a PDF-only review's alone", () => {
    const seats = [
      { reviewer: "reviewer_a", status: "completed" as const, model: "m" },
    ];
    expect(
      renderReviewForHistory(
        { annotations: [pdfConcern] },
        seats,
        undefined,
        undefined,
        pdfSeat,
      ),
    ).toContain("; pdf_reviewer=model-p");
    expect(
      renderReviewForHistory(
        { annotations: [pdfConcern] },
        [],
        undefined,
        undefined,
        pdfSeat,
      ),
    ).toContain("reviewers: pdf_reviewer=model-p");
    // A PDF-only review is not called a panel; a panel with the seat still is.
    expect(
      renderReviewForHistory(
        { annotations: [pdfConcern] },
        [],
        undefined,
        undefined,
        pdfSeat,
      ).startsWith("PDF review result — 1 located concern(s)."),
    ).toBe(true);
    expect(
      renderReviewForHistory(
        { annotations: [pdfConcern] },
        seats,
        undefined,
        undefined,
        pdfSeat,
      ).startsWith("Review panel result"),
    ).toBe(true);
  });

  it("says the seat's concerns were not checked, only when it has one", () => {
    const sentence =
      "pdf_reviewer's concerns are about the rendered page of the compiled PDF and were not checked by the verifier.";
    expect(
      renderReviewForHistory(
        { annotations: [pdfConcern] },
        [],
        undefined,
        undefined,
        pdfSeat,
      ),
    ).toContain(sentence);
    expect(
      renderReviewForHistory(
        { annotations: [] },
        [],
        undefined,
        undefined,
        pdfSeat,
      ),
    ).not.toContain(sentence);
  });
});
