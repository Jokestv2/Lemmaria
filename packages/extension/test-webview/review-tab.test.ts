/**
 * O25 / O26: the Review tab, in both modes (R3, ADR 0061 §10; ADR 0037).
 *
 * The tab rendered inside `main.ts` until R3, so nothing about it could be
 * asserted offline. These read the produced DOM: what a reader actually sees,
 * in each locale, for a panel and for the quick action that goes through the
 * same module unchanged.
 */
import type { ReviewLimit, Scorecard } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import type {
  ReviewAnnotationInfo,
  ReviewTabState,
} from "../src/webview-protocol.js";
import type { ReviewRunView } from "../src/webview/parts/review-progress.js";
import {
  type ReviewTabDeps,
  dimensionLabel,
  limitSentence,
  renderReviewTab,
} from "../src/webview/parts/review-tab.js";
import { tr } from "../src/webview/parts/strings.js";

const calls: string[] = [];
/** What the reader folded, so a test can drive §4's groups the way main.ts
 *  does — including the "unknown key answers with the group's own default"
 *  rule, which is what makes a seat group arrive OPEN. */
const folds = new Map<string, boolean>();
const deps = (
  locale: "en" | "zh" = "en",
  /** ADR 0065 §3: the detached panel in flight, which replaced ADR 0064 §3's
   *  `busy` — see `ReviewTabDeps.run` for why the swap is a decision. */
  run?: ReviewRunView,
): ReviewTabDeps => ({
  locale,
  reveal: (i) => calls.push(`reveal:${i}`),
  // V1 (ADR 0076 §9): the passage that answered a withdrawn concern.
  revealCounter: (i) => calls.push(`counter:${i}`),
  ignore: (i) => calls.push(`ignore:${i}`),
  adopt: (i) => calls.push(`adopt:${i}`),
  resolve: (a) => calls.push(`resolve:${a.id}`),
  chat: (a) => calls.push(`chat:${a.id}`),
  selectReview: (id) => calls.push(`select:${id}`),
  chooseEntry: () => calls.push("entry"),
  runPanel: () => calls.push("run"),
  stopPanel: () => calls.push("stop"),
  ...(run ? { run } : {}),
  groupOpen: (key, fallback) => folds.get(key) ?? fallback,
  onGroupToggle: (key, open) => calls.push(`fold:${key}:${open}`),
});

const annotation = (
  over: Partial<ReviewAnnotationInfo> = {},
): ReviewAnnotationInfo => ({
  index: 0,
  id: "reviewer_a-1",
  dimension: "soundness",
  severity: "major",
  message: "the exclusion restriction is never argued",
  reviewer: "reviewer_a",
  file: "main.tex",
  line: 4,
  hasSuggestion: false,
  status: "pending",
  ...over,
});

const PANEL: ReviewTabState = {
  available: true,
  mode: "panel",
  file: "main.tex",
  entry: "main.tex",
  nextEntry: "main.tex",
  annotations: [
    annotation({
      blocking: true,
      evidence: { kind: "span", file: "main.tex", line: 3 },
    }),
    annotation({
      index: 1,
      id: "reviewer_b-1",
      dimension: "claims",
      reviewer: "reviewer_b",
      file: "sections/method.tex",
      line: 1,
      severity: "minor",
      evidence: { kind: "missing" },
      message: "the estimator is asserted, never defined",
    }),
    annotation({
      index: 2,
      id: "reviewer_c-1",
      dimension: "positioning",
      reviewer: "reviewer_c",
      severity: "info",
      line: 5,
      message: "the strongest baseline is not named",
    }),
  ],
  seats: [
    { reviewer: "reviewer_a", count: 1 },
    { reviewer: "reviewer_b", count: 1 },
    { reviewer: "reviewer_c", count: 1 },
  ],
  synthesis: {
    consensus: [
      {
        ids: ["reviewer_a-1", "reviewer_b-1"],
        note: "both read the design as thin",
      },
    ],
    disagreements: [],
  },
};

const text = (node: HTMLElement): string => node.textContent ?? "";

describe("the Review tab in panel mode (O25)", () => {
  it("groups the concerns by seat, in the order the seats are given", () => {
    const panel = renderReviewTab(PANEL, deps());
    const groups = [...panel.querySelectorAll(".lm-review-fold__summary")].map(
      (g) => g.textContent ?? "",
    );
    // The three seat headings come first, then the synthesis heading.
    expect(groups.slice(0, 3).map((g) => g.split(" ")[0])).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_c",
    ]);
    expect(groups[3]).toContain("Across the panel");
  });

  it("shows a seat that found nothing, rather than omitting it", () => {
    // No quota is the stage's rule: an empty lens is a finding.
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: [],
        seats: [
          { reviewer: "reviewer_a", count: 0 },
          { reviewer: "reviewer_b", count: 0 },
          {
            reviewer: "reviewer_c",
            count: 0,
            missing: {
              kind: "seat_missing",
              reviewer: "reviewer_c",
              reason: "unparsed",
            },
          },
        ],
      },
      deps(),
    );
    expect(text(panel)).toContain("raised no concern");
    expect(text(panel)).toContain("this reviewer's report could not be read");
  });

  it("carries the id, the blocking badge and the evidence line", () => {
    const panel = renderReviewTab(PANEL, deps());
    const details = [...panel.querySelectorAll(".lm-cite-row__detail")].map(
      (d) => d.textContent ?? "",
    );
    expect(details[0]).toContain("reviewer_a-1");
    expect(details[0]).toContain("blocking");
    expect(details[1]).not.toContain("blocking");
    const evidence = [...panel.querySelectorAll(".lm-cite-row__evidence")].map(
      (e) => e.textContent ?? "",
    );
    expect(evidence[0]).toBe("evidence · L3");
    expect(evidence[1]).toBe("no supporting passage in the manuscript");
    // The third concern carries no evidence key at all, so it renders none.
    expect(evidence).toHaveLength(2);
  });

  it("names the file only when the concern is NOT in the entry", () => {
    const panel = renderReviewTab(PANEL, deps());
    const details = [...panel.querySelectorAll(".lm-cite-row__detail")].map(
      (d) => d.textContent ?? "",
    );
    expect(details[0]).toContain("L4");
    expect(details[0]).not.toContain("main.tex");
    expect(details[1]).toContain("sections/method.tex:1");
  });

  it("renders the synthesis as a note with the ids it cites", () => {
    const panel = renderReviewTab(PANEL, deps());
    const note = panel.querySelector(".lm-review-note");
    expect(note?.textContent).toContain("both read the design as thin");
    const chips = [...panel.querySelectorAll(".lm-review-chip")].map(
      (c) => c.textContent ?? "",
    );
    expect(chips).toEqual(["reviewer_a-1", "reviewer_b-1"]);
  });

  it("renders each limit as one sentence, and none when there are none", () => {
    expect(PANEL.limits).toBeUndefined();
    expect(
      renderReviewTab(PANEL, deps()).querySelectorAll(".lm-review-limit"),
    ).toHaveLength(0);
    const limits: ReviewLimit[] = [
      {
        kind: "anchors_dropped",
        reviewer: "reviewer_b",
        anchors: [{ anchor: "x", role: "claim", reason: "not_found" }],
      },
      { kind: "seat_unguided", reviewer: "reviewer_a" },
      {
        kind: "source_unavailable",
        reviewer: "reviewer_c",
        source: "arxiv",
        status: "rate_limited",
      },
      { kind: "search_budget_spent", reviewer: "reviewer_c" },
      { kind: "synthesis_missing", reason: "insufficient_seats" },
    ];
    const rendered = [
      ...renderReviewTab({ ...PANEL, limits }, deps()).querySelectorAll(
        ".lm-review-limit",
      ),
    ].map((n) => n.textContent ?? "");
    expect(rendered).toEqual([
      "reviewer_b: 1 quote(s) from this reviewer could not be located",
      "reviewer_a: reviewed without the panel protocol",
      "reviewer_c: arxiv — rate-limited",
      "reviewer_c: the literature-search budget ran out",
      "no cross-panel reading was produced (too few reviewers reported)",
    ]);
  });

  it("points an anonymous source at the key command, per reader (R4)", () => {
    // By exception (ADR 0038): only a source that BOTH ran without a key and
    // did not answer earns the pointer, so a keyed source that was rate-limited
    // anyway reads exactly as it did before R4.
    const limits: ReviewLimit[] = [
      {
        kind: "source_unavailable",
        reviewer: "reviewer_c",
        source: "semantic_scholar",
        status: "rate_limited",
        anonymous: true,
      },
      {
        kind: "source_unavailable",
        reviewer: "reviewer_c",
        source: "arxiv",
        status: "timeout",
      },
    ];
    const lines = (locale: "en" | "zh") =>
      [
        ...renderReviewTab({ ...PANEL, limits }, deps(locale)).querySelectorAll(
          ".lm-review-limit",
        ),
      ].map((n) => n.textContent ?? "");
    expect(lines("en")).toEqual([
      "reviewer_c: semantic_scholar — rate-limited (no API key — Lemmaria: Set Semantic Scholar API Key)",
      "reviewer_c: arxiv — timed out",
    ]);
    expect(lines("zh")).toEqual([
      "reviewer_c: semantic_scholar — 触发限流（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
      "reviewer_c: arxiv — 超时",
    ]);
  });

  it("renders in the reader's language, one language at a time", () => {
    const zh = text(renderReviewTab(PANEL, deps("zh")));
    expect(zh).toContain("盲审小组");
    expect(zh).toContain("文中没有支持该判断的段落");
    expect(zh).not.toContain("no supporting passage");
    const en = text(renderReviewTab(PANEL, deps("en")));
    expect(en).not.toContain("盲审");
  });

  it("labels the ten known dimensions and passes an unknown one through", () => {
    for (const [dimension, label] of [
      ["soundness", "soundness"],
      ["claims", "claims"],
      ["clarity", "clarity"],
      ["positioning", "positioning"],
      // V2 (ADR 0078 6): the panel's two new dimensions. Without these rows
      // an `originality` concern would have rendered the bare word in BOTH
      // locales and this test would still have been green -- it checks the
      // labels it lists, and it listed seven.
      ["originality", "originality"],
      ["significance", "significance"],
      ["rigor", "rigor"],
      ["structure", "structure"],
      ["language", "language"],
      // V4 (ADR 0081 §1): the PDF reviewer's dimension.
      ["presentation", "presentation"],
    ] as const) {
      expect(dimensionLabel("en", dimension)).toBe(label);
      // Every one of them is translated — a zh reader sees no English label.
      expect(dimensionLabel("zh", dimension)).not.toBe(label);
    }
    // A user's own action may name anything; inventing a translation for a
    // word we have never seen would be worse than showing the word.
    expect(dimensionLabel("zh", "venue-fit")).toBe("venue-fit");
  });

  it("says WHY a review could not guard its own title, per reason, in both locales (V2 O22)", () => {
    // The code review's I1 third part: `own_title_unguarded` had no test in
    // the extension at all, so swapping the two arms -- or deleting one --
    // went unnoticed in en and zh alike.
    //
    // They are whole sentences per reason rather than a shared stem plus a
    // reason word, because they say different things to an author: the title
    // could not be read at all, versus the guard was never wired.
    const noTitle: ReviewLimit = {
      kind: "own_title_unguarded",
      reason: "no_title",
    };
    const unavailable: ReviewLimit = {
      kind: "own_title_unguarded",
      reason: "unavailable",
    };
    expect(limitSentence("en", noTitle)).toBe(
      "could not read the manuscript's title, so a literature search may have returned this paper itself",
    );
    expect(limitSentence("en", unavailable)).toBe(
      "could not keep literature searches from returning this paper itself",
    );
    // The two must not be the same sentence in either locale -- that is the
    // failure a swap or a shared stem would produce.
    expect(limitSentence("en", noTitle)).not.toBe(
      limitSentence("en", unavailable),
    );
    expect(limitSentence("zh", noTitle)).not.toBe(
      limitSentence("zh", unavailable),
    );
    // And each is translated: a zh reader sees no English sentence.
    expect(limitSentence("zh", noTitle)).not.toBe(limitSentence("en", noTitle));
    expect(limitSentence("zh", unavailable)).not.toBe(
      limitSentence("en", unavailable),
    );
    expect(limitSentence("zh", noTitle)).toContain("标题");
  });

  it("says why the compiled PDF was not reviewed, one sentence per reason, in both locales (V4 O19)", () => {
    const limits: ReviewLimit[] = [
      { kind: "pdf_unavailable", reason: "none" },
      { kind: "pdf_unavailable", reason: "stale" },
      {
        kind: "pdf_unavailable",
        reason: "compile_failed",
        detail: "! LaTeX Error",
      },
      { kind: "pdf_unavailable", reason: "render_failed" },
      { kind: "visual_unavailable", reason: "model_has_no_image_input" },
      { kind: "visual_unavailable", reason: "no_renderer" },
    ];
    for (const locale of ["en", "zh"] as const) {
      const sentences = limits.map((l) => limitSentence(locale, l));
      // Six reasons, six different sentences — a swapped or shared arm
      // collapses two of them.
      expect(new Set(sentences).size, locale).toBe(limits.length);
      // A failed compile's log tail is the record's, never the reader's.
      for (const s of sentences) expect(s).not.toContain("LaTeX Error");
    }
    expect(limitSentence("en", limits[0] as ReviewLimit)).toBe(
      "the compiled PDF was not reviewed: no PDF was found beside the entry file and none could be compiled",
    );
    expect(limitSentence("zh", limits[4] as ReviewLimit)).toBe(
      "未评审已编译 PDF：PDF 评审人的模型不接受图像",
    );
  });

  it("fills both slots of pages_unviewed, in both locales (V4 O19)", () => {
    const limit: ReviewLimit = { kind: "pages_unviewed", viewed: 2, total: 3 };
    expect(limitSentence("en", limit)).toBe(
      "the PDF reviewer viewed 2 of 3 pages",
    );
    expect(limitSentence("zh", limit)).toBe("PDF 评审人查看了 3 页中的 2 页");
  });

  it("builds a limit sentence from the record's fields, in both locales", () => {
    const limit: ReviewLimit = {
      kind: "seat_missing",
      reviewer: "reviewer_b",
      reason: "interrupted",
      detail: "model-facing English that must never be rendered",
    };
    expect(limitSentence("en", limit)).toBe(
      "reviewer_b: reported nothing usable (stopped)",
    );
    expect(limitSentence("zh", limit)).toBe(
      "reviewer_b: 未给出可用意见 (被停止)",
    );
    // The record's `detail` is model-facing English — never shown to a reader.
    expect(limitSentence("zh", limit)).not.toContain("model-facing");
  });

  it("renders entries_rejected as one sentence, in both locales, and never prints a reason (X5 O14)", () => {
    const limit: ReviewLimit = {
      kind: "entries_rejected",
      reviewer: "reviewer_a",
      entries: [
        { index: 2, reason: '"severity" must be one of: info, minor, major' },
        { index: 5, reason: '"message" must be a non-empty string' },
      ],
    };
    expect(limitSentence("en", limit)).toBe(
      "reviewer_a: 2 entries of its report were malformed and were not recorded",
    );
    expect(limitSentence("zh", limit)).toBe(
      "reviewer_a：其报告中有 2 条意见格式有误，未被记录",
    );
    // `reason` is the interpreter's own model-facing English (invariant 6
    // rule 2): it feeds the record and the one re-ask, never a reader.
    for (const locale of ["en", "zh"] as const) {
      expect(limitSentence(locale, limit)).not.toContain("severity");
      expect(limitSentence(locale, limit)).not.toContain("non-empty");
    }
  });

  it("says a single rejected entry in the singular (X6 O15; X5's known limit (a))", () => {
    const limit: ReviewLimit = {
      kind: "entries_rejected",
      reviewer: "reviewer_a",
      entries: [{ index: 1, reason: '"message" must be a non-empty string' }],
    };
    expect(limitSentence("en", limit)).toBe(
      "reviewer_a: 1 entry of its report was malformed and was not recorded",
    );
    // Chinese has no number agreement: the one sentence serves both counts.
    expect(limitSentence("zh", limit)).toBe(
      "reviewer_a：其报告中有 1 条意见格式有误，未被记录",
    );
  });

  it("V1 O23: says, per reason, that concerns were not checked — in both locales", () => {
    const sentence = (
      locale: "en" | "zh",
      reason: Extract<ReviewLimit, { kind: "verification_missing" }>["reason"],
    ) =>
      limitSentence(locale, {
        kind: "verification_missing",
        reason,
        detail: "model-facing English that must never be rendered",
      });
    expect(sentence("en", "off")).toBe(
      "concerns were not checked against the manuscript: verification is turned off",
    );
    expect(sentence("zh", "off")).toBe("未对照稿件核查意见：核查已关闭");
    expect(sentence("en", "no_protocol")).toBe(
      "concerns were not checked against the manuscript: the verification skill is not available",
    );
    expect(sentence("zh", "no_protocol")).toBe(
      "未对照稿件核查意见：核查技能不可用",
    );
    expect(sentence("en", "incomplete")).toBe(
      "some concerns were not checked against the manuscript",
    );
    expect(sentence("zh", "incomplete")).toBe("部分意见未对照稿件核查");
    // The four child-level reasons compose with the existing reason words,
    // exactly as `synthesis_missing` does — and none silently reads "failed".
    expect(sentence("en", "failed")).toBe(
      "concerns were not checked against the manuscript (failed)",
    );
    expect(sentence("en", "interrupted")).toBe(
      "concerns were not checked against the manuscript (stopped)",
    );
    expect(sentence("en", "unparsed")).toBe(
      "concerns were not checked against the manuscript (unreadable)",
    );
    expect(sentence("en", "no_report")).toBe(
      "concerns were not checked against the manuscript (no report)",
    );
    expect(sentence("zh", "no_report")).toBe("未对照稿件核查意见 (没有报告)");
    for (const locale of ["en", "zh"] as const) {
      expect(sentence(locale, "failed")).not.toContain("model-facing");
    }
  });
});

