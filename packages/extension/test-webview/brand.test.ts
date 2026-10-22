import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BRAND_GRADIENTS,
  BRAND_VIEW_BOX,
  BUSY_MARK_SIZE,
  GLYPH_SEPARATION,
  HEADER_GLYPH_SIZE,
  PEBBLE_BOTTOM,
  PEBBLE_MIDDLE,
  PEBBLE_TOP,
  brandGlyph,
  brandMark,
  busyRow,
  popMark,
  welcomePanel,
  workingRing,
} from "../src/webview/parts/brand";

/**
 * P1 rows O3–O6.
 *
 * The interesting assertion here is O3, and it is the reason this file reads a
 * file off disk. The marks are **built as DOM nodes** (P1 / D1) because the
 * webview's CSP is `default-src 'none'` with no `img-src` and
 * `check-webview-innerhtml.mjs` is deny-by-default over this tree — so the
 * artwork's path data had to be *transcribed* out of the design pack's SVGs
 * into TypeScript constants. A transcription is exactly the kind of thing that
 * is wrong by one character and looks plausible, and a wrong logo is not
 * something any other test in this repo would notice.
 *
 * So the constants are pinned against the pack itself. If the operator reissues
 * the pack with corrected geometry, this test is what turns the update into a
 * one-line diff instead of a discovery.
 */

const PACK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "Lemmaria-design-doc",
  "lemmaria-motion-pack",
);

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

describe("the brand geometry is the pack's, not a redraw (O3)", () => {
  // The design bundle is a PRIVATE submodule, so a clone that did not fetch it
  // cannot run this check. Skipping loudly beats failing a legitimate checkout
  // — and in the build's own tree the submodule is always present, which is
  // where the pin has to hold.
  const packPresent = existsSync(PACK);

  it.skipIf(!packPresent)(
    "the three pebble paths match the pack's mono mark byte-for-byte",
    () => {
      const mono = readFileSync(
        join(PACK, "vscode", "activity-bar.svg"),
        "utf8",
      );
      const shapes: Record<string, string> = {};
      for (const m of mono.matchAll(
        /id="[^"]*shape-(bottom|middle|top)"\s+d="([^"]+)"/g,
      ))
        shapes[m[1] as string] = m[2] as string;

      expect(Object.keys(shapes).sort()).toEqual(["bottom", "middle", "top"]);
      expect(PEBBLE_BOTTOM).toBe(shapes.bottom);
      expect(PEBBLE_MIDDLE).toBe(shapes.middle);
      expect(PEBBLE_TOP).toBe(shapes.top);
    },
  );

  it.skipIf(!packPresent)("the viewBox matches the pack's", () => {
    const mono = readFileSync(join(PACK, "vscode", "activity-bar.svg"), "utf8");
    const viewBox = /viewBox="([^"]+)"/.exec(mono)?.[1];
    expect(BRAND_VIEW_BOX).toBe(viewBox);
  });

  it.skipIf(!packPresent)(
    "every gradient's coordinates match the pack's static mark",
    () => {
      const svg = readFileSync(
        join(PACK, "animations", "static", "lemmaria-current-dark.svg"),
        "utf8",
      );
      const packed = new Map<string, string>();
      for (const m of svg.matchAll(
        /id="lemmaria-dark-g-([a-z-]+)"[^>]*x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"/g,
      ))
        packed.set(
          m[1] as string,
          `${m[2]} ${m[3]} ${m[4]} ${m[5]}`.replaceAll('"', ""),
        );

      expect([...packed.keys()].sort()).toEqual([
        "bottom",
        "middle",
        "overlap-lower",
        "overlap-upper",
        "top",
      ]);
      for (const g of BRAND_GRADIENTS)
        expect(`${g.id}: ${g.x1} ${g.y1} ${g.x2} ${g.y2}`).toBe(
          `${g.id}: ${packed.get(g.id)}`,
        );
    },
  );
});

