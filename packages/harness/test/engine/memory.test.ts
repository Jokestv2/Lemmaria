import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../../src/contracts/tools.js";
import {
  directoryPaperCandidates,
  draftPaperMd,
  resolveMemory,
} from "../../src/engine/memory.js";
import { parsePaperMd } from "../../src/engine/paper.js";

describe("resolveMemory", () => {
  it("nearest non-empty profile field wins (directory > project > global)", () => {
    const merged = resolveMemory({
      global: "## Style\n- global rule",
      project:
        "## Style\n- project rule\n\n## Contribution\nProject contribution.",
      directory: "## Style\n- directory rule",
    });
    expect(merged.profile.style).toBe("- directory rule");
    expect(merged.profile.contribution).toBe("Project contribution.");
  });

  it("merges glossary per term, nearest wins, others survive", () => {
    const merged = resolveMemory({
      global:
        "## Glossary\n| Term | 中文 | Abbrev |\n|---|---|---|\n| foo | 全局 | F |\n| bar | 条 | B |",
      project:
        "## Glossary\n| Term | 中文 | Abbrev |\n|---|---|---|\n| Foo | 项目 | F |",
    });
    const foo = merged.glossary.find((g) => g.term.toLowerCase() === "foo");
    expect(foo?.zh).toBe("项目");
    expect(merged.glossary.some((g) => g.term === "bar")).toBe(true);
  });

  it("merges symbols per symbol, nearest wins", () => {
    const merged = resolveMemory({
      global:
        "## Symbols\n| Symbol | Meaning |\n|---|---|\n| α | global alpha |\n| β | beta |",
      directory:
        "## Symbols\n| Symbol | Meaning |\n|---|---|\n| α | local alpha |",
    });
    expect(merged.symbols.find((s) => s.symbol === "α")?.meaning).toBe(
      "local alpha",
    );
    expect(merged.symbols.some((s) => s.symbol === "β")).toBe(true);
  });

  it("single project layer behaves exactly like parsePaperMd (M3 regression)", () => {
    const md = "## Contribution\nX.\n\n## Style\n- s";
    expect(resolveMemory({ project: md }).profile.contribution).toBe("X.");
    expect(resolveMemory({ project: md }).profile.style).toBe("- s");
  });

  it("all layers absent yields the empty PaperMd", () => {
    const merged = resolveMemory({});
    expect(merged.profile).toEqual({
      contribution: "",
      audience: "",
      claims: "",
      outline: "",
      style: "",
      venue: "",
    });
    expect(merged.glossary).toEqual([]);
    expect(merged.symbols).toEqual([]);
  });
});

describe("draftPaperMd", () => {
  const node = (title: string, children: OutlineNode[] = []): OutlineNode => ({
    title,
    file: "main.tex",
    startLine: 1,
    endLine: 9,
    wordCount: 10,
    labels: [],
    citations: [],
    children,
  });

  it("emits a skeleton that round-trips through parsePaperMd", () => {
    const draft = draftPaperMd({
      title: "My Paper",
      outline: [node("Introduction", [node("Motivation")]), node("Method")],
    });
    expect(draft).toContain("# My Paper");
    expect(draft).toContain("## Venue");
    // Rewritten by D4: this asserted BOTH placeholder halves in one draft —
    // i.e. it asserted the defect ADR 0034 retired. The two-locale pair is
    // asserted in the "one language per reader" suite below.
    expect(draft).toMatch(/what is new\?/i);
    const parsed = parsePaperMd(draft);
    expect(parsed.profile.outline).toContain("- Introduction");
    expect(parsed.profile.outline).toContain("  - Motivation");
    expect(parsed.profile.outline).toContain("- Method");
    expect(parsed.glossary).toEqual([]);
    expect(parsed.symbols).toEqual([]);
  });

  it("uses a placeholder bullet when the outline is empty", () => {
    const parsed = parsePaperMd(draftPaperMd({ title: "T", outline: [] }));
    expect(parsed.profile.outline).not.toBe("");
  });

  it("seeds venue constraints from a manifest (M10 scaffolder)", () => {
    const draft = draftPaperMd({
      title: "T",
      outline: [],
      venue: {
        pageLimit: "9 pages (excl. references; check your CFP)",
        anonymity: "double_blind",
        bibstyle: "ACM-Reference-Format",
      },
    });
    expect(draft).toContain(
      "page_limit: 9 pages (excl. references; check your CFP)",
    );
    expect(draft).toContain("anonymity: double_blind");
    expect(draft).toContain("bibstyle: ACM-Reference-Format");
    const parsed = parsePaperMd(draft);
    expect(parsed.profile.venue).toContain("double_blind");
  });

  it("keeps the empty venue lines when no venue is given", () => {
    const draft = draftPaperMd({ title: "T", outline: [] });
    expect(draft).toContain("page_limit:\n");
    expect(draft).toContain("anonymity:\n");
    expect(draft).toContain("bibstyle:\n");
  });
});

