/**
 * O13: the Reviewers and Cross-review cards (R9, ADR 0069 §D8).
 *
 * The Models tab's roles section has been inline in `main.ts` since U3, where
 * nothing about it could be asserted. R9 lights its two dimmed shells, and a
 * control that decides how many models a review spends on is not one to ship
 * on a human's word — so the card is a pure `parts/` module and this reads the
 * DOM it produces, in both locales.
 */
import { describe, expect, it } from "vitest";
import {
  type ReviewRolesView,
  crossReviewCardBody,
  pdfReviewCardBody,
  reviewersCardBody,
} from "../src/webview/parts/review-roles-card.js";
import { tr } from "../src/webview/parts/strings.js";

const MODELS = [
  {
    id: "id-sonnet",
    label: "Sonnet",
    providerLabel: "Anthropic",
    keyPresent: true,
  },
  {
    id: "id-luna",
    label: "gpt-5.6-luna",
    providerLabel: "OpenAI",
    keyPresent: true,
  },
  {
    id: "id-nokey",
    label: "Haiku",
    providerLabel: "Anthropic",
    keyPresent: false,
  },
];

// V1 (ADR 0076 §8): the roles value gained `verifier`, so every roles literal
// in this file carries its default, `""`. No expectation changed with it.
const view = (over: Partial<ReviewRolesView> = {}): ReviewRolesView => ({
  models: MODELS,
  roles: { reviewers: ["", "", ""], synthesis: "", verifier: "" },
  maxReviewers: 8,
  ...over,
});

const posted: Array<{ reviewers: string[]; synthesis: string }> = [];
const post = (roles: { reviewers: string[]; synthesis: string }): void => {
  posted.push(roles);
};

const selects = (node: HTMLElement): HTMLSelectElement[] => [
  ...node.querySelectorAll("select"),
];

const optionsOf = (s: HTMLSelectElement): string[] =>
  [...s.options].map((o) => o.textContent ?? "");

