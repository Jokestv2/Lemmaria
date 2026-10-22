import { describe, expect, it } from "vitest";
import { countWords } from "../../src/latex/count-words.js";

describe("countWords", () => {
  it("counts English by word", () => {
    expect(countWords("Alpha beta gamma delta.")).toEqual({
      language: "en",
      unit: "words",
      count: 4,
    });
  });

  it("keeps hyphenated/apostrophe words single and counts numbers", () => {
    expect(countWords("state-of-the-art doesn't cost 42 dollars").count).toBe(
      5,
    );
  });

  it("counts Chinese by character, excluding punctuation", () => {
    expect(countWords("这是一段中文。")).toEqual({
      language: "zh",
      unit: "字",
      count: 6,
    });
  });

  it("reports mixed text per contiguous segment", () => {
    expect(countWords("模型 model 使用 attention 机制。")).toEqual({
      language: "mixed",
      unit: "words",
      count: 8,
      segments: [
        { language: "zh", count: 2 },
        { language: "en", count: 1 },
        { language: "zh", count: 2 },
        { language: "en", count: 1 },
        { language: "zh", count: 2 },
      ],
    });
  });

  it("returns zero for empty/whitespace/punctuation-only text", () => {
    expect(countWords("")).toEqual({ language: "en", unit: "words", count: 0 });
    expect(countWords("  …—— !?")).toEqual({
      language: "en",
      unit: "words",
      count: 0,
    });
  });
});