describe("the Review tab in quick mode (O26)", () => {
  const QUICK: ReviewTabState = {
    available: true,
    mode: "quick",
    file: "main.tex",
    entry: "main.tex",
    nextEntry: "main.tex",
    annotations: [
      annotation({
        id: "writing-1",
        reviewer: "writing",
        dimension: "language",
        severity: "minor",
        message: "Subject–verb agreement.",
        line: 5,
        hasSuggestion: true,
        suggestion: "They have been adopted",
      }),
    ],
  };

  it("renders the file, the count and the row, with no panel furniture", () => {
    const panel = renderReviewTab(QUICK, deps());
    expect(panel.querySelector(".lm-cite-title")?.textContent).toBe("main.tex");
    expect(panel.querySelector(".lm-cite-sub")?.textContent).toBe(
      "1 to review",
    );
    // No seat groups, no synthesis, no limits — a quick review has none.
    expect(panel.querySelectorAll(".lm-review-fold")).toHaveLength(0);
    // ONE entry row, and it is the launcher's (ADR 0064 §1), not a fact about
    // this review. This assertion read `toHaveLength(0)` until ADR 0064: which
    // file the paper starts at stopped being a panel's fact and became the
    // project's, so it is named in every mode — the launcher is how the NEXT
    // panel is aimed, and a quick review is no reason to hide it.
    expect(panel.querySelectorAll(".lm-review-entry")).toHaveLength(1);
    expect(panel.querySelectorAll(".lm-review-launch")).toHaveLength(1);
    // And no picker: this window holds one review (ADR 0062 §1).
    expect(panel.querySelectorAll(".lm-review-picker")).toHaveLength(0);
    expect(panel.querySelectorAll(".lm-review-note")).toHaveLength(0);
    expect(panel.querySelectorAll(".lm-review-limit")).toHaveLength(0);
    // And no evidence line: the quick action's prompt never asks for one.
    expect(panel.querySelectorAll(".lm-cite-row__evidence")).toHaveLength(0);
  });

  it("offers a copyedit's three actions, and calls back by index", () => {
    // ADR 0063 §2: this row is `language` AND carries a suggestion, so it is a
    // copyedit — Adopt fix, and NO *Resolve with assistant*. Handing a typo to
    // a model to reason about is the wrong tool for it, and offering both
    // would make the reader choose between two fix paths for one typo.
    calls.length = 0;
    const panel = renderReviewTab(QUICK, deps());
    // Scoped to the ROW since ADR 0064 — the launcher above it owns two
    // buttons of its own, and this assertion is about a concern's fix path.
    const buttons = [
      ...(panel.querySelector(".lm-cite-row")?.querySelectorAll("button") ??
        []),
    ];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Adopt fix",
      "Ignore",
      "Chat about it",
    ]);
    for (const b of buttons) b.click();
    panel.querySelector<HTMLElement>(".lm-cite-row")?.click();
    expect(calls).toEqual([
      "adopt:0",
      "ignore:0",
      "chat:writing-1",
      "reveal:0",
    ]);
  });

  it("keeps the copyedit GROUP out of quick mode, flat as it always was", () => {
    // ADR 0063 §2's D9 call: the grouping is panel furniture. A quick review
    // that found one wording nit must not fold its only finding away.
    const panel = renderReviewTab(QUICK, deps());
    expect(panel.querySelectorAll(".lm-review-fold")).toHaveLength(0);
    expect(panel.querySelectorAll(".lm-cite-row")).toHaveLength(1);
  });

  it("says L<n>, not the entry path, when the entry is NOT at the root", () => {
    // The header is a BASENAME in quick mode, so comparing a row's file
    // against it would print `sections/intro.tex:5` under a header reading
    // `intro.tex` — the redundant form for the one file the review is of.
    const nested = renderReviewTab(
      {
        ...QUICK,
        file: "intro.tex",
        entry: "sections/intro.tex",
        annotations: [
          annotation({
            id: "writing-1",
            reviewer: "writing",
            file: "sections/intro.tex",
            line: 5,
          }),
        ],
      },
      deps(),
    );
    const detail = nested.querySelector(".lm-cite-row__detail")?.textContent;
    expect(detail).toContain("L5");
    expect(detail).not.toContain("sections/intro.tex");
  });

  it("renders no limits section, even when the state carries limits", () => {
    // D9 pins quick mode to what it rendered before R3, and it never showed
    // an honesty record. The state carries one regardless (the quick action
    // has produced `anchors_dropped` since R2), so this is the tab's choice
    // and the open question's single switch.
    const limits: ReviewLimit[] = [
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [{ anchor: "x", role: "claim", reason: "not_found" }],
      },
    ];
    const quick = renderReviewTab({ ...QUICK, limits }, deps());
    expect(quick.querySelectorAll(".lm-review-limit")).toHaveLength(0);
    expect(text(quick)).not.toContain("could not do");
    // The same limits DO render in panel mode — the mode is what differs.
    expect(
      renderReviewTab({ ...PANEL, limits }, deps()).querySelectorAll(
        ".lm-review-limit",
      ),
    ).toHaveLength(1);
  });

  it("renders the empty state when no review has run", () => {
    const empty = renderReviewTab(undefined, deps());
    // ADR 0064 §2 rewrote the hint: it named only the quick action, which
    // contradicted the Run button the launcher now puts above it.
    expect(empty.querySelector(".lm-cite-empty")?.textContent).toContain(
      "select text in a .tex or .md file",
    );
    expect(empty.querySelector(".lm-cite-empty")?.textContent).toContain(
      "blind panel",
    );
    // `undefined` state = the host has pushed nothing yet, so there is nothing
    // to aim: no launcher until the first `reviewState` arrives.
    expect(empty.querySelectorAll(".lm-review-launch")).toHaveLength(0);
  });
});

/**
 * The R3 gate-review round (ADR 0062). Every item below is something the
 * operator saw at a real rendering and asked for; each one has an offline half,
 * which is this.
 */
describe("the Review tab after the gate-review round (ADR 0062)", () => {
  it("says the panel read the whole manuscript, and names the entry as the entry", () => {
    // §3. The header used to be `Blind panel · main.tex`, which reads as a
    // review OF that file — and the panel reads every file the workspace lists.
    const panel = renderReviewTab(PANEL, deps());
    expect(panel.querySelector(".lm-cite-title")?.textContent).toBe(
      "Blind panel · whole manuscript",
    );
    const entry = panel.querySelector(".lm-review-entry");
    expect(entry?.textContent).toContain("main file");
    expect(entry?.textContent).toContain("main.tex");
  });

  it("offers the entry picker from the header", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    panel.querySelector<HTMLButtonElement>(".lm-review-entry__change")?.click();
    expect(calls).toEqual(["entry"]);
  });

  it("draws no version picker for one review, and one for two", () => {
    // §1. A select with a single option is a control that cannot be operated.
    const one = renderReviewTab(
      {
        ...PANEL,
        history: [
          {
            id: 0,
            mode: "panel",
            version: 1,
            at: 0,
            file: "main.tex",
            concerns: 3,
          },
        ],
        selected: 0,
      },
      deps(),
    );
    expect(one.querySelectorAll(".lm-review-picker")).toHaveLength(0);

    const at =
      Date.UTC(2026, 8, 4, 12) + new Date().getTimezoneOffset() * 60000;
    const two = renderReviewTab(
      {
        ...PANEL,
        history: [
          {
            id: 0,
            mode: "panel",
            version: 1,
            at,
            file: "main.tex",
            concerns: 3,
          },
          {
            id: 1,
            mode: "panel",
            version: 2,
            at,
            file: "main.tex",
            concerns: 1,
          },
        ],
        selected: 1,
      },
      deps(),
    );
    const select = two.querySelector<HTMLSelectElement>(".lm-review-picker");
    expect(select).not.toBeNull();
    // Newest first, and the selected one is the one showing.
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual([
      "v2 · 2026-09-04 · 1 concern(s)",
      "v1 · 2026-09-04 · 3 concern(s)",
    ]);
    expect(select?.value).toBe("1");
  });

  it("names a quick review by its file and a panel by its version", () => {
    const at =
      Date.UTC(2026, 8, 4, 12) + new Date().getTimezoneOffset() * 60000;
    const zh = renderReviewTab(
      {
        ...PANEL,
        history: [
          { id: 0, mode: "quick", at, file: "intro.tex", concerns: 2 },
          {
            id: 1,
            mode: "panel",
            version: 1,
            at,
            file: "main.tex",
            concerns: 3,
          },
        ],
        selected: 1,
      },
      deps("zh"),
    );
    expect(
      [
        ...(zh.querySelector<HTMLSelectElement>(".lm-review-picker")?.options ??
          []),
      ].map((o) => o.textContent),
    ).toEqual([
      "第1版 · 2026-09-04 · 3 条意见",
      "选区审稿 · intro.tex · 2026-09-04 · 2 条意见",
    ]);
  });

  it("switches review when the picker changes", () => {
    calls.length = 0;
    const at = 0;
    const panel = renderReviewTab(
      {
        ...PANEL,
        history: [
          {
            id: 0,
            mode: "panel",
            version: 1,
            at,
            file: "main.tex",
            concerns: 3,
          },
          {
            id: 1,
            mode: "panel",
            version: 2,
            at,
            file: "main.tex",
            concerns: 1,
          },
        ],
        selected: 1,
      },
      deps(),
    );
    const select = panel.querySelector<HTMLSelectElement>(".lm-review-picker");
    if (select) {
      select.value = "0";
      select.dispatchEvent(new Event("change"));
    }
    expect(calls).toEqual(["select:0"]);
  });

  it("folds every group, with the seats open and the archive closed", () => {
    // §4/§5. Open by default is the point: a panel that arrives collapsed
    // hides the review it just paid for.
    folds.clear();
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: PANEL.annotations.map((a, i) =>
          i === 2 ? { ...a, status: "handed" as const } : a,
        ),
      },
      deps(),
    );
    const folded = [
      ...panel.querySelectorAll<HTMLDetailsElement>(".lm-review-fold"),
    ];
    const byTitle = new Map(
      folded.map((f) => [
        f.querySelector(".lm-review-fold__summary")?.textContent ?? "",
        f.open,
      ]),
    );
    expect([...byTitle.values()].filter((o) => o)).not.toHaveLength(0);
    expect(byTitle.get("Archived · 1")).toBe(false);
    for (const [title, open] of byTitle)
      if (!title.startsWith("Archived")) expect(open).toBe(true);
  });

  it("reports a fold the reader closed, keyed by group", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    const first = panel.querySelector<HTMLDetailsElement>(".lm-review-fold");
    if (first) {
      first.open = false;
      first.dispatchEvent(new Event("toggle"));
    }
    expect(calls).toEqual(["fold:seat:reviewer_a:false"]);
  });

  it("archives accepted, ignored and handed into ONE list, each saying which", () => {
    // §5. Three verbs, one place to look — and the row keeps its own word.
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: [
          {
            ...annotation({ index: 0, id: "reviewer_a-1" }),
            status: "accepted",
          },
          {
            ...annotation({
              index: 1,
              id: "reviewer_b-1",
              reviewer: "reviewer_b",
            }),
            status: "ignored",
          },
          {
            ...annotation({
              index: 2,
              id: "reviewer_c-1",
              reviewer: "reviewer_c",
            }),
            status: "handed",
          },
        ],
      },
      deps(),
    );
    const archive = [...panel.querySelectorAll(".lm-review-fold")].find((f) =>
      (
        f.querySelector(".lm-review-fold__summary")?.textContent ?? ""
      ).startsWith("Archived"),
    );
    expect(archive).toBeDefined();
    const words = [
      ...(archive?.querySelectorAll(".lm-cite-row__detail") ?? []),
    ].map((d) => (d.textContent ?? "").split(" · ")[0]);
    expect(words).toEqual(["accepted", "ignored", "with the assistant"]);
    // And nothing archived is still offered a triage button.
    expect(archive?.querySelectorAll("button")).toHaveLength(0);
  });

  it("gives every concern its own outlined card, addressable by id", () => {
    const panel = renderReviewTab(PANEL, deps());
    const ids = [...panel.querySelectorAll(".lm-review-card")].map((n) =>
      n.getAttribute("data-concern"),
    );
    expect(ids).toEqual(["reviewer_a-1", "reviewer_b-1", "reviewer_c-1"]);
  });

  it("jumps to the concern a synthesis chip cites, opening its group first", () => {
    // §7. The chip named a real concern and left the reader to find it.
    folds.clear();
    folds.set("seat:reviewer_b", false); // the reader had closed that reviewer
    const panel = renderReviewTab(PANEL, deps());
    const chip = [
      ...panel.querySelectorAll<HTMLButtonElement>(".lm-review-chip--link"),
    ].find((c) => c.textContent === "reviewer_b-1");
    expect(chip).toBeDefined();
    const target = panel.querySelector('[data-concern="reviewer_b-1"]');
    const fold = target?.closest("details") as HTMLDetailsElement | null;
    expect(fold?.open).toBe(false);
    chip?.click();
    expect(fold?.open).toBe(true);
    expect(target?.classList.contains("is-target")).toBe(true);
    // Exactly one row is the target — a second jump moves the mark.
    expect(panel.querySelectorAll(".is-target")).toHaveLength(1);
  });
});

