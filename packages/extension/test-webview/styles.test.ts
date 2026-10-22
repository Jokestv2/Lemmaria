import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * QA-4, and the one place in this project where a SOURCE-level assertion is
 * the right tool rather than a shortcut.
 *
 * jsdom performs no layout: `offsetWidth` is always 0 and a container query
 * never resolves, so no test here can observe the reflow. What *is* offline is
 * that the mechanism exists and is aimed at the right selectors — a stylesheet
 * is data, and reading it asserts the rule itself rather than the code that
 * built it. Whether the result LOOKS right at a real sidebar width is an
 * *eyes* item, with that reason recorded in the tier table.
 */

// Resolved from this file, not from the runner's cwd. Deliberately NOT
// `new URL("…", import.meta.url)`: Vite rewrites that pattern into a bundled
// asset reference, and `import … from "….css?raw"` comes back empty because
// vitest's `css: false` short-circuits stylesheet transforms.
const css = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "webview",
    "styles.css",
  ),
  "utf8",
);

/** The body of the first `@container` block, braces balanced. */
function containerBlock(): string {
  const start = css.indexOf("@container");
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
}

describe("the Assistant view is responsive (QA-4)", () => {
  it("declares a query container on the app root", () => {
    // `@container`, not `@media`: the sidebar's width is not the viewport's,
    // so a viewport breakpoint is the wrong tool. `.lm-app` is the full-height
    // flex column `render()` creates; the served <body> is empty.
    expect(css).toMatch(/\.lm-app\s*\{[^}]*container-type:\s*inline-size/);
  });

  it("carries a width breakpoint at all", () => {
    // Before D2 the only @media in ~1,260 lines was prefers-reduced-motion,
    // so narrowing the sidebar simply clipped the right-hand tiles.
    expect(containerBlock()).not.toBe("");
  });

  it("collapses the quick-action grid to one column when narrow", () => {
    // `.lm-grid` is a hard `1fr 1fr` with no minmax and no auto-fit.
    const block = containerBlock();
    expect(block).toMatch(
      /\.lm-grid\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
    );
  });

  it("lets a Markdown code block scroll rather than break mid-token", () => {
    // `.lm-tool__raw`'s `word-break: break-all` is right for a JSON blob and
    // wrong for code, which is why D3 gave the code block a rule of its own
    // instead of reusing that class the way the script fold does.
    expect(css).toMatch(/\.lm-md__pre\s*\{[^}]*overflow:\s*auto/);
  });

  it("lets the composer row wrap instead of crowding", () => {
    // Seven children in one flex row with no wrap — the primary narrow-width
    // failure. `.lm-proposal__controls` and `.lm-steering` already wrap, so
    // this is the file's own idiom rather than a new one.
    expect(containerBlock()).toMatch(
      /\.lm-composer__row\s*\{[^}]*flex-wrap:\s*wrap/,
    );
  });
});

