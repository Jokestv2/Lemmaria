/**
 * The drive-and-measure vocabulary (T2, ADR 0043).
 *
 * The extension host posts a `probe` request; this module executes one step of
 * it against the live DOM and returns a plain, structured answer. The point is
 * to reach the two facts jsdom structurally cannot supply — **real geometry**
 * and **a resolving container query** — in the real Electron webview, where
 * `offsetWidth` is a number and `@container` resolves.
 *
 * **The vocabulary is closed, and that is the security property.** The obvious
 * design is to post a string of JavaScript and evaluate it. It is refused, and
 * it is not even reachable: the webview CSP is `script-src 'nonce-…'` with no
 * `'unsafe-eval'`, so an eval-a-string protocol would mean weakening the CSP of
 * the one browser context in the product — the one that renders model output.
 * That is the shape invariant 2 refuses at the model boundary, one level down:
 * capability arrives as a named, bounded verb, never as a general escape hatch.
 *
 * **The selector is free; the verb is not.** What matters is what may be DONE
 * with a node, not which node may be named.
 *
 * **Every verb here has a reader.** The list starts at what `test/webview-drive.test.ts`
 * actually drives rather than at what a DOM can do — the `RetryPolicy`
 * precedent (ADR 0026): a surface with no reader is speculative, and an unused
 * escape hatch is a thing a later reader assumes something calls. It grows by
 * commit, when a reader arrives.
 *
 * This module is deliberately **pure and root-injected** — it never reaches for
 * a `document` global — which is what lets ADR 0037's jsdom project assert the
 * vocabulary while the ext-host suite asserts what the vocabulary measures.
 *
 * **The wire types live in `webview-protocol.ts`, not here.** That file is the
 * single source of truth for host↔webview messages and must stay DOM-free —
 * the host's own tsconfig carries `lib: ["ES2022"]` with no DOM — so the step
 * and result shapes are plain data there, and only the execution is here.
 */
import type {
  ProbeRect,
  ProbeResult,
  ProbeStep,
} from "../../webview-protocol.js";

export type { ProbeRect, ProbeResult, ProbeStep };

/** Anything with the two query methods — a `Document` or an `Element`. */
export interface ProbeRoot {
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): ArrayLike<Element>;
}

function rectOf(el: Element): ProbeRect {
  const r = el.getBoundingClientRect();
  return {
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    left: r.left,
    width: r.width,
    height: r.height,
  };
}

/**
 * Runs ONE step. Never throws: a bad selector, an absent node and an unknown
 * verb all come back as `error`.
 */
export function runProbeStep(step: ProbeStep, root: ProbeRoot): ProbeResult {
  const { verb, selector } = step;

  // `querySelector` throws on a malformed selector. Letting that escape would
  // reject the whole request, which ADR 0043 §D6 reserves for a dead channel.
  let first: Element | null;
  let all: ArrayLike<Element>;
  try {
    first = root.querySelector(selector);
    all = root.querySelectorAll(selector);
  } catch (e) {
    return { verb, error: `bad selector: ${selector} (${String(e)})` };
  }

  // The two verbs for which an empty match IS the answer. Every other verb
  // reports the miss, because inventing an answer (an empty string, a zero
  // rect) is how a test passes against a surface that is not there.
  if (verb === "exists") return { verb, value: first !== null };
  if (verb === "count") return { verb, value: all.length };
  // `rects` joins them: an empty set is a real answer ("nothing is laid out
  // here"), and a caller that wanted one box would have asked for `rect`.
  if (verb === "rects") {
    return { verb, value: Array.from(all, rectOf) };
  }

  if (!first) return { verb, error: `no match: ${selector}` };
  const el = first as HTMLElement;

  switch (verb) {
    case "text":
      return { verb, value: el.textContent ?? "" };
    case "value":
      return {
        verb,
        value: (el as HTMLTextAreaElement | HTMLInputElement).value ?? "",
      };
    case "classes":
      return { verb, value: [...el.classList] };
    case "computed": {
      const view = el.ownerDocument?.defaultView;
      if (!view) return { verb, error: "no view: cannot compute style" };
      return {
        verb,
        value: view.getComputedStyle(el).getPropertyValue(step.name),
      };
    }
    case "rect":
      return { verb, value: rectOf(el) };
    case "overflows":
      // Horizontal only: a region that scrolls sideways is the clipping D2's
      // item 2 is about. Vertical overflow is the transcript doing its job.
      //
      // **Point this at a SCROLL CONTAINER.** On an `overflow: visible` box,
      // `scrollWidth` reports layout overflow and both figures round to whole
      // pixels, so a child ending at 280.03 inside a 280px box answers `true`
      // with no scrollbar anywhere. That sub-pixel artefact cost this milestone
      // a red test, and the fix was to measure the element that can actually
      // scroll rather than to loosen the comparison.
      return { verb, value: el.scrollWidth > el.clientWidth };
    case "click":
      el.click();
      return { verb, value: true };
    case "key": {
      const view = el.ownerDocument?.defaultView;
      if (!view) return { verb, error: "no view: cannot dispatch a key" };
      const ev = new view.KeyboardEvent("keydown", {
        key: step.key,
        shiftKey: step.shift === true,
        ctrlKey: step.ctrl === true,
        altKey: step.alt === true,
        metaKey: step.meta === true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      // Whether the handler consumed it — the newline-versus-send fork, free
      // to observe and otherwise invisible to the host.
      return { verb, value: ev.defaultPrevented };
    }
    case "input": {
      const view = el.ownerDocument?.defaultView;
      if (!view) return { verb, error: "no view: cannot dispatch input" };
      (el as HTMLTextAreaElement | HTMLInputElement).value = step.text;
      el.dispatchEvent(new view.Event("input", { bubbles: true }));
      return { verb, value: true };
    }
    case "setWidth":
      // 0 clears. A forced width outlives the request on a shared view, so
      // handing it back must be expressible — and `width: 0px` is a collapsed
      // panel, not a released one.
      if (step.px <= 0) el.style.removeProperty("width");
      else el.style.setProperty("width", `${step.px}px`);
      return { verb, value: true };
    default:
      // The client's own message dispatch has no exhaustiveness check and drops
      // unknown types silently. A probe that did the same would answer a
      // question nobody asked with a pass.
      return {
        verb: (step as { verb: string }).verb,
        error: `unknown verb: ${(step as { verb: string }).verb}`,
      };
  }
}
