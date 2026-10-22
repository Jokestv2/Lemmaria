import type { SessionLocale } from "@lemmaria/harness";
import { HEADER_GLYPH_SIZE, brandGlyph } from "./brand.js";
import { tr } from "./strings.js";

/**
 * The panel's two chrome strips (D2 / CHAT-6).
 *
 * `header()` sits **above** the tab bar, so everything in it is visible from
 * every tab. Until D2 it carried ⟲ History and ＋ New — session controls that
 * mean nothing while the user is in Citations, Models, Venue, Review or
 * Compile. They move to a strip of the Assistant tab's own; ⚙ Settings is
 * genuinely global and stays.
 */

function iconButton(
  glyph: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "lm-iconbtn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.textContent = glyph;
  btn.addEventListener("click", onClick);
  return btn;
}

/** The global strip: brand mark, title, and the one control that is global. */
export function header(
  locale: SessionLocale,
  on: { onSettings: () => void },
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "lm-header";

  const title = document.createElement("div");
  title.className = "lm-header__title";
  title.textContent = "Lemmaria";

  // P1b: the brand, not the U1 placeholder diamond. At this size the masked
  // glyph is the right construction — see `brandGlyph`.
  bar.append(brandGlyph(HEADER_GLYPH_SIZE), title);
  // A5: was a clickable no-op since U1 — now opens Lemmaria's settings.
  bar.append(iconButton("⚙", tr(locale, "settings"), on.onSettings));
  return bar;
}

/**
 * The Assistant tab's own strip: the two session controls, rendered only while
 * that tab is the one on screen.
 */
export function assistantToolbar(
  locale: SessionLocale,
  on: { onHistory: () => void; onNew: () => void },
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "lm-assistant-bar";
  // A2: History — the resume quick-pick over ALL sessions; the A5 Sessions
  // view lists the recent ones in the activity bar.
  bar.append(iconButton("⟲", tr(locale, "history"), on.onHistory));
  // A1a: New Session — same fresh-thread operation as the command palette.
  bar.append(iconButton("＋", tr(locale, "new"), on.onNew));
  return bar;
}
