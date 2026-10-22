import { describe, expect, it } from "vitest";
import type {
  PdfDocument,
  PdfPageImage,
} from "../../../src/contracts/adapters.js";
import type { ToolError } from "../../../src/contracts/results.js";
import {
  PDF_RENDER_WIDTH_PX,
  PDF_ZOOM_SCALE,
  VIEW_PDF_PAGES_MAX_PER_CALL,
  VIEW_PDF_PAGES_MAX_VIEWS,
  VIEW_PDF_PAGES_SPEC,
  createViewPdfPagesTool,
} from "../../../src/session/loop-tools/pdf-pages.js";

/** Records every render so a case can assert WHAT was asked of the renderer. */
function fakeDocument(
  pageCount = 10,
  opts: { throwOnRender?: boolean } = {},
): PdfDocument & {
  renders: Array<{ page: number; width: number; half?: "top" | "bottom" }>;
  closed: () => boolean;
} {
  const renders: Array<{
    page: number;
    width: number;
    half?: "top" | "bottom";
  }> = [];
  let closed = false;
  return {
    renders,
    closed: () => closed,
    pageCount,
    pageSize: () => ({ width: 612, height: 792 }),
    renderPage: async (page, o): Promise<PdfPageImage> => {
      if (opts.throwOnRender) throw new Error("wasm trap");
      renders.push({
        page,
        width: o.width,
        ...(o.half ? { half: o.half } : {}),
      });
      const height = Math.round(o.width * (792 / 612));
      return {
        png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, page]),
        width: o.width,
        height: o.half ? Math.round(height / 2) : height,
      };
    },
    pageText: async () => "text",
    metadata: async () => ({ producer: "pdfTeX" }),
    close: () => {
      closed = true;
    },
  };
}

const errorOf = (outcome: { ok: boolean; error?: ToolError }): ToolError => {
  if (outcome.ok) throw new Error("expected a refusal, got a success");
  return outcome.error as ToolError;
};

describe("VIEW_PDF_PAGES_SPEC — the argument contract (V3, ADR 0080 §7)", () => {
  it("is named, and takes pages plus an optional zoom", () => {
    expect(VIEW_PDF_PAGES_SPEC.name).toBe("view_pdf_pages");
    expect(VIEW_PDF_PAGES_SPEC.parameters).toEqual({
      type: "object",
      properties: {
        pages: {
          type: "array",
          items: { type: "integer" },
          description: expect.any(String),
        },
        zoom: {
          type: "string",
          enum: ["top", "bottom"],
          description: expect.any(String),
        },
      },
      required: ["pages"],
      additionalProperties: false,
    });
  });

  it("accepts NO path — the only string argument in the schema is zoom", () => {
    // Invariant 2 and stage-gate claim 4: the PDF is fixed for the review by
    // the harness's own policy, so a model cannot address a file at all.
    const props = (
      VIEW_PDF_PAGES_SPEC.parameters as {
        properties: Record<string, { type?: string }>;
      }
    ).properties;
    const stringArgs = Object.entries(props)
      .filter(([, schema]) => schema.type === "string")
      .map(([name]) => name);
    expect(stringArgs).toEqual(["zoom"]);
  });

  it("the description names both bounds and the eviction, in English", () => {
    const d = VIEW_PDF_PAGES_SPEC.description;
    expect(d).toContain(String(VIEW_PDF_PAGES_MAX_PER_CALL));
    expect(d).toContain(String(VIEW_PDF_PAGES_MAX_VIEWS));
    expect(d).toMatch(/write down what you saw/i);
    expect(d).toMatch(/cannot choose the file/i);
    // Invariant 6 rule 3: system-facing text is English only.
    expect(d).not.toMatch(/[一-鿿]/);
  });

  it("the bounds and the width are what the plan fixed", () => {
    expect(VIEW_PDF_PAGES_MAX_PER_CALL).toBe(6);
    expect(VIEW_PDF_PAGES_MAX_VIEWS).toBe(60);
    expect(PDF_RENDER_WIDTH_PX).toBe(1100);
    expect(PDF_ZOOM_SCALE).toBe(2);
  });
});

