import { spawnScript } from "@lemmaria/adapters";
import type {
  ScriptApproval,
  ScriptRunItem,
  SessionScriptHost,
} from "@lemmaria/harness";
import * as vscode from "vscode";

/**
 * A4b (ADR 0020): the script-execution host — approval webview + real spawn
 * (B1 split of `session-host.ts`).
 */

/** A4b: the pending run_script approval — the webview resolves it
 *  approve/deny (or the loop's abort race resolves it undefined). `hash` keys
 *  the always-allow cache when the user checks "always allow this script". */
let pendingScript:
  | {
      itemId: string;
      hash: string;
      /** The live `pending` item, kept so a re-created webview can be handed
       *  the decidable card instead of the replay's normalized `failed` one
       *  (see `livePendingItems`). */
      item: ScriptRunItem;
      resolve: (d: ScriptApproval | undefined) => void;
    }
  | undefined;
/** A4b: per-session content-hash always-allow cache (cleared on New Session). */
const alwaysAllowScripts = new Set<string>();

/** A4b: the interpreter allowlist — the host reads config; the harness never does. */
export const DEFAULT_SCRIPT_INTERPRETERS = ["python", "python3", "Rscript"];
let scriptInterpretersOverride: string[] | undefined;
function scriptInterpreters(): string[] {
  if (scriptInterpretersOverride) return scriptInterpretersOverride;
  return (
    vscode.workspace
      .getConfiguration("lemmaria")
      .get<string[]>("script.interpreters") ?? DEFAULT_SCRIPT_INTERPRETERS
  );
}

/** Test seam (A4b): override the interpreter allowlist hermetically (e.g. node). */
export function setScriptInterpretersForTests(list?: string[]): void {
  scriptInterpretersOverride = list;
}

export function buildSessionScriptHost(): SessionScriptHost {
  return {
    interpreters: scriptInterpreters,
    requestApproval: (item, scriptHash) => {
      if (alwaysAllowScripts.has(scriptHash)) {
        return Promise.resolve<ScriptApproval>({ approve: true });
      }
      return new Promise<ScriptApproval | undefined>((resolve) => {
        // A newer pause supersedes an older unresolved one (defensive).
        pendingScript?.resolve(undefined);
        pendingScript = { itemId: item.id, hash: scriptHash, item, resolve };
      });
    },
    run: (argv, cwd, signal) => spawnScript(argv, cwd, { signal }),
  };
}

/**
 * A4b: the webview's approve/deny for a pending run_script (routed through the
 * single inbound dispatcher). `alwaysAllow` adds the script's content-hash to
 * the per-session cache so an identical re-run skips the prompt.
 */
export function submitScriptDecision(
  itemId: string,
  decision: ScriptApproval,
  alwaysAllow?: boolean,
): boolean {
  if (!pendingScript || pendingScript.itemId !== itemId) return false;
  if (alwaysAllow && decision.approve) {
    alwaysAllowScripts.add(pendingScript.hash);
  }
  const resolve = pendingScript.resolve;
  pendingScript = undefined;
  resolve(decision);
  return true;
}

/** The pause this host is currently parked on, for the snapshot path. */
export function livePendingScript():
  | { itemId: string; item: ScriptRunItem }
  | undefined {
  return pendingScript
    ? { itemId: pendingScript.itemId, item: pendingScript.item }
    : undefined;
}

/**
 * A4b: drop any pending run_script approval and the always-allow cache — a
 * fresh thread re-prompts for every run (ADR 0020).
 */
export function resetForNewSession(): void {
  pendingScript?.resolve(undefined);
  pendingScript = undefined;
  alwaysAllowScripts.clear();
}

/**
 * Test seams (E6, D11): seed and count the always-allow cache.
 *
 * What a rewind CARRIES — the edit policy — has been observable since E5
 * through `currentEditPolicyForTests`. What it deliberately does NOT carry had
 * no such window, so "run_script always re-consents" was a claim in a comment.
 * These are that window, and nothing but tests reads them.
 */
export function allowScriptForTests(hash: string): void {
  alwaysAllowScripts.add(hash);
}

export function alwaysAllowedScriptsForTests(): number {
  return alwaysAllowScripts.size;
}

/** A reload is a process death: the pause promise dies with it, unresolved. */
export function resetQuiet(): void {
  pendingScript = undefined;
  alwaysAllowScripts.clear();
}
