/**
 * T2 (ADR 0043): the drive-and-measure vocabulary, asserted in jsdom.
 *
 * This is the FINE instrument asserting the COARSE one's vocabulary — ADR 0043
 * §D5's split applied to the probe itself. jsdom can answer everything about
 * `runProbeStep` except the two things the probe exists for: real geometry and
 * a resolving container query. Those are asserted in the real Electron webview
 * by `test/webview-drive.test.ts`, so `rect` / `computed` / `overflows` are
 * checked here for their SHAPE only — that they read the DOM and report the
 * right keys — never for a layout value, which jsdom reports as 0 whatever the
 * CSS says. That is not a weakness of this file; it is the fact that makes the
 * other one necessary.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { type ProbeStep, runProbeStep } from "../src/webview/parts/probe.js";

/**
 * Builds the fixture from nodes, never from a string of HTML.
 * `check-webview-innerhtml.mjs` guards `src/webview` deny-by-default, and a
 * test that builds its fixture the way the source may not is a test written
 * against a different product.
 */
function mount(...specs: [tag: string, cls: string, text?: string][]): void {
  const root = document.createElement("div");
  root.className = "lm-app";
  for (const [tag, cls, text] of specs) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    root.appendChild(node);
  }
  document.body.replaceChildren(root);
}

const run = (step: ProbeStep) => runProbeStep(step, document);

describe("runProbeStep — measure verbs", () => {
  beforeEach(() => {
    mount(
      ["button", "lm-tile alpha", "Polish"],
      ["button", "lm-tile", "Expand"],
      ["div", "lm-grid"],
    );
  });

  it("reports existence as a boolean, both ways", () => {
    expect(run({ verb: "exists", selector: ".lm-grid" })).toEqual({
      verb: "exists",
      value: true,
    });
    expect(run({ verb: "exists", selector: ".lm-nope" })).toEqual({
      verb: "exists",
      value: false,
    });
  });

  it("counts every match, and counts zero rather than failing", () => {
    // `exists` and `count` are the two verbs for which an empty match IS the
    // answer. Every other verb reports an error instead — see the last block.
    expect(run({ verb: "count", selector: ".lm-tile" })).toEqual({
      verb: "count",
      value: 2,
    });
    expect(run({ verb: "count", selector: ".lm-nope" })).toEqual({
      verb: "count",
      value: 0,
    });
  });

  it("reads text from the first match", () => {
    expect(run({ verb: "text", selector: ".lm-tile" })).toEqual({
      verb: "text",
      value: "Polish",
    });
  });

  it("reads a form field's value, which is not its text", () => {
    const input = document.createElement("textarea");
    input.className = "lm-input";
    input.value = "drafted";
    document.querySelector(".lm-app")?.appendChild(input);
    expect(run({ verb: "value", selector: ".lm-input" })).toEqual({
      verb: "value",
      value: "drafted",
    });
  });

  it("reads the class list as an array, not as the raw attribute", () => {
    // An array is what an assertion wants. Substring-matching a className
    // string would also match `lm-proposal--applied-later`, and the row states
    // this suite cares about are a family of `lm-proposal--*` siblings.
    expect(run({ verb: "classes", selector: ".lm-tile" })).toEqual({
      verb: "classes",
      value: ["lm-tile", "alpha"],
    });
  });

  it("reads a named computed style property", () => {
    // jsdom resolves declared properties but performs no layout, so this
    // asserts the READING, not a layout value.
    const got = run({
      verb: "computed",
      selector: ".lm-grid",
      name: "display",
    });
    expect(got.verb).toBe("computed");
    expect(typeof got.value).toBe("string");
  });

  it("reports a rect with the six numbers a geometry assertion needs", () => {
    const got = run({ verb: "rect", selector: ".lm-grid" });
    expect(got.verb).toBe("rect");
    // Shape only. Every number is 0 in jsdom — which is precisely the fact
    // that makes the real-webview instrument necessary (ADR 0038 §3).
    expect(Object.keys(got.value as object).sort()).toEqual([
      "bottom",
      "height",
      "left",
      "right",
      "top",
      "width",
    ]);
  });

  it("reports horizontal overflow as a boolean", () => {
    const got = run({ verb: "overflows", selector: ".lm-app" });
    expect(got.verb).toBe("overflows");
    expect(typeof got.value).toBe("boolean");
  });
});

