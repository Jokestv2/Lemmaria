import { describe, expect, it } from "vitest";
import { IgnoreStack, parseGitignore } from "../../src/engine/gitignore.js";

function stack(layers: [dirRel: string, content: string][]): IgnoreStack {
  const s = new IgnoreStack();
  for (const [dirRel, content] of layers) s.push(dirRel, content);
  return s;
}

describe("parseGitignore", () => {
  it("skips blank lines and comments", () => {
    expect(parseGitignore("\n# a comment\n\n")).toEqual([]);
  });

  it("marks negation and dir-only rules", () => {
    const rules = parseGitignore("!keep.log\nbuild/\n");
    expect(rules).toHaveLength(2);
    expect(rules[0]?.negated).toBe(true);
    expect(rules[0]?.dirOnly).toBe(false);
    expect(rules[1]?.negated).toBe(false);
    expect(rules[1]?.dirOnly).toBe(true);
  });
});

describe("IgnoreStack (the documented ADR 0019 subset)", () => {
  it("*.log ignores at any depth", () => {
    const s = stack([["", "*.log\n"]]);
    expect(s.ignores("a.log", false)).toBe(true);
    expect(s.ignores("sub/b.log", false)).toBe(true);
    expect(s.ignores("a.txt", false)).toBe(false);
  });

  it("build/ ignores the directory's contents but not a file named build", () => {
    const s = stack([["", "build/\n"]]);
    expect(s.ignores("build", true)).toBe(true);
    expect(s.ignores("build/x.txt", false)).toBe(true);
    expect(s.ignores("build", false)).toBe(false);
  });

  it("/top.txt is anchored to the .gitignore's directory", () => {
    const s = stack([["", "/top.txt\n"]]);
    expect(s.ignores("top.txt", false)).toBe(true);
    expect(s.ignores("sub/top.txt", false)).toBe(false);
  });

  it("a pattern containing a slash is anchored", () => {
    const s = stack([["", "docs/*.tmp\n"]]);
    expect(s.ignores("docs/a.tmp", false)).toBe(true);
    expect(s.ignores("sub/docs/a.tmp", false)).toBe(false);
  });

  it("!negation un-ignores, last match wins", () => {
    const s = stack([["", "*.log\n!keep.log\n"]]);
    expect(s.ignores("other.log", false)).toBe(true);
    expect(s.ignores("keep.log", false)).toBe(false);
    expect(s.ignores("sub/keep.log", false)).toBe(false);
  });

  it("** crosses directories", () => {
    const s = stack([["", "docs/**/*.tmp\n"]]);
    expect(s.ignores("docs/a/b.tmp", false)).toBe(true);
    expect(s.ignores("docs/b.tmp", false)).toBe(true);
    expect(s.ignores("src/a.tmp", false)).toBe(false);
  });

  it("? matches exactly one non-slash character", () => {
    const s = stack([["", "a?.txt\n"]]);
    expect(s.ignores("ab.txt", false)).toBe(true);
    expect(s.ignores("a.txt", false)).toBe(false);
    expect(s.ignores("a/b.txt", false)).toBe(false);
  });

  it("nested .gitignore layers: a child negation overrides the root rule beneath it", () => {
    const s = stack([
      ["", "*.csv\n"],
      ["data", "!small.csv\n"],
    ]);
    expect(s.ignores("data/big.csv", false)).toBe(true);
    expect(s.ignores("data/small.csv", false)).toBe(false);
    // The child layer applies only beneath its directory.
    expect(s.ignores("small.csv", false)).toBe(true);
  });

  it("an ignored directory ignores everything beneath it", () => {
    const s = stack([["", "out/\n"]]);
    expect(s.ignores("out/deep/nested/file.txt", false)).toBe(true);
  });
});