describe("directoryPaperCandidates", () => {
  it("walks from the entry dir up to (excluding) the root", () => {
    expect(directoryPaperCandidates("chapters/eval/main.tex")).toEqual([
      "chapters/eval/PAPER.md",
      "chapters/PAPER.md",
    ]);
  });

  it("is empty for a root-level entry", () => {
    expect(directoryPaperCandidates("main.tex")).toEqual([]);
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): the drafted PAPER.md is written into the
 * USER'S REPOSITORY, which makes it the one place in the product where a mixed
 * string outlived the screen. ADR 0034 §*Consequences* 3 is why it takes a
 * locale rather than being Englished — the file is the user's from the moment
 * it is written.
 */
describe("draftPaperMd — one language per reader (D4)", () => {
  const CJK = /[一-鿿]/;
  /** The glossary column header is part of the pinned PAPER.md FORMAT, not
   *  chrome — renaming it would be a format change with parser consequences. */
  const withoutGlossaryHeader = (draft: string): string =>
    draft
      .split("\n")
      .filter((l) => !l.startsWith("| Term |"))
      .join("\n");

  it("drafts wholly in English under the en locale", () => {
    const draft = draftPaperMd({ title: "T", outline: [], locale: "en" });
    expect(withoutGlossaryHeader(draft)).not.toMatch(CJK);
  });

  it("drafts wholly in Chinese under the zh locale", () => {
    const draft = draftPaperMd({ title: "T", outline: [], locale: "zh" });
    expect(draft).toMatch(CJK);
    expect(draft).not.toMatch(/what is new/i);
    expect(draft).not.toMatch(/your style rules/i);
    expect(draft).not.toMatch(/add your intended structure/i);
  });

  it("round-trips through parsePaperMd in BOTH locales", () => {
    for (const locale of ["en", "zh"] as const) {
      const parsed = parsePaperMd(
        draftPaperMd({ title: "T", outline: [], locale }),
      );
      expect(parsed.profile.outline).not.toBe("");
      expect(parsed.glossary).toEqual([]);
      expect(parsed.symbols).toEqual([]);
    }
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", () => {
    expect(draftPaperMd({ title: "T", outline: [] })).toBe(
      draftPaperMd({ title: "T", outline: [], locale: "en" }),
    );
  });
});

/**
 * D4 / MEM-1 (ADR 0042): the drafted template.
 *
 * The rule that decided its contents: a section earns its place only if it
 * changes what the agent writes AND is stable across sessions. Two were added
 * and three candidates rejected — see the ADR.
 */
describe("draftPaperMd — the D4 template (MEM-1)", () => {
  it("drafts the two new sections, and they round-trip", () => {
    for (const locale of ["en", "zh"] as const) {
      const draft = draftPaperMd({ title: "T", outline: [], locale });
      expect(draft, `## Audience missing in ${locale}`).toMatch(
        /^## (Audience|读者)$/m,
      );
      expect(draft, `## Claims missing in ${locale}`).toMatch(
        /^## (Claims|主张)$/m,
      );
      // And the section HEADINGS are what the parser recognises.
      expect(parsePaperMd(draft)).toBeDefined();
    }
  });

  /**
   * Found by D4's code review, and the sharpest defect the milestone had: the
   * template explains each section in an HTML comment, and `parsePaperMd` took
   * a section body verbatim — so an UNFILLED draft parsed as its own
   * instructions, and D4 had just wired two of those fields into three
   * actions' prompts. Polish would have told the model the paper's claims were
   * "Lemmaria must not weaken, strengthen or invent any of them".
   *
   * The original version of the test above asserted `.not.toBe("")` on that
   * value, i.e. it pinned the defect as correct.
   */
  it("an UNFILLED draft carries no profile content at all", () => {
    for (const locale of ["en", "zh"] as const) {
      const parsed = parsePaperMd(
        draftPaperMd({ title: "T", outline: [], locale }),
      );
      for (const field of [
        "contribution",
        "audience",
        "claims",
        "style",
      ] as const) {
        expect(
          parsed.profile[field],
          `${field} carries placeholder text in ${locale}`,
        ).toBe("");
      }
    }
  });

  it("says what belongs in ## Style versus a Writing Skill", () => {
    // The template must state the boundary, or the two homes drift — which is
    // the whole reason MEM-1 lists `## Style`'s rival as a problem.
    const en = draftPaperMd({ title: "T", outline: [], locale: "en" });
    expect(en).toMatch(/skill/i);
    const zh = draftPaperMd({ title: "T", outline: [], locale: "zh" });
    expect(zh).toMatch(/技能|Skill/);
  });

  it("still emits every section the PAPER.md format defines", () => {
    const draft = draftPaperMd({ title: "T", outline: [], locale: "en" });
    for (const heading of [
      "## Contribution",
      "## Audience",
      "## Claims",
      "## Outline",
      "## Glossary",
      "## Symbols",
      "## Venue",
      "## Style",
    ]) {
      expect(draft, `${heading} missing`).toContain(heading);
    }
  });
});
