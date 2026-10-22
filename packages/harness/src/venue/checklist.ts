/**
 * U4 Venue-tab logic: resolve a detected \documentclass to a library venue and
 * compute the pre-submission checklist. Pure and vscode-free — the extension
 * host stays a thin mapper (invariant 1; "push logic down into the harness").
 *
 * Rows carry structured facts plus a three-way status; wording (and its EN/CN
 * forms) belongs to the UI. `unknown` is the honest "cannot check this
 * automatically today" state — never coerced to pass/fail.
 */

import type { DocumentClass } from "../contracts/adapters.js";
import type { VenueManifest, VenuePageLimit } from "../contracts/venues.js";
import type { LoadedVenue } from "./library.js";

/**
 * Class-name equality; among same-class venues prefer one whose manifest
 * options all appear in the detected options; ties → first in list order
 * (listVenues sorts by id). Lifts the class-level half of the M10 "no
 * class→venue matching" limit; option-exact matching stays out of scope.
 */
export function matchVenueByClass(
  detected: DocumentClass | undefined,
  venues: LoadedVenue[],
): LoadedVenue | undefined {
  if (!detected) return undefined;
  const sameClass = venues.filter(
    (v) => v.manifest.documentclass.class === detected.name,
  );
  const optioned = sameClass.filter((v) =>
    v.manifest.documentclass.options.every((o) => detected.options.includes(o)),
  );
  return optioned[0] ?? sameClass[0];
}

export type ChecklistStatus = "pass" | "fail" | "unknown";

export type VenueChecklistRow =
  | {
      id: "anonymity";
      status: ChecklistStatus;
      required: "double_blind" | "single_blind" | "none";
      anonymousOptionPresent: boolean;
    }
  | {
      id: "page_limit";
      status: ChecklistStatus;
      limit?: VenuePageLimit;
      pages?: number;
    }
  | {
      id: "bibstyle";
      status: ChecklistStatus;
      expected?: string;
      detected?: string;
    }
  | { id: "citations"; status: ChecklistStatus; errors?: number };

export interface VenueChecklistInput {
  manifest: VenueManifest;
  detected: DocumentClass;
  /** The project's \bibliographystyle argument, if any. */
  bibliographyStyle?: string;
  /** C1 error-severity issue count; undefined = no bibliography to check. */
  citationErrors?: number;
  /** Page count from the most recent compile of this entry, if known. */
  pages?: number;
}

/**
 * Documentclass options that make a class render anonymously — the curated
 * set we can check reliably. Classes without a standard switch make a declared
 * double_blind requirement `unknown` (manual check), never a guess.
 */
const ANONYMOUS_OPTIONS: Record<string, string[]> = {
  acmart: ["anonymous"],
};

export function computeVenueChecklist(
  input: VenueChecklistInput,
): VenueChecklistRow[] {
  const { manifest, detected } = input;

  const required = manifest.anonymity ?? "none";
  const anonOpts = ANONYMOUS_OPTIONS[detected.name] ?? [];
  const anonymousOptionPresent = anonOpts.some((o) =>
    detected.options.includes(o),
  );
  const anonymity: VenueChecklistRow = {
    id: "anonymity",
    required,
    anonymousOptionPresent,
    // Only double_blind demands an anonymized manuscript.
    status:
      required !== "double_blind"
        ? "pass"
        : anonOpts.length === 0
          ? "unknown"
          : anonymousOptionPresent
            ? "pass"
            : "fail",
  };

  const limit = manifest.page_limit;
  const pageLimit: VenueChecklistRow = {
    id: "page_limit",
    ...(limit !== undefined ? { limit } : {}),
    ...(input.pages !== undefined ? { pages: input.pages } : {}),
    status:
      limit === undefined || limit.unit !== "pages" || input.pages === undefined
        ? "unknown"
        : input.pages <= limit.value
          ? "pass"
          : "fail",
  };

  const bibstyle: VenueChecklistRow = {
    id: "bibstyle",
    ...(manifest.bibstyle !== undefined ? { expected: manifest.bibstyle } : {}),
    ...(input.bibliographyStyle !== undefined
      ? { detected: input.bibliographyStyle }
      : {}),
    status:
      manifest.bibstyle === undefined || input.bibliographyStyle === undefined
        ? "unknown"
        : input.bibliographyStyle === manifest.bibstyle
          ? "pass"
          : "fail",
  };

  const citations: VenueChecklistRow = {
    id: "citations",
    ...(input.citationErrors !== undefined
      ? { errors: input.citationErrors }
      : {}),
    status:
      input.citationErrors === undefined
        ? "unknown"
        : input.citationErrors === 0
          ? "pass"
          : "fail",
  };

  return [anonymity, pageLimit, bibstyle, citations];
}
