import { describe, expect, it } from "vitest";
import type { ReviewAnnotationInfo } from "../src/webview-protocol.js";
import {
  chatDraft,
  locationOf,
  resolvePrompt,
} from "../src/webview/parts/review-prompts.js";
import { tr } from "../src/webview/parts/strings.js";

/**
 * What a concern becomes on its way to the assistant (ADR 0062 §6, ADR 0063
 * §3). The Resolve prompt is MODEL-facing text, so the reader of every line
 * here is a model with write access to the paper, not a person with the tab
 * beside them.
 */

/** The instruction's own text is not what these tests are about; it is read
 *  from the table so a rewording there does not fail a test here. */
const STR_INSTRUCTION_EN = tr("en", "rFixInstruction");

const CONCERN: ReviewAnnotationInfo = {
  index: 0,
  id: "reviewer_a-2",
  dimension: "soundness",
  severity: "major",
  message: "the bound in Eq. 3 needs the support assumption",
  reviewer: "reviewer_a",
  file: "main.tex",
  line: 3,
  hasSuggestion: false,
  status: "pending",
  evidence: { kind: "span", file: "sections/method.tex", line: 37 },
};

describe("the location a prompt gives (X6 review round)", () => {
  it("names the file whenever it is known — the entry included", () => {
    // Not the tab's rule. The tab prints `L<n>` for the entry because the
    // launcher above it names the entry; a prompt has no such header.
    expect(locationOf("sections/method.tex", 37)).toBe(
      "sections/method.tex:37",
    );
    expect(locationOf("main.tex", 3)).toBe("main.tex:3");
  });

  it("falls back to a bare line only when the file is unnamed", () => {
    expect(locationOf("", 5)).toBe("L5");
  });
});

describe("the Resolve prompt (ADR 0063 §3)", () => {
  it("gives the supporting passage WITH its file", () => {
    // The defect: `Supporting passage: L37`, beside a concern placed at
    // `main.tex:3` — so the model opened line 37 of the wrong file.
    const prompt = resolvePrompt("en", CONCERN);
    expect(prompt).toContain("Supporting passage: sections/method.tex:37");
    expect(prompt).not.toMatch(/Supporting passage: L\d/);
  });

  it("names the file for evidence in the concern's own file too", () => {
    const prompt = resolvePrompt("en", {
      ...CONCERN,
      evidence: { kind: "span", file: "main.tex", line: 5 },
    });
    expect(prompt).toContain("Supporting passage: main.tex:5");
  });

  it("is otherwise the prompt it always was, line for line", () => {
    // Pins the whole composition, so moving it out of `main.ts` moved
    // nothing but the evidence's location.
    expect(
      resolvePrompt("en", { ...CONCERN, suggestion: "state it first" }),
    ).toBe(
      [
        "Resolve this reviewer concern in the manuscript.",
        "",
        "The concern reviewer_a-2 (soundness · major) — at main.tex:3:",
        "> the bound in Eq. 3 needs the support assumption",
        "",
        "Supporting passage: sections/method.tex:37",
        "",
        "The reviewer's suggested wording: state it first",
        "",
        STR_INSTRUCTION_EN,
      ].join("\n"),
    );
  });

  it("carries no evidence line when there is no located passage", () => {
    for (const evidence of [{ kind: "missing" }, undefined] as const) {
      const { evidence: _drop, ...rest } = CONCERN;
      const prompt = resolvePrompt(
        "en",
        evidence === undefined ? rest : { ...rest, evidence },
      );
      expect(prompt).not.toContain("Supporting passage");
    }
  });

  it("is written in the reader's language, with the location as it is", () => {
    const prompt = resolvePrompt("zh", CONCERN);
    expect(prompt).toContain("佐证段落: sections/method.tex:37");
    expect(prompt).not.toContain("Supporting passage");
  });
});

describe("a paper reaches both drafts (V2 O23, ADR 0078 §D12)", () => {
  const withPaper = (
    over: Partial<{ title: string; year: string; href: string }> = {},
  ): ReviewAnnotationInfo => ({
    ...CONCERN,
    dimension: "originality",
    evidence: {
      kind: "paper",
      title: "Adam: A Method for Stochastic Optimization",
      year: "2015",
      href: "https://arxiv.org/abs/1412.6980",
      ...over,
    },
  });

  it("carries the title, the year and the link into the Resolve prompt", () => {
    // A draft that dropped the evidence would ask the assistant to act on a
    // concern with its support removed -- and for an `originality` concern the
    // paper IS the support (ADR 0078 §3).
    expect(resolvePrompt("en", withPaper())).toContain(
      'prior work: "Adam: A Method for Stochastic Optimization" (2015) https://arxiv.org/abs/1412.6980',
    );
    expect(resolvePrompt("zh", withPaper())).toContain(
      '已有工作: "Adam: A Method for Stochastic Optimization" (2015) https://arxiv.org/abs/1412.6980',
    );
  });

  it("carries it into the chat draft too", () => {
    expect(chatDraft("en", withPaper())).toContain(
      'prior work: "Adam: A Method for Stochastic Optimization" (2015)',
    );
  });

  it("omits the parts the record does not have", () => {
    const bare: ReviewAnnotationInfo = {
      ...CONCERN,
      evidence: { kind: "paper", title: "Undated Work" },
    };
    expect(resolvePrompt("en", bare)).toContain('prior work: "Undated Work"');
    // No empty parentheses and no trailing space where a link would go.
    expect(resolvePrompt("en", bare)).not.toContain("()");
    // The line is exactly the title, with nothing dangling where a year or a
    // link would have been.
    const line = resolvePrompt("en", bare)
      .split(String.fromCharCode(10))
      .find((l) => l.startsWith("prior work:"));
    expect(line).toBe('prior work: "Undated Work"');
  });

  it("still gives a SPAN evidence as a location, not as prior work", () => {
    // The two kinds must not blur: a span is a place in the manuscript.
    expect(resolvePrompt("en", CONCERN)).toContain("sections/method.tex:37");
    expect(resolvePrompt("en", CONCERN)).not.toContain("prior work");
  });
});