describe("the working ring (O4)", () => {
  it("is an SVG built as nodes, with the animated arc classed", () => {
    const ring = workingRing();
    expect(ring.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(ring.tagName.toLowerCase()).toBe("svg");
    // Two circles: the faint track and the arc that turns.
    const circles = ring.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    const arc = ring.querySelector(".lm-brand-ring__arc");
    expect(arc).not.toBeNull();
    // `currentColor` is what makes it follow the transcript's dim foreground
    // rather than pinning a brand purple onto every theme.
    expect(arc?.getAttribute("stroke")).toBe("currentColor");
  });

  it("is hidden from assistive technology — the row's text is the status", () => {
    // Invariant 6 / D4: the label is `t("sessionThinking")` and is announced
    // once. A ring with its own aria-label would announce the same fact twice,
    // in a language the pack hardcoded in English.
    expect(workingRing().getAttribute("aria-hidden")).toBe("true");
    expect(workingRing().getAttribute("aria-label")).toBeNull();
  });

  it("carries no inline style — the CSP has no 'unsafe-inline' (D1)", () => {
    const ring = workingRing();
    expect(ring.querySelector("style")).toBeNull();
    expect(ring.getAttribute("style")).toBeNull();
    expect(ring.outerHTML).not.toContain("<style");
  });

  it("has its animation in styles.css, at the pack's timing", () => {
    // In the stylesheet and NOT in an in-SVG <style> element, which the CSP
    // would drop — leaving a graphic that is silently static and looks correct
    // in this very test file. Hence asserting the stylesheet.
    expect(css).toContain("@keyframes lm-brand-ring-spin");
    expect(css).toMatch(/\.lm-brand-ring__arc[^{]*\{[^}]*animation:/);
    // The pack's own timing, kept: a 1.2s ring for tight UI rows.
    expect(css).toMatch(/lm-brand-ring-spin\s+1200ms/);
  });

  it("is covered by the stylesheet's single reduced-motion rule", () => {
    // The ring adds no reduced-motion rule of its own, on purpose: the
    // stylesheet already carries one global `* { animation: none !important }`
    // block, so a second rule would be a duplicate with two places to change.
    // What this asserts is that the coverage is real — the global rule exists,
    // and the ring's motion is an `animation` (not a `transition` or a JS
    // timer), which is what that rule switches off.
    const block =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\{[^}]*\}/.exec(
        css,
      )?.[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/\*\s*\{/);
    expect(block).toMatch(/animation:\s*none\s*!important/);
    expect(css).toMatch(/\.lm-brand-ring__arc[^{]*\{[^}]*animation:/);
    expect(workingRing().querySelector(".lm-brand-ring__arc")).not.toBeNull();
  });
});

describe("the brand mark (O3, O4)", () => {
  it("reproduces the pack's paint order: middle, then bottom, then top", () => {
    const mark = brandMark(64);
    // `mark.children`, not a `svg > *` selector: `querySelectorAll` matches
    // only DESCENDANTS, so a selector rooted at `svg` needs a second `<svg>`
    // inside the subtree and silently returns nothing here.
    const painted = [...mark.children].filter(
      (n) => !["defs", "title"].includes(n.tagName.toLowerCase()),
    );
    // <path> middle, <g clip=bottom>, <g clip=top> — in that order. The two
    // groups each hold a full-bleed rect plus the middle path repainted in the
    // overlap gradient, which is how the pack renders the intersections.
    expect(painted.map((n) => n.tagName.toLowerCase())).toEqual([
      "path",
      "g",
      "g",
    ]);
    expect(painted[0]?.getAttribute("d")).toBe(PEBBLE_MIDDLE);
    for (const group of [painted[1], painted[2]]) {
      expect(group?.querySelector("rect")).not.toBeNull();
      expect(group?.querySelector("path")?.getAttribute("d")).toBe(
        PEBBLE_MIDDLE,
      );
    }
  });

  it("clips the two groups to the bottom and top silhouettes", () => {
    const mark = brandMark(64);
    const clips = [...mark.querySelectorAll("clipPath")];
    expect(clips).toHaveLength(2);
    expect(clips[0]?.querySelector("path")?.getAttribute("d")).toBe(
      PEBBLE_BOTTOM,
    );
    expect(clips[1]?.querySelector("path")?.getAttribute("d")).toBe(PEBBLE_TOP);
  });

  it("gives every instance its own ids, so two marks cannot cross-reference", () => {
    // A `url(#id)` reference resolves document-wide. Two marks sharing ids
    // means the second one's gradients silently repaint the first.
    const a = brandMark(64);
    const b = brandMark(64);
    const ids = (n: SVGElement) =>
      [...n.querySelectorAll("[id]")].map((e) => e.id);
    const idsA = ids(a);
    const idsB = ids(b);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA).not.toEqual(idsB);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    // And every reference inside an instance resolves within that instance.
    for (const el of a.querySelectorAll("[fill],[clip-path]")) {
      for (const attr of ["fill", "clip-path"]) {
        const ref = /url\(#([^)]+)\)/.exec(el.getAttribute(attr) ?? "")?.[1];
        if (ref) expect(idsA).toContain(ref);
      }
    }
  });

  it("is decorative — the panel's own text carries the meaning", () => {
    expect(brandMark(64).getAttribute("aria-hidden")).toBe("true");
  });

  it("takes its stop colours from CSS custom properties, per theme", () => {
    // Not a hardcoded palette: the same nodes render the light, dark and
    // high-contrast marks, because `stop-color` is a CSS property and the
    // theme blocks in styles.css redefine the tokens.
    const mark = brandMark(64);
    const stops = [...mark.querySelectorAll("stop")];
    expect(stops.length).toBe(BRAND_GRADIENTS.length * 2);
    for (const stop of stops) {
      expect(stop.getAttribute("stop-color")).toBeNull();
      expect(stop.getAttribute("class")).toMatch(/^lm-brand-stop /);
    }
    expect(css).toContain("--lm-brand-bottom-0");
    expect(css).toMatch(/\.lm-brand-stop\b/);
  });
});

describe("the busy row (O5)", () => {
  it("keeps the row's class and its localized label as the only text", () => {
    const row = busyRow("Thinking…");
    expect(row.className).toBe("lm-msg lm-msg-busy");
    // The graphic contributes no text node, so the row still reads as exactly
    // the string the caller passed — which is `t("sessionThinking")`.
    expect(row.textContent).toBe("Thinking…");
  });

  it("puts the pop mark beside the label, not instead of it", () => {
    const row = busyRow("思考中……");
    expect(row.querySelector(".lm-brand-pop")).not.toBeNull();
    expect(row.textContent).toBe("思考中……");
  });

  it("shows pop at the pack's floor size for the variant, not below it", () => {
    // The pack specifies 32–128 for `pop` against 16–32 for `compact`. Below
    // the floor the pebbles stop separating as they stack and the sequence
    // reads as one pulsing blob — so the size is asserted, not just chosen.
    expect(BUSY_MARK_SIZE).toBe(32);
    const mark = busyRow("Thinking…").querySelector(".lm-brand-pop");
    expect(mark?.getAttribute("width")).toBe("32");
    expect(mark?.getAttribute("height")).toBe("32");
  });

  it("no longer carries the ring, but has not lost it either", () => {
    // P1b swapped the graphic on operator direction. `workingRing` stays
    // exported and tested so that putting it back is one word in `busyRow`.
    expect(busyRow("Thinking…").querySelector(".lm-brand-ring")).toBeNull();
    expect(workingRing().getAttribute("class")).toBe("lm-brand-ring");
  });

  it("announces once, as a live status", () => {
    const row = busyRow("Thinking…");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.querySelectorAll("[aria-label]")).toHaveLength(0);
  });
});

describe("the welcome panel (O6)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the mark above a title and a line of guidance", () => {
    const panel = welcomePanel("Ask Lemmaria", "Nothing is written…");
    expect(panel.querySelector("svg")).not.toBeNull();
    expect(panel.textContent).toContain("Ask Lemmaria");
    expect(panel.textContent).toContain("Nothing is written…");
  });

  it("renders no image — the CSP forbids one (D1)", () => {
    const panel = welcomePanel("Ask Lemmaria", "Nothing is written…");
    expect(panel.querySelectorAll("img")).toHaveLength(0);
  });

  it("uses the static mark: the empty panel is not a loading state", () => {
    // The pack's own guidance — stop animation as soon as work stops, and never
    // represent waiting for input as active computation. An empty panel is
    // waiting for the user, so nothing here turns.
    const panel = welcomePanel("Ask Lemmaria", "Nothing is written…");
    expect(panel.querySelector(".lm-brand-ring")).toBeNull();
    expect(panel.querySelector(".lm-brand-pop")).toBeNull();
    expect(panel.querySelector(".lm-brand-mark")).not.toBeNull();
  });
});

