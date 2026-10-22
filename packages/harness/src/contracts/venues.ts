/**
 * Venue Template Library manifest (venue.yaml) — canonical contract (ADR 0010).
 *
 * One directory per venue holds `venue.yaml` (this shape) + `requirements.md`
 * (human-readable submission notes) + redistributable starter files. MVP ships
 * the library as a bundled snapshot overlaid by a per-id user cache
 * (~/.lemmaria/venues/); see the architecture design → Venue Template Support.
 */

export interface VenueName {
  en: string;
  zh: string;
}

export interface VenuePageLimit {
  value: number;
  unit: string;
  note?: string;
}

/** redistribute:false — a non-redistributable artifact fetched live at scaffold
 *  time (ADR 0010). `dest` is workspace-relative inside the scaffold target. */
export interface VenueFetchFile {
  url: string;
  dest: string;
}

export interface VenueManifest {
  id: string;
  name: VenueName;
  documentclass: { class: string; options: string[] };
  /** The venue's official engine — routes the baseline compile and Compile Check. */
  engine: string;
  bibstyle?: string;
  page_limit?: VenuePageLimit;
  anonymity?: "double_blind" | "single_blind" | "none";
  /** How this template expresses each semantic field (feeds migration, post-MVP). */
  field_map?: Record<string, string>;
  theorem_envs?: string;
  /** Rel paths inside the venue dir, materialized verbatim by the scaffolder. */
  starter_files: string[];
  fetch_files?: VenueFetchFile[];
  license?: string;
  /** false ⇒ reference-and-fetch: restricted artifacts live in fetch_files. */
  redistribute: boolean;
  source_url?: string;
}
