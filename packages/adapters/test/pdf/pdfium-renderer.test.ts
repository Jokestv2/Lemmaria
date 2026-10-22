import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decode as decodePng } from "fast-png";
import { beforeAll, describe, expect, it } from "vitest";
import { createPdfiumRenderer } from "../../src/pdf/pdfium-renderer.js";
import { pdfiumWasmPath } from "../../src/pdf/wasm-path.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/simple-en/main.pdf", import.meta.url),
);

/** A US-Letter page: the fixture is `\documentclass[11pt]{article}`. */
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;

let wasm: Uint8Array;
let pdf: Uint8Array;

beforeAll(async () => {
  wasm = new Uint8Array(await readFile(pdfiumWasmPath()));
  pdf = new Uint8Array(await readFile(FIXTURE));
});

describe("createPdfiumRenderer (V3, ADR 0080 §9)", () => {
  it("opens the fixture and reports its page count", async () => {
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    expect(doc).toBeDefined();
    expect(doc?.pageCount).toBe(1);
    doc?.close();
  });

  it("reads the page size as POINTS — the two out-params are floats, not doubles", async () => {
    // S6's raw-binding tax: reading them as doubles returns ~8.1e20 with no
    // error at all. That is why this assertion exists at a tight tolerance.
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const size = doc?.pageSize(1);
    expect(size?.width).toBeCloseTo(LETTER_WIDTH_PT, 1);
    expect(size?.height).toBeCloseTo(LETTER_HEIGHT_PT, 1);
    doc?.close();
  });

  it("renders page 1 at the requested width, with the height DERIVED from the aspect", async () => {
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const page = await doc?.renderPage(1, { width: 1100 });
    const expectedHeight = Math.round(
      1100 * (LETTER_HEIGHT_PT / LETTER_WIDTH_PT),
    );
    expect(page?.width).toBe(1100);
    expect(page?.height).toBe(expectedHeight);

    // It is a real PNG, and the PNG's own header agrees with what we reported.
    expect([...(page?.png.subarray(0, 8) ?? [])]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const decoded = decodePng(page?.png as Uint8Array);
    expect(decoded.width).toBe(1100);
    expect(decoded.height).toBe(expectedHeight);
    doc?.close();
  });

  it("renders the SAME page twice — a page handle is not single-use here", async () => {
    // The trap S6 hit on the other candidate (@hyzyla/pdfium), whose second
    // render on one page object traps outright. Pinned so a renderer swap
    // cannot reintroduce it silently.
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const a = await doc?.renderPage(1, { width: 400 });
    const b = await doc?.renderPage(1, { width: 400 });
    expect(a?.png.length).toBeGreaterThan(0);
    expect(b?.png.length).toBe(a?.png.length);
    doc?.close();
  });

  it("`half` crops rows and scales NOTHING — the width is the one asked for", async () => {
    // The port renders at exactly `width`; doubling it to get a zoom is the
    // caller's, and `view_pdf_pages` is what does it. A renderer that also
    // doubled would square the effect, so this pins the width unchanged.
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const whole = await doc?.renderPage(1, { width: 550 });
    const top = await doc?.renderPage(1, { width: 550, half: "top" });
    const bottom = await doc?.renderPage(1, { width: 550, half: "bottom" });

    expect(top?.width).toBe(550);
    expect(top?.height).toBe(Math.floor((whole?.height ?? 0) / 2));
    // The two halves COVER the page between them: nothing at the seam falls
    // out of both. On an odd height the bottom is one row taller.
    expect((top?.height ?? 0) + (bottom?.height ?? 0)).toBe(whole?.height);
    expect(
      Math.abs((bottom?.height ?? 0) - (top?.height ?? 0)),
    ).toBeLessThanOrEqual(1);
    // The two halves are different pictures — a crop that silently returned
    // the same rows twice would pass every size assertion above.
    expect(
      Buffer.from(top?.png ?? []).equals(Buffer.from(bottom?.png ?? [])),
    ).toBe(false);
    doc?.close();
  });

  it("exposes the page's text layer for the harness's own use", async () => {
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const text = await doc?.pageText(1);
    expect(text).toContain("Introduction");
    expect(text).toContain("LemmaNet");
    doc?.close();
  });

  it("reads the producer out of the PDF's metadata", async () => {
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    const meta = await doc?.metadata();
    expect(meta?.producer).toMatch(/pdfTeX/i);
    doc?.close();
  });

  it("returns undefined for bytes that are not a PDF — honest degradation, never a throw", async () => {
    const render = createPdfiumRenderer(wasm);
    expect(await render(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
    expect(await render(new Uint8Array())).toBeUndefined();
    expect(
      await render(new TextEncoder().encode("not a pdf, just prose")),
    ).toBeUndefined();
  });

  it("initialises the WASM once and still serves two renderers", async () => {
    // PDFium's module is process-global; a second init must not corrupt the
    // first renderer's open documents.
    const one = createPdfiumRenderer(wasm);
    const two = createPdfiumRenderer(wasm);
    const a = await one(pdf);
    const b = await two(pdf);
    expect(a?.pageCount).toBe(1);
    expect(b?.pageCount).toBe(1);
    const pa = await a?.renderPage(1, { width: 300 });
    const pb = await b?.renderPage(1, { width: 300 });
    expect(pa?.png.length).toBeGreaterThan(0);
    expect(pb?.png.length).toBe(pa?.png.length);
    a?.close();
    b?.close();
  });

  it("refuses an out-of-range page rather than rendering garbage", async () => {
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    await expect(doc?.renderPage(2, { width: 300 })).rejects.toThrow();
    doc?.close();
  });
});

describe("pdfiumWasmPath", () => {
  it("resolves the package's one exported wasm subpath", async () => {
    const path = pdfiumWasmPath();
    expect(path).toMatch(/pdfium\.wasm$/);
    const bytes = await readFile(path);
    // The WebAssembly magic number.
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});

describe("the renderer's PNG is packed, not strided", () => {
  it("an ODD width still decodes at exactly that width", async () => {
    // PDFium may pad each row, so `stride` is not always `width * 4`. A
    // subarray of a padded buffer shears the image progressively down the
    // page while passing every size assertion — this is the case that
    // notices, because an odd width is where padding is most likely.
    const render = createPdfiumRenderer(wasm);
    const doc = await render(pdf);
    for (const width of [301, 407, 555]) {
      const page = await doc?.renderPage(width === 301 ? 1 : 1, { width });
      const decoded = decodePng(page?.png as Uint8Array);
      expect(decoded.width).toBe(width);
      expect(decoded.height).toBe(page?.height);
      // The PNG's own byte count must match a PACKED buffer exactly.
      expect(decoded.data.length).toBe(width * (page?.height ?? 0) * 4);
    }
    doc?.close();
  });
});

/**
 * V4 (ADR 0081 §1): the effective size of every run of text on a page — the
 * font's nominal size times the scale of the character's own matrix, so text
 * inside a figure included at half width reads at half its nominal size.
 */
describe("pageTextSizes (V4, ADR 0081 §1, O3)", () => {
  const fixture = (rel: string) =>
    readFile(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)));

  it("groups a page's text by effective size, ascending, whitespace excluded", async () => {
    const doc = await createPdfiumRenderer(wasm)(pdf);
    const groups = (await doc?.pageTextSizes(1)) ?? [];
    expect(groups.length).toBeGreaterThan(0);
    const sizes = groups.map((g) => g.sizePt);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    // Rounded to 0.1 pt, so two runs a rounding error apart are one group.
    for (const s of sizes) expect(Math.round(s * 10) / 10).toBe(s);
    // Whitespace is not text anyone reads: the counts sum below the text
    // layer's own length, which includes the spaces and line breaks.
    const text = (await doc?.pageText(1)) ?? "";
    const counted = groups.reduce((n, g) => n + g.chars, 0);
    expect(counted).toBeLessThan(text.length);
    expect(counted).toBe(text.replace(/\s/g, "").length);
    doc?.close();
  });

  it("reads the body text of simple-en at the class's own size or above", async () => {
    // `\documentclass[11pt]{article}` sets 10.95 pt body text; nothing the
    // page holds in quantity is smaller than 9 pt.
    const doc = await createPdfiumRenderer(wasm)(pdf);
    const groups = (await doc?.pageTextSizes(1)) ?? [];
    const counted = groups.filter((g) => g.chars >= 10);
    expect(counted[0]?.sizePt).toBeGreaterThanOrEqual(9);
    doc?.close();
  });

  it("reads a figure included at half its width at half its nominal size", async () => {
    // `figure.pdf` sets its label at 10 pt on a 4 in page; `main.pdf`
    // includes it at `width=2in`. The nominal size is 10 in both; only the
    // character matrix knows the second one prints at 5.
    const render = createPdfiumRenderer(wasm);
    const alone = await render(
      new Uint8Array(await fixture("scaled-figure/figure.pdf")),
    );
    expect((await alone?.pageTextSizes(1))?.[0]?.sizePt).toBeCloseTo(10, 1);
    alone?.close();

    const included = await render(
      new Uint8Array(await fixture("scaled-figure/main.pdf")),
    );
    const groups = (await included?.pageTextSizes(1)) ?? [];
    const figureGroup = groups.find((g) => g.chars >= 10);
    expect(figureGroup?.sizePt).toBeCloseTo(5, 1);
    included?.close();
  });

  it("reads the visual-defects paper: A4, the metadata author, and its smallest labels", async () => {
    const doc = await createPdfiumRenderer(wasm)(
      new Uint8Array(await fixture("visual-defects/main.pdf")),
    );
    expect(doc?.pageCount).toBe(3);
    const size = doc?.pageSize(1);
    expect(size?.width).toBeCloseTo(595.28, 0);
    expect(Math.abs((size?.width ?? 0) - 595.28)).toBeLessThan(0.5);
    expect(Math.abs((size?.height ?? 0) - 841.89)).toBeLessThan(0.5);
    expect((await doc?.metadata())?.author).toBe("A. Fixture");
    // The figure asks for 2 pt labels; LaTeX has no Computer Modern at 2 pt
    // and substitutes size 5 (the compile log says so), so 5.0 is what the
    // page actually prints — and what the fact must say.
    const counted = ((await doc?.pageTextSizes(1)) ?? []).filter(
      (g) => g.chars >= 10,
    );
    expect(counted[0]?.sizePt).toBe(5);
    doc?.close();
  });

  it("names no author where the PDF has none", async () => {
    const doc = await createPdfiumRenderer(wasm)(pdf);
    expect((await doc?.metadata())?.author).toBeUndefined();
    doc?.close();
  });

  it("refuses an out-of-range page, as the other page reads do", async () => {
    const doc = await createPdfiumRenderer(wasm)(pdf);
    await expect(doc?.pageTextSizes(2)).rejects.toThrow(/out of range/);
    doc?.close();
  });
});

describe("close() is idempotent (V4, O3)", () => {
  it("closing twice does not throw, and frees once", async () => {
    const doc = await createPdfiumRenderer(wasm)(pdf);
    expect(() => {
      doc?.close();
      doc?.close();
    }).not.toThrow();
    // The renderer still serves a fresh document afterwards — a double free
    // would have corrupted the allocator under it.
    const again = await createPdfiumRenderer(wasm)(pdf);
    expect(again?.pageCount).toBe(1);
    expect((await again?.pageText(1))?.length).toBeGreaterThan(0);
    again?.close();
  });
});
