/**
 * O67–O70: the workspace's review history, persisted (ADR 0065 §1).
 *
 * The operator's report was that starting a new chat emptied the Review tab
 * and restarted the version sequence at v1. The fix has two halves: the
 * extension stopped clearing on a session boundary (asserted in the ext-host
 * suite, where session boundaries exist), and the history became a thing that
 * outlives the window at all — which is this file.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ReviewResult,
  ReviewSeatState,
} from "../../src/contracts/index.js";
import {
  MAX_STORED_REVIEWS,
  ReviewStore,
  type StoredReview,
  nextPanelVersion,
} from "../../src/session/review-store.js";

const result: ReviewResult = {
  annotations: [
    {
      id: "soundness-1",
      reviewer: "soundness",
      dimension: "soundness",
      severity: "major",
      span: { file: "main.tex", line: 4 },
      message: "the exclusion restriction is never argued",
    },
  ],
};

const review = (over: Partial<StoredReview> = {}): StoredReview => ({
  mode: "panel",
  result,
  root: "/p",
  entry: "main.tex",
  file: "/p/main.tex",
  at: 1_756_000_000_000,
  version: 1,
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lemmaria-reviews-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the review store (O67)", () => {
  it("round-trips a review, so the next window opens on it", () => {
    const store = new ReviewStore(dir);
    return store.save([review()]).then(async () => {
      const back = await new ReviewStore(dir).load();
      expect(back).toEqual([review()]);
    });
  });

  it("answers an empty history for a workspace that has never been reviewed", async () => {
    expect(await new ReviewStore(dir).load()).toEqual([]);
  });

  it("answers empty rather than throwing on a corrupt or unknown file", async () => {
    // A review is cheap to re-run and there is no backward-compatibility
    // burden, so an unreadable history is dropped, never migrated — and never
    // allowed to take activation down with it.
    await new ReviewStore(dir).save([review()]);
    await writeFile(join(dir, "reviews.json"), "{ not json", "utf8");
    expect(await new ReviewStore(dir).load()).toEqual([]);
    await writeFile(join(dir, "reviews.json"), '{"v":99,"reviews":[]}', "utf8");
    expect(await new ReviewStore(dir).load()).toEqual([]);
  });

  it("writes through a temp file, leaving no partial history behind", async () => {
    const store = new ReviewStore(dir);
    await store.save([review()]);
    await store.save([review(), review({ version: 2 })]);
    // The rename target is the only file that survives a save.
    const raw = JSON.parse(await readFile(join(dir, "reviews.json"), "utf8"));
    expect(raw.reviews).toHaveLength(2);
  });
});

describe("the cross-review survives the store (X5 O13)", () => {
  /** The fourth child's row, in the same shape as a reviewer's. */
  const synthesisSeat: ReviewSeatState = {
    reviewer: "synthesis",
    status: "completed",
    model: "claude-opus-4-1",
    usage: { inputTokens: 900, outputTokens: 300 },
  };

  it("round-trips `synthesisSeat` beside the seats", async () => {
    // It has ridden the live item since R9 and was dropped here, so a
    // reloaded review could not say which model read ACROSS the others, or
    // what that reading cost — the one child whose whole job is reading the
    // panel was the one the record could not price.
    const stored = review({
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
      synthesisSeat,
    });
    await new ReviewStore(dir).save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
  });

  it("loads a review that has none, exactly as before", async () => {
    // Every X5 field is additive and optional, which is what lets a review
    // written by the published 0.3.0 replay unchanged — no `v` bump, no
    // migration, no legacy branch.
    const old = review({
      seats: [{ reviewer: "reviewer_a", status: "failed" }],
    });
    await new ReviewStore(dir).save([old]);
    const back = await new ReviewStore(dir).load();
    expect(back).toEqual([old]);
    expect(Object.hasOwn(back[0] ?? {}, "synthesisSeat")).toBe(false);
  });

  it("carries the unpriced mark and the tally through a save", async () => {
    // `unpriced` is what makes a stored `costUsd` readable as the lower bound
    // it is, and `ledger` is what makes "before and after the re-ask" legible
    // off one run. Both are worthless if they do not survive the reload.
    const stored = review({
      seats: [
        {
          reviewer: "reviewer_a",
          status: "completed",
          model: "local-8b",
          usage: { inputTokens: 10, outputTokens: 5 },
          unpriced: true,
          retried: true,
          ledger: {
            entries: 3,
            located: 2,
            relocated: 1,
            dropped: 0,
            rejected: 1,
            firstPass: {
              entries: 3,
              located: 1,
              relocated: 0,
              dropped: 1,
              rejected: 1,
            },
          },
        },
      ],
      synthesisSeat: { ...synthesisSeat, unpriced: true },
    });
    await new ReviewStore(dir).save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
  });
});

