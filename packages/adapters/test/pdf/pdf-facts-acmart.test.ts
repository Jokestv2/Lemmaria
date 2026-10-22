import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { computePdfFacts } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { createPdfiumRenderer } from "../../src/pdf/pdfium-renderer.js";
import { pdfiumWasmPath } from "../../src/pdf/wasm-path.js";

/**
 * J1's round (ADR 0082 §4, O33): the facts over a REAL `acmart` submission.
 *
 * The fixture is `[sigconf, screen, review, anonymous]` with a conference
 * running head and `\clearpage` before the bibliography — the shape of the
 * paper J1 was driven on, where the block read *main text 9 pages* of an
 * eight-page paper. Kept beside the renderer's suite because only PDFium's own
 * text order shows the shape the rule answers: the line numbers first, the
 * head part-way through them, the heading after.
 */
const FIXTURE = fileURLToPath(
  new URL("../fixtures/acmart-review/main.pdf", import.meta.url),
);

describe("the references page of a real acmart submission (J1's round, O33)", () => {
  it("reads references on page 3 and main text 2, through line numbers and a running head", async () => {
    const wasm = new Uint8Array(await readFile(pdfiumWasmPath()));
    const doc = await createPdfiumRenderer(wasm)(
      new Uint8Array(await readFile(FIXTURE)),
    );
    if (doc === undefined) throw new Error("the fixture did not open");
    try {
      // The shape the rule answers, pinned so that a TeX update which changes
      // it fails here, naming the cause, rather than in the facts below.
      const lines = (await doc.pageText(3))
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
      const at = lines.indexOf("References");
      expect(at).toBeGreaterThan(100);
      const above = lines.slice(0, at).filter((l) => !/^\d+$/.test(l));
      expect(above).toHaveLength(1);
      expect(above[0]).toContain("FIXTURE");

      const facts = await computePdfFacts({ document: doc });
      expect(facts.pages).toBe(3);
      expect(facts.referencesStart).toBe(3);
      expect(facts.mainTextPages).toBe(2);
    } finally {
      doc.close();
    }
  });
});
