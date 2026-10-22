import { describe, expect, it, vi } from "vitest";
import { mockSource } from "../../src/engine/citation-lookup.js";
import { checkCitationMetadata } from "../../src/engine/citation-metadata.js";

const entry = (fields: Record<string, string>) => ({ key: "k", fields });

describe("checkCitationMetadata", () => {
  it("returns ok when metadata matches (DOI-first)", async () => {
    const src = mockSource("crossref", () => ({
      title: "T",
      year: "2020",
      venue: "ACL",
    }));
    const [r] = await checkCitationMetadata(
      [entry({ doi: "10/x", title: "T", year: "2020", journal: "ACL" })],
      { sources: [src] },
    );
    expect(r).toMatchObject({
      key: "k",
      status: "ok",
      source: "crossref",
      matchedBy: "doi",
    });
  });

  it("returns metadata_mismatch with a correction when a field differs", async () => {
    const src = mockSource("crossref", () => ({ year: "2021" }));
    const [r] = await checkCitationMetadata(
      [entry({ doi: "10/x", year: "2019" })],
      {
        sources: [src],
      },
    );
    expect(r?.status).toBe("metadata_mismatch");
    expect(r?.correction?.key).toBe("k");
    expect(r?.correction?.changes).toContainEqual({
      field: "year",
      from: "2019",
      to: "2021",
    });
  });

  it("falls back to a title query when there is no DOI", async () => {
    const src = mockSource("crossref", (q) =>
      q.title ? { title: q.title, year: "2020" } : null,
    );
    const [r] = await checkCitationMetadata(
      [entry({ title: "Some Paper", year: "2020" })],
      { sources: [src] },
    );
    expect(r).toMatchObject({ status: "ok", matchedBy: "title" });
  });

  it("treats a full-name author from the source as matching the bib surname (no spurious mismatch)", async () => {
    const src = mockSource("crossref", () => ({
      year: "2020",
      authors: ["Jane Smith"],
    }));
    const [r] = await checkCitationMetadata(
      [entry({ doi: "10/x", year: "2020", author: "Smith, Jane" })],
      { sources: [src] },
    );
    expect(r?.status).toBe("ok");
  });

  it("flags a genuinely different author set as a mismatch", async () => {
    const src = mockSource("crossref", () => ({
      year: "2020",
      authors: ["Alan Turing"],
    }));
    const [r] = await checkCitationMetadata(
      [entry({ doi: "10/x", year: "2020", author: "Smith, Jane" })],
      { sources: [src] },
    );
    expect(r?.status).toBe("metadata_mismatch");
    expect(r?.correction?.changes.map((c) => c.field)).toContain("author");
  });

  it("returns not_found when every source completes with no record", async () => {
    const src = mockSource("crossref", () => null);
    const [r] = await checkCitationMetadata([entry({ title: "Ghost" })], {
      sources: [src],
    });
    expect(r?.status).toBe("not_found");
  });

  it("returns not_found when the entry has neither DOI nor title", async () => {
    const src = mockSource("crossref", () => ({ year: "2020" }));
    const [r] = await checkCitationMetadata([entry({ note: "x" })], {
      sources: [src],
    });
    expect(r?.status).toBe("not_found");
  });

  it("flags a preprint that has a published version (preprint_superseded)", async () => {
    const src = mockSource("crossref", () => ({
      title: "T",
      venue: "NeurIPS",
      publishedDoi: "10.5555/pub",
    }));
    const [r] = await checkCitationMetadata(
      [entry({ doi: "10/arxiv", title: "T", archiveprefix: "arXiv" })],
      { sources: [src] },
    );
    expect(r?.status).toBe("preprint_superseded");
    expect(r?.correction?.changes.map((c) => c.field)).toContain("doi");
  });

  it("returns unverified (not not_found) on a timeout, and never throws", async () => {
    const src = mockSource(
      "crossref",
      (_q, signal) =>
        new Promise<null>((_res, rej) => {
          signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const results = await checkCitationMetadata([entry({ doi: "10/x" })], {
      sources: [src],
      timeoutMs: 20,
    });
    expect(results[0]?.status).toBe("unverified");
  });

  it("caches a lookup so a repeated query hits the source once", async () => {
    const responder = vi.fn(() => ({ year: "2020" }));
    const src = mockSource("crossref", responder);
    const cache = new Map();
    await checkCitationMetadata(
      [entry({ doi: "10/x" }), entry({ doi: "10/x" })],
      { sources: [src], cache },
    );
    expect(responder).toHaveBeenCalledTimes(1);
  });
});
