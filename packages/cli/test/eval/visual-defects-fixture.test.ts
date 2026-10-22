/**
 * V4 (O25): the visual-defects fixture is what `visual.json` says it is.
 *
 * Built from S6's `visual-defects` pair: every answer-key comment stripped,
 * the defective twin given an Author in its metadata, both compiled once and
 * committed. This file proves the two PDFs and the manifest agree with the
 * source they were built from — so a number the instrument reads is a number
 * about THIS paper.
 */
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import type { PdfRenderer } from "@lemmaria/harness";
import { beforeAll, describe, expect, it } from "vitest";
import { readVisualManifest } from "../../src/eval/visual.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../live/fixtures/visual-defects");
const MANIFEST = resolve(FIXTURE, "visual.json");

let render: PdfRenderer;
beforeAll(async () => {
  render = createPdfiumRenderer(
    new Uint8Array(await readFile(pdfiumWasmPath())),
  );
});

async function open(twin: "paper" | "clean") {
  const doc = await render(
    new Uint8Array(await readFile(resolve(FIXTURE, twin, "main.pdf"))),
  );
  if (doc === undefined) throw new Error(`${twin}/main.pdf did not open`);
  return doc;
}

describe("V4 O25 — the visual-defects fixture", () => {
  it("the defective twin is 3 pages of A4 and names an author; the clean twin is 2 of Letter and names nobody", async () => {
    const paper = await open("paper");
    const clean = await open("clean");
    try {
      expect(paper.pageCount).toBe(3);
      expect(paper.pageSize(1).width).toBeCloseTo(595.28, 0);
      expect(paper.pageSize(1).height).toBeCloseTo(841.89, 0);
      expect((await paper.metadata()).author).toBe("A. Fixture");

      expect(clean.pageCount).toBe(2);
      expect(clean.pageSize(1).width).toBeCloseTo(612, 0);
      expect(clean.pageSize(1).height).toBeCloseTo(792, 0);
      expect((await clean.metadata()).author ?? "").toBe("");
    } finally {
      paper.close();
      clean.close();
    }
  });

  it("carries no answer key in either source", async () => {
    for (const twin of ["paper", "clean"] as const) {
      const tex = await readFile(resolve(FIXTURE, twin, "main.tex"), "utf8");
      expect(tex, twin).not.toContain("DEFECT");
      // Every whole-line comment was stripped; S6's key lived in them.
      expect(
        tex.split("\n").filter((l) => /^\s*%/.test(l)),
        twin,
      ).toEqual([]);
    }
  });

  it("every manifest span locates byte-exactly once, on its line", async () => {
    const manifest = await readVisualManifest(MANIFEST);
    const tex = await readFile(resolve(FIXTURE, "paper", "main.tex"), "utf8");
    const lines = tex.split("\n");
    for (const d of manifest.defects) {
      for (const span of d.spans) {
        expect(
          tex.split(span.anchor).length - 1,
          `${d.id}: ${span.anchor}`,
        ).toBe(1);
        expect(lines[span.line - 1], `${d.id} line ${span.line}`).toContain(
          span.anchor,
        );
      }
    }
  });

  it("sits outside both twins, and holds S6's ten ids with the three the facts answer", async () => {
    const manifest = await readVisualManifest(MANIFEST);
    expect(relative(FIXTURE, MANIFEST)).toBe("visual.json");
    expect(manifest.defects.map((d) => d.id)).toEqual([
      "V1",
      "V2",
      "V3",
      "V4",
      "V5",
      "V6",
      "V7",
      "V8",
      "V9",
      "V10",
    ]);
    expect(manifest.defects.filter((d) => d.facts).map((d) => d.id)).toEqual([
      "V3",
      "V6",
      "V7",
    ]);
    expect(manifest.defective).toEqual({ pages: 3, pageSize: "a4" });
    expect(manifest.clean).toEqual({ pages: 2, pageSize: "letter" });
    expect(manifest.venue.pageLimit).toMatchObject({ value: 2, unit: "pages" });
  });
});