describe("the copyedit split and the agentic Resolve (ADR 0063)", () => {
  /** The panel above, plus two `language` concerns raised by two different
   *  seats — one with a fix to adopt, one without. */
  const WITH_COPYEDITS: ReviewTabState = {
    ...PANEL,
    annotations: [
      ...PANEL.annotations,
      annotation({
        index: 3,
        id: "reviewer_a-2",
        reviewer: "reviewer_a",
        dimension: "language",
        severity: "minor",
        message: "They has been adopted.",
        hasSuggestion: true,
        suggestion: "They have been adopted",
      }),
      annotation({
        index: 4,
        id: "reviewer_b-2",
        reviewer: "reviewer_b",
        dimension: "language",
        severity: "minor",
        message: "this sentence reads awkwardly, but I have no rewrite",
        hasSuggestion: false,
      }),
    ],
    seats: [
      { reviewer: "reviewer_a", count: 2 },
      { reviewer: "reviewer_b", count: 2 },
      { reviewer: "reviewer_c", count: 1 },
    ],
  };

  const summaries = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll(".lm-review-fold__summary")].map(
      (n) => n.textContent ?? "",
    );

  const concernsIn = (root: Element | undefined): (string | null)[] =>
    [...(root?.querySelectorAll("[data-concern]") ?? [])].map((n) =>
      n.getAttribute("data-concern"),
    );

  const foldNamed = (
    panel: HTMLElement,
    prefix: string,
  ): HTMLDetailsElement | undefined =>
    [...panel.querySelectorAll("details")].find((d) =>
      (
        d.querySelector(".lm-review-fold__summary")?.textContent ?? ""
      ).startsWith(prefix),
    );

  const buttonsOf = (panel: HTMLElement, id: string): string[] =>
    [
      ...(panel
        .querySelector(`[data-concern="${id}"]`)
        ?.querySelectorAll("button") ?? []),
    ].map((b) => b.textContent ?? "");

  it("lifts a language concern WITH a fix out of its seat group", () => {
    const panel = renderReviewTab(WITH_COPYEDITS, deps());
    const copyedit = foldNamed(panel, "Copyedit");
    expect(copyedit).toBeDefined();
    // Exactly the one with a suggestion. `reviewer_b-2` is `language` too and has
    // no fix behind it, so it is NOT a copyedit — an Adopt fix with nothing to
    // adopt is a button that cannot be operated.
    expect(concernsIn(copyedit)).toEqual(["reviewer_a-2"]);
    // And it is gone from the seat group that raised it.
    expect(concernsIn(foldNamed(panel, "reviewer_a"))).toEqual([
      "reviewer_a-1",
    ]);
  });

  it("closes the copyedit group and puts it after the seats", () => {
    const panel = renderReviewTab(WITH_COPYEDITS, deps());
    const order = summaries(panel);
    expect(order[0]?.startsWith("reviewer_a")).toBe(true);
    expect(order.indexOf("Copyedit · 1")).toBe(3);
    // Closed on arrival — the one exception to ADR 0062 §4, and the count in
    // the heading is what makes it honest.
    expect(foldNamed(panel, "Copyedit")?.open).toBe(false);
    // The seats are still open, so nothing else moved.
    expect(foldNamed(panel, "reviewer_a")?.open).toBe(true);
  });

  it("gives a copyedit Adopt fix and a concern Resolve with assistant", () => {
    const panel = renderReviewTab(WITH_COPYEDITS, deps());
    expect(buttonsOf(panel, "reviewer_a-2")).toEqual([
      "Adopt fix",
      "Ignore",
      "Chat about it",
    ]);
    // A substantive concern: NO Adopt at all, even though the fix path used to
    // offer one whenever a suggestion existed.
    expect(buttonsOf(panel, "reviewer_a-1")).toEqual([
      "Resolve with assistant",
      "Ignore",
      "Chat about it",
    ]);
    // A `language` concern with no fix behind it is substantive, by the same
    // rule that kept it out of the group.
    expect(buttonsOf(panel, "reviewer_b-2")).toEqual([
      "Resolve with assistant",
      "Ignore",
      "Chat about it",
    ]);
  });

  it("hands the whole annotation to resolve, not an index", () => {
    // The prompt is composed from the concern's message, location, evidence
    // and suggested wording, so the callback needs the annotation itself.
    calls.length = 0;
    const panel = renderReviewTab(WITH_COPYEDITS, deps());
    const row = panel.querySelector('[data-concern="reviewer_a-1"]');
    [...(row?.querySelectorAll("button") ?? [])][0]?.click();
    expect(calls).toEqual(["resolve:reviewer_a-1"]);
  });

  it("counts what each group SHOWS, and everything in the sub-line", () => {
    const panel = renderReviewTab(WITH_COPYEDITS, deps());
    // reviewer_a raised 2 and shows 1 — the other is in Copyedit. A heading
    // saying 2 over one row sends the reader hunting.
    expect(summaries(panel)[0]).toBe("reviewer_a · 1 concern(s)");
    // reviewer_b raised 2 and shows 2: its `language` concern had no fix, so it
    // never left.
    expect(summaries(panel)[1]).toBe("reviewer_b · 2 concern(s)");
    // The sub-line counts the copyedits too: a typo folded away is still a
    // typo the author has to deal with.
    expect(panel.querySelector(".lm-cite-sub")?.textContent).toBe(
      "5 to review",
    );
  });

  it("renders the split in the reader's language", () => {
    const panel = renderReviewTab(WITH_COPYEDITS, deps("zh"));
    expect(summaries(panel)).toContain("文字校对 · 1");
    expect(buttonsOf(panel, "reviewer_a-2")).toEqual([
      "采纳修改",
      "忽略",
      "与助手讨论",
    ]);
    expect(buttonsOf(panel, "reviewer_a-1")).toEqual([
      "交给助手处理",
      "忽略",
      "与助手讨论",
    ]);
  });

  it("draws no copyedit group when the panel raised none", () => {
    const panel = renderReviewTab(PANEL, deps());
    expect(summaries(panel).some((x) => x.startsWith("Copyedit"))).toBe(false);
  });

  it("still lets a synthesis chip jump INTO the copyedit group", () => {
    // §7's chips cite by id, and a copyedit has an id like any other concern —
    // so the closed group has to open the same way a collapsed seat does.
    const panel = renderReviewTab(
      {
        ...WITH_COPYEDITS,
        synthesis: {
          consensus: [{ ids: ["reviewer_a-2"], note: "both saw the typo" }],
          disagreements: [],
        },
      },
      deps(),
    );
    const fold = foldNamed(panel, "Copyedit");
    expect(fold?.open).toBe(false);
    panel.querySelector<HTMLElement>(".lm-review-chip--link")?.click();
    expect(fold?.open).toBe(true);
    expect(
      panel
        .querySelector('[data-concern="reviewer_a-2"]')
        ?.classList.contains("is-target"),
    ).toBe(true);
  });
});

describe("the launcher at the top of the tab (ADR 0064)", () => {
  const launch = (p: HTMLElement) =>
    p.querySelector<HTMLElement>(".lm-review-launch");
  const runButton = (p: HTMLElement) =>
    p.querySelector<HTMLButtonElement>(".lm-review-launch__run");

  it("renders BEFORE any review has run — the whole point of the move", () => {
    // ADR 0062 §2 put Change inside the results, so the only way to reach it
    // was to review the wrong document first.
    const panel = renderReviewTab(
      {
        available: false,
        mode: "quick",
        file: "",
        entry: "",
        nextEntry: "paper/main.tex",
        annotations: [],
      },
      deps(),
    );
    expect(text(launch(panel) as HTMLElement)).toContain("paper/main.tex");
    expect(runButton(panel)?.textContent).toBe("Run blind panel");
    // And the empty hint is still there, under it, now naming both routes.
    expect(text(panel)).toContain("blind panel over the whole manuscript");
  });

  it("names the NEXT entry, not the shown review's", () => {
    const panel = renderReviewTab(
      { ...PANEL, entry: "main.tex", nextEntry: "supplement.tex" },
      deps(),
    );
    expect(text(launch(panel) as HTMLElement)).toContain("supplement.tex");
    expect(text(launch(panel) as HTMLElement)).not.toContain("main.tex");
  });

  it("says which entry the shown review read when the two disagree", () => {
    const panel = renderReviewTab(
      { ...PANEL, entry: "main.tex", nextEntry: "supplement.tex" },
      deps(),
    );
    expect(text(panel)).toContain("this review read main.tex");
  });

  it("stays silent about it when they agree — the ordinary case", () => {
    const panel = renderReviewTab(PANEL, deps());
    expect(text(panel)).not.toContain("this review read");
  });

  it("shows a detected-nothing entry as such, not as a blank", () => {
    const panel = renderReviewTab({ ...PANEL, nextEntry: "" }, deps());
    expect(text(launch(panel) as HTMLElement)).toContain("not detected");
  });

  it("runs a panel on click", () => {
    // The reader STAYS here (ADR 0065 §3): the progress is drawn in this tab
    // now, so ADR 0064 §2's switch to the Assistant would walk them away from
    // the thing they just started. `selectTab` is `main.ts`'s and no longer
    // fires, which is asserted where it lives.
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    runButton(panel)?.click();
    expect(calls).toEqual(["run"]);
  });

  it("keeps Change reachable with no entry detected", () => {
    // NOT disabled: `lemmaria.selectPaperEntry` answers a folderless window
    // with a warning that says why, and a dead button says nothing at all.
    calls.length = 0;
    const panel = renderReviewTab({ ...PANEL, nextEntry: "" }, deps());
    panel.querySelector<HTMLButtonElement>(".lm-review-entry__change")?.click();
    expect(calls).toEqual(["entry"]);
  });

  it("draws exactly ONE Change button — the results row lost its own", () => {
    const panel = renderReviewTab(PANEL, deps());
    expect(panel.querySelectorAll(".lm-review-entry__change").length).toBe(1);
  });

  it("is drawn in quick mode too, and carries no per-review entry note", () => {
    // The entry is a fact about the PROJECT, not about the review on screen —
    // so the launcher does not care which kind of review produced the results.
    // A quick review's own entry is incidental to a selection, so no note.
    const panel = renderReviewTab(
      {
        available: true,
        mode: "quick",
        file: "intro.tex",
        entry: "sections/intro.tex",
        nextEntry: "main.tex",
        annotations: [],
      },
      deps(),
    );
    expect(text(launch(panel) as HTMLElement)).toContain("main.tex");
    expect(text(panel)).not.toContain("this review read");
  });

  it("renders in Chinese", () => {
    const panel = renderReviewTab(
      { ...PANEL, entry: "main.tex", nextEntry: "supplement.tex" },
      deps("zh"),
    );
    expect(runButton(panel)?.textContent).toBe("运行盲审小组");
    expect(text(launch(panel) as HTMLElement)).toContain("主文件");
    expect(text(panel)).toContain("本次审稿读取的是 main.tex");
  });
});

describe("the panel runs inside the tab (ADR 0065 §3)", () => {
  const launch = (p: HTMLElement) =>
    p.querySelector<HTMLElement>(".lm-review-launch");
  const runButton = (p: HTMLElement) =>
    p.querySelector<HTMLButtonElement>(".lm-review-launch__run");
  const live: ReviewRunView = {
    running: true,
    item: {
      id: "r1",
      type: "review",
      status: "running",
      skill: "blind-reviewer",
      version: 4,
      seats: [
        {
          reviewer: "reviewer_a",
          status: "completed",
          model: "claude-sonnet-4-5",
        },
        {
          reviewer: "reviewer_b",
          status: "running",
          model: "claude-sonnet-4-5",
        },
      ],
      synthesis: "pending",
    },
    notices: [],
  };

  it("draws the running panel inside the launcher, not in the transcript", () => {
    // ADR 0061 §9 put this in the composer's transcript, because the panel was
    // a task of the chat. It is not one any more, so the account of it belongs
    // to the surface the review belongs to.
    const panel = renderReviewTab(PANEL, deps("en", live));
    const block = launch(panel)?.querySelector(".lm-review-progress");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("v4");
    expect(block?.querySelectorAll(".lm-review-chip").length).toBe(3);
  });

  it("draws it before any review has run, where there is no tab content at all", () => {
    // The first panel a workspace ever runs has nothing below it — and that is
    // exactly the reader who most needs to see that something is happening.
    const panel = renderReviewTab(
      {
        available: false,
        mode: "quick",
        file: "",
        entry: "",
        nextEntry: "main.tex",
        annotations: [],
      },
      deps("en", live),
    );
    expect(panel.querySelector(".lm-review-progress")).not.toBeNull();
  });

  it("refuses a second panel while one runs, and says why", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps("en", live));
    const run = runButton(panel);
    expect(run?.disabled).toBe(true);
    // NOT "finish the running task first": ADR 0064 §3's reason (a send during
    // a task becomes steering) went away with ADR 0065 §2. What is refused is
    // a second REVIEW — two would spend twice and race for the version number.
    expect(run?.title).toBe("A review is already running");
    run?.click();
    expect(calls).toEqual([]);
  });

  it("offers Run while a CHAT task runs — the two are independent now", () => {
    // The decisive case. `deps` no longer carries a session-busy flag at all,
    // so there is nothing a running conversation can do to this button.
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    const run = runButton(panel);
    expect(run?.disabled).toBe(false);
    run?.click();
    expect(calls).toEqual(["run"]);
  });

  it("stops the running panel from the tab", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps("en", live));
    panel.querySelector<HTMLButtonElement>(".lm-review-stop")?.click();
    expect(calls).toEqual(["stop"]);
  });

  it("keeps a run that produced nothing on screen, with its reason", () => {
    const refused: ReviewRunView = {
      running: false,
      item: {
        id: "r1",
        type: "review",
        status: "failed",
        skill: "blind-reviewer",
        seats: [],
      },
      notices: ["No manuscript in this window."],
    };
    const panel = renderReviewTab(PANEL, deps("en", refused));
    expect(text(panel)).toContain("The panel did not run.");
    expect(text(panel)).toContain("No manuscript in this window.");
    // And Run is offered again: nothing is in flight.
    expect(runButton(panel)?.disabled).toBe(false);
  });

  it("draws no progress block when nothing is running", () => {
    const panel = renderReviewTab(PANEL, deps());
    expect(panel.querySelector(".lm-review-progress")).toBeNull();
    expect(panel.querySelector(".lm-review-stop")).toBeNull();
  });

  it("renders the running panel in Chinese", () => {
    const panel = renderReviewTab(PANEL, deps("zh", live));
    expect(text(panel)).toContain("正在通读全文");
    expect(
      panel.querySelector<HTMLButtonElement>(".lm-review-stop")?.textContent,
    ).toBe("停止");
    expect(text(panel)).not.toContain("reading the manuscript");
  });
});

/**
 * O14: the seat header after R9 (ADR 0069 §D8) — who reviewed, on what, and
 * how many concerns they raised.
 *
 * The model segment is what makes a mixed panel readable: two reviewers
 * agreeing means one thing when they are the same model and another when they
 * are not, and the header is where a reader finds out which.
 */
describe("the Review tab names each reviewer's model (O14)", () => {
  const headings = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        ".lm-review-fold__summary",
      ),
    ].map((g) => g.textContent ?? "");

  it("puts the model between the reviewer and the count", () => {
    expect(
      headings({
        ...PANEL,
        seats: [
          { reviewer: "reviewer_a", count: 1, model: "claude-sonnet-4-5" },
          { reviewer: "reviewer_b", count: 1, model: "gpt-5.6-luna" },
          { reviewer: "reviewer_c", count: 1, model: "claude-sonnet-4-5" },
        ],
      }).slice(0, 3),
    ).toEqual([
      "reviewer_a · claude-sonnet-4-5 · 1 concern(s)",
      "reviewer_b · gpt-5.6-luna · 1 concern(s)",
      "reviewer_c · claude-sonnet-4-5 · 1 concern(s)",
    ]);
  });

  it("names the model on a reviewer that raised nothing, and on one that failed", () => {
    // Knowing WHICH model produced nothing is the point of a mixed panel, so
    // the model segment is not something only the ordinary branch gets.
    const said = headings({
      ...PANEL,
      annotations: [],
      seats: [
        { reviewer: "reviewer_a", count: 0, model: "gpt-5.6-luna" },
        {
          reviewer: "reviewer_b",
          count: 0,
          model: "claude-sonnet-4-5",
          missing: {
            kind: "seat_missing",
            reviewer: "reviewer_b",
            reason: "unparsed",
          },
        },
      ],
    });
    expect(said[0]).toBe("reviewer_a · gpt-5.6-luna — raised no concern");
    expect(said[1]).toBe(
      "reviewer_b · claude-sonnet-4-5 — this reviewer's report could not be read",
    );
  });

  it("marks an unverified model by exception, in both locales", () => {
    // ADR 0023: two verdicts, no `below`. A reviewer outside the declared L2
    // floor is still run and still reported — the header just says so, where
    // the reader is weighing what that reviewer said.
    const seats = [
      { reviewer: "reviewer_a", count: 1, model: "local-8b", unverified: true },
      { reviewer: "reviewer_b", count: 1, model: "gpt-5.6-luna" },
      { reviewer: "reviewer_c", count: 1, model: "claude-sonnet-4-5" },
    ] as const;
    const en = headings({ ...PANEL, seats: [...seats] });
    expect(en[0]).toContain("local-8b (unverified)");
    expect(en[1]).not.toContain("unverified");
    const zh = headings({ ...PANEL, seats: [...seats] }, "zh");
    expect(zh[0]).toContain("local-8b（未验证）");
    expect(zh[0]).not.toContain("unverified");
  });

  it("omits the segment for a review recorded before R9", () => {
    // A22: replay normalizes a pre-R9 seat's model to `""`, and there is no
    // migration path that could invent one. The header simply says less.
    expect(
      headings({
        ...PANEL,
        seats: [
          { reviewer: "reviewer_a", count: 1 },
          { reviewer: "reviewer_b", count: 1, model: "" },
          { reviewer: "reviewer_c", count: 1 },
        ],
      }).slice(0, 2),
    ).toEqual(["reviewer_a · 1 concern(s)", "reviewer_b · 1 concern(s)"]);
  });

  it("draws exactly the seats it is given — two, or five", () => {
    // The count is a setting now, so nothing about the tab may assume three.
    const two = headings({
      ...PANEL,
      seats: [
        { reviewer: "reviewer_a", count: 1, model: "m" },
        { reviewer: "reviewer_b", count: 1, model: "m" },
      ],
    });
    expect(two.slice(0, 2).map((g) => g.split(" ")[0])).toEqual([
      "reviewer_a",
      "reviewer_b",
    ]);
    expect(two[2]).toContain("Across the panel");

    const five = headings({
      ...PANEL,
      seats: [
        "reviewer_a",
        "reviewer_b",
        "reviewer_c",
        "reviewer_d",
        "reviewer_e",
      ].map((reviewer) => ({ reviewer, count: 0, model: "m" })),
    });
    expect(five.slice(0, 5).map((g) => g.split(" ")[0])).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_c",
      "reviewer_d",
      "reviewer_e",
    ]);
  });
});

