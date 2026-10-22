import { describe, expect, it } from "vitest";
import type { LoadedVenue, VenueManifest } from "../../src/index.js";
import { computeVenueChecklist, matchVenueByClass } from "../../src/index.js";

function manifest(
  over: Partial<VenueManifest> & { id: string },
): VenueManifest {
  return {
    name: { en: over.id, zh: over.id },
    documentclass: { class: "article", options: [] },
    engine: "pdflatex",
    starter_files: [],
    redistribute: true,
    ...over,
  };
}

function venue(m: VenueManifest): LoadedVenue {
  return { manifest: m, dir: `/x/${m.id}`, source: "bundled" };
}

const ACM = manifest({
  id: "acm-sigconf",
  documentclass: { class: "acmart", options: ["sigconf"] },
  bibstyle: "ACM-Reference-Format",
  page_limit: { value: 9, unit: "pages" },
  anonymity: "double_blind",
});
const IEEE = manifest({
  id: "ieee-conference",
  documentclass: { class: "IEEEtran", options: ["conference"] },
  bibstyle: "IEEEtran",
  anonymity: "none",
});

describe("matchVenueByClass", () => {
  const venues = [venue(ACM), venue(IEEE)];

  it("matches by documentclass name", () => {
    expect(
      matchVenueByClass({ name: "IEEEtran", options: [] }, venues)?.manifest.id,
    ).toBe("ieee-conference");
  });

  it("returns undefined for an unknown class or no detection", () => {
    expect(
      matchVenueByClass({ name: "article", options: [] }, venues),
    ).toBeUndefined();
    expect(matchVenueByClass(undefined, venues)).toBeUndefined();
  });

  it("prefers the same-class venue whose manifest options all appear", () => {
    const journal = manifest({
      id: "acm-journal",
      documentclass: { class: "acmart", options: ["acmsmall"] },
    });
    const both = [venue(journal), venue(ACM)];
    expect(
      matchVenueByClass(
        { name: "acmart", options: ["sigconf", "anonymous"] },
        both,
      )?.manifest.id,
    ).toBe("acm-sigconf");
    // Neither option set matches → falls back to the first same-class venue.
    expect(
      matchVenueByClass({ name: "acmart", options: [] }, both)?.manifest.id,
    ).toBe("acm-journal");
  });
});

describe("computeVenueChecklist", () => {
  it("passes anonymity for none/single_blind and for acmart with the anonymous option", () => {
    const none = computeVenueChecklist({
      manifest: IEEE,
      detected: { name: "IEEEtran", options: ["conference"] },
    });
    expect(none.find((r) => r.id === "anonymity")?.status).toBe("pass");

    const anon = computeVenueChecklist({
      manifest: ACM,
      detected: { name: "acmart", options: ["sigconf", "anonymous"] },
    });
    expect(anon.find((r) => r.id === "anonymity")?.status).toBe("pass");

    const single = computeVenueChecklist({
      manifest: manifest({ id: "x", anonymity: "single_blind" }),
      detected: { name: "article", options: [] },
    });
    expect(single.find((r) => r.id === "anonymity")?.status).toBe("pass");
  });

  it("fails anonymity for double_blind acmart without the option; unknown for classes with no switch", () => {
    const fail = computeVenueChecklist({
      manifest: ACM,
      detected: { name: "acmart", options: ["sigconf"] },
    });
    expect(fail.find((r) => r.id === "anonymity")?.status).toBe("fail");

    const unk = computeVenueChecklist({
      manifest: manifest({ id: "x", anonymity: "double_blind" }),
      detected: { name: "llncs", options: [] },
    });
    expect(unk.find((r) => r.id === "anonymity")?.status).toBe("unknown");
  });

  it("compares pages against the limit only when both are known", () => {
    const detected = { name: "acmart", options: ["sigconf"] };
    const pick = (pages?: number) =>
      computeVenueChecklist({
        manifest: ACM,
        detected,
        ...(pages !== undefined ? { pages } : {}),
      }).find((r) => r.id === "page_limit");
    expect(pick(7)?.status).toBe("pass");
    expect(pick(10)?.status).toBe("fail");
    expect(pick(undefined)?.status).toBe("unknown");
    const noLimit = computeVenueChecklist({
      manifest: IEEE,
      detected: { name: "IEEEtran", options: [] },
      pages: 4,
    }).find((r) => r.id === "page_limit");
    expect(noLimit?.status).toBe("unknown");
  });

  it("compares bibstyle exactly; unknown when either side is missing", () => {
    const detected = { name: "IEEEtran", options: [] };
    const row = (bib?: string) =>
      computeVenueChecklist({
        manifest: IEEE,
        detected,
        ...(bib !== undefined ? { bibliographyStyle: bib } : {}),
      }).find((r) => r.id === "bibstyle");
    expect(row("IEEEtran")?.status).toBe("pass");
    expect(row("plain")?.status).toBe("fail");
    expect(row(undefined)?.status).toBe("unknown");
    const noDecl = computeVenueChecklist({
      manifest: manifest({ id: "x" }),
      detected,
      bibliographyStyle: "plain",
    }).find((r) => r.id === "bibstyle");
    expect(noDecl?.status).toBe("unknown");
  });

  it("citations: 0 errors pass, >0 fail with count, undefined unknown", () => {
    const detected = { name: "IEEEtran", options: [] };
    const row = (errors?: number) =>
      computeVenueChecklist({
        manifest: IEEE,
        detected,
        ...(errors !== undefined ? { citationErrors: errors } : {}),
      }).find((r) => r.id === "citations");
    expect(row(0)?.status).toBe("pass");
    const failing = row(2);
    expect(failing?.status).toBe("fail");
    expect(failing && "errors" in failing ? failing.errors : -1).toBe(2);
    expect(row(undefined)?.status).toBe("unknown");
  });

  it("always yields the 4 rows in mockup order", () => {
    const rows = computeVenueChecklist({
      manifest: IEEE,
      detected: { name: "IEEEtran", options: [] },
    });
    expect(rows.map((r) => r.id)).toEqual([
      "anonymity",
      "page_limit",
      "bibstyle",
      "citations",
    ]);
  });
});
