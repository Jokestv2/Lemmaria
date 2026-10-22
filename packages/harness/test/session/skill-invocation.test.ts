import { describe, expect, it } from "vitest";
import type { Skill } from "../../src/contracts/skills.js";
import { parseSkillInvocations } from "../../src/session/skill-invocation.js";

const s = (name: string, body: string): Skill => ({
  name,
  description: "d",
  body,
  source: "project",
  path: `p/${name}/SKILL.md`,
  references: [],
});

const skills = [
  s("tone", "ALWAYS use active voice."),
  s("cite", "Cite well."),
  s("venue-rules", "Follow the venue."),
];

const names = (text: string) =>
  parseSkillInvocations(text, skills).skills.map((k) => k.name);

describe("parseSkillInvocations (ADR 0028 §D6 → ADR 0047 → ADR 0050)", () => {
  it("returns the named skill and the request, with the token removed", () => {
    const r = parseSkillInvocations("/skill:tone rewrite the abstract", skills);
    expect(r.skills.map((k) => k.name)).toEqual(["tone"]);
    expect(r.request).toBe("rewrite the abstract");
  });

  it("returns a REQUEST TO LOAD, never expanded text", () => {
    // The caller decides how each body reaches the model, so it can stay a real
    // tool exchange the rebuild path already replays.
    const r = parseSkillInvocations("/skill:tone go", skills);
    expect(r).not.toHaveProperty("content");
    expect(r.skills[0]?.body).toBe("ALWAYS use active voice.");
  });

  it("leaves ordinary text alone, as an EMPTY list rather than undefined", () => {
    // No failure here, only a count — a caller that branches on
    // undefined-vs-empty gets the empty case wrong eventually.
    const r = parseSkillInvocations("rewrite the abstract", skills);
    expect(r.skills).toEqual([]);
    expect(r.request).toBe("rewrite the abstract");
  });

  it("an unknown skill is prose, not an error, and KEEPS its place", () => {
    // The model still sees the catalogue and can call load_skill itself, so a
    // typo degrades to a question rather than to an error.
    const r = parseSkillInvocations("/skill:nope do it", skills);
    expect(r.skills).toEqual([]);
    expect(r.request).toBe("/skill:nope do it");
  });

  // ─── ADR 0050: anywhere in the message, and more than one ───

  it("finds a skill MID-MESSAGE, which ADR 0047 refused", () => {
    // The behaviour the operator confirmed against Codex's VS Code extension.
    const r = parseSkillInvocations("please /skill:tone the intro", skills);
    expect(r.skills.map((k) => k.name)).toEqual(["tone"]);
    expect(r.request).toBe("please the intro");
  });

  it("finds SEVERAL, in the order they were named", () => {
    // The operator's own case: a house style AND a venue's rules, one message.
    expect(names("/skill:tone and also /skill:venue-rules please")).toEqual([
      "tone",
      "venue-rules",
    ]);
    expect(names("first /skill:cite then /skill:tone")).toEqual([
      "cite",
      "tone",
    ]);
  });

  it("names one skill twice and loads it ONCE", () => {
    // A repeat is a typo, not a request to load the body twice — and the second
    // exchange would be bytes the model has already been given.
    expect(names("/skill:tone x /skill:tone y")).toEqual(["tone"]);
  });

  it("strips every resolved token from the request, keeping the prose", () => {
    const r = parseSkillInvocations(
      "rewrite /skill:tone the intro /skill:cite carefully",
      skills,
    );
    expect(r.request).toBe("rewrite the intro carefully");
  });

  it("keeps an unknown token while stripping a known one beside it", () => {
    const r = parseSkillInvocations("/skill:tone and /skill:nope", skills);
    expect(r.skills.map((k) => k.name)).toEqual(["tone"]);
    expect(r.request).toBe("and /skill:nope");
  });

  it("does NOT fire on a slash inside a word — a URL is not an invocation", () => {
    // The half that did not move, and the reason the composer's `boundary`
    // anchor and this regex are the same rule stated twice.
    expect(names("see http://x/skill:tone for details")).toEqual([]);
    expect(names("and/skill:tone")).toEqual([]);
  });

  it("fires at the end of a message with no trailing space", () => {
    expect(names("polish this /skill:tone")).toEqual(["tone"]);
  });

  it("does not fire on a longer word that merely starts the same", () => {
    // `(?=\s|$)` is what makes this a name rather than a prefix of one.
    expect(names("/skill:toneing")).toEqual([]);
    expect(names("/skill:tone-ish")).toEqual([]);
  });

  it("keeps a multi-line request's lines", () => {
    // Only the run a removal leaves behind is collapsed, never `\s+`.
    const r = parseSkillInvocations("/skill:tone fix\nthis\nplease", skills);
    expect(r.request).toBe("fix\nthis\nplease");
  });
});
