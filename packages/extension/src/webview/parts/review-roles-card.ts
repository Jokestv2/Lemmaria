/**
 * The Models tab's Reviewers and Cross-review cards (R9, ADR 0069 §D8), and
 * since V4 the PDF review card (ADR 0081 §8).
 *
 * These are the two `shell: "v03"` cards U3 drew dimmed and tagged *v0.3*, lit
 * at last: R9 made the panel N standalone reviewers, each on a model the user
 * picks, and this is where the user picks them.
 *
 * **Why a `parts/` module rather than inline in `main.ts`.** Every other card
 * on the Models tab is inline, and the roles section was too. But these two
 * decide how many models a review spends on and which — a control whose only
 * evidence would otherwise be a human clicking it, which ADR 0038 §3 forbids
 * sending a human for a *tooling* reason. Under `parts/` it is in the jsdom
 * project, and `review-roles-card.test.ts` reads the DOM it produces.
 *
 * Nothing here reads module state, the `vscode` handle or a module-global
 * `t()`: the locale is a parameter and every post goes through the callback,
 * which is what `rows.ts`'s header asks of a part and what makes the module
 * testable at all.
 *
 * The two cards return only their BODIES. `roleCard` in `main.ts` stays the
 * one home of the card chrome — the dot, the title, the description — so
 * lighting these two cannot drift from the Writing card beside them.
 */
import type { SessionLocale } from "@lemmaria/harness";
import { PDF_REVIEWER_OFF, VERIFIER_OFF } from "../../webview-protocol.js";
import { el } from "./rows.js";
import { tr } from "./strings.js";

/** The part of `ConfiguredModelInfo` a role select needs. */
export interface RoleModelOption {
  id: string;
  label: string;
  providerLabel: string;
  keyPresent: boolean;
  /** V4 (ADR 0081 §8): the Writing model — what *Same as Writing* means.
   *  Optional, like the two below: `ConfiguredModelInfo` carries all three,
   *  and a card that needs none of them is not made to invent them. */
  active?: boolean;
  /** V3 (ADR 0080 §6): the user's image-input override; absent for *auto*. */
  imageInput?: boolean;
  /** V3: what *auto* resolves to for this model id, computed host-side. */
  imageInputDefault?: boolean;
}

/** What the two cards render from. */
export interface ReviewRolesView {
  models: readonly RoleModelOption[];
  roles: {
    reviewers: readonly string[];
    synthesis: string;
    verifier: string;
    /** V4 (ADR 0081 §8): carried through every post, so editing one role
     *  never resets another. */
    pdfReviewer?: string;
  };
  /** The harness's fan-out ceiling, relayed by the host — the webview cannot
   *  import `MAX_FAN_OUT` (it takes only pure leaf subpaths, ADR 0011) and a
   *  second copy of the number is a second thing to keep true. */
  maxReviewers: number;
}

/** The whole value, every time (D8): the count IS the list — and, since V1
 *  (ADR 0076 §8), the verifier travels with it, so no card can post a value
 *  that silently resets another card's choice. */
export type PostRoles = (roles: {
  reviewers: string[];
  synthesis: string;
  verifier: string;
  pdfReviewer?: string;
}) => void;

/** An option a role offers ahead of the models: a value and its caption. */
interface LeadingOption {
  value: string;
  label: string;
}

/** What every role but the verifier leads with: `""`, *Same as Writing*. */
const sameAsWriting = (locale: SessionLocale): LeadingOption[] => [
  { value: "", label: tr(locale, "mSameAsWriting") },
];

/**
 * One role's `<select>`: its leading options first — *Same as Writing* for a
 * reviewer and the cross-review; *Same as Cross-review* and *Off* for the
 * verifier (V1, ADR 0076 §8) — then every configured model in the Writing
 * select's own `label · providerLabel` form.
 *
 * A model with no key is OFFERED, carrying the same `mNoKey` suffix the
 * Connected list uses. Hiding it would leave the reader wondering where their
 * model went; showing it lets them see the refusal coming, because the host
 * declines to run a panel whose reviewer cannot be bound rather than quietly
 * falling back to Writing.
 */