describe("the verifier survives the store (V1 O13)", () => {
  it("round-trips `verifierSeat` and a withdrawn concern, still withdrawn", async () => {
    // Verification is part of the RESULT, not triage (ADR 0065 §1): a
    // reloaded review keeps its withdrawn fold because the concern still
    // carries the passage that answered it.
    const stored = review({
      result: {
        annotations: [
          {
            ...(result.annotations[0] as ReviewResult["annotations"][number]),
            verification: {
              outcome: "refuted",
              kind: "absence",
              counter: { file: "main.tex", line: 40 },
              note: "Section 5 carries it.",
            },
          },
        ],
        limits: [{ kind: "verification_missing", reason: "incomplete" }],
      },
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
      verifierSeat: {
        reviewer: "verifier",
        status: "completed",
        model: "claude-opus-4-1",
        usage: { inputTokens: 400, outputTokens: 80 },
        verification: {
          concerns: 2,
          upheld: 0,
          refuted: 1,
          unverifiable: 0,
          downgraded: 0,
          unanswered: 1,
        },
      },
    });
    await new ReviewStore(dir).save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
  });

  it("loads a review stored before V1 unchanged — no verifier, no key", async () => {
    const old = review({
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
    });
    await new ReviewStore(dir).save([old]);
    const back = await new ReviewStore(dir).load();
    expect(back).toEqual([old]);
    expect(Object.hasOwn(back[0] ?? {}, "verifierSeat")).toBe(false);
  });
});

describe("the history is bounded, and the sequence is not (O68)", () => {
  it("keeps the newest and drops the oldest past the cap", async () => {
    const many = Array.from({ length: MAX_STORED_REVIEWS + 5 }, (_, i) =>
      review({ version: i + 1 }),
    );
    const store = new ReviewStore(dir);
    await store.save(many);
    const back = await store.load();
    expect(back).toHaveLength(MAX_STORED_REVIEWS);
    // The five that fell off are the FIRST five, not the last.
    expect(back[0]?.version).toBe(6);
    expect(back.at(-1)?.version).toBe(MAX_STORED_REVIEWS + 5);
  });

  it("numbers the next panel past the highest RETAINED version", () => {
    // The trim must never renumber: the newest is never dropped, so counting
    // over what is retained stays monotonic across one. A counter in the file
    // would be a second home for a fact the reviews already carry.
    expect(nextPanelVersion([])).toBe(1);
    expect(nextPanelVersion([review({ version: 7 })])).toBe(8);
    expect(
      nextPanelVersion([review({ version: 40 }), review({ version: 41 })]),
    ).toBe(42);
  });

  it("ignores an unnumbered quick review when numbering the next panel", () => {
    // A quick review reads one unit of one file, so it is not part of the
    // manuscript's version sequence — it is still in the history, and still in
    // the picker, named by its file and its time.
    const quick = review({ mode: "quick", version: undefined });
    expect(nextPanelVersion([quick])).toBe(1);
    expect(nextPanelVersion([review({ version: 3 }), quick])).toBe(4);
  });
});

/**
 * V2 (ADR 0078, D1): `ReviewEvidence` is re-tagged, which is a change to the
 * SHAPE of a persisted review — so the store's own written rule fires and `v`
 * becomes 2.
 *
 * There is no reader for the old shape and no migration: the operator's
 * 2026-09-20 direction re-affirmed the *no backward-compatibility burden*
 * Convention, and a shim is exactly what it forbids. The Review tab's history
 * therefore starts empty once, which is a recorded deliberate limit.
 */
describe("the evidence re-tag starts the store over (V2 O18)", () => {
  const paperReview = (): StoredReview =>
    review({
      result: {
        annotations: [
          {
            id: "reviewer_a-1",
            reviewer: "reviewer_a",
            dimension: "originality",
            severity: "major",
            span: { file: "main.tex", line: 9 },
            message: "the optimizer is not new",
            evidence: {
              kind: "paper",
              title: "Adam: A Method for Stochastic Optimization",
              authors: ["Diederik P. Kingma", "Jimmy Ba"],
              year: "2015",
              source: "arxiv",
              url: "https://arxiv.org/abs/1412.6980",
            },
          },
          {
            id: "reviewer_a-2",
            reviewer: "reviewer_a",
            dimension: "soundness",
            severity: "minor",
            span: { file: "main.tex", line: 20 },
            message: "no variance is reported",
            evidence: { kind: "missing" },
          },
        ],
      },
    });

  it("writes `v: 2`", async () => {
    await new ReviewStore(dir).save([paperReview()]);
    const raw = JSON.parse(await readFile(join(dir, "reviews.json"), "utf8"));
    expect(raw.v).toBe(2);
  });

  it("reads a `v: 1` file as empty — no migration, no shim", async () => {
    // A real pre-V2 file: valid JSON, the old untagged evidence, the old tag.
    await writeFile(
      join(dir, "reviews.json"),
      JSON.stringify({
        v: 1,
        reviews: [
          {
            ...review(),
            result: {
              annotations: [
                {
                  id: "reviewer_a-1",
                  reviewer: "reviewer_a",
                  dimension: "soundness",
                  severity: "major",
                  span: { file: "main.tex", line: 4 },
                  message: "…",
                  evidence: { file: "main.tex", line: 6 },
                },
              ],
            },
          },
        ],
      }),
      "utf8",
    );
    expect(await new ReviewStore(dir).load()).toEqual([]);
  });

  it("round-trips a paper evidence and a missing one", async () => {
    await new ReviewStore(dir).save([paperReview()]);
    expect(await new ReviewStore(dir).load()).toEqual([paperReview()]);
  });
});

