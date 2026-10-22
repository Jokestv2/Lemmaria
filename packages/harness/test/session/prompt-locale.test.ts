import { describe, expect, it } from "vitest";
import { COMPACTION_PROMPTS } from "../../src/session/compaction.js";

const HAN = /[一-鿿]/;

describe("prompts are single-language", () => {
  it("the English compaction prompt contains no Han characters", () => {
    expect(HAN.test(COMPACTION_PROMPTS.en)).toBe(false);
  });

  it("the Chinese one does, and names Chinese as the reply language", () => {
    expect(HAN.test(COMPACTION_PROMPTS.zh)).toBe(true);
    expect(COMPACTION_PROMPTS.zh).toContain("中文");
  });

  it("neither defers the choice back to the model", () => {
    for (const prompt of Object.values(COMPACTION_PROMPTS))
      expect(prompt).not.toContain("the language the user has been writing in");
  });
});
