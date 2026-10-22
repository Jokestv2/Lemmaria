/**
 * O16 (the launcher's half) and O19: the Review tab's PDF reviewer (V4, ADR
 * 0081 §§1, 3–5, 7–8; plan D12–D13).
 *
 * Kept apart from `review-tab.test.ts` so the merged suite's only V4 edit is
 * the one *The one rule about merged tests* allows (nine dimensions → ten).
 * The fixtures below are that suite's shapes, restated.
 */
import type { ReviewLimit, ReviewPdfRecord } from "@lemmaria/harness";
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
import { tr, versionLabel } from "../src/webview/parts/strings.js";

const calls: string[] = [];
const deps = (
  locale: "en" | "zh" = "en",
  opts: { run?: ReviewRunView; pdf?: boolean } = {},
): ReviewTabDeps => ({
  locale,
  reveal: (i) => calls.push(`reveal:${i}`),
  revealCounter: (i) => calls.push(`counter:${i}`),
  ignore: (i) => calls.push(`ignore:${i}`),
  adopt: (i) => calls.push(`adopt:${i}`),
  resolve: (a) => calls.push(`resolve:${a.id}`),
  chat: (a) => calls.push(`chat:${a.id}`),
  selectReview: (id) => calls.push(`select:${id}`),
  chooseEntry: () => calls.push("entry"),
  runPanel: () => calls.push("run"),
  ...(opts.pdf === false ? {} : { runPdf: () => calls.push("pdf") }),
  stopPanel: () => calls.push("stop"),
  ...(opts.run ? { run: opts.run } : {}),
  groupOpen: (_key, fallback) => fallback,
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

const PDF: ReviewPdfRecord = {
  source: "compiled",
  facts: {
    pages: 3,
    pageSize: { width: 595.28, height: 841.89, name: "a4" },
    referencesStart: 3,
    mainTextPages: 2,
  },
  viewed: [1, 2, 3],
};

const PAGE_CONCERN = annotation({
  index: 2,
  id: "pdf_reviewer-1",
  dimension: "presentation",
  severity: "minor",
  reviewer: "pdf_reviewer",
  line: 12,
  message: "the results table runs past its column",
  evidence: { kind: "page", page: 2 },
});

/** A panel of two reviewers with a PDF reviewer beside them, verified. */
const PANEL: ReviewTabState = {
  available: true,
  mode: "panel",
  file: "main.tex",
  entry: "main.tex",
  nextEntry: "main.tex",
  annotations: [
    annotation(),
    annotation({
      index: 1,
      id: "reviewer_b-1",
      reviewer: "reviewer_b",
      dimension: "claims",
      message: "the estimator is asserted, never defined",
    }),
    PAGE_CONCERN,
  ],
  seats: [
    { reviewer: "reviewer_a", count: 1, model: "claude-sonnet-4-5" },
    { reviewer: "reviewer_b", count: 1, model: "claude-sonnet-4-5" },
  ],
  verifier: { model: "claude-sonnet-4-5" },
  pdfSeat: { reviewer: "pdf_reviewer", count: 1, model: "claude-haiku-4-5" },
  pdf: PDF,
};

/** A `/review-pdf` run: no reviewers, no verifier, no cross-review. */
const PDF_ONLY: ReviewTabState = {
  available: true,
  mode: "pdf",
  file: "main.tex",
  entry: "main.tex",
  nextEntry: "main.tex",
  annotations: [{ ...PAGE_CONCERN, index: 0 }],
  seats: [],
  pdfSeat: { reviewer: "pdf_reviewer", count: 1, model: "claude-haiku-4-5" },
  pdf: PDF,
};

const text = (node: Element | null | undefined): string =>
  node?.textContent ?? "";
const summaries = (panel: HTMLElement): string[] =>
  [...panel.querySelectorAll(".lm-review-fold__summary")].map(text);
const pdfGroup = (panel: HTMLElement): HTMLElement | null =>
  panel.querySelector<HTMLElement>('[data-seat="pdf_reviewer"]');
const rowOf = (panel: HTMLElement, id: string): HTMLElement | null =>
  panel.querySelector<HTMLElement>(`[data-concern="${id}"]`);
const precedes = (a: Node | null, b: Node | null): boolean =>
  a !== null &&
  b !== null &&
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("the launcher's second verb, Review the PDF (O16)", () => {
  const launch = (p: HTMLElement) =>
    p.querySelector<HTMLElement>(".lm-review-launch");
  const pdfButton = (p: HTMLElement) =>
    p.querySelector<HTMLButtonElement>(".lm-review-launch__pdf");

  it("draws it after Run blind panel, and a click reviews the PDF", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    const button = pdfButton(panel);
    expect(button?.textContent).toBe("Review the PDF");
    expect(
      precedes(panel.querySelector(".lm-review-launch__run"), button),
    ).toBe(true);
    expect(button?.parentElement).toBe(launch(panel));
    button?.click();
    expect(calls).toEqual(["pdf"]);
  });

  it("is drawn before any review has run — it is a way to start one", () => {
    const panel = renderReviewTab(
      {
        available: false,
        mode: "quick",
        file: "",
        entry: "",
        nextEntry: "main.tex",
        annotations: [],
      },
      deps(),
    );
    expect(pdfButton(panel)?.textContent).toBe("Review the PDF");
  });

  it("is disabled with the busy title while any review runs, and a click does nothing", () => {
    calls.length = 0;
    const panel = renderReviewTab(
      PANEL,
      deps("en", { run: { running: true, notices: [] } }),
    );
    const button = pdfButton(panel);
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe(tr("en", "rRunPanelBusy"));
    // The same state and title as the panel's own button.
    const run = panel.querySelector<HTMLButtonElement>(
      ".lm-review-launch__run",
    );
    expect(run?.disabled).toBe(true);
    expect(run?.title).toBe(button?.title);
    button?.click();
    expect(calls).toEqual([]);
  });

  it("is enabled again once the run has ended", () => {
    const panel = renderReviewTab(
      PANEL,
      deps("en", { run: { running: false, notices: [] } }),
    );
    expect(pdfButton(panel)?.disabled).toBe(false);
    expect(pdfButton(panel)?.hasAttribute("title")).toBe(false);
  });

  it("is not drawn when the tab is given nothing to run it with", () => {
    const panel = renderReviewTab(PANEL, deps("en", { pdf: false }));
    expect(pdfButton(panel)).toBeNull();
  });

  it("says it in Chinese", () => {
    expect(pdfButton(renderReviewTab(PANEL, deps("zh")))?.textContent).toBe(
      "审阅 PDF",
    );
  });

  it("names the third route in the empty hint, in both locales", () => {
    const empty = (locale: "en" | "zh") =>
      text(
        renderReviewTab(
          {
            available: false,
            mode: "quick",
            file: "",
            entry: "",
            nextEntry: "",
            annotations: [],
          },
          deps(locale),
        ).querySelector(".lm-cite-empty"),
      );
    expect(empty("en")).toContain("review the compiled PDF alone");
    expect(empty("en")).toContain("blind panel over the whole manuscript");
    expect(empty("zh")).toContain("单独评审已编译的 PDF");
  });
});

describe("the facts block's place in the tab (O19)", () => {
  it("sits after the panel line and before the first seat group", () => {
    const panel = renderReviewTab(PANEL, deps());
    const facts = panel.querySelector(".lm-review-pdffacts");
    expect(facts).not.toBeNull();
    expect(precedes(panel.querySelector(".lm-review-panelline"), facts)).toBe(
      true,
    );
    expect(precedes(facts, panel.querySelector(".lm-review-fold"))).toBe(true);
  });

  it("is drawn in pdf mode too, and not without a record", () => {
    expect(
      renderReviewTab(PDF_ONLY, deps()).querySelector(".lm-review-pdffacts"),
    ).not.toBeNull();
    const { pdf: _pdf, ...none } = PANEL;
    expect(
      renderReviewTab(none, deps()).querySelector(".lm-review-pdffacts"),
    ).toBeNull();
  });

  it("is never drawn for a quick review", () => {
    const quick: ReviewTabState = {
      ...PANEL,
      mode: "quick",
      file: "main.tex",
      annotations: [],
    };
    expect(
      renderReviewTab(quick, deps()).querySelector(".lm-review-pdffacts"),
    ).toBeNull();
  });
});

describe("the PDF reviewer's group (O19)", () => {
  it("comes after the reviewers and before Copyedit, headed PDF reviewer · model", () => {
    const withCopyedit: ReviewTabState = {
      ...PANEL,
      annotations: [
        ...PANEL.annotations,
        annotation({
          index: 3,
          id: "reviewer_a-2",
          dimension: "language",
          severity: "info",
          hasSuggestion: true,
          suggestion: "its",
          message: "it's → its",
        }),
      ],
    };
    const heads = summaries(renderReviewTab(withCopyedit, deps()));
    expect(heads[0]).toMatch(/^reviewer_a/);
    expect(heads[1]).toMatch(/^reviewer_b/);
    expect(heads[2]).toBe(
      `PDF reviewer · claude-haiku-4-5 · 1 ${tr("en", "rSeatConcerns")}`,
    );
    expect(heads[3]).toMatch(/^Copyedit/);
  });

  it("is open on arrival, keyed by its seat, and never prints the record's word for it", () => {
    calls.length = 0;
    const panel = renderReviewTab(PANEL, deps());
    const group = pdfGroup(panel) as HTMLDetailsElement;
    expect(group.open).toBe(true);
    group.open = false;
    group.dispatchEvent(new Event("toggle"));
    expect(calls).toEqual(["fold:seat:pdf_reviewer:false"]);
    expect(text(group.querySelector(".lm-review-fold__summary"))).not.toContain(
      "pdf_reviewer",
    );
  });

  it("holds the PDF reviewer's concerns, and only those", () => {
    const group = pdfGroup(renderReviewTab(PANEL, deps()));
    expect(
      [...(group?.querySelectorAll("[data-concern]") ?? [])].map((r) =>
        r.getAttribute("data-concern"),
      ),
    ).toEqual(["pdf_reviewer-1"]);
  });

  it("goes through the five heading shapes unchanged", () => {
    const head = (seat: ReviewTabState["pdfSeat"], limits?: ReviewLimit[]) =>
      text(
        pdfGroup(
          renderReviewTab(
            {
              ...PANEL,
              annotations: PANEL.annotations.slice(0, 2),
              pdfSeat: seat,
              ...(limits ? { limits } : {}),
            },
            deps(),
          ),
        )?.querySelector(".lm-review-fold__summary"),
      );
    const base = { reviewer: "pdf_reviewer", model: "m-1" };
    expect(head({ ...base, count: 0 })).toBe(
      `PDF reviewer · m-1 — ${tr("en", "rSeatNone")}`,
    );
    expect(
      head({ ...base, count: 0 }, [
        {
          kind: "anchors_dropped",
          reviewer: "pdf_reviewer",
          anchors: [{ anchor: "q", role: "claim", reason: "not_found" }],
        },
      ]),
    ).toBe(
      `PDF reviewer · m-1 — ${tr("en", "rSeatOneUnanchored").replace("{n}", "1")}`,
    );
    for (const [reason, key] of [
      ["failed", "rSeatFailed"],
      ["interrupted", "rSeatInterrupted"],
      ["unparsed", "rSeatUnparsed"],
    ] as const) {
      expect(
        head({
          ...base,
          count: 0,
          missing: { kind: "seat_missing", reviewer: "pdf_reviewer", reason },
        }),
      ).toBe(`PDF reviewer · m-1 — ${tr("en", key)}`);
    }
  });

  it("says why a failed PDF reviewer failed, under its heading", () => {
    const group = pdfGroup(
      renderReviewTab(
        {
          ...PANEL,
          annotations: PANEL.annotations.slice(0, 2),
          pdfSeat: {
            reviewer: "pdf_reviewer",
            count: 0,
            model: "m-1",
            missing: {
              kind: "seat_missing",
              reviewer: "pdf_reviewer",
              reason: "failed",
              cause: {
                class: "fatal",
                message: "model does not support images",
              },
            },
          },
        },
        deps(),
      ),
    );
    const cause = group?.querySelector(".lm-review-cause");
    expect(cause?.previousElementSibling?.tagName).toBe("SUMMARY");
    expect(text(cause)).toContain("model does not support images");
  });

  it("says once, under its heading, that its concerns were not checked — when verification completed", () => {
    const group = pdfGroup(renderReviewTab(PANEL, deps()));
    const sentence = group?.querySelector(".lm-review-unchecked");
    expect(text(sentence)).toBe(tr("en", "rSeatPdfUnchecked"));
    expect(sentence?.previousElementSibling?.tagName).toBe("SUMMARY");
    expect(group?.querySelectorAll(".lm-review-unchecked")).toHaveLength(1);
  });

  it("does not say it when verification did not complete — the limits fold says that", () => {
    const missing = renderReviewTab(
      {
        ...PANEL,
        limits: [{ kind: "verification_missing", reason: "incomplete" }],
      },
      deps(),
    );
    expect(pdfGroup(missing)?.querySelector(".lm-review-unchecked")).toBeNull();
    const { verifier: _v, ...unverified } = PANEL;
    expect(
      pdfGroup(renderReviewTab(unverified, deps()))?.querySelector(
        ".lm-review-unchecked",
      ),
    ).toBeNull();
  });

  it("marks no row of it not checked, while a reviewer's unverified row still is", () => {
    const panel = renderReviewTab(PANEL, deps());
    const unchecked = tr("en", "rConcernUnchecked");
    expect(
      text(
        rowOf(panel, "pdf_reviewer-1")?.querySelector(".lm-cite-row__detail"),
      ),
    ).not.toContain(unchecked);
    expect(
      text(rowOf(panel, "reviewer_a-1")?.querySelector(".lm-cite-row__detail")),
    ).toContain(unchecked);
  });

  it("marks none of its rows in Copyedit or the archive either — by the seat, not the fold", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: [
          ...PANEL.annotations.slice(0, 2),
          {
            ...PAGE_CONCERN,
            dimension: "language",
            hasSuggestion: true,
            suggestion: "x",
          },
          {
            ...PAGE_CONCERN,
            index: 3,
            id: "pdf_reviewer-2",
            status: "ignored",
          },
        ],
        pdfSeat: { reviewer: "pdf_reviewer", count: 2, model: "m-1" },
      },
      deps(),
    );
    const unchecked = tr("en", "rConcernUnchecked");
    for (const id of ["pdf_reviewer-1", "pdf_reviewer-2"])
      expect(text(rowOf(panel, id)), id).not.toContain(unchecked);
  });

  it("draws its page evidence and its presentation label", () => {
    const row = rowOf(renderReviewTab(PANEL, deps()), "pdf_reviewer-1");
    expect(text(row?.querySelector(".lm-cite-row__evidence"))).toBe(
      "evidence · page 2 of the compiled PDF",
    );
    expect(text(row)).toContain("presentation: the results table runs past");
  });

  it("reads in Chinese", () => {
    const panel = renderReviewTab(PANEL, deps("zh"));
    const group = pdfGroup(panel);
    expect(text(group?.querySelector(".lm-review-fold__summary"))).toMatch(
      /^PDF 评审人 · claude-haiku-4-5 · 1 条意见$/,
    );
    expect(text(group?.querySelector(".lm-review-unchecked"))).toBe(
      tr("zh", "rSeatPdfUnchecked"),
    );
    const row = rowOf(panel, "pdf_reviewer-1");
    expect(text(row?.querySelector(".lm-cite-row__evidence"))).toBe(
      "依据 · 已编译 PDF 第 2 页",
    );
    expect(text(row)).toContain(
      `${tr("zh", "rDimPresentation")}: the results table`,
    );
    expect(tr("zh", "rDimPresentation")).not.toBe("presentation");
  });
});

