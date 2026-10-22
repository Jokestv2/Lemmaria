/**
 * O2–O14: the scorecard block (V6, ADR 0088 §3–§5; plan D3–D10).
 *
 * The block draws the card the HOST derived (`deriveScorecard`) and computes
 * nothing about a level of its own: every level, count, mark and delta here is
 * read off the card literal the test hands in. These read the DOM
 * `renderScorecard` builds, in both locales.
 */
import type {
  PanelDimension,
  Scorecard,
  ScorecardDelta,
  ScorecardDimension,
  ScorecardSeat,
  ScorecardStanding,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type ScorecardView,
  countsText,
  deltaCell,
  formatMedian,
  hasContributor,
  impressionText,
  readinessKey,
  renderScorecard,
  seatLetter,
} from "../src/webview/parts/review-scorecard.js";
import { dimensionLabel } from "../src/webview/parts/review-tab.js";
import { tr, versionLabel } from "../src/webview/parts/strings.js";

const EIGHT: PanelDimension[] = [
  "soundness",
  "claims",
  "clarity",
  "language",
  "positioning",
  "originality",
  "significance",
  "presentation",
];

const level = (n: 1 | 2 | 3 | 4, checked = n !== 4): ScorecardStanding => ({
  kind: "level",
  level: n,
  checked,
});
const NOTHING: ScorecardStanding = { kind: "nothing_raised" };
const NO_REVIEWER: ScorecardStanding = {
  kind: "not_assessed",
  reason: { kind: "no_reviewer" },
};
const NO_PDF: ScorecardStanding = {
  kind: "not_assessed",
  reason: { kind: "no_pdf" },
};

/** A text seat's column in one row. */
const seat = (
  reviewer: string,
  standing?: ScorecardStanding,
  impression: number | null = null,
  model = "m1",
): ScorecardSeat => ({
  reviewer,
  model,
  ...(standing !== undefined ? { standing } : {}),
  impression,
});

/** One row, with every field a row carries. */
const row = (
  dimension: PanelDimension,
  over: Partial<ScorecardDimension> = {},
): ScorecardDimension => ({
  dimension,
  standing: NOTHING,
  issues: { blocking: 0, major: 0, minor: 0, info: 0 },
  strengths: 0,
  seats: [
    seat("reviewer_a", dimension === "presentation" ? undefined : NOTHING),
    seat("reviewer_b", dimension === "presentation" ? undefined : NOTHING),
  ],
  impression: null,
  ...over,
});

/**
 * A two-reviewer panel with a PDF seat: soundness at level 1 (checked),
 * claims level 2 not checked, clarity strong, originality not assessed for
 * want of literature, presentation level 3 from the PDF seat — and nothing
 * raised on the rest.
 */
const card = (over: Partial<Scorecard> = {}): Scorecard => {
  const pdf = (standing: ScorecardStanding, impression: number | null) =>
    seat("pdf_reviewer", standing, impression, "vision-1");
  const withPdf = (r: ScorecardDimension): ScorecardDimension => ({
    ...r,
    seats: [
      ...r.seats,
      r.dimension === "presentation"
        ? pdf(r.standing, r.impression)
        : seat("pdf_reviewer", undefined, null, "vision-1"),
    ],
  });
  const rows: Record<PanelDimension, ScorecardDimension> = {
    soundness: row("soundness", {
      standing: level(1),
      issues: { blocking: 1, major: 2, minor: 1, info: 3 },
      seats: [seat("reviewer_a", level(1), 3), seat("reviewer_b", level(3), 4)],
      impression: 3.5,
    }),
    claims: row("claims", {
      standing: level(2, false),
      issues: { blocking: 0, major: 1, minor: 0, info: 0 },
      seats: [
        seat("reviewer_a", level(2, false), 5),
        seat("reviewer_b", NOTHING, 6),
      ],
      impression: 5.5,
    }),
    clarity: row("clarity", {
      standing: level(4),
      strengths: 2,
      seats: [
        seat("reviewer_a", level(4), 8),
        seat("reviewer_b", NOTHING, null),
      ],
      impression: 8,
    }),
    language: row("language"),
    positioning: row("positioning"),
    originality: row("originality", {
      standing: { kind: "not_assessed", reason: { kind: "no_literature" } },
      seats: [
        seat("reviewer_a", {
          kind: "not_assessed",
          reason: { kind: "no_literature" },
        }),
        seat("reviewer_b", {
          kind: "not_assessed",
          reason: { kind: "no_literature" },
        }),
      ],
    }),
    significance: row("significance"),
    presentation: row("presentation", {
      standing: level(3, false),
      issues: { blocking: 0, major: 0, minor: 2, info: 0 },
      impression: 6,
    }),
  };
  return {
    readiness: { label: "blocking", checked: false },
    notAssessed: 1,
    dimensions: EIGHT.map((d) => withPdf(rows[d])),
    panel: {
      reviewers: [
        { reviewer: "reviewer_a", model: "m1" },
        { reviewer: "reviewer_b", model: "m2" },
      ],
      verificationOn: true,
      pdf: { model: "vision-1" },
    },
    ...over,
  };
};

