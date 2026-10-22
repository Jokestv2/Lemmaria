/**
 * The Lemmaria brand in the webview (P1, ADR 0072; revised by P1b, ADR 0073).
 *
 * Four builders, because the brand is not one drawing at four sizes:
 *
 * - `brandMark(48–128)` — the full gradient mark, static. The welcome region.
 * - `popMark(32–128)` — the pack's sequential loader, animated. The working row.
 * - `brandGlyph(14–32)` — the masked single-colour glyph. The panel header.
 *   A *different construction*, not a smaller `brandMark`: below ~32 px the
 *   gradients and overlaps merge into a blob, so the small mark separates the
 *   pebbles with a stroked mask instead.
 * - `workingRing()` — the pack's `compact` ring. Currently wired to nothing;
 *   see its own comment for why it is kept.
 *
 * **Why the artwork is code and not a file.** The webview's CSP is
 * `default-src 'none'` with `style-src`/`font-src`/a nonced `script-src` and
 * **no `img-src`** (`webview-view.ts`), so an `<img>` — SVG, WebP, APNG, GIF,
 * any of them — is blocked with no visible error; `localResourceRoots` is
 * `["dist"]` besides. The design pack ships a framework-free component for
 * exactly this job, and it cannot be vendored either: it builds its artwork
 * with `el.innerHTML = markup`, and `check-webview-innerhtml.mjs` is
 * deny-by-default over this whole tree with no allowlist, for the good reason
 * that model output is one sibling away.
 *
 * So the marks are built with `createElementNS`, the way
 * `parts/markdown.ts`'s `icon()` and `parts/ring.ts` already reason about it.
 *
 * **And why the colours and the animation are in `styles.css`.** The pack's
 * standalone SVGs carry their keyframes in an in-SVG `<style>` element. Under a
 * CSP with no `'unsafe-inline'` that element is dropped, and the result is a
 * *silently static* graphic — the worst failure mode available, because it
 * looks correct in jsdom. `styles.css` is served from `dist` and is already
 * covered by `style-src ${cspSource}`, so the keyframes live there and the
 * nodes here carry only classes. `stop-color` is a real CSS property, which is
 * what lets one set of nodes render the light, dark and high-contrast marks
 * from theme-scoped custom properties.
 *
 * The geometry below is transcribed from the pack and **pinned against it** by
 * `test-webview/brand.test.ts` (row O3): a path string is wrong by one
 * character and still plausible, and nothing else in this repo would notice a
 * wrong logo.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The pack's own viewBox. The mark is drawn on a 1000-unit grid and cropped. */
export const BRAND_VIEW_BOX = "52 72 840 840";

/** The bottom pebble. */
export const PEBBLE_BOTTOM =
  "M301.758 546.256C216.969 569.98 135.643 647.227 169.12 730.176c33.476 82.948 141.669 107.204 226.718 125.347 85.048 18.143 180.134 36.267 265.735 4.385 85.601-31.883 142.132-124.876 114.6-207.019-27.533-82.143-121.516-130.636-209.49-141.504-87.975-10.867-180.136 11.147-264.925 34.871Z";

/**
 * The middle pebble — drawn three times, which is not a mistake. The pack
 * renders each *intersection* by repainting this same silhouette inside the
 * clip of the pebble above it, in a dedicated overlap gradient. See `brandMark`.
 */
export const PEBBLE_MIDDLE =
  "M390.5 312.4C320.052 306.651 226.78 326.592 207.602 395.974s52.544 122.88 112.833 161.281c60.289 38.401 129.148 81.338 201.511 80.385 72.362-.952 149.849-46.605 178.488-111.457 28.639-64.853-33.447-128.288-99.684-160.83-66.236-32.542-139.802-47.204-210.25-52.953Z";

/** The top pebble. */
export const PEBBLE_TOP =
  "M390.5 312.4c38.839 42.36 93.223 83.144 149.807 82.644 56.584-.499 126.028-15.069 164.083-57.019 38.054-41.949 11.057-108.743-30.803-149.086-41.86-40.342-96.547-69.404-154.455-78.99-57.908-9.586-128.342 3.251-161.778 51.839-33.435 48.588-5.693 108.253 33.146 150.612Z";

