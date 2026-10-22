import { readFile } from "node:fs/promises";
import type { SessionItem, SessionTaskResult } from "@lemmaria/harness";

/**
 * The marker instrument (V3, ADR 0080; ADR 0070 §6's rule).
 *
 * It lives in the CLI's eval, never in the harness: a measurement is not a
 * product surface, and the harness must not grow a way to ask "did the model
 * read the thing we planted".
 *
 * **It reports `read` or `not read`, never a percentage.** One page, one code,
 * one run — a rate over a single binary observation is a number with no content
 * (`no-score.test.ts` is the standing guard for that whole family of words).
 */

/** The ground truth beside a marker fixture. */
export interface Marker {
  marker: string;
  page: number;
}

/**
 * Read a marker file. **Refuses rather than repairs**: a fixture whose ground
 * truth is malformed cannot be measured against, and guessing a default would
 * make a broken fixture indistinguishable from a passing run.
 */
export async function readMarker(path: string): Promise<Marker> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: expected a JSON object`);
  }
  const { marker, page } = raw as { marker?: unknown; page?: unknown };
  if (typeof marker !== "string" || marker === "") {
    throw new Error(`${path}: "marker" must be a non-empty string`);
  }
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    throw new Error(`${path}: "page" must be a 1-based integer`);
  }
  return { marker, page };
}

export interface MarkerMeasurement {
  /** Did the final answer carry the code that is only on the page? */
  read: boolean;
  /** How many times `view_pdf_pages` actually RAN. */
  calls: number;
  /**
   * How many calls the ALLOWLIST refused. The allowlist denies at execution,
   * not at request time, so a withheld tool still leaves a `tool_call` item
   * behind — counting those as calls would make a run that never opened the
   * door read exactly like one that did.
   */
  refused: number;
  /** Every page it was shown, in call order, deduplicated. */
  viewed: number[];
  /** How many page images the tool handed back in total. */
  imagesSent: number;
  /**
   * False when the tool never ran — never called at all, or called and
   * refused. The run says nothing about whether a model can read a page, and
   * reporting `read: false` for it would be a measurement of the wiring
   * wearing a measurement of the model.
   *
   * A call that ran and FAILED is still a measurement: the door opened and the
   * renderer broke, which is a reading about the door.
   */
  measured: boolean;
}

/** The `view_pdf_pages` rows of a run's transcript, parsed. */
function markerCalls(items: readonly SessionItem[]): Array<{
  pages: number[];
  images: number;
  refused: boolean;
}> {
  const out: Array<{ pages: number[]; images: number; refused: boolean }> = [];
  for (const item of items) {
    if (item.type !== "tool_call" || item.tool !== "view_pdf_pages") continue;
    let pages: number[] = [];
    let images = 0;
    let refused = false;
    try {
      const result = JSON.parse(item.resultJson ?? "{}") as {
        pages?: Array<{ page?: unknown }>;
        error?: { code?: unknown };
      };
      // `denied` is the ONLY refusal that is not a measurement: it is the
      // allowlist saying the tool was never offered. `unavailable`,
      // `too_large` and `invalid` all come from the tool itself, which means
      // the door was open.
      refused = result.error?.code === "denied";
      pages = (result.pages ?? [])
        .map((p) => p.page)
        .filter((p): p is number => typeof p === "number");
      // One image per page the tool reported rendering — the result JSON is
      // what survives eviction, so it is the honest place to count from.
      images = pages.length;
    } catch {
      // A malformed result is a call that produced nothing readable: it still
      // counts as a call, with no pages.
    }
    out.push({ pages, images, refused });
  }
  return out;
}

export function measureMarker(
  outcome: SessionTaskResult,
  marker: string,
): MarkerMeasurement {
  const asked = markerCalls(outcome.items);
  const ran = asked.filter((c) => !c.refused);
  const viewed: number[] = [];
  let imagesSent = 0;
  for (const call of ran) {
    imagesSent += call.images;
    for (const page of call.pages)
      if (!viewed.includes(page)) viewed.push(page);
  }
  const answer = outcome.items
    .filter((i) => i.type === "agent_message")
    .map((i) => (i as { text: string }).text)
    .join("\n");
  return {
    read: answer.includes(marker),
    calls: ran.length,
    refused: asked.length - ran.length,
    viewed,
    imagesSent,
    measured: ran.length > 0,
  };
}

/**
 * The report line. Prose, not a rate — `read` / `not read` / `not measured`,
 * and the raw counts beside it.
 */
export function formatMarkerReport(m: MarkerMeasurement): string {
  if (!m.measured) {
    return m.refused > 0
      ? `marker: not measured — the tool was withheld (${m.refused} call${
          m.refused === 1 ? "" : "s"
        } refused)`
      : "marker: not measured — the tool was never called";
  }
  const pages = m.viewed.length > 0 ? m.viewed.join(", ") : "none";
  return [
    `marker: ${m.read ? "read" : "not read"}`,
    `calls: ${m.calls}`,
    `pages viewed: ${pages}`,
    `images sent: ${m.imagesSent}`,
  ].join(" · ");
}
