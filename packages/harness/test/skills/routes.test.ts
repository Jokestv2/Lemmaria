import { describe, expect, it } from "vitest";
import { routesOutsideReferences } from "../../src/skills/routes.js";

describe("routesOutsideReferences (E1, ADR 0046)", () => {
  it("names the unreachable directories a body points at, deduplicated and sorted", () => {
    const body = [
      "Run scripts/fetch.py to collect the corpus.",
      "Then apply templates/log.md and rerun scripts/fetch.py.",
    ].join("\n");
    expect(routesOutsideReferences(body)).toEqual(["scripts", "templates"]);
  });

  it("matches a Markdown link, which is how these packs actually write it", () => {
    expect(
      routesOutsideReferences("See [the guide](scripts/guide.md) first."),
    ).toEqual(["scripts"]);
  });

  it("matches assets/ and the other named siblings", () => {
    const body = "Open assets/logo.png, then agents/reviewer.md.";
    expect(routesOutsideReferences(body)).toEqual(["agents", "assets"]);
  });

  // --- The false-positive tests, which are the point of this module. ---

  it("does NOT fire on ordinary English words", () => {
    // STRAT-1's own substring scan flagged six skills for `verify` that were
    // all the ordinary English word. A false positive here would train the
    // user to ignore the ONE signal that catches the silent-summary failure,
    // which is worse than having no signal at all.
    const body = [
      "Verify each claim before citing it.",
      "Scripts are provided elsewhere; do not rely on them.",
      "Use the assets and/or templates your lab already has.",
      "Consult references for the full taxonomy.",
      "Read the templates section of the venue guide.",
    ].join("\n");
    expect(routesOutsideReferences(body)).toEqual([]);
  });

  it("does NOT fire on references/, which IS reachable", () => {
    expect(
      routesOutsideReferences("See references/taxonomy.md for the full list."),
    ).toEqual([]);
  });

  it("does NOT fire on a URL that merely contains one of the names", () => {
    // A body citing a repository is not routing to a local directory.
    const body = "Adapted from https://example.org/scripts/fetch.py (MIT).";
    expect(routesOutsideReferences(body)).toEqual([]);
  });

  it("does NOT fire on a bare directory name with no file after the slash", () => {
    expect(routesOutsideReferences("Everything lives under scripts/.")).toEqual(
      [],
    );
    expect(routesOutsideReferences("Put it in templates/")).toEqual([]);
  });

  it("matches the relative forms the real pack actually uses (E1, review)", () => {
    // `nature-paper-card` routes to four SKILL_DIR/scripts/*.py files. The
    // first pattern rejected any `/` before the name to keep URLs out, and so
    // reported only `static` for that skill — telling the user about one
    // unreachable directory and not about the four scripts it depends on.
    expect(routesOutsideReferences("Run ./scripts/fetch.py")).toEqual([
      "scripts",
    ]);
    expect(
      routesOutsideReferences("python SKILL_DIR/scripts/audit_paper_card.py"),
    ).toEqual(["scripts"]);
    expect(routesOutsideReferences("See Scripts/Fetch.py")).toEqual([
      "scripts",
    ]);
  });

  it("still does NOT fire on a name that merely ends in a directory name", () => {
    expect(routesOutsideReferences("see my-scripts/x.md")).toEqual([]);
    expect(routesOutsideReferences("see notscripts/x.md")).toEqual([]);
  });

  it("does NOT fire on a URL however it is spelled", () => {
    for (const body of [
      "Adapted from https://example.org/scripts/fetch.py (MIT).",
      "See https://github.com/o/r/blob/main/scripts/check-deps.mjs",
      "http://x.test/a?p=templates/log.md",
      // Schemeless and protocol-relative, which the widened lookbehind
      // re-admitted — an attribution line of the first shape is common in a
      // third-party SKILL.md (second review round).
      "Adapted from github.com/openai/codex/scripts/build.sh",
      "See www.example.com/assets/logo.png",
      "See //cdn.example.org/assets/app.js",
    ]) {
      expect(routesOutsideReferences(body)).toEqual([]);
    }
  });

  it("a dotless first segment is still a LOCAL route, not a host", () => {
    // The discriminator is the dot: `docs/scripts/x` and `SKILL_DIR/scripts/x`
    // are this skill's own tree, `github.com/…/scripts/x` is somebody else's.
    expect(routesOutsideReferences("see docs/scripts/build.sh")).toEqual([
      "scripts",
    ]);
    expect(routesOutsideReferences("run SKILL_DIR/scripts/x.py")).toEqual([
      "scripts",
    ]);
  });

  it("returns [] for an empty body", () => {
    expect(routesOutsideReferences("")).toEqual([]);
  });
});
