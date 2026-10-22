/**
 * The context-window ring (D2 / CHAT-8, ADR 0037 §5).
 *
 * It has been called `.lm-ring` since U0 and has never been one: a 10px faint
 * `<span>` rendering `—` or `42%`.
 */

export interface ContextUsage {
  /** Measured occupancy; absent before the first turn and after a compaction. */
  occupied?: number;
  window: number;
}

export interface RingState {
  /** Absent while nothing has been measured — NOT zero, and NOT a hundred. */
  pct?: number;
  level: "unknown" | "ok" | "warn" | "high";
}

/**
 * **Empty state: Pi's honesty, not Codex's optimism.** Codex renders
 * `"100% context left"` before anything is measured, which is an assertion the
 * UI has not earned and which visibly drops the moment a real number arrives.
 * Pi renders a real `?` when tokens are unknown. A2 worked to make Lemmaria's
 * number real; the ring must not fake it while it waits.
 *
 * **Thresholds: Pi's 70 / 90**, which is the part that actually changes what a
 * user does. A ring gets them for free as hue.
 */
export function ringState(usage: ContextUsage | undefined): RingState {
  if (usage?.occupied === undefined || usage.window <= 0) {
    return { level: "unknown" };
  }
  const pct = Math.min(100, Math.round((usage.occupied / usage.window) * 100));
  const level = pct > 90 ? "high" : pct > 70 ? "warn" : "ok";
  return { pct, level };
}

/**
 * The ring itself — a conic-gradient dot, deliberately not an SVG.
 *
 * `document.createElement("svg")` yields an `HTMLUnknownElement`; a real arc
 * needs `createElementNS`, i.e. widening the `el()` helper for one graphic. A
 * conic gradient needs neither and is one CSS rule.
 *
 * The percentage is set through **CSSOM**, never as a `style` attribute: the
 * webview CSP is `style-src ${cspSource}` with no `'unsafe-inline'`, so an
 * attribute would be blocked while CSSOM is not.
 */
export function contextRing(state: RingState, title: string): HTMLElement {
  const node = document.createElement("span");
  node.className = `lm-ring lm-ring--${state.level}`;
  node.title = title;
  // NOT aria-hidden (review): the ring carries a live measurement, so the
  // number is announced rather than merely drawn.
  node.setAttribute("aria-label", title);
  if (state.pct !== undefined) {
    node.style.setProperty("--lm-ring-pct", String(state.pct));
  }
  // The number stays beside the ring: a hue and an arc are a summary, and the
  // measurement itself is what A2 built.
  node.textContent = state.pct === undefined ? "—" : `${state.pct}%`;
  return node;
}
