import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Warning } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import {
  parseCompileLog,
  parseOutputPages,
  warningId,
} from "../../src/latex/compile-log.js";

const logDir = fileURLToPath(new URL("./fixtures/logs/", import.meta.url));
const load = (n: string) => readFileSync(`${logDir}${n}`, "utf8");
const parse = (n: string) =>
  parseCompileLog(load(n), { source: "latexmk", entryFile: "main.tex" });

describe("parseCompileLog (pdflatex/latexmk)", () => {
  it("clean log → no warnings", () => {
    expect(parse("clean-pdflatex.log")).toEqual([]);
  });

  it("warn log → undefined-ref, undefined-citation, overfull-hbox (summary dropped)", () => {
    const ws = parse("warn-pdflatex.log");
    expect(ws.map((w) => w.code).sort()).toEqual([
      "overfull-hbox",
      "undefined-citation",
      "undefined-ref",
    ]);
    const ref = ws.find((w) => w.code === "undefined-ref");
    expect(ref).toMatchObject({
      severity: "warning",
      line: 4,
      source: "latexmk",
      file: "main.tex",
    });
    // volatile "on page N" stripped from the stored message
    expect(ref?.message).not.toMatch(/on page/);
    // the "There were undefined references." summary line is dropped
    expect(ws.some((w) => /There were/.test(w.message))).toBe(false);
  });

  it("overfull-hbox carries the first line of the range", () => {
    const over = parse("warn-pdflatex.log").find(
      (w) => w.code === "overfull-hbox",
    );
    expect(over).toMatchObject({ severity: "warning", line: 4 });
  });

  it("every warning has a non-empty stable id", () => {
    const ws = parse("warn-pdflatex.log");
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.every((w) => typeof w.id === "string" && w.id.length > 0)).toBe(
      true,
    );
  });

  it("fail log → error-severity entries with line numbers", () => {
    const ws = parse("fail-pdflatex.log");
    expect(
      ws.find((w) => w.code === "undefined-control-sequence"),
    ).toMatchObject({
      severity: "error",
      line: 4,
    });
    expect(ws.find((w) => w.code === "latex-error")).toMatchObject({
      severity: "error",
      line: 5,
    });
  });
});

describe("warningId", () => {
  const base: Omit<Warning, "id"> = {
    source: "latexmk",
    severity: "warning",
    code: "overfull-hbox",
    message:
      "Overfull \\hbox (371.20049pt too wide) in paragraph at lines 4--6",
    file: "main.tex",
    line: 4,
  };

  it("is stable under volatile pt-magnitude noise", () => {
    const a = warningId(base);
    const b = warningId({
      ...base,
      message: "Overfull \\hbox (12.0pt too wide) in paragraph at lines 4--6",
    });
    expect(a).toBe(b);
  });

  it("differs when the normalized message differs", () => {
    const a = warningId(base);
    const b = warningId({ ...base, code: "underfull-hbox" });
    expect(a).not.toBe(b);
  });

  it("is stable under volatile 'on page N' noise", () => {
    const mk = (page: number): Omit<Warning, "id"> => ({
      source: "latexmk",
      severity: "warning",
      code: "undefined-ref",
      message: `Reference \`fig:x' on page ${page} undefined`,
      file: "main.tex",
      line: 4,
    });
    expect(warningId(mk(1))).toBe(warningId(mk(9)));
  });
});

describe("parseOutputPages", () => {
  it("reads the page count from the Output written line", () => {
    expect(
      parseOutputPages("Output written on main.pdf (7 pages, 123456 bytes).\n"),
    ).toBe(7);
    expect(
      parseOutputPages("Output written on out/main.pdf (1 page, 99 bytes).\n"),
    ).toBe(1);
  });

  it("takes the LAST run's count on a multi-pass latexmk transcript", () => {
    const log =
      "Output written on main.pdf (6 pages, 1 bytes).\n...rerun...\nOutput written on main.pdf (8 pages, 2 bytes).\n";
    expect(parseOutputPages(log)).toBe(8);
  });

  it("returns undefined when the line is absent", () => {
    expect(parseOutputPages("! Emergency stop.\n")).toBeUndefined();
  });
});