const calls: string[] = [];
const deps = {
  onNarrow: (d: string | undefined) => calls.push(`narrow:${d ?? "-"}`),
};
const draw = (view: Partial<ScorecardView> = {}, locale: "en" | "zh" = "en") =>
  renderScorecard(
    { card: card(), pdfReviewer: "pdf_reviewer", ...view },
    locale,
    deps,
  );
const text = (n: Element | null | undefined): string => n?.textContent ?? "";
const rowOf = (block: HTMLElement, d: PanelDimension): HTMLElement =>
  block.querySelector(`.lm-sc-row[data-dimension="${d}"]`) as HTMLElement;

describe("the scorecard block's frame (O2, O13)", () => {
  it("is a labelled section, readiness first and the caveat last", () => {
    for (const locale of ["en", "zh"] as const) {
      const block = draw({}, locale);
      expect(block.tagName).toBe("SECTION");
      expect(block.classList.contains("lm-scorecard")).toBe(true);
      expect(block.getAttribute("aria-label")).toBe(tr(locale, "scTitle"));
      const kids = [...block.children].map((c) => c.className);
      expect(kids[0]).toBe("lm-sc-readiness");
      expect(kids.at(-1)).toBe("lm-sc-caveat");
      expect(text(block.lastElementChild)).toBe(tr(locale, "scCaveat"));
      // Always visible: no fold, no tooltip.
      expect(block.querySelector("details")).toBeNull();
      expect(block.lastElementChild?.closest("details")).toBeNull();
    }
  });

  it("draws an unmeasured card as one sentence and the caveat, and nothing else", () => {
    const unmeasured = card({
      readiness: { label: "not_assessed", checked: true },
      notAssessed: 8,
      dimensions: EIGHT.map((d) =>
        row(d, {
          standing: d === "presentation" ? NO_PDF : NO_REVIEWER,
          seats: [],
        }),
      ),
      panel: { reviewers: [], verificationOn: true },
    });
    for (const locale of ["en", "zh"] as const) {
      const block = draw({ card: unmeasured }, locale);
      expect([...block.children].map((c) => c.className)).toEqual([
        "lm-sc-unmeasured",
        "lm-sc-caveat",
      ]);
      expect(text(block.firstElementChild)).toBe(tr(locale, "scUnmeasured"));
      expect(block.querySelector(".lm-sc-row")).toBeNull();
      expect(block.querySelector(".lm-sc-legend")).toBeNull();
      expect(block.querySelector(".lm-sc-compare")).toBeNull();
    }
  });

  it("says no reviewer ran, not that no ledger could be read, for a review with no seat at all (E1's round)", () => {
    // The 中文 window stored `seats: []` from a PDF-only run with the role
    // Off, and the block blamed an unreadable ledger nobody had produced.
    const empty = card({
      readiness: { label: "not_assessed", checked: true },
      notAssessed: 8,
      dimensions: EIGHT.map((d) =>
        row(d, {
          standing: d === "presentation" ? NO_PDF : NO_REVIEWER,
          seats: [],
        }),
      ),
      panel: { reviewers: [], verificationOn: true },
    });
    for (const locale of ["en", "zh"] as const) {
      const block = draw({ card: empty, noSeat: true }, locale);
      expect([...block.children].map((c) => c.className)).toEqual([
        "lm-sc-unmeasured",
        "lm-sc-caveat",
      ]);
      expect(text(block.firstElementChild)).toBe(tr(locale, "scNoReviewerRan"));
      expect(tr(locale, "scNoReviewerRan")).not.toBe(
        tr(locale, "scUnmeasured"),
      );
    }
    // A card with a contributor ignores the flag: its rows say the rest.
    expect(
      draw({ noSeat: true }).querySelector(".lm-sc-unmeasured"),
    ).toBeNull();
  });

  it("carries no style attribute and no image anywhere (the CSP drops both)", () => {
    const block = draw({
      previous: { version: 2, comparable: true },
      delta: { dimensions: [] },
      narrow: { dimension: "soundness", shown: 1, total: 4 },
    });
    expect(block.querySelector("[style]")).toBeNull();
    expect(block.querySelector("img, svg")).toBeNull();
  });
});

