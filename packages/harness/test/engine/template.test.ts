import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/engine/template.js";

describe("renderTemplate", () => {
  it("interpolates dotted paths", () => {
    const r = renderTemplate("Shrink to {{params.target}} {{unit}}.", {
      params: { target: 500 },
      unit: "words",
    });
    expect(r.text).toBe("Shrink to 500 words.");
    expect(r.warnings).toEqual([]);
  });

  it("renders undeclared variables empty with a warning", () => {
    const r = renderTemplate("Hello {{missing.var}}!", {});
    expect(r.text).toBe("Hello !");
    expect(r.warnings).toEqual(["undeclared template variable: missing.var"]);
  });

  it("supports upper and trim helpers", () => {
    const r = renderTemplate("{{upper lang}} {{trim padded}}", {
      lang: "en",
      padded: "  x  ",
    });
    expect(r.text).toBe("EN x");
  });

  it("supports #if / #unless blocks with logic-less truthiness", () => {
    const tpl =
      "{{#if style}}S:{{style}}{{/if}}{{#unless style}}none{{/unless}}";
    expect(renderTemplate(tpl, { style: "active voice" }).text).toBe(
      "S:active voice",
    );
    expect(renderTemplate(tpl, { style: "" }).text).toBe("none");
  });

  it("supports nested blocks", () => {
    const tpl = "{{#if a}}A{{#if b}}B{{/if}}{{/if}}";
    expect(renderTemplate(tpl, { a: 1, b: 1 }).text).toBe("AB");
    expect(renderTemplate(tpl, { a: 1, b: 0 }).text).toBe("A");
    expect(renderTemplate(tpl, { a: 0, b: 1 }).text).toBe("");
  });

  it("warns on unclosed/unmatched blocks and unsupported expressions", () => {
    expect(renderTemplate("{{#if a}}x", { a: 1 }).warnings).toContainEqual(
      expect.stringContaining("unclosed"),
    );
    expect(renderTemplate("{{/if}}", {}).warnings).toContainEqual(
      expect.stringContaining("unmatched"),
    );
    expect(
      renderTemplate("{{#each items}}{{/each}}", {}).warnings.length,
    ).toBeGreaterThan(0);
  });

  it("does not treat prototype members as variables (hasOwn discipline)", () => {
    const r = renderTemplate("{{valueOf}}", {});
    expect(r.text).toBe("");
    expect(r.warnings).toEqual(["undeclared template variable: valueOf"]);
  });
});
