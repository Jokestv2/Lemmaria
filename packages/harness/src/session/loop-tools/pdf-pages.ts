import type {
  ImagePart,
  PdfDocument,
  ToolSpec,
} from "../../contracts/adapters.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { ToolExecutor, ToolOutcome } from "../../engine/tools.js";

/**
 * `view_pdf_pages` — rendered pages of the paper's compiled PDF (V3, ADR 0080
 * §7).
 *
 * A **session-scoped** tool in the shape of `run_script` and `load_skill`: it
 * is built from an opened `PdfDocument`, which `buildToolRegistry` has no
 * access to, so it is never in the engine registry. In V3 **no production path
 * builds it at all** — the door is proven from the CLI eval, and V4 adds the
 * seat that walks through it.
 *
 * Two things make it safe to hand a model (invariant 2):
 *
 *  - **It takes page NUMBERS, never a path.** The PDF is fixed for the review
 *    by `session/review-pdf.ts`, so the tool cannot widen the read surface —
 *    the same containment `load_skill` gets from addressing a skill by name,
 *    rather than trust that a path argument would be well-behaved.
 *  - **Both bounds refuse as DATA**, never as a throw: six pages a call and
 *    sixty page views a task, each refusal naming the bound it hit and the
 *    result always saying how many views remain.
 *
 * Adapted from Codex's `view_image` (Apache-2.0), which refuses outright for a
 * model without `InputModality::Image`. Lemmaria refuses one step earlier — the
 * name is withheld from the allowlist (`model/capabilities.ts`) — and drops the
 * blocks one step later, at the wire.
 */

/**
 * At most this many DISTINCT pages in one call. Six is a spread a reviewer can
 * actually reason about in one turn, and at the fixed width it is ~13k input
 * tokens — a bound on the turn, not just on the task.
 */
export const VIEW_PDF_PAGES_MAX_PER_CALL = 6;

/**
 * At most this many page views in one task. A bound on the TOOL, not a token
 * ceiling — `DEFAULT_TASK_BUDGET` does not move (invariant 5).
 */
export const VIEW_PDF_PAGES_MAX_VIEWS = 60;

/**
 * The render width, in pixels, and the one cost dial this tool has.
 *
 * S6 measured 800 px losing two defect kinds outright and 1500 px buying one
 * more at 1.8× the tokens; 1100 px is the knee. It is a named constant rather
 * than a model-supplied argument on purpose: a model choosing 3000 px is a cost
 * the harness would not have bounded, and width is exactly the dial V4 may want
 * to expose to a user.
 */
export const PDF_RENDER_WIDTH_PX = 1100;

/**
 * A zoomed half renders at this multiple of the width and is then cropped, so
 * it arrives at the SAME pixel width as a whole page at twice the resolution —
 * about twice a page's tokens by S6's quadratic rule, and still one view.
 */
export const PDF_ZOOM_SCALE = 2;

export const VIEW_PDF_PAGES_SPEC: ToolSpec = {
  name: "view_pdf_pages",
  description: [
    "Show yourself rendered pages of the compiled PDF of the paper under review.",
    `Give 1-based page numbers, at most ${VIEW_PDF_PAGES_MAX_PER_CALL} per call;`,
    'zoom "top" or "bottom" shows that half of each page at twice the resolution.',
    `Every page counts against a budget of ${VIEW_PDF_PAGES_MAX_VIEWS} page views for this task,`,
    "and the result says how many remain.",
    "The images stay attached until your next call to this tool, then only the page",
    "numbers remain — write down what you saw before viewing more.",
    "You cannot choose the file: the PDF is fixed for this review.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: { type: "integer" },
        description: "1-based page numbers, at most 6 per call.",
      },
      zoom: {
        type: "string",
        enum: ["top", "bottom"],
        description:
          "Show only that half of each page, at twice the resolution.",
      },
    },
    required: ["pages"],
    additionalProperties: false,
  },
};

export interface ViewPdfPagesDeps {
  document: PdfDocument;
  /** Overridable for a test; production always takes the constant. */
  width?: number;
  maxPerCall?: number;
  maxViews?: number;
}