describe("the readiness line (O3)", () => {
  const LABELS = [
    ["blocking", "scReadinessBlocking"],
    ["major", "scReadinessMajor"],
    ["minor", "scReadinessMinor"],
    ["none", "scReadinessNone"],
    ["not_assessed", "scReadinessNotAssessed"],
  ] as const;

  it("renders each label's word, in both languages", () => {
    for (const [label, key] of LABELS) {
      expect(readinessKey(label)).toBe(key);
      for (const locale of ["en", "zh"] as const) {
        const block = draw(
          { card: card({ readiness: { label, checked: false } }) },
          locale,
        );
        expect(text(block.querySelector(".lm-sc-readiness__word"))).toBe(
          tr(locale, key),
        );
      }
    }
  });

  it("says how many dimensions were not assessed only when some were", () => {
    const one = draw();
    expect(text(one.querySelector(".lm-sc-readiness__na"))).toBe(
      "1 not assessed",
    );
    expect(text(one.querySelector(".lm-sc-readiness"))).toBe(
      "Blocking issues · 1 not assessed",
    );
    const zh = draw({}, "zh");
    expect(text(zh.querySelector(".lm-sc-readiness__na"))).toBe(
      tr("zh", "scNotAssessedCount").replace("{n}", "1"),
    );
    const none = draw({ card: card({ notAssessed: 0 }) });
    expect(none.querySelector(".lm-sc-readiness__na")).toBeNull();
    expect(text(none.querySelector(".lm-sc-readiness"))).toBe(
      "Blocking issues",
    );
  });

  it("draws nothing over readiness.checked: flipping it changes no node", () => {
    const off = draw({
      card: card({ readiness: { label: "major", checked: false } }),
    });
    const on = draw({
      card: card({ readiness: { label: "major", checked: true } }),
    });
    expect(on.outerHTML).toBe(off.outerHTML);
  });
});

describe("the rows (O4, O5, O6)", () => {
  it("draws eight rows, in the card's order, each labelled and keyed", () => {
    for (const locale of ["en", "zh"] as const) {
      const rows = [...draw({}, locale).querySelectorAll(".lm-sc-row")];
      expect(rows.map((r) => r.getAttribute("data-dimension"))).toEqual(EIGHT);
      expect(rows.map((r) => text(r.querySelector(".lm-sc-row__dim")))).toEqual(
        EIGHT.map((d) => dimensionLabel(locale, d)),
      );
    }
  });

  it("fills as many steps as the level, and colours the track by it", () => {
    const block = draw();
    const steps = (d: PanelDimension) =>
      [...rowOf(block, d).querySelectorAll(".lm-sc-track > .lm-sc-step")].map(
        (s) => s.className.replace("lm-sc-step lm-sc-step--", ""),
      );
    expect(steps("soundness")).toEqual(["on", "off", "off", "off"]);
    expect(steps("claims")).toEqual(["on", "on", "off", "off"]);
    expect(steps("presentation")).toEqual(["on", "on", "on", "off"]);
    expect(steps("clarity")).toEqual(["on", "on", "on", "on"]);
    for (const [d, cls] of [
      ["soundness", "lm-sc-track--l1"],
      ["claims", "lm-sc-track--l2"],
      ["presentation", "lm-sc-track--l3"],
      ["clarity", "lm-sc-track--l4"],
      ["language", "lm-sc-track--none"],
      ["originality", "lm-sc-track--na"],
    ] as const)
      expect(
        rowOf(block, d).querySelector(".lm-sc-track")?.classList.contains(cls),
        d,
      ).toBe(true);
  });

  it("never renders not assessed as a level — four hatched steps and no filled one", () => {
    const block = draw();
    const track = rowOf(block, "originality").querySelector(".lm-sc-track");
    expect(track?.querySelectorAll(".lm-sc-step--na")).toHaveLength(4);
    expect(track?.querySelector(".lm-sc-step--on")).toBeNull();
    const none = rowOf(block, "language").querySelector(".lm-sc-track");
    expect(none?.querySelectorAll(".lm-sc-step--off")).toHaveLength(4);
    expect(none?.querySelector(".lm-sc-step--on, .lm-sc-step--na")).toBeNull();
  });

  it("names the level by its number and word, and marks what was not checked", () => {
    for (const locale of ["en", "zh"] as const) {
      const block = draw({}, locale);
      const words = (d: PanelDimension) =>
        text(rowOf(block, d).querySelector(".lm-sc-row__level"));
      const levelWord = (
        n: number,
        key: "scLevel1" | "scLevel2" | "scLevel3" | "scLevel4",
      ) =>
        tr(locale, "scLevelWord")
          .replace("{level}", String(n))
          .replace("{word}", tr(locale, key));
      const mark = tr(locale, "rConcernUnchecked");
      // Checked: the word alone.
      expect(words("soundness"), locale).toBe(levelWord(1, "scLevel1"));
      // Not checked: the id line's own words, by exception.
      expect(words("claims"), locale).toBe(
        `${levelWord(2, "scLevel2")} · ${mark}`,
      );
      expect(words("presentation"), locale).toBe(
        `${levelWord(3, "scLevel3")} · ${mark}`,
      );
      // Level 4 always carries it: no verifier reads a strength.
      expect(words("clarity"), locale).toBe(
        `${levelWord(4, "scLevel4")} · ${mark}`,
      );
      expect(words("language"), locale).toBe(tr(locale, "scNothingRaised"));
      expect(words("originality"), locale).toBe(tr(locale, "scNotAssessed"));
      expect(rowOf(block, "soundness").querySelector(".lm-sc-mark")).toBeNull();
      expect(text(rowOf(block, "claims").querySelector(".lm-sc-mark"))).toBe(
        mark,
      );
    }
  });
});