describe("the PDF reviewer survives the store (V4 O13)", () => {
  const pdfSeat: ReviewSeatState = {
    reviewer: "pdf_reviewer",
    status: "completed",
    model: "gpt-5-mini",
    usage: { inputTokens: 900, outputTokens: 120 },
  };
  const pdf: StoredReview["pdf"] = {
    source: "beside_entry",
    path: "main.pdf",
    stale: true,
    facts: {
      pages: 3,
      pageSize: { width: 595.3, height: 841.9, name: "a4" },
      referencesStart: 3,
      mainTextPages: 2,
      author: "A. Fixture",
      overfull: { hboxes: 1, vboxes: 0 },
      smallestText: [{ page: 1, sizePt: 5 }],
    },
    viewed: [1, 2],
  };
  const pageConcern: ReviewResult = {
    annotations: [
      {
        id: "pdf_reviewer-1",
        reviewer: "pdf_reviewer",
        dimension: "presentation",
        severity: "minor",
        span: { file: "main.tex", line: 9 },
        message: "the table runs into the margin",
        evidence: { kind: "page", page: 1 },
      },
    ],
    limits: [{ kind: "pages_unviewed", viewed: 2, total: 3 }],
  };

  it("round-trips a panel with the PDF reviewer beside its seats", async () => {
    const stored = review({
      result: pageConcern,
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
      pdfSeat,
      pdf,
    });
    await new ReviewStore(dir).save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
  });

  it("round-trips a review of the PDF alone under the same `v: 2`", async () => {
    const stored = review({ mode: "pdf", result: pageConcern, pdfSeat, pdf });
    const store = new ReviewStore(dir);
    await store.save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
    const file = (await readFile(join(dir, "reviews.json"), "utf8")).trim();
    expect(JSON.parse(file)).toMatchObject({ v: 2 });
  });

  it("loads a panel stored before V4 unchanged — no PDF keys", async () => {
    const old = review({
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
    });
    await new ReviewStore(dir).save([old]);
    const back = await new ReviewStore(dir).load();
    expect(back).toEqual([old]);
    expect(Object.hasOwn(back[0] ?? {}, "pdfSeat")).toBe(false);
    expect(Object.hasOwn(back[0] ?? {}, "pdf")).toBe(false);
  });
});

describe("the scorecard's inputs survive the store (V5, O12)", () => {
  it("round-trips strengths, assessments and a seat's searches under v: 2", async () => {
    const stored = review({
      result: {
        ...result,
        strengths: [
          {
            id: "reviewer_a-s1",
            reviewer: "reviewer_a",
            dimension: "clarity",
            span: { file: "main.tex", line: 3 },
            message: "laid out before it is used",
          },
        ],
        assessments: [
          { reviewer: "reviewer_a", dimension: "clarity", impression: 7 },
          {
            reviewer: "reviewer_a",
            dimension: "positioning",
            impression: null,
            notAssessed: "no source answered",
          },
        ],
        limits: [
          {
            kind: "strengths_lost",
            reviewer: "reviewer_a",
            dropped: [],
            rejected: [{ index: 2, reason: "r" }],
          },
        ],
      },
      seats: [
        {
          reviewer: "reviewer_a",
          status: "completed",
          model: "m",
          searches: { attempted: 2, answered: 0 },
          ledger: {
            entries: 1,
            located: 1,
            relocated: 0,
            dropped: 0,
            rejected: 0,
            strengths: {
              entries: 2,
              located: 1,
              relocated: 0,
              dropped: 0,
              rejected: 1,
            },
          },
        },
      ],
    });
    await new ReviewStore(dir).save([stored]);
    expect(await new ReviewStore(dir).load()).toEqual([stored]);
    const raw = JSON.parse(await readFile(join(dir, "reviews.json"), "utf8"));
    expect(raw.v).toBe(2);
  });

  it("loads a panel stored before V5, with no strengths, assessments or searches", async () => {
    const old = review({
      seats: [{ reviewer: "reviewer_a", status: "completed", model: "m" }],
    });
    await new ReviewStore(dir).save([old]);
    const back = await new ReviewStore(dir).load();
    expect(back).toEqual([old]);
    expect(Object.hasOwn(back[0]?.result ?? {}, "strengths")).toBe(false);
    expect(back[0]?.seats?.[0]?.searches).toBeUndefined();
  });
});