/**
 * The five gradients, with the pack's coordinates. `userSpaceOnUse` on the
 * 1000-unit grid, so these numbers are the artwork and not a scale factor —
 * changing the rendered size must not touch them.
 *
 * The two stops of each carry no `stop-color`: they take it from
 * `--lm-brand-<id>-0` / `-1`, which `styles.css` defines once per theme.
 */
export const BRAND_GRADIENTS = [
  { id: "bottom", x1: "220", y1: "575", x2: "720", y2: "790" },
  { id: "middle", x1: "270", y1: "360", x2: "670", y2: "580" },
  { id: "top", x1: "390", y1: "140", x2: "690", y2: "350" },
  { id: "overlap-lower", x1: "340", y1: "530", x2: "650", y2: "625" },
  { id: "overlap-upper", x1: "400", y1: "330", x2: "620", y2: "400" },
] as const;

/**
 * The three pebbles, bottom to top — the order `popMark` stacks them in, and
 * the order the masked glyph paints them in. Named once so the two builders and
 * their tests cannot disagree about it.
 */
export const PEBBLES = [
  { id: "bottom", d: PEBBLE_BOTTOM },
  { id: "middle", d: PEBBLE_MIDDLE },
  { id: "top", d: PEBBLE_TOP },
] as const;

/**
 * The separation the small-size glyph cuts between pebbles: each lower pebble
 * is masked by the silhouette of the one above it, *stroked* by this much, so a
 * gap of visible background survives being scaled down to 14–16 px. The pack's
 * value, and the whole reason the glyph reads at a size where the gradient
 * mark's overlaps do not.
 */
export const GLYPH_SEPARATION = "84";

/**
 * The working row's mark size. **32 px is the pack's floor for `pop`** — it
 * specifies 32–128 for the variant, against 16–32 for `compact`. Below it the
 * three pebbles stop separating as they stack and the sequence reads as one
 * pulsing blob, which is the failure the size floor exists to prevent.
 */
export const BUSY_MARK_SIZE = 32;

/** The empty panel's mark size, within the pack's 48–128 for the full mark. */
export const WELCOME_MARK_SIZE = 64;

/** The panel header's glyph size, within the pack's 16–32 for a title-bar mark. */
export const HEADER_GLYPH_SIZE = 16;

/**
 * Instance counter for `url(#id)` uniqueness.
 *
 * A fragment reference resolves **document-wide**, so two marks sharing ids
 * means the second instance's gradients silently repaint the first. The
 * transcript rebuilds `document.body` once per animation frame while a response
 * streams, so "there is only ever one mark" is not a property this module may
 * assume. Adapted from the pack's component, which prefixes for the same reason.
 */
let instance = 0;

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  return node;
}

/**
 * The three-pebble mark, static and in full colour.
 *
 * Paint order is the pack's, and it is load-bearing: the middle pebble first,
 * then the bottom and top each as a full-bleed rect clipped to their own
 * silhouette, each followed by the middle silhouette repainted in that
 * intersection's own gradient. Reordering these produces a mark that is
 * recognisably wrong in the overlaps and nowhere else.
 *
 * `size` is CSS pixels. The pack specifies 48–128 for the full mark; below that
 * the overlaps stop reading and `workingRing` is the right graphic instead.
 */
