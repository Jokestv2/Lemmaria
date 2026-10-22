import { describe, expect, it } from "vitest";
import { parseBibtex, resolveBibPaths } from "../../src/latex/bib.js";

describe("parseBibtex", () => {
  it("parses type, key, and brace/quote/bare field values", () => {
    const src = `@Article{smith2020,
  title = {A Study of {Deep} Nets},
  author = "Smith, Jane and Doe, John",
  year = 2020,
}`;
    const [e] = parseBibtex(src);
    expect(e).toMatchObject({ key: "smith2020", type: "article", line: 1 });
    expect(e?.fields.title).toBe("A Study of {Deep} Nets");
    expect(e?.fields.author).toBe("Smith, Jane and Doe, John");
    expect(e?.fields.year).toBe("2020");
  });

  it("keeps duplicate keys and skips @string/@comment/@preamble", () => {
    const src = `@string{acl = "ACL"}
@comment{ignore me}
@article{dup, title={A}}
@article{dup, title={B}}`;
    expect(parseBibtex(src).map((e) => e.key)).toEqual(["dup", "dup"]);
  });

  it("records the 1-based line of each entry", () => {
    const src = `@article{a, title={A}}

@article{b, title={B}}`;
    expect(parseBibtex(src).map((e) => e.line)).toEqual([1, 3]);
  });

  it("does not throw on a truncated entry", () => {
    expect(() => parseBibtex("@article{open, title = {no close")).not.toThrow();
  });
});

describe("resolveBibPaths", () => {
  it("splits \\bibliography and appends .bib", () => {
    expect(resolveBibPaths("refs, more", "bibliography")).toEqual([
      "refs.bib",
      "more.bib",
    ]);
  });
  it("keeps an explicit .bib for \\addbibresource", () => {
    expect(resolveBibPaths("refs.bib", "addbibresource")).toEqual(["refs.bib"]);
  });
});
