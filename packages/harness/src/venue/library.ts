/**
 * Venue Template Library resolver (ADR 0010): the shipped bundled snapshot
 * overlaid by a per-id user cache dir (~/.lemmaria/venues/ by default) —
 * cache wins, so users can add or patch venues between releases. One bad
 * venue dir must never break the picker: it lands in `errors` instead.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionLocale } from "../contracts/sessions.js";
import type { VenueManifest } from "../contracts/venues.js";
import { VenueError, parseVenueManifest } from "./manifest.js";

export interface LoadedVenue {
  manifest: VenueManifest;
  /** Absolute venue dir (starter files + requirements.md live here). */
  dir: string;
  source: "bundled" | "cache";
}

export interface VenueLibraryOptions {
  /** The shipped snapshot dir — hosts pass it explicitly (CLI:
   *  bundledVenuesDir(); extension: its copied dist/venues). */
  bundledDir: string;
  /** Overlay; default ~/.lemmaria/venues. Missing dir = empty overlay. */
  cacheDir?: string;
  /** D4 (ADR 0034): the language a `VenueError` message renders in. */
  locale?: SessionLocale;
}

export interface VenueListResult {
  /** Sorted by id; cache wins per id. */
  venues: LoadedVenue[];
  /** Unparseable/incomplete venue dirs, surfaced not thrown. */
  errors: Array<{ dir: string; message: string }>;
}

export function defaultVenueCacheDir(): string {
  // `LEMMARIA_MEMORY_DIR` overrides the `.lemmaria` root (the M8 memory
  // convention) so tests — and users who relocate `.lemmaria` — get a
  // hermetic venues cache instead of the real home dir.
  const root = process.env.LEMMARIA_MEMORY_DIR ?? join(homedir(), ".lemmaria");
  return join(root, "venues");
}

async function loadLayer(
  root: string,
  source: LoadedVenue["source"],
  out: Map<string, LoadedVenue>,
  errors: VenueListResult["errors"],
  locale: SessionLocale = "en",
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // missing layer dir = empty layer
  }
  for (const name of entries) {
    const dir = join(root, name);
    let yaml: string;
    try {
      yaml = await readFile(join(dir, "venue.yaml"), "utf8");
    } catch {
      continue; // not a venue dir
    }
    try {
      const manifest = parseVenueManifest(yaml, `${name}/venue.yaml`, locale);
      await access(join(dir, "requirements.md")).catch(() => {
        throw new VenueError(
          "invalid_manifest",
          locale === "zh"
            ? `模板 "${manifest.id}" 缺少 requirements.md。`
            : `venue "${manifest.id}" is missing requirements.md.`,
        );
      });
      out.set(manifest.id, { manifest, dir, source });
    } catch (error) {
      errors.push({ dir, message: (error as Error).message });
    }
  }
}

export async function listVenues(
  opts: VenueLibraryOptions,
): Promise<VenueListResult> {
  const byId = new Map<string, LoadedVenue>();
  const errors: VenueListResult["errors"] = [];
  await loadLayer(opts.bundledDir, "bundled", byId, errors, opts.locale);
  // Cache second: same-id entries overwrite the bundled ones (cache wins).
  await loadLayer(
    opts.cacheDir ?? defaultVenueCacheDir(),
    "cache",
    byId,
    errors,
    opts.locale,
  );
  const venues = [...byId.values()].sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  );
  return { venues, errors };
}

export async function getVenue(
  id: string,
  opts: VenueLibraryOptions,
): Promise<LoadedVenue> {
  const { venues } = await listVenues(opts);
  const hit = venues.find((v) => v.manifest.id === id);
  if (!hit) {
    const known = venues.map((v) => v.manifest.id).join(", ") || "(none)";
    throw new VenueError(
      "unknown_venue",
      opts.locale === "zh"
        ? `未知投稿模板 "${id}"，可用：${known}。`
        : `unknown venue "${id}" — known venues: ${known}.`,
    );
  }
  return hit;
}
