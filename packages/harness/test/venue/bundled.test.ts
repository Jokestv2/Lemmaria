import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledVenuesDir } from "../../src/venue/bundled.js";
import { parseVenueManifest } from "../../src/venue/manifest.js";

/** Pins the shipped curated set (ADR 0010): every bundled venue must be a
 *  complete, parseable venue dir — this is what the picker and the scaffolder
 *  trust without re-validating at every call site. */
describe("bundled curated venue set", () => {
  it("ships exactly the curated ids", async () => {
    const entries = await readdir(bundledVenuesDir());
    expect(entries.sort()).toEqual(["acm-sigconf", "ieee-conference", "llncs"]);
  });

  it("every bundled venue parses and is complete", async () => {
    const dir = bundledVenuesDir();
    for (const id of await readdir(dir)) {
      const venueDir = join(dir, id);
      const manifest = parseVenueManifest(
        await readFile(join(venueDir, "venue.yaml"), "utf8"),
        `${id}/venue.yaml`,
      );
      expect(manifest.id).toBe(id);
      const req = await readFile(join(venueDir, "requirements.md"), "utf8");
      expect(req.trim().length).toBeGreaterThan(0);
      for (const rel of manifest.starter_files) {
        const s = await stat(join(venueDir, rel));
        expect(s.isFile()).toBe(true);
      }
    }
  });

  it("llncs is the reference-and-fetch exemplar", async () => {
    const manifest = parseVenueManifest(
      await readFile(join(bundledVenuesDir(), "llncs", "venue.yaml"), "utf8"),
    );
    expect(manifest.redistribute).toBe(false);
    expect(manifest.fetch_files).toHaveLength(2);
    expect(manifest.source_url).toBeDefined();
  });

  it("acm-sigconf and ieee-conference are redistributable with .tex starters", async () => {
    for (const id of ["acm-sigconf", "ieee-conference"]) {
      const manifest = parseVenueManifest(
        await readFile(join(bundledVenuesDir(), id, "venue.yaml"), "utf8"),
      );
      expect(manifest.redistribute).toBe(true);
      expect(manifest.starter_files).toContain("main.tex");
      expect(manifest.engine).toBe("pdflatex");
    }
  });
});
