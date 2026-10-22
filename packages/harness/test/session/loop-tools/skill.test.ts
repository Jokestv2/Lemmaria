import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../../../src/contracts/skills.js";
import {
  MAX_REFERENCE_LOADS_PER_TASK,
  SKILL_BODY_MAX_LINES,
  createLoadSkillTool,
} from "../../../src/session/loop-tools/skill.js";

const s = (name: string, body: string): Skill => ({
  name,
  description: "d",
  body,
  source: "project",
  path: `p/${name}/SKILL.md`,
  references: [],
});

/**
 * A real skill directory on disk, because the reference path is resolved
 * against `dirname(skill.path)` and a fake path cannot exercise containment.
 */
async function onDisk(
  name: string,
  references: Record<string, string>,
): Promise<Skill> {
  const root = await mkdtemp(join(tmpdir(), "lemmaria-skill-refs-"));
  const dir = join(root, name);
  await mkdir(join(dir, "references"), { recursive: true });
  for (const [file, text] of Object.entries(references)) {
    await writeFile(join(dir, "references", file), text, "utf8");
  }
  return {
    name,
    description: "d",
    body: "See references/taxonomy.md.",
    source: "project",
    path: join(dir, "SKILL.md"),
    references: Object.keys(references).sort(),
  };
}

describe("load_skill (ADR 0028)", () => {
  it("returns the body, its name and its source", async () => {
    const tool = createLoadSkillTool({
      skills: [s("tone", "Use active voice.")],
    });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatchObject({
      name: "tone",
      source: "project",
      text: "Use active voice.",
    });
  });

  it("never hands the model a path", async () => {
    // §D3, the divergence from Pi: a path in the model's hands is a path it can
    // feed to read_span, which would turn a skills feature into a way to widen
    // the read surface (invariant 2).
    const tool = createLoadSkillTool({ skills: [s("tone", "b")] });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok && JSON.stringify(r.value)).not.toContain("SKILL.md");
    expect(r.ok && JSON.stringify(r.value)).not.toContain("p/tone");
  });

  it("an unknown name is not_found and lists what IS available", async () => {
    const tool = createLoadSkillTool({
      skills: [s("tone", "b"), s("voice", "b")],
    });
    const r = await tool.invoke({ name: "nope" });
    expect(!r.ok && r.error.code).toBe("not_found");
    expect(!r.ok && r.error.message).toContain("tone, voice");
  });

  it("says `none` rather than an empty list when nothing is loaded", async () => {
    const tool = createLoadSkillTool({ skills: [] });
    const r = await tool.invoke({ name: "nope" });
    expect(!r.ok && r.error.message).toContain("none");
  });

  it("malformed args are invalid, never a throw", async () => {
    const tool = createLoadSkillTool({ skills: [s("tone", "b")] });
    expect((await tool.invoke({})).ok).toBe(false);
    expect((await tool.invoke({ name: 42 })).ok).toBe(false);
    expect((await tool.invoke({ name: "" })).ok).toBe(false);
    const r = await tool.invoke(undefined);
    expect(!r.ok && r.error.code).toBe("invalid");
  });

  it("a fitting body comes back byte-identical, with no truncation keys", async () => {
    // ADR 0029's rule: a result that fits stays byte-identical.
    const tool = createLoadSkillTool({ skills: [s("tone", "one\ntwo")] });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok && r.value).not.toHaveProperty("truncated");
    expect(r.ok && r.value).not.toHaveProperty("total_lines");
    expect(r.ok && (r.value as { text: string }).text).toBe("one\ntwo");
  });

  it("an over-long body is truncated HEAD-first and says how much was cut", async () => {
    const long = Array.from(
      { length: SKILL_BODY_MAX_LINES + 50 },
      (_, i) => `line ${i}`,
    ).join("\n");
    const tool = createLoadSkillTool({ skills: [s("tone", long)] });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok).toBe(true);
    const v = r.ok ? (r.value as Record<string, unknown>) : {};
    expect(v.truncated).toBe(true);
    expect(v.truncated_by).toBe("lines");
    expect(v.total_lines).toBe(SKILL_BODY_MAX_LINES + 50);
    expect(v.shown_lines).toBe(SKILL_BODY_MAX_LINES);
    // HEAD, not tail: a skill states its rules first and elaborates after.
    expect(String(v.text).startsWith("line 0")).toBe(true);
  });

  it("is retrieval and may run in parallel — it is pure and emits nothing", () => {
    const tool = createLoadSkillTool({ skills: [] });
    expect(tool.name).toBe("load_skill");
    expect(tool.category).toBe("retrieval");
    expect(tool.executionMode).toBe("parallel");
  });

  it("advertises a spec the model can form a call against", () => {
    const tool = createLoadSkillTool({ skills: [] });
    expect(tool.spec.name).toBe("load_skill");
    // `reference` is OPTIONAL: invariant 2 gains no tool, `load_skill` gains
    // one argument, so `required` must not grow.
    expect((tool.spec.parameters as { required?: string[] }).required).toEqual([
      "name",
    ]);
    expect(
      (tool.spec.parameters as { properties: Record<string, unknown> })
        .properties.reference,
    ).toBeDefined();
  });
});

