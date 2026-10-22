/**
 * The Models tab's *Image input* control (V3, ADR 0080 §6).
 *
 * One select per model row, with three settings and four labels: **auto**,
 * which renders as *auto (yes)* or *auto (no)* by what the harness's prefix
 * table says about that model id, and the two explicit overrides.
 *
 * **Why `auto` shows its resolved answer.** A bare *auto* would leave the user
 * to guess whether their endpoint is one the table knows, which is exactly the
 * question the override exists to answer. Showing *auto (no)* beside a model id
 * nobody has heard of is what makes the override discoverable at the moment it
 * is needed.
 *
 * `imageInputDefault` is computed HOST-side and relayed: the webview may import
 * nothing from the harness but the declared pure leaf subpaths, and the
 * capability table is not one of them (ADR 0011). A second copy of the table
 * here would be a second thing to keep true.
 *
 * Like `review-roles-card.ts`, this is a `parts/` module rather than inline in
 * `main.ts` so the jsdom project can read the DOM it produces — the control's
 * value, its options and the message it posts are all assertable, which leaves
 * the human only the perceptual question of whether it reads as part of its row.
 */
import type { SessionLocale } from "@lemmaria/harness";
import type {
  ConfiguredModelInfo,
  WebviewToHost,
} from "../../webview-protocol.js";
import { el } from "./rows.js";
import { tr } from "./strings.js";

/** The part of `ConfiguredModelInfo` this control needs. */
export type ImageInputModel = Pick<
  ConfiguredModelInfo,
  "id" | "imageInput" | "imageInputDefault"
>;

/** The three stored settings, as the select's option values. */
export const IMAGE_INPUT_VALUES = ["auto", "yes", "no"] as const;
export type ImageInputValue = (typeof IMAGE_INPUT_VALUES)[number];

/** Which option a model's stored override selects. Absent ⇒ auto. */
export function imageInputValueOf(m: ImageInputModel): ImageInputValue {
  if (m.imageInput === undefined) return "auto";
  return m.imageInput ? "yes" : "no";
}

export function imageInputControl(
  locale: SessionLocale,
  m: ImageInputModel,
  post: (msg: WebviewToHost) => void,
): HTMLElement {
  const select = el("select", { class: "m-image-input" }) as HTMLSelectElement;
  const current = imageInputValueOf(m);

  const options: Array<[ImageInputValue, string]> = [
    [
      "auto",
      tr(locale, m.imageInputDefault ? "mImageAutoYes" : "mImageAutoNo"),
    ],
    ["yes", tr(locale, "mImageYes")],
    ["no", tr(locale, "mImageNo")],
  ];
  for (const [value, label] of options) {
    const option = el("option", { value }, label) as HTMLOptionElement;
    if (value === current) option.selected = true;
    select.append(option);
  }

  select.addEventListener("change", () => {
    post({
      type: "setModelImageInput",
      id: m.id,
      value: select.value as ImageInputValue,
    });
  });

  return el(
    "label",
    { class: "m-image-input-row" },
    el("span", { class: "m-image-input-label" }, tr(locale, "mImageInput")),
    select,
  );
}
