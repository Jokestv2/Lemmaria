/**
 * venue.yaml parsing/validation (ADR 0010). The manifest is declarative data —
 * the Venue Engine reads it; nothing in it is executable. Validation is
 * deny-on-malformed with bilingual errors naming the offending field, so a
 * broken community venue fails loudly in the picker instead of mid-scaffold.
 */

import { parse as parseYaml } from "yaml";
import type { SessionLocale } from "../contracts/sessions.js";
import type {
  VenueFetchFile,
  VenueManifest,
  VenueName,
  VenuePageLimit,
} from "../contracts/venues.js";
import { assertWorkspaceRelative } from "../engine/workspace-utils.js";

export class VenueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VenueError";
  }
}

const ANONYMITY = new Set(["double_blind", "single_blind", "none"]);

function invalid(
  field: string,
  origin?: string,
  locale: SessionLocale = "en",
): never {
  const at = origin
    ? locale === "zh"
      ? `（${origin}）`
      : ` in ${origin}`
    : "";
  throw new VenueError(
    "invalid_manifest",
    locale === "zh"
      ? `venue.yaml${at}：字段 "${field}" 缺失或无效。`
      : `venue.yaml${at}: missing or invalid "${field}".`,
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseVenueManifest(
  source: string,
  origin?: string,
  /** D4 (ADR 0034): the language a `VenueError` message renders in. */
  locale: SessionLocale = "en",
): VenueManifest {
  // Explicitly annotated: TS only applies never-returning control-flow
  // narrowing to a call through a variable when the VARIABLE carries the type.
  const bad: (field: string) => never = (field) =>
    invalid(field, origin, locale);
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch {
    bad("(yaml)");
  }
  if (!isRecord(raw)) bad("(top-level mapping)");

  if (!nonEmptyString(raw.id)) bad("id");
  if (!isRecord(raw.name) || !nonEmptyString(raw.name.en)) {
    bad("name.en");
  }
  if (!nonEmptyString(raw.name.zh)) bad("name.zh");
  const name: VenueName = { en: raw.name.en, zh: raw.name.zh };

  if (
    !isRecord(raw.documentclass) ||
    !nonEmptyString(raw.documentclass.class)
  ) {
    bad("documentclass.class");
  }
  const options = raw.documentclass.options ?? [];
  if (!stringArray(options)) bad("documentclass.options");

  if (!nonEmptyString(raw.engine)) bad("engine");

  const starterFiles = raw.starter_files ?? [];
  if (!stringArray(starterFiles)) bad("starter_files");
  for (const rel of starterFiles) {
    try {
      assertWorkspaceRelative(rel);
    } catch {
      bad(`starter_files entry "${rel}"`);
    }
  }

  const redistribute = raw.redistribute ?? true;
  if (typeof redistribute !== "boolean") bad("redistribute");

  let fetchFiles: VenueFetchFile[] | undefined;
  if (raw.fetch_files !== undefined) {
    if (!Array.isArray(raw.fetch_files)) bad("fetch_files");
    fetchFiles = raw.fetch_files.map((entry) => {
      if (
        !isRecord(entry) ||
        !nonEmptyString(entry.url) ||
        !nonEmptyString(entry.dest)
      ) {
        bad("fetch_files entry");
      }
      try {
        assertWorkspaceRelative(entry.dest);
      } catch {
        bad(`fetch_files dest "${entry.dest}"`);
      }
      return { url: entry.url, dest: entry.dest };
    });
  }

  let pageLimit: VenuePageLimit | undefined;
  if (raw.page_limit !== undefined) {
    if (
      !isRecord(raw.page_limit) ||
      typeof raw.page_limit.value !== "number" ||
      !Number.isFinite(raw.page_limit.value) ||
      !nonEmptyString(raw.page_limit.unit)
    ) {
      bad("page_limit");
    }
    pageLimit = {
      value: raw.page_limit.value,
      unit: raw.page_limit.unit,
      ...(nonEmptyString(raw.page_limit.note)
        ? { note: raw.page_limit.note }
        : {}),
    };
  }

  if (raw.anonymity !== undefined && !ANONYMITY.has(raw.anonymity as string)) {
    bad("anonymity");
  }

  let fieldMap: Record<string, string> | undefined;
  if (raw.field_map !== undefined) {
    if (!isRecord(raw.field_map)) bad("field_map");
    fieldMap = {};
    for (const [k, v] of Object.entries(raw.field_map)) {
      if (typeof v !== "string") bad(`field_map.${k}`);
      fieldMap[k] = v;
    }
  }

  return {
    id: raw.id,
    name,
    documentclass: { class: raw.documentclass.class, options },
    engine: raw.engine,
    ...(nonEmptyString(raw.bibstyle) ? { bibstyle: raw.bibstyle } : {}),
    ...(pageLimit ? { page_limit: pageLimit } : {}),
    ...(raw.anonymity !== undefined
      ? { anonymity: raw.anonymity as VenueManifest["anonymity"] }
      : {}),
    ...(fieldMap ? { field_map: fieldMap } : {}),
    ...(nonEmptyString(raw.theorem_envs)
      ? { theorem_envs: raw.theorem_envs }
      : {}),
    starter_files: starterFiles,
    ...(fetchFiles ? { fetch_files: fetchFiles } : {}),
    ...(nonEmptyString(raw.license) ? { license: raw.license } : {}),
    redistribute,
    ...(nonEmptyString(raw.source_url) ? { source_url: raw.source_url } : {}),
  };
}