describe("load_skill references (E1, ADR 0046)", () => {
  it("a plain load returns the manifest alongside the body", async () => {
    const skill = await onDisk("tone", {
      "taxonomy.md": "t",
      "worked-examples.md": "w",
    });
    const tool = createLoadSkillTool({ skills: [skill] });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok && (r.value as { references: string[] }).references).toEqual([
      "taxonomy.md",
      "worked-examples.md",
    ]);
  });

  it("a skill with an empty manifest omits the key entirely", async () => {
    // ADR 0029's absent-when-empty rule, which the body's truncation report
    // already follows: a result that has nothing to say says nothing.
    const tool = createLoadSkillTool({ skills: [s("tone", "b")] });
    const r = await tool.invoke({ name: "tone" });
    expect(r.ok && r.value).not.toHaveProperty("references");
  });

  it("returns a named reference's text", async () => {
    const skill = await onDisk("tone", { "taxonomy.md": "The taxonomy." });
    const tool = createLoadSkillTool({ skills: [skill] });
    const r = await tool.invoke({ name: "tone", reference: "taxonomy.md" });
    expect(r.ok).toBe(true);
    expect(r.ok && (r.value as { text: string }).text).toBe("The taxonomy.");
    expect(r.ok && (r.value as { reference: string }).reference).toBe(
      "taxonomy.md",
    );
  });

  it("head-truncates an over-long reference, as the body already is", async () => {
    const long = Array.from(
      { length: SKILL_BODY_MAX_LINES + 50 },
      (_, i) => `line ${i}`,
    ).join("\n");
    const skill = await onDisk("tone", { "big.md": long });
    const tool = createLoadSkillTool({ skills: [skill] });
    const r = await tool.invoke({ name: "tone", reference: "big.md" });
    const v = r.ok ? (r.value as Record<string, unknown>) : {};
    expect(v.truncated).toBe(true);
    // HEAD, not tail: a reference states its rules first, same as a body.
    expect(String(v.text).startsWith("line 0")).toBe(true);
  });

  it("REFUSES every reference that is not a manifest member — the invariant-2 guard", async () => {
    // Membership of the manifest is the gate. Path arithmetic is only how the
    // file is then found, so none of these ever reaches the disk: they are
    // rejected on the list, not on a normalized path that has to be trusted.
    const skill = await onDisk("tone", { "taxonomy.md": "t" });
    const tool = createLoadSkillTool({ skills: [skill] });
    for (const reference of [
      "../../../etc/passwd",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "subdir/x.md",
      "nope.md",
      "./taxonomy.md",
      "taxonomy.md\u0000.png",
    ]) {
      const r = await tool.invoke({ name: "tone", reference });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("not_found");
      // Name what IS there, so the model can act rather than only retry.
      expect(!r.ok && r.error.message).toContain("taxonomy.md");
    }
  });

  it("never hands the model a path, on EITHER call shape (§D3)", async () => {
    // The §D3 assertion extended to the reference call. If this ever fails,
    // the design's central claim has failed and the answer is a BLOCKED exit,
    // never a relaxed assertion.
    //
    // **`text` is excluded, and that exclusion is the point, not a hole.**
    // `text` is the author's own prose, and 18 of 19 bodies in the surveyed
    // pack are routers that SAY "see references/taxonomy.md" — passing that
    // through verbatim is the feature. What §D3 forbids is LEMMARIA handing
    // over a filesystem location, so the assertion is that every key Lemmaria
    // itself fills in is free of separators and of this skill's real directory.
    const skill = await onDisk("tone", { "taxonomy.md": "t" });
    const tool = createLoadSkillTool({ skills: [skill] });
    const dir = dirname(skill.path);
    for (const args of [
      { name: "tone" },
      { name: "tone", reference: "taxonomy.md" },
    ]) {
      const r = await tool.invoke(args);
      expect(r.ok).toBe(true);
      const whole = r.ok ? JSON.stringify(r.value) : "";
      expect(whole).not.toContain("SKILL.md");
      expect(whole).not.toContain(dir);

      const lemmariaWrote = JSON.stringify({
        ...(r.ok ? (r.value as Record<string, unknown>) : {}),
        text: "",
      });
      expect(lemmariaWrote).not.toContain("/");
      expect(lemmariaWrote).not.toContain("\\");
    }
  });

  it("caps how many references one task may load", async () => {
    const skill = await onDisk("tone", { "taxonomy.md": "t" });
    // Per TOOL INSTANCE, because `createLoadSkillTool` is constructed per task.
    const tool = createLoadSkillTool({ skills: [skill] });
    for (let i = 0; i < MAX_REFERENCE_LOADS_PER_TASK; i++) {
      const r = await tool.invoke({ name: "tone", reference: "taxonomy.md" });
      expect(r.ok).toBe(true);
    }
    const over = await tool.invoke({ name: "tone", reference: "taxonomy.md" });
    expect(!over.ok && over.error.code).toBe("invalid");
    expect(!over.ok && over.error.message).toContain(
      String(MAX_REFERENCE_LOADS_PER_TASK),
    );
    // The cap is on REFERENCES, not on the body: a plain load still works.
    expect((await tool.invoke({ name: "tone" })).ok).toBe(true);
  });

  it("the cap holds when the whole batch runs CONCURRENTLY", async () => {
    // This tool is `parallel`, so a batch really does run copies at once.
    // The counter used to be checked before the `await readFile` and
    // incremented after it, so every member of a batch could pass the gate at
    // 7 and then read — overshooting a cap of 8 (found by review).
    const skill = await onDisk("tone", { "taxonomy.md": "t" });
    const tool = createLoadSkillTool({ skills: [skill] });
    const results = await Promise.all(
      Array.from({ length: MAX_REFERENCE_LOADS_PER_TASK + 6 }, () =>
        tool.invoke({ name: "tone", reference: "taxonomy.md" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(
      MAX_REFERENCE_LOADS_PER_TASK,
    );
    expect(results.filter((r) => !r.ok)).toHaveLength(6);
  });

  it("a reference deleted between load and call is a typed not_found, never a throw", async () => {
    const skill = await onDisk("tone", {});
    // Claimed by the manifest but absent from disk — the race a long task hits.
    const claimed: Skill = { ...skill, references: ["ghost.md"] };
    const tool = createLoadSkillTool({ skills: [claimed] });
    const r = await tool.invoke({ name: "tone", reference: "ghost.md" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("not_found");
  });

  it("a malformed reference argument is invalid, never a throw", async () => {
    const tool = createLoadSkillTool({ skills: [s("tone", "b")] });
    const r = await tool.invoke({ name: "tone", reference: 42 });
    expect(!r.ok && r.error.code).toBe("invalid");
  });
});