describe("the chat draft (ADR 0062 §6)", () => {
  it("places the concern the way the Resolve prompt does", () => {
    expect(chatDraft("en", CONCERN)).toBe(
      [
        "About this review concern (reviewer_a-2 · soundness · major · main.tex:3):",
        "",
        "> the bound in Eq. 3 needs the support assumption",
        "",
        "What should I do about it?",
      ].join("\n"),
    );
  });

  /**
   * V1's J1 round (2026-09-19), Judge question 3. The reader disagreed with
   * both withdrawals on their own paper, opened Chat — and the draft said
   * nothing about the withdrawal or the passage that answered it, so the
   * disagreement had to be explained to the assistant by hand. This is
   * `known-limits.md`'s *Chat on a withdrawn concern does not tell the
   * assistant it was withdrawn*, whose revisit trigger was J1.
   */
  const WITHDRAWN: ReviewAnnotationInfo = {
    ...CONCERN,
    verification: {
      outcome: "refuted",
      kind: "contradiction",
      counter: { file: "sections/method.tex", line: 86 },
      note: "Section 5 states the ablation's one-epoch setting.",
    },
  };

  it("a withdrawn concern's draft carries the withdrawal, the passage and the note", () => {
    expect(chatDraft("en", WITHDRAWN)).toBe(
      [
        "About this review concern (reviewer_a-2 · soundness · major · main.tex:3):",
        "",
        "> the bound in Eq. 3 needs the support assumption",
        "",
        "The panel's verification withdrew it, on this passage: sections/method.tex:86",
        "",
        "> Section 5 states the ablation's one-epoch setting.",
        "",
        "What should I do about it?",
      ].join("\n"),
    );
  });

  it("carries the withdrawal without a note when the verifier wrote none", () => {
    const { note: _note, ...rest } = WITHDRAWN.verification ?? {};
    const draft = chatDraft("en", {
      ...WITHDRAWN,
      verification: rest as never,
    });
    expect(draft).toContain("sections/method.tex:86");
    expect(draft).not.toContain("Section 5 states");
  });

  it("says nothing about verification on a concern that was not withdrawn", () => {
    for (const a of [
      CONCERN,
      { ...CONCERN, verification: { outcome: "upheld", kind: "absence" } },
    ] as ReviewAnnotationInfo[]) {
      expect(chatDraft("en", a)).not.toContain("verification");
    }
  });

  it("carries the withdrawal in the reader's language, and only that one", () => {
    const draft = chatDraft("zh", WITHDRAWN);
    expect(draft).toContain("sections/method.tex:86");
    expect(draft).not.toContain("The panel's verification");
  });
});

describe("a page reaches both drafts (V4 O20, ADR 0081 §4)", () => {
  const PAGE: ReviewAnnotationInfo = {
    ...CONCERN,
    id: "pdf_reviewer-1",
    reviewer: "pdf_reviewer",
    dimension: "presentation",
    message: "the results table runs past its column",
    line: 12,
    evidence: { kind: "page", page: 3 },
  };

  it("says in the Resolve prompt where it is visible, in both locales", () => {
    expect(resolvePrompt("en", PAGE)).toContain(
      "Visible on page 3 of the compiled PDF",
    );
    expect(resolvePrompt("zh", PAGE)).toContain("见于已编译 PDF 第 3 页");
    // A page is not a supporting passage, and is never given as one.
    expect(resolvePrompt("en", PAGE)).not.toContain(tr("en", "rFixEvidence"));
    // The concern's own anchor is still where the fix is.
    expect(resolvePrompt("en", PAGE)).toContain("main.tex:12");
  });

  it("says it in the chat draft too, in both locales", () => {
    expect(chatDraft("en", PAGE)).toContain(
      "Visible on page 3 of the compiled PDF",
    );
    expect(chatDraft("zh", PAGE)).toContain("见于已编译 PDF 第 3 页");
  });

  it("is one language per reader", () => {
    expect(tr("zh", "rFixEvidencePage").replace(/\{n\}|PDF/g, "")).not.toMatch(
      /[A-Za-z]/,
    );
    expect(tr("en", "rFixEvidencePage")).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
