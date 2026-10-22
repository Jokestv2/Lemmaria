/**
 * V3 (O21): the marker fixture is what the live rows will need it to be.
 *
 * A fixture that silently stopped carrying its code — recompiled from a
 * different `.tex`, or committed without its PDF — would make a live run read
 * *not read* for a reason that has nothing to do with the model. This is the
 * cheapest guard against confusing a broken fixture with a real finding, which
 * is the one thing a `TEST.md` must never do.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPdfiumRenderer } from "@lemmaria/adapters";
import { pdfiumWasmPath } from "@lemmaria/adapters/pdfium-wasm";
import { describe, expect, it } from "vitest";
import { readMarker } from "../../src/eval/marker.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "live",
  "fixtures",
  "pdf-marker",
);

describe("the pdf-marker fixture (V3, O21)", () => {
  it("marker.json parses and names a 1-based page", async () => {
    const m = await readMarker(join(FIXTURE, "marker.json"));
    expect(m.marker).toBe("LEMMARIA-MARKER-7F3A");
    expect(m.page).toBe(1);
  });

  it("marker.json sits OUTSIDE paper/ — ground truth is not the paper", async () => {
    // ADR 0070's layout rule: a run copies `paper/`, so anything inside it
    // travels with the fixture and could reach the model.
    await expect(
      readFile(join(FIXTURE, "paper", "marker.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("main.tex contains the marker exactly once", async () => {
    const tex = await readFile(join(FIXTURE, "paper", "main.tex"), "utf8");
    const hits = tex.split("LEMMARIA-MARKER-7F3A").length - 1;
    expect(hits).toBe(1);
  });

  it("main.pdf opens, has ONE page, and carries the marker in its text layer", async () => {
    const render = createPdfiumRenderer(
      new Uint8Array(await readFile(pdfiumWasmPath())),
    );
    const doc = await render(
      new Uint8Array(await readFile(join(FIXTURE, "paper", "main.pdf"))),
    );
    expect(doc).toBeDefined();
    expect(doc?.pageCount).toBe(1);
    // The model is NEVER shown this layer (the port's `pageText` is for the
    // harness). It is asserted here only because a PDF whose text layer lost
    // the code was compiled from the wrong source.
    expect(await doc?.pageText(1)).toContain("LEMMARIA-MARKER-7F3A");
    doc?.close();
  });

  it("renders at the harness's own width into a PNG a model could read", async () => {
    const render = createPdfiumRenderer(
      new Uint8Array(await readFile(pdfiumWasmPath())),
    );
    const doc = await render(
      new Uint8Array(await readFile(join(FIXTURE, "paper", "main.pdf"))),
    );
    const page = await doc?.renderPage(1, { width: 1100 });
    expect(page?.width).toBe(1100);
    expect(page?.png.length).toBeGreaterThan(10_000);
    doc?.close();
  });
});