describe("the three ways a review falls short of the page (O19)", () => {
  it("says each pdf_unavailable reason as one whole sentence", () => {
    for (const [reason, key] of [
      ["none", "rLimitPdfNone"],
      ["stale", "rLimitPdfStale"],
      ["compile_failed", "rLimitPdfCompileFailed"],
      ["render_failed", "rLimitPdfRenderFailed"],
    ] as const) {
      for (const locale of ["en", "zh"] as const)
        expect(limitSentence(locale, { kind: "pdf_unavailable", reason })).toBe(
          tr(locale, key),
        );
    }
  });

  it("never prints a limit's detail — the harness's English (ADR 0060 §5)", () => {
    expect(
      limitSentence("zh", {
        kind: "pdf_unavailable",
        reason: "compile_failed",
        detail: "! LaTeX Error: File `x.sty' not found.",
      }),
    ).not.toContain("LaTeX Error");
  });

  it("says each visual_unavailable reason", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(
        limitSentence(locale, {
          kind: "visual_unavailable",
          reason: "model_has_no_image_input",
        }),
      ).toBe(tr(locale, "rLimitVisualNoImageInput"));
      expect(
        limitSentence(locale, {
          kind: "visual_unavailable",
          reason: "no_renderer",
        }),
      ).toBe(tr(locale, "rLimitVisualNoRenderer"));
    }
  });

  it("fills pages_unviewed's two numbers", () => {
    const limit: ReviewLimit = { kind: "pages_unviewed", viewed: 2, total: 5 };
    expect(limitSentence("en", limit)).toBe(
      "the PDF reviewer viewed 2 of 5 pages",
    );
    expect(limitSentence("zh", limit)).toBe("PDF 评审人查看了 5 页中的 2 页");
  });

  it("says a skipped PDF reviewer did not run, and how to bring it back — never that it reviewed", () => {
    // The seat never ran, so the tab has no row for it and passes no name.
    const skipped: ReviewLimit = {
      kind: "seat_unguided",
      reviewer: "pdf_reviewer",
    };
    expect(limitSentence("en", skipped)).toBe(tr("en", "rLimitPdfSeatSkipped"));
    expect(limitSentence("en", skipped)).toContain("did not run");
    expect(limitSentence("en", skipped)).toContain("Skills list");
    expect(limitSentence("zh", skipped)).toBe(tr("zh", "rLimitPdfSeatSkipped"));
    expect(limitSentence("zh", skipped)).toContain("未运行");
    expect(limitSentence("en", skipped)).not.toContain(
      tr("en", "rLimitSeatUnguided"),
    );
    // A text reviewer's unguided limit is unchanged.
    expect(
      limitSentence("en", { kind: "seat_unguided", reviewer: "reviewer_a" }),
    ).toBe(`reviewer_a: ${tr("en", "rLimitSeatUnguided")}`);
  });

  it("names the PDF reviewer in a limit about it, as its heading does", () => {
    const unguided: ReviewLimit = {
      kind: "seat_unguided",
      reviewer: "pdf_reviewer",
    };
    expect(limitSentence("en", unguided, "pdf_reviewer")).toBe(
      `PDF reviewer: ${tr("en", "rLimitSeatUnguided")}`,
    );
    expect(limitSentence("zh", unguided, "pdf_reviewer")).toBe(
      `PDF 评审人: ${tr("zh", "rLimitSeatUnguided")}`,
    );
    // A reviewer's own limit is untouched. (A PDF reviewer's limit with NO
    // seat named is the skipped seat — the case above, since the code review.)
    expect(
      limitSentence(
        "en",
        { kind: "seat_unguided", reviewer: "reviewer_a" },
        "pdf_reviewer",
      ),
    ).toBe(`reviewer_a: ${tr("en", "rLimitSeatUnguided")}`);
  });

  it("draws them in the limits fold, the PDF reviewer by name", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        limits: [
          { kind: "pages_unviewed", viewed: 2, total: 3 },
          { kind: "seat_unguided", reviewer: "pdf_reviewer" },
        ],
      },
      deps(),
    );
    const rows = [...panel.querySelectorAll(".lm-review-limit")].map(text);
    expect(rows).toEqual([
      "the PDF reviewer viewed 2 of 3 pages",
      `PDF reviewer: ${tr("en", "rLimitSeatUnguided")}`,
    ]);
  });
});

