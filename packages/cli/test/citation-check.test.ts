import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCliCitationCheck } from "../src/citation-check.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("runCliCitationCheck (C1 offline, real adapter + parser)", () => {
  it("reports each defect class on the fixture project", async () => {
    const warnings = await runCliCitationCheck({
      root: join(FIXTURES, "citations"),
      entry: "main.tex",
    });
    const codes = new Set(warnings.map((w) => w.code));
    expect(codes).toContain("undefined-citation");
    expect(codes).toContain("orphan-citation");
    expect(codes).toContain("duplicate-key");
    expect(codes).toContain("duplicate-entry");
    // Every citation warning carries the unified shape.
    expect(warnings.every((w) => w.source === "citation")).toBe(true);
    // The undefined citation names the hallucinated key.
    const undef = warnings.find((w) => w.code === "undefined-citation");
    expect(undef?.message).toMatch(/ghost2099/);
  });

  it("M8: runs C1 on a Markdown project (frontmatter bibliography + [@key] cites)", async () => {
    const warnings = await runCliCitationCheck({
      root: join(FIXTURES, "citations-md"),
      entry: "draft.md",
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("undefined-citation"); // [@ghost2099] not in refs.bib
    expect(codes).toContain("orphan-citation"); // orphan2021 never cited
    const undef = warnings.find((w) => w.code === "undefined-citation");
    expect(undef?.message).toMatch(/ghost2099/);
    expect(warnings.every((w) => w.source === "citation")).toBe(true);
  });
});
