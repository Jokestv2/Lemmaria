import type {
  PdfDocument,
  PdfMetadata,
  PdfPageImage,
  PdfRenderer,
} from "@lemmaria/harness";
import { bgraToRgba, encodeRgbaPng } from "./png.js";

/**
 * `PdfRenderer` on PDFium-WASM (V3, ADR 0080 §2, §9).
 *
 * The raw C API, not a wrapper's convenience layer: `@embedpdf/pdfium` hangs
 * ~600 cwrapped `FPDF_*` / `EPDF_*` functions off the module's top level, and
 * the emscripten module — its heap and its allocator — off `.pdfium`. S6 drove
 * exactly this surface, and three of its findings are carried as comments at
 * the lines where they bite.
 *
 * The caller hands in the WASM bytes. That is what lets the extension read its
 * own copied `dist/pdfium.wasm` through the VS Code file API while the CLI
 * resolves the package's subpath — and it is why this module reads no file and
 * touches no network: bytes in, bytes out (invariant 2).
 */

/** The bitmap format PDFium fills: 32-bit BGRA. */
const FPDF_BITMAP_BGRA = 0;
/** Render annotations too — a review should see what a reader sees. */
const FPDF_ANNOT = 0x10;

/** The minimal slice of the module's surface this file drives. */
interface PdfiumModule {
  pdfium: {
    HEAPU8: Uint8Array;
    wasmExports: { malloc(n: number): number; free(p: number): void };
    getValue(ptr: number, type: string): number;
    UTF16ToString(ptr: number): string;
  };
  PDFiumExt_Init(): void;
  FPDF_LoadMemDocument(ptr: number, size: number, password: number): number;
  FPDF_GetLastError(): number;
  FPDF_CloseDocument(doc: number): void;
  FPDF_GetPageCount(doc: number): number;
  EPDF_GetPageSizeByIndexNormalized(
    doc: number,
    index: number,
    out: number,
  ): number;
  FPDF_LoadPage(doc: number, index: number): number;
  FPDF_ClosePage(page: number): void;
  FPDFBitmap_Create(w: number, h: number, alpha: number): number;
  FPDFBitmap_FillRect(
    bmp: number,
    x: number,
    y: number,
    w: number,
    h: number,
    color: number,
  ): void;
  FPDF_RenderPageBitmap(
    bmp: number,
    page: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotate: number,
    flags: number,
  ): void;
  FPDFBitmap_GetBuffer(bmp: number): number;
  FPDFBitmap_GetStride(bmp: number): number;
  FPDFBitmap_Destroy(bmp: number): void;
  FPDFText_LoadPage(page: number): number;
  FPDFText_ClosePage(textPage: number): void;
  FPDFText_CountChars(textPage: number): number;
  FPDFText_GetText(
    textPage: number,
    start: number,
    count: number,
    out: number,
  ): number;
  FPDF_GetMetaText(doc: number, tag: string, out: number, len: number): number;
  // V4 (ADR 0081 §1): the two calls the effective text size is built from.
  FPDFText_GetUnicode(textPage: number, index: number): number;
  /** The character's NOMINAL font size, in points — a double. */
  FPDFText_GetFontSize(textPage: number, index: number): number;
  /** Fills an FS_MATRIX — SIX FLOATS — with the character's matrix: the text
   *  matrix combined with the CTM, a Form XObject's included. */
  FPDFText_GetMatrix(textPage: number, index: number, out: number): boolean;
}

/**
 * One process-wide PDFium module, created on the FIRST open and shared after.
 *
 * Lazy behind a dynamic import so the extension's activation never pays for the
 * module or the 2 MiB of WASM; process-wide because PDFium's C globals are, and
 * a second `PDFiumExt_Init` on a fresh module would leave two allocators
 * pointing at documents opened through the other.
 */
let modulePromise: Promise<PdfiumModule> | undefined;

async function pdfium(wasmBinary: Uint8Array): Promise<PdfiumModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const { init } = await import("@embedpdf/pdfium");
      const m = (await init({ wasmBinary })) as unknown as PdfiumModule;
      m.PDFiumExt_Init();
      return m;
    })();
  }
  return modulePromise;
}