describe("the counts line (O7)", () => {
  it("prints the non-zero of blocking, major, minor and strengths, in that order, never info", () => {
    // soundness holds 2 major issues, 1 of them blocking: the line prints the
    // blocking one, then the 1 that is major and NOT blocking (E1/J2 round).
    expect(countsText("en", card().dimensions[0] as ScorecardDimension)).toBe(
      "issues: blocking 1 · major 1 · minor 1",
    );
    expect(countsText("en", card().dimensions[2] as ScorecardDimension)).toBe(
      "strengths 2",
    );
    const block = draw();
    expect(
      text(rowOf(block, "soundness").querySelector(".lm-sc-row__counts")),
    ).toBe("issues: blocking 1 · major 1 · minor 1");
    expect(text(block)).not.toContain("info");
    const zh = draw({}, "zh");
    expect(
      text(rowOf(zh, "soundness").querySelector(".lm-sc-row__counts")),
    ).toBe(
      tr("zh", "scCountIssues").replace(
        "{list}",
        ["scCountBlocking", "scCountMajor", "scCountMinor"]
          .map((k) => tr("zh", k as "scCountMajor").replace("{n}", String(1)))
          .join(" · "),
      ),
    );
  });

  it("never reads as a sum: the counts are disjoint, and name issues rather than concerns (E1/J2 round)", () => {
    // PrismGPT's soundness row: 11 major issues, all of them blocking, read
    // on screen as `blocking 11 · major 11` — 22, where there were 11.
    const allBlocking = row("soundness", {
      standing: level(1),
      issues: { blocking: 11, major: 11, minor: 1, info: 0 },
      strengths: 2,
    });
    expect(countsText("en", allBlocking)).toBe(
      "issues: blocking 11 · minor 1 · strengths 2",
    );
    const noneBlocking = row("claims", {
      standing: level(2),
      issues: { blocking: 0, major: 3, minor: 0, info: 1 },
    });
    expect(countsText("en", noneBlocking)).toBe("issues: major 3");
    // The banner counts concerns; the row says what it counts, in both
    // languages, with a word the banner does not use.
    for (const locale of ["en", "zh"] as const) {
      const line = countsText(locale, allBlocking);
      expect(line, locale).toContain(
        tr(locale, "scCountIssues").replace("{list}", "").trim(),
      );
      expect(tr(locale, "scNarrowed"), locale).not.toContain(
        tr(locale, "scCountIssues").replace("{list}", "").trim(),
      );
    }
  });

  it("prints nothing on a nothing-raised row, even with info groups", () => {
    const quiet = row("language", {
      issues: { blocking: 0, major: 0, minor: 0, info: 2 },
    });
    expect(countsText("en", quiet)).toBe("");
    const block = draw({
      card: card({
        dimensions: card().dimensions.map((d) =>
          d.dimension === "language" ? quiet : d,
        ),
      }),
    });
    expect(
      rowOf(block, "language").querySelector(".lm-sc-row__counts"),
    ).toBeNull();
  });
});