describe("the pop mark (P1b / O10)", () => {
  const packPresent = existsSync(PACK);
  const popSvg = packPresent
    ? readFileSync(
        join(PACK, "animations", "svg", "lemmaria-pop-dark.svg"),
        "utf8",
      )
    : "";

  it("is nodes, decorative, and carries no inline style or title", () => {
    const mark = popMark(BUSY_MARK_SIZE);
    expect(mark.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // The pack's own SVG is role="img" with a hardcoded English aria-label and
    // a <title>. Both would announce a second time over the row's own
    // localized, `role="status"` label — and the English breaks invariant 6
    // rule 2. So neither ships.
    expect(mark.getAttribute("role")).toBeNull();
    expect(mark.getAttribute("aria-label")).toBeNull();
    expect(mark.querySelector("title")).toBeNull();
    expect(mark.querySelector("style")).toBeNull();
    expect(mark.outerHTML).not.toContain("<style");
  });

  it("animates the clip's own use, which is what makes an overlap track", () => {
    // The load-bearing part of the construction. Each overlap is the middle
    // pebble repainted inside the clip of the pebble above or below it; the
    // clip's `<use>` carries the SAME animation class as the pebble it clips,
    // so the intersection follows two independently moving shapes instead of
    // sitting still while they pass through it.
    const mark = popMark(32);
    const clips = [...mark.querySelectorAll("clipPath")];
    expect(clips).toHaveLength(2);
    for (const [i, name] of ["bottom", "top"].entries()) {
      const use = clips[i]?.querySelector("use");
      expect(use).not.toBeNull();
      expect(use?.getAttribute("class")).toBe(
        `lm-animated lm-pop-${name}-shape`,
      );
    }
  });

  it("gives every instance its own ids, and resolves every ref inside it", () => {
    const a = popMark(32);
    const b = popMark(32);
    const ids = (n: SVGElement) =>
      [...n.querySelectorAll("[id]")].map((e) => e.id);
    const idsA = ids(a);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA.filter((id) => ids(b).includes(id))).toEqual([]);
    let refs = 0;
    for (const el of a.querySelectorAll("[fill],[clip-path],[href]")) {
      for (const attr of ["fill", "clip-path"]) {
        const ref = /url\(#([^)]+)\)/.exec(el.getAttribute(attr) ?? "")?.[1];
        if (ref) {
          refs++;
          expect(idsA).toContain(ref);
        }
      }
      const href = el.getAttribute("href");
      if (href?.startsWith("#")) {
        refs++;
        expect(idsA).toContain(href.slice(1));
      }
    }
    expect(refs).toBeGreaterThan(0);
  });

  it("takes its stop colours from the same theme tokens as the static mark", () => {
    const stops = [...popMark(32).querySelectorAll("stop")];
    expect(stops.length).toBe(BRAND_GRADIENTS.length * 2);
    for (const stop of stops)
      expect(stop.getAttribute("stop-color")).toBeNull();
  });

  it.skipIf(!packPresent)(
    "every keyframe percentage and value matches the pack's own SVG",
    () => {
      // The pack ships these keyframes inside an in-SVG <style> element, which
      // this webview's CSP drops — so they were transcribed into styles.css,
      // and a transcribed timing curve is wrong by one digit and still
      // plausible. Both copies are normalized before comparing, because the
      // pack minifies (`.68`) where the stylesheet is formatted (`0.68`).
      // `@keyframes` bodies nest braces, so they are extracted by counting
      // them rather than by a regex — a lazy `[\s\S]*?` stops at the first
      // step's closing brace and silently compares one keyframe out of five.
      const body = (src: string, name: string): string => {
        const at = src.indexOf(`@keyframes ${name}`);
        if (at < 0) return `MISSING ${name}`;
        const open = src.indexOf("{", at);
        let depth = 0;
        for (let i = open; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}" && --depth === 0)
            return src.slice(open + 1, i);
        }
        return `UNBALANCED ${name}`;
      };
      // One normalized `offsets => declarations` set per side. Both are
      // whitespace-stripped and `0.5`/`.5` unified, because the pack minifies
      // where the stylesheet is biome-formatted.
      const steps = (block: string): string[] =>
        block
          .split("}")
          .map((chunk) => chunk.trim())
          .filter((chunk) => chunk.includes("{"))
          .map((chunk) => {
            const [offsets, decls] = chunk.split("{") as [string, string];
            const norm = (s: string) =>
              s
                .replace(/\s+/g, "")
                .replace(/\b0\./g, ".")
                .replace(/;$/, "")
                .toLowerCase();
            return `${norm(offsets)} => ${norm(decls)
              .split(";")
              .sort()
              .join(";")}`;
          })
          .sort();

      for (const name of [
        "lm-pop-bottom-shape",
        "lm-pop-middle-shape",
        "lm-pop-top-shape",
        "lm-pop-bottom-fade",
        "lm-pop-middle-fade",
        "lm-pop-top-fade",
      ]) {
        const fromPack = steps(body(popSvg, name));
        // Guard the guard: an empty or unparsed pack side would make the
        // comparison below pass for the wrong reason. A `-fade` set has three
        // steps (start, hold, out); a `-shape` set has four (start, overshoot,
        // settle, out).
        expect(fromPack.length).toBe(name.endsWith("-fade") ? 3 : 4);
        expect(steps(body(css, name))).toEqual(fromPack);
      }
    },
  );

  it.skipIf(!packPresent)(
    "the three transform origins and the 2400ms period are the pack's",
    () => {
      for (const [name, origin] of [
        ["bottom", "472px695px"],
        ["middle", "453px473px"],
        ["top", "533px251px"],
      ] as const) {
        const packOrigin = new RegExp(
          `\\.lm-pop-${name}-shape\\{transform-origin:([^;]+);`,
        ).exec(popSvg)?.[1];
        expect(packOrigin?.replace(/\s+/g, "")).toBe(origin);
        expect(
          new RegExp(
            `\\.lm-pop-${name}-shape\\s*\\{[^}]*transform-origin:\\s*${origin.replace("px", "px ")}`,
          ).test(css.replace(/\s+/g, " ")),
        ).toBe(true);
      }
      // Six animations, all on the pack's single 2400ms period.
      expect(
        css.match(/lm-pop-[a-z-]+\s+2400ms\s+linear\s+infinite/g),
      ).toHaveLength(6);
    },
  );

  it("keeps the assembled logo as the BASE state, not the first keyframe", () => {
    // The 0% keyframe is "small, low and invisible". Were that also the base
    // style, `animation: none` — the global reduced-motion rule, and the
    // high-contrast rule — would land on an INVISIBLE mark rather than the
    // assembled one, and nothing in jsdom would show it. So no animated node
    // may carry a base transform or opacity.
    for (const el of popMark(32).querySelectorAll(".lm-animated")) {
      expect(el.getAttribute("transform")).toBeNull();
      expect(el.getAttribute("opacity")).toBeNull();
      expect(el.getAttribute("style")).toBeNull();
    }
    expect(css).not.toMatch(/\.lm-pop-[a-z-]+-(shape|fade)\s*\{[^}]*opacity:/);
    expect(css).not.toMatch(
      /\.lm-pop-[a-z-]+-shape\s*\{[^}]*\btransform:\s*translate/,
    );
  });

  it("is static in high contrast, per the pack's direction for this variant", () => {
    // "Pop uses a static monochrome mark in high-contrast mode, with the same
    // status label." The monochrome half is the currentColor tokens; this is
    // the static half. It lands on the assembled logo by the rule above.
    expect(css).toMatch(
      /body\.vscode-high-contrast[\s\S]{0,120}\.lm-brand-pop\s+\*[\s\S]{0,60}animation:\s*none\s*!important/,
    );
  });

  it("is covered by the stylesheet's single reduced-motion rule", () => {
    const block =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\{[^}]*\}/.exec(
        css,
      )?.[0];
    expect(block).toMatch(/\*\s*\{/);
    expect(block).toMatch(/animation:\s*none\s*!important/);
  });
});