export function brandMark(size: number): SVGElement {
  const prefix = `lm-brand-${++instance}`;
  const root = svg("svg", {
    viewBox: BRAND_VIEW_BOX,
    width: String(size),
    height: String(size),
    fill: "none",
    // `geometricPrecision` is the pack's: the overlaps are hairline-adjacent
    // and default rasterization leaves seams between the clipped groups.
    "shape-rendering": "geometricPrecision",
    // Decorative. Every surface that shows the mark carries its own text, so a
    // label here would announce the brand name a second time.
    "aria-hidden": "true",
    focusable: "false",
    class: "lm-brand-mark",
  });

  const defs = svg("defs", {});
  defs.append(...gradients(prefix));
  for (const [name, d] of [
    ["bottom", PEBBLE_BOTTOM],
    ["top", PEBBLE_TOP],
  ] as const) {
    const clip = svg("clipPath", {
      id: `${prefix}-clip-${name}`,
      clipPathUnits: "userSpaceOnUse",
    });
    clip.append(svg("path", { d }));
    defs.append(clip);
  }
  root.append(defs);

  root.append(
    svg("path", { d: PEBBLE_MIDDLE, fill: `url(#${prefix}-g-middle)` }),
  );
  for (const [clip, base, overlap] of [
    ["bottom", "bottom", "overlap-lower"],
    ["top", "top", "overlap-upper"],
  ] as const) {
    const group = svg("g", { "clip-path": `url(#${prefix}-clip-${clip})` });
    group.append(
      svg("rect", {
        x: "0",
        y: "0",
        width: "1000",
        height: "1000",
        fill: `url(#${prefix}-g-${base})`,
      }),
      svg("path", {
        d: PEBBLE_MIDDLE,
        fill: `url(#${prefix}-g-${overlap})`,
      }),
    );
    root.append(group);
  }
  return root;
}

/**
 * The **compact** indicator — the pack's 1.2 s ring, for inline rows.
 *
 * **Built, tested, and currently wired to nothing.** It was the working row's
 * graphic until the operator judged it too plain (2026-09-13) and directed
 * `pop` in its place. It is kept rather than deleted because it is the one
 * thing you would put back: the pack specifies `compact` for *"inline tool
 * activity"* and for *"when motion must be legible at 16 px"*, and warns
 * against *"showing multiple large animated marks in one working panel"* —
 * which a 32 px `pop` in the transcript is. If that warning turns out to bite,
 * restoring the ring is one word in `busyRow`, not a rebuild. Its tests run, so
 * it cannot rot while it waits.
 *
 * `currentColor` throughout, so it follows the row's dim foreground rather than
 * printing a brand purple onto every theme. The geometry — r 8.25, stroke 1.8,
 * dash `14 37.836` — is the pack's.
 */
export function workingRing(): SVGElement {
  const root = svg("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    // Decorative: the row's own localized label is the announced status (D4).
    // The pack's component labels its graphic, in hardcoded English, which
    // invariant 6 rule 2 does not permit and which would announce twice.
    "aria-hidden": "true",
    focusable: "false",
    class: "lm-brand-ring",
  });
  root.append(
    svg("circle", {
      cx: "12",
      cy: "12",
      r: "8.25",
      stroke: "currentColor",
      "stroke-opacity": ".18",
      "stroke-width": "1.8",
      class: "lm-brand-ring__track",
    }),
    svg("circle", {
      cx: "12",
      cy: "12",
      r: "8.25",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-dasharray": "14 37.836",
      class: "lm-brand-ring__arc",
    }),
  );
  return root;
}

/** The five gradients, as `<defs>` children. Shared by `brandMark` and `popMark`. */
function gradients(prefix: string): SVGElement[] {
  return BRAND_GRADIENTS.map((g) => {
    const gradient = svg("linearGradient", {
      id: `${prefix}-g-${g.id}`,
      gradientUnits: "userSpaceOnUse",
      x1: g.x1,
      y1: g.y1,
      x2: g.x2,
      y2: g.y2,
    });
    gradient.append(
      svg("stop", { class: `lm-brand-stop lm-brand-stop--${g.id}-0` }),
      svg("stop", {
        offset: "1",
        class: `lm-brand-stop lm-brand-stop--${g.id}-1`,
      }),
    );
    return gradient;
  });
}

