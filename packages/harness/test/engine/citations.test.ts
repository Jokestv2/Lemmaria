import { describe, expect, it } from "vitest";
import {
  applyBibDiff,
  checkCitationConsistency,
} from "../../src/engine/citations.js";
import { expectLocalePair } from "../support/locale.js";

const rec = (
  key: string,
  fields: Record<string, string> = {},
  line = 1,
): {
  key: string;
  fields: Record<string, string>;
  file: string;
  line: number;
} => ({
  key,
  fields,
  file: "refs.bib",
  line,
});

describe("checkCitationConsistency", () => {
  it("flags a cited key that is not in the bib (undefined-citation)", () => {
    const w = checkCitationConsistency({
      citedKeys: ["ghost", "real"],
      entries: [rec("real")],
      entryFile: "main.tex",
    });
    expect(w).toEqual([
      expect.objectContaining({
        code: "undefined-citation",
        severity: "error",
        source: "citation",
        file: "main.tex",
      }),
    ]);
    expect(w[0]?.message).toMatch(/ghost/);
  });

  it("flags a bib entry that is never cited (orphan-citation)", () => {
    const w = checkCitationConsistency({
      citedKeys: [],
      entries: [rec("unused", {}, 4)],
      entryFile: "main.tex",
    });
    expect(w).toEqual([
      expect.objectContaining({
        code: "orphan-citation",
        severity: "info",
        line: 4,
      }),
    ]);
  });

  it("flags a duplicate key", () => {
    const w = checkCitationConsistency({
      citedKeys: ["dup"],
      entries: [rec("dup", {}, 1), rec("dup", {}, 5)],
      entryFile: "main.tex",
    });
    const dup = w.find((x) => x.code === "duplicate-key");
    expect(dup).toMatchObject({ severity: "error", line: 5 });
  });

  it("flags two keys that share a DOI (duplicate-entry)", () => {
    const w = checkCitationConsistency({
      citedKeys: ["a", "b"],
      entries: [rec("a", { doi: "10.1/x" }, 1), rec("b", { doi: "10.1/X" }, 5)],
      entryFile: "main.tex",
    });
    expect(w.map((x) => x.code)).toContain("duplicate-entry");
  });

  it("returns no warnings for a clean project", () => {
    expect(
      checkCitationConsistency({
        citedKeys: ["a"],
        entries: [rec("a")],
        entryFile: "main.tex",
      }),
    ).toEqual([]);
  });

  it("gives each warning a stable id across runs", () => {
    const run = (): string | undefined =>
      checkCitationConsistency({
        citedKeys: ["ghost"],
        entries: [],
        entryFile: "main.tex",
      })[0]?.id;
    expect(run()).toBe(run());
  });
});

describe("applyBibDiff", () => {
  it("replaces a field value in place and adds a missing field", () => {
    const src = `@article{k,
  title = {Old},
  year = {2019},
}`;
    const out = applyBibDiff(src, {
      key: "k",
      changes: [
        { field: "year", from: "2019", to: "2020" },
        { field: "doi", to: "10.1/x" },
      ],
    });
    expect(out).toMatch(/year = \{2020\}/);
    expect(out).toMatch(/doi = \{10\.1\/x\}/);
    expect(out).toMatch(/title = \{Old\}/);
  });

  it("leaves the source unchanged when the key is absent", () => {
    const src = "@article{k, title = {Old}}\n";
    expect(
      applyBibDiff(src, { key: "other", changes: [{ field: "x", to: "y" }] }),
    ).toBe(src);
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): the four consistency warnings render in the
 * reader's language. Before D4 every message was `"English. 中文。"` in one
 * string — the shape ADR 0034 retired from the session path and left enumerated
 * in `check-mixed-language-strings.mjs` as D4's scope.
 */
describe("checkCitationConsistency — one language per reader (D4)", () => {
  const both = (input: Parameters<typeof checkCitationConsistency>[0]) => ({
    en: checkCitationConsistency(input, "en"),
    zh: checkCitationConsistency(input, "zh"),
  });

  it("renders undefined-citation in one language, differing by locale", () => {
    const { en, zh } = both({
      citedKeys: ["ghost"],
      entries: [],
      entryFile: "main.tex",
    });
    expectLocalePair(en[0]?.message ?? "", zh[0]?.message ?? "", ["ghost"]);
  });

  it("renders orphan-citation in one language, differing by locale", () => {
    const { en, zh } = both({
      citedKeys: [],
      entries: [rec("lonely")],
      entryFile: "main.tex",
    });
    expectLocalePair(en[0]?.message ?? "", zh[0]?.message ?? "", ["lonely"]);
  });

  it("renders duplicate-key in one language, differing by locale", () => {
    const { en, zh } = both({
      citedKeys: ["dup"],
      entries: [rec("dup"), rec("dup", {}, 9)],
      entryFile: "main.tex",
    });
    const enDup = en.find((w) => w.code === "duplicate-key")?.message ?? "";
    const zhDup = zh.find((w) => w.code === "duplicate-key")?.message ?? "";
    expectLocalePair(enDup, zhDup, ["dup"]);
  });

  it("renders duplicate-entry in one language, differing by locale", () => {
    const shared = { doi: "10.1/x" };
    const { en, zh } = both({
      citedKeys: ["a", "b"],
      entries: [rec("a", shared), rec("b", shared, 4)],
      entryFile: "main.tex",
    });
    const enDup = en.find((w) => w.code === "duplicate-entry")?.message ?? "";
    const zhDup = zh.find((w) => w.code === "duplicate-entry")?.message ?? "";
    expectLocalePair(enDup, zhDup, ["a", "b"]);
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", () => {
    const input = {
      citedKeys: ["ghost"],
      entries: [],
      entryFile: "main.tex",
    };
    expect(checkCitationConsistency(input)).toEqual(
      checkCitationConsistency(input, "en"),
    );
  });
});