describe("a review recorded before R9 still shows its concerns (O14)", () => {
  // The regression this pins: `seatsOf` builds from the ITEM's seat rows now,
  // and a review persisted before R9 has none — `StoredReview.seats` is
  // optional and `initReviews` leaves it undefined, so the state ships
  // `seats: []`. A grouped branch taken on `!== undefined` then loops zero
  // times and appends no concern row at all, while the header above still
  // counts every one of them. Pre-R9 the seat list came from the `PANEL_SEATS`
  // constant and could never be empty, so nothing had ever exercised the
  // shape.
  //
  // The honest degradation is the FLAT list — the same one quick mode uses.
  // The record does not say who raised what, so the tab does not group; it
  // does not invent groups from the annotations either, because a reviewer
  // that reported nothing would be missing from that reconstruction and the
  // result would read as a complete panel while being an incomplete one.
  it("falls back to a flat list when no seat rows were recorded", () => {
    const panel = renderReviewTab({ ...PANEL, seats: [] }, deps());
    expect(
      [...panel.querySelectorAll(".lm-cite-row__title")].length,
    ).toBeGreaterThanOrEqual(3);
    expect(text(panel)).toContain("the exclusion restriction is never argued");
    // No seat groups, because there are no seats to group by.
    expect(
      [...panel.querySelectorAll(".lm-review-fold__summary")].map(
        (g) => g.textContent ?? "",
      ),
    ).not.toContain("reviewer_a");
  });

  it("still shows them when the state carries no seats key at all", () => {
    const { seats: _seats, ...noSeats } = PANEL;
    const panel = renderReviewTab(noSeats, deps());
    expect(text(panel)).toContain("the exclusion restriction is never argued");
  });
});

describe("a seat heading has five shapes (X6 O2, ADR 0075 §1)", () => {
  const headings = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        ".lm-review-fold__summary",
      ),
    ].map((g) => g.textContent ?? "");
  const dropped = (reviewer: string, n: number): ReviewLimit => ({
    kind: "anchors_dropped",
    reviewer,
    anchors: Array.from({ length: n }, (_, i) => ({
      anchor: `quote ${i}`,
      role: "claim" as const,
      reason: "not_found" as const,
    })),
  });
  const rejected = (reviewer: string, n: number): ReviewLimit => ({
    kind: "entries_rejected",
    reviewer,
    entries: Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      reason: '"severity" must be one of: info, minor, major',
    })),
  });
  /** Two reviewers that recorded nothing, on named models, plus reviewer_c
   *  which kept its one concern. */
  const LOST: ReviewTabState = {
    ...PANEL,
    annotations: PANEL.annotations.filter((a) => a.reviewer === "reviewer_c"),
    seats: [
      { reviewer: "reviewer_a", count: 0, model: "gpt-5.4-mini" },
      {
        reviewer: "reviewer_b",
        count: 0,
        model: "local-8b",
        unverified: true,
      },
      { reviewer: "reviewer_c", count: 1, model: "gpt-5.4-mini" },
    ],
    synthesis: { consensus: [], disagreements: [] },
  };

  it("says none of its concerns could be located when all were lost to the locator", () => {
    // The round's finding, verbatim: a reviewer that raised FOUR, all dropped,
    // read *raised no concern*.
    const said = headings({
      ...LOST,
      limits: [dropped("reviewer_a", 4), dropped("reviewer_b", 1)],
    });
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — none of its 4 concerns could be located in the manuscript",
    );
    expect(said[1]).toBe(
      "reviewer_b · local-8b (unverified) — its 1 concern could not be located in the manuscript",
    );
    expect(said.join("\n")).not.toContain("raised no concern");
  });

  it("says they could not be recorded when ANY lost entry was rejected", () => {
    // X5 created this case: every entry rejected for its shape also read
    // *raised no concern*. A mix of the two still reads as unrecorded — the
    // fold beneath says which was which.
    const said = headings({
      ...LOST,
      limits: [
        rejected("reviewer_a", 3),
        dropped("reviewer_b", 2),
        rejected("reviewer_b", 1),
      ],
    });
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — none of its 3 concerns could be recorded",
    );
    expect(said[1]).toBe(
      "reviewer_b · local-8b (unverified) — none of its 3 concerns could be recorded",
    );
    // Never a reason: those are the interpreter's model-facing English.
    expect(said.join("\n")).not.toContain("severity");
  });

  it("uses the one-concern forms at N = 1", () => {
    const said = headings({
      ...LOST,
      limits: [rejected("reviewer_a", 1)],
    });
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — its 1 concern could not be recorded",
    );
  });

  it("says each in the reader's language", () => {
    const said = headings(
      {
        ...LOST,
        limits: [dropped("reviewer_a", 4), rejected("reviewer_b", 1)],
      },
      "zh",
    );
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — 提出的 4 条意见均无法在原文中定位",
    );
    expect(said[1]).toBe(
      "reviewer_b · local-8b（未验证） — 提出的 1 条意见未能记录",
    );
    expect(said.join("\n")).not.toMatch(/could not|concern/);
  });

  it("says one lost entry in Chinese without 均, which means all", () => {
    const said = headings(
      {
        ...LOST,
        limits: [dropped("reviewer_a", 1), rejected("reviewer_b", 1)],
      },
      "zh",
    );
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — 提出的 1 条意见无法在原文中定位",
    );
    expect(said[1]).toBe(
      "reviewer_b · local-8b（未验证） — 提出的 1 条意见未能记录",
    );
  });

  it("keeps *raised no concern* for a reviewer that recorded AND lost nothing", () => {
    // reviewer_c's losses must not leak into reviewer_a's heading.
    const said = headings({ ...LOST, limits: [dropped("reviewer_c", 2)] });
    expect(said[0]).toBe("reviewer_a · gpt-5.4-mini — raised no concern");
    expect(said[1]).toBe(
      "reviewer_b · local-8b (unverified) — raised no concern",
    );
  });

  it("leaves a reviewer that kept some of its concerns as it was", () => {
    // D12.1: its heading is true of what its group shows; the fold says what
    // was lost.
    const said = headings({ ...LOST, limits: [dropped("reviewer_c", 2)] });
    expect(said[2]).toBe("reviewer_c · gpt-5.4-mini · 1 concern(s)");
  });

  it("keeps a failed reviewer's heading ahead of anything it lost", () => {
    const said = headings({
      ...LOST,
      seats: [
        {
          reviewer: "reviewer_a",
          count: 0,
          model: "gpt-5.4-mini",
          missing: {
            kind: "seat_missing",
            reviewer: "reviewer_a",
            reason: "unparsed",
          },
        },
      ],
      limits: [dropped("reviewer_a", 2)],
    });
    expect(said[0]).toBe(
      "reviewer_a · gpt-5.4-mini — this reviewer's report could not be read",
    );
  });
});

describe("a failed reviewer says why (X6 O3–O4, ADR 0075 §2)", () => {
  const failedSeat = (
    cause?: import("@lemmaria/harness").ModelFailureCause,
    reason: "failed" | "interrupted" | "unparsed" = "failed",
  ): ReviewTabState => ({
    ...PANEL,
    annotations: PANEL.annotations.filter((a) => a.reviewer !== "reviewer_a"),
    seats: [
      {
        reviewer: "reviewer_a",
        count: 0,
        model: "gpt-5.4-mini",
        missing: {
          kind: "seat_missing",
          reviewer: "reviewer_a",
          reason,
          detail: "model-facing English that must never be rendered",
          ...(cause !== undefined ? { cause } : {}),
        },
      },
      { reviewer: "reviewer_b", count: 1 },
      { reviewer: "reviewer_c", count: 1 },
    ],
  });
  /** The first seat group — the failed reviewer's `<details>`. */
  const group = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    renderReviewTab(state, deps(locale)).querySelector(
      "details.lm-review-fold--group",
    ) as HTMLElement;

  it("gives our sentence for each class, in each locale", () => {
    const ours = (cls: "quota" | "retryable" | "fatal", locale: "en" | "zh") =>
      group(failedSeat({ class: cls }), locale).querySelector(
        ".lm-review-cause__ours",
      )?.textContent;
    // `quota` reuses the notice the transcript already shows — one home for
    // that sentence.
    expect(ours("quota", "en")).toBe(
      "The provider refused this request for a quota or billing reason, so retrying cannot help. Check your plan, credit balance or API key.",
    );
    expect(ours("retryable", "en")).toBe(
      "The model did not answer, and retrying did not help.",
    );
    expect(ours("fatal", "en")).toBe(
      "The request failed with an error that Lemmaria does not retry automatically.",
    );
    expect(ours("quota", "zh")).toBe(
      "服务商因额度或账单原因拒绝了本次请求，重试无济于事。请检查你的套餐、余额或 API 密钥。",
    );
    expect(ours("retryable", "zh")).toBe("该模型未能作答，重试后仍未成功。");
    expect(ours("fatal", "zh")).toBe("请求失败，此类错误不会自动重试。");
  });

  it("sits directly under the heading, before any row", () => {
    const g = group(failedSeat({ class: "fatal" }));
    expect(g.children[0]?.tagName).toBe("SUMMARY");
    expect(g.children[1]?.classList.contains("lm-review-cause")).toBe(true);
  });

  it("shows the provider's words verbatim and whole, labelled as theirs", () => {
    // Third-party text passing as authored (invariant 6's E1 boundary): not
    // translated, not truncated, beside our sentence and never in place of it.
    const message = `429 Too Many Requests — 您的额度已用尽 ${"x".repeat(600)}`;
    // Each locale owns its label's separator: a full-width colon takes no
    // space after it.
    for (const [locale, label] of [
      ["en", "The provider's message: "],
      ["zh", "服务商返回的信息："],
    ] as const) {
      const g = group(failedSeat({ class: "quota", message }), locale);
      expect(g.querySelector(".lm-review-cause__theirs")?.textContent).toBe(
        `${label}${message}`,
      );
      expect(g.querySelector(".lm-review-cause__ours")).not.toBeNull();
    }
  });

  it("fills the label's slot literally, whatever the provider wrote", () => {
    // `String.replace` would read `$&` in a string replacement as "the match".
    const message = "bad field $& in body $1";
    const g = group(failedSeat({ class: "fatal", message }));
    expect(g.querySelector(".lm-review-cause__theirs")?.textContent).toBe(
      `The provider's message: ${message}`,
    );
  });

  it("shows no provider line for a blank message, and our sentence alone", () => {
    const g = group(failedSeat({ class: "retryable", message: "   " }));
    expect(g.querySelector(".lm-review-cause__theirs")).toBeNull();
    expect(g.querySelector(".lm-review-cause__ours")).not.toBeNull();
  });

  it("draws nothing for a stopped or unreadable reviewer, or a failed one with no cause", () => {
    for (const state of [
      failedSeat(undefined, "interrupted"),
      failedSeat(undefined, "unparsed"),
      failedSeat(undefined, "failed"),
    ]) {
      expect(
        renderReviewTab(state, deps()).querySelectorAll(".lm-review-cause"),
      ).toHaveLength(0);
    }
  });

  it("never renders the record's model-facing detail", () => {
    const panel = renderReviewTab(
      {
        ...failedSeat({ class: "fatal", message: "bad key" }),
        limits: [
          {
            kind: "seat_missing",
            reviewer: "reviewer_a",
            reason: "failed",
            detail: "model-facing English that must never be rendered",
            cause: { class: "fatal", message: "bad key" },
          },
        ],
      },
      deps(),
    );
    expect(text(panel)).not.toContain("model-facing");
  });

  it("does not repeat a seat's cause in its limits row", () => {
    const cause = { class: "fatal" as const, message: "bad key" };
    const panel = renderReviewTab(
      {
        ...failedSeat(cause),
        limits: [
          {
            kind: "seat_missing",
            reviewer: "reviewer_a",
            reason: "failed",
            cause,
          },
        ],
      },
      deps(),
    );
    // Once, under the heading — not twice.
    expect(panel.querySelectorAll(".lm-review-cause")).toHaveLength(1);
    const row = panel.querySelector(".lm-review-limit");
    expect(row?.textContent).toBe(
      "reviewer_a: reported nothing usable (failed)",
    );
  });

  it("puts a failed cross-review's cause inside its limits row", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        synthesis: undefined,
        limits: [
          {
            kind: "synthesis_missing",
            reason: "failed",
            cause: { class: "quota", message: "insufficient_quota" },
          },
        ],
      },
      deps(),
    );
    const row = panel.querySelector(".lm-review-limit") as HTMLElement;
    expect(row.firstChild?.textContent).toBe(
      "no cross-panel reading was produced (failed)",
    );
    expect(row.querySelector(".lm-review-cause__ours")?.textContent).toContain(
      "quota or billing",
    );
    expect(row.querySelector(".lm-review-cause__theirs")?.textContent).toBe(
      "The provider's message: insufficient_quota",
    );
  });
});

describe("one line about the panel, in the results header (X6 O5, ADR 0075 §3)", () => {
  const line = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    renderReviewTab(state, deps(locale)).querySelector(
      ".lm-cite-header__text .lm-review-panelline",
    )?.textContent;
  const missing = (
    reviewer: string,
    reason: "failed" | "interrupted" | "unparsed",
  ) => ({
    reviewer,
    count: 0,
    model: "m2",
    missing: { kind: "seat_missing" as const, reviewer, reason },
  });

  it("counts reviewers and distinct models", () => {
    const state: ReviewTabState = {
      ...PANEL,
      seats: [
        { reviewer: "reviewer_a", count: 1, model: "m1" },
        { reviewer: "reviewer_b", count: 1, model: "m2" },
        { reviewer: "reviewer_c", count: 1, model: "m1" },
      ],
    };
    expect(line(state)).toBe("3 reviewers · 2 distinct models");
    expect(line(state, "zh")).toBe("3 位评审 · 2 个不同模型");
  });

  it("uses the singular where English needs one", () => {
    const state: ReviewTabState = {
      ...PANEL,
      seats: [{ reviewer: "reviewer_a", count: 1, model: "m1" }],
    };
    expect(line(state)).toBe("1 reviewer · 1 distinct model");
    const two: ReviewTabState = {
      ...PANEL,
      seats: [
        { reviewer: "reviewer_a", count: 1, model: "m1" },
        { reviewer: "reviewer_b", count: 1, model: "m1" },
      ],
    };
    expect(line(two)).toBe("2 reviewers · 1 distinct model");
  });

  it("names each way a reviewer did not report, by exception and in a fixed order", () => {
    const state: ReviewTabState = {
      ...PANEL,
      seats: [
        missing("reviewer_a", "unparsed"),
        missing("reviewer_b", "interrupted"),
        missing("reviewer_c", "failed"),
        missing("reviewer_d", "failed"),
        { reviewer: "reviewer_e", count: 1, model: "m1" },
      ],
    };
    expect(line(state)).toBe(
      "5 reviewers · 2 distinct models · 2 failed · 1 stopped · 1 unreadable",
    );
    expect(line(state, "zh")).toBe(
      "5 位评审 · 2 个不同模型 · 2 位失败 · 1 位被停止 · 1 位报告无法解析",
    );
  });

  it("omits the models segment when any reviewer's model is unknown", () => {
    // PANEL's seats carry no models — a review stored before R9.
    expect(line(PANEL)).toBe("3 reviewers");
  });

  it("is drawn in the results header, under the title and the count", () => {
    const text_ = renderReviewTab(PANEL, deps()).querySelector(
      ".lm-cite-header__text",
    ) as HTMLElement;
    expect([...text_.children].map((c) => c.className)).toEqual([
      "lm-cite-title",
      "lm-cite-sub",
      "lm-review-panelline",
    ]);
  });

  it("is absent with no seat rows, and in quick mode", () => {
    expect(line({ ...PANEL, seats: [] })).toBeUndefined();
    const { seats: _s, ...noSeats } = PANEL;
    expect(line(noSeats)).toBeUndefined();
    expect(line({ ...PANEL, mode: "quick" })).toBeUndefined();
  });
});

