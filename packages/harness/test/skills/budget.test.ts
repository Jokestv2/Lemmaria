import { describe, expect, it } from "vitest";
import type { Skill, SkillSource } from "../../src/contracts/skills.js";
import {
  DEFAULT_SKILL_CATALOGUE_CHAR_BUDGET,
  MIN_SKILL_DESCRIPTION_CHARS,
  SKILL_CATALOGUE_CONTEXT_WINDOW_PERCENT,
  catalogueEntryCost,
  defaultSkillCatalogueBudget,
  fitCatalogue,
} from "../../src/skills/budget.js";

/** A token-unit budget of `limit`, which is what most of these tests want. */
const tokens = (limit: number) => ({ unit: "tokens" as const, limit });

const s = (
  name: string,
  description: string,
  source: SkillSource = "project",
): Skill => ({
  name,
  description,
  body: "b",
  source,
  path: `${source}/${name}/SKILL.md`,
  references: [],
});

/** The budget that exactly holds these skills at their current descriptions. */
const budgetFor = (skills: Skill[]): number =>
  skills.reduce((n, k) => n + catalogueEntryCost(k), 0);

describe("fitCatalogue (E1, ADR 0045)", () => {
  it("a catalogue that fits comes back byte-identical, with no diagnostics", () => {
    // The case that must never regress: most users have four short skills, and
    // the ladder must not touch a single character of them.
    const skills = [s("tone", "Use active voice."), s("cite", "Cite well.")];
    const { kept, diagnostics } = fitCatalogue(skills, {
      budget: defaultSkillCatalogueBudget(200_000),
    });
    expect(diagnostics).toEqual([]);
    expect(kept).toEqual(skills);
    // Same objects, not merely equal ones — nothing was rebuilt.
    expect(kept[0]).toBe(skills[0]);
  });

  it("truncates the LONGEST description first and stops the moment it fits", () => {
    const long = s("long", "L".repeat(900));
    const mid = s("mid", "M".repeat(400));
    const short = s("short", "S".repeat(120));
    const all = [long, mid, short];
    // ~300 chars over: only `long` should be asked to pay.
    const budget = budgetFor(all) - Math.ceil(300 / 4);
    const { kept, diagnostics } = fitCatalogue(all, { budget: tokens(budget) });

    expect(kept).toHaveLength(3);
    const by = (n: string) => kept.find((k) => k.name === n);
    expect(by("long")?.description.length).toBeLessThan(900);
    expect(by("mid")?.description).toBe("M".repeat(400));
    expect(by("short")?.description).toBe("S".repeat(120));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("description_truncated");
    expect(diagnostics[0]?.message).toContain("long");
  });

  it("never truncates below the 200-char floor; the shortfall is paid by omission", () => {
    const skills = Array.from({ length: 12 }, (_, i) =>
      s(`k${i}`, "x".repeat(800)),
    );
    const { kept } = fitCatalogue(skills, { budget: tokens(300) });
    for (const k of kept) {
      expect(k.description.length).toBeGreaterThanOrEqual(
        MIN_SKILL_DESCRIPTION_CHARS,
      );
    }
    // It could not have fitted by truncation alone, so it must have omitted.
    expect(kept.length).toBeLessThan(skills.length);
  });

  it("omits LOWEST-PRECEDENCE first, not localeCompare order", () => {
    // One skill per source, all identical in size, and room for two. The
    // survey called the old localeCompare tail drop "arbitrary from the user's
    // point of view"; a-bundled sorts FIRST by name and must still be the
    // first to go.
    const d = "x".repeat(MIN_SKILL_DESCRIPTION_CHARS);
    const all = [
      s("aaa", d, "bundled"),
      s("bbb", d, "venue"),
      s("ccc", d, "user"),
      s("ddd", d, "project"),
    ];
    const budget = budgetFor(all.slice(0, 2));
    const { kept, diagnostics } = fitCatalogue(all, { budget: tokens(budget) });

    expect(kept.map((k) => k.name).sort()).toEqual(["ccc", "ddd"]);
    expect(diagnostics.map((x) => x.code)).toEqual([
      "over_budget",
      "over_budget",
    ]);
    expect(diagnostics.map((x) => x.source).sort()).toEqual([
      "bundled",
      "venue",
    ]);
  });

  it("the over_budget message names the disable action, in each reader's own language", () => {
    const d = "x".repeat(MIN_SKILL_DESCRIPTION_CHARS);
    const all = [s("aaa", d, "bundled"), s("ddd", d, "project")];
    const budget = budgetFor(all.slice(0, 1));

    const en = fitCatalogue(all, { budget: tokens(budget) }).diagnostics[0];
    expect(en?.message).toContain("disable");
    expect(en?.message).toContain("aaa");

    const zh = fitCatalogue(all, { budget: tokens(budget), locale: "zh" })
      .diagnostics[0];
    expect(zh?.message).toContain("停用");
    expect(zh?.message).toContain("aaa");
    // Invariant 6 rule 2: one language per reader, never both in one string.
    expect(zh?.message).not.toContain("disable");
    expect(en?.message).not.toMatch(/[一-鿿]/);
  });

  it("a truncated description ends in an ellipsis and never splits an astral character", () => {
    // Chinese-and-emoji descriptions are exactly what these packs carry, and a
    // code-unit slice would leave a lone surrogate.
    const astral = "𝑥".repeat(500);
    const all = [s("astral", astral), s("plain", "p".repeat(500))];
    const { kept } = fitCatalogue(all, {
      budget: tokens(budgetFor(all) - 100),
    });
    const cut = kept.find((k) => k.name === "astral")?.description ?? "";
    expect(cut.endsWith("…")).toBe(true);
    // No lone surrogate survived: re-encoding is lossless.
    expect(cut).toBe(Buffer.from(cut, "utf8").toString("utf8"));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
  });

  it("a skill that was truncated and THEN omitted reports only the omission", () => {
    // Found by review: rung 3's diagnostics used to be emitted before rung 4
    // dropped anything, so one skill could carry both an info note saying its
    // description was shortened "so the whole catalogue fits" AND a failure row
    // saying it was not loaded — two contradictory things about one skill.
    const long = "L".repeat(900);
    const all = [
      s("keep", long, "project"),
      s("drop", long, "bundled"),
      s("also-drop", long, "bundled"),
    ];
    const { kept, diagnostics } = fitCatalogue(all, { budget: tokens(80) });

    const codesFor = (name: string) =>
      diagnostics
        .filter((d) => d.path.includes(`/${name}/`))
        .map((d) => d.code);

    for (const name of ["drop", "also-drop"]) {
      expect(kept.some((k) => k.name === name)).toBe(false);
      expect(codesFor(name)).toEqual(["over_budget"]);
    }
    // A skill that was truncated and KEPT still says so.
    expect(kept.some((k) => k.name === "keep")).toBe(true);
    expect(codesFor("keep")).toEqual(["description_truncated"]);
  });

  it("a description already at or below the floor is never truncated to pay for another", () => {
    const tiny = s("tiny", "short one");
    const huge = s("huge", "H".repeat(4_000));
    const { kept } = fitCatalogue([tiny, huge], { budget: tokens(400) });
    expect(kept.find((k) => k.name === "tiny")?.description).toBe("short one");
  });
});