describe("the not-assessed reason (O8)", () => {
  const withRow = (r: ScorecardDimension): Scorecard =>
    card({
      dimensions: card().dimensions.map((d) =>
        d.dimension === r.dimension ? r : d,
      ),
    });
  const reasonOf = (r: ScorecardDimension, locale: "en" | "zh" = "en") =>
    text(
      rowOf(draw({ card: withRow(r) }, locale), r.dimension).querySelector(
        ".lm-sc-row__reason",
      ),
    );

  it("says each kind's reason, in both languages", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(
        reasonOf(
          row("originality", {
            standing: {
              kind: "not_assessed",
              reason: { kind: "no_literature" },
            },
          }),
          locale,
        ),
      ).toBe(tr(locale, "scReasonNoLiterature"));
      expect(
        reasonOf(
          row("positioning", {
            standing: {
              kind: "not_assessed",
              reason: { kind: "literature_budget" },
            },
          }),
          locale,
        ),
      ).toBe(tr(locale, "scReasonLiteratureBudget"));
      expect(reasonOf(row("presentation", { standing: NO_PDF }), locale)).toBe(
        tr(locale, "scReasonNoPdf"),
      );
      expect(reasonOf(row("claims", { standing: NO_REVIEWER }), locale)).toBe(
        tr(locale, "scReasonNoReviewer"),
      );
    }
  });

  it("names each declaring seat, and prints its note as authored, as text", () => {
    const note = "無法判斷 <b>novelty</b> & the related work";
    const declared = row("significance", {
      standing: {
        kind: "not_assessed",
        reason: {
          kind: "declared",
          by: [
            { reviewer: "reviewer_a", note },
            { reviewer: "reviewer_b", note: "no field context" },
          ],
        },
      },
    });
    const block = draw({ card: withRow(declared) });
    const reason = rowOf(block, "significance").querySelector(
      ".lm-sc-row__reason",
    );
    expect(text(reason)).toContain(
      tr("en", "scReasonDeclared").replace("{who}", "A, B"),
    );
    const notes = [...(reason?.querySelectorAll(".lm-sc-row__note") ?? [])];
    expect(notes.map((n) => n.textContent)).toEqual([
      `A · ${note}`,
      "B · no field context",
    ]);
    // Set as text: the angle brackets made no element.
    expect(reason?.querySelector("b")).toBeNull();
    // A not-assessed row carries no counts and no impression line.
    expect(
      rowOf(block, "significance").querySelector(".lm-sc-row__counts"),
    ).toBeNull();
    expect(
      rowOf(block, "significance").querySelector(".lm-sc-row__impression"),
    ).toBeNull();
    const zh = draw({ card: withRow(declared) }, "zh");
    expect(
      text(rowOf(zh, "significance").querySelector(".lm-sc-row__reason")),
    ).toContain(tr("zh", "scReasonDeclared").replace("{who}", "A、B"));
  });
});

describe("the seats column and the legend (O9, O10)", () => {
  it("maps a reviewer to its letter, the PDF seat to PDF, and anything else to itself", () => {
    expect(seatLetter("reviewer_b", "pdf_reviewer")).toBe("B");
    expect(seatLetter("reviewer_a")).toBe("A");
    expect(seatLetter("pdf_reviewer", "pdf_reviewer")).toBe("PDF");
    expect(seatLetter("soundness")).toBe("soundness");
    expect(seatLetter("pdf_reviewer")).toBe("pdf_reviewer");
  });

  it("shows one cell per seat that assesses the row, its level or a dash", () => {
    const block = draw();
    const cells = (d: PanelDimension) =>
      [...rowOf(block, d).querySelectorAll(".lm-sc-seat")].map(
        (c) => c.textContent,
      );
    expect(cells("soundness")).toEqual(["A 1", "B 3"]);
    expect(cells("claims")).toEqual(["A 2", "B –"]);
    expect(cells("originality")).toEqual(["A –", "B –"]);
    // The PDF seat assesses presentation alone, and only it.
    expect(cells("presentation")).toEqual(["PDF 3"]);
    expect(
      text(rowOf(block, "soundness").querySelector(".lm-sc-row__seats")),
    ).toBe("A 1 · B 3");
  });

  it("puts every contributor's model in view once, above the rows", () => {
    const legend = draw().querySelector(".lm-sc-legend");
    expect(
      [...(legend?.querySelectorAll(".lm-sc-legend__seat") ?? [])].map(
        (s) => s.textContent,
      ),
    ).toEqual(["A m1", "B m2", "PDF vision-1"]);
    expect(
      [...(legend?.querySelectorAll(".lm-review-model") ?? [])].map(
        (m) => m.textContent,
      ),
    ).toEqual(["m1", "m2", "vision-1"]);
  });

  it("omits a model the record does not know, and the PDF seat when none contributed", () => {
    const legend = draw({
      card: card({
        panel: {
          reviewers: [
            { reviewer: "reviewer_a", model: "" },
            { reviewer: "reviewer_b", model: "m2" },
          ],
          verificationOn: true,
        },
      }),
    }).querySelector(".lm-sc-legend");
    expect(
      [...(legend?.querySelectorAll(".lm-sc-legend__seat") ?? [])].map(
        (s) => s.textContent,
      ),
    ).toEqual(["A", "B m2"]);
    expect(legend?.querySelectorAll(".lm-review-model")).toHaveLength(1);
  });
});