describe("a review of the PDF alone (O19)", () => {
  it("is titled PDF review with the entry, draws no panel line, and its one group is the PDF reviewer's", () => {
    const panel = renderReviewTab(PDF_ONLY, deps());
    expect(text(panel.querySelector(".lm-cite-title"))).toBe(
      "PDF review · main.tex",
    );
    expect(panel.querySelector(".lm-review-panelline")).toBeNull();
    const groups = [...panel.querySelectorAll(".lm-review-fold--group")];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBe(pdfGroup(panel));
    // No verifier ran, so there is nothing to say about one.
    expect(panel.querySelector(".lm-review-unchecked")).toBeNull();
  });

  it("titles itself in Chinese", () => {
    expect(
      text(
        renderReviewTab(PDF_ONLY, deps("zh")).querySelector(".lm-cite-title"),
      ),
    ).toBe("PDF 评审 · main.tex");
  });

  it("shows a run that could not see the page as its limit, and nothing else", () => {
    // D11: a PDF-only run that cannot run COMPLETES, with an empty ledger and
    // one limit — which is then the whole of what the tab has to show.
    const blind: ReviewTabState = {
      available: true,
      mode: "pdf",
      file: "main.tex",
      entry: "main.tex",
      nextEntry: "main.tex",
      annotations: [],
      seats: [],
      limits: [
        { kind: "visual_unavailable", reason: "model_has_no_image_input" },
      ],
    };
    const panel = renderReviewTab(blind, deps());
    expect(text(panel.querySelector(".lm-cite-title"))).toBe(
      "PDF review · main.tex",
    );
    expect(panel.querySelector(".lm-review-pdffacts")).toBeNull();
    expect(pdfGroup(panel)).toBeNull();
    expect(summaries(panel)).toEqual([`${tr("en", "rLimits")} · 1`]);
    expect([...panel.querySelectorAll(".lm-review-limit")].map(text)).toEqual([
      tr("en", "rLimitVisualNoImageInput"),
    ]);
  });

  it("is named as a PDF review in the picker", () => {
    const panel = renderReviewTab(
      {
        ...PDF_ONLY,
        history: [
          {
            id: 0,
            mode: "panel",
            version: 1,
            at: 0,
            file: "main.tex",
            concerns: 3,
          },
          {
            id: 1,
            mode: "pdf",
            version: 2,
            at: 0,
            file: "main.tex",
            concerns: 1,
          },
        ],
        selected: 1,
      },
      deps(),
    );
    const options = [
      ...panel.querySelectorAll<HTMLOptionElement>(".lm-review-picker option"),
    ].map(text);
    expect(options[0]).toMatch(
      new RegExp(`^${versionLabel("en", 2)} · PDF review · `),
    );
    expect(options[1]).not.toContain("PDF review");
  });
});

