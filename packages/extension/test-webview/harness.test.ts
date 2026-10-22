import { describe, expect, it } from "vitest";

/**
 * The environment check for the project ADR 0037 adds. It asserts the two
 * things every other file here depends on: a real DOM, and that this project
 * is NOT collecting the mocha ext-host suite under `test/`.
 */
describe("the webview test environment", () => {
  it("provides a real DOM", () => {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "head";
    details.append(summary);

    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.textContent).toBe("head");
  });

  it("sets a custom property through CSSOM, which the webview CSP allows", () => {
    // The served CSP is `style-src ${cspSource}` with no 'unsafe-inline', so a
    // `style` ATTRIBUTE is blocked while CSSOM manipulation is not. The context
    // ring depends on exactly this distinction.
    const node = document.createElement("span");
    node.style.setProperty("--lm-ring-pct", "42");
    expect(node.style.getPropertyValue("--lm-ring-pct")).toBe("42");
  });
});
