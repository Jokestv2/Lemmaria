/**
 * O24 (re-aimed at ADR 0065 §3): a blind panel in flight, drawn at the top of
 * the Review tab.
 *
 * These are the transcript card's tests, following the chips to where they now
 * render. What each status has to say on its own — and in the reader's
 * language — is unchanged; what is gone is the card's own furniture, which the
 * three deleted cases asserted (its title, its concern/limit counts, and its
 * *Open the Review tab* button, which a reader already on the tab does not
 * need). Two cases are new, for the two things a card never had to answer: the
 * gap before the driver's first frame, and a refusal's reason.
 */
import type { ReviewItem } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  type ReviewRunView,
  reviewProgress,
} from "../src/webview/parts/review-progress.js";

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "r1",
  type: "review",
  status: "running",
  skill: "blind-reviewer",
  seats: [
    { reviewer: "reviewer_a", status: "running", model: "claude-sonnet-4-5" },
    { reviewer: "reviewer_b", status: "running", model: "claude-sonnet-4-5" },
    { reviewer: "reviewer_c", status: "running", model: "claude-sonnet-4-5" },
  ],
  ...over,
});

/** A run in flight around `item`, which is the ordinary case. */
const running = (over: Partial<ReviewItem> = {}): ReviewRunView => ({
  running: true,
  item: item(over),
  notices: [],
});

/** A run that has ENDED around `item` — what the host keeps on screen when a
 *  panel produced no result to present. */
const ended = (
  over: Partial<ReviewItem> = {},
  notices: string[] = [],
): ReviewRunView => ({ running: false, item: item(over), notices });

/** A chip's state mark and its label. Read as two elements rather than as
 *  `textContent`, because ADR 0062 §4 split them: the mark is a spinner while
 *  the seat works and a glyph once it lands, and only the mark ever moves. */
const chips = (node: HTMLElement): string[] =>
  [...node.querySelectorAll(".lm-review-chip")].map(
    (c) =>
      `${c.querySelector(".lm-review-chip__glyph, .lm-review-chip__spin")?.textContent ?? ""} ${
        c.querySelector(".lm-review-chip__label")?.textContent ?? ""
      }`,
  );

describe("the running panel (O24)", () => {
  it("shows one chip per seat while the panel reads", () => {
    const block = reviewProgress(running(), "en", () => {});
    // R9 (ADR 0069 §D8): the chip names what RUNS — ADR 0064 §4's principle,
    // which under one model was already satisfied by the Models tab and under
    // a mixed panel is not. The id, not a friendly label: the webview has no
    // model list to resolve one against, and the Review tab's own header says
    // the same thing the same way.
    expect(chips(block)).toEqual([
      "◜ reviewer_a · claude-sonnet-4-5",
      "◜ reviewer_b · claude-sonnet-4-5",
      "◜ reviewer_c · claude-sonnet-4-5",
    ]);
    expect(block.textContent).toContain("reading the manuscript…");
  });

  it("says *starting* before the driver's first frame", () => {
    // ADR 0065 §3. New with the move: the driver reads the whole manuscript
    // before it briefs a seat, which is real seconds on a large project, and
    // the card never had to cover that gap — the transcript showed a
    // `user_message` bubble in the meantime and this surface shows nothing.
    const block = reviewProgress(
      { running: true, notices: [] },
      "en",
      () => {},
    );
    expect(block.textContent).toContain("starting…");
    expect(chips(block)).toEqual([]);
    // Still stoppable: the run is real from the click, not from the frame.
    expect(block.querySelector(".lm-review-stop")).not.toBeNull();
  });

  it("marks each seat's own outcome, and a seat that was handed back once", () => {
    const block = reviewProgress(
      ended({
        status: "interrupted",
        seats: [
          {
            reviewer: "reviewer_a",
            status: "completed",
            model: "claude-sonnet-4-5",
            retried: true,
          },
          {
            reviewer: "reviewer_b",
            status: "failed",
            model: "claude-sonnet-4-5",
          },
          {
            reviewer: "reviewer_c",
            status: "interrupted",
            model: "claude-sonnet-4-5",
          },
        ],
        synthesis: "completed",
      }),
      "en",
      () => {},
    );
    expect(chips(block)).toEqual([
      "✓ reviewer_a · claude-sonnet-4-5 · retried",
      "✗ reviewer_b · claude-sonnet-4-5",
      "⊘ reviewer_c · claude-sonnet-4-5",
      "✓ synthesis",
    ]);
  });

  it("says a stopped panel was stopped", () => {
    const block = reviewProgress(
      ended({
        status: "interrupted",
        seats: [
          {
            reviewer: "reviewer_a",
            status: "interrupted",
            model: "claude-sonnet-4-5",
          },
        ],
      }),
      "en",
      () => {},
    );
    expect(block.textContent).toContain("The panel was stopped.");
    // Nothing to stop any more.
    expect(block.querySelector(".lm-review-stop")).toBeNull();
  });

  it("a refused panel says nothing ran, and shows the reason beside it", () => {
    // ADR 0065 §3. The card said only that nothing ran, because the WHY was a
    // notice item rendered beside it in the transcript. Detached, there is no
    // transcript to put it in — so the reason rides here, already localized by
    // `main.ts` through the same `noticeText` every other notice goes through.
    const block = reviewProgress(
      ended({ status: "failed", seats: [] }, [
        "No manuscript: open a LaTeX or Markdown project first.",
      ]),
      "en",
      () => {},
    );
    expect(block.textContent).toContain("The panel did not run.");
    expect(block.querySelector(".lm-review-notice")?.textContent).toBe(
      "No manuscript: open a LaTeX or Markdown project first.",
    );
    expect(chips(block)).toEqual([]);
  });

  it("carries the user's focus verbatim, never re-phrased", () => {
    const focus = "the statistics in Table 2 / 表 2";
    const block = reviewProgress(running({ focus }), "en", () => {});
    expect(block.querySelector(".lm-review-focus")?.textContent).toBe(focus);
  });

  it("stops the panel on request, and only while it is running", () => {
    const stopped: string[] = [];
    const block = reviewProgress(running(), "en", () => stopped.push("stop"));
    const button = block.querySelector(".lm-review-stop") as HTMLButtonElement;
    expect(button.textContent).toBe("Stop");
    button.click();
    expect(stopped).toEqual(["stop"]);
  });

  it("renders in the reader's language, one language at a time", () => {
    const zh = reviewProgress(running(), "zh", () => {}).textContent ?? "";
    expect(zh).toContain("正在通读全文");
    expect(zh).toContain("停止");
    expect(zh).not.toContain("reading the manuscript");
    expect(zh).not.toContain("Stop");
  });
});

