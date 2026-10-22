import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledVenuesDir } from "../../src/venue/bundled.js";
import { getVenue, listVenues } from "../../src/venue/library.js";
import { VenueError } from "../../src/venue/manifest.js";

function manifestYaml(id: string, nameEn = id): string {
  return [
    `id: ${id}`,
    `name: { en: "${nameEn}", zh: "${nameEn}-zh" }`,
    "documentclass: { class: article }",
    "engine: pdflatex",
    "starter_files: []",
    "",
  ].join("\n");
}

async function writeVenue(
  root: string,
  dirName: string,
  yaml: string,
  withRequirements = true,
): Promise<void> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "venue.yaml"), yaml, "utf8");
  if (withRequirements) {
    await writeFile(join(dir, "requirements.md"), "# reqs\n", "utf8");
  }
}

describe("venue library", () => {
  let bundled: string;
  let cache: string;

  beforeEach(async () => {
    bundled = await mkdtemp(join(tmpdir(), "lemmaria-venues-bundled-"));
    cache = await mkdtemp(join(tmpdir(), "lemmaria-venues-cache-"));
    // Hermetic default cache: redirect the `.lemmaria` root away from the
    // real home dir so tests that pass no cacheDir see an empty overlay.
    vi.stubEnv("LEMMARIA_MEMORY_DIR", join(cache, "isolated-home"));
    await writeVenue(bundled, "beta", manifestYaml("beta"));
    await writeVenue(bundled, "alpha", manifestYaml("alpha"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(bundled, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("lists bundled venues sorted by id", async () => {
    const { venues, errors } = await listVenues({ bundledDir: bundled });
    expect(errors).toEqual([]);
    expect(venues.map((v) => v.manifest.id)).toEqual(["alpha", "beta"]);
    expect(venues.every((v) => v.source === "bundled")).toBe(true);
  });

  it("cache overlays bundled per id (cache wins) and adds new ids", async () => {
    await writeVenue(cache, "alpha", manifestYaml("alpha", "alpha-patched"));
    await writeVenue(cache, "gamma", manifestYaml("gamma"));
    const { venues } = await listVenues({
      bundledDir: bundled,
      cacheDir: cache,
    });
    expect(venues.map((v) => v.manifest.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    const alpha = venues.find((v) => v.manifest.id === "alpha");
    expect(alpha?.source).toBe("cache");
    expect(alpha?.manifest.name.en).toBe("alpha-patched");
    expect(venues.find((v) => v.manifest.id === "gamma")?.source).toBe("cache");
  });

  it("a missing cache dir is an empty overlay, not an error", async () => {
    const { venues, errors } = await listVenues({
      bundledDir: bundled,
      cacheDir: join(cache, "does-not-exist"),
    });
    expect(errors).toEqual([]);
    expect(venues).toHaveLength(2);
  });

  it("an invalid cache venue.yaml is surfaced in errors without breaking the list", async () => {
    await writeVenue(cache, "broken", "id: broken\n"); // missing name/class/engine
    const { venues, errors } = await listVenues({
      bundledDir: bundled,
      cacheDir: cache,
    });
    expect(venues).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.dir).toContain("broken");
  });

  it("a venue dir missing requirements.md is surfaced in errors", async () => {
    await writeVenue(cache, "noreq", manifestYaml("noreq"), false);
    const { venues, errors } = await listVenues({
      bundledDir: bundled,
      cacheDir: cache,
    });
    expect(venues).toHaveLength(2);
    expect(errors[0]?.message).toMatch(/requirements\.md/);
  });

  it("subdirectories without a venue.yaml are skipped silently", async () => {
    await mkdir(join(bundled, "not-a-venue"), { recursive: true });
    const { venues, errors } = await listVenues({ bundledDir: bundled });
    expect(venues).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("getVenue throws unknown_venue naming the known ids", async () => {
    let err: unknown;
    try {
      await getVenue("nope", { bundledDir: bundled });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe("unknown_venue");
    expect((err as VenueError).message).toContain("alpha");
    expect((err as VenueError).message).toContain("beta");
  });

  it("getVenue resolves a bundled venue with its dir", async () => {
    const v = await getVenue("alpha", { bundledDir: bundled });
    expect(v.manifest.id).toBe("alpha");
    expect(v.dir).toBe(join(bundled, "alpha"));
  });

  it("the real bundled dir lists the three curated ids", async () => {
    const { venues, errors } = await listVenues({
      bundledDir: bundledVenuesDir(),
    });
    expect(errors).toEqual([]);
    expect(venues.map((v) => v.manifest.id)).toEqual([
      "acm-sigconf",
      "ieee-conference",
      "llncs",
    ]);
  });
});