describe("J1's review round: a seat that ran out of a budget says which (O32)", () => {
  /** J1's own record: the seat viewed 8 of 9 pages and wrote no report. */
  const ranOut = (
    budget: "turns" | "tool_calls" | "output_tokens",
    reviewer = "pdf_reviewer",
  ): Extract<ReviewLimit, { kind: "seat_missing" }> => ({
    kind: "seat_missing",
    reviewer,
    reason: "unparsed",
    detail: `the seat produced no report (budget.${budget})`,
    ranOutOf: budget,
  });
  const KEYS = [
    ["turns", "rSeatRanOutTurns", "rLimitRanOutTurns", "maxTurns"],
    [
      "tool_calls",
      "rSeatRanOutToolCalls",
      "rLimitRanOutToolCalls",
      "maxToolCalls",
    ],
    ["output_tokens", "rSeatRanOutOutput", "rLimitRanOutOutput", "maxTokens"],
  ] as const;
  /** J1's panel: the reviewers verified, the PDF reviewer out of calls. */
  const failedSeat = (locale: "en" | "zh" = "en") =>
    renderReviewTab(
      {
        ...PANEL,
        annotations: PANEL.annotations.slice(0, 2),
        pdfSeat: {
          reviewer: "pdf_reviewer",
          count: 0,
          model: "gpt-5.6-luna",
          missing: ranOut("tool_calls"),
        },
        limits: [ranOut("tool_calls")],
      },
      deps(locale),
    );

  it("heads the group with the budget, never as an unreadable report", () => {
    for (const [budget, seatKey] of KEYS) {
      const group = pdfGroup(
        renderReviewTab(
          {
            ...PANEL,
            annotations: PANEL.annotations.slice(0, 2),
            pdfSeat: {
              reviewer: "pdf_reviewer",
              count: 0,
              model: "m-1",
              missing: ranOut(budget),
            },
          },
          deps(),
        ),
      );
      expect(text(group?.querySelector(".lm-review-fold__summary"))).toBe(
        `PDF reviewer · m-1 — ${tr("en", seatKey)}`,
      );
    }
  });

  it("names the setting to raise in the limits fold, and never prints the detail", () => {
    for (const [budget, , limitKey, setting] of KEYS) {
      const sentence = limitSentence("en", ranOut(budget), "pdf_reviewer");
      expect(sentence).toBe(`PDF reviewer: ${tr("en", limitKey)}`);
      expect(sentence).toContain(`lemmaria.budget.${setting}`);
      expect(sentence).not.toContain("budget.tool_calls)");
      expect(sentence).not.toContain(tr("en", "rReasonUnparsed"));
    }
  });

  it("says it in Chinese, wholly, but for the setting's own name", () => {
    for (const [budget, seatKey, limitKey, setting] of KEYS) {
      expect(tr("zh", seatKey)).not.toBe(tr("en", seatKey));
      expect(tr("zh", limitKey)).not.toBe(tr("en", limitKey));
      const sentence = limitSentence("zh", ranOut(budget), "pdf_reviewer");
      expect(sentence).toContain(`lemmaria.budget.${setting}`);
      // The setting's id, `PDF` and the `token` loanword the zh budget strings
      // already use are the only Latin letters allowed.
      expect(
        sentence
          .replace(`lemmaria.budget.${setting}`, "")
          .replace("PDF", "")
          .replace("token", ""),
      ).not.toMatch(/[A-Za-z]{2,}/);
    }
    expect(
      text(
        pdfGroup(failedSeat("zh"))?.querySelector(".lm-review-fold__summary"),
      ),
    ).toBe(`PDF 评审人 · gpt-5.6-luna — ${tr("zh", "rSeatRanOutToolCalls")}`);
  });

  it("draws no not-checked sentence under a group that holds no row", () => {
    // The verifier completed on the reviewers, so the old rule drew the
    // sentence under J1's empty, failed group.
    expect(
      pdfGroup(failedSeat())?.querySelector(".lm-review-unchecked"),
    ).toBeNull();
  });

  it("counts a reviewer out of budget as such in the panel line, not as unreadable", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: PANEL.annotations.slice(1),
        seats: [
          {
            reviewer: "reviewer_a",
            count: 0,
            model: "claude-sonnet-4-5",
            missing: ranOut("turns", "reviewer_a"),
          },
          { reviewer: "reviewer_b", count: 1, model: "claude-sonnet-4-5" },
        ],
      },
      deps(),
    );
    const line = text(panel.querySelector(".lm-review-panelline"));
    expect(line).toContain(tr("en", "rHeadOutOfBudget").replace("{n}", "1"));
    expect(line).not.toContain(tr("en", "rHeadUnparsed").replace("{n}", "1"));
    expect(summaries(panel).find((s) => s.startsWith("reviewer_a"))).toBe(
      `reviewer_a · claude-sonnet-4-5 — ${tr("en", "rSeatRanOutTurns")}`,
    );
  });
});