export interface ViewPdfPagesTool {
  executor: ToolExecutor;
  /** Every page this task has been shown — for the caller's own reporting. */
  viewed: ReadonlySet<number>;
  /** Live remaining budget; read after a call, never written from outside. */
  views: { remaining: number };
}

/** One page of the result's JSON — what survives after the pixels are evicted. */
interface PageReport {
  page: number;
  width: number;
  height: number;
  zoom?: "top" | "bottom";
}

/**
 * Validate `pages` into distinct, in-range, first-seen-order page numbers, or
 * say exactly what is wrong with it. Nothing renders until this succeeds.
 */
function parsePages(
  raw: unknown,
  pageCount: number,
): { pages: number[] } | { message: string } {
  if (!Array.isArray(raw)) {
    return { message: "`pages` is required and must be an array of integers" };
  }
  if (raw.length === 0) {
    return { message: "`pages` must name at least one page" };
  }
  const pages: number[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return {
        message: `\`pages\` must contain integers; got ${JSON.stringify(value)}`,
      };
    }
    if (value < 1 || value > pageCount) {
      return {
        message: `page ${value} is out of range: this PDF has ${pageCount} page${
          pageCount === 1 ? "" : "s"
        }, numbered from 1`,
      };
    }
    if (!pages.includes(value)) pages.push(value);
  }
  return { pages };
}

export function createViewPdfPagesTool(
  deps: ViewPdfPagesDeps,
): ViewPdfPagesTool {
  const width = deps.width ?? PDF_RENDER_WIDTH_PX;
  const maxPerCall = deps.maxPerCall ?? VIEW_PDF_PAGES_MAX_PER_CALL;
  const views = { remaining: deps.maxViews ?? VIEW_PDF_PAGES_MAX_VIEWS };
  const viewed = new Set<number>();

  const executor: ToolExecutor = {
    name: "view_pdf_pages",
    category: "retrieval",
    // No executionMode: sequential. Rendering is CPU-bound WASM, so overlap
    // buys nothing, and a serial counter is trivially correct.
    spec: VIEW_PDF_PAGES_SPEC,
    invoke: async (args: unknown): Promise<ToolOutcome> => {
      const a = (args ?? {}) as { pages?: unknown; zoom?: unknown };
      if (typeof a !== "object") {
        return toolFail("invalid", "arguments must be an object");
      }

      const parsed = parsePages(a.pages, deps.document.pageCount);
      if ("message" in parsed) return toolFail("invalid", parsed.message);
      const { pages } = parsed;

      let zoom: "top" | "bottom" | undefined;
      if (a.zoom !== undefined) {
        if (a.zoom !== "top" && a.zoom !== "bottom") {
          return toolFail(
            "invalid",
            '`zoom` must be "top" or "bottom" when given',
          );
        }
        zoom = a.zoom;
      }

      if (pages.length > maxPerCall) {
        return toolFail(
          "too_large",
          `at most ${maxPerCall} pages a call; you asked for ${pages.length}`,
        );
      }
      if (pages.length > views.remaining) {
        return toolFail(
          "too_large",
          `${views.remaining} page view${
            views.remaining === 1 ? "" : "s"
          } remain in this task; you asked for ${pages.length}`,
        );
      }

      // The budget is spent BEFORE the render awaits, so a renderer that hangs
      // or throws cannot leave the counter claiming views that were consumed.
      views.remaining -= pages.length;

      const reports: PageReport[] = [];
      const images: ImagePart[] = [];
      try {
        for (const page of pages) {
          const image = await deps.document.renderPage(page, {
            width: zoom ? width * PDF_ZOOM_SCALE : width,
            ...(zoom ? { half: zoom } : {}),
          });
          viewed.add(page);
          reports.push({
            page,
            width: image.width,
            height: image.height,
            ...(zoom ? { zoom } : {}),
          });
          images.push({
            mimeType: "image/png",
            data: Buffer.from(image.png).toString("base64"),
            label: zoom ? `page ${page} (${zoom})` : `page ${page}`,
          });
        }
      } catch (error) {
        return toolFail(
          "unavailable",
          `could not render the PDF: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        ...ok({
          pages: reports,
          pageCount: deps.document.pageCount,
          viewsRemaining: views.remaining,
        }),
        images,
      };
    },
  };

  return { executor, viewed, views };
}
