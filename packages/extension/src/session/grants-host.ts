import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  type GrantUpdateItem,
  type GrantedRoot,
  LITERATURE_SESSION_BUDGET,
  type LiteratureProvider,
  type SessionItem,
  type SessionStore,
  arxivLiterature,
  canonicalizeGrantRoot,
  crossrefLiterature,
  dblpLiterature,
  semanticScholarLiterature,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { currentSession, pathsEqual, sessionStoreFor } from "./session-state";

/**
 * A4 (ADR 0019): the session's external read grants and the literature budget
 * they share (B1 split of `session-host.ts`).
 *
 * Grants are per-session state, persisted as `grant_update` items so the set
 * replays with the session.
 */

let grants: GrantedRoot[] = [];
let nextGrantOrdinal = 1;
/** A4: grant items awaiting a session to persist into (a grant can be added
 *  before the first message creates the session); flushed on session create. */
let unflushedGrantItems: GrantUpdateItem[] = [];
let notifyGrantsChanged:
  | ((grants: GrantedRoot[], item?: GrantUpdateItem) => void)
  | undefined;
/** A4: host-owned per-session literature_search budget (the executor decrements). */
const literatureBudget = { remaining: LITERATURE_SESSION_BUDGET };
/** A4: the Semantic Scholar key's SecretStorage id (the model-key convention). */
export const S2_KEY_SECRET = "lemmaria.apiKey.semanticScholar";
let literatureProvidersOverride: LiteratureProvider[] | undefined;

/** The live grant set (copies — callers never mutate session state). */
export function activeSessionGrants(): GrantedRoot[] {
  return grants.slice();
}

/** Set by the view layer: pushes chips state + the transcript card. */
export function onGrantsChanged(
  notify: (grants: GrantedRoot[], item?: GrantUpdateItem) => void,
): void {
  notifyGrantsChanged = notify;
}

async function persistGrantItem(
  context: vscode.ExtensionContext,
  item: GrantUpdateItem,
): Promise<void> {
  const session = currentSession();
  if (!session) {
    unflushedGrantItems.push(item);
    return;
  }
  try {
    await sessionStoreFor(context).append(session.id, {
      type: "item.completed",
      item,
    });
  } catch {
    // Persistence is best-effort (the A0 P1 rule); the live set still updates.
  }
}

/**
 * A4: grants added before the session existed persist now, in add order — the
 * JSONL replays to the same active set the live getter serves.
 */
export async function flushGrantItems(
  store: SessionStore,
  sessionId: string,
): Promise<void> {
  if (unflushedGrantItems.length === 0) return;
  const pending = unflushedGrantItems;
  unflushedGrantItems = [];
  for (const item of pending) {
    try {
      await store.append(sessionId, { type: "item.completed", item });
    } catch {
      // Best-effort (the A0 P1 rule).
    }
  }
}

/**
 * A4: grant a folder to the session — realpath-canonicalized at grant time
 * (ADR 0019; throws an honest message for a missing/non-directory path).
 * Re-granting an already-granted folder returns the existing grant.
 */
export async function addGrant(
  context: vscode.ExtensionContext,
  folderPath: string,
): Promise<GrantedRoot> {
  const canonical = canonicalizeGrantRoot(folderPath);
  const existing = grants.find((g) => pathsEqual(g.path, canonical));
  if (existing) return existing;
  const grant: GrantedRoot = {
    id: `g${nextGrantOrdinal}`,
    path: canonical,
    label: basename(canonical),
  };
  nextGrantOrdinal += 1;
  grants.push(grant);
  const item: GrantUpdateItem = {
    id: randomUUID(),
    type: "grant_update",
    action: "added",
    grant,
  };
  await persistGrantItem(context, item);
  notifyGrantsChanged?.(activeSessionGrants(), item);
  return grant;
}

/** A4: revoke a grant — bites at the running task's next tool call. */
export async function revokeGrant(
  context: vscode.ExtensionContext,
  id: string,
): Promise<boolean> {
  const index = grants.findIndex((g) => g.id === id);
  if (index < 0) return false;
  const grant = grants[index] as GrantedRoot;
  grants.splice(index, 1);
  const item: GrantUpdateItem = {
    id: randomUUID(),
    type: "grant_update",
    action: "revoked",
    grant,
  };
  await persistGrantItem(context, item);
  notifyGrantsChanged?.(activeSessionGrants(), item);
  return true;
}

/** Test seam (A4): the host-owned literature budget object. */
export function literatureBudgetForTests(): { remaining: number } {
  return literatureBudget;
}

/** The budget object the tool registry decrements. */
export const sessionLiteratureBudget = (): { remaining: number } =>
  literatureBudget;

/** Test seam (A4): replace the live scholarly providers (undefined restores). */
export function setLiteratureProvidersForTests(
  providers?: LiteratureProvider[],
): void {
  literatureProvidersOverride = providers;
}

/**
 * A4: the scholarly providers for one task — polite-pool contact from the
 * setting, the optional S2 key from SecretStorage (BYOK: injected here by the
 * host; the harness never reads storage — the ModelBinding.apiKey precedent).
 */
export async function literatureProviders(
  context: vscode.ExtensionContext,
): Promise<LiteratureProvider[]> {
  if (literatureProvidersOverride) return literatureProvidersOverride;
  const contact = vscode.workspace
    .getConfiguration("lemmaria")
    .get<string>("literature.contactEmail")
    ?.trim();
  const apiKey = ((await context.secrets.get(S2_KEY_SECRET)) ?? "").trim();
  return [
    crossrefLiterature(contact ? { mailto: contact } : {}),
    arxivLiterature(),
    semanticScholarLiterature(apiKey ? { apiKey } : {}),
    dblpLiterature(),
  ];
}

/** Highest `g<N>` ordinal ever used in a transcript, so a resumed session
 *  never re-mints an id a revoked grant already used. */
function highestGrantOrdinal(items: readonly SessionItem[]): number {
  let max = 0;
  for (const item of items) {
    if (item.type !== "grant_update") continue;
    const n = Number.parseInt(item.grant.id.replace(/^g/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** A2: adopt a resumed session's grant set, replayed from its transcript. */
export function adoptResumedGrants(
  replayed: GrantedRoot[],
  items: readonly SessionItem[],
): void {
  grants = replayed;
  nextGrantOrdinal = highestGrantOrdinal(items) + 1;
  notifyGrantsChanged?.(activeSessionGrants());
}

/**
 * A4: grants are per-session — a fresh thread starts ungranted, and the
 * literature budget refills (ADR 0019).
 */
export function resetForNewSession(): void {
  grants = [];
  nextGrantOrdinal = 1;
  unflushedGrantItems = [];
  literatureBudget.remaining = LITERATURE_SESSION_BUDGET;
  notifyGrantsChanged?.([]);
}

/** The same reset without notifying the view (a reload/test teardown). */
export function resetQuiet(): void {
  grants = [];
  nextGrantOrdinal = 1;
  unflushedGrantItems = [];
  literatureBudget.remaining = LITERATURE_SESSION_BUDGET;
}
