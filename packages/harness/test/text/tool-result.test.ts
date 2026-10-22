import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_MAX_CHARS,
  capToolResult,
} from "../../src/text/tool-result.js";

/**
 * A6: a tool result is the one payload a *tool* — not the model — injects into
 * the conversation, and until now nothing bounded it. `run_script` can return
 * 200 000 bytes per stream and `literature_search` 20 abstracts, either of
 * which can consume a whole context window in a single call.
 */
describe("capToolResult (A6)", () => {
  it("leaves a result that fits byte-identical", () => {
    // The 99% case must not change at all — no re-encoding, no re-wrapping.
    const json = JSON.stringify({ ok: true, files: ["a.tex", "b.tex"] });
    expect(capToolResult(json)).toBe(json);
  });

  it("leaves a result exactly at the limit alone", () => {
    const json = "x".repeat(TOOL_RESULT_MAX_CHARS);
    expect(capToolResult(json)).toBe(json);
  });

  it("caps an oversized result and stays valid JSON", () => {
    const huge = JSON.stringify({ stdout: "y".repeat(500_000) });
    const capped = capToolResult(huge);

    expect(capped.length).toBeLessThan(huge.length);
    // The model must be able to parse what it is handed.
    const parsed = JSON.parse(capped) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
  });

  it("states the REAL original size, not the capped one", () => {
    const huge = JSON.stringify({ stdout: "y".repeat(500_000) });
    const parsed = JSON.parse(capToolResult(huge)) as {
      originalChars: number;
      shownChars: number;
    };
    expect(parsed.originalChars).toBe(huge.length);
    expect(parsed.shownChars).toBeLessThan(parsed.originalChars);
    expect(parsed.shownChars).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
  });

  it("keeps the head of the payload, so the result is still useful", () => {
    // Truncation must not throw the answer away — the beginning of a script's
    // output or a search's first hits is exactly what matters.
    const huge = JSON.stringify({
      first: "THE-IMPORTANT-BIT",
      rest: "z".repeat(500_000),
    });
    const parsed = JSON.parse(capToolResult(huge)) as { content: string };
    expect(parsed.content).toContain("THE-IMPORTANT-BIT");
  });

  it("tells the model what to do about it", () => {
    // An honest marker the model can act on beats a silent slice.
    const huge = JSON.stringify({ stdout: "y".repeat(500_000) });
    const parsed = JSON.parse(capToolResult(huge)) as { note: string };
    expect(parsed.note).toMatch(/truncat/i);
    expect(parsed.note.length).toBeGreaterThan(0);
  });

  it("bounds the SERIALIZED result, even for escape-heavy payloads", () => {
    // The regression guard for review finding "Important 4". The envelope
    // re-serializes the payload, so every \ and " doubles: a plain
    // slice(0, limit) returned up to 2x the limit on exactly the run_script
    // output this module exists to bound. An all-"q" input cannot detect that,
    // so these inputs are deliberately escape-dense.
    const cases = [
      "q".repeat(2_000_000),
      JSON.stringify({
        stdout: 'C:\\Users\\x\\run.py: "warning"\n'.repeat(20_000),
      }),
      JSON.stringify({ stdout: "\\".repeat(500_000) }),
      JSON.stringify({ stdout: '"'.repeat(500_000) }),
    ];
    for (const input of cases) {
      const capped = capToolResult(input);
      expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
      // ...and it is still parseable, which is the other half of the contract.
      expect(() => JSON.parse(capped)).not.toThrow();
    }
  });

  it("returns an empty string rather than throwing on an undefined result", () => {
    // JSON.stringify(undefined) is undefined; the loop's never-throws contract
    // must survive a tool whose invoke resolves to nothing.
    expect(capToolResult(undefined)).toBe("");
  });
});