/**
 * The **pop** indicator — the pack's sequential loader, and what the working
 * row shows.
 *
 * The three pebbles arrive bottom-to-top at 168 ms intervals; each rises,
 * overshoots slightly and settles. The assembled mark holds, then fades to
 * restart the 2400 ms loop. Timing, easing and the three transform origins are
 * the pack's, and they live in `styles.css` — see the module comment for why
 * they cannot travel inside the SVG.
 *
 * **The construction is the pack's and it is load-bearing.** Each overlap is
 * the middle pebble repainted inside the *clip* of the pebble above or below it,
 * and that clip's own `<use>` carries the same animation class as the pebble it
 * clips — which is what makes an intersection track two independently moving
 * shapes instead of sitting still while they pass through it. Chromium animates
 * a `<use>` inside a `<clipPath>`; this was verified before the code was
 * written, because it is the assumption the whole variant rests on.
 *
 * **Base styles carry no transform and no opacity, deliberately.** The initial
 * keyframe is "small, low and invisible", so if it were also the base style,
 * then `animation: none` — the global reduced-motion rule, and the
 * high-contrast rule below it — would land on an *invisible* mark rather than
 * an assembled one. Everything that moves moves only from a keyframe.
 *
 * `size` is CSS pixels; the pack specifies 32–128 for this variant.
 */
export function popMark(size: number): SVGElement {
  const prefix = `lm-pop-${++instance}`;
  const root = svg("svg", {
    viewBox: BRAND_VIEW_BOX,
    width: String(size),
    height: String(size),
    fill: "none",
    "shape-rendering": "geometricPrecision",
    // Decorative: the row's own localized label is the announced status, and
    // the row's `role="status"` announces it once. The pack's own SVG carries
    // `role="img"` with a hardcoded English `aria-label`, which would both
    // announce twice and break invariant 6 rule 2.
    "aria-hidden": "true",
    focusable: "false",
    class: "lm-brand-pop",
  });

  const defs = svg("defs", {});
  defs.append(...gradients(prefix));
  for (const p of PEBBLES)
    defs.append(svg("path", { id: `${prefix}-${p.id}`, d: p.d }));
  for (const name of ["bottom", "top"] as const) {
    const clip = svg("clipPath", {
      id: `${prefix}-clip-${name}`,
      clipPathUnits: "userSpaceOnUse",
    });
    clip.append(
      svg("use", {
        href: `#${prefix}-${name}`,
        class: `lm-animated lm-pop-${name}-shape`,
      }),
    );
    defs.append(clip);
  }
  root.append(defs);

  /** The middle silhouette, animated, in whichever gradient the caller wants. */
  const middle = (fill: string): SVGElement => {
    const fade = svg("g", { class: "lm-animated lm-pop-middle-fade" });
    fade.append(
      svg("use", {
        href: `#${prefix}-middle`,
        class: "lm-animated lm-pop-middle-shape",
        fill: `url(#${prefix}-g-${fill})`,
      }),
    );
    return fade;
  };

  root.append(middle("middle"));
  for (const [name, overlap] of [
    ["bottom", "overlap-lower"],
    ["top", "overlap-upper"],
  ] as const) {
    const fade = svg("g", { class: `lm-animated lm-pop-${name}-fade` });
    const clipped = svg("g", { "clip-path": `url(#${prefix}-clip-${name})` });
    clipped.append(
      svg("rect", {
        x: "0",
        y: "0",
        width: "1000",
        height: "1000",
        fill: `url(#${prefix}-g-${name})`,
      }),
      middle(overlap),
    );
    fade.append(clipped);
    root.append(fade);
  }
  return root;
}

/**
 * The brand at **small sizes** — the masked, single-colour glyph.
 *
 * `brandMark`'s gradients and overlaps stop reading below about 32 px: scaled
 * down, the three pebbles merge into one blob. The pack solves this with a
 * different construction rather than a smaller copy of the same one — each
 * lower pebble is masked by the *stroked* silhouette of the pebble above it, so
 * a band of background separates them and the stack still reads at 14 px. This
 * is the shape that ships as `media/lemmaria/activity-bar.svg` for the Activity
 * Bar; inside the webview it is the same geometry as nodes.
 *
 * `currentColor` throughout, so it takes the surrounding text's colour and needs
 * no theme tokens at all — which is also what makes it correct in high contrast
 * without a special case.
 */
