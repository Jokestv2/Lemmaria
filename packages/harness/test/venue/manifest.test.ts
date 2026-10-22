import { describe, expect, it } from "vitest";
import { VenueError, parseVenueManifest } from "../../src/venue/manifest.js";
import { expectLocalePair } from "../support/locale.js";

const FULL_SAMPLE = `
id: acm-sigconf
name: { en: "ACM (sigconf)", zh: "ACM 会议 (sigconf)" }
documentclass: { class: acmart, options: [sigconf, anonymous, review] }
engine: pdflatex
bibstyle: ACM-Reference-Format
page_limit: { value: 9, unit: pages, note: "excl. references" }
anonymity: double_blind
field_map:
  title: "\\\\title{...}"
  authors: "\\\\author + \\\\affiliation blocks"
theorem_envs: amsthm
starter_files: [main.tex, references.bib]
license: LPPL-1.3c
redistribute: true
source_url: https://www.acm.org/publications/proceedings-template
`;

describe("parseVenueManifest", () => {
  it("parses the architecture-design sample manifest field for field", () => {
    const m = parseVenueManifest(FULL_SAMPLE);
    expect(m.id).toBe("acm-sigconf");
    expect(m.name).toEqual({ en: "ACM (sigconf)", zh: "ACM 会议 (sigconf)" });
    expect(m.documentclass).toEqual({
      class: "acmart",
      options: ["sigconf", "anonymous", "review"],
    });
    expect(m.engine).toBe("pdflatex");
    expect(m.bibstyle).toBe("ACM-Reference-Format");
    expect(m.page_limit).toEqual({
      value: 9,
      unit: "pages",
      note: "excl. references",
    });
    expect(m.anonymity).toBe("double_blind");
    expect(m.field_map?.title).toBe("\\title{...}");
    expect(m.theorem_envs).toBe("amsthm");
    expect(m.starter_files).toEqual(["main.tex", "references.bib"]);
    expect(m.license).toBe("LPPL-1.3c");
    expect(m.redistribute).toBe(true);
    expect(m.source_url).toBe(
      "https://www.acm.org/publications/proceedings-template",
    );
  });

  it("fills defaults on a minimal manifest", () => {
    const m = parseVenueManifest(`
id: min
name: { en: Minimal, zh: 最小 }
documentclass: { class: article }
engine: pdflatex
`);
    expect(m.starter_files).toEqual([]);
    expect(m.redistribute).toBe(true);
    expect(m.documentclass.options).toEqual([]);
    expect(m.fetch_files).toBeUndefined();
  });

  it("parses redistribute:false with fetch_files", () => {
    const m = parseVenueManifest(`
id: llncs
name: { en: LNCS, zh: LNCS }
documentclass: { class: llncs }
engine: pdflatex
redistribute: false
fetch_files:
  - { url: "https://example.org/llncs.cls", dest: llncs.cls }
source_url: https://example.org/guidelines
`);
    expect(m.redistribute).toBe(false);
    expect(m.fetch_files).toEqual([
      { url: "https://example.org/llncs.cls", dest: "llncs.cls" },
    ]);
  });

  const base = `
name: { en: X, zh: X }
documentclass: { class: article }
engine: pdflatex
`;

  it.each([
    ["id", `${base}`, "id"],
    [
      "name.zh",
      "id: x\nname: { en: X }\ndocumentclass: { class: a }\nengine: p\n",
      "name.zh",
    ],
    [
      "documentclass.class",
      "id: x\nname: { en: X, zh: X }\ndocumentclass: {}\nengine: p\n",
      "documentclass.class",
    ],
    [
      "engine",
      "id: x\nname: { en: X, zh: X }\ndocumentclass: { class: a }\n",
      "engine",
    ],
  ])(
    "rejects a manifest missing %s, naming the field",
    (_label, src, field) => {
      let err: unknown;
      try {
        parseVenueManifest(src);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(VenueError);
      expect((err as VenueError).code).toBe("invalid_manifest");
      expect((err as VenueError).message).toContain(field);
    },
  );

  it("rejects a fetch_files dest escaping the target dir", () => {
    expect(() =>
      parseVenueManifest(`
id: x
name: { en: X, zh: X }
documentclass: { class: a }
engine: p
fetch_files:
  - { url: "https://e.org/f", dest: "../evil.cls" }
`),
    ).toThrow(VenueError);
  });

  it("rejects a non-array starter_files", () => {
    expect(() =>
      parseVenueManifest(`
id: x
name: { en: X, zh: X }
documentclass: { class: a }
engine: p
starter_files: main.tex
`),
    ).toThrow(/starter_files/);
  });

  it("rejects input that is not a YAML mapping", () => {
    let err: unknown;
    try {
      parseVenueManifest("- just\n- a list\n", "some/venue.yaml");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).message).toContain("some/venue.yaml");
  });

  it("rejects an out-of-enum anonymity", () => {
    expect(() =>
      parseVenueManifest(`
id: x
name: { en: X, zh: X }
documentclass: { class: a }
engine: p
anonymity: sorta_blind
`),
    ).toThrow(/anonymity/);
  });

  it("ignores unknown top-level keys (forward compatibility)", () => {
    const m = parseVenueManifest(`
id: x
name: { en: X, zh: X }
documentclass: { class: a }
engine: p
future_field: whatever
`);
    expect(m.id).toBe("x");
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): a `VenueError` surfaces in the Venue tab,
 * so its message renders in the reader's language. Before D4 it was one
 * `"English. 中文。"` string and `manifest.ts` had no locale in scope at all.
 */
describe("parseVenueManifest — one language per reader (D4)", () => {
  const reason = (source: string, locale?: "en" | "zh"): string => {
    try {
      parseVenueManifest(source, "acm/venue.yaml", locale);
    } catch (error) {
      return (error as VenueError).message;
    }
    throw new Error("expected parseVenueManifest to throw");
  };

  it("renders an invalid-manifest reason in one language, differing by locale", () => {
    expectLocalePair(reason("id: x", "en"), reason("id: x", "zh"), [
      "acm/venue.yaml",
      "venue.yaml",
    ]);
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", () => {
    expect(reason("id: x")).toBe(reason("id: x", "en"));
  });
});