describe("J1's round: a row's severity is said in the reader's language (O34)", () => {
  const detail = (panel: HTMLElement, id: string): string =>
    text(rowOf(panel, id)?.querySelector(".lm-cite-row__detail"));

  it("puts the Chinese word beside the Chinese blocking mark — never `major` beside `阻碍`", () => {
    const panel = renderReviewTab(
      {
        ...PANEL,
        annotations: [annotation({ blocking: true }), PAGE_CONCERN],
      },
      deps("zh"),
    );
    expect(detail(panel, "reviewer_a-1")).toMatch(
      new RegExp(
        `^reviewer_a-1 · ${tr("zh", "rSeverityMajor")} · ${tr("zh", "rBlocking")} · `,
      ),
    );
    expect(detail(panel, "pdf_reviewer-1")).toMatch(
      new RegExp(`^pdf_reviewer-1 · ${tr("zh", "rSeverityMinor")} · `),
    );
    for (const id of ["reviewer_a-1", "pdf_reviewer-1"])
      expect(detail(panel, id)).not.toMatch(/major|minor/);
  });

  it("has a word for each of the three, in both locales, and English reads as before", () => {
    for (const [severity, key] of [
      ["info", "rSeverityInfo"],
      ["minor", "rSeverityMinor"],
      ["major", "rSeverityMajor"],
    ] as const) {
      expect(tr("en", key)).toBe(severity);
      expect(tr("zh", key)).not.toMatch(/[A-Za-z]/);
    }
    const panel = renderReviewTab(PANEL, deps());
    expect(detail(panel, "reviewer_a-1")).toMatch(/^reviewer_a-1 · major · /);
  });
});