describe("the running panel after the gate-review round (ADR 0062)", () => {
  it("keeps the chip still and spins only the mark inside it", () => {
    // §4. `lm-spin` used to sit on the chip, so the whole pill rotated —
    // text, border and all — and two of the three seat names were upside down
    // at any moment. The chip is static for its whole life now.
    const block = reviewProgress(running(), "en", () => {});
    const live = [...block.querySelectorAll(".lm-review-chip")];
    expect(live).toHaveLength(3);
    for (const chip of live) {
      expect(chip.classList.contains("lm-spin")).toBe(false);
      expect(
        chip.querySelectorAll(".lm-review-chip__spin.lm-spin"),
      ).toHaveLength(1);
    }
    // A settled chip has no spinner at all, and still nothing turning on it.
    const done = reviewProgress(
      ended({
        status: "interrupted",
        seats: [
          {
            reviewer: "reviewer_a",
            status: "completed",
            model: "claude-sonnet-4-5",
          },
        ],
        synthesis: "completed",
      }),
      "en",
      () => {},
    );
    expect(done.querySelectorAll(".lm-spin")).toHaveLength(0);
  });

  it("spins the synthesis chip the same way, and marks a missing one failed", () => {
    const live = reviewProgress(
      running({ synthesis: "running" }),
      "en",
      () => {},
    );
    expect(chips(live).at(-1)).toBe("◜ synthesis");
    const missing = reviewProgress(
      ended({
        status: "interrupted",
        seats: [
          {
            reviewer: "reviewer_a",
            status: "completed",
            model: "claude-sonnet-4-5",
          },
        ],
        synthesis: "missing",
      }),
      "en",
      () => {},
    );
    expect(chips(missing).at(-1)).toBe("✗ synthesis");
    expect(missing.querySelectorAll(".lm-spin")).toHaveLength(0);
  });

  it("says which review this is, and when — in both locales", () => {
    // §1. Three panels from one afternoon used to be indistinguishable. Under
    // ADR 0065 the stamp matters MORE, not less: while the panel runs this is
    // the only place its number appears at all.
    const at =
      Date.UTC(2026, 8, 4, 12) + new Date().getTimezoneOffset() * 60000;
    const en = reviewProgress(running({ version: 3, at }), "en", () => {});
    expect(en.querySelector(".lm-review-stamp")?.textContent).toBe(
      "v3 · 2026-09-04",
    );
    const zh = reviewProgress(running({ version: 3, at }), "zh", () => {});
    expect(zh.querySelector(".lm-review-stamp")?.textContent).toBe(
      "第3版 · 2026-09-04",
    );
  });

  it("carries no stamp for a panel that has neither", () => {
    // A refused panel is unversioned by design (the version is a thing you can
    // go back to, and a review that never ran is not one), and an item from
    // before versions existed carries neither field.
    const block = reviewProgress(running(), "en", () => {});
    expect(block.querySelector(".lm-review-stamp")).toBeNull();
    // The date alone still shows: it is when the user asked.
    const dated = reviewProgress(running({ at: 0 }), "en", () => {});
    expect(dated.querySelector(".lm-review-stamp")?.textContent).not.toContain(
      "v",
    );
  });
});