describe("the impression line (O11)", () => {
  it("prints the median, each seat's value or a dash, and says uncalibrated", () => {
    const block = draw();
    expect(
      text(rowOf(block, "soundness").querySelector(".lm-sc-row__impression")),
    ).toBe("impression 3.5 · A 3 · B 4 · uncalibrated");
    expect(
      text(rowOf(block, "clarity").querySelector(".lm-sc-row__impression")),
    ).toBe("impression 8 · A 8 · B – · uncalibrated");
    expect(
      text(
        rowOf(block, "presentation").querySelector(".lm-sc-row__impression"),
      ),
    ).toBe("impression 6 · PDF 6 · uncalibrated");
    expect(
      rowOf(block, "soundness").querySelector(".lm-sc-uncal")?.textContent,
    ).toBe("uncalibrated");
    const zh = draw({}, "zh");
    expect(
      text(rowOf(zh, "soundness").querySelector(".lm-sc-row__impression")),
    ).toBe(
      `${tr("zh", "scImpression").replace("{n}", "3.5")} · A 3 · B 4 · ${tr("zh", "scUncalibrated")}`,
    );
  });

  it("says no impression was given when none was", () => {
    const block = draw();
    expect(
      text(rowOf(block, "language").querySelector(".lm-sc-row__impression")),
    ).toBe("no impression given");
    expect(impressionText("en", row("language"), "pdf_reviewer")).toBe(
      "no impression given",
    );
    expect(
      rowOf(block, "originality").querySelector(".lm-sc-row__impression"),
    ).toBeNull();
  });

  it("formats a whole median as an integer and a half as one decimal", () => {
    expect(formatMedian(6)).toBe("6");
    expect(formatMedian(6.5)).toBe("6.5");
    expect(formatMedian(6.25)).toBe("6.3");
  });

  it("drives nothing: replacing every impression changes no other node", () => {
    const bland = card({
      dimensions: card().dimensions.map((d) => ({
        ...d,
        impression: null,
        seats: d.seats.map((s) => ({ ...s, impression: null })),
      })),
    });
    const strip = (block: HTMLElement): string => {
      for (const n of block.querySelectorAll(".lm-sc-row__impression"))
        n.remove();
      return block.outerHTML;
    };
    expect(strip(draw({ card: bland }))).toBe(strip(draw()));
  });
});

