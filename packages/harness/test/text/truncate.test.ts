import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  truncateKeepingHead,
  truncateKeepingTail,
  truncateLineTo,
} from "../../src/text/truncate.js";

/**
 * B4 (ADR 0029) — the one truncation primitive.
 *
 * A6 bounded tool results with a single 32 000-character head cut over the
 * SERIALIZED payload. That is a backstop, not a policy: it cannot say how big
 * the thing it cut was in the tool's own terms, and it keeps the head even for
 * a failing script, whose error is at the end.
 *
 * The second limit is estimated TOKENS, not bytes (the divergence from Pi):
 * bytes are a transport measure, and a byte cap would hand a Chinese paper a
 * third of the budget an English one gets (invariant 6).
 */
describe("truncateKeepingHead / truncateKeepingTail (B4)", () => {
  const lines = (n: number, prefix = "line"): string =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");

  it("returns text that fits untouched, and says so", () => {
    const text = lines(3);
    for (const fn of [truncateKeepingHead, truncateKeepingTail]) {
      const out = fn(text, { maxLines: 100, maxTokens: 100 });
      expect(out.text).toBe(text);
      expect(out.truncated).toBe(false);
      expect(out.truncatedBy).toBeNull();
      expect(out.totalLines).toBe(3);
      expect(out.shownLines).toBe(3);
      expect(out.partialLine).toBe(false);
    }
  });

  it("keeps the HEAD when the line limit fires, and names the limit", () => {
    const out = truncateKeepingHead(lines(10), {
      maxLines: 3,
      maxTokens: 10_000,
    });
    expect(out.text).toBe("line1\nline2\nline3");
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("lines");
    expect(out.totalLines).toBe(10);
    expect(out.shownLines).toBe(3);
  });

  it("keeps the TAIL when the line limit fires — a failing script's error is at the end", () => {
    const out = truncateKeepingTail(lines(10), {
      maxLines: 3,
      maxTokens: 10_000,
    });
    expect(out.text).toBe("line8\nline9\nline10");
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("lines");
    expect(out.totalLines).toBe(10);
    expect(out.shownLines).toBe(3);
  });

  it("fires on tokens when tokens run out first, and never emits a partial line", () => {
    // 20 lines of ~5 ASCII chars ≈ 2 tokens each once the newline is charged.
    const text = lines(20);
    const out = truncateKeepingHead(text, { maxLines: 1_000, maxTokens: 6 });
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("tokens");
    expect(out.partialLine).toBe(false);
    // Whole lines only: every kept line is one of the originals, in order.
    const kept = out.text.split("\n");
    expect(kept.length).toBe(out.shownLines);
    for (const [i, line] of kept.entries()) expect(line).toBe(`line${i + 1}`);
    expect(out.shownTokens).toBeLessThanOrEqual(6);
  });

  it("reports the REAL totals, not the shown ones", () => {
    const text = lines(50);
    const out = truncateKeepingHead(text, { maxLines: 5, maxTokens: 10_000 });
    expect(out.totalLines).toBe(50);
    expect(out.totalTokens).toBe(estimateTokens(text));
    expect(out.totalBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.shownLines).toBe(5);
  });

  it("counts CN and EN by the same COST, not by bytes (invariant 6)", () => {
    // 400 CJK codepoints ≈ 400 tokens; 1600 ASCII chars ≈ 400 tokens. The two
    // cost the same, so the same budget must keep both whole — a BYTE limit
    // would have cut the Chinese text at a third of the English one.
    const cn = "实验结果表明该方法显著优于基线".repeat(20); // 300 codepoints
    const en = "the experimental results show a clear gain ".repeat(28);
    expect(estimateTokens(cn)).toBeLessThanOrEqual(400);
    expect(estimateTokens(en)).toBeLessThanOrEqual(400);
    // Chinese is far heavier in bytes yet must not be penalised for it.
    expect(Buffer.byteLength(cn, "utf8")).toBeGreaterThan(
      Buffer.byteLength(en, "utf8") / 2,
    );
    for (const text of [cn, en]) {
      const out = truncateKeepingHead(text, { maxLines: 10, maxTokens: 400 });
      expect(out.truncated).toBe(false);
      expect(out.text).toBe(text);
    }
  });

  it("keeps a bounded PREFIX of a single over-budget line (head)", () => {
    // A LaTeX paragraph is routinely ONE line. Pi returns nothing here; that
    // would make read_span useless on exactly the documents Lemmaria serves.
    const one = "x".repeat(4_000); // ~1000 tokens
    const out = truncateKeepingHead(one, { maxLines: 100, maxTokens: 10 });
    expect(out.partialLine).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("tokens");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThan(one.length);
    expect(one.startsWith(out.text)).toBe(true);
  });

  it("keeps a bounded SUFFIX of a single over-budget line (tail)", () => {
    const one = `${"x".repeat(4_000)}ERROR-AT-THE-END`;
    const out = truncateKeepingTail(one, { maxLines: 100, maxTokens: 10 });
    expect(out.partialLine).toBe(true);
    expect(out.text.endsWith("ERROR-AT-THE-END")).toBe(true);
    expect(one.endsWith(out.text)).toBe(true);
  });

  it("never splits a codepoint", () => {
    const one = "研究方法".repeat(500);
    for (const fn of [truncateKeepingHead, truncateKeepingTail]) {
      const out = fn(one, { maxLines: 10, maxTokens: 7 });
      expect(out.partialLine).toBe(true);
      // A split surrogate/continuation byte would show up as U+FFFD.
      expect(out.text).not.toContain("�");
      expect(one).toContain(out.text);
    }
  });

  it("does not count a trailing newline as an extra line", () => {
    const out = truncateKeepingHead("a\nb\n", { maxLines: 10, maxTokens: 100 });
    expect(out.totalLines).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("handles empty input without inventing a line", () => {
    const out = truncateKeepingHead("", { maxLines: 10, maxTokens: 10 });
    expect(out.totalLines).toBe(0);
    expect(out.text).toBe("");
    expect(out.truncated).toBe(false);
  });
});

describe("truncateLineTo (B4)", () => {
  it("leaves a short line alone", () => {
    expect(truncateLineTo("abc", 10)).toEqual({
      text: "abc",
      truncated: false,
    });
  });

  it("marks a cut line rather than cutting it silently", () => {
    // grep_project cut lines at 200 chars with NO marker before B4 — the model
    // could not tell a truncated match from a short one.
    const out = truncateLineTo("y".repeat(500), 10);
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("y".repeat(10))).toBe(true);
    expect(out.text).toMatch(/truncated/);
  });

  it("counts characters, not UTF-16 units, so CJK is not double-charged", () => {
    const out = truncateLineTo("方法".repeat(50), 10);
    expect([...out.text.replace(/….*$/, "")].length).toBe(10);
  });
});