describe("the rendered message controls its own whitespace (D3-7)", () => {
  it("turns pre-wrap off on the Markdown bubble, by specificity", () => {
    // With block children, `.lm-msg`'s `pre-wrap` would also render the
    // whitespace BETWEEN them, so a heading followed by a list would carry a
    // blank line nobody wrote.
    //
    // The selector must be `.lm-msg.lm-md`, not a bare `.lm-md`: both are one
    // class, so a bare selector wins only by source order and reordering this
    // file would reintroduce the defect with the suite still green.
    expect(css).toMatch(/\.lm-msg\.lm-md\s*\{[^}]*white-space:\s*normal/);
  });

  it("puts it back on the paragraph, where it was doing a job", () => {
    // A soft newline inside a paragraph is visible today and stays visible:
    // the rule moved, it was not dropped.
    expect(css).toMatch(/\.lm-md__p\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  it("leaves every other message bubble alone", () => {
    // `.lm-msg-user` and the tool/notice rows still depend on it.
    expect(css).toMatch(/\.lm-msg\s*\{[^}]*white-space:\s*pre-wrap/);
  });
});

describe("the Markdown heading scale is legible at sidebar width (D3 round 2)", () => {
  /** The declared `font-size`, in `em`, for `h<level>.lm-md__h`. */
  const headingEm = (level: number): number => {
    const rule = new RegExp(
      `h${level}\\.lm-md__h[^{]*\\{[^}]*font-size:\\s*([\\d.]+)em`,
    ).exec(css);
    return rule === null ? Number.NaN : Number(rule[1]);
  };

  it("declares a size for every level h1–h4", () => {
    for (const level of [1, 2, 3, 4]) {
      expect(headingEm(level), `h${level}`).not.toBeNaN();
    }
  });

  it("separates each consecutive level by at least 1.12x", () => {
    // The threshold is the operator's own measurement at the 2026-08-15 gate
    // round, not a guess. Against a 12px bubble they could distinguish 1.125x
    // (round 1's h1:h2) and could NOT distinguish 1.111x (h2:h3) or 1.080x
    // (h3:h4) — so 1.12 is the line the evidence draws. The shipped ladder is a
    // geometric 1.15x, which clears it at every step.
    for (const level of [1, 2, 3]) {
      const ratio = headingEm(level) / headingEm(level + 1);
      expect(ratio, `h${level}:h${level + 1}`).toBeGreaterThanOrEqual(1.12);
    }
  });

  it("makes h4 larger than body text rather than equal to it", () => {
    // Round 1's h4 was exactly 1em, so an h4 was a bold paragraph.
    expect(headingEm(4)).toBeGreaterThanOrEqual(1.12);
  });

  it("keeps h5 and h6 at body size and dim, which is what makes them last", () => {
    // Below h4 there is no room left above 12px body text, so they stop being a
    // size and become a colour.
    const rule =
      /h5\.lm-md__h,\s*h6\.lm-md__h\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/font-size:\s*1em/);
    expect(rule).toMatch(/color:\s*var\(--lm-fg-dim\)/);
  });
});

describe("a streaming code block grows, a settled one is clamped (ADR 0040)", () => {
  it("lifts the height clamp while the fence is open, by specificity", () => {
    // A stylesheet claim, which is the one thing ADR 0037 §4 keeps a
    // source-level assertion for. The compound selector is load-bearing: both
    // are one class, so a bare `.lm-md__pre--open` would win only by source
    // order and a reorder would silently re-clamp a streaming block.
    expect(css).toMatch(
      /\.lm-md__pre\.lm-md__pre--open\s*\{[^}]*max-height:\s*none/,
    );
  });

  it("still clamps a settled code block at 240px", () => {
    // Judge 3 confirmed the constant at the 2026-08-15 gate round ("the height
    // looks fine"); it is not re-opened, only scoped to the settled case.
    expect(css).toMatch(/\.lm-md__pre\s*\{[^}]*max-height:\s*240px/);
  });
});

describe("a table scrolls rather than widening the bubble (X4, ADR 0044)", () => {
  it("gives the table a scroll container of its own", () => {
    // The wrapper, not the table: without a container that can scroll, a
    // four-column comparison widens the bubble and takes the whole transcript
    // sideways with it. `.lm-md__pre` is the same stylesheet's existing answer
    // to the same problem for the other block that can be arbitrarily wide.
    const rule = /\.lm-md__tablewrap\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/overflow-x:\s*auto/);
  });

  it("does not stretch the table across the panel", () => {
    // A two-column table at `width: 100%` puts a hand's width of empty space
    // between a label and its value. Asserted as an absence, because the
    // obvious "improvement" is to add it.
    const rule = /\.lm-md__table\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/border-collapse:\s*collapse/);
    expect(rule).not.toMatch(/width:/);
  });

  it("wins the alignment declaration by specificity, not by source order", () => {
    // The trap this file documents three times over. `.lm-md__cell` sets
    // `text-align: left`, so a bare `.lm-md__cell--right` is (0,1,0) against
    // (0,1,0) and wins only because it comes later — reordering the stylesheet
    // would silently drop every author's alignment with this suite still green.
    // Scoped through `.lm-md__table` it is (0,2,0) and wins outright.
    for (const align of ["left", "center", "right"]) {
      expect(css).toMatch(
        new RegExp(
          `\\.lm-md__table\\s+\\.lm-md__cell--${align}\\s*\\{[^}]*text-align:\\s*${align}`,
        ),
      );
    }
  });

  it("marks a quote with a rule rather than a fourth background", () => {
    // The transcript already stacks tinted bubbles; another ground in the stack
    // stops reading as emphasis.
    const rule = /\.lm-md__quote\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/border-left:/);
    expect(rule).not.toMatch(/background:/);
  });
});