export function createPdfiumRenderer(wasmBinary: Uint8Array): PdfRenderer {
  return async (pdf: Uint8Array): Promise<PdfDocument | undefined> => {
    if (pdf.length === 0) return undefined;
    const m = await pdfium(wasmBinary);
    const em = m.pdfium;
    const malloc = (n: number) => em.wasmExports.malloc(n);
    const free = (p: number) => em.wasmExports.free(p);

    const filePtr = malloc(pdf.length);
    em.HEAPU8.set(pdf, filePtr);
    const docPtr = m.FPDF_LoadMemDocument(filePtr, pdf.length, 0);
    if (!docPtr) {
      // Honest degradation, the rule `ManuscriptGraphReader` follows: these
      // bytes are not a PDF this renderer can open. Never a throw.
      free(filePtr);
      return undefined;
    }

    const pageCount = m.FPDF_GetPageCount(docPtr);
    let closed = false;

    /**
     * The page's size in points.
     *
     * **The two out-params are FLOATS, not doubles.** Reading them as doubles
     * returns garbage (~8.1e20) with no error at all — the raw-binding tax S6
     * found only by probing, and the reason this is not inlined at its callers.
     */
    const sizeOf = (page: number): { width: number; height: number } => {
      const out = malloc(8);
      m.EPDF_GetPageSizeByIndexNormalized(docPtr, page - 1, out);
      const width = em.getValue(out, "float");
      const height = em.getValue(out + 4, "float");
      free(out);
      return { width, height };
    };

    const assertPage = (page: number): void => {
      if (!Number.isInteger(page) || page < 1 || page > pageCount) {
        throw new Error(
          `page ${page} is out of range (this PDF has ${pageCount})`,
        );
      }
    };

    const document: PdfDocument = {
      pageCount,
      pageSize: (page) => {
        assertPage(page);
        return sizeOf(page);
      },

      renderPage: async (page, opts): Promise<PdfPageImage> => {
        assertPage(page);
        const { width: wPt, height: hPt } = sizeOf(page);
        const pw = Math.max(1, Math.round(opts.width));
        // The height is DERIVED, never supplied: a width alone leaves the
        // bitmap at the page's original point height and silently distorts
        // (S6, measured on both candidates).
        const ph = Math.max(1, Math.round((hPt / wPt) * pw));

        // Both handles are freed in a `finally`. The tool turns a throw in
        // here into an `unavailable` refusal and the session carries on, so a
        // leak would not surface as a crash — it would accumulate silently
        // across a review, one pathological page at a time.
        let bgra: Uint8Array;
        let stride: number;
        const pagePtr = m.FPDF_LoadPage(docPtr, page - 1);
        let bmp = 0;
        try {
          bmp = m.FPDFBitmap_Create(pw, ph, FPDF_BITMAP_BGRA);
          if (!bmp) throw new Error(`could not allocate a ${pw}x${ph} bitmap`);
          m.FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 0xffffffff);
          m.FPDF_RenderPageBitmap(bmp, pagePtr, 0, 0, pw, ph, 0, FPDF_ANNOT);
          const bufPtr = m.FPDFBitmap_GetBuffer(bmp);
          stride = m.FPDFBitmap_GetStride(bmp);
          // `.slice()` copies out of the WASM heap, which can be re-grown or
          // re-used the moment anything else allocates.
          bgra = new Uint8Array(em.HEAPU8.buffer, bufPtr, stride * ph).slice();
        } finally {
          if (bmp) m.FPDFBitmap_Destroy(bmp);
          m.FPDF_ClosePage(pagePtr);
        }

        const rgba = bgraToRgba(bgra);
        // Which rows to keep. A whole page is all of them; a half is the top
        // or bottom, and the caller has already asked for twice the width it
        // wants, so the crop arrives at the intended pixel width at twice the
        // resolution (ADR 0080 §7's zoom).
        // The split is `[0, H/2)` and `[H/2, H)` — between them they cover
        // EVERY row, so nothing at the seam falls out of both halves. On an
        // odd height the bottom half is one row taller; taking `floor(H/2)`
        // for both would drop the middle row from each, which is invisible
        // until a line of text sits on it.
        const split = Math.floor(ph / 2);
        const firstRow = opts.half === "bottom" ? split : 0;
        const outHeight = opts.half
          ? opts.half === "bottom"
            ? ph - split
            : split
          : ph;

        // PDFium may PAD each row: `stride` is bytes per row, which is not
        // necessarily `width * 4`. `fast-png` wants exactly `width * 4`, so a
        // padded bitmap has to be repacked rather than sliced — a subarray of
        // a padded buffer shears the image progressively down the page, which
        // every size assertion would still pass.
        const rowBytes = pw * 4;
        let out: Uint8Array;
        if (stride === rowBytes) {
          out = rgba.subarray(
            firstRow * stride,
            (firstRow + outHeight) * stride,
          );
        } else {
          out = new Uint8Array(rowBytes * outHeight);
          for (let row = 0; row < outHeight; row++) {
            const from = (firstRow + row) * stride;
            out.set(rgba.subarray(from, from + rowBytes), row * rowBytes);
          }
        }
        return {
          png: encodeRgbaPng(out, pw, outHeight),
          width: pw,
          height: outHeight,
        };
      },

      pageText: async (page) => {
        assertPage(page);
        // Three things to give back — the buffer and both page handles — so
        // they are given back in a `finally`, as `renderPage` does above.
        const pagePtr = m.FPDF_LoadPage(docPtr, page - 1);
        let textPage = 0;
        let out = 0;
        try {
          textPage = m.FPDFText_LoadPage(pagePtr);
          const count = m.FPDFText_CountChars(textPage);
          // UTF-16, NUL-terminated — two bytes a char plus the terminator.
          out = malloc((count + 1) * 2);
          m.FPDFText_GetText(textPage, 0, count, out);
          return em.UTF16ToString(out);
        } finally {
          if (out) free(out);
          if (textPage) m.FPDFText_ClosePage(textPage);
          m.FPDF_ClosePage(pagePtr);
        }
      },

      pageTextSizes: async (page) => {
        assertPage(page);
        // The same three handles `pageText` gives back, plus the matrix
        // buffer, all in a `finally`.
        const pagePtr = m.FPDF_LoadPage(docPtr, page - 1);
        let textPage = 0;
        let matrix = 0;
        try {
          textPage = m.FPDFText_LoadPage(pagePtr);
          const count = m.FPDFText_CountChars(textPage);
          matrix = malloc(24);
          const bySize = new Map<number, number>();
          for (let i = 0; i < count; i++) {
            const code = m.FPDFText_GetUnicode(textPage, i);
            // Whitespace is not text a reader reads — and PDFium GENERATES
            // spaces and line breaks between runs, which carry a size of
            // their own that is nobody's.
            if (code === 0 || /\s/.test(String.fromCodePoint(code))) continue;
            const nominal = m.FPDFText_GetFontSize(textPage, i);
            // **The FS_MATRIX is six FLOATS, not doubles** — the page size's
            // trap again: reading doubles returns garbage with no error.
            // `false` means PDFium has no matrix for this character, and the
            // nominal size is then the only honest reading (scale 1).
            let scale = 1;
            if (m.FPDFText_GetMatrix(textPage, i, matrix)) {
              const a = em.getValue(matrix, "float");
              const b = em.getValue(matrix + 4, "float");
              const c = em.getValue(matrix + 8, "float");
              const d = em.getValue(matrix + 12, "float");
              scale = Math.sqrt(Math.abs(a * d - b * c));
            }
            const size = Math.round(nominal * scale * 10) / 10;
            if (!Number.isFinite(size) || size <= 0) continue;
            bySize.set(size, (bySize.get(size) ?? 0) + 1);
          }
          return [...bySize]
            .sort(([a], [b]) => a - b)
            .map(([sizePt, chars]) => ({ sizePt, chars }));
        } finally {
          if (matrix) free(matrix);
          if (textPage) m.FPDFText_ClosePage(textPage);
          m.FPDF_ClosePage(pagePtr);
        }
      },

      metadata: async (): Promise<PdfMetadata> => {
        const read = (tag: string): string | undefined => {
          // Two calls: the first asks how many BYTES the value needs.
          const bytes = m.FPDF_GetMetaText(docPtr, tag, 0, 0);
          if (bytes <= 2) return undefined; // just the NUL terminator
          const out = malloc(bytes);
          m.FPDF_GetMetaText(docPtr, tag, out, bytes);
          const value = em.UTF16ToString(out);
          free(out);
          return value === "" ? undefined : value;
        };
        const title = read("Title");
        const author = read("Author");
        const creator = read("Creator");
        const producer = read("Producer");
        return {
          ...(title ? { title } : {}),
          ...(author ? { author } : {}),
          ...(creator ? { creator } : {}),
          ...(producer ? { producer } : {}),
        };
      },

      close: () => {
        // Idempotent (V4): a second close would free the document and its
        // bytes twice, which corrupts the allocator every other open shares
        // and surfaces nowhere near the call that did it.
        if (closed) return;
        closed = true;
        m.FPDF_CloseDocument(docPtr);
        free(filePtr);
      },
    };

    return document;
  };
}