describe("createViewPdfPagesTool — refusals are data (V3, ADR 0080 §7)", () => {
  const toolFor = (doc: PdfDocument, over: Record<string, unknown> = {}) =>
    createViewPdfPagesTool({ document: doc, ...over });

  it("is a sequential retrieval tool", () => {
    const { executor } = toolFor(fakeDocument());
    expect(executor.category).toBe("retrieval");
    // Absent means sequential: rendering is CPU-bound WASM and the view
    // counter stays trivially correct.
    expect(executor.executionMode).toBeUndefined();
  });

  it.each([
    ["missing pages", {}],
    ["pages not an array", { pages: 1 }],
    ["an empty array", { pages: [] }],
    ["a non-integer element", { pages: [1.5] }],
    ["a string element", { pages: ["1"] }],
    ["page 0", { pages: [0] }],
    ["a negative page", { pages: [-2] }],
    ["a page past the end", { pages: [11] }],
    ["args that are not an object", null],
  ])("refuses %s as `invalid`", async (_label, args) => {
    const { executor } = toolFor(fakeDocument());
    const out = await executor.invoke(args);
    expect(errorOf(out).code).toBe("invalid");
  });

  it("names the real page count when a page is out of range", async () => {
    const { executor } = toolFor(fakeDocument(3));
    const out = await executor.invoke({ pages: [4] });
    expect(errorOf(out).message).toContain("3");
  });

  it("refuses a zoom that is neither top nor bottom as `invalid`", async () => {
    const { executor } = toolFor(fakeDocument());
    const out = await executor.invoke({ pages: [1], zoom: "middle" });
    expect(errorOf(out).code).toBe("invalid");
  });

  it("refuses more than 6 distinct pages as `too_large`, naming the bound", async () => {
    const { executor } = toolFor(fakeDocument());
    const out = await executor.invoke({ pages: [1, 2, 3, 4, 5, 6, 7] });
    const err = errorOf(out);
    expect(err.code).toBe("too_large");
    expect(err.message).toContain("6");
  });

  it("refuses more pages than the task has views left, naming what remains", async () => {
    const { executor, views } = toolFor(fakeDocument(), { maxViews: 2 });
    const out = await executor.invoke({ pages: [1, 2, 3] });
    const err = errorOf(out);
    expect(err.code).toBe("too_large");
    expect(err.message).toContain("2");
    // A refusal spends nothing.
    expect(views.remaining).toBe(2);
  });

  it("reports a throwing renderer as `unavailable`, never as a crash", async () => {
    const { executor } = toolFor(fakeDocument(10, { throwOnRender: true }));
    const out = await executor.invoke({ pages: [1] });
    expect(errorOf(out).code).toBe("unavailable");
  });

  it("refuses BEFORE anything renders", async () => {
    const doc = fakeDocument(3);
    const { executor } = toolFor(doc);
    await executor.invoke({ pages: [1, 99] });
    expect(doc.renders).toEqual([]);
  });
});

describe("createViewPdfPagesTool — what it hands back", () => {
  it("returns one labelled PNG part per page, in call order, beside its JSON", async () => {
    const doc = fakeDocument();
    const { executor } = createViewPdfPagesTool({ document: doc });
    const out = await executor.invoke({ pages: [3, 1] });

    expect(out.ok).toBe(true);
    expect(out.ok && out.value).toEqual({
      pages: [
        { page: 3, width: 1100, height: 1424 },
        { page: 1, width: 1100, height: 1424 },
      ],
      pageCount: 10,
      viewsRemaining: 58,
    });
    expect(out.images).toHaveLength(2);
    expect(out.images?.map((i) => i.label)).toEqual(["page 3", "page 1"]);
    expect(out.images?.every((i) => i.mimeType === "image/png")).toBe(true);
    expect(out.images?.every((i) => (i.data?.length ?? 0) > 0)).toBe(true);
    expect(doc.renders.map((r) => r.page)).toEqual([3, 1]);
  });

  it("the JSON already names which pages were shown — it is what survives eviction", async () => {
    const { executor } = createViewPdfPagesTool({ document: fakeDocument() });
    const out = await executor.invoke({ pages: [2] });
    expect(JSON.stringify(out.ok && out.value)).toContain('"page":2');
  });

  it("collapses duplicates and keeps first-seen order, spending one view each", async () => {
    const doc = fakeDocument();
    const { executor, views } = createViewPdfPagesTool({ document: doc });
    const out = await executor.invoke({ pages: [2, 1, 2, 1] });
    expect(doc.renders.map((r) => r.page)).toEqual([2, 1]);
    expect(out.images).toHaveLength(2);
    expect(views.remaining).toBe(58);
  });

  it("renders at the fixed width, which a model cannot choose", async () => {
    const doc = fakeDocument();
    const { executor } = createViewPdfPagesTool({ document: doc });
    await executor.invoke({ pages: [1], width: 4000 });
    expect(doc.renders[0]?.width).toBe(PDF_RENDER_WIDTH_PX);
  });

  it("a zoomed page renders that half at twice the width, and is still ONE view", async () => {
    const doc = fakeDocument();
    const { executor, views } = createViewPdfPagesTool({ document: doc });
    const out = await executor.invoke({ pages: [4], zoom: "top" });
    expect(doc.renders[0]).toEqual({
      page: 4,
      width: PDF_RENDER_WIDTH_PX * PDF_ZOOM_SCALE,
      half: "top",
    });
    expect(out.images?.[0]?.label).toBe("page 4 (top)");
    expect(views.remaining).toBe(59);
    expect(out.ok && (out.value as { pages: unknown[] }).pages).toEqual([
      { page: 4, width: 2200, height: 1424, zoom: "top" },
    ]);
  });

  it("`viewed` grows across calls and never shrinks", async () => {
    const { executor, viewed } = createViewPdfPagesTool({
      document: fakeDocument(),
    });
    await executor.invoke({ pages: [1, 2] });
    await executor.invoke({ pages: [2, 5] });
    expect([...viewed].sort((a, b) => a - b)).toEqual([1, 2, 5]);
  });

  it("the budget runs down across calls and then refuses", async () => {
    const { executor, views } = createViewPdfPagesTool({
      document: fakeDocument(),
      maxViews: 3,
    });
    await executor.invoke({ pages: [1, 2] });
    expect(views.remaining).toBe(1);
    const ok1 = await executor.invoke({ pages: [3] });
    expect(ok1.ok).toBe(true);
    expect(views.remaining).toBe(0);
    const out = await executor.invoke({ pages: [4] });
    expect(errorOf(out).code).toBe("too_large");
  });

  it("re-viewing a page it already saw still costs a view", async () => {
    // The budget bounds RENDERS and the tokens they cost, not distinct pages.
    const { executor, views } = createViewPdfPagesTool({
      document: fakeDocument(),
      maxViews: 60,
    });
    await executor.invoke({ pages: [1] });
    await executor.invoke({ pages: [1] });
    expect(views.remaining).toBe(58);
  });
});