describe("agreement on one model is marked (X6 O6, ADR 0075 §4)", () => {
  /** PANEL with every reviewer on a named model — reviewer_a and reviewer_b
   *  share one, which is the pair PANEL's consensus note cites. */
  const onModels = (a: string, b: string, c = "m3"): ReviewTabState => ({
    ...PANEL,
    seats: [
      { reviewer: "reviewer_a", count: 1, model: a },
      { reviewer: "reviewer_b", count: 1, model: b },
      { reviewer: "reviewer_c", count: 1, model: c },
    ],
  });
  const marks = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        ".lm-review-note__mark",
      ),
    ].map((m) => m.textContent ?? "");

  it("marks a consensus whose reviewers all ran on one model", () => {
    expect(marks(onModels("gpt-5.4-mini", "gpt-5.4-mini"))).toEqual([
      "Same model — every reviewer cited here ran on gpt-5.4-mini",
    ]);
    expect(marks(onModels("gpt-5.4-mini", "gpt-5.4-mini"), "zh")).toEqual([
      "同一模型——此处引用的评审均运行于 gpt-5.4-mini",
    ]);
  });

  it("sits between the note and its chips", () => {
    const note = renderReviewTab(onModels("m1", "m1"), deps()).querySelector(
      ".lm-review-note",
    ) as HTMLElement;
    const kinds = [...note.childNodes].map((n) =>
      n.nodeType === 3 ? "text" : (n as HTMLElement).className,
    );
    expect(kinds).toEqual(["text", "lm-review-note__mark", "lm-review-chips"]);
  });

  it("does not mark reviewers on different models", () => {
    expect(marks(onModels("m1", "m2"))).toEqual([]);
  });

  it("never marks the unknown", () => {
    // PANEL's seats carry no models.
    expect(marks(PANEL)).toEqual([]);
    expect(marks(onModels("m1", ""))).toEqual([]);
  });

  it("never marks a disagreement", () => {
    // Two reviewers on one model disagreeing claims no independence.
    const state: ReviewTabState = {
      ...onModels("m1", "m1"),
      synthesis: {
        consensus: [],
        disagreements: [
          { ids: ["reviewer_a-1", "reviewer_b-1"], note: "they differ" },
        ],
      },
    };
    expect(marks(state)).toEqual([]);
  });

  it("leaves the chips as buttons that still jump", () => {
    folds.clear();
    const panel = renderReviewTab(onModels("m1", "m1"), deps());
    const chip = [
      ...panel.querySelectorAll<HTMLButtonElement>(".lm-review-chip--link"),
    ].find((c) => c.textContent === "reviewer_b-1");
    expect(chip?.tagName).toBe("BUTTON");
    chip?.click();
    expect(
      panel
        .querySelector('[data-concern="reviewer_b-1"]')
        ?.classList.contains("is-target"),
    ).toBe(true);
  });

  it("writes a model id literally, whatever characters it carries", () => {
    // A model id is the user's own text; `$&` in it is not a pattern.
    expect(marks(onModels("m$&1", "m$&1"))).toEqual([
      "Same model — every reviewer cited here ran on m$&1",
    ]);
  });
});

describe("the cross-review names its model and says when it found nothing (X6 O7, ADR 0075 §5)", () => {
  const acrossFold = (state: ReviewTabState, locale: "en" | "zh" = "en") => {
    const title = locale === "en" ? "Across the panel" : "小组综述";
    return [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        "details.lm-review-fold--group",
      ),
    ].find((d) => d.querySelector("summary")?.textContent?.startsWith(title)) as
      | HTMLDetailsElement
      | undefined;
  };
  const summary = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    acrossFold(state, locale)?.querySelector("summary")?.textContent;

  it("names the model that wrote it, as a seat's heading does", () => {
    expect(summary({ ...PANEL, crossReview: { model: "gpt-5.6-luna" } })).toBe(
      "Across the panel · gpt-5.6-luna · 1",
    );
    const unverified: ReviewTabState = {
      ...PANEL,
      crossReview: { model: "local-8b", unverified: true },
    };
    expect(summary(unverified)).toBe(
      "Across the panel · local-8b (unverified) · 1",
    );
    expect(summary(unverified, "zh")).toBe("小组综述 · local-8b（未验证） · 1");
  });

  it("says less when no model is recorded", () => {
    // A review stored before X5 has no row; one whose model replayed `""`
    // has a row with no model. Both simply omit the segment.
    expect(summary(PANEL)).toBe("Across the panel · 1");
    expect(summary({ ...PANEL, crossReview: {} })).toBe("Across the panel · 1");
  });

  it("draws the fold, open, with a sentence when it ran and found nothing", () => {
    const empty: ReviewTabState = {
      ...PANEL,
      synthesis: { consensus: [], disagreements: [] },
      crossReview: { model: "gpt-5.6-luna" },
    };
    const fold = acrossFold(empty);
    expect(fold?.open).toBe(true);
    expect(fold?.querySelector("summary")?.textContent).toBe(
      "Across the panel · gpt-5.6-luna · 0",
    );
    expect(fold?.querySelector(".lm-cite-empty")?.textContent).toBe(
      "The cross-panel reading ran and found nothing the reviewers agree or disagree on.",
    );
    expect(fold?.querySelectorAll(".lm-review-note")).toHaveLength(0);
    expect(
      acrossFold(empty, "zh")?.querySelector(".lm-cite-empty")?.textContent,
    ).toBe("小组综述已完成：各评审的意见之间未发现共识或分歧。");
  });

  it("draws no fold when it did not run — the limits say why", () => {
    const { synthesis: _s, ...none } = PANEL;
    expect(acrossFold(none)).toBeUndefined();
    expect(
      acrossFold({ ...none, crossReview: { model: "gpt-5.6-luna" } }),
    ).toBeUndefined();
  });
});

describe("the evidence line draws prior work (V2 O21, ADR 0078 §D12)", () => {
  const render = (
    evidence: ReviewAnnotationInfo["evidence"],
    locale: "en" | "zh" = "en",
    over: Partial<ReviewTabState> = {},
  ) =>
    renderReviewTab(
      { ...PANEL, annotations: [annotation({ evidence })], ...over },
      deps(locale),
    );
  const PAPER = {
    kind: "paper",
    title: "Adam: A Method for Stochastic Optimization",
    year: "2015",
    href: "https://arxiv.org/abs/1412.6980",
  } as const;

  it("draws `prior work · title (year)` as a link, in both locales", () => {
    const en = render(PAPER);
    expect(en.querySelector(".lm-cite-row__evidence")?.textContent).toBe(
      "prior work · Adam: A Method for Stochastic Optimization (2015)",
    );
    const a = en.querySelector("a.lm-review-paper");
    expect(a?.getAttribute("href")).toBe("https://arxiv.org/abs/1412.6980");
    // The TITLE is the openable part, not the whole line: a reader clicking
    // "prior work" or the year is not asking to leave the editor.
    expect(a?.textContent).toBe("Adam: A Method for Stochastic Optimization");

    expect(
      render(PAPER, "zh").querySelector(".lm-cite-row__evidence")?.textContent,
    ).toBe("已有工作 · Adam: A Method for Stochastic Optimization (2015)");
  });

  it("draws plain text when the host handed no href", () => {
    // An index that returned no usable URL is not an error, and a link that
    // opens nothing is worse than no link.
    const panel = render({ kind: "paper", title: "A Paper", year: "2019" });
    expect(panel.querySelector("a.lm-review-paper")).toBeNull();
    expect(panel.querySelector("span.lm-review-paper")?.textContent).toBe(
      "A Paper",
    );
    expect(panel.querySelector(".lm-cite-row__evidence")?.textContent).toBe(
      "prior work · A Paper (2019)",
    );
  });

  it("omits the year when the record has none", () => {
    expect(
      render({ kind: "paper", title: "Undated Work" }).querySelector(
        ".lm-cite-row__evidence",
      )?.textContent,
    ).toBe("prior work · Undated Work");
  });

  it("does NOT reveal the claim when the title is clicked", () => {
    // The counter button's precedent. Opening the paper and scrolling the
    // manuscript are two actions, and the click asked for one.
    const revealed: unknown[] = [];
    const panel = renderReviewTab(
      { ...PANEL, annotations: [annotation({ evidence: PAPER })] },
      { ...deps(), reveal: (...args: unknown[]) => revealed.push(args) },
    );
    const link = panel.querySelector("a.lm-review-paper") as HTMLElement;
    link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(revealed).toEqual([]);

    // And the row itself still reveals, so the guard is on the link alone.
    const row = panel.querySelector(".lm-cite-row") as HTMLElement;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(revealed.length).toBeGreaterThan(0);
  });

  it("lets the title click REACH the frame's own link handler, unprevented", () => {
    // V2's gate review, issue 1 — the bug the test above could not see.
    //
    // A webview link is opened by VS Code, not by us: its shell installs a
    // BUBBLE-phase `click` listener on the frame's window (`resources/app/out/
    // vs/workbench/contrib/webview/browser/pre/index.html`, `handleInnerClick`),
    // which calls `preventDefault()` and posts `did-click-link` to the host.
    // So the click has to arrive there, still cancellable. A
    // `stopPropagation()` on the anchor did not merely stop the row revealing
    // — it deleted the only path that opens the paper, and the frame followed
    // the anchor's own default and navigated ITSELF. The manual run saw the
    // whole Lemmaria view go blank behind `frame-src 'self'`.
    //
    // Nothing above asserts this, which is why jsdom passed a link that
    // cannot work: the reveal guard and the open path are two properties, and
    // the old code bought the first by spending the second.
    const seen: { tag: string; defaultPrevented: boolean }[] = [];
    const handleInnerClick = (e: Event): void => {
      seen.push({
        tag: (e.target as Element).tagName,
        defaultPrevented: e.defaultPrevented,
      });
      // What VS Code's handler does — and here it also keeps jsdom from
      // attempting the navigation it does not implement.
      e.preventDefault();
    };
    const panel = renderReviewTab(
      { ...PANEL, annotations: [annotation({ evidence: PAPER })] },
      deps(),
    );
    // The listener is on `window`, so the tree has to be IN the document for
    // the click to reach it at all.
    document.body.append(panel);
    window.addEventListener("click", handleInnerClick);
    try {
      const link = panel.querySelector("a.lm-review-paper") as HTMLElement;
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    } finally {
      window.removeEventListener("click", handleInnerClick);
      panel.remove();
    }
    expect(seen).toEqual([{ tag: "A", defaultPrevented: false }]);
  });

  it("draws on a WITHDRAWN row too", () => {
    // A withdrawn concern keeps its evidence: the reader deciding whether to
    // agree with the verifier needs to see what the reviewer was citing.
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: [
          annotation({
            evidence: PAPER,
            verification: {
              outcome: "refuted",
              kind: "literature",
              counter: { file: "main.tex", line: 9 },
            },
          }),
        ],
      },
      deps(),
    );
    expect(panel.querySelector("a.lm-review-paper")?.textContent).toBe(
      PAPER.title,
    );
  });
});

describe("the evidence line names its file (X6 O9, ADR 0075 §6)", () => {
  const evidenceOf = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        ".lm-cite-row__evidence",
      ),
    ].map((e) => e.textContent ?? "");
  const withEvidence = (
    evidence: ReviewAnnotationInfo["evidence"],
    over: Partial<ReviewTabState> = {},
  ): ReviewTabState => ({
    ...PANEL,
    annotations: [annotation({ evidence })],
    ...over,
  });

  it("prints file:line when the evidence is not in the entry", () => {
    // The round's finding: the evidence was in a table file, and `L3` sent the
    // reader to line 3 of main.tex, which is `\makeatother`.
    expect(
      evidenceOf(
        withEvidence({
          kind: "span",
          file: "tables/quantitative_comparison.tex",
          line: 3,
        }),
      ),
    ).toEqual(["evidence · tables/quantitative_comparison.tex:3"]);
    expect(
      evidenceOf(
        withEvidence({ kind: "span", file: "sections/method.tex", line: 12 }),
        "zh",
      ),
    ).toEqual(["依据 · sections/method.tex:12"]);
  });

  it("prints L<n> when the evidence is in the entry, or names no file", () => {
    expect(
      evidenceOf(withEvidence({ kind: "span", file: "main.tex", line: 3 })),
    ).toEqual(["evidence · L3"]);
    expect(
      evidenceOf(withEvidence({ kind: "span", file: "", line: 7 })),
    ).toEqual(["evidence · L7"]);
  });

  it("compares against the reviewed ENTRY — never the next run's, never the header's", () => {
    // `file` is a display string and `nextEntry` is the NEXT panel's; only
    // `entry` says which document this review read (ADR 0064 §1).
    const over = {
      entry: "paper/main.tex",
      nextEntry: "other.tex",
      file: "main.tex",
    };
    expect(
      evidenceOf(
        withEvidence({ kind: "span", file: "paper/main.tex", line: 3 }, over),
      ),
    ).toEqual(["evidence · L3"]);
    expect(
      evidenceOf(
        withEvidence({ kind: "span", file: "other.tex", line: 3 }, over),
      ),
    ).toEqual(["evidence · other.tex:3"]);
    expect(
      evidenceOf(
        withEvidence({ kind: "span", file: "main.tex", line: 3 }, over),
      ),
    ).toEqual(["evidence · main.tex:3"]);
  });

  it("follows the same rule as the claim's own location on the row", () => {
    const panel = renderReviewTab(
      withEvidence({ kind: "span", file: "sections/method.tex", line: 2 }, {}),
      deps(),
    );
    // Claim in the entry → `L4`; evidence elsewhere → its file.
    expect(panel.querySelector(".lm-cite-row__detail")?.textContent).toContain(
      "· L4",
    );
    expect(panel.querySelector(".lm-cite-row__evidence")?.textContent).toBe(
      "evidence · sections/method.tex:2",
    );
  });

  it("leaves the missing and absent cases as they were", () => {
    expect(evidenceOf(withEvidence({ kind: "missing" }))).toEqual([
      "no supporting passage in the manuscript",
    ]);
    expect(evidenceOf(withEvidence(undefined))).toEqual([]);
  });
});

describe("a literature source that failed is one row (X6 O13, ADR 0075 §7)", () => {
  const source = (
    reviewer: string,
    name: string,
    status: "rate_limited" | "timeout" | "failed",
    anonymous?: true,
  ): ReviewLimit => ({
    kind: "source_unavailable",
    reviewer,
    source: name,
    status,
    ...(anonymous ? { anonymous } : {}),
  });
  const rows = (limits: ReviewLimit[], locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab({ ...PANEL, limits }, deps(locale)).querySelectorAll(
        ".lm-review-limit",
      ),
    ].map((n) => n.textContent ?? "");
  const limitsSummary = (limits: ReviewLimit[], locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab({ ...PANEL, limits }, deps(locale)).querySelectorAll(
        ".lm-review-fold__summary",
      ),
    ]
      .map((s) => s.textContent ?? "")
      .find((s) =>
        s.startsWith(
          locale === "en"
            ? "What this review could not do"
            : "本次审稿未能完成的部分",
        ),
      );

  /** The round's shape: the same two sources failing for every reviewer. */
  const ROUND: ReviewLimit[] = [
    source("reviewer_c", "arxiv", "rate_limited"),
    source("reviewer_a", "arxiv", "rate_limited"),
    source("reviewer_a", "semantic_scholar", "rate_limited", true),
    { kind: "search_budget_spent", reviewer: "reviewer_a" },
    source("reviewer_b", "arxiv", "timeout"),
    source("reviewer_b", "semantic_scholar", "rate_limited"),
    source("reviewer_c", "semantic_scholar", "failed"),
  ];

  it("folds a source's failures into one sentence, reviewers in panel order", () => {
    expect(rows(ROUND)).toEqual([
      "reviewer_a, reviewer_b, reviewer_c: arxiv — rate-limited, timed out",
      "reviewer_a, reviewer_b, reviewer_c: semantic_scholar — rate-limited, failed (no API key — Lemmaria: Set Semantic Scholar API Key)",
      "reviewer_a: the literature-search budget ran out",
    ]);
  });

  it("says the merged sentence in the reader's language", () => {
    expect(rows(ROUND, "zh")).toEqual([
      "reviewer_a、reviewer_b、reviewer_c: arxiv — 触发限流、超时",
      "reviewer_a、reviewer_b、reviewer_c: semantic_scholar — 触发限流、失败（未设置 API Key — Lemmaria: 设置 Semantic Scholar API Key）",
      "reviewer_a: 文献检索额度已用尽",
    ]);
  });

  it("counts the rows it renders, not the limits it holds", () => {
    expect(limitsSummary(ROUND)).toBe("What this review could not do · 3");
    expect(limitsSummary(ROUND, "zh")).toBe("本次审稿未能完成的部分 · 3");
  });

  it("renders a one-reviewer, one-status source exactly as before", () => {
    expect(rows([source("reviewer_c", "arxiv", "timeout")])).toEqual([
      "reviewer_c: arxiv — timed out",
    ]);
  });
});

