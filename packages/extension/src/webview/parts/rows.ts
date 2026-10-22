/**
 * The row primitives the Citations, Review and Compile tabs share (R3,
 * ADR 0037).
 *
 * `el`, `citeRow` and `foldedGroup` lived in `main.ts` because that is where
 * every tab was rendered. R3 moves the Review tab into its own pure module
 * (`review-tab.ts`), and a second renderer needs the same primitives — so they
 * move here rather than being copied, which is what would have made the two
 * tabs drift apart in CSS class names nothing type-checks.
 *
 * Nothing here reads module state, a locale or a `vscode` handle: every string
 * is passed in, already in the reader's language.
 */

/** Build one element: `class` sets `className`, everything else is an attribute. */
export function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export interface CiteRowOptions {
  mono?: boolean;
  spin?: boolean;
  onClick?: () => void;
  adopt?: () => void;
  /** Required with `adopt`: the button's caption, in the reader's language.
   *  It used to default to the Citations wording through a `t()` call inside
   *  this function — a locale dependency hidden in a primitive, which is
   *  exactly what a pure module cannot have. */
  adoptLabel?: string;
  /** A second, neutral action (the Review tab's Ignore button). */
  ignore?: () => void;
  ignoreLabel?: string;
  /** ADR 0062 §5: *I have dealt with this* — distinct from Ignore. */
  resolve?: () => void;
  resolveLabel?: string;
  /** ADR 0062 §6: take this finding to the Assistant and talk about it. */
  chat?: () => void;
  chatLabel?: string;
  /** An extra line inside the row's BODY, under the detail and above the
   *  buttons — the Review tab's evidence line. Appending it to the row itself
   *  would make it a third child of a flex row and put it beside the glyph. */
  extra?: readonly HTMLElement[];
}

/**
 * One finding row: a glyph, a title, a detail line, and up to two buttons.
 *
 * A row can be clickable AND carry buttons, so each button stops the click
 * from bubbling into the row's own reveal handler.
 */
export function citeRow(
  glyph: string,
  color: string,
  title: string,
  detail: string,
  opts: CiteRowOptions = {},
): HTMLElement {
  const icon = el(
    "span",
    { class: `lm-cite-row__icon ${color}${opts.spin ? " lm-spin" : ""}` },
    glyph,
  );
  const titleEl = el("span", { class: `lm-cite-row__title ${color}` }, title);
  const detailEl = el(
    "span",
    { class: `lm-cite-row__detail${opts.mono ? " lm-cite-mono" : ""}` },
    detail,
  );
  const body = el("div", { class: "lm-cite-row__body" }, titleEl, detailEl);
  if (opts.extra) body.append(...opts.extra);
  const rowButton = (
    label: string,
    onClick: () => void,
    extraClass: string,
  ): HTMLButtonElement => {
    const btn = el(
      "button",
      { class: `lm-cite-adopt ${extraClass}` },
      label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  };
  if (opts.adopt || opts.ignore || opts.resolve || opts.chat) {
    const actions = el("div", { class: "lm-cite-actions" });
    if (opts.adopt)
      actions.append(rowButton(opts.adoptLabel ?? "", opts.adopt, color));
    if (opts.resolve)
      actions.append(rowButton(opts.resolveLabel ?? "", opts.resolve, "is-ok"));
    if (opts.ignore)
      actions.append(
        rowButton(opts.ignoreLabel ?? "", opts.ignore, "is-faint"),
      );
    if (opts.chat)
      actions.append(rowButton(opts.chatLabel ?? "", opts.chat, "is-faint"));
    body.append(actions);
  }
  const row = el("div", { class: "lm-cite-row" }, icon, body);
  if (opts.onClick) {
    row.classList.add("lm-cite-row--link");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.addEventListener("click", (e) => {
      // V2's gate review, issue 1: a row may CONTAIN a link — the Review tab's
      // `prior work` title. That click is the link's, and the row takes no
      // second action from it: opening the paper and scrolling the manuscript
      // are two things, and the click asked for one.
      //
      // The guard lives HERE rather than on the anchor because the anchor is
      // the one element that must not stop the click. VS Code opens a webview
      // link from a bubble-phase listener on the frame's window, so the click
      // has to travel past this row, uncancelled, to be opened at all.
      if ((e.target as Element | null)?.closest?.("a[href]") != null) return;
      opts.onClick?.();
    });
    row.addEventListener("keydown", (e) => {
      // Enter/Space on the focused Adopt button must activate the BUTTON —
      // preventDefault here would swallow its synthetic click.
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onClick?.();
      }
    });
  }
  return row;
}

/**
 * A folded sub-list — shared by the Review and Compile tabs, each passing its
 * own row renderer.
 *
 * `opts.summary` replaces the default `title · count` wholesale, for a heading
 * that already carries its own count or says why there is none (ADR 0062 §4:
 * the Review tab's seat groups, whose heading is a sentence in three shapes).
 * `opts.class` is appended to the `<details>`, which is how those groups get
 * the larger heading without the Compile tab's folds changing size.
 *
 * `opts.summary` may be a node as well as a string: a Review heading carries
 * a model id and a count in spans of their own, so they can stay whole at a
 * narrow width (the X6 review round). Its text is the same either way.
 */
export function foldedGroup<T>(
  title: string,
  items: readonly T[],
  open: boolean,
  onToggle: (next: boolean) => void,
  row: (item: T) => HTMLElement,
  opts: { summary?: string | Node; class?: string } = {},
): HTMLElement {
  const details = el("details", {
    class: `lm-review-fold${opts.class ? ` ${opts.class}` : ""}`,
  });
  if (open) details.setAttribute("open", "");
  const summary = el(
    "summary",
    { class: "lm-review-fold__summary" },
    opts.summary ?? `${title} · ${items.length}`,
  );
  details.append(summary);
  for (const a of items) details.append(row(a));
  details.addEventListener("toggle", () =>
    onToggle((details as HTMLDetailsElement).open),
  );
  return details;
}