describe("the delta (O12)", () => {
  const same = (
    d: PanelDimension,
    change: "improved" | "worsened" | "unchanged",
  ) => ({
    dimension: d,
    comparable: true as const,
    from: NOTHING,
    to: NOTHING,
    change,
  });
  const DELTA: ScorecardDelta = {
    dimensions: [
      same("soundness", "worsened"),
      same("claims", "improved"),
      same("clarity", "unchanged"),
      { dimension: "language", comparable: false, reason: "not_assessed" },
      same("positioning", "unchanged"),
      { dimension: "originality", comparable: false, reason: "not_assessed" },
      same("significance", "unchanged"),
      { dimension: "presentation", comparable: false, reason: "pdf" },
    ],
  };
  const cell = (block: HTMLElement, d: PanelDimension) =>
    rowOf(block, d).querySelector(".lm-sc-row__delta");

  it("says first reading, and draws no cell, with nothing to compare against", () => {
    for (const locale of ["en", "zh"] as const) {
      const block = draw({}, locale);
      expect(text(block.querySelector(".lm-sc-compare"))).toBe(
        tr(locale, "scFirstReading"),
      );
      expect(block.querySelector(".lm-sc-row__delta")).toBeNull();
    }
  });

  it("names a version that was not comparable, why, and draws no cell", () => {
    for (const locale of ["en", "zh"] as const) {
      const panel = draw(
        {
          previous: { version: 3, comparable: false },
          delta: {
            dimensions: EIGHT.map((d) =>
              d === "presentation"
                ? { dimension: d, comparable: false, reason: "pdf" }
                : { dimension: d, comparable: false, reason: "reviewers" },
            ),
          },
        },
        locale,
      );
      expect(text(panel.querySelector(".lm-sc-compare"))).toBe(
        tr(locale, "scNotComparable").replace(
          "{version}",
          versionLabel(locale, 3),
        ),
      );
      expect(panel.querySelector(".lm-sc-row__delta")).toBeNull();
      const dial = draw(
        {
          previous: { version: 2, comparable: false },
          delta: {
            dimensions: EIGHT.map((d) => ({
              dimension: d,
              comparable: false as const,
              reason:
                d === "presentation"
                  ? ("pdf" as const)
                  : ("verification" as const),
            })),
          },
        },
        locale,
      );
      expect(text(dial.querySelector(".lm-sc-compare"))).toBe(
        tr(locale, "scNotComparableVerification").replace(
          "{version}",
          versionLabel(locale, 2),
        ),
      );
      expect(dial.querySelector(".lm-sc-row__delta")).toBeNull();
    }
  });

  it("draws a glyph with its word on every comparable row", () => {
    for (const locale of ["en", "zh"] as const) {
      const block = draw(
        { previous: { version: 2, comparable: true }, delta: DELTA },
        locale,
      );
      expect(text(block.querySelector(".lm-sc-compare"))).toBe(
        tr(locale, "scComparedWith").replace(
          "{version}",
          versionLabel(locale, 2),
        ),
      );
      for (const [d, glyph, cls, key] of [
        ["soundness", "▼", "lm-sc-delta--down", "scDeltaWorsened"],
        ["claims", "▲", "lm-sc-delta--up", "scDeltaImproved"],
        ["clarity", "=", "lm-sc-delta--same", "scDeltaUnchanged"],
      ] as const) {
        const c = cell(block, d);
        expect(c?.textContent, d).toBe(glyph);
        expect(c?.classList.contains(cls), d).toBe(true);
        expect(c?.getAttribute("aria-label"), d).toBe(tr(locale, key));
      }
    }
  });

  it("sets the glyph right after its level words, inside the level cell, so it wraps with them (E1's round)", () => {
    // At a real sidebar width a far-right glyph read as a separate column,
    // and at ~280 px it landed alone on a line of its own.
    const block = draw({
      previous: { version: 2, comparable: true },
      delta: DELTA,
    });
    for (const d of [
      "soundness",
      "claims",
      "clarity",
      "language",
      "presentation",
    ] as const)
      expect(
        cell(block, d)?.parentElement?.classList.contains("lm-sc-row__level"),
        d,
      ).toBe(true);
    const words = (d: PanelDimension) =>
      text(rowOf(block, d).querySelector(".lm-sc-row__level"));
    // A no-break space binds the glyph to the word before it, and the
    // not-checked mark follows the glyph rather than splitting the two.
    expect(words("soundness")).toBe("1 Blocking ▼");
    expect(words("claims")).toBe(
      `2 Major ▲ · ${tr("en", "rConcernUnchecked")}`,
    );
    expect(words("language")).toBe(
      `${tr("en", "scNothingRaised")} ${tr("en", "scDeltaNew")}`,
    );
  });

  it("says new where the compared version had no standing here and this one has", () => {
    const block = draw({
      previous: { version: 2, comparable: true },
      delta: DELTA,
    });
    // presentation: a PDF seat this time, none (or another model) then.
    expect(cell(block, "presentation")?.textContent).toBe("new");
    // language: nothing raised now, not assessed then.
    expect(cell(block, "language")?.textContent).toBe("new");
    // originality is not assessed NOW: the row already says so.
    expect(cell(block, "originality")).toBeNull();
  });

  it("draws nothing for a pair-level reason, even under a comparable pair", () => {
    expect(
      deltaCell(
        "en",
        { dimension: "claims", comparable: false, reason: "reviewers" },
        true,
      ),
    ).toBeUndefined();
    expect(
      deltaCell(
        "en",
        { dimension: "claims", comparable: false, reason: "verification" },
        true,
      ),
    ).toBeUndefined();
    expect(
      deltaCell(
        "en",
        { dimension: "claims", comparable: false, reason: "not_assessed" },
        false,
      ),
    ).toBeUndefined();
  });
});