describe("the small-size glyph (P1b / O11)", () => {
  const packPresent = existsSync(PACK);

  it.skipIf(!packPresent)(
    "reproduces the pack's masked construction, including the separation",
    () => {
      // This is a DIFFERENT construction from `brandMark`, not a smaller copy:
      // each lower pebble is masked by the STROKED silhouette of the one above
      // it, so a band of background separates them and the stack still reads
      // at 14px. The stroke width is the whole trick, so it is pinned.
      const icon = readFileSync(
        join(PACK, "icons", "lemmaria-current.svg"),
        "utf8",
      );
      const packStroke = /stroke-width="(\d+)"/.exec(icon)?.[1];
      expect(packStroke).toBeDefined();
      expect(GLYPH_SEPARATION).toBe(packStroke);
      expect(icon).toContain('stroke-linejoin="round"');

      const glyph = brandGlyph(HEADER_GLYPH_SIZE);
      const masks = [...glyph.querySelectorAll("mask")];
      expect(masks).toHaveLength(2);
      for (const mask of masks) {
        // White ground, then the pebble above punched out in black and stroked.
        expect(mask.querySelector("rect")?.getAttribute("fill")).toBe("white");
        const cut = mask.querySelector("use");
        expect(cut?.getAttribute("fill")).toBe("black");
        expect(cut?.getAttribute("stroke-width")).toBe(GLYPH_SEPARATION);
        expect(cut?.getAttribute("stroke-linejoin")).toBe("round");
      }
    },
  );

  it("masks the lower two pebbles by the one above, and the top by nothing", () => {
    const glyph = brandGlyph(16);
    const painted = [...glyph.children].filter(
      (n) => n.tagName.toLowerCase() === "use",
    );
    expect(painted).toHaveLength(3);
    expect(painted[0]?.getAttribute("mask")).toMatch(
      /^url\(#.*-mask-bottom\)$/,
    );
    expect(painted[1]?.getAttribute("mask")).toMatch(
      /^url\(#.*-mask-middle\)$/,
    );
    expect(painted[2]?.getAttribute("mask")).toBeNull();
  });

  it("is single-colour and follows the surrounding text", () => {
    // currentColor throughout, so it needs no theme tokens at all — which is
    // also what makes it correct in high contrast with no special case.
    const glyph = brandGlyph(16);
    for (const use of [...glyph.children].filter(
      (n) => n.tagName.toLowerCase() === "use",
    ))
      expect(use.getAttribute("fill")).toBe("currentColor");
    expect(glyph.querySelectorAll("linearGradient")).toHaveLength(0);
    expect(glyph.querySelectorAll("stop")).toHaveLength(0);
  });

  it("is decorative — the name sits beside it in text", () => {
    expect(brandGlyph(16).getAttribute("aria-hidden")).toBe("true");
    expect(brandGlyph(16).querySelector("title")).toBeNull();
  });

  it("gives every instance its own ids", () => {
    const a = brandGlyph(16);
    const b = brandGlyph(16);
    const ids = (n: SVGElement) =>
      [...n.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
    for (const use of a.querySelectorAll("use")) {
      const href = use.getAttribute("href");
      if (href?.startsWith("#")) expect(ids(a)).toContain(href.slice(1));
      const mask = /url\(#([^)]+)\)/.exec(use.getAttribute("mask") ?? "")?.[1];
      if (mask) expect(ids(a)).toContain(mask);
    }
  });

  it("is sized inside the pack's 16–32 band for a title-bar mark", () => {
    expect(HEADER_GLYPH_SIZE).toBeGreaterThanOrEqual(16);
    expect(HEADER_GLYPH_SIZE).toBeLessThanOrEqual(32);
  });
});