describe("J1's round 3: a page cite the harness moved is said (ADR 0084, O39)", () => {
  const corrected = (n: number): ReviewLimit => ({
    kind: "pages_corrected",
    reviewer: "pdf_reviewer",
    entries: Array.from({ length: n }, (_, i) => ({
      id: `pdf_reviewer-${i + 1}`,
      cited: 6,
      page: 7,
    })),
  });

  it("says the count in the limits fold, one sentence per number, in both locales", () => {
    expect(limitSentence("en", corrected(3), "pdf_reviewer")).toBe(
      "PDF reviewer: 3 page citations named a page other than the one their figure or table sits on, and were moved to it",
    );
    expect(limitSentence("en", corrected(1), "pdf_reviewer")).toBe(
      "PDF reviewer: 1 page citation named a page other than the one its figure or table sits on, and was moved to it",
    );
    expect(limitSentence("zh", corrected(2), "pdf_reviewer")).toBe(
      "PDF 评审人：有 2 处页码引用与所指图表所在的页不符，已改为该图表所在的页",
    );
  });
});

describe("J1's round 2: what a panel set aside is said, never lost silently (ADR 0083 §2, O36)", () => {
  const setAside = (n: number): ReviewLimit => ({
    kind: "concerns_set_aside",
    reviewer: "pdf_reviewer",
    entries: Array.from({ length: n }, () => ({ dimension: "soundness" })),
  });

  it("says the count, one sentence per number, in both locales", () => {
    expect(limitSentence("en", setAside(3), "pdf_reviewer")).toBe(
      "PDF reviewer: 3 concerns about the argument cited no page and were set aside — the text reviewers review the argument",
    );
    expect(limitSentence("en", setAside(1), "pdf_reviewer")).toBe(
      "PDF reviewer: 1 concern about the argument cited no page and was set aside — the text reviewers review the argument",
    );
    expect(limitSentence("zh", setAside(2), "pdf_reviewer")).toBe(
      "PDF 评审人：有 2 条关于论证的意见未引用页码，已被搁置——论证由文字评审审阅",
    );
  });

  it("heads a PDF reviewer whose every concern was set aside with that, never with *none*", () => {
    const head = (locale: "en" | "zh", n: number) =>
      text(
        pdfGroup(
          renderReviewTab(
            {
              ...PANEL,
              annotations: PANEL.annotations.slice(0, 2),
              pdfSeat: { reviewer: "pdf_reviewer", count: 0, model: "m-1" },
              limits: [setAside(n)],
            },
            deps(locale),
          ),
        )?.querySelector(".lm-review-fold__summary"),
      );
    expect(head("en", 2)).toBe(
      "PDF reviewer · m-1 — its 2 concerns were about the argument and were set aside",
    );
    expect(head("en", 1)).toBe(
      "PDF reviewer · m-1 — its 1 concern was about the argument and was set aside",
    );
    expect(head("zh", 2)).toBe(
      `PDF 评审人 · m-1 — ${tr("zh", "rSeatAllSetAside").replace("{n}", "2")}`,
    );
  });

  it("leaves a seat that kept concerns headed by its count", () => {
    const heads = summaries(
      renderReviewTab({ ...PANEL, limits: [setAside(2)] }, deps()),
    );
    expect(heads[2]).toBe(
      `PDF reviewer · claude-haiku-4-5 · 1 ${tr("en", "rSeatConcerns")}`,
    );
  });
});

describe("J1's round 4: a moved cite says so on its own row, not in the fold (ADR 0085 §4, O43)", () => {
  const MOVED: ReviewLimit = {
    kind: "pages_corrected",
    reviewer: "pdf_reviewer",
    entries: [{ id: "pdf_reviewer-1", cited: 1, page: 2 }],
  };
  const evidenceOf = (panel: HTMLElement, id: string): string =>
    text(rowOf(panel, id)?.querySelector(".lm-cite-row__evidence"));

  it("prints the page the seat cited beside the page it now carries, in both locales", () => {
    const withMove = { ...PANEL, limits: [MOVED] };
    expect(
      evidenceOf(renderReviewTab(withMove, deps()), "pdf_reviewer-1"),
    ).toBe("evidence · page 2 of the compiled PDF (cited 1)");
    expect(
      evidenceOf(renderReviewTab(withMove, deps("zh")), "pdf_reviewer-1"),
    ).toBe("依据 · 已编译 PDF 第 2 页（原引第 1 页）");
  });

  it("leaves a cite the harness did not move as it was", () => {
    const elsewhere: ReviewLimit = {
      ...MOVED,
      entries: [{ id: "pdf_reviewer-9", cited: 1, page: 2 }],
    };
    expect(
      evidenceOf(
        renderReviewTab({ ...PANEL, limits: [elsewhere] }, deps()),
        "pdf_reviewer-1",
      ),
    ).toBe("evidence · page 2 of the compiled PDF");
  });

  it("draws no fold row for a move, and no fold when a move is the only limit", () => {
    const only = renderReviewTab({ ...PANEL, limits: [MOVED] }, deps());
    expect(only.querySelectorAll(".lm-review-limit")).toHaveLength(0);
    expect(text(only)).not.toContain(tr("en", "rLimits"));
    const beside = renderReviewTab(
      {
        ...PANEL,
        limits: [MOVED, { kind: "pages_unviewed", viewed: 2, total: 3 }],
      },
      deps(),
    );
    expect([...beside.querySelectorAll(".lm-review-limit")].map(text)).toEqual([
      "the PDF reviewer viewed 2 of 3 pages",
    ]);
    expect(summaries(beside)).toContain(`${tr("en", "rLimits")} · 1`);
  });
});