describe("the code block's Copy affordance (ADR 0040)", () => {
  it("gives the button something to be positioned against", () => {
    expect(css).toMatch(/\.lm-md__codeblock\s*\{[^}]*position:\s*relative/);
  });

  it("pins it to the top-right corner, out of sight until wanted", () => {
    const rule = /\.lm-md__copy\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*4px/);
    expect(rule).toMatch(/right:\s*4px/);
    expect(rule).toMatch(/opacity:\s*0/);
  });

  it("reveals it by hovering the BLOCK, and on keyboard focus", () => {
    // A control you must already be hovering to see is not discoverable; and one
    // that appears only on hover is unreachable by keyboard without the second
    // selector, since it stays in the tab order at opacity 0.
    expect(css).toMatch(
      /\.lm-md__codeblock:hover\s+\.lm-md__copy[^{]*\{[^}]*opacity:\s*1/,
    );
    expect(css).toMatch(/\.lm-md__copy:focus-visible/);
  });

  it("shows the press feedback at the reveal rule's own specificity", () => {
    // A bare `.lm-md__copy:active` is (0,2,0) and the reveal rule
    // `.lm-md__codeblock:hover .lm-md__copy` is (0,3,0), so the press feedback
    // never appeared for a pointer user — and revealing the button requires
    // hovering the block. Scoping it through the wrapper ties the specificity and
    // wins on source order. The file's own precedent for pinning this is
    // `.lm-msg.lm-md` and `.lm-md__pre.lm-md__pre--open`, both above.
    expect(css).toMatch(
      /\.lm-md__codeblock\s+\.lm-md__copy:active\s*\{[^}]*opacity:\s*0\.7/,
    );
  });

  it("keeps the confirmation visible over the hover state, by specificity", () => {
    // Compound, not a bare `.lm-md__copy--done`: two classes tie
    // `.lm-md__copy:hover` and win on order, where one class loses outright — and
    // hover is the state the user is in at the moment they press it.
    expect(css).toMatch(
      /\.lm-md__copy\.lm-md__copy--done\s*\{[^}]*opacity:\s*1/,
    );
  });

  it("sizes the icon so the button is a 24px target", () => {
    // 14px icon + 2x4px padding + 2x1px border, the reference's arithmetic.
    expect(css).toMatch(/\.lm-md__copy svg\s*\{[^}]*width:\s*14px/);
  });
});