function roleSelect(
  view: ReviewRolesView,
  selected: string,
  locale: SessionLocale,
  ariaLabel: string,
  onPick: (id: string) => void,
  leading: readonly LeadingOption[],
): HTMLSelectElement {
  const select = el("select", {
    class: "lm-mcard__modelselect",
    "aria-label": ariaLabel,
  }) as HTMLSelectElement;
  for (const option of leading)
    select.append(
      el("option", { value: option.value }, option.label) as HTMLOptionElement,
    );
  for (const m of view.models) {
    const suffix = m.keyPresent ? "" : ` · ${tr(locale, "mNoKey")}`;
    select.append(
      el(
        "option",
        { value: m.id },
        `${m.label} · ${m.providerLabel}${suffix}`,
      ) as HTMLOptionElement,
    );
  }
  // A role pointing at a model that has left the list would select nothing and
  // silently read as "Same as Writing" — which is exactly what the host's own
  // pruning already made true, so the two agree by construction. A leading
  // value (the verifier's *Off*) is a choice, not a model, and is kept.
  select.value =
    leading.some((o) => o.value === selected) ||
    view.models.some((m) => m.id === selected)
      ? selected
      : "";
  select.addEventListener("change", () => onPick(select.value));
  return select;
}

/** The current value, as a mutable copy the callers below can edit. */
function copy(view: ReviewRolesView): {
  reviewers: string[];
  synthesis: string;
  verifier: string;
  pdfReviewer?: string;
} {
  return {
    reviewers: [...view.roles.reviewers],
    synthesis: view.roles.synthesis,
    verifier: view.roles.verifier,
    ...(view.roles.pdfReviewer !== undefined
      ? { pdfReviewer: view.roles.pdfReviewer }
      : {}),
  };
}

/**
 * The Reviewers card's body: one row per reviewer, an add button, and — at one
 * reviewer — the line that says a cross-review will not run.
 *
 * The count is the row count. There is no separate number to disagree with the
 * list, which is the same reason the message carries the whole value.
 */
export function reviewersCardBody(
  view: ReviewRolesView,
  locale: SessionLocale,
  post: PostRoles,
): HTMLElement {
  const body = el("div", { class: "lm-mcard__roles" });
  const lone = view.roles.reviewers.length <= 1;

  for (const [i, id] of view.roles.reviewers.entries()) {
    const row = el("div", { class: "lm-mrole" });
    row.append(
      // Numbered, so a screen reader can tell the rows apart — every row
      // carried the same label until the R9 review pointed it out.
      roleSelect(
        view,
        id,
        locale,
        `${tr(locale, "mReviewers")} ${i + 1}`,
        (picked) => {
          const next = copy(view);
          next.reviewers[i] = picked;
          post(next);
        },
        sameAsWriting(locale),
      ),
    );
    const remove = el(
      "button",
      {
        class: "lm-mrole__remove",
        title: tr(locale, "mRemoveReviewer"),
        "aria-label": tr(locale, "mRemoveReviewer"),
      },
      "✕",
    ) as HTMLButtonElement;
    // Zero reviewers is not a panel — the store clamps to 1 anyway, and a
    // control that posts a value the host will silently change is a lie.
    remove.disabled = lone;
    remove.addEventListener("click", () => {
      const next = copy(view);
      next.reviewers.splice(i, 1);
      post(next);
    });
    row.append(remove);
    body.append(row);
  }

  const add = el(
    "button",
    { class: "lm-dashed-btn lm-mrole__add" },
    `＋ ${tr(locale, "mAddReviewer")}`,
  ) as HTMLButtonElement;
  // Invariant 5: a host can only ask for LESS than the fan-out allows.
  add.disabled = view.roles.reviewers.length >= view.maxReviewers;
  add.addEventListener("click", () => {
    const next = copy(view);
    // A new reviewer follows Writing until the reader says otherwise — the
    // same default the store ships.
    next.reviewers.push("");
    post(next);
  });
  body.append(add);

  if (lone) {
    // D6: N = 1 is allowed, and its cross-review is honestly recorded as
    // missing. Saying so here is what stops that being a surprise on the
    // Review tab twenty minutes later.
    body.append(
      el(
        "div",
        { class: "lm-mcard__hint" },
        tr(locale, "mCrossReviewNeedsTwo"),
      ),
    );
  }
  return body;
}

