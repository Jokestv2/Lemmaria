import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SKILL_REFERENCES, listSkills } from "../../src/skills/library.js";

let bundled: string;
let venue: string;
let user: string;
let project: string;

const write = async (
  root: string,
  dir: string,
  file: string,
  body: string,
): Promise<void> => {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, file), body, "utf8");
};

const doc = (description: string, body: string): string =>
  `---\ndescription: ${description}\n---\n\n${body}\n`;

beforeEach(async () => {
  bundled = await mkdtemp(join(tmpdir(), "lemmaria-skills-bundled-"));
  venue = await mkdtemp(join(tmpdir(), "lemmaria-skills-venue-"));
  user = await mkdtemp(join(tmpdir(), "lemmaria-skills-user-"));
  project = await mkdtemp(join(tmpdir(), "lemmaria-skills-project-"));
});

describe("listSkills references and the user layer (E1, ADR 0046)", () => {
  it("reads a skill's references/*.md as sorted NAMES", async () => {
    await write(project, "tone", "SKILL.md", doc("tone", "b"));
    // Written out of order: `readdir` order is not guaranteed and this list
    // reaches a tool result, so the loaded set must be deterministic across
    // platforms exactly as `readLayer` already sorts its entries.
    await write(project, "tone/references", "worked-examples.md", "e");
    await write(project, "tone/references", "taxonomy.md", "t");
    const { skills } = await listSkills({ projectDir: project });
    expect(skills[0]?.references).toEqual([
      "taxonomy.md",
      "worked-examples.md",
    ]);
  });

  it("takes .md files one level down only — not scripts, not assets, not subdirectories", async () => {
    await write(project, "tone", "SKILL.md", doc("tone", "b"));
    await write(project, "tone/references", "guide.md", "g");
    await write(project, "tone/references", "fetch.py", "print(1)");
    await write(project, "tone/references", "figure.png", "not-really");
    await write(project, "tone/references/deeper", "nested.md", "n");
    const { skills } = await listSkills({ projectDir: project });
    // Only `references/` is exposed at all, and only its .md files: scripts
    // and assets are executable or binary, and invariant 2 says capability
    // arrives as a named tool, never as a file a skill smuggled in.
    expect(skills[0]?.references).toEqual(["guide.md"]);
  });

  it("a skill with no references/ directory gets [] and NO diagnostic", async () => {
    // The venue library's rule: only a CLAIMED thing can be malformed. Most
    // skills have no references, and a note about each would be noise.
    await write(project, "tone", "SKILL.md", doc("tone", "b"));
    const { skills, diagnostics } = await listSkills({ projectDir: project });
    expect(skills[0]?.references).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("caps the manifest so a skill cannot make its own list unbounded", async () => {
    await write(project, "tone", "SKILL.md", doc("tone", "b"));
    for (let i = 0; i < MAX_SKILL_REFERENCES + 8; i++) {
      // Zero-padded so sort order is the obvious one and the cap is testable.
      await write(
        project,
        "tone/references",
        `r${String(i).padStart(3, "0")}.md`,
        "x",
      );
    }
    const { skills } = await listSkills({ projectDir: project });
    expect(skills[0]?.references).toHaveLength(MAX_SKILL_REFERENCES);
    expect(skills[0]?.references[0]).toBe("r000.md");
  });

  it("the manifest carries NAMES ONLY — no separator, no temp path", async () => {
    // This list reaches a tool result. A path in it would be a path the model
    // can feed to read_span, which is exactly what ADR 0028 §D3 closed.
    await write(project, "tone", "SKILL.md", doc("tone", "b"));
    await write(project, "tone/references", "taxonomy.md", "t");
    const { skills } = await listSkills({ projectDir: project });
    for (const name of skills[0]?.references ?? []) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain(project);
    }
  });

  it("REFUSES a symlinked references/ — the containment hole review found", async () => {
    // `readdir` follows a symlink on the final path component, so a pack
    // carrying `references -> somewhere-else` would publish a manifest of .md
    // files from anywhere on disk — and `load_skill` would then serve them,
    // because the manifest is the gate and the manifest would say they belong.
    // A third-party pack cloned from git can carry exactly this, and the whole
    // point of the `user` source is that users drop such packs in.
    const outside = await mkdtemp(join(tmpdir(), "lemmaria-outside-"));
    await writeFile(join(outside, "secret.md"), "TOP SECRET", "utf8");
    await write(project, "evil", "SKILL.md", doc("evil", "b"));

    try {
      await symlink(outside, join(project, "evil", "references"), "junction");
    } catch {
      // Unprivileged Windows without Developer Mode cannot create links at
      // all. Skipping is honest; asserting nothing would not be.
      return;
    }

    const { skills, diagnostics } = await listSkills({ projectDir: project });
    expect(skills[0]?.name).toBe("evil");
    // The skill still LOADS — a symlinked references/ is not a malformed
    // skill, it is just one Lemmaria will not follow. It publishes nothing,
    // so there is no name for the model to ask back.
    expect(skills[0]?.references).toEqual([]);
    // **And it SAYS so.** Refusing is right; refusing silently leaves a router
    // with nothing behind it and no way for the user to find out, which is the
    // exact failure this subsystem exists to remove (second review round).
    const note = diagnostics.find((d) => d.code === "references_not_followed");
    expect(note).toBeDefined();
    expect(note?.message).toContain("evil");
  });

  it("a skill with NO references/ gets no refusal note — absent is not refused", async () => {
    // The distinction the flag exists for: "has none" and "has some Lemmaria
    // will not read" are the same empty array and very different things.
    await write(project, "plain", "SKILL.md", doc("plain", "b"));
    const { diagnostics } = await listSkills({ projectDir: project });
    expect(
      diagnostics.filter((d) => d.code === "references_not_followed"),
    ).toEqual([]);
  });

  it("loads a user layer at source `user`, between venue and project", async () => {
    await write(venue, "tone", "SKILL.md", doc("from the venue", "v"));
    await write(user, "tone", "SKILL.md", doc("from the user", "u"));
    await write(user, "mine", "SKILL.md", doc("only mine", "m"));
    const { skills } = await listSkills({
      venueDir: venue,
      userDir: user,
      projectDir: project,
    });
    expect(skills.find((s) => s.name === "mine")?.source).toBe("user");
    expect(skills.find((s) => s.name === "tone")?.description).toBe(
      "from the user",
    );
  });

  it("passes the disabled selection through to the loader", async () => {
    await write(user, "tone", "SKILL.md", doc("from the user", "u"));
    await write(user, "mine", "SKILL.md", doc("only mine", "m"));
    const { skills } = await listSkills({
      userDir: user,
      disabled: [{ name: "tone" }],
    });
    expect(skills.map((s) => s.name)).toEqual(["mine"]);
  });
});

describe("listSkills (ADR 0028)", () => {
  it("reads one level of skill directories from each root", async () => {
    await write(bundled, "tone", "SKILL.md", doc("bundled tone", "b"));
    await write(venue, "venue-style", "SKILL.md", doc("venue style", "v"));
    await write(project, "mine", "SKILL.md", doc("my own", "m"));
    const { skills, diagnostics } = await listSkills({
      bundledDir: bundled,
      venueDir: venue,
      projectDir: project,
    });
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name).sort()).toEqual([
      "mine",
      "tone",
      "venue-style",
    ]);
    expect(skills.find((s) => s.name === "mine")?.source).toBe("project");
    expect(skills.find((s) => s.name === "venue-style")?.source).toBe("venue");
    expect(skills.find((s) => s.name === "tone")?.source).toBe("bundled");
  });

  it("treats a missing root as an empty layer, not an error", async () => {
    await write(project, "mine", "SKILL.md", doc("my own", "m"));
    const { skills, diagnostics } = await listSkills({
      bundledDir: join(bundled, "does-not-exist"),
      projectDir: project,
    });
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["mine"]);
  });

  it("treats an omitted root as an empty layer", async () => {
    const { skills, diagnostics } = await listSkills({});
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("skips a directory with no SKILL.md silently", async () => {
    // The venue library's rule (`venue/library.ts:62`): only a CLAIMED skill
    // can be malformed. A notes folder is not a broken skill.
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, "notes", "README.md"), "hi", "utf8");
    const { skills, diagnostics } = await listSkills({ projectDir: project });
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("ignores loose files directly under a root", async () => {
    await writeFile(join(project, "SKILL.md"), doc("d", "b"), "utf8");
    const { skills } = await listSkills({ projectDir: project });
    expect(skills).toEqual([]);
  });

  it("does not descend past one level", async () => {
    // §D1: the three roots are fixed and small, so recursion buys nothing.
    await mkdir(join(project, "outer", "inner"), { recursive: true });
    await writeFile(
      join(project, "outer", "inner", "SKILL.md"),
      doc("d", "b"),
      "utf8",
    );
    const { skills } = await listSkills({ projectDir: project });
    expect(skills).toEqual([]);
  });

  it("carries the locale through to the file choice", async () => {
    await write(bundled, "tone", "SKILL.md", doc("English", "English body"));
    await write(bundled, "tone", "SKILL.zh.md", doc("中文", "中文正文"));
    const zh = await listSkills({ bundledDir: bundled, locale: "zh" });
    expect(zh.skills[0]?.body).toBe("中文正文");
    const en = await listSkills({ bundledDir: bundled, locale: "en" });
    expect(en.skills[0]?.body).toBe("English body");
  });

  it("defaults to en when no locale is given", async () => {
    await write(bundled, "tone", "SKILL.md", doc("English", "English body"));
    await write(bundled, "tone", "SKILL.zh.md", doc("中文", "中文正文"));
    const { skills } = await listSkills({ bundledDir: bundled });
    expect(skills[0]?.body).toBe("English body");
  });

  it("reports a malformed skill through to the caller", async () => {
    await write(project, "broken", "SKILL.md", "---\nname: [oops\n---\nb\n");
    const { skills, diagnostics } = await listSkills({ projectDir: project });
    expect(skills).toEqual([]);
    expect(diagnostics[0]?.code).toBe("parse_failed");
    expect(diagnostics[0]?.source).toBe("project");
  });

  it("applies precedence across roots on disk, not just in memory", async () => {
    await write(bundled, "tone", "SKILL.md", doc("bundled", "b"));
    await write(project, "tone", "SKILL.md", doc("project", "p"));
    const { skills } = await listSkills({
      bundledDir: bundled,
      projectDir: project,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("project");
  });
});
