import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LatexAdapter } from "../../src/index.js";
import { fixtureReader } from "./helpers.js";

const warnLog = readFileSync(
  fileURLToPath(new URL("./fixtures/logs/warn-pdflatex.log", import.meta.url)),
  "utf8",
);

describe("LatexAdapter.verify", () => {
  it("compiles via the injected workspace and parses the log into warnings", async () => {
    const calls: string[] = [];
    const workspace = {
      compile: async (engine: string) => {
        calls.push(engine);
        return { ok: true, log: warnLog };
      },
    };
    const adapter = await LatexAdapter.load(
      fixtureReader("simple-en"),
      "main.tex",
      { workspace, engine: "pdflatex" },
    );
    const { ok, warnings } = await adapter.verify();
    expect(calls).toEqual(["pdflatex"]);
    expect(ok).toBe(true);
    expect(warnings.map((w) => w.code).sort()).toEqual([
      "overfull-hbox",
      "undefined-citation",
      "undefined-ref",
    ]);
    expect(warnings.every((w) => w.source === "latexmk")).toBe(true);
  });

  it("propagates ok:false from a failed compile", async () => {
    const workspace = {
      compile: async () => ({ ok: false, log: "" }),
    };
    const adapter = await LatexAdapter.load(
      fixtureReader("simple-en"),
      "main.tex",
      { workspace, engine: "pdflatex" },
    );
    expect((await adapter.verify()).ok).toBe(false);
  });

  it("throws a clear error when no workspace/engine is bound", async () => {
    const adapter = await LatexAdapter.load(
      fixtureReader("simple-en"),
      "main.tex",
    );
    await expect(adapter.verify()).rejects.toThrow(/verify/i);
  });
});
