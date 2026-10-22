/**
 * The entry's venue, matched once (V4, ADR 0081 §2).
 *
 * Extracted from the Venue tab's `computeVenueState` so the review's venue
 * fact and the tab cannot disagree about which venue a paper is for: both read
 * the entry's `\documentclass` through the same adapter, list the same library
 * and match with the same `matchVenueByClass`. The tab keeps everything it
 * does with the answer; this module only finds it.
 */

import { loadAdapterFor } from "@lemmaria/adapters";
import {
  type LoadedVenue,
  type ReviewVenue,
  listVenues,
  matchVenueByClass,
} from "@lemmaria/harness";
import type * as vscode from "vscode";
import { libraryOptions } from "./venue-ui";
import { VscodeWorkspace } from "./workspace";

type EntryAdapter = Awaited<ReturnType<typeof loadAdapterFor>>;
type DetectedClass = ReturnType<
  Extract<EntryAdapter, { documentClass: unknown }>["documentClass"]
>;

/**
 * The entry's adapter, its detected class and the library venue it matches —
 * each as far as it goes. `undefined` when the entry cannot be loaded at all.
 */
export async function matchVenueForEntry(
  context: vscode.ExtensionContext,
  workspace: VscodeWorkspace,
  entry: string,
): Promise<
  | { adapter: EntryAdapter; detected?: DetectedClass; matched?: LoadedVenue }
  | undefined
> {
  let adapter: EntryAdapter;
  try {
    adapter = await loadAdapterFor(workspace, entry);
  } catch {
    return undefined;
  }
  const detected =
    "documentClass" in adapter ? adapter.documentClass() : undefined;
  if (!detected) return { adapter };
  const { venues } = await listVenues(libraryOptions(context));
  const matched = matchVenueByClass(detected, venues);
  return { adapter, detected, ...(matched ? { matched } : {}) };
}

/**
 * The venue summary a review's facts carry — the matched manifest's id, page
 * limit and anonymity, as authored. `undefined` for no paper, an entry that
 * will not load, or a class no bundled venue names: the facts then state no
 * venue, which is true.
 */
export async function venueForEntry(
  context: vscode.ExtensionContext,
  paper: { root: string; entry: string } | undefined,
): Promise<ReviewVenue | undefined> {
  if (!paper) return undefined;
  try {
    const found = await matchVenueForEntry(
      context,
      new VscodeWorkspace(paper.root, paper.entry),
      paper.entry,
    );
    const m = found?.matched?.manifest;
    if (!m) return undefined;
    return {
      id: m.id,
      ...(m.page_limit !== undefined ? { pageLimit: m.page_limit } : {}),
      ...(m.anonymity !== undefined ? { anonymity: m.anonymity } : {}),
    };
  } catch {
    // A venue library that will not list is a missing fact, never a failed
    // review.
    return undefined;
  }
}