describe("every X6 sentence is one language per reader (X6 O14, invariant 6)", () => {
  /** One degraded panel carrying every new surface at once: a failed reviewer
   *  with a cause, one whose entries were all lost, a same-model consensus, a
   *  named cross-review, a cross-file evidence line and a merged source row. */
  const DEGRADED: ReviewTabState = {
    ...PANEL,
    annotations: [
      annotation({
        id: "reviewer_c-1",
        reviewer: "reviewer_c",
        evidence: { kind: "span", file: "sections/method.tex", line: 2 },
      }),
      annotation({
        index: 1,
        id: "reviewer_d-1",
        reviewer: "reviewer_d",
      }),
      // V1 (ADR 0076 §9): one withdrawn, with its note; one of each mark.
      annotation({
        index: 2,
        id: "reviewer_c-2",
        reviewer: "reviewer_c",
        verification: {
          outcome: "refuted",
          kind: "absence",
          counter: { file: "sections/method.tex", line: 4 },
          note: "Eq. (3), §2.",
        },
      }),
      annotation({
        index: 3,
        id: "reviewer_d-2",
        reviewer: "reviewer_d",
        verification: { outcome: "unverifiable", kind: "judgment" },
      }),
      annotation({
        index: 4,
        id: "reviewer_d-3",
        reviewer: "reviewer_d",
        verification: { outcome: "unverifiable", kind: "absence" },
      }),
    ],
    seats: [
      {
        reviewer: "reviewer_a",
        count: 0,
        model: "m1",
        missing: {
          kind: "seat_missing",
          reviewer: "reviewer_a",
          reason: "failed",
          cause: { class: "retryable", message: "HTTP 503" },
        },
      },
      { reviewer: "reviewer_b", count: 0, model: "m1" },
      { reviewer: "reviewer_c", count: 2, model: "m2" },
      { reviewer: "reviewer_d", count: 3, model: "m2" },
    ],
    synthesis: {
      consensus: [{ ids: ["reviewer_c-1", "reviewer_d-1"], note: "agree" }],
      disagreements: [],
    },
    crossReview: { model: "m3", unverified: true },
    verifier: { model: "m4" },
    limits: [
      {
        kind: "verification_missing",
        reason: "failed",
        cause: { class: "fatal", message: "HTTP 400" },
      },
      {
        kind: "anchors_dropped",
        reviewer: "reviewer_b",
        anchors: [
          { anchor: "a", role: "claim", reason: "not_found" },
          { anchor: "b", role: "evidence", reason: "ambiguous" },
        ],
      },
      {
        kind: "source_unavailable",
        reviewer: "reviewer_c",
        source: "arxiv",
        status: "timeout",
      },
      {
        kind: "source_unavailable",
        reviewer: "reviewer_d",
        source: "arxiv",
        status: "failed",
        anonymous: true,
      },
      {
        kind: "seat_missing",
        reviewer: "reviewer_a",
        reason: "failed",
        cause: { class: "retryable", message: "HTTP 503" },
      },
    ],
  };
  const OURS_EN = [
    "located in the manuscript",
    "could be recorded",
    "could not be recorded",
    "reviewers",
    "distinct model",
    "failed",
    "Same model",
    "The model did not answer",
    "The provider's message",
    "timed out",
    "Across the panel",
    "unverified",
    "evidence",
    // V1 (ADR 0076 §9).
    "Withdrawn by verification",
    "Answered at",
    "not checked",
    "reviewer's judgment",
    "could not be settled from the text",
    "concerns were not checked against the manuscript",
    "does not retry automatically",
  ];

  it("draws every new surface in the fixture, so the sweep is not vacuous", () => {
    const panel = renderReviewTab(DEGRADED, deps());
    for (const selector of [
      ".lm-review-panelline",
      ".lm-review-cause__ours",
      ".lm-review-cause__theirs",
      ".lm-review-note__mark",
      ".lm-cite-row__evidence",
    ])
      expect(panel.querySelector(selector), selector).not.toBeNull();
    expect(text(panel)).toContain(
      "none of its 2 concerns could be located in the manuscript",
    );
    expect(text(panel)).toContain("reviewer_c, reviewer_d: arxiv");
  });

  it("draws every V1 surface in the fixture too", () => {
    const panel = renderReviewTab(DEGRADED, deps());
    for (const selector of [
      "button.lm-review-counter",
      ".lm-review-counter__note",
      ".lm-review-limit .lm-review-cause",
    ])
      expect(panel.querySelector(selector), selector).not.toBeNull();
    for (const mark of [
      "not checked",
      "reviewer's judgment",
      "could not be settled from the text",
      "Withdrawn by verification",
    ])
      expect(text(panel), mark).toContain(mark);
  });

  it("carries none of our English under the Chinese display language", () => {
    const zh = text(renderReviewTab(DEGRADED, deps("zh")));
    for (const english of OURS_EN) expect(zh).not.toContain(english);
    // The provider's own words pass as authored, beside our sentence.
    expect(zh).toContain("HTTP 503");
    expect(zh).toContain("HTTP 400");
  });

  it("carries no Chinese under any other display language", () => {
    const en = text(renderReviewTab(DEGRADED, deps("en")));
    expect(en).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
  });
});

describe("a model id and a count each stay whole (X6 review round)", () => {
  // In the \u4e2d\u6587 window at ~440 px every mark wrapped as `\u2026\u5747\u8fd0\u884c\u4e8e gpt-` /
  // `5.6-luna`, and a heading as `REVIEWER_A \u00b7 GPT-5.6-LUNA \u00b7 9` / `\u6761\u610f\u89c1`.
  // And the heading's `text-transform: uppercase` printed `GPT-5.6-LUNA`
  // right above a mark printing `gpt-5.6-luna`: model ids are case-sensitive.
  // The fix is a span around each, which the stylesheet keeps whole and out of
  // the heading's case; what jsdom can assert is that the spans exist, hold
  // exactly the id and the count, and leave every sentence's text as it was.
  const summaries = (state: ReviewTabState, locale: "en" | "zh" = "en") => [
    ...renderReviewTab(state, deps(locale)).querySelectorAll(
      ".lm-review-fold__summary",
    ),
  ];
  const MODELLED: ReviewTabState = {
    ...PANEL,
    seats: [
      { reviewer: "reviewer_a", count: 1, model: "gpt-5.6-luna" },
      {
        reviewer: "reviewer_b",
        count: 1,
        model: "local-8b",
        unverified: true,
      },
      // A seat recorded before R9 carries no model.
      { reviewer: "reviewer_c", count: 1 },
    ],
    crossReview: { model: "gpt-5.6-luna" },
  };

  it("puts a seat's model id in a span of its own, and nothing else in it", () => {
    const [a, b, c] = summaries(MODELLED);
    expect(a?.querySelector(".lm-review-model")?.textContent).toBe(
      "gpt-5.6-luna",
    );
    // The unverified mark is ours, not part of the id.
    expect(b?.querySelector(".lm-review-model")?.textContent).toBe("local-8b");
    // No model recorded, no span.
    expect(c?.querySelector(".lm-review-model")).toBeNull();
  });

  it("keeps a count with its unit, in each language", () => {
    const [a] = summaries(MODELLED);
    expect(a?.querySelector(".lm-review-count")?.textContent).toBe(
      "1 concern(s)",
    );
    const [zh] = summaries(MODELLED, "zh");
    expect(zh?.querySelector(".lm-review-count")?.textContent).toBe(
      "1 \u6761\u610f\u89c1",
    );
  });

  it("leaves every heading's text exactly as it was", () => {
    expect(summaries(MODELLED).map((s) => s.textContent)).toEqual([
      "reviewer_a \u00b7 gpt-5.6-luna \u00b7 1 concern(s)",
      "reviewer_b \u00b7 local-8b (unverified) \u00b7 1 concern(s)",
      "reviewer_c \u00b7 1 concern(s)",
      "Across the panel \u00b7 gpt-5.6-luna \u00b7 1",
    ]);
  });

  it("names the cross-review's model in a span too", () => {
    const across = summaries(MODELLED).at(-1);
    expect(across?.querySelector(".lm-review-model")?.textContent).toBe(
      "gpt-5.6-luna",
    );
  });

  it("puts the same-model mark's model id in a span, the sentence unchanged", () => {
    const mark = renderReviewTab(
      {
        ...PANEL,
        seats: [
          { reviewer: "reviewer_a", count: 1, model: "gpt-5.6-luna" },
          { reviewer: "reviewer_b", count: 1, model: "gpt-5.6-luna" },
          { reviewer: "reviewer_c", count: 1, model: "gpt-5.6-luna" },
        ],
      },
      deps("zh"),
    ).querySelector(".lm-review-note__mark");
    expect(mark?.textContent).toBe(
      "\u540c\u4e00\u6a21\u578b\u2014\u2014\u6b64\u5904\u5f15\u7528\u7684\u8bc4\u5ba1\u5747\u8fd0\u884c\u4e8e gpt-5.6-luna",
    );
    expect(mark?.querySelector(".lm-review-model")?.textContent).toBe(
      "gpt-5.6-luna",
    );
  });

  it("keeps a model id that looks like a replacement pattern literal", () => {
    // The slot is filled by splitting the sentence, not by `replace`, so no
    // `$&` in a user's model id can be read as a pattern.
    const mark = renderReviewTab(
      {
        ...PANEL,
        seats: [
          { reviewer: "reviewer_a", count: 1, model: "odd-$&-id" },
          { reviewer: "reviewer_b", count: 1, model: "odd-$&-id" },
          { reviewer: "reviewer_c", count: 1 },
        ],
      },
      deps(),
    ).querySelector(".lm-review-note__mark");
    expect(mark?.textContent).toBe(
      "Same model \u2014 every reviewer cited here ran on odd-$&-id",
    );
  });
});

/**
 * V1 (ADR 0076 §9): what verification withdrew is FOLDED, not deleted — one
 * group, closed on arrival, naming the model that checked; each row keeps
 * Chat and Ignore, loses Resolve and Adopt, and carries the passage that
 * answered it. Every other row says, by exception, what the verifier could not
 * settle.
 */
describe("what verification withdrew is folded, not deleted (V1 O20–O22)", () => {
  const VERIFIED: ReviewTabState = {
    ...PANEL,
    // The shown review read main.tex; the next one will read other.tex. The
    // counter's file is compared against the FIRST (ADR 0075 §6).
    entry: "main.tex",
    nextEntry: "other.tex",
    annotations: [
      annotation({
        blocking: true,
        evidence: { kind: "span", file: "main.tex", line: 3 },
        verification: { outcome: "upheld", kind: "contradiction" },
      }),
      annotation({
        index: 1,
        id: "reviewer_b-1",
        dimension: "claims",
        reviewer: "reviewer_b",
        file: "sections/method.tex",
        line: 1,
        severity: "minor",
        evidence: { kind: "missing" },
        message: "the estimator is asserted, never defined",
        verification: {
          outcome: "refuted",
          kind: "absence",
          counter: { file: "main.tex", line: 3 },
          note: "Eq. (3) defines it.",
        },
      }),
      // A copyedit the verifier withdrew leaves the Copyedit group too.
      annotation({
        index: 2,
        id: "reviewer_c-1",
        dimension: "language",
        reviewer: "reviewer_c",
        severity: "minor",
        line: 5,
        hasSuggestion: true,
        suggestion: "the strongest",
        message: "a typo in the baseline sentence",
        verification: {
          outcome: "refuted",
          kind: "contradiction",
          counter: { file: "sections/method.tex", line: 2 },
        },
      }),
      // A copyedit that stands keeps its group, so the order can be seen.
      annotation({
        index: 3,
        id: "reviewer_c-2",
        dimension: "language",
        reviewer: "reviewer_c",
        severity: "minor",
        line: 6,
        hasSuggestion: true,
        suggestion: "defined",
        message: "a slip in the conclusion",
        verification: { outcome: "upheld", kind: "absence" },
      }),
    ],
    seats: [
      { reviewer: "reviewer_a", count: 1 },
      { reviewer: "reviewer_b", count: 1 },
      { reviewer: "reviewer_c", count: 2 },
    ],
    verifier: { model: "m9" },
  };
  const summaries = (state: ReviewTabState, locale: "en" | "zh" = "en") =>
    [
      ...renderReviewTab(state, deps(locale)).querySelectorAll(
        ".lm-review-fold__summary",
      ),
    ].map((s) => s.textContent ?? "");
  const fold = (panel: HTMLElement, startsWith: string) =>
    [...panel.querySelectorAll<HTMLDetailsElement>(".lm-review-fold")].find(
      (f) =>
        (
          f.querySelector(".lm-review-fold__summary")?.textContent ?? ""
        ).startsWith(startsWith),
    );

  it("gathers them in one fold after Copyedit and before the cross-review, naming the verifier", () => {
    expect(summaries(VERIFIED)).toEqual([
      "reviewer_a · 1 concern(s)",
      // The heading counts what its group shows (ADR 0075 §1 stands): a
      // reviewer whose every concern was withdrawn never reads *raised none*.
      "reviewer_b · 0 concern(s)",
      "reviewer_c · 0 concern(s)",
      `${tr("en", "rCopyedit")} · 1`,
      "Withdrawn by verification · m9 · 2",
      "Across the panel · 1",
    ]);
  });

  it("arrives closed, and still counts in the header's pending line", () => {
    const panel = renderReviewTab(VERIFIED, deps());
    expect(fold(panel, "Withdrawn")?.open).toBe(false);
    expect(panel.querySelector(".lm-cite-sub")?.textContent).toBe(
      `4 ${tr("en", "rAnnotations")}`,
    );
  });

  it("offers Chat and Ignore on a withdrawn row, and neither Resolve nor Adopt", () => {
    const withdrawn = fold(renderReviewTab(VERIFIED, deps()), "Withdrawn");
    const buttons = [
      ...(withdrawn?.querySelectorAll(".lm-cite-actions button") ?? []),
    ].map((b) => b.textContent);
    expect(buttons).toEqual([
      tr("en", "rIgnore"),
      tr("en", "rChat"),
      tr("en", "rIgnore"),
      tr("en", "rChat"),
    ]);
  });

  it("names where the manuscript answers it — by the REVIEWED entry — and opens that, not the claim", () => {
    calls.length = 0;
    const withdrawn = fold(renderReviewTab(VERIFIED, deps()), "Withdrawn");
    const counters = [
      ...(withdrawn?.querySelectorAll<HTMLButtonElement>(
        "button.lm-review-counter",
      ) ?? []),
    ];
    expect(counters.map((c) => c.textContent)).toEqual([
      "Answered at L3",
      "Answered at sections/method.tex:2",
    ]);
    counters[0]?.click();
    expect(calls).toEqual(["counter:1"]);
  });

  it("sets the counter under the evidence line and the note under the counter, as authored", () => {
    const row = renderReviewTab(VERIFIED, deps()).querySelector(
      '[data-concern="reviewer_b-1"]',
    );
    const lines = [
      ...(row?.querySelectorAll(
        ".lm-cite-row__evidence, .lm-review-counter, .lm-review-counter__note",
      ) ?? []),
    ].map((n) => `${n.className}: ${n.textContent}`);
    expect(lines).toEqual([
      `lm-cite-row__evidence: ${tr("en", "rNoEvidence")}`,
      "lm-review-counter: Answered at L3",
      "lm-review-counter__note: Eq. (3) defines it.",
    ]);
    // A withdrawn concern with no note carries no empty line for one.
    const bare = renderReviewTab(VERIFIED, deps()).querySelector(
      '[data-concern="reviewer_c-1"]',
    );
    expect(bare?.querySelector(".lm-review-counter__note")).toBeNull();
  });

  it("lets a synthesis chip jump INTO the withdrawn fold, opening it", () => {
    calls.length = 0;
    const panel = renderReviewTab(VERIFIED, deps());
    const chip = [
      ...panel.querySelectorAll<HTMLButtonElement>(".lm-review-chip--link"),
    ].find((c) => c.textContent === "reviewer_b-1");
    chip?.click();
    expect(calls).toContain("fold:withdrawn:true");
    expect(fold(panel, "Withdrawn")?.open).toBe(true);
  });

  it("says it in the reader's language", () => {
    const zh = renderReviewTab(VERIFIED, deps("zh"));
    expect(summaries(VERIFIED, "zh")).toContain("经核查撤回 · m9 · 2");
    expect(
      [...zh.querySelectorAll("button.lm-review-counter")].map(
        (c) => c.textContent,
      ),
    ).toEqual(["稿件中已有回应：L3", "稿件中已有回应：sections/method.tex:2"]);
  });

  it("draws no fold, and no mark, in quick mode — a quick action has no verifier", () => {
    const quick: ReviewTabState = {
      ...VERIFIED,
      mode: "quick",
      file: "main.tex",
    };
    const panel = renderReviewTab(quick, deps());
    expect(fold(panel, "Withdrawn")).toBeUndefined();
    expect(text(panel)).not.toContain(tr("en", "rConcernUnchecked"));
  });
});