describe("the verification chip (V1 O23, ADR 0076 §9)", () => {
  it("sits between the seats and the cross-review, in each state it can run in", () => {
    const at = (verification: ReviewItem["verification"]) =>
      chips(
        reviewProgress(
          running({ verification, synthesis: "pending" }),
          "en",
          () => {},
        ),
      );
    const labels = (verification: ReviewItem["verification"]) =>
      at(verification).map((c) => c.slice(c.indexOf(" ") + 1));
    expect(labels("running").slice(-2)).toEqual(["verification", "synthesis"]);
    expect(at("pending").at(-2)).toBe("· verification");
    expect(at("completed").at(-2)).toBe("✓ verification");
    // `missing` is drawn as the cross-review draws its own: failed.
    expect(at("missing").at(-2)).toBe("✗ verification");
  });

  it("draws no chip when verification is off or had nothing to check", () => {
    for (const verification of ["off", "skipped", undefined] as const) {
      const labels = chips(
        reviewProgress(
          running({
            ...(verification !== undefined ? { verification } : {}),
            synthesis: "pending",
          }),
          "en",
          () => {},
        ),
      );
      expect(
        labels.some((l) => l.endsWith("verification")),
        String(verification),
      ).toBe(false);
    }
  });

  it("names it in the reader's language", () => {
    const zh = chips(
      reviewProgress(running({ verification: "running" }), "zh", () => {}),
    );
    expect(zh.some((l) => l.endsWith("核查"))).toBe(true);
    expect(zh.some((l) => l.endsWith("verification"))).toBe(false);
  });
});

describe("the PDF reviewer's chip (V4 O19, ADR 0081 §3)", () => {
  const pdfSeat = {
    reviewer: "pdf_reviewer",
    status: "running" as const,
    model: "claude-haiku-4-5",
  };

  it("follows the reviewers' chips, named PDF reviewer with its model", () => {
    const block = reviewProgress(running({ pdfSeat }), "en", () => {});
    expect(chips(block)).toEqual([
      "◜ reviewer_a · claude-sonnet-4-5",
      "◜ reviewer_b · claude-sonnet-4-5",
      "◜ reviewer_c · claude-sonnet-4-5",
      "◜ PDF reviewer · claude-haiku-4-5",
    ]);
  });

  it("is the whole of a PDF review's progress — no reviewers, no cross-review", () => {
    const block = reviewProgress(
      running({
        seats: [],
        pdfSeat: { ...pdfSeat, status: "completed" },
        pdfOnly: true,
        verification: "skipped",
      }),
      "en",
      () => {},
    );
    expect(chips(block)).toEqual(["✓ PDF reviewer · claude-haiku-4-5"]);
  });

  it("settles like a reviewer's", () => {
    const block = reviewProgress(
      ended({ pdfSeat: { ...pdfSeat, status: "failed" } }),
      "en",
      () => {},
    );
    expect(chips(block).at(-1)).toBe("✗ PDF reviewer · claude-haiku-4-5");
  });

  it("is named in Chinese for a Chinese reader", () => {
    const block = reviewProgress(running({ pdfSeat }), "zh", () => {});
    expect(chips(block).at(-1)).toBe("◜ PDF 评审人 · claude-haiku-4-5");
  });

  it("is absent when no PDF reviewer runs", () => {
    const block = reviewProgress(running(), "en", () => {});
    expect(chips(block).some((c) => c.includes("PDF"))).toBe(false);
  });
});
