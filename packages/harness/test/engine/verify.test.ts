import { describe, expect, it } from "vitest";
import type { EditProposal, Warning } from "../../src/contracts/index.js";
import {
  compileStatusLabel,
  formatWarningsForFix,
  planRollback,
  resolveEngine,
  tectonicInstallHint,
} from "../../src/engine/verify.js";
import { expectLocalePair, expectMonolingual } from "../support/locale.js";

describe("planRollback", () => {
  it("inverts an accepted edit by content anchor (no blind whole-file restore)", () => {
    const edit: EditProposal = {
      file: "a.tex",
      span: { startOffset: 3, endOffset: 8 },
      expectedOriginal: "hello",
      replacement: "WORLD",
      contract: "replace_selection",
    };
    expect(planRollback(edit)).toEqual({
      file: "a.tex",
      expectedOriginal: "WORLD",
      replacement: "hello",
    });
  });
});

describe("resolveEngine", () => {
  it("auto picks the first available preferred engine", () => {
    expect(
      resolveEngine({
        configEngine: "auto",
        preferred: ["xelatex", "lualatex"],
        available: (e) => e === "lualatex",
      }),
    ).toEqual({ engine: "lualatex" });
  });

  it("auto falls back to latexmk when no preferred engine is available", () => {
    expect(
      resolveEngine({
        configEngine: "auto",
        preferred: ["pdflatex"],
        available: (e) => e === "latexmk",
      }),
    ).toEqual({ engine: "latexmk" });
  });

  it("auto with nothing available routes to tectonic WITH guidance, never throws", () => {
    const r = resolveEngine({
      configEngine: "auto",
      preferred: ["pdflatex"],
      available: () => false,
    });
    expect(r.engine).toBe("tectonic");
    expect(r.guidance).toBe(tectonicInstallHint("en"));
    expect(r.guidance).toContain("tectonic");
  });

  it("honors an explicit engine override when it is available", () => {
    expect(
      resolveEngine({
        configEngine: "xelatex",
        preferred: ["pdflatex"],
        available: () => true,
      }),
    ).toEqual({ engine: "xelatex" });
  });

  it("explicit tectonic override with no binary → engine + guidance, not a throw", () => {
    const r = resolveEngine({
      configEngine: "tectonic",
      preferred: ["pdflatex"],
      available: () => false,
    });
    expect(r).toEqual({
      engine: "tectonic",
      guidance: tectonicInstallHint("en"),
    });
  });

  it("an explicit non-tectonic engine that is absent still resolves to that engine with guidance to install a TeX toolchain", () => {
    const r = resolveEngine({
      configEngine: "pdflatex",
      preferred: ["pdflatex"],
      available: () => false,
    });
    expect(r.engine).toBe("pdflatex");
    expect(r.guidance).toBeTruthy();
  });
});

describe("formatWarningsForFix", () => {
  const fw = (code: string, line: number, message: string): Warning => ({
    id: `${code}:${line}`,
    source: "latexmk",
    severity: code.includes("error") ? "error" : "warning",
    code,
    message,
    file: "main.tex",
    line,
  });

  it("renders one finding as a code/line/message line", () => {
    expect(
      formatWarningsForFix([
        fw("undefined-ref", 12, "citation `foo' undefined"),
      ]),
    ).toBe("- undefined-ref (line 12): citation `foo' undefined");
  });

  it("renders many findings one per line, in order", () => {
    const out = formatWarningsForFix([
      fw("undefined-ref", 12, "first"),
      fw("overfull-hbox", 30, "second"),
    ]);
    expect(out).toBe(
      "- undefined-ref (line 12): first\n- overfull-hbox (line 30): second",
    );
  });

  it("caps at 8 findings — a fix prompt is not a log dump", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      fw("undefined-ref", i + 1, `m${i}`),
    );
    const out = formatWarningsForFix(many);
    expect(out.split("\n")).toHaveLength(8);
    expect(out).toContain("m7");
    expect(out).not.toContain("m8");
  });

  it("renders a missing line as ? rather than undefined", () => {
    const noLine = {
      ...fw("runaway-argument", 1, "unbalanced brace"),
      line: undefined,
    };
    expect(formatWarningsForFix([noLine])).toBe(
      "- runaway-argument (line ?): unbalanced brace",
    );
  });

  it("returns an empty string for no findings", () => {
    expect(formatWarningsForFix([])).toBe("");
  });
});