describe("the id line says what the verifier could not settle, by exception (V1 O22)", () => {
  const detailOf = (
    verification: ReviewAnnotationInfo["verification"] | undefined,
    mode: "panel" | "quick" = "panel",
  ): string =>
    renderReviewTab(
      {
        ...PANEL,
        mode,
        annotations: [
          annotation({
            blocking: true,
            ...(verification !== undefined ? { verification } : {}),
          }),
        ],
        seats: [{ reviewer: "reviewer_a", count: 1 }],
      },
      deps(),
    ).querySelector(".lm-cite-row__detail")?.textContent ?? "";

  it("puts the mark after the badge and before the location", () => {
    expect(detailOf(undefined)).toBe(
      "reviewer_a-1 · major · blocking · not checked · L4",
    );
    expect(detailOf({ outcome: "unverifiable", kind: "judgment" })).toBe(
      "reviewer_a-1 · major · blocking · reviewer's judgment · L4",
    );
    expect(detailOf({ outcome: "unverifiable", kind: "absence" })).toBe(
      "reviewer_a-1 · major · blocking · could not be settled from the text · L4",
    );
  });

  it("says nothing of a concern the verifier upheld", () => {
    expect(detailOf({ outcome: "upheld", kind: "absence" })).toBe(
      "reviewer_a-1 · major · blocking · L4",
    );
  });

  it("says nothing at all in quick mode", () => {
    expect(detailOf(undefined, "quick")).toBe(
      "reviewer_a-1 · major · blocking · L4",
    );
  });

  it("says each in Chinese", () => {
    const zh = (verification?: ReviewAnnotationInfo["verification"]) =>
      renderReviewTab(
        {
          ...PANEL,
          annotations: [
            annotation(verification !== undefined ? { verification } : {}),
          ],
          seats: [{ reviewer: "reviewer_a", count: 1 }],
        },
        deps("zh"),
      ).querySelector(".lm-cite-row__detail")?.textContent ?? "";
    expect(zh()).toContain("未核查");
    expect(zh({ outcome: "unverifiable", kind: "judgment" })).toContain(
      "评审人的判断",
    );
    expect(zh({ outcome: "unverifiable", kind: "absence" })).toContain(
      "无法从稿件中核实",
    );
  });
});

describe("a failed verification says why, in its limits row (V1 O23)", () => {
  it("appends the cause block, exactly as a failed cross-review does", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        limits: [
          {
            kind: "verification_missing",
            reason: "failed",
            cause: { class: "fatal", message: "HTTP 400" },
          },
          { kind: "verification_missing", reason: "incomplete" },
        ],
      },
      deps(),
    );
    const rows = [...panel.querySelectorAll(".lm-review-limit")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".lm-review-cause__ours")?.textContent).toBe(
      tr("en", "rCauseFatal"),
    );
    expect(rows[0]?.textContent).toContain("HTTP 400");
    expect(rows[1]?.querySelector(".lm-review-cause")).toBeNull();
  });
});

/**
 * V5 (ADR 0087, D14, O15): the one thing V5 shows. A strength that did not
 * locate is a new way of falling short, so it is a `ReviewLimit` — and the
 * fold renders every limit as one sentence built from the record's own fields.
 * Nothing else about strengths or impressions reached the tab until V6, and
 * since V6 it reaches it only through the card (ADR 0088; the V6 suite below).
 */
describe("a strength that could not be recorded is one sentence in the fold (V5, D14)", () => {
  const lost = (
    reviewer: string,
    dropped: number,
    rejected: number,
  ): ReviewLimit => ({
    kind: "strengths_lost",
    reviewer,
    dropped: Array.from({ length: dropped }, (_, i) => ({
      anchor: `praised passage ${i}`,
      role: "claim" as const,
      reason: "not_found" as const,
    })),
    rejected: Array.from({ length: rejected }, (_, i) => ({
      index: i + 1,
      reason: 'a strength\'s "evidence" is a passage or a paper',
    })),
  });
  const rendered = (limits: ReviewLimit[], locale: "en" | "zh" = "en") =>
    renderReviewTab({ ...PANEL, limits }, deps(locale));

  it("counts the dropped and the rejected together, in each locale's own sentence", () => {
    const limit = lost("reviewer_b", 2, 1);
    expect(limitSentence("en", limit)).toBe(
      "reviewer_b: 3 strength(s) could not be recorded — the quote or its evidence was not found, or the entry was malformed",
    );
    expect(limitSentence("zh", limit)).toBe(
      "reviewer_b：有 3 条优点未能记录——引文或其依据未能找到，或条目格式有误",
    );
    // Never the quote, never the reason: the one is the reviewer's text and
    // the other the interpreter's model-facing English (invariant 6 rule 2).
    for (const locale of ["en", "zh"] as const) {
      expect(limitSentence(locale, limit)).not.toContain("praised passage");
      expect(limitSentence(locale, limit)).not.toContain('"evidence"');
    }
  });

  it("names the PDF reviewer as its heading does", () => {
    expect(
      limitSentence("en", lost("pdf_reviewer", 1, 0), "pdf_reviewer"),
    ).toBe(
      `${tr("en", "rSeatPdfReviewer")}: 1 strength(s) could not be recorded — the quote or its evidence was not found, or the entry was malformed`,
    );
  });

  it("is a row of `What this review could not do`, in both locales", () => {
    for (const locale of ["en", "zh"] as const) {
      const rows = [
        ...rendered([lost("reviewer_a", 1, 0)], locale).querySelectorAll(
          ".lm-review-limit",
        ),
      ].map((n) => n.textContent ?? "");
      expect(rows).toEqual([limitSentence(locale, lost("reviewer_a", 1, 0))]);
    }
  });

  it("leaves every seat heading as it was — a lost strength is not a lost concern", () => {
    const headings = (limits: ReviewLimit[]) =>
      [...rendered(limits).querySelectorAll(".lm-review-fold__summary")]
        .map((s) => s.textContent ?? "")
        .filter((s) => s.startsWith("reviewer_"));
    expect(headings([lost("reviewer_a", 3, 2)])).toEqual(headings([]));
  });
});

/**
 * V6 (ADR 0088 §3–§4; plan D3, D9): the scorecard block in the tab, and a row
 * that narrows the concern list beneath it to its dimension.
 *
 * The narrowing is view-state `main.ts` holds and hands back as
 * `deps.narrowed`; the tab only filters, recounts and says so.
 */