describe("runProbeStep — drive verbs", () => {
  beforeEach(() => {
    mount(["button", "lm-tile", "Polish"], ["div", "lm-grid"]);
    const input = document.createElement("textarea");
    input.className = "lm-input";
    document.querySelector(".lm-app")?.appendChild(input);
  });

  it("clicks the first match, and a listener sees a real bubbling event", () => {
    let seen = 0;
    document.querySelector(".lm-tile")?.addEventListener("click", () => {
      seen += 1;
    });
    expect(run({ verb: "click", selector: ".lm-tile" })).toEqual({
      verb: "click",
      value: true,
    });
    expect(seen).toBe(1);
  });

  it("dispatches a key with its modifiers, because the composer rule reads them", () => {
    // D2's keydown rule tests `isComposing`, then `keyCode`, then the
    // modifiers, and its operator round found `Alt+Enter` inserting NOTHING
    // while 32 offline rows stayed green. A probe that could not carry a
    // modifier could not drive the rule it is most likely to be pointed at —
    // that defect is the one that opened T2.
    let got: KeyboardEvent | undefined;
    document.querySelector(".lm-input")?.addEventListener("keydown", (e) => {
      got = e as KeyboardEvent;
    });
    run({ verb: "key", selector: ".lm-input", key: "Enter", alt: true });
    expect(got?.key).toBe("Enter");
    expect(got?.altKey).toBe(true);
    expect(got?.shiftKey).toBe(false);
    expect(got?.ctrlKey).toBe(false);
    expect(got?.metaKey).toBe(false);
  });

  it("reports whether the key was consumed, which is the newline-vs-send fork", () => {
    // `preventDefault()` is how the composer says "I handled this" — it is the
    // difference between Enter sending and Enter inserting a newline, and it
    // is observable to the dispatcher for free.
    document.querySelector(".lm-input")?.addEventListener("keydown", (e) => {
      e.preventDefault();
    });
    expect(run({ verb: "key", selector: ".lm-input", key: "Enter" })).toEqual({
      verb: "key",
      value: true,
    });
  });

  it("sets a value and fires input, which is what a controlled field listens for", () => {
    let fired = 0;
    document.querySelector(".lm-input")?.addEventListener("input", () => {
      fired += 1;
    });
    run({ verb: "input", selector: ".lm-input", text: "hello" });
    const field = document.querySelector(".lm-input") as HTMLTextAreaElement;
    expect(field.value).toBe("hello");
    expect(fired).toBe(1);
  });

  it("sets a width through CSSOM, never as a style attribute", () => {
    // ADR 0043 §D2: the webview CSP is `style-src ${cspSource}` with no
    // 'unsafe-inline', so a `style` ATTRIBUTE is blocked while CSSOM is not —
    // the route `parts/ring.ts` already uses for `--lm-ring-pct`. This is the
    // verb the whole milestone turns on, so its mechanism is pinned here.
    run({ verb: "setWidth", selector: ".lm-app", px: 280 });
    const app = document.querySelector(".lm-app") as HTMLElement;
    expect(app.style.width).toBe("280px");
  });
});

describe("runProbeStep — failure is explicit, never silent", () => {
  beforeEach(() => {
    mount(["div", "lm-grid"]);
  });

  it("reports a selector that matches nothing, and does not throw", () => {
    // Every verb but `exists`/`count` has no answer for an empty match, and
    // inventing one (an empty string, a zero rect) is how a test passes
    // against a surface that is not there.
    expect(run({ verb: "text", selector: ".lm-nope" })).toEqual({
      verb: "text",
      error: "no match: .lm-nope",
    });
    expect(run({ verb: "rect", selector: ".lm-nope" })).toEqual({
      verb: "rect",
      error: "no match: .lm-nope",
    });
  });

  it("reports a click on nothing as an error, not as a no-op success", () => {
    expect(run({ verb: "click", selector: ".lm-nope" })).toEqual({
      verb: "click",
      error: "no match: .lm-nope",
    });
  });

  it("rejects an unknown verb rather than ignoring it", () => {
    // The client's own message dispatch has no exhaustiveness check and drops
    // unknown types silently. A probe that did the same would answer a
    // question nobody asked with a pass. `eval` is the verb ADR 0043 §D1
    // refuses, so it is the one used here.
    const got = runProbeStep(
      { verb: "eval", selector: "*" } as unknown as ProbeStep,
      document,
    );
    expect(got).toEqual({ verb: "eval", error: "unknown verb: eval" });
  });

  it("reports an invalid selector as an error rather than throwing", () => {
    // `querySelector` THROWS on a malformed selector. A probe that let that
    // escape would fail the whole request, and the host would see a rejected
    // promise — which ADR 0043 §D6 reserves for a broken channel.
    const got = run({ verb: "exists", selector: "((" });
    expect(got.verb).toBe("exists");
    expect(got.error).toMatch(/bad selector/);
  });
});

describe("runProbeStep — setWidth releases as well as forces", () => {
  it("px 0 removes the override rather than collapsing the panel", () => {
    // The override outlives the request on a view the whole ext-host suite
    // shares, so handing it back must be expressible. `width: 0px` would be a
    // collapsed panel silently changing what every later suite measures.
    mount(["div", "lm-grid"]);
    run({ verb: "setWidth", selector: ".lm-app", px: 280 });
    const app = document.querySelector(".lm-app") as HTMLElement;
    expect(app.style.width).toBe("280px");
    run({ verb: "setWidth", selector: ".lm-app", px: 0 });
    expect(app.style.width).toBe("");
  });
});