/**
 * The Cross-review card's body: its own select, then — V1 (ADR 0076 §8) — the
 * verifier's, labelled, under it.
 *
 * The verifier lives on this card because its default IS this card's model:
 * *Same as Cross-review*. It is a role, not a reviewer (ADR 0069 §1 stands),
 * so it is not a row of the Reviewers card and never counts toward it.
 */
export function crossReviewCardBody(
  view: ReviewRolesView,
  locale: SessionLocale,
  post: PostRoles,
): HTMLElement {
  const body = el("div", { class: "lm-mcard__roles" });
  body.append(
    // Both selects carry a sub-label, as every Reviewers row does. V1's J1
    // round read a card that named only its second control, and inferred the
    // first from the card title — which is a guess the card can just answer.
    el("div", { class: "lm-mcard__sublabel" }, tr(locale, "mCrossReview")),
    roleSelect(
      view,
      view.roles.synthesis,
      locale,
      tr(locale, "mCrossReview"),
      (picked) => {
        const next = copy(view);
        next.synthesis = picked;
        post(next);
      },
      sameAsWriting(locale),
    ),
    el("div", { class: "lm-mcard__sublabel" }, tr(locale, "mVerifier")),
    roleSelect(
      view,
      view.roles.verifier,
      locale,
      tr(locale, "mVerifier"),
      (picked) => {
        const next = copy(view);
        next.verifier = picked;
        post(next);
      },
      [
        { value: "", label: tr(locale, "mSameAsCrossReview") },
        { value: VERIFIER_OFF, label: tr(locale, "mVerifierOff") },
      ],
    ),
    el("div", { class: "lm-mcard__hint" }, tr(locale, "mVerifierDesc")),
  );
  return body;
}

/**
 * V4 (ADR 0081 §8): the PDF review card's body — who reads the compiled PDF.
 *
 * One named select, led by *Same as Writing* (the default, ADR 0069 §8's for
 * a role) and *Off*, then every model; a hint saying what the role does; and
 * — only when the EFFECTIVE model cannot see — a notice saying the PDF will
 * not be reviewed. The effective model is the selected row, or the Writing
 * row for *Same as Writing*; *cannot see* is `imageInput ?? imageInputDefault`
 * answering `false`, both of which `ConfiguredModelInfo` carries since V3, so
 * the card needs no table of its own. Advice, not an error: the review still
 * runs, and the limit it records says the same thing afterwards.
 */
export function pdfReviewCardBody(
  view: ReviewRolesView,
  locale: SessionLocale,
  post: PostRoles,
): HTMLElement {
  const body = el("div", { class: "lm-mcard__roles" });
  const selected = view.roles.pdfReviewer ?? "";
  const select = roleSelect(
    view,
    selected,
    locale,
    tr(locale, "mPdfReviewer"),
    (picked) => {
      // The whole value, every time — the other three roles ride along, so
      // choosing a PDF reviewer never resets a reviewer or the verifier.
      post({ ...copy(view), pdfReviewer: picked });
    },
    [
      ...sameAsWriting(locale),
      { value: PDF_REVIEWER_OFF, label: tr(locale, "mPdfReviewerOff") },
    ],
  );
  body.append(
    select,
    el("div", { class: "lm-mcard__hint" }, tr(locale, "mPdfReviewerDesc")),
  );
  // What the select SHOWS is what counts: a dangling id reads as *Same as
  // Writing* there, which is what the host's pruning makes it.
  const shown = select.value;
  const effective =
    shown === PDF_REVIEWER_OFF
      ? undefined
      : shown === ""
        ? view.models.find((m) => m.active === true)
        : view.models.find((m) => m.id === shown);
  if (
    effective !== undefined &&
    (effective.imageInput ?? effective.imageInputDefault) === false
  ) {
    body.append(
      el(
        "div",
        { class: "lm-mcard__hint lm-mcard__blind" },
        tr(locale, "mPdfReviewerBlind"),
      ),
    );
  }
  return body;
}