describe("J1's round 4: a page cite the review could not check is said (ADR 0085 §3, O42)", () => {
  const unchecked = (
    n: number,
    reason: "aux_older_than_pdf" | "aux_other_build",
  ): ReviewLimit => ({
    kind: "pages_unchecked",
    reviewer: "pdf_reviewer",
    reason,
    entries: Array.from({ length: n }, (_, i) => ({
      id: `pdf_reviewer-${i + 1}`,
    })),
  });

  it("says the count and why, one sentence per number, in both locales", () => {
    expect(
      limitSentence("en", unchecked(3, "aux_older_than_pdf"), "pdf_reviewer"),
    ).toBe(
      "PDF reviewer: 3 page citations of figures and tables were not checked against the pages they sit on — the .aux file beside the PDF is older than the PDF; compile the paper again for the check",
    );
    expect(
      limitSentence("en", unchecked(1, "aux_other_build"), "pdf_reviewer"),
    ).toBe(
      "PDF reviewer: 1 page citation of a figure or table was not checked against the page it sits on — the .aux file beside the PDF counts a different number of pages than the PDF; compile the paper again for the check",
    );
    expect(
      limitSentence("zh", unchecked(2, "aux_older_than_pdf"), "pdf_reviewer"),
    ).toBe(
      "PDF 评审人：有 2 处图表页码引用未与图表所在的页核对——PDF 旁的 .aux 文件早于该 PDF；重新编译论文即可核对",
    );
    expect(
      limitSentence("zh", unchecked(1, "aux_other_build"), "pdf_reviewer"),
    ).toBe(
      "PDF 评审人：有 1 处图表页码引用未与图表所在的页核对——PDF 旁的 .aux 文件记录的页数与该 PDF 不同；重新编译论文即可核对",
    );
  });

  it("draws it in the limits fold", () => {
    const panel = renderReviewTab(
      { ...PANEL, limits: [unchecked(1, "aux_older_than_pdf")] },
      deps(),
    );
    expect([...panel.querySelectorAll(".lm-review-limit")].map(text)).toEqual([
      limitSentence("en", unchecked(1, "aux_older_than_pdf"), "pdf_reviewer"),
    ]);
  });
});

describe("J1's round 4: review-mode furniture set aside is said (ADR 0085 §2, O41)", () => {
  const furniture = (n: number): ReviewLimit => ({
    kind: "furniture_set_aside",
    reviewer: "pdf_reviewer",
    entries: Array.from({ length: n }, () => ({ dimension: "presentation" })),
  });
  const argument = (n: number): ReviewLimit => ({
    kind: "concerns_set_aside",
    reviewer: "pdf_reviewer",
    entries: Array.from({ length: n }, () => ({ dimension: "soundness" })),
  });

  it("says the count, one sentence per number, in both locales", () => {
    expect(limitSentence("en", furniture(2), "pdf_reviewer")).toBe(
      "PDF reviewer: 2 concerns were about what the document class prints for review — an author block it hides, a placeholder DOI or ISBN — and were set aside",
    );
    expect(limitSentence("en", furniture(1), "pdf_reviewer")).toBe(
      "PDF reviewer: 1 concern was about what the document class prints for review — an author block it hides, a placeholder DOI or ISBN — and was set aside",
    );
    expect(limitSentence("zh", furniture(2), "pdf_reviewer")).toBe(
      "PDF 评审人：有 2 条意见针对的是文档类为评审而排印的内容（被隐去的作者信息、模板占位的 DOI 或 ISBN），已被搁置",
    );
  });

  it("heads a PDF reviewer whose every concern was furniture with that, and one with both kinds plainly", () => {
    const head = (locale: "en" | "zh", limits: ReviewLimit[]) =>
      text(
        pdfGroup(
          renderReviewTab(
            {
              ...PANEL,
              annotations: PANEL.annotations.slice(0, 2),
              pdfSeat: { reviewer: "pdf_reviewer", count: 0, model: "m-1" },
              limits,
            },
            deps(locale),
          ),
        )?.querySelector(".lm-review-fold__summary"),
      );
    expect(head("en", [furniture(2)])).toBe(
      "PDF reviewer · m-1 — its 2 concerns were about what the class prints for review and were set aside",
    );
    expect(head("en", [furniture(1)])).toBe(
      "PDF reviewer · m-1 — its 1 concern was about what the class prints for review and was set aside",
    );
    expect(head("en", [furniture(1), argument(2)])).toBe(
      "PDF reviewer · m-1 — its 3 concerns were set aside",
    );
    expect(head("zh", [furniture(2)])).toBe(
      `PDF 评审人 · m-1 — ${tr("zh", "rSeatAllFurniture").replace("{n}", "2")}`,
    );
    // Round 2's heading is untouched when only the argument was set aside.
    expect(head("en", [argument(2)])).toBe(
      "PDF reviewer · m-1 — its 2 concerns were about the argument and were set aside",
    );
  });
});