describe("defaultSkillCatalogueBudget (E1 review round — Codex's rule)", () => {
  // Codex `core-skills/src/render.rs::default_skill_metadata_budget`:
  // 2 % of the context window in tokens, and an 8,000-CHARACTER budget when
  // there is no window to take a percentage of.
  it("is 2 % of the context window, in tokens", () => {
    expect(SKILL_CATALOGUE_CONTEXT_WINDOW_PERCENT).toBe(2);
    expect(defaultSkillCatalogueBudget(200_000)).toEqual({
      unit: "tokens",
      limit: 4_000,
    });
    expect(defaultSkillCatalogueBudget(272_000)).toEqual({
      unit: "tokens",
      limit: 5_440,
    });
  });

  it("falls back to a CHARACTER budget when the window is unknown", () => {
    // The unit changes with the branch, and that is Codex's shape rather than
    // an accident: with no window there is no token figure worth deriving, so
    // it stops estimating tokens and counts characters instead.
    expect(DEFAULT_SKILL_CATALOGUE_CHAR_BUDGET).toBe(8_000);
    for (const window of [undefined, 0, -1, Number.NaN]) {
      expect(defaultSkillCatalogueBudget(window)).toEqual({
        unit: "chars",
        limit: 8_000,
      });
    }
  });

  it("never derives a budget of zero", () => {
    // `.max(1)` in Codex. A 10-token window is not a real model, but a budget
    // of 0 would omit every skill and emit an omission diagnostic per skill,
    // which is a worse answer than keeping one.
    expect(defaultSkillCatalogueBudget(10)).toEqual({
      unit: "tokens",
      limit: 1,
    });
  });

  it("fits the catalogue in CHARACTERS when the budget is a character one", () => {
    // The ladder is the same ladder; only what a line costs changes. 900 `L`s
    // is ~225 estimated tokens but ~950 characters, so a 400-unit budget
    // truncates under `chars` and would not under `tokens` — which is what
    // proves the unit is actually being honoured.
    const long = s("long", "L".repeat(900));
    const under = fitCatalogue([long], {
      budget: { unit: "chars", limit: 400 },
    });
    expect(under.kept[0]?.description.length).toBeLessThan(900);
    expect(under.diagnostics[0]?.code).toBe("description_truncated");

    const over = fitCatalogue([long], { budget: tokens(400) });
    expect(over.diagnostics).toEqual([]);
    expect(over.kept[0]?.description).toBe("L".repeat(900));
  });

  it("costs a catalogue entry in whichever unit the budget names", () => {
    const one = s("tone", "Use active voice.");
    expect(catalogueEntryCost(one, "chars")).toBeGreaterThan(
      catalogueEntryCost(one, "tokens"),
    );
  });
});