/**
 * D4 (invariant 6 rule 2, ADR 0034): the two engine hints and the compile status
 * label render in the reader's language. Before D4 both hints were one
 * `"English. 中文。"` string, and the status label lived in the extension where
 * nothing could assert it.
 */
describe("engine guidance — one language per reader (D4)", () => {
  const unavailable = () => false;

  it("renders the tectonic install hint in one language, differing by locale", () => {
    expectLocalePair(tectonicInstallHint("en"), tectonicInstallHint("zh"), [
      "https://tectonic-typesetting.github.io/install.html",
      "lemmaria.verify.engine",
      "tectonic",
    ]);
  });

  it("renders the missing-engine hint in one language, differing by locale", () => {
    const en = resolveEngine({
      configEngine: "xelatex",
      preferred: [],
      available: unavailable,
      locale: "en",
    }).guidance;
    const zh = resolveEngine({
      configEngine: "xelatex",
      preferred: [],
      available: unavailable,
      locale: "zh",
    }).guidance;
    expectLocalePair(en ?? "", zh ?? "", ["xelatex", "MiKTeX", "TeX Live"]);
  });

  it("defaults to English, so every pre-D4 caller is byte-identical", () => {
    const opts = {
      configEngine: "tectonic",
      preferred: [],
      available: unavailable,
    };
    expect(resolveEngine(opts).guidance).toBe(tectonicInstallHint("en"));
  });
});

/**
 * D4 / CHROME-3: the compile status item showed `findings.length` on the
 * success-with-warnings branch and DISCARDED it on the failure branch — the
 * branch where a user most needs to know how much is wrong. The label is a pure
 * function here so the count, the pluralization and the locale are one
 * assertion rather than a new ext-host seam (ADR 0037 §4's kept precedent).
 */
describe("compileStatusLabel (D4, CHROME-3)", () => {
  it("names the finding count when the compile FAILED", () => {
    expect(
      compileStatusLabel({ ok: false, findingCount: 3, locale: "en" }),
    ).toMatchObject({ icon: "$(error)" });
    expect(
      compileStatusLabel({ ok: false, findingCount: 3, locale: "en" }).text,
    ).toMatch(/3/);
  });

  it("still names the count when the compile SUCCEEDED with warnings", () => {
    expect(
      compileStatusLabel({ ok: true, findingCount: 2, locale: "en" }).text,
    ).toMatch(/2/);
  });

  it("says nothing about a count when a failure produced no findings", () => {
    const label = compileStatusLabel({
      ok: false,
      findingCount: 0,
      locale: "en",
    });
    expect(label.text).not.toMatch(/\d/);
  });

  it("pluralizes at one and at many", () => {
    expect(
      compileStatusLabel({ ok: true, findingCount: 1, locale: "en" }).text,
    ).toMatch(/\b1 warning\b/);
    expect(
      compileStatusLabel({ ok: true, findingCount: 2, locale: "en" }).text,
    ).toMatch(/\b2 warnings\b/);
  });

  it("reports a clean compile with no number at all", () => {
    const label = compileStatusLabel({
      ok: true,
      findingCount: 0,
      locale: "en",
    });
    expect(label.icon).toBe("$(check)");
    expect(label.text).not.toMatch(/\d/);
  });

  it("renders every branch in one language, differing by locale", () => {
    for (const [ok, findingCount] of [
      [false, 3],
      [false, 0],
      [true, 2],
      [true, 0],
    ] as const) {
      const en = compileStatusLabel({ ok, findingCount, locale: "en" });
      const zh = compileStatusLabel({ ok, findingCount, locale: "zh" });
      expectLocalePair(en.tooltip, zh.tooltip);
      expectMonolingual(en.text, "en");
      expectMonolingual(zh.text, "zh", [String(findingCount)]);
    }
  });
});