describe("V6: the scorecard sits above the concerns, and a row narrows them (O1, O15–O18, O25)", () => {
  const EIGHT = [
    "soundness",
    "claims",
    "clarity",
    "language",
    "positioning",
    "originality",
    "significance",
    "presentation",
  ] as const;
  const CARD: Scorecard = {
    readiness: { label: "major", checked: false },
    notAssessed: 0,
    dimensions: EIGHT.map((dimension) => ({
      dimension,
      standing: { kind: "nothing_raised" },
      issues: { blocking: 0, major: 0, minor: 0, info: 0 },
      strengths: 0,
      seats: [],
      impression: null,
    })),
    panel: {
      reviewers: [
        { reviewer: "reviewer_a", model: "m1" },
        { reviewer: "reviewer_b", model: "m1" },
      ],
      verificationOn: true,
      pdf: { model: "vision-1" },
    },
  };
  const concern = (
    index: number,
    id: string,
    over: Partial<ReviewAnnotationInfo>,
  ): ReviewAnnotationInfo =>
    annotation({ index, id, line: index + 1, ...over });
  /** Two reviewers and a PDF seat; soundness in every fold a narrowing
   *  reaches, and something else beside it in each. */
  const SC: ReviewTabState = {
    available: true,
    mode: "panel",
    file: "main.tex",
    entry: "main.tex",
    nextEntry: "main.tex",
    annotations: [
      concern(0, "reviewer_a-1", { dimension: "soundness" }),
      concern(1, "reviewer_a-2", { dimension: "claims", severity: "minor" }),
      // The wire carries a dimension as the seat spelled it; the card, and
      // the narrowing, lowercase it.
      concern(2, "reviewer_b-1", {
        reviewer: "reviewer_b",
        dimension: "Soundness",
        severity: "minor",
      }),
      concern(3, "reviewer_b-2", {
        reviewer: "reviewer_b",
        dimension: "language",
        severity: "minor",
        hasSuggestion: true,
        suggestion: "its",
      }),
      concern(4, "reviewer_a-3", {
        dimension: "soundness",
        verification: { outcome: "refuted", kind: "absence" },
      }),
      concern(5, "reviewer_b-3", {
        reviewer: "reviewer_b",
        dimension: "claims",
        status: "ignored",
      }),
      concern(6, "reviewer_a-4", {
        dimension: "soundness",
        status: "accepted",
      }),
      concern(7, "pdf_reviewer-1", {
        reviewer: "pdf_reviewer",
        dimension: "presentation",
        severity: "minor",
      }),
    ],
    seats: [
      { reviewer: "reviewer_a", count: 4, model: "m1" },
      { reviewer: "reviewer_b", count: 3, model: "m1" },
    ],
    pdfSeat: { reviewer: "pdf_reviewer", count: 1, model: "vision-1" },
    synthesis: {
      consensus: [{ ids: ["reviewer_a-1", "reviewer_a-2"], note: "both" }],
      disagreements: [],
    },
    limits: [
      {
        kind: "concerns_set_aside",
        reviewer: "pdf_reviewer",
        entries: [
          {
            dimension: "soundness",
            concern: {
              severity: "major",
              message: "the argument in section 3 is circular",
              span: { file: "main.tex", line: 9 },
            },
          },
          {
            dimension: "claims",
            concern: {
              severity: "minor",
              message: "the headline claim overreaches",
              span: { file: "main.tex", line: 10 },
            },
          },
        ],
      },
      {
        kind: "source_unavailable",
        reviewer: "reviewer_a",
        source: "arxiv",
        status: "timeout",
      },
    ],
    scorecard: CARD,
    history: [
      {
        id: 0,
        mode: "panel",
        version: 1,
        at: 0,
        file: "main.tex",
        concerns: 2,
      },
      {
        id: 1,
        mode: "panel",
        version: 2,
        at: 0,
        file: "main.tex",
        concerns: 8,
      },
    ],
    selected: 1,
  };
  const narrowDeps = (
    narrowed?: string,
    locale: "en" | "zh" = "en",
  ): ReviewTabDeps => ({
    ...deps(locale),
    ...(narrowed !== undefined ? { narrowed } : {}),
    onNarrow: (d, reveal) =>
      calls.push(
        `narrow:${d ?? "-"}${reveal !== undefined ? `:${reveal}` : ""}`,
      ),
  });
  const ids = (root: Element | null | undefined): string[] =>
    [...(root?.querySelectorAll("[data-concern]") ?? [])].map(
      (n) => n.getAttribute("data-concern") ?? "",
    );
  const summaries = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll(".lm-review-fold__summary")].map((s) =>
      text(s as HTMLElement),
    );
  const fold = (panel: HTMLElement, startsWith: string) =>
    [...panel.querySelectorAll("details.lm-review-fold")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").startsWith(startsWith),
    );
  const textOf = (n: Element | null | undefined): string =>
    n?.textContent ?? "";

  it("O1: draws the block for a panel and a PDF review that carry a card", () => {
    expect(
      renderReviewTab(SC, narrowDeps()).querySelectorAll(".lm-scorecard"),
    ).toHaveLength(1);
    const pdf = renderReviewTab(
      { ...SC, mode: "pdf", seats: [] },
      narrowDeps(),
    );
    expect(pdf.querySelectorAll(".lm-scorecard")).toHaveLength(1);
  });

  it("O1: draws no block for a quick review, or for any state without a card", () => {
    const { scorecard: _card, ...cardless } = SC;
    expect(
      renderReviewTab(cardless, narrowDeps()).querySelector(".lm-scorecard"),
    ).toBeNull();
    const { seats: _seats, ...seatless } = cardless;
    expect(
      renderReviewTab(
        { ...seatless, mode: "quick" },
        narrowDeps(),
      ).querySelector(".lm-scorecard"),
    ).toBeNull();
    expect(
      renderReviewTab(PANEL, deps()).querySelector(".lm-scorecard"),
    ).toBeNull();
  });

  it("O1: sits under the header, the picker and the entry line, and above the PDF facts and every concern", () => {
    const panel = renderReviewTab(
      {
        ...SC,
        nextEntry: "other.tex",
        pdf: {
          source: "compiled",
          facts: {
            pages: 3,
            pageSize: { width: 595.28, height: 841.89, name: "a4" },
          },
        },
      } as ReviewTabState,
      narrowDeps(),
    );
    const kids = [...panel.children];
    const at = (sel: string) => kids.findIndex((k) => k.matches(sel));
    const block = at(".lm-scorecard");
    expect(block).toBeGreaterThan(at(".lm-cite-header"));
    expect(block).toBeGreaterThan(at(".lm-review-picker"));
    expect(block).toBeGreaterThan(at(".lm-review-entry"));
    expect(at(".lm-review-pdffacts")).toBeGreaterThan(-1);
    expect(block).toBeLessThan(at(".lm-review-pdffacts"));
    expect(block).toBeLessThan(at(".lm-review-fold--group"));
  });

  it("O25: reuses none of the classes the positional probes index", () => {
    const block = renderReviewTab(SC, narrowDeps()).querySelector(
      ".lm-scorecard",
    );
    expect(
      block?.querySelector(
        ".lm-review-fold, .lm-review-fold--group, .lm-cite-row, .lm-review-card, .lm-review-fold__summary",
      ),
    ).toBeNull();
    // With the block present the probes still land where they always did:
    // the seat headings first, then *Across the panel*, and the first card is
    // the first reviewer's first concern.
    const withCard = renderReviewTab({ ...PANEL, scorecard: CARD }, deps());
    expect(withCard.querySelector(".lm-scorecard")).not.toBeNull();
    const groups = summaries(withCard);
    expect(groups.slice(0, 3).map((g) => g.split(" ")[0])).toEqual([
      "reviewer_a",
      "reviewer_b",
      "reviewer_c",
    ]);
    expect(groups[3]).toContain("Across the panel");
    expect(
      withCard
        .querySelector(".lm-review-tab .lm-review-card")
        ?.getAttribute("data-concern"),
    ).toBe("reviewer_a-1");
  });

  it("O15: narrowed, every concern list shows that dimension only, matched case-insensitively", () => {
    const panel = renderReviewTab(SC, narrowDeps("soundness"));
    expect(ids(fold(panel, "reviewer_a"))).toEqual(["reviewer_a-1"]);
    expect(ids(fold(panel, "reviewer_b"))).toEqual(["reviewer_b-1"]);
    expect(ids(fold(panel, tr("en", "rSeatPdfReviewer")))).toEqual([]);
    // Copyedit held only a language concern, so it has nothing to show.
    expect(fold(panel, tr("en", "rCopyedit"))).toBeUndefined();
    expect(ids(fold(panel, tr("en", "rWithdrawn")))).toEqual(["reviewer_a-3"]);
    expect(ids(fold(panel, tr("en", "rArchived")))).toEqual(["reviewer_a-4"]);
    const aside = fold(panel, tr("en", "rSetAsideFold"));
    expect(
      [...(aside?.querySelectorAll(".lm-review-aside__concern") ?? [])].map(
        (n) => n.textContent ?? "",
      ),
    ).toEqual([
      expect.stringContaining("the argument in section 3 is circular"),
    ]);
    // The rule's own sentence stays the record's, whole: it set two aside.
    const whole = fold(
      renderReviewTab(SC, narrowDeps()),
      tr("en", "rSetAsideFold"),
    );
    expect(textOf(aside?.querySelector(".lm-review-aside__rule"))).toBe(
      textOf(whole?.querySelector(".lm-review-aside__rule")),
    );
  });

  it("O15: a pre-R9 panel's flat list narrows the same way", () => {
    const { pdfSeat: _p, ...noPdf } = SC;
    const panel = renderReviewTab(
      { ...noPdf, seats: [] },
      narrowDeps("claims"),
    );
    const flat = [...panel.children]
      .filter((c) => c.matches(".lm-review-card"))
      .map((c) => c.getAttribute("data-concern"));
    expect(flat).toEqual(["reviewer_a-2"]);
  });

  it("O15: the header, the panel line, the picker, the cross-review and the limits are untouched", () => {
    const whole = renderReviewTab(SC, narrowDeps());
    const narrowed = renderReviewTab(SC, narrowDeps("soundness"));
    for (const sel of [
      ".lm-cite-header",
      ".lm-review-picker",
      ".lm-review-launch",
      ".lm-cite-footer",
    ])
      expect(narrowed.querySelector(sel)?.outerHTML, sel).toBe(
        whole.querySelector(sel)?.outerHTML,
      );
    expect(
      textOf(narrowed.querySelector(".lm-cite-sub")),
      "the sub-line counts everything pending",
    ).toBe(`6 ${tr("en", "rAnnotations")}`);
    for (const title of [tr("en", "rSynthesis"), tr("en", "rLimits")]) {
      expect(fold(narrowed, title), title).toBeDefined();
      expect(fold(narrowed, title)?.outerHTML, title).toBe(
        fold(whole, title)?.outerHTML,
      );
    }
  });

  it("O15: says what it narrowed to and how much it shows, and offers everything back", () => {
    calls.length = 0;
    for (const locale of ["en", "zh"] as const) {
      const panel = renderReviewTab(SC, narrowDeps("soundness", locale));
      const banner = panel.querySelector(".lm-scorecard .lm-sc-narrow");
      // Soundness, not withdrawn: a-1, b-1 (pending) and a-4 (archived) — of
      // the seven concerns the verifier did not withdraw.
      expect(textOf(banner)).toContain(
        tr(locale, "scNarrowed")
          .replace("{dimension}", dimensionLabel(locale, "soundness"))
          .replace("{shown}", "3")
          .replace("{total}", "7"),
      );
      banner?.querySelector<HTMLButtonElement>(".lm-sc-narrow__all")?.click();
    }
    expect(calls).toEqual(["narrow:-", "narrow:-"]);
    expect(
      renderReviewTab(SC, narrowDeps()).querySelector(".lm-sc-narrow"),
    ).toBeNull();
  });

  it("O15: presses the narrowed row, and a click on another narrows to it", () => {
    calls.length = 0;
    const panel = renderReviewTab(SC, narrowDeps("soundness"));
    const row = (d: string) =>
      panel.querySelector<HTMLButtonElement>(
        `.lm-sc-row[data-dimension="${d}"]`,
      );
    expect(row("soundness")?.getAttribute("aria-pressed")).toBe("true");
    expect(row("claims")?.getAttribute("aria-pressed")).toBe("false");
    row("claims")?.click();
    row("soundness")?.click();
    expect(calls).toEqual(["narrow:claims", "narrow:-"]);
  });

  it("O16: a narrowed seat heading counts what it shows OF what it holds", () => {
    for (const locale of ["en", "zh"] as const) {
      const panel = renderReviewTab(SC, narrowDeps("soundness", locale));
      const of = (shown: number, total: number) =>
        tr(locale, "scSeatConcernsOf")
          .replace("{shown}", String(shown))
          .replace("{total}", String(total));
      // reviewer_a's group holds two pending concerns (a-1, a-2; a-3 was
      // withdrawn and a-4 archived); reviewer_b's one (b-1 — its copyedit
      // went to Copyedit and b-3 to the archive).
      expect(
        textOf(fold(panel, "reviewer_a")?.querySelector(".lm-review-count")),
      ).toBe(of(1, 2));
      expect(
        textOf(fold(panel, "reviewer_b")?.querySelector(".lm-review-count")),
      ).toBe(of(1, 1));
      expect(
        textOf(
          fold(panel, tr(locale, "rSeatPdfReviewer"))?.querySelector(
            ".lm-review-count",
          ),
        ),
      ).toBe(of(0, 1));
    }
    const whole = renderReviewTab(SC, narrowDeps());
    expect(
      textOf(fold(whole, "reviewer_a")?.querySelector(".lm-review-count")),
    ).toBe(`2 ${tr("en", "rSeatConcerns")}`);
  });

  it("O16: a seat that reported nothing, or failed, keeps its own heading", () => {
    const state: ReviewTabState = {
      ...SC,
      seats: [
        { reviewer: "reviewer_a", count: 4, model: "m1" },
        { reviewer: "reviewer_b", count: 0, model: "m1" },
        {
          reviewer: "reviewer_c",
          count: 0,
          missing: {
            kind: "seat_missing",
            reviewer: "reviewer_c",
            reason: "failed",
          },
        },
      ],
    };
    const whole = summaries(renderReviewTab(state, narrowDeps()));
    const narrowed = summaries(renderReviewTab(state, narrowDeps("claims")));
    for (const who of ["reviewer_b", "reviewer_c"]) {
      expect(
        whole.find((s) => s.startsWith(who)),
        who,
      ).toBeDefined();
      expect(
        narrowed.find((s) => s.startsWith(who)),
        who,
      ).toBe(whole.find((s) => s.startsWith(who)));
    }
  });

  it("O16: every fold's count is what it shows", () => {
    const panel = renderReviewTab(SC, narrowDeps("soundness"));
    const summary = (p: HTMLElement, title: string) =>
      textOf(fold(p, title)?.querySelector("summary"));
    expect(summary(panel, tr("en", "rWithdrawn"))).toBe(
      `${tr("en", "rWithdrawn")} · 1`,
    );
    expect(summary(panel, tr("en", "rArchived"))).toBe(
      `${tr("en", "rArchived")} · 1`,
    );
    expect(summary(panel, tr("en", "rSetAsideFold"))).toBe(
      `${tr("en", "rSetAsideFold")} · 1`,
    );
    const language = renderReviewTab(SC, narrowDeps("language"));
    expect(summary(language, tr("en", "rCopyedit"))).toBe(
      `${tr("en", "rCopyedit")} · 1`,
    );
  });

  it("O17: a chip whose row the narrowing hides clears it and asks to land there", () => {
    calls.length = 0;
    const panel = renderReviewTab(SC, narrowDeps("soundness"));
    const chips = [
      ...panel.querySelectorAll<HTMLButtonElement>(".lm-review-chip--link"),
    ];
    // reviewer_a-2 is a claims concern: hidden under soundness.
    chips.find((c) => c.textContent === "reviewer_a-2")?.click();
    expect(calls).toEqual(["narrow:-:reviewer_a-2"]);
    // A visible one scrolls as it always did, and clears nothing.
    calls.length = 0;
    chips.find((c) => c.textContent === "reviewer_a-1")?.click();
    expect(calls.filter((c) => c.startsWith("narrow"))).toEqual([]);
    expect(
      panel
        .querySelector('[data-concern="reviewer_a-1"]')
        ?.classList.contains("is-target"),
    ).toBe(true);
  });

  it("O17: the render that clears it lands on the row the chip named", () => {
    calls.length = 0;
    const panel = renderReviewTab(SC, {
      ...narrowDeps(),
      target: "reviewer_b-2",
    });
    const row = panel.querySelector('[data-concern="reviewer_b-2"]');
    expect(row?.classList.contains("is-target")).toBe(true);
    // Its fold — Copyedit, closed by default — is opened, and remembered.
    expect(row?.closest("details")?.hasAttribute("open")).toBe(true);
    expect(calls).toContain("fold:copyedit:true");
    expect(panel.querySelectorAll(".is-target")).toHaveLength(1);
  });

  it("O18: in quick mode a narrowing is ignored — no filter, no banner, no pressed row", () => {
    const {
      scorecard: _c,
      seats: _s,
      pdfSeat: _p,
      synthesis: _y,
      ...rest
    } = SC;
    const quick: ReviewTabState = { ...rest, mode: "quick" };
    const whole = renderReviewTab(quick, narrowDeps());
    const narrowed = renderReviewTab(quick, narrowDeps("soundness"));
    expect(narrowed.outerHTML).toBe(whole.outerHTML);
    expect(narrowed.querySelector(".lm-sc-narrow")).toBeNull();
    expect(narrowed.querySelector("[aria-pressed]")).toBeNull();
    expect(narrowed.querySelectorAll("[data-concern]").length).toBeGreaterThan(
      1,
    );
  });
});

/**
 * V6 (O23; open-questions → *some Review-tab text a reader has to read is
 * still drawn in the disabled token*, whose trigger — the next milestone that
 * opens the Review tab's rows — V6 is): the two places that entry shaped as
 * text a reader reads move to the dim token; the two it left to the operator
 * do not move.
 */
describe("V6: an info concern's title and the other-entry line read in the dim token (O23)", () => {
  const info = annotation({
    id: "reviewer_c-1",
    reviewer: "reviewer_c",
    dimension: "positioning",
    severity: "info",
  });

  it("gives an info concern's title the dim class, and leaves its glyph faint", () => {
    const state: ReviewTabState = { ...PANEL, annotations: [info] };
    const row = renderReviewTab(state, deps()).querySelector(
      '[data-concern="reviewer_c-1"]',
    );
    const title = row?.querySelector(".lm-cite-row__title");
    expect(title?.classList.contains("is-dim")).toBe(true);
    expect(title?.classList.contains("is-faint")).toBe(false);
    expect(
      row?.querySelector(".lm-cite-row__icon")?.classList.contains("is-faint"),
    ).toBe(true);
    // Quick mode draws the same row the same way.
    const quick = renderReviewTab(
      {
        available: true,
        mode: "quick",
        file: "main.tex",
        entry: "main.tex",
        nextEntry: "main.tex",
        annotations: [info],
      },
      deps(),
    );
    expect(
      quick.querySelector(".lm-cite-row__title")?.classList.contains("is-dim"),
    ).toBe(true);
  });

  it("draws the other-entry line without the disabled class", () => {
    const panel = renderReviewTab({ ...PANEL, nextEntry: "other.tex" }, deps());
    const was = [...panel.querySelectorAll(".lm-review-entry")].find((n) =>
      (n.textContent ?? "").startsWith(tr("en", "rEntryWas")),
    );
    expect(was).toBeDefined();
    expect(was?.classList.contains("is-faint")).toBe(false);
  });

  it("leaves the archived row and the no-entry placeholder as the operator's call", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        nextEntry: "",
        annotations: [{ ...info, status: "ignored" }],
      },
      deps(),
    );
    const archived = panel.querySelector('[data-concern="reviewer_c-1"]');
    expect(
      archived
        ?.querySelector(".lm-cite-row__title")
        ?.classList.contains("is-faint"),
    ).toBe(true);
    expect(
      panel
        .querySelector(".lm-review-entry__file")
        ?.classList.contains("is-faint"),
    ).toBe(true);
  });
});

describe("V6: the code review's round on narrowing", () => {
  const concern = (
    index: number,
    dimension: string,
    status: ReviewAnnotationInfo["status"] = "pending",
  ): ReviewAnnotationInfo =>
    annotation({
      index,
      id: `reviewer_a-${index}`,
      dimension,
      line: index + 1,
      status,
    });
  /** A card no seat contributed to — a panel stored before X5, whose seats
   *  carried no ledger, or one whose every seat failed. */
  const UNMEASURED: Scorecard = {
    readiness: { label: "not_assessed", checked: true },
    notAssessed: 8,
    dimensions: [],
    panel: { reviewers: [], verificationOn: true },
  };
  const narrowing = (narrowed: string): ReviewTabDeps => ({
    ...deps(),
    narrowed,
    onNarrow: (d, reveal) =>
      calls.push(
        `narrow:${d ?? "-"}${reveal !== undefined ? `:${reveal}` : ""}`,
      ),
  });

  it("applies no narrowing over a card that has no row to press", () => {
    // Narrowed on a measured version, then the picker selects an older one:
    // with no row and no banner, a filter would hide concerns with nothing on
    // screen to say so or to clear it.
    const state: ReviewTabState = {
      ...PANEL,
      annotations: [
        concern(0, "soundness"),
        concern(1, "claims"),
        concern(2, "clarity"),
      ],
      seats: [{ reviewer: "reviewer_a", count: 3 }],
      synthesis: undefined,
      scorecard: UNMEASURED,
    };
    const whole = renderReviewTab(state, deps());
    const narrowed = renderReviewTab(state, narrowing("soundness"));
    expect(
      [...narrowed.querySelectorAll("[data-concern]")].map((n) =>
        n.getAttribute("data-concern"),
      ),
    ).toEqual(["reviewer_a-0", "reviewer_a-1", "reviewer_a-2"]);
    expect(narrowed.querySelector(".lm-sc-narrow")).toBeNull();
    expect(narrowed.querySelector(".lm-review-count")?.textContent ?? "").toBe(
      `3 ${tr("en", "rSeatConcerns")}`,
    );
    expect(narrowed.outerHTML).toBe(whole.outerHTML);
  });

  it("tells the block when the review has no seat at all, so it says no reviewer ran (E1's round)", () => {
    const sentence = (state: ReviewTabState): string =>
      renderReviewTab(state, deps("zh")).querySelector(".lm-sc-unmeasured")
        ?.textContent ?? "";
    // The stored PDF-only record of the 中文 window: no seat, no PDF seat.
    expect(
      sentence({
        ...PANEL,
        mode: "pdf",
        annotations: [],
        seats: [],
        synthesis: undefined,
        scorecard: UNMEASURED,
      }),
    ).toBe(tr("zh", "scNoReviewerRan"));
    // Seats that ran, none of them with a ledger: the old sentence is true.
    expect(
      sentence({
        ...PANEL,
        seats: [{ reviewer: "reviewer_a", count: 0 }],
        synthesis: undefined,
        scorecard: UNMEASURED,
      }),
    ).toBe(tr("zh", "scUnmeasured"));
  });

  it("does not clear a narrowing for a chip that names an archived concern", () => {
    calls.length = 0;
    const CARD: Scorecard = {
      readiness: { label: "none", checked: true },
      notAssessed: 0,
      dimensions: [],
      panel: {
        reviewers: [{ reviewer: "reviewer_a", model: "m1" }],
        verificationOn: true,
      },
    };
    const state: ReviewTabState = {
      ...PANEL,
      annotations: [concern(0, "soundness"), concern(1, "claims", "ignored")],
      seats: [{ reviewer: "reviewer_a", count: 2 }],
      synthesis: {
        consensus: [{ ids: ["reviewer_a-1"], note: "an archived one" }],
        disagreements: [],
      },
      scorecard: CARD,
    };
    const panel = renderReviewTab(state, narrowing("soundness"));
    panel.querySelector<HTMLButtonElement>(".lm-review-chip--link")?.click();
    // No archived row is ever located, so clearing would land nowhere.
    expect(calls.filter((c) => c.startsWith("narrow"))).toEqual([]);
  });
});