describe("the Reviewers card (O13)", () => {
  it("draws one select per reviewer, Same as Writing first", () => {
    const body = reviewersCardBody(view(), "en", post);
    const rows = selects(body);
    expect(rows).toHaveLength(3);
    expect(optionsOf(rows[0] as HTMLSelectElement)).toEqual([
      tr("en", "mSameAsWriting"),
      "Sonnet · Anthropic",
      "gpt-5.6-luna · OpenAI",
      `Haiku · Anthropic · ${tr("en", "mNoKey")}`,
    ]);
    // A model with no key is OFFERED, with the suffix the Connected list
    // already uses: the reader sees the refusal coming rather than picking a
    // reviewer that will decline to run.
    expect(rows[0]?.value).toBe("");
  });

  it("selects the model each reviewer is bound to", () => {
    const body = reviewersCardBody(
      view({
        roles: { reviewers: ["", "id-luna"], synthesis: "", verifier: "" },
      }),
      "en",
      post,
    );
    const rows = selects(body);
    expect(rows.map((r) => r.value)).toEqual(["", "id-luna"]);
  });

  it("posts the WHOLE value on any change", () => {
    posted.length = 0;
    const body = reviewersCardBody(
      view({
        roles: { reviewers: ["", ""], synthesis: "id-luna", verifier: "" },
      }),
      "en",
      post,
    );
    const second = selects(body)[1] as HTMLSelectElement;
    second.value = "id-sonnet";
    second.dispatchEvent(new Event("change"));
    // The count IS the list, so a partial message would leave the host
    // reconstructing it from a sequence of edits.
    expect(posted).toEqual([
      { reviewers: ["", "id-sonnet"], synthesis: "id-luna", verifier: "" },
    ]);
  });

  it("adds a reviewer, and stops at the harness's own ceiling", () => {
    posted.length = 0;
    const add = (v: ReviewRolesView): HTMLButtonElement =>
      reviewersCardBody(v, "en", post).querySelector(
        ".lm-mrole__add",
      ) as HTMLButtonElement;

    const button = add(view());
    expect(button.disabled).toBe(false);
    button.click();
    // A new reviewer follows Writing until the reader says otherwise.
    expect(posted).toEqual([
      { reviewers: ["", "", "", ""], synthesis: "", verifier: "" },
    ]);

    const full = add(
      view({
        roles: {
          reviewers: new Array(8).fill(""),
          synthesis: "",
          verifier: "",
        },
      }),
    );
    // Invariant 5: the host can only ask for LESS. Eight is where the fan-out
    // stops, so this is where the button does.
    expect(full.disabled).toBe(true);
  });

  it("removes a reviewer, but never the last one", () => {
    posted.length = 0;
    const body = reviewersCardBody(
      view({
        roles: { reviewers: ["", "id-luna", ""], synthesis: "", verifier: "" },
      }),
      "en",
      post,
    );
    const removes = [
      ...body.querySelectorAll(".lm-mrole__remove"),
    ] as HTMLButtonElement[];
    expect(removes).toHaveLength(3);
    removes[1]?.click();
    expect(posted).toEqual([
      { reviewers: ["", ""], synthesis: "", verifier: "" },
    ]);

    const lone = reviewersCardBody(
      view({ roles: { reviewers: [""], synthesis: "", verifier: "" } }),
      "en",
      post,
    );
    expect(
      (lone.querySelector(".lm-mrole__remove") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says a cross-review needs two, and only when there is one reviewer", () => {
    // D6: N = 1 is allowed and yields `synthesis_missing / insufficient_seats`
    // — an honest record of a single standalone review. The hint is what stops
    // that being a surprise.
    const lone = reviewersCardBody(
      view({ roles: { reviewers: [""], synthesis: "", verifier: "" } }),
      "en",
      post,
    );
    expect(lone.textContent).toContain(tr("en", "mCrossReviewNeedsTwo"));
    expect(reviewersCardBody(view(), "en", post).textContent).not.toContain(
      tr("en", "mCrossReviewNeedsTwo"),
    );
  });

  it("labels each reviewer row by its number", () => {
    const body = reviewersCardBody(
      view({ roles: { reviewers: ["", "", ""], synthesis: "", verifier: "" } }),
      "en",
      post,
    );
    expect(selects(body).map((s) => s.getAttribute("aria-label"))).toEqual([
      `${tr("en", "mReviewers")} 1`,
      `${tr("en", "mReviewers")} 2`,
      `${tr("en", "mReviewers")} 3`,
    ]);
  });

  it("renders in the reader's language, and only that one", () => {
    const zh = reviewersCardBody(
      view({ roles: { reviewers: [""], synthesis: "", verifier: "" } }),
      "zh",
      post,
    );
    expect(optionsOf(selects(zh)[0] as HTMLSelectElement)[0]).toBe(
      tr("zh", "mSameAsWriting"),
    );
    expect(zh.textContent).toContain(tr("zh", "mCrossReviewNeedsTwo"));
    expect(zh.textContent).not.toContain(tr("en", "mSameAsWriting"));
  });

  it("reads a role pointing at a deleted model as Same as Writing", () => {
    // The store prunes a dangling id on read, but the card is drawn from
    // whatever it is handed — and a `<select>` given a value no `<option>`
    // carries silently keeps the FIRST option selected, which happens to be
    // the right answer for the wrong reason. Pin the answer, so a later
    // rewrite that adds a placeholder option cannot make a deleted model read
    // as "some other model" while every test still passes.
    const stale = reviewersCardBody(
      view({
        roles: {
          reviewers: ["id-gone", "id-luna"],
          synthesis: "",
          verifier: "",
        },
      }),
      "en",
      post,
    );
    const [first, second] = selects(stale) as [
      HTMLSelectElement,
      HTMLSelectElement,
    ];
    expect(first.value).toBe("");
    expect(first.selectedOptions[0]?.textContent).toBe(
      tr("en", "mSameAsWriting"),
    );
    expect(second.value).toBe("id-luna");
  });

  it("offers Same as Writing alone when nothing is configured", () => {
    const empty = reviewersCardBody(view({ models: [] }), "en", post);
    expect(optionsOf(selects(empty)[0] as HTMLSelectElement)).toEqual([
      tr("en", "mSameAsWriting"),
    ]);
  });
});

describe("the Cross-review card (O13)", () => {
  it("its first select keeps the same shape, and posts the whole value", () => {
    posted.length = 0;
    const body = crossReviewCardBody(
      view({
        roles: { reviewers: ["", "id-luna"], synthesis: "", verifier: "" },
      }),
      "en",
      post,
    );
    const one = selects(body);
    // V1 (ADR 0076 §8): 2 — the verifier's select sits under this one.
    expect(one).toHaveLength(2);
    expect(optionsOf(one[0] as HTMLSelectElement)[0]).toBe(
      tr("en", "mSameAsWriting"),
    );
    const s = one[0] as HTMLSelectElement;
    s.value = "id-luna";
    s.dispatchEvent(new Event("change"));
    expect(posted).toEqual([
      { reviewers: ["", "id-luna"], synthesis: "id-luna", verifier: "" },
    ]);
  });

  it("shows the model the cross-review is bound to", () => {
    const body = crossReviewCardBody(
      view({
        roles: { reviewers: ["", ""], synthesis: "id-sonnet", verifier: "" },
      }),
      "en",
      post,
    );
    expect((selects(body)[0] as HTMLSelectElement).value).toBe("id-sonnet");
  });

  /**
   * V1's J1 round (2026-09-19), item 5: the card enclosed two selects and
   * named only the second, so the reader inferred what the first controlled
   * from the card title. Both are roles; both are named — the Reviewers
   * card's own precedent, where every row carries its label.
   */
  it("names its first select, as the verifier's below it is named", () => {
    const body = crossReviewCardBody(
      view({ roles: { reviewers: ["", ""], synthesis: "", verifier: "" } }),
      "en",
      post,
    );
    expect(
      [...body.querySelectorAll(".lm-mcard__sublabel")].map((n) =>
        n.textContent?.trim(),
      ),
    ).toEqual([tr("en", "mCrossReview"), tr("en", "mVerifier")]);
  });
});

describe("the verifier's select, under the Cross-review (V1 O18, ADR 0076 §8)", () => {
  const verifierOf = (
    verifier: string,
    locale: "en" | "zh" = "en",
  ): { body: HTMLElement; select: HTMLSelectElement } => {
    const body = crossReviewCardBody(
      view({ roles: { reviewers: ["", ""], synthesis: "id-luna", verifier } }),
      locale,
      post,
    );
    return { body, select: selects(body)[1] as HTMLSelectElement };
  };

  it("offers Same as Cross-review, then Off, then every model, captioned as the others are", () => {
    const { select } = verifierOf("");
    expect(optionsOf(select)).toEqual([
      tr("en", "mSameAsCrossReview"),
      tr("en", "mVerifierOff"),
      "Sonnet · Anthropic",
      "gpt-5.6-luna · OpenAI",
      `Haiku · Anthropic · ${tr("en", "mNoKey")}`,
    ]);
    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "off",
      "id-sonnet",
      "id-luna",
      "id-nokey",
    ]);
    expect(select.getAttribute("aria-label")).toBe(tr("en", "mVerifier"));
    expect(select.value).toBe("");
  });

  it("shows Off and a bound model as chosen, and a dangling id as the default", () => {
    expect(verifierOf("off").select.value).toBe("off");
    expect(verifierOf("id-sonnet").select.value).toBe("id-sonnet");
    expect(verifierOf("id-gone").select.value).toBe("");
  });

  it("posts the whole value, every other role as it was", () => {
    posted.length = 0;
    const { select } = verifierOf("");
    select.value = "off";
    select.dispatchEvent(new Event("change"));
    select.value = "id-sonnet";
    select.dispatchEvent(new Event("change"));
    expect(posted).toEqual([
      { reviewers: ["", ""], synthesis: "id-luna", verifier: "off" },
      { reviewers: ["", ""], synthesis: "id-luna", verifier: "id-sonnet" },
    ]);
  });

  it("is labelled, and says what it does and what it costs", () => {
    const { body } = verifierOf("");
    // The SECOND sub-label: since V1's J1 round the cross-review's own select
    // carries the first one.
    expect(body.querySelectorAll(".lm-mcard__sublabel")[1]?.textContent).toBe(
      tr("en", "mVerifier"),
    );
    expect(body.textContent).toContain(tr("en", "mVerifierDesc"));
  });

  it("leaves the cross-review's own select on Same as Writing", () => {
    const { body } = verifierOf("");
    expect(optionsOf(selects(body)[0] as HTMLSelectElement)[0]).toBe(
      tr("en", "mSameAsWriting"),
    );
    expect(optionsOf(selects(body)[0] as HTMLSelectElement)).not.toContain(
      tr("en", "mVerifierOff"),
    );
  });

  it("renders in the reader's language, and only that one", () => {
    const { body, select } = verifierOf("", "zh");
    expect(optionsOf(select).slice(0, 2)).toEqual([
      tr("zh", "mSameAsCrossReview"),
      tr("zh", "mVerifierOff"),
    ]);
    expect(body.textContent).toContain(tr("zh", "mVerifierDesc"));
    for (const key of [
      "mVerifier",
      "mVerifierDesc",
      "mSameAsCrossReview",
      "mVerifierOff",
    ] as const)
      expect(body.textContent, key).not.toContain(tr("en", key));
  });
});