export function brandGlyph(size: number): SVGElement {
  const prefix = `lm-glyph-${++instance}`;
  const root = svg("svg", {
    viewBox: BRAND_VIEW_BOX,
    width: String(size),
    height: String(size),
    fill: "none",
    // Decorative: every surface that shows the glyph carries the name in text
    // beside it, so a label here would announce "Lemmaria" twice.
    "aria-hidden": "true",
    focusable: "false",
    class: "lm-brand-glyph",
  });

  const defs = svg("defs", {});
  for (const p of PEBBLES)
    defs.append(svg("path", { id: `${prefix}-${p.id}`, d: p.d }));
  // Each pebble is cut by the one ABOVE it; the top pebble is cut by nothing.
  for (const [name, cutBy] of [
    ["bottom", "middle"],
    ["middle", "top"],
  ] as const) {
    const mask = svg("mask", {
      id: `${prefix}-mask-${name}`,
      maskUnits: "userSpaceOnUse",
      x: "0",
      y: "0",
      width: "1000",
      height: "1000",
    });
    mask.append(
      svg("rect", { width: "1000", height: "1000", fill: "white" }),
      svg("use", {
        href: `#${prefix}-${cutBy}`,
        fill: "black",
        stroke: "black",
        "stroke-width": GLYPH_SEPARATION,
        "stroke-linejoin": "round",
      }),
    );
    defs.append(mask);
  }
  root.append(defs);

  root.append(
    svg("use", {
      href: `#${prefix}-bottom`,
      fill: "currentColor",
      mask: `url(#${prefix}-mask-bottom)`,
    }),
    svg("use", {
      href: `#${prefix}-middle`,
      fill: "currentColor",
      mask: `url(#${prefix}-mask-middle)`,
    }),
    svg("use", { href: `#${prefix}-top`, fill: "currentColor" }),
  );
  return root;
}

/**
 * The transcript's "working" row.
 *
 * **Only the graphic is new.** When this row appears is `parts/busy.ts`'s
 * `busyRowVisible()` and stays there — it encodes four decisions (suppressed on
 * a pending edit decision, on a pending script approval, and from the first
 * streamed delta; restored on `stream.retried`) that have nothing to do with
 * what the row looks like.
 *
 * `label` is `t("sessionThinking")`. It is set with `textContent` and is the
 * row's only text node, because the mark contributes none — so
 * `row.textContent` still reads as exactly the caller's string, which is what
 * `role="status"` announces, once. This is why `popMark` emits no `<title>`
 * even though the pack's own SVG does.
 *
 * **The graphic is `popMark`, at the pack's minimum size for it** (operator
 * direction, 2026-09-13: the ring read as too plain). `workingRing` is the
 * pack's `compact` variant and remains available for exactly this row — see its
 * own comment.
 */
export function busyRow(label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "lm-msg lm-msg-busy";
  row.setAttribute("role", "status");
  row.append(popMark(BUSY_MARK_SIZE));
  const text = document.createElement("span");
  text.className = "lm-msg-busy__label";
  text.textContent = label;
  row.append(text);
  return row;
}

/**
 * The Assistant tab's intro region — **the only one it has.**
 *
 * The pack's *"empty webview"* placement, which it ships as a 320 × 180
 * illustration that is itself the 96 px mark on a frame — so once the mark is
 * nodes, the frame is two CSS rules and the file is not needed.
 *
 * **It replaced the `lm-hero` block rather than joining it** (operator
 * direction, 2026-09-13). P1 first added this panel inside the transcript,
 * which put two centred mark-plus-title-plus-subtitle regions in one scroll
 * view — this one below the quick actions and the older hero above them. The
 * hero's *slot* survives, with its show/hide condition untouched in
 * `applySelection`; only what fills it changed.
 *
 * **Static, deliberately.** The pack's own direction: stop animation as soon as
 * work stops, and never represent waiting for a human as active computation. An
 * empty panel is waiting for the user.
 *
 * Both strings come from `parts/strings.ts` and are therefore one language,
 * chosen by the reader (invariant 6 rule 2).
 */
export function welcomePanel(title: string, body: string): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "lm-welcome";
  panel.append(brandMark(WELCOME_MARK_SIZE));
  const heading = document.createElement("div");
  heading.className = "lm-welcome__title";
  heading.textContent = title;
  const guidance = document.createElement("div");
  guidance.className = "lm-welcome__body";
  guidance.textContent = body;
  panel.append(heading, guidance);
  return panel;
}
