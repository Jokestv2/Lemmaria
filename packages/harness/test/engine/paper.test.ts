import { describe, expect, it } from "vitest";
import { formatGlossary, parsePaperMd } from "../../src/engine/paper.js";

const SAMPLE = `# Attention Is All You Need

## Contribution
A transformer architecture relying entirely on attention.

## glossary
| Term | 中文 | Abbrev |
|------|------|--------|
| self-attention | 自注意力 | — |
| multi-head attention | 多头注意力 | MHA |

## 风格
- Prefer active voice.

## Symbols
| Symbol | Meaning |
|--------|---------|
| $d_k$ | key dimension |

## Unknown Section
ignored
`;

describe("parsePaperMd", () => {
  it("maps H2 sections case-insensitively with ZH aliases", () => {
    const p = parsePaperMd(SAMPLE);
    expect(p.profile.contribution).toBe(
      "A transformer architecture relying entirely on attention.",
    );
    expect(p.profile.style).toBe("- Prefer active voice.");
    expect(p.profile.outline).toBe("");
    expect(p.profile.venue).toBe("");
    expect(p.glossary).toEqual([
      { term: "self-attention", zh: "自注意力", abbrev: "—" },
      { term: "multi-head attention", zh: "多头注意力", abbrev: "MHA" },
    ]);
    expect(p.symbols).toEqual([{ symbol: "$d_k$", meaning: "key dimension" }]);
  });

  it("returns all-empty on empty/absent content", () => {
    const p = parsePaperMd("");
    expect(p.profile).toEqual({
      contribution: "",
      audience: "",
      claims: "",
      outline: "",
      style: "",
      venue: "",
    });
    expect(p.glossary).toEqual([]);
    expect(p.symbols).toEqual([]);
  });
});

describe("formatGlossary", () => {
  it("re-emits a compact table incl. symbols", () => {
    const g = formatGlossary(parsePaperMd(SAMPLE));
    expect(g).toContain("| self-attention | 自注意力 | — |");
    expect(g).toContain("| $d_k$ | key dimension |");
  });
  it("is empty when there is no glossary", () => {
    expect(formatGlossary(parsePaperMd(""))).toBe("");
  });
});

/**
 * D4 / MEM-1 (ADR 0042): `## Audience` and `## Claims`.
 *
 * Each was added only because the whole chain is wired in the same milestone —
 * alias, `PaperMd.profile` field, `context.ts`'s `include_profile` gate, and an
 * action that declares it. A section the draft asks the user to fill in and
 * nothing ever reads is the defect this milestone is named after.
 */
describe("PAPER.md — the D4 profile sections", () => {
  it("parses ## Audience and ## Claims into profile fields", () => {
    const paper = parsePaperMd(
      [
        "## Audience",
        "Systems reviewers at a top-tier venue.",
        "",
        "## Claims",
        "- 3.2x faster than the baseline",
        "- no accuracy loss",
      ].join("\n"),
    );
    expect(paper.profile.audience).toBe(
      "Systems reviewers at a top-tier venue.",
    );
    expect(paper.profile.claims).toContain("3.2x faster");
  });

  it("accepts the ZH heading aliases, like every other section", () => {
    const paper = parsePaperMd(
      ["## 读者", "系统方向的审稿人。", "", "## 主张", "- 快 3.2 倍"].join(
        "\n",
      ),
    );
    expect(paper.profile.audience).toBe("系统方向的审稿人。");
    expect(paper.profile.claims).toContain("3.2");
  });

  /**
   * Always true (`section = undefined` collects nothing), never asserted — and
   * MEM-1 relies on it, because a user is free to keep sections of their own in
   * a file they own.
   */
  it("ignores an unknown section without contaminating its neighbour", () => {
    const paper = parsePaperMd(
      [
        "## Contribution",
        "A real contribution.",
        "",
        "## Notes to self",
        "buy milk",
        "remember the deadline",
        "",
        "## Audience",
        "Reviewers.",
      ].join("\n"),
    );
    expect(paper.profile.contribution).toBe("A real contribution.");
    expect(paper.profile.audience).toBe("Reviewers.");
    expect(JSON.stringify(paper)).not.toContain("buy milk");
  });
});