describe("a row is a door into its concerns (O14)", () => {
  it("is a button that says whether it is pressed", () => {
    const block = draw({ narrowed: "claims" });
    const rows = [...block.querySelectorAll(".lm-sc-row")];
    for (const r of rows) {
      expect(r.tagName).toBe("BUTTON");
      expect(r.getAttribute("type")).toBe("button");
    }
    expect(rows.map((r) => r.getAttribute("aria-pressed"))).toEqual(
      EIGHT.map((d) => (d === "claims" ? "true" : "false")),
    );
    // A button holds phrasing content only.
    expect(block.querySelector(".lm-sc-row div")).toBeNull();
  });

  it("narrows on a click, and a click on the pressed row clears it", () => {
    calls.length = 0;
    const block = draw({ narrowed: "claims" });
    (rowOf(block, "soundness") as HTMLButtonElement).click();
    (rowOf(block, "claims") as HTMLButtonElement).click();
    expect(calls).toEqual(["narrow:soundness", "narrow:-"]);
  });

  it("says what it narrowed to, how much it shows, and offers everything back", () => {
    calls.length = 0;
    for (const locale of ["en", "zh"] as const) {
      const block = draw(
        {
          narrowed: "soundness",
          narrow: { dimension: "soundness", shown: 5, total: 23 },
        },
        locale,
      );
      const banner = block.querySelector(".lm-sc-narrow");
      expect(banner?.nextElementSibling?.className).toBe("lm-sc-caveat");
      expect(text(banner)).toContain(
        tr(locale, "scNarrowed")
          .replace("{dimension}", dimensionLabel(locale, "soundness"))
          .replace("{shown}", "5")
          .replace("{total}", "23"),
      );
      const all = banner?.querySelector(
        "button.lm-sc-narrow__all",
      ) as HTMLButtonElement;
      expect(all.textContent).toBe(tr(locale, "scShowAll"));
      all.click();
    }
    expect(calls).toEqual(["narrow:-", "narrow:-"]);
    expect(draw().querySelector(".lm-sc-narrow")).toBeNull();
  });
  it("with nothing to narrow, draws the rows as text, not as controls", () => {
    const block = renderScorecard(
      {
        card: card(),
        narrowed: "claims",
        narrow: { dimension: "claims", shown: 1, total: 2 },
      },
      "en",
      {},
    );
    expect(block.querySelector("button")).toBeNull();
    expect(block.querySelector("[aria-pressed]")).toBeNull();
    expect(block.querySelectorAll("div.lm-sc-row")).toHaveLength(8);
    expect(block.querySelector(".lm-sc-narrow")).not.toBeNull();
  });
});

describe("the code review's round (V6)", () => {
  it("says a compared version measured nothing, rather than that it was a different panel", () => {
    for (const locale of ["en", "zh"] as const) {
      const block = draw(
        {
          previous: { version: 4, comparable: false, unmeasured: true },
          delta: {
            dimensions: EIGHT.map((d) =>
              d === "presentation"
                ? {
                    dimension: d,
                    comparable: false as const,
                    reason: "pdf" as const,
                  }
                : {
                    dimension: d,
                    comparable: false as const,
                    reason: "reviewers" as const,
                  },
            ),
          },
        },
        locale,
      );
      expect(text(block.querySelector(".lm-sc-compare"))).toBe(
        tr(locale, "scNotComparableUnmeasured").replace(
          "{version}",
          versionLabel(locale, 4),
        ),
      );
      expect(block.querySelector(".lm-sc-row__delta")).toBeNull();
    }
  });

  it("gives the delta glyph an image role, so its word is its accessible name", () => {
    const cell = deltaCell(
      "en",
      {
        dimension: "claims",
        comparable: true,
        from: NOTHING,
        to: NOTHING,
        change: "improved",
      },
      true,
    );
    expect(cell?.getAttribute("role")).toBe("img");
    expect(cell?.getAttribute("aria-label")).toBe(tr("en", "scDeltaImproved"));
  });

  it("knows a card no seat contributed to", () => {
    expect(hasContributor(card())).toBe(true);
    expect(
      hasContributor(card({ panel: { reviewers: [], verificationOn: true } })),
    ).toBe(false);
    expect(
      hasContributor(
        card({
          panel: { reviewers: [], verificationOn: true, pdf: { model: "v" } },
        }),
      ),
    ).toBe(true);
  });
});