describe("J1's round 5: what a rule set aside is listed in a fold of its own (ADR 0086, O44)", () => {
  const ARGUMENT: ReviewLimit = {
    kind: "concerns_set_aside",
    reviewer: "pdf_reviewer",
    entries: [
      {
        dimension: "soundness",
        concern: {
          severity: "major",
          blocking: true,
          message: "the identification argument is never made",
          span: { file: "sections/method.tex", line: 9 },
        },
      },
    ],
  };
  const FURNITURE: ReviewLimit = {
    kind: "furniture_set_aside",
    reviewer: "pdf_reviewer",
    entries: [
      {
        dimension: "presentation",
        concern: {
          severity: "minor",
          message: "the DOI is a placeholder",
          span: { file: "main.tex", line: 2 },
          page: 1,
        },
      },
    ],
  };
  const asideFold = (panel: HTMLElement): HTMLDetailsElement | null =>
    panel.querySelector(".lm-review-aside")?.closest("details") ?? null;
  const rowsOf = (block: Element | undefined): string[][] =>
    [...(block?.querySelectorAll(".lm-cite-row") ?? [])].map((r) => [
      text(r.querySelector(".lm-cite-row__title")),
      text(r.querySelector(".lm-cite-row__detail")),
      text(r.querySelector(".lm-cite-row__evidence")),
    ]);

  it("lists each concern under its rule's sentence, closed, counted in concerns", () => {
    const fold = asideFold(
      renderReviewTab({ ...PANEL, limits: [FURNITURE, ARGUMENT] }, deps()),
    );
    expect(text(fold?.querySelector(".lm-review-fold__summary"))).toBe(
      "What this review set aside · 2",
    );
    expect(fold?.hasAttribute("open")).toBe(false);
    const blocks = [...(fold?.querySelectorAll(".lm-review-aside") ?? [])];
    expect(
      blocks.map((b) => text(b.querySelector(".lm-review-aside__rule"))),
    ).toEqual([
      limitSentence("en", FURNITURE, "pdf_reviewer"),
      limitSentence("en", ARGUMENT, "pdf_reviewer"),
    ]);
    // The page as CITED — a set-aside concern is never moved — and the file
    // by the claim's own rule, only when it is not the entry.
    expect(rowsOf(blocks[0])).toEqual([
      [
        `${dimensionLabel("en", "presentation")}: the DOI is a placeholder`,
        "minor · L2",
        "evidence · page 1 of the compiled PDF",
      ],
    ]);
    expect(rowsOf(blocks[1])).toEqual([
      [
        `${dimensionLabel("en", "soundness")}: the identification argument is never made`,
        "major · blocking · sections/method.tex:9",
        "",
      ],
    ]);
  });

  it("offers no action and no reveal on a set-aside concern, and draws it faint and uncarded", () => {
    const fold = asideFold(
      renderReviewTab({ ...PANEL, limits: [FURNITURE, ARGUMENT] }, deps()),
    );
    // A major set-aside is never drawn in a live finding's colour, nor as a
    // card a synthesis chip could land on.
    const rows = [...(fold?.querySelectorAll(".lm-cite-row") ?? [])];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        row
          .querySelector(".lm-cite-row__title")
          ?.classList.contains("is-faint"),
      ).toBe(true);
      expect(
        row.querySelector(".lm-cite-row__icon")?.classList.contains("is-faint"),
      ).toBe(true);
      expect(row.classList.contains("lm-review-card")).toBe(false);
    }
    expect(fold?.querySelectorAll("button")).toHaveLength(0);
    expect(fold?.querySelectorAll(".lm-cite-row--link")).toHaveLength(0);
    // Not a concern the synthesis can cite, nor one a jump can land on.
    expect(fold?.querySelectorAll("[data-concern]")).toHaveLength(0);
    calls.length = 0;
    fold?.querySelector<HTMLElement>(".lm-cite-row")?.click();
    expect(calls).toEqual([]);
  });

  it("leaves *What this review could not do*, and sits above it", () => {
    const only = renderReviewTab(
      { ...PANEL, limits: [ARGUMENT, FURNITURE] },
      deps(),
    );
    expect(only.querySelectorAll(".lm-review-limit")).toHaveLength(0);
    expect(summaries(only).some((s) => s.startsWith(tr("en", "rLimits")))).toBe(
      false,
    );
    const beside = renderReviewTab(
      {
        ...PANEL,
        limits: [ARGUMENT, { kind: "pages_unviewed", viewed: 2, total: 3 }],
      },
      deps(),
    );
    expect([...beside.querySelectorAll(".lm-review-limit")].map(text)).toEqual([
      "the PDF reviewer viewed 2 of 3 pages",
    ]);
    expect(summaries(beside)).toContain(`${tr("en", "rLimits")} · 1`);
    expect(
      precedes(asideFold(beside), beside.querySelector(".lm-review-limit")),
    ).toBe(true);
  });

  it("draws a record stored before ADR 0086 as its sentence alone", () => {
    const old: ReviewLimit = {
      kind: "concerns_set_aside",
      reviewer: "pdf_reviewer",
      entries: [{ dimension: "soundness" }, { dimension: "claims" }],
    };
    const fold = asideFold(
      renderReviewTab({ ...PANEL, limits: [old] }, deps()),
    );
    expect(text(fold?.querySelector(".lm-review-fold__summary"))).toBe(
      "What this review set aside · 2",
    );
    expect(text(fold?.querySelector(".lm-review-aside__rule"))).toBe(
      limitSentence("en", old, "pdf_reviewer"),
    );
    expect(fold?.querySelectorAll(".lm-cite-row")).toHaveLength(0);
  });

  it("draws in a PDF-only run too, and in 中文", () => {
    const fold = asideFold(
      renderReviewTab({ ...PDF_ONLY, limits: [FURNITURE] }, deps("zh")),
    );
    expect(text(fold?.querySelector(".lm-review-fold__summary"))).toBe(
      "本次审稿搁置的意见 · 1",
    );
    expect(text(fold?.querySelector(".lm-review-aside__rule"))).toBe(
      "PDF 评审人：有 1 条意见针对的是文档类为评审而排印的内容（被隐去的作者信息、模板占位的 DOI 或 ISBN），已被搁置",
    );
    expect(
      rowsOf(fold?.querySelector(".lm-review-aside") ?? undefined),
    ).toEqual([
      [
        `${dimensionLabel("zh", "presentation")}: the DOI is a placeholder`,
        "次要 · L2",
        "依据 · 已编译 PDF 第 1 页",
      ],
    ]);
  });

  it("is not drawn in quick mode, which sets nothing aside", () => {
    expect(
      asideFold(
        renderReviewTab(
          { ...PANEL, mode: "quick", limits: [ARGUMENT] },
          deps(),
        ),
      ),
    ).toBeNull();
  });
});
