import { describe, expect, it } from "vitest";
import {
  MIN_SKILL_DESCRIPTION_CHARS,
  defaultSkillCatalogueBudget,
} from "../../src/skills/budget.js";

/**
 * The window whose 2 % is 1,500 tokens (ADR 0048) — the figure these fixtures
 * were sized against when the budget was a fixed one. Pinning it keeps the
 * sizing meaningful now that the budget is derived: without a window the
 * loader falls back to Codex's 8,000-CHARACTER budget, which is a different
 * unit and a looser bound, and every ladder assertion below would go quiet.
 */
const WINDOW_FOR_1500 = 75_000;
import {
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  SKILL_DIAGNOSTIC_LEVEL,
  loadSkillSet,
} from "../../src/skills/loader.js";

const skill = (
  name: string,
  description = "When to use it.",
  body = "Do the thing.",
): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe("loadSkillSet (ADR 0028)", () => {
  it("parses frontmatter into a Skill and keeps the body out of the description", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        { path: ".lemmaria/skills/tone/SKILL.md", content: skill("tone") },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(skills).toEqual([
      {
        name: "tone",
        description: "When to use it.",
        body: "Do the thing.",
        source: "project",
        path: ".lemmaria/skills/tone/SKILL.md",
        // E1: present and EMPTY, never absent. An optional array is two shapes
        // to handle at every reader, and this one reaches a tool result.
        references: [],
      },
    ]);
  });

  it("falls back to the directory name when frontmatter omits name", () => {
    const { skills } = loadSkillSet({
      project: [
        {
          path: ".lemmaria/skills/house-style/SKILL.md",
          content: "---\ndescription: d\n---\nb\n",
        },
      ],
    });
    expect(skills[0]?.name).toBe("house-style");
  });

  it("a user skill beats a venue one and loses to a project one (E1)", () => {
    // The fourth source, mirroring the action loader's built-in < user <
    // project: `~/.lemmaria/skills` is the user's own, so it outranks whatever
    // the venue shipped and yields to what this paper says.
    const files = (source: string) => skill("tone", source);
    const beatsVenue = loadSkillSet({
      venue: [{ path: "venue/tone/SKILL.md", content: files("venue") }],
      user: [{ path: "user/tone/SKILL.md", content: files("user") }],
    });
    expect(beatsVenue.skills).toHaveLength(1);
    expect(beatsVenue.skills[0]?.description).toBe("user");
    expect(beatsVenue.skills[0]?.source).toBe("user");

    const losesToProject = loadSkillSet({
      user: [{ path: "user/tone/SKILL.md", content: files("user") }],
      project: [{ path: "p/tone/SKILL.md", content: files("project") }],
    });
    expect(losesToProject.skills).toHaveLength(1);
    expect(losesToProject.skills[0]?.description).toBe("project");
  });

  it("carries the references manifest the library read, defaulting to empty (E1)", () => {
    const { skills } = loadSkillSet({
      project: [
        {
          path: "p/tone/SKILL.md",
          content: skill("tone"),
          references: ["taxonomy.md", "worked-examples.md"],
        },
        { path: "p/voice/SKILL.md", content: skill("voice") },
      ],
    });
    expect(skills.find((s) => s.name === "tone")?.references).toEqual([
      "taxonomy.md",
      "worked-examples.md",
    ]);
    expect(skills.find((s) => s.name === "voice")?.references).toEqual([]);
  });

  it("project beats venue beats bundled on a name collision", () => {
    const { skills, diagnostics } = loadSkillSet({
      bundled: [
        { path: "bundled/tone/SKILL.md", content: skill("tone", "bundled") },
      ],
      venue: [{ path: "venue/tone/SKILL.md", content: skill("tone", "venue") }],
      project: [
        {
          path: ".lemmaria/skills/tone/SKILL.md",
          content: skill("tone", "project"),
        },
      ],
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("project");
    expect(skills[0]?.source).toBe("project");
    // Shadowing is the FEATURE, not an error — it must not produce a diagnostic.
    expect(diagnostics).toEqual([]);
  });

  it("venue beats bundled when the paper declares no skill of its own", () => {
    const { skills } = loadSkillSet({
      bundled: [
        { path: "bundled/tone/SKILL.md", content: skill("tone", "bundled") },
      ],
      venue: [{ path: "venue/tone/SKILL.md", content: skill("tone", "venue") }],
    });
    expect(skills[0]?.source).toBe("venue");
  });

  it("reports invalid YAML as parse_failed rather than throwing", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        { path: "p/bad/SKILL.md", content: "---\nname: [unclosed\n---\nb\n" },
      ],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("parse_failed");
    expect(diagnostics[0]?.path).toBe("p/bad/SKILL.md");
    expect(diagnostics[0]?.source).toBe("project");
  });

  it("drops a skill with no description, and says so", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: "---\nname: x\n---\nbody\n" }],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("missing_description");
  });

  it("treats a file with no frontmatter at all as missing its description", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        { path: "p/x/SKILL.md", content: "just prose, no frontmatter" },
      ],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("missing_description");
  });

  it("drops a skill whose name is not a slug, naming the offending name", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: skill("Not A Slug") }],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("invalid_name");
    expect(diagnostics[0]?.message).toContain("Not A Slug");
  });

  it("drops a name that is too long, naming the limit", () => {
    const long = "a".repeat(MAX_SKILL_NAME_CHARS + 1);
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: skill(long) }],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("invalid_name");
    expect(diagnostics[0]?.message).toContain(String(MAX_SKILL_NAME_CHARS));
  });

  it("a 700-char description LOADS, untouched and undiagnosed (E1)", () => {
    // STRAT-1's headline, in one assertion. The old 200-char gate is now a
    // truncation FLOOR, not a rejection: 16 of 19 skills in a real pack, and 7
    // of ~20 of the skills Anthropic itself ships, sit between 200 and 1,024.
    const long = "x".repeat(700);
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: skill("x", long) }],
    });
    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe(long);
  });

  it("a description over 1,024 chars is still a hard rejection (E1)", () => {
    // The Agent Skills standard's number, which Pi enforces and Codex
    // truncates at. Past it the author has not written a description at all.
    const long = "x".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1);
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: skill("x", long) }],
    });
    expect(MAX_SKILL_DESCRIPTION_CHARS).toBe(1_024);
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("description_too_long");
    expect(diagnostics[0]?.message).toContain(
      String(MAX_SKILL_DESCRIPTION_CHARS),
    );
  });

  it("accepts a description of exactly the limit", () => {
    const exact = "x".repeat(MAX_SKILL_DESCRIPTION_CHARS);
    const { skills, diagnostics } = loadSkillSet({
      project: [{ path: "p/x/SKILL.md", content: skill("x", exact) }],
    });
    // One skill alone is well inside the catalogue budget, so nothing is cut.
    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
  });

  it("19 short-description skills all load, where 16 was the old ceiling (E1)", () => {
    // `over_capacity` is gone from the union, so a test still naming it is a
    // COMPILE error — the intended proof that the old gate cannot fire.
    const project = Array.from({ length: 19 }, (_, i) => ({
      path: `p/k${i}/SKILL.md`,
      content: skill(`k${i}`),
    }));
    const { skills, diagnostics } = loadSkillSet({ project });
    expect(skills).toHaveLength(19);
    expect(diagnostics).toEqual([]);
  });

  it("a body routing to scripts/ STILL LOADS, with an Info note beside it (E1)", () => {
    // Assert the skill is in `skills`, not only in `diagnostics`: an Info note
    // that silently dropped the skill would be the exact opposite of this
    // feature's purpose. `nature-downloader` routes to six scripts and will
    // not work; its prose half is still worth having.
    const body = "Run scripts/fetch.py, then apply templates/log.md.";
    const content = `---\nname: dl\ndescription: d\n---\n\n${body}\n`;
    const { skills, diagnostics } = loadSkillSet({
      user: [{ path: "u/dl/SKILL.md", content }],
    });
    expect(skills.map((k) => k.name)).toEqual(["dl"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("routes_outside_references");
    expect(diagnostics[0]?.message).toContain("scripts");
    expect(diagnostics[0]?.message).toContain("templates");

    // One language per reader (invariant 6), asserted under both.
    const zh = loadSkillSet(
      { user: [{ path: "u/dl/SKILL.md", content }] },
      "zh",
    );
    expect(zh.diagnostics[0]?.message).toContain("scripts");
    expect(zh.diagnostics[0]?.message).toMatch(/[一-鿿]/);
    expect(diagnostics[0]?.message).not.toMatch(/[一-鿿]/);
  });

  it("a body that only mentions references/ gets no note (E1)", () => {
    const content =
      "---\nname: tone\ndescription: d\n---\n\nSee references/taxonomy.md.\n";
    const { skills, diagnostics } = loadSkillSet({
      user: [{ path: "u/tone/SKILL.md", content }],
    });
    expect(skills).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it("a mixed-script third-party description passes through byte-identical (E1)", () => {
    // The invariant-6 boundary, pinned as behaviour rather than left in prose:
    // invariant 6 binds what LEMMARIA writes, not text a third party authored
    // that Lemmaria displays as theirs. 14 of 19 nature-skills descriptions
    // have exactly this shape. Without this test the decision lives only in a
    // doc and the next contributor "fixes" it.
    const mixed =
      "Add strict Nature/CNS citations to manuscript text — 分段引用、自动给出引用、补引用 — and export RIS.";
    const { skills, diagnostics } = loadSkillSet({
      user: [{ path: "u/cite/SKILL.md", content: skill("cite", mixed) }],
    });
    expect(diagnostics).toEqual([]);
    expect(skills[0]?.description).toBe(mixed);
  });

  it("hands the disabled skills back, so a UI can offer them again", () => {
    // The gate-review round of 2026-08-25. Dropping them on the floor meant the
    // Skills view had nothing to render a row from, so a disabled skill simply
    // vanished and the only way back was a palette command — a switch you can
    // turn off and not find again is not a switch.
    //
    // Collected BEFORE the merge, deliberately: that is where the filter runs,
    // and it is what lets both copies of a twice-resolving name come back
    // separately. A `path` selector would otherwise have no row to act on.
    const both = {
      bundled: [
        { path: "b/tone/SKILL.md", content: skill("tone", "The bundled one.") },
      ],
      user: [{ path: "u/tone/SKILL.md", content: skill("tone", "Mine.") }],
    };
    const out = loadSkillSet({
      ...both,
      disabled: [{ path: "u/tone/SKILL.md" }],
    });
    expect(out.skills.map((k) => k.name)).toEqual(["tone"]);
    expect(out.skills[0]?.source).toBe("bundled");
    expect(out.disabled.map((k) => k.path)).toEqual(["u/tone/SKILL.md"]);
    expect(out.disabled[0]?.source).toBe("user");
    // The description comes back too — the row's hover has to say what the
    // skill you turned off actually was.
    expect(out.disabled[0]?.description).toBe("Mine.");
  });

  it("collects BOTH copies when a name is disabled from two sources", () => {
    const out = loadSkillSet({
      bundled: [
        { path: "b/tone/SKILL.md", content: skill("tone", "The bundled one.") },
      ],
      user: [{ path: "u/tone/SKILL.md", content: skill("tone", "Mine.") }],
      disabled: [{ path: "u/tone/SKILL.md" }, { path: "b/tone/SKILL.md" }],
    });
    expect(out.skills).toEqual([]);
    expect(out.disabled.map((k) => k.source).sort()).toEqual([
      "bundled",
      "user",
    ]);
  });

  it("a disabled skill is removed BEFORE the budget runs (E1)", () => {
    // The E1.2 ordering, made observable: the set only fits with `hog`
    // disabled, so if disabling ran after the budget there would be an
    // `over_budget` or `description_truncated` diagnostic here.
    // Sized so the eight alone fit a 1,500-token budget with nothing touched,
    // and the ninth pushes them over it.
    const filler = "x".repeat(MIN_SKILL_DESCRIPTION_CHARS * 3);
    const project = Array.from({ length: 8 }, (_, i) => ({
      path: `p/k${i}/SKILL.md`,
      content: skill(`k${i}`, filler),
    }));
    const hog = {
      path: "p/hog/SKILL.md",
      content: skill("hog", "H".repeat(MAX_SKILL_DESCRIPTION_CHARS)),
    };
    const withHog = loadSkillSet({
      project: [...project, hog],
      contextWindowTokens: WINDOW_FOR_1500,
    });
    expect(withHog.diagnostics.map((d) => d.code)).toContain(
      "description_truncated",
    );

    const disabled = loadSkillSet({
      project: [...project, hog],
      disabled: [{ name: "hog" }],
      contextWindowTokens: WINDOW_FOR_1500,
    });
    expect(disabled.skills.map((s) => s.name)).not.toContain("hog");
    expect(disabled.skills).toHaveLength(8);
    expect(disabled.diagnostics).toEqual([]);
  });

  it("a PATH selector disables one copy, leaving the same name from another source (E1)", () => {
    const both = {
      venue: [{ path: "venue/tone/SKILL.md", content: skill("tone", "venue") }],
      project: [{ path: "p/tone/SKILL.md", content: skill("tone", "project") }],
    };
    const byPath = loadSkillSet({
      ...both,
      disabled: [{ path: "p/tone/SKILL.md" }],
    });
    expect(byPath.skills).toHaveLength(1);
    expect(byPath.skills[0]?.source).toBe("venue");

    // A NAME selector, by contrast, disables it wherever it resolves from.
    const byName = loadSkillSet({ ...both, disabled: [{ name: "tone" }] });
    expect(byName.skills).toEqual([]);
  });

  it("a catalogue over budget truncates and names it, still loading every skill (E1)", () => {
    const project = Array.from({ length: 19 }, (_, i) => ({
      path: `p/k${i}/SKILL.md`,
      content: skill(`k${i}`, "x".repeat(900)),
    }));
    const { skills, diagnostics } = loadSkillSet({
      project,
      contextWindowTokens: WINDOW_FOR_1500,
    });
    // 19 x 900 chars is far over 1,500 tokens; 19 at the 200 floor is not.
    expect(skills).toHaveLength(19);
    expect(diagnostics.every((d) => d.code === "description_truncated")).toBe(
      true,
    );
    for (const loaded of skills) {
      expect(loaded.description.length).toBeLessThan(900);
      expect(loaded.description.length).toBeGreaterThanOrEqual(
        MIN_SKILL_DESCRIPTION_CHARS,
      );
    }
    // The budget this fixture is sized against, stated rather than assumed —
    // 2 % of a 75,000-token window is the 1,500 the fixed constant used to be.
    expect(defaultSkillCatalogueBudget(WINDOW_FOR_1500)).toEqual({
      unit: "tokens",
      limit: 1_500,
    });
  });

  it("drops a skill with an empty body — a description alone teaches nothing", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        {
          path: "p/x/SKILL.md",
          content: "---\nname: x\ndescription: d\n---\n   \n",
        },
      ],
    });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("empty_body");
  });

  it("omits lowest-precedence-first when even the floor will not fit (E1)", () => {
    // §D5's guarantee, preserved and strengthened: the user's own skill must
    // never be the one crowded out. What changed is the ORDER of the drop —
    // precedence, not the localeCompare tail sort the survey called "arbitrary
    // from the user's point of view".
    const floor = "x".repeat(MIN_SKILL_DESCRIPTION_CHARS);
    const bundled = Array.from({ length: 40 }, (_, i) => ({
      path: `bundled/b${i}/SKILL.md`,
      content: skill(`b${i}`, floor),
    }));
    const { skills, diagnostics } = loadSkillSet({
      bundled,
      project: [{ path: "p/mine/SKILL.md", content: skill("mine", floor) }],
    });
    expect(skills.map((s) => s.name)).toContain("mine");
    expect(skills.length).toBeLessThan(41);
    const dropped = diagnostics.filter((d) => d.code === "over_budget");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((d) => d.source === "bundled")).toBe(true);
    expect(dropped[0]?.message).toContain("disable");
  });

  it("prefers SKILL.zh.md over SKILL.md for zh, and the reverse for en", () => {
    const files = [
      {
        path: "b/tone/SKILL.md",
        content: skill("tone", "English one", "English body"),
      },
      {
        path: "b/tone/SKILL.zh.md",
        content: skill("tone", "中文说明", "中文正文"),
      },
    ];
    expect(loadSkillSet({ bundled: files }, "zh").skills[0]?.body).toBe(
      "中文正文",
    );
    expect(loadSkillSet({ bundled: files }, "en").skills[0]?.body).toBe(
      "English body",
    );
  });

  it("uses the only file there is when a locale variant is missing", () => {
    // A user who writes only Chinese gets Chinese in both locales, because it
    // is the only text that exists — honest, and better than nothing.
    const { skills } = loadSkillSet(
      {
        project: [
          {
            path: "p/tone/SKILL.md",
            content: skill("tone", "只有中文", "正文"),
          },
        ],
      },
      "zh",
    );
    expect(skills[0]?.body).toBe("正文");
  });

  it("ignores a file in a skill directory that is not a SKILL file", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        { path: "p/tone/SKILL.md", content: skill("tone") },
        { path: "p/tone/notes.md", content: "scratch" },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
  });

  it("normalizes CRLF so a Windows-authored skill parses", () => {
    const { skills, diagnostics } = loadSkillSet({
      project: [
        {
          path: "p/tone/SKILL.md",
          content: "---\r\nname: tone\r\ndescription: d\r\n---\r\n\r\nbody\r\n",
        },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(skills[0]?.body).toBe("body");
  });

  it("accepts a Windows path separator when deriving the directory name", () => {
    const { skills } = loadSkillSet({
      project: [
        {
          path: "C:\\paper\\.lemmaria\\skills\\house-style\\SKILL.md",
          content: "---\ndescription: d\n---\nb\n",
        },
      ],
    });
    expect(skills[0]?.name).toBe("house-style");
  });

  it("returns an empty set for no sources at all", () => {
    expect(loadSkillSet({})).toEqual({
      skills: [],
      diagnostics: [],
      disabled: [],
    });
  });
});

describe("SKILL_DIAGNOSTIC_LEVEL — whether a diagnostic means the skill is gone", () => {
  // The view has to render a note one of two ways, and until E1's gate record
  // it decided for itself: `skills-ui.ts` kept its own set of "info" codes,
  // the second review round added a third code to the union, and the set never
  // learned about it — so a skill that loaded was reported as one that could
  // not be loaded. The level belongs beside the union, where a new code cannot
  // be added without answering the question.

  it("is a total map, so a new code cannot compile without a level", () => {
    // The `Record<SkillDiagnosticCode, …>` annotation is the proof: a code
    // added to the union without a level here fails `pnpm typecheck`. This
    // asserts the runtime half of the same claim — nine codes, no gaps.
    for (const level of Object.values(SKILL_DIAGNOSTIC_LEVEL)) {
      expect(["info", "failure"]).toContain(level);
    }
    expect(Object.keys(SKILL_DIAGNOSTIC_LEVEL).length).toBe(9);
  });

  it("levels the three notes as info — the skill loaded, with something to know", () => {
    expect(SKILL_DIAGNOSTIC_LEVEL.description_truncated).toBe("info");
    expect(SKILL_DIAGNOSTIC_LEVEL.routes_outside_references).toBe("info");
    // The one the view got wrong. ADR 0046 calls it Info, `loader.ts`'s own
    // doc comment calls it Info, and its message says "The skill still loads".
    expect(SKILL_DIAGNOSTIC_LEVEL.references_not_followed).toBe("info");
  });

  it("levels a rejection as a failure — including the budget's omission rung", () => {
    expect(SKILL_DIAGNOSTIC_LEVEL.parse_failed).toBe("failure");
    expect(SKILL_DIAGNOSTIC_LEVEL.invalid_name).toBe("failure");
    expect(SKILL_DIAGNOSTIC_LEVEL.missing_description).toBe("failure");
    expect(SKILL_DIAGNOSTIC_LEVEL.description_too_long).toBe("failure");
    expect(SKILL_DIAGNOSTIC_LEVEL.empty_body).toBe("failure");
    // `over_budget` is the one note about a skill that is genuinely NOT in the
    // loaded set — the ladder omitted it — so it is a failure, not a note.
    expect(SKILL_DIAGNOSTIC_LEVEL.over_budget).toBe("failure");
  });
});