/**
 * O15: the PDF review card (V4, ADR 0081 §8; plan D12) — who reads the
 * compiled PDF, and a notice when that model cannot see.
 */
describe("the PDF review card (O15)", () => {
  /** The Models tab's rows as `ConfiguredModelInfo` carries them: the
   *  Writing row is `active`, and each says whether it takes images. */
  const SEEING = [
    {
      id: "id-sonnet",
      label: "Sonnet",
      providerLabel: "Anthropic",
      keyPresent: true,
      active: true,
      imageInputDefault: true,
    },
    {
      id: "id-deepseek",
      label: "deepseek-chat",
      providerLabel: "DeepSeek",
      keyPresent: true,
      active: false,
      imageInputDefault: false,
    },
    {
      id: "id-override",
      label: "my-vlm",
      providerLabel: "Custom",
      keyPresent: false,
      active: false,
      imageInput: true,
      imageInputDefault: false,
    },
  ];
  const card = (
    pdfReviewer: string | undefined,
    models: ReviewRolesView["models"] = SEEING,
    locale: "en" | "zh" = "en",
    sink: unknown[] = [],
  ): HTMLElement =>
    pdfReviewCardBody(
      {
        models,
        roles: {
          reviewers: ["", "id-sonnet"],
          synthesis: "id-sonnet",
          verifier: "off",
          ...(pdfReviewer !== undefined ? { pdfReviewer } : {}),
        },
        maxReviewers: 8,
      },
      locale,
      (roles) => sink.push(roles),
    );
  const notice = (body: HTMLElement): string | undefined =>
    body.querySelector(".lm-mcard__blind")?.textContent ?? undefined;

  it("offers Same as Writing, then Off, then every model", () => {
    const [select] = selects(card(""));
    expect(optionsOf(select as HTMLSelectElement)).toEqual([
      tr("en", "mSameAsWriting"),
      tr("en", "mPdfReviewerOff"),
      "Sonnet · Anthropic",
      "deepseek-chat · DeepSeek",
      `my-vlm · Custom · ${tr("en", "mNoKey")}`,
    ]);
    expect(select?.getAttribute("aria-label")).toBe(tr("en", "mPdfReviewer"));
    expect(selects(card(""))).toHaveLength(1);
  });

  it("selects the stored value — Same as Writing, Off, or a model", () => {
    expect(selects(card(""))[0]?.value).toBe("");
    expect(selects(card("off"))[0]?.value).toBe("off");
    expect(selects(card("id-deepseek"))[0]?.value).toBe("id-deepseek");
    // A value stored before V4 has no field, and reads as the default.
    expect(selects(card(undefined))[0]?.value).toBe("");
    // A model that has left the list reads as what the host prunes it to.
    expect(selects(card("id-gone"))[0]?.value).toBe("");
  });

  it("posts all four roles on change, the other three untouched", () => {
    const sink: unknown[] = [];
    const [select] = selects(card("", SEEING, "en", sink));
    (select as HTMLSelectElement).value = "id-override";
    select?.dispatchEvent(new Event("change"));
    (select as HTMLSelectElement).value = "off";
    select?.dispatchEvent(new Event("change"));
    expect(sink).toEqual([
      {
        reviewers: ["", "id-sonnet"],
        synthesis: "id-sonnet",
        verifier: "off",
        pdfReviewer: "id-override",
      },
      {
        reviewers: ["", "id-sonnet"],
        synthesis: "id-sonnet",
        verifier: "off",
        pdfReviewer: "off",
      },
    ]);
  });

  it("carries its hint", () => {
    expect(card("").querySelector(".lm-mcard__hint")?.textContent).toBe(
      tr("en", "mPdfReviewerDesc"),
    );
  });

  it("draws the blind notice iff the effective model cannot see", () => {
    const blind = tr("en", "mPdfReviewerBlind");
    // A model that cannot see, chosen by id.
    expect(notice(card("id-deepseek"))).toBe(blind);
    // Seeing models, chosen by id — by the table, or by the user's override
    // of a table that says no.
    expect(notice(card("id-sonnet"))).toBeUndefined();
    expect(notice(card("id-override"))).toBeUndefined();
    // Off reviews no PDF, so there is nothing to warn about.
    expect(notice(card("off"))).toBeUndefined();
  });

  it("reads the Writing row for Same as Writing", () => {
    expect(notice(card(""))).toBeUndefined();
    const blindWriting = SEEING.map((m) => ({
      ...m,
      active: m.id === "id-deepseek",
    }));
    expect(notice(card("", blindWriting))).toBe(tr("en", "mPdfReviewerBlind"));
    // The override wins over the table in both directions.
    const overridden = SEEING.map((m) =>
      m.id === "id-sonnet" ? { ...m, imageInput: false } : m,
    );
    expect(notice(card("", overridden))).toBe(tr("en", "mPdfReviewerBlind"));
    // No Writing model at all: nothing is known, so nothing is claimed.
    const noWriting = SEEING.map((m) => ({ ...m, active: false }));
    expect(notice(card("", noWriting))).toBeUndefined();
  });

  it("claims nothing about a model whose image input it was not told", () => {
    // The merged fixtures' rows carry neither field.
    expect(notice(card("", MODELS))).toBeUndefined();
    expect(notice(card("id-luna", MODELS))).toBeUndefined();
  });

  it("says all of it in Chinese", () => {
    const body = card("id-deepseek", SEEING, "zh");
    expect(
      optionsOf(selects(body)[0] as HTMLSelectElement).slice(0, 2),
    ).toEqual(["与写作模型相同", "关闭"]);
    expect(body.querySelector(".lm-mcard__hint")?.textContent).toBe(
      tr("zh", "mPdfReviewerDesc"),
    );
    expect(notice(body)).toBe(tr("zh", "mPdfReviewerBlind"));
    // Wholly Chinese but for the format's name, which the zh table keeps.
    expect(notice(body)?.replace(/\bPDF\b/g, "")).not.toMatch(/[A-Za-z]{2,}/);
  });
});
