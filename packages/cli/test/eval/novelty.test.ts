/**
 * V2 (O26): the novelty probe's instrument.
 *
 * Like `recall.test.ts`, the items here are hand-built rather than driven
 * through a panel: what is under test is arithmetic over the record, and the
 * seam that produces the record is asserted by the driver suites.
 *
 * The case that matters most is the last one. `measured: false` and
 * `citingKnown: 0` are different facts, and an instrument that printed them
 * alike would put a floor in a durable record that no reviewer earned.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReviewAnnotation,
  ReviewItem,
  ReviewLimit,
  ReviewSeatState,
} from "@lemmaria/harness";
import { afterEach, describe, expect, it } from "vitest";
import {
  type NoveltyProbe,
  formatNoveltyReport,
  measureNovelty,
  readProbe,
} from "../../src/eval/novelty.js";

const KNOWN = "Adam: A Method for Stochastic Optimization";

const PROBE: NoveltyProbe = {
  fixture: "novelty-probe",
  file: "main.tex",
  known: { title: KNOWN, arxiv: "1412.6980" },
  claims: [{ anchor: "we introduce this combination", line: 42 }],
};

// ── builders ────────────────────────────────────────────────────────────────

function seat(
  reviewer: string,
  extra: Partial<ReviewSeatState> = {},
): ReviewSeatState {
  return {
    reviewer,
    status: "completed",
    model: "stub-model",
    ledger: { entries: 1, located: 1, relocated: 0, dropped: 0, rejected: 0 },
    ...extra,
  };
}

function paperConcern(
  id: string,
  reviewer: string,
  title: string,
  dimension = "originality",
): ReviewAnnotation {
  return {
    id,
    reviewer,
    dimension,
    severity: "major",
    span: { file: "main.tex", line: 42 },
    message: "this combination is not new",
    evidence: {
      kind: "paper",
      title,
      authors: ["Kingma", "Ba"],
      year: "2015",
      source: "arxiv",
    },
  } as ReviewAnnotation;
}

function item(
  seats: ReviewSeatState[],
  annotations: ReviewAnnotation[],
  limits?: ReviewLimit[],
): ReviewItem {
  return {
    id: "review-1",
    type: "review",
    status: "completed",
    skill: "blind-reviewer",
    seats,
    result: {
      annotations,
      ...(limits !== undefined && limits.length > 0 ? { limits } : {}),
    },
  } as ReviewItem;
}

/** Every source down, for one reviewer — the shape `source_unavailable` takes. */
function allSourcesDown(reviewer: string): ReviewLimit[] {
  return (["crossref", "dblp", "semantic_scholar", "arxiv"] as const).map(
    (source) =>
      ({
        kind: "source_unavailable",
        reviewer,
        source,
        status: "rate_limited",
      }) as ReviewLimit,
  );
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

// ── the instrument ──────────────────────────────────────────────────────────

describe("V2 O26 — citing the known work is read from the record", () => {
  it("matches the known title by `sameTitle`, not by string equality", () => {
    // The index returns a title with its own casing and spacing, and a model
    // copies it as it was shown. `sameTitle` is what makes "copied exactly"
    // a checkable instruction rather than a brittle one.
    const report = measureNovelty(
      item(
        [seat("reviewer_a")],
        [
          paperConcern(
            "a-1",
            "reviewer_a",
            "ADAM:  a method for  stochastic optimization",
          ),
        ],
      ),
      PROBE,
    );
    expect(report.reviewers[0]?.citedKnown).toBe(true);
    expect(report.citingKnown).toBe(1);
  });

  it("does not credit a DIFFERENT paper, however close its subject", () => {
    const report = measureNovelty(
      item(
        [seat("reviewer_a")],
        [
          paperConcern(
            "a-1",
            "reviewer_a",
            "Adaptive Subgradient Methods for Online Learning",
          ),
        ],
      ),
      PROBE,
    );
    expect(report.reviewers[0]).toMatchObject({
      paperEvidence: 1,
      citedKnown: false,
      citedUnder: [],
    });
    expect(report.citingKnown).toBe(0);
  });

  it("tallies per reviewer, and names the dimensions it was cited under", () => {
    const report = measureNovelty(
      item(
        [seat("reviewer_a"), seat("reviewer_b"), seat("reviewer_c")],
        [
          paperConcern("a-1", "reviewer_a", KNOWN),
          paperConcern("a-2", "reviewer_a", KNOWN, "positioning"),
          // Same dimension twice: `citedUnder` is a set in first-seen order,
          // because "cited it under originality" is one fact however many
          // concerns carry it.
          paperConcern("a-3", "reviewer_a", KNOWN),
          paperConcern("b-1", "reviewer_b", "Some Other Paper"),
          // reviewer_c cites nothing at all.
        ],
      ),
      PROBE,
    );
    expect(report.reviewers).toEqual([
      {
        reviewer: "reviewer_a",
        paperEvidence: 3,
        citedKnown: true,
        citedUnder: ["originality", "positioning"],
        notInResults: 0,
        ownTitleWithheld: 0,
      },
      {
        reviewer: "reviewer_b",
        paperEvidence: 1,
        citedKnown: false,
        citedUnder: [],
        notInResults: 0,
        ownTitleWithheld: 0,
      },
      {
        reviewer: "reviewer_c",
        paperEvidence: 0,
        citedKnown: false,
        citedUnder: [],
        notInResults: 0,
        ownTitleWithheld: 0,
      },
    ]);
    expect(report.citingKnown).toBe(1);
  });

  it("reads `notInResults` and `ownTitleWithheld` off the record, per seat", () => {
    const report = measureNovelty(
      item(
        [seat("reviewer_a", { ownTitleWithheld: 2 }), seat("reviewer_b")],
        [],
        [
          {
            kind: "anchors_dropped",
            reviewer: "reviewer_a",
            anchors: [
              { anchor: "A Paper Nobody Returned", reason: "not_in_results" },
              { anchor: "Another One", reason: "not_in_results" },
              // A manuscript anchor that simply was not found is a different
              // failure and must not inflate the probe's number.
              { anchor: "some prose", reason: "not_found", file: "main.tex" },
            ],
          } as ReviewLimit,
        ],
      ),
      PROBE,
    );
    expect(report.reviewers[0]).toMatchObject({
      notInResults: 2,
      ownTitleWithheld: 2,
    });
    // Another seat's limits are not this seat's.
    expect(report.reviewers[1]).toMatchObject({
      notInResults: 0,
      ownTitleWithheld: 0,
    });
  });

  it("counts the SEATS, never the synthesis or the verifier", () => {
    const report = measureNovelty(
      {
        ...item(
          [seat("reviewer_a")],
          [paperConcern("a-1", "reviewer_a", KNOWN)],
        ),
        synthesisSeat: seat("synthesis"),
        verifierSeat: seat("verifier"),
      } as ReviewItem,
      PROBE,
    );
    // `found 1/1`, not `1/3`: those two children read across the panel rather
    // than the literature, so counting them would deflate every probe.
    expect(report.reviewers.map((r) => r.reviewer)).toEqual(["reviewer_a"]);
  });
});

describe("V2 O26 — not measured is not zero", () => {
  it("is not measured when NO seat produced a readable ledger", () => {
    const report = measureNovelty(
      item(
        [
          seat("reviewer_a", { ledger: undefined, status: "failed" }),
          seat("reviewer_b", { ledger: undefined, status: "interrupted" }),
        ],
        [],
      ),
      PROBE,
    );
    expect(report.measured).toBe(false);
    expect(report.citingKnown).toBe(0);
  });

  it("is not measured when every source every readable seat asked failed", () => {
    const report = measureNovelty(
      item(
        [seat("reviewer_a"), seat("reviewer_b")],
        [],
        [...allSourcesDown("reviewer_a"), ...allSourcesDown("reviewer_b")],
      ),
      PROBE,
    );
    expect(report.measured).toBe(false);
  });

  it("IS measured when one seat still had a source that answered", () => {
    // One seat blind and one seat served is a thin panel, not an unmeasured
    // one: the served seat had its chance to find the known work.
    const report = measureNovelty(
      item(
        [seat("reviewer_a"), seat("reviewer_b")],
        [],
        allSourcesDown("reviewer_a"),
      ),
      PROBE,
    );
    expect(report.measured).toBe(true);
  });

  it("leaves a dead seat OUT of the denominator, and names it", () => {
    // The code review's I2. The denominator of `found/asked` is the seats that
    // could answer; a panel with one dead seat and two that looked and missed
    // is `found 0/2`, not `found 0/3`. Reporting the third as a seat that
    // missed is a fabricated zero of exactly the kind ADR 0070 5 forbids, and
    // shrinking the denominator without saying so is its own dishonesty --
    // hence `unreadable`.
    //
    // Nothing caught this before: `novelty.test.ts` tested an all-dead panel
    // and an all-live one, and never a MIXED one.
    const report = measureNovelty(
      item(
        [
          seat("reviewer_a"),
          seat("reviewer_b"),
          seat("reviewer_c", { ledger: undefined, status: "failed" }),
        ],
        [],
      ),
      PROBE,
    );
    expect(report.reviewers.map((r) => r.reviewer)).toEqual([
      "reviewer_a",
      "reviewer_b",
    ]);
    expect(report.unreadable).toEqual(["reviewer_c"]);
    expect(report.measured).toBe(true);
    expect(formatNoveltyReport(report, PROBE)).toContain("found 0/2");
    expect(formatNoveltyReport(report, PROBE)).toContain(
      "reviewer_c produced no readable ledger",
    );
  });

  it("carries no `unreadable` key when every seat could answer", () => {
    // Absent stays absent, the contract's own rule.
    const report = measureNovelty(item([seat("reviewer_a")], []), PROBE);
    expect(report.unreadable).toBeUndefined();
    expect(formatNoveltyReport(report, PROBE)).not.toContain(
      "no readable ledger",
    );
  });

  it("is measured, and zero, when the sources answered and nobody cited it", () => {
    // The case the gate explicitly refuses to treat as a failure — and the one
    // that must never be confused with the two above.
    const report = measureNovelty(item([seat("reviewer_a")], []), PROBE);
    expect(report).toMatchObject({ measured: true, citingKnown: 0 });
  });
});

describe("V2 O26 — the report says found/asked, and no banned word", () => {
  // The v0.3 stage gate's own regex, over this instrument's output. The
  // instrument is a measurement, so it is the one place a word like that
  // would look harmless and still teach a reader the wrong frame.
  const BANNED =
    /\b(score|scores|scored|scoring|rating|ratings|verdict|verdicts)\b/i;

  it("prints a fraction rather than a bare percentage", () => {
    const report = measureNovelty(
      item(
        [seat("reviewer_a", { ownTitleWithheld: 1 }), seat("reviewer_b")],
        [paperConcern("a-1", "reviewer_a", KNOWN)],
      ),
      PROBE,
    );
    const text = formatNoveltyReport(report, PROBE);
    expect(text).toContain("found 1/2 reviewers citing it");
    expect(text).toContain("cited the known work under originality");
    expect(text).toContain("1 withheld");
    expect(text).not.toMatch(/\d+\s*%/);
  });

  it("says *not measured* in words rather than printing a zero", () => {
    const report = measureNovelty(
      item([seat("reviewer_a", { ledger: undefined })], []),
      PROBE,
    );
    const text = formatNoveltyReport(report, PROBE);
    expect(text).toContain("not measured");
    expect(text).not.toContain("found 0/");
  });

  it("carries no banned word, in its text or its JSON", () => {
    const report = measureNovelty(
      item([seat("reviewer_a")], [paperConcern("a-1", "reviewer_a", KNOWN)]),
      PROBE,
    );
    expect(formatNoveltyReport(report, PROBE)).not.toMatch(BANNED);
    expect(JSON.stringify(report)).not.toMatch(BANNED);
  });
});

// ── readProbe refuses rather than repairs ───────────────────────────────────

describe("V2 O26 — readProbe refuses a probe it cannot trust", () => {
  async function probeFile(body: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lemmaria-probe-"));
    dirs.push(dir);
    const path = join(dir, "probe.json");
    await writeFile(path, JSON.stringify(body), "utf8");
    return path;
  }

  it("reads a well-formed probe", async () => {
    await expect(readProbe(await probeFile(PROBE))).resolves.toEqual(PROBE);
  });

  it("refuses one that names no known work", async () => {
    const path = await probeFile({ ...PROBE, known: { arxiv: "1412.6980" } });
    await expect(readProbe(path)).rejects.toThrow(/names no known work/);
  });

  it("refuses one with no claim span", async () => {
    const path = await probeFile({ ...PROBE, claims: [] });
    await expect(readProbe(path)).rejects.toThrow(/records no claim span/);
  });

  it("refuses a claim span with no line", async () => {
    const path = await probeFile({
      ...PROBE,
      claims: [{ anchor: "we introduce this combination" }],
    });
    await expect(readProbe(path)).rejects.toThrow(/no integer line/);
  });
});
