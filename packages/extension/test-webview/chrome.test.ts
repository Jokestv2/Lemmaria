import { describe, expect, it, vi } from "vitest";
import { assistantToolbar, header } from "../src/webview/parts/chrome.js";

describe("header (CHAT-6)", () => {
  it("carries only the one control that is genuinely global", () => {
    // `header()` sits ABOVE the tab bar, so anything in it shows while the
    // user is in Citations, Models, Venue, Review or Compile — tabs where a
    // session control means nothing. ⚙ Settings is the exception: it is global.
    const buttons = header("en", { onSettings: () => {} }).querySelectorAll(
      "button",
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Settings");
  });

  it("carries the brand glyph and the title", () => {
    // P1b: the real mark, not U1's placeholder diamond (operator direction).
    // The glyph, not `brandMark` — at 16 px the gradient mark's overlaps merge
    // into a blob, which is why `brandGlyph` is a separate construction.
    const node = header("en", { onSettings: () => {} });
    expect(node.querySelector(".lm-brand-glyph")).not.toBeNull();
    expect(node.querySelector(".lm-diamond")).toBeNull();
    expect(node.querySelector(".lm-header__title")?.textContent).toBe(
      "Lemmaria",
    );
  });

  it("does not announce the brand twice", () => {
    // The glyph is decorative; the title beside it is the text.
    const node = header("en", { onSettings: () => {} });
    expect(
      node.querySelector(".lm-brand-glyph")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(node.textContent).toBe("Lemmaria⚙");
  });

  it("fires its callback on click", () => {
    const onSettings = vi.fn();
    header("en", { onSettings }).querySelector("button")?.click();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("labels the control in Chinese under zh", () => {
    const label = header("zh", { onSettings: () => {} })
      .querySelector("button")
      ?.getAttribute("aria-label");
    expect(label).toMatch(/[一-鿿]/);
  });
});

describe("assistantToolbar (CHAT-6)", () => {
  const noop = { onHistory: () => {}, onNew: () => {} };

  it("carries exactly the two session controls, in order", () => {
    const buttons = [
      ...assistantToolbar("en", noop).querySelectorAll("button"),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("History");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("New");
  });

  it("fires each callback exactly once, and only its own", () => {
    const onHistory = vi.fn();
    const onNew = vi.fn();
    const buttons = [
      ...assistantToolbar("en", { onHistory, onNew }).querySelectorAll(
        "button",
      ),
    ];
    buttons[0]?.click();
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(onNew).not.toHaveBeenCalled();
    buttons[1]?.click();
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it("labels both in Chinese under zh, with no English", () => {
    const labels = [
      ...assistantToolbar("zh", noop).querySelectorAll("button"),
    ].map((b) => b.getAttribute("aria-label") ?? "");
    for (const label of labels) {
      expect(label).toMatch(/[一-鿿]/);
      expect(label).not.toMatch(/History|New/);
    }
  });

  it("reuses the header's icon-button class, so it looks like what it was", () => {
    for (const b of assistantToolbar("en", noop).querySelectorAll("button")) {
      expect(b.className).toBe("lm-iconbtn");
    }
  });
});
