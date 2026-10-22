import { describe, expect, it } from "vitest";
import {
  crossrefSource,
  dblpSource,
  mockSource,
  semanticScholarSource,
} from "../../src/engine/citation-lookup.js";

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});

describe("crossrefSource", () => {
  it("maps a DOI response to CitationMetadata and exposes its endpoint", async () => {
    const src = crossrefSource(() =>
      Promise.resolve(
        okJson({
          message: {
            title: ["Attention Is All You Need"],
            published: { "date-parts": [[2017]] },
            "container-title": ["NeurIPS"],
            DOI: "10.5555/xyz",
          },
        }),
      ),
    );
    const md = await src.lookup(
      { doi: "10.5555/xyz" },
      AbortSignal.timeout(1000),
    );
    expect(md).toMatchObject({
      title: "Attention Is All You Need",
      year: "2017",
      venue: "NeurIPS",
    });
    expect(src.name).toBe("crossref");
    expect(src.endpoint).toMatch(/crossref/i);
  });

  it("returns null on a non-ok response", async () => {
    const src = crossrefSource(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      }),
    );
    expect(
      await src.lookup({ doi: "10/x" }, AbortSignal.timeout(1000)),
    ).toBeNull();
  });
});

describe("dblpSource + semanticScholarSource", () => {
  it("expose distinct names and endpoints", () => {
    expect(dblpSource().name).toBe("dblp");
    expect(dblpSource().endpoint).toMatch(/dblp/i);
    expect(semanticScholarSource().name).toBe("semantic_scholar");
    expect(semanticScholarSource().endpoint).toMatch(/semanticscholar/i);
  });
});

describe("mockSource", () => {
  it("returns whatever the responder yields, and passes the signal", async () => {
    const src = mockSource("crossref", (q) => ({ title: q.title ?? "" }));
    const md = await src.lookup({ title: "T" }, AbortSignal.timeout(1000));
    expect(md).toEqual({ title: "T" });
  });
});