describe("the composer command menu's stylesheet (E2, ADR 0049)", () => {
  /** The body of one rule, braces balanced. */
  function rule(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) return "";
    return css.slice(start, css.indexOf("}", start) + 1);
  }

  it("makes the composer the menu's positioning ancestor", () => {
    // Without this the menu anchors to the viewport and drifts whenever the
    // grants row or the steering row appears above the input. Two rules, one
    // fact — so a source reorder that dropped `position: relative` from
    // `.lm-composer` would fail here rather than at the operator's round.
    expect(rule(".lm-composer")).toMatch(/position:\s*relative/);
    expect(rule(".lm-menu")).toMatch(/position:\s*absolute/);
    expect(rule(".lm-menu")).toMatch(/bottom:\s*100%/);
  });

  it("layers the menu above the transcript's own positioned affordances", () => {
    // The panel's first stacking context. The ⟲ restore control and the
    // code-block Copy button are `position: absolute` and unlayered, so
    // without a z-index the menu would paint UNDER whichever of them the
    // transcript happened to render last.
    expect(rule(".lm-menu")).toMatch(/z-index:\s*\d+/);
  });

  it("anchors the rewind popover to the bubble it was opened from (E6)", () => {
    // Same two-rules-one-fact shape as the composer pair above: the popover is
    // mounted into `.lm-msg-user`, so a source edit that dropped that bubble's
    // `position: relative` would silently re-anchor the menu to the viewport
    // and leave it hanging over an unrelated message.
    expect(rule(".lm-msg-user")).toMatch(/position:\s*relative/);
    expect(rule(".lm-rewind")).toMatch(/position:\s*absolute/);
    // Hung UNDER the control rather than in flow: opening it reserves no
    // layout, so the transcript the reader is in the middle of does not move.
    expect(rule(".lm-rewind")).toMatch(/top:\s*100%/);
  });

  it("has exactly two layers, and the rewind popover is the upper one (E6)", () => {
    // E2 could say "first and ONLY": before it the word `z-index` did not
    // appear in this file at all, and the assertion that it appeared once was
    // how the panel's stacking stayed a decision rather than an accident.
    //
    // E6 (D8) adds the second and last: the ⟲ popover is an overlay too. The
    // count claim is kept — a THIRD layer still fails here — and it is now
    // also an ORDER claim, which the count alone never was. The popover wins
    // because it was opened by a deliberate click on the message it hangs
    // from, where the completion menu merely follows the caret.
    // Counted on the WORD, exactly as E2's sweep did (E6 code review): a
    // third layer declared as `z-index: var(--x)` or `auto` would slip a
    // numeric-only count, and the point of the count is that a new layer
    // cannot arrive unnoticed however it is spelled.
    const layers = css.match(/z-index:/g) ?? [];
    expect(layers).toHaveLength(2);
    const depth = (selector: string): number =>
      Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1]);
    expect(depth(".lm-rewind")).toBeGreaterThan(depth(".lm-menu"));
  });

  it("bounds the BOX, and scrolls rather than clipping if it is ever too short", () => {
    // Named carefully (E2 code review): `visibleRows()` caps the DOM at
    // MAX_ROWS, so this `overflow-y` is a SAFETY NET, not the scroll mechanism
    // — in normal operation eight rows and their headers fit and it never
    // engages. What it buys is that a `max-height` reached by any route hides
    // nothing behind the edge, which is the defect X4 fixed for a wide table.
    const body = rule(".lm-menu");
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it("lets the description truncate and never the name", () => {
    // The name is the string the row inserts; a user cannot pick what they
    // cannot read in full. The description is context and yields first.
    expect(rule(".lm-menu__name")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".lm-menu__desc")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("makes a PATH row the one exception, and only inside a path row", () => {
    // E3 (D5). A path is long by nature and carries no description competing
    // for the width, so it takes the row and ellipsizes. The base rule above
    // still stands for slug rows — a `/skill:` name IS the string it inserts,
    // and truncating that would show a lie. Two rules, one trade, so a source
    // edit that generalised the override would fail here.
    const override = rule(".lm-menu__row--path .lm-menu__name");
    expect(override).toMatch(/text-overflow:\s*ellipsis/);
    expect(override).toMatch(/min-width:\s*0/);
    // It must NOT relax `white-space`. Inheriting `nowrap` is what keeps the
    // path on one line: a wrapped path would make a row two lines tall and
    // blow the box `max-height` sized for eight of them.
    expect(override).not.toMatch(/white-space:/);
  });

  it("gives the note a footer's shape, not a row's", () => {
    // B4/A6's counted-never-dropped line. It sits under the rows behind a
    // divider and is visibly not selectable, which is the whole point: it says
    // what the list is missing, and a user must not try to pick it.
    const note = rule(".lm-menu__note");
    expect(note).toMatch(/border-top:/);
    expect(note).toMatch(/color:\s*var\(--lm-fg-faint\)/);
    expect(note).not.toMatch(/cursor:\s*pointer/);
  });
});

/**
 * The Review tab's own rules (ADR 0062). Same argument as the block above:
 * jsdom performs no layout, so whether the tab READS well is an *eyes* item —
 * but that the mechanism exists and is aimed at the right selectors is data,
 * and every rule here is one the operator's round asked for by name.
 */
describe("the Review tab's card and chip rules (ADR 0062)", () => {
  function rule(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) return "";
    return css.slice(start, css.indexOf("}", start) + 1);
  }

  it("never spins the chip itself — only the mark inside it", () => {
    // §4. The operator saw three seat chips rotating bodily, text and border
    // together. `.lm-review-chip` must carry no animation of its own, and the
    // spinner must be a child with a fixed box so the chip does not resize
    // when the seat lands.
    expect(rule(".lm-review-chip")).not.toMatch(/animation/);
    expect(rule(".lm-review-chip")).toMatch(/display:\s*inline-flex/);
    const mark = css.slice(
      css.indexOf(".lm-review-chip__spin,"),
      css.indexOf("}", css.indexOf(".lm-review-chip__spin,")) + 1,
    );
    expect(mark).toMatch(/width:\s*9px/);
  });

  it("outlines a concern as a card, and ONLY in the Review tab", () => {
    // §5. `.lm-cite-row` is shared with Citations and Compile; an unscoped
    // rule would have outlined every list in the product.
    expect(rule(".lm-review-tab .lm-cite-row")).toMatch(/border:\s*1px solid/);
    expect(rule(".lm-cite-row")).not.toMatch(/border:\s*1px solid/);
  });

  it("enlarges the group headings, scoped the same way", () => {
    // §4. `.lm-review-fold__summary` is the Compile tab's heading too, so the
    // larger size hangs off the group modifier under the tab's own class.
    const group = rule(
      ".lm-review-tab .lm-review-fold--group > .lm-review-fold__summary",
    );
    expect(group).toMatch(/font-size:\s*11\.5px/);
    // The shared base is unchanged — the Compile tab's folds keep their size.
    expect(rule(".lm-review-fold__summary")).toMatch(/font-size:\s*10px/);
  });

  it("flashes a jumped-to concern with an animation, not a timer", () => {
    // §7. A CSS animation ends by itself; a `setTimeout` in the renderer would
    // outlive the render that started it.
    expect(css).toMatch(/@keyframes lm-review-flash/);
    expect(rule(".lm-review-tab .lm-cite-row.is-target")).toMatch(
      /animation:\s*lm-review-flash/,
    );
    // And the global reduced-motion rule turns it off with everything else.
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("the Review tab's id line is its own line (X6 O11, ADR 0075 §6)", () => {
  /** A rule's body, by its exact selector — the whole selector, so a longer
   *  selector that merely ends the same way is not mistaken for it. */
  function exact(selector: string): string {
    const escaped = selector.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? "";
  }

  it("makes the detail a block, scoped to the Review tab", () => {
    // Two inline spans flowed the id line on from the message's last word:
    // `…robustness.reviewer_b-1 · major · …`.
    expect(exact(".lm-review-tab .lm-cite-row__detail")).toMatch(
      /display:\s*block/,
    );
  });

  it("leaves the shared rule inline, so Citations and Compile are unchanged", () => {
    const shared = exact(".lm-cite-row__detail");
    expect(shared).not.toBe("");
    expect(shared).not.toMatch(/display:/);
  });
});

describe("the Review tab reads in every theme and at a narrow width (X6 review round)", () => {
  /** A rule's body, by its exact selector (the O11 helper's shape). */
  function exact(selector: string): string {
    const escaped = selector.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? "";
  }
  const color = (selector: string): string | undefined =>
    exact(selector)
      .match(/(?:^|;|\s)color:\s*([^;]+);/)?.[1]
      ?.trim();

  // `--lm-fg-faint` is `--vscode-disabledForeground`, a token for DISABLED
  // UI. The round measured it at ~2.2 : 1 in Light Modern and in VS Code's
  // default Dark 2026, on text the reader has to read.
  it("draws the mark, the evidence line, the chips and the provider's words dim", () => {
    for (const selector of [
      ".lm-review-note__mark",
      ".lm-cite-row__evidence",
      ".lm-review-chip",
      ".lm-review-cause__theirs",
    ])
      expect(color(selector), selector).toBe("var(--lm-fg-dim)");
  });

  it("gives the pending count and the panel line one register, scoped to the tab", () => {
    // The panel line was dim under a faint count, so the qualifier outweighed
    // the figure it sits beneath.
    expect(color(".lm-review-tab .lm-cite-sub")).toBe("var(--lm-fg-dim)");
    expect(color(".lm-review-panelline")).toBe(
      color(".lm-review-tab .lm-cite-sub"),
    );
  });

  it("leaves the shared sub-line alone, so Citations and Compile are unchanged", () => {
    expect(color(".lm-cite-sub")).toBe("var(--lm-fg-faint)");
  });

  it("keeps a model id whole and in its own case, and a count with its unit", () => {
    // An inline-block moves to the next line whole instead of breaking at a
    // hyphen, and still wraps inside itself when it is wider than the whole
    // line, so a long id cannot push the panel sideways — which `nowrap`
    // would. The fold heading around it is uppercase; an id is case-sensitive.
    expect(exact(".lm-review-model")).toMatch(/display:\s*inline-block/);
    expect(exact(".lm-review-model")).toMatch(/text-transform:\s*none/);
    expect(exact(".lm-review-count")).toMatch(/display:\s*inline-block/);
    expect(exact(".lm-review-model")).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe("V1's lines read like the evidence line they sit under (ADR 0076 §9)", () => {
  /** A rule's body, by its exact selector (the O11 helper's shape). */
  function exact(selector: string): string {
    const escaped = selector.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? "";
  }
  const color = (selector: string): string | undefined =>
    exact(selector)
      .match(/(?:^|;|\s)color:\s*([^;]+);/)?.[1]
      ?.trim();

  it("draws the counter line, its note and the verifier's label dim — no new colour token", () => {
    for (const selector of [
      ".lm-review-counter",
      ".lm-review-counter__note",
      ".lm-mcard__sublabel",
    ])
      expect(color(selector), selector).toBe("var(--lm-fg-dim)");
  });

  it("makes the counter an unstyled text button that wraps rather than widens", () => {
    const rule = exact(".lm-review-counter");
    expect(rule).toMatch(/background:\s*(none|transparent)/);
    expect(rule).toMatch(/border:\s*(none|0)/);
    expect(rule).toMatch(/font:\s*inherit/);
    expect(rule).toMatch(/cursor:\s*pointer/);
    expect(rule).toMatch(/word-break:\s*break-word|overflow-wrap:\s*anywhere/);
  });

  it("falls to currentColor in high contrast", () => {
    expect(color("body.vscode-high-contrast-light .lm-review-counter")).toBe(
      "currentColor",
    );
    expect(css).toMatch(
      /body\.vscode-high-contrast \.lm-review-counter,\s*\nbody\.vscode-high-contrast-light \.lm-review-counter\s*\{/,
    );
  });

  /**
   * V1's J1 round (2026-09-19), item 5. At rest the counter line WAS the
   * evidence line's twin — same size, weight, colour and indentation, with no
   * underline, no icon and no button chrome, the underline arriving only on
   * hover — and E1's own example finding came back word for word: *"Nothing
   * says it opens anything, and I only found out by clicking."* It stays dim
   * and stays quiet; it stops being a twin.
   */
  it("says it opens something before anyone hovers it", () => {
    expect(exact(".lm-review-counter")).toMatch(/text-decoration:\s*underline/);
    expect(exact(".lm-review-counter::before")).toMatch(/content:/);
  });

  it("still answers the hover, and the evidence line carries neither mark", () => {
    expect(exact(".lm-review-counter:hover")).toMatch(/text-decoration:/);
    expect(exact(".lm-cite-row__evidence")).not.toMatch(/text-decoration:/);
    expect(exact(".lm-cite-row__evidence::before")).toBe("");
  });

  /**
   * V2 (O22, ADR 0078 D12): a paper's title takes the counter line's
   * affordance, for the counter line's reason -- it opens something, so it
   * says so before anyone hovers it (ADR 0077 4).
   */
  it("gives an openable paper title the same resting affordance", () => {
    expect(color("a.lm-review-paper")).toBe("var(--lm-fg-dim)");
    expect(exact("a.lm-review-paper")).toMatch(
      /text-decoration:\s*underline dotted/,
    );
    expect(exact("a.lm-review-paper::before")).toMatch(/content:/);
    expect(exact("a.lm-review-paper:hover")).toMatch(/text-decoration:/);
    expect(color("body.vscode-high-contrast-light a.lm-review-paper")).toBe(
      "currentColor",
    );
  });

  it("gives a paper with NO href no affordance at all", () => {
    // The selector is `a.lm-review-paper`, never the bare class: a plain
    // `span` carrying the same class must promise nothing, because there is
    // nothing to open. A rule written on `.lm-review-paper` would underline
    // the span too and invent an affordance the row cannot honour.
    expect(css).not.toMatch(/(?:^|[^a-z.])\.lm-review-paper\s*\{/m);
  });
});

/**
 * V3's E1 round (2026-09-22). `.lm-mrow__setkey` and `.m-image-input-row` ask
 * for a line of their own with `flex-basis: 100%`, which only starts a new
 * line in a container that WRAPS. `.lm-mrow` did not, so both were squeezed
 * into the row's single line and `.lm-mrow__body` — the provider name and the
 * model id — got 0px at every width. The real-webview half of this claim is
 * `test/webview-models.test.ts`; this is the cheap half, and the one that runs
 * on save.
 */
describe("a model row wraps, so its full-width lines get lines of their own (V3 E1 round)", () => {
  /** A rule's body, by its exact selector (the O11 helper's shape), so
   *  `.lm-mrow__body { … }` cannot answer for `.lm-mrow { … }`. */
  function exact(selector: string): string {
    const escaped = selector.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? "";
  }

  it("lets the model row wrap", () => {
    expect(exact(".lm-mrow")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("sends the key controls and the Image input line to full width", () => {
    // The two rules that depend on the wrap above. Asserted together, because
    // either one without the other is the defect this block exists for.
    expect(exact(".lm-mrow__setkey")).toMatch(/flex-basis:\s*100%/);
    expect(exact(".m-image-input-row")).toMatch(/flex-basis:\s*100%/);
  });

  it("keeps the Set key button and the Image input label whole", () => {
    // CJK text breaks between any two characters, so a squeezed `设置密钥` or
    // `图像输入` stacks one character per line. Scoped through the row: the
    // add-model form's Save button shares `.lm-mform__save`.
    expect(exact(".lm-mrow__setkey .lm-mform__save")).toMatch(/flex:\s*none/);
    expect(exact(".lm-mform__save")).not.toMatch(/flex:\s*none/);
    expect(exact(".m-image-input-label")).toMatch(/white-space:\s*nowrap/);
  });
});

/**
 * J1's round (V4, E1's Judge question 1): at a ~290 px side bar several facts
 * wrapped, and a continuation line flush with the next fact read as a fact of
 * its own — `vertical` alone on a line, the author line as three. A hanging
 * indent keeps each fact one visual unit, however it wraps.
 */
describe("a fact's wrapped lines hang under it (V4 J1 round)", () => {
  /** A rule's body, by its exact selector — the V3 round's helper's shape. */
  function exact(selector: string): string {
    const escaped = selector.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`);
    return css.match(re)?.[2] ?? "";
  }

  it("indents a fact's continuation lines, and not its first", () => {
    const line = exact(".lm-review-pdffacts__line");
    expect(line).toMatch(/padding-left:\s*1em/);
    expect(line).toMatch(/text-indent:\s*-1em/);
    // The title is a heading, not a fact: it keeps its own margin.
    expect(exact(".lm-review-pdffacts__title")).not.toMatch(/text-indent/);
  });
});

describe("V6's scorecard block: classes only, tokens by level, currentColor in high contrast (O22, O23, ADR 0088 §5)", () => {
  /** Every rule, as its selector list and body — comments stripped, rules
   *  inside `@media` / `@container` included — so a grouped selector
   *  (`a, b { … }`) answers for each of its members. */
  const RULES = [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((m) => ({
    selectors: (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " ")),
    body: m[2] ?? "",
  }));
  /** The value a selector's rules give a property, the last one winning. */
  const prop = (selector: string, name: string): string | undefined => {
    let value: string | undefined;
    for (const rule of RULES) {
      if (!rule.selectors.includes(selector)) continue;
      const found = new RegExp(String.raw`(?:^|;|\s)${name}:\s*([^;]+);`).exec(
        rule.body,
      );
      if (found) value = found[1]?.trim();
    }
    return value;
  };
  const HC = ["body.vscode-high-contrast", "body.vscode-high-contrast-light"];

  it("draws every line a reader reads in the dim token, never the disabled one", () => {
    for (const selector of [
      ".lm-sc-row__counts",
      ".lm-sc-row__reason",
      ".lm-sc-row__seats",
      ".lm-sc-row__impression",
      ".lm-sc-legend",
      ".lm-sc-compare",
      ".lm-sc-caveat",
      ".lm-sc-mark",
    ])
      expect(prop(selector, "color"), selector).toBe("var(--lm-fg-dim)");
    const faint = RULES.filter(
      (r) =>
        r.selectors.some((s) => s.includes("lm-sc-")) &&
        r.body.includes("--lm-fg-faint"),
    );
    expect(faint.map((r) => r.selectors.join(", "))).toEqual([]);
  });

  it("sets the impression line smaller, and the readiness word in the foreground", () => {
    expect(prop(".lm-sc-row__impression", "font-size")).toBe("0.9em");
    expect(prop(".lm-sc-readiness__word", "color")).toBe("var(--lm-fg)");
  });

  it("fills a level's steps with the colour the concern glyphs use for it", () => {
    expect(prop(".lm-sc-track--l1 .lm-sc-step--on", "background")).toBe(
      "var(--lm-red)",
    );
    expect(prop(".lm-sc-track--l2 .lm-sc-step--on", "background")).toBe(
      "var(--lm-red)",
    );
    expect(prop(".lm-sc-track--l3 .lm-sc-step--on", "background")).toBe(
      "var(--lm-amber)",
    );
    expect(prop(".lm-sc-track--l4 .lm-sc-step--on", "background")).toBe(
      "var(--lm-green)",
    );
    expect(prop(".lm-sc-step--off", "background")).toBe("transparent");
    expect(prop(".lm-sc-step--na", "background")).toMatch(
      /^repeating-linear-gradient\(/,
    );
    // Empty and hatched steps are graphical objects: outlined in the dim
    // token, not the panel-divider one (WCAG 1.4.11's 3 : 1).
    expect(prop(".lm-sc-step", "border")).toBe("1px solid var(--lm-fg-dim)");
    // No image anywhere in the block's rules: the CSP has no img-src.
    const images = RULES.filter(
      (r) =>
        r.selectors.some((s) => s.includes("lm-sc-")) && /url\(/.test(r.body),
    );
    expect(images).toEqual([]);
  });

  it("collapses the track, the hatch and the delta to currentColor under both high-contrast classes", () => {
    for (const body of HC) {
      expect(prop(`${body} .lm-sc-step--on`, "background"), body).toBe(
        "currentColor",
      );
      expect(prop(`${body} .lm-sc-step`, "border-color"), body).toBe(
        "currentColor",
      );
      expect(prop(`${body} .lm-sc-step--na`, "background"), body).toMatch(
        /repeating-linear-gradient\([^)]*currentColor/,
      );
      expect(prop(`${body} .lm-sc-row__delta`, "color"), body).toBe(
        "currentColor",
      );
    }
  });

  it("sets the delta glyph in its level's flow, not pushed to the row's far edge, and large enough to read (E1's round)", () => {
    // `margin-left: auto` sent the glyph to the right edge — a separate
    // column at a real width, a lone `=` on its own line at ~280 px.
    expect(prop(".lm-sc-row__delta", "margin-left")).toBeUndefined();
    expect(prop(".lm-sc-row__delta", "margin")).toBeUndefined();
    // At 10 px an `=` was a speck beside 11 px words.
    expect(prop(".lm-sc-row__delta", "font-size")).toBe("12px");
    // The word `new` is a word, read at the size of the words around it.
    expect(prop(".lm-sc-delta--new", "font-size")).toBe("inherit");
  });

  it("resets the row like the tab's other buttons, and marks the pressed one", () => {
    expect(prop(".lm-sc-row", "font")).toBe("inherit");
    expect(prop(".lm-sc-row", "border")).toBe("0");
    expect(prop(".lm-sc-row", "background")).toBe("none");
    expect(prop(".lm-sc-row", "text-align")).toBe("left");
    // A wrapping flow, with a forced break between the head and the dim lines
    // (the V6 Chromium check: a grid crushed the level word at sidebar width).
    expect(prop(".lm-sc-row", "display")).toBe("flex");
    expect(prop(".lm-sc-row", "flex-wrap")).toBe("wrap");
    expect(prop(".lm-sc-row::after", "flex-basis")).toBe("100%");
    // Only the control looks like one: a row with nothing to narrow is text.
    expect(prop("button.lm-sc-row", "cursor")).toBe("pointer");
    expect(prop(".lm-sc-row", "cursor")).toBeUndefined();
    expect(prop('.lm-sc-row[aria-pressed="true"]', "border-left")).toMatch(
      /var\(--lm-accent\)/,
    );
  });

  it("gives an info concern's title and the other-entry line the dim token, and leaves the disabled one as it was (O23)", () => {
    expect(prop(".is-dim", "color")).toBe("var(--lm-fg-dim)");
    expect(prop(".is-faint", "color")).toBe("var(--lm-fg-faint)");
    // The other-entry line takes the entry row's own colour, which is dim.
    expect(prop(".lm-review-entry", "color")).toBe("var(--lm-fg-dim)");
  });
});
