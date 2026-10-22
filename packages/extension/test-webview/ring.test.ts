import { describe, expect, it } from "vitest";
import { contextRing, ringState } from "../src/webview/parts/ring.js";

describe("ringState (CHAT-8)", () => {
  it("is unknown before anything has been measured", () => {
    // A2 worked to make this number real. Codex renders "100% context left"
    // here — reassuring, but an assertion the UI has not earned, and it
    // visibly DROPS on first measurement. Pi's honest "?" is the shape
    // adopted (ADR 0037 §5).
    expect(ringState(undefined)).toEqual({ level: "unknown" });
    expect(ringState({ window: 100 })).toEqual({ level: "unknown" });
  });

  it("is unknown rather than infinite when the window is zero", () => {
    expect(ringState({ occupied: 10, window: 0 })).toEqual({
      level: "unknown",
    });
  });

  it("reports a measured percentage", () => {
    expect(ringState({ occupied: 42, window: 100 })).toEqual({
      pct: 42,
      level: "ok",
    });
  });

  it("warns above 70% and alarms above 90%, Pi's thresholds", () => {
    expect(ringState({ occupied: 70, window: 100 }).level).toBe("ok");
    expect(ringState({ occupied: 71, window: 100 }).level).toBe("warn");
    expect(ringState({ occupied: 90, window: 100 }).level).toBe("warn");
    expect(ringState({ occupied: 91, window: 100 }).level).toBe("high");
  });

  it("clamps an over-window measurement to 100", () => {
    expect(ringState({ occupied: 250, window: 100 })).toEqual({
      pct: 100,
      level: "high",
    });
  });
});

describe("contextRing (CHAT-8)", () => {
  it("draws the track with no fill, and says —, before the first measurement", () => {
    const node = contextRing({ level: "unknown" }, "not measured yet");
    expect(node.textContent).toBe("—");
    // No fill at all, rather than a full ring that would then drop.
    expect(node.style.getPropertyValue("--lm-ring-pct")).toBe("");
    expect(node.className).toContain("lm-ring--unknown");
  });

  it("sets the fill through CSSOM, which the webview CSP allows", () => {
    // `style-src ${cspSource}` carries no 'unsafe-inline', so a `style`
    // ATTRIBUTE is blocked while CSSOM is not. The percentage must never go
    // through el()'s setAttribute path.
    const node = contextRing({ pct: 42, level: "ok" }, "42%");
    expect(node.style.getPropertyValue("--lm-ring-pct")).toBe("42");
    expect(node.getAttribute("style")).toContain("--lm-ring-pct");
  });

  it("carries the level as a class, so the colour is CSS's job", () => {
    expect(contextRing({ pct: 80, level: "warn" }, "t").className).toContain(
      "lm-ring--warn",
    );
    expect(contextRing({ pct: 95, level: "high" }, "t").className).toContain(
      "lm-ring--high",
    );
  });

  it("keeps the measured tooltip on both title and aria-label", () => {
    // The ring is deliberately NOT aria-hidden: it carries a live measurement,
    // so the number must be announced, not just shown. A graphical ring makes
    // that more important, not less.
    const title = "Context-window usage: 42% (4200 / 10000 tok)";
    const node = contextRing({ pct: 42, level: "ok" }, title);
    expect(node.title).toBe(title);
    expect(node.getAttribute("aria-label")).toBe(title);
    expect(node.getAttribute("aria-hidden")).toBeNull();
  });

  it("still shows the number, so the ring is not the only carrier", () => {
    expect(contextRing({ pct: 42, level: "ok" }, "t").textContent).toBe("42%");
  });
});
