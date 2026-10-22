/**
 * run_script argv resolution + containment (ADR 0020).
 *
 * The loop calls these before asking for approval: the interpreter must be
 * allowlisted, and the script (command[1]) must resolve inside the granted-root
 * cwd OR the paper workspace — both are material the user can see (the
 * "seen script" rule). Containment is enforcement here (the grants.ts
 * philosophy): a refusal is data the model self-corrects from, never a throw.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ToolErrorCode } from "../contracts/results.js";
import type { GrantedRoot } from "../contracts/sessions.js";
import {
  deniedReason,
  isWithinRoot,
  resolveGrantedPath,
} from "../engine/grants.js";
import { assertWorkspaceRelative } from "../engine/workspace-utils.js";

/**
 * Upper bound on a script we will read wholesale to hash + preview for approval.
 * A script the user is meant to *read* before approving is small; a huge file in
 * a granted root would otherwise block the extension host on a synchronous read.
 */
export const MAX_SCRIPT_BYTES = 1_000_000;

export function parseRunScriptArgs(
  args: unknown,
): { root: string; command: string[] } | { error: string } {
  const root = (args as { root?: unknown } | undefined)?.root;
  const command = (args as { command?: unknown } | undefined)?.command;
  if (typeof root !== "string" || root === "") {
    return { error: 'run_script needs a "root" granted-folder id' };
  }
  if (
    !Array.isArray(command) ||
    command.length < 2 ||
    !command.every((c) => typeof c === "string" && c.length > 0)
  ) {
    return {
      error:
        "run_script needs command: [interpreter, script, ...args] (at least an interpreter and a script)",
    };
  }
  return { root, command: command as string[] };
}

/** Lowercased basename, `.exe` stripped — how an argv[0] matches the allowlist. */
export function interpreterBasename(interp: string): string {
  let name = basename(interp).toLowerCase();
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return name;
}

export interface ResolveRunScriptInput {
  command: string[];
  grant: GrantedRoot;
  workspaceRoot: string;
  interpreters: string[];
}

/**
 * ADR 0024's boundary mapping, carried as data rather than re-parsed from
 * English: this module is an internal helper (several callers), so it keeps
 * its `{refused}` shape and states the code the tool boundary should use.
 */
export interface RunScriptRefusal {
  refused: string;
  code: ToolErrorCode;
}

export interface ResolvedRunScript {
  argv: string[];
  cwd: string;
  content: string;
  display: string[];
}

/**
 * Resolve a run_script argv for spawning, or refuse as data (ADR 0020).
 * Interpreter basename must be allowlisted; the script (command[1]) must
 * resolve inside the granted-root cwd OR the paper workspace (both are
 * user-visible material — the "seen script" rule); the resolved absolute
 * script path is spawned so relative data reads happen against cwd.
 */
export function resolveRunScript(
  input: ResolveRunScriptInput,
): ResolvedRunScript | RunScriptRefusal {
  const interpreter = input.command[0];
  const script = input.command[1];
  if (interpreter === undefined || script === undefined) {
    return {
      code: "invalid",
      refused:
        "run_script needs command: [interpreter, script, ...args] (at least an interpreter and a script)",
    };
  }
  const rest = input.command.slice(2);
  const allow = new Set(input.interpreters.map(interpreterBasename));
  if (!allow.has(interpreterBasename(interpreter))) {
    return {
      code: "denied",
      refused: `interpreter "${interpreter}" is not on the allowed list (${
        [...allow].join(", ") || "none configured"
      })`,
    };
  }

  // 1) inside the granted-root cwd (reuses the read-path's exact containment).
  const inGrant = resolveGrantedPath(input.grant, script);
  let scriptAbs: string | undefined = inGrant.abs;

  // 2) else workspace-relative under the paper workspace.
  if (scriptAbs === undefined) {
    try {
      assertWorkspaceRelative(script);
      const denied = deniedReason(script);
      if (denied === undefined) {
        const abs = resolve(input.workspaceRoot, script);
        if (isWithinRoot(input.workspaceRoot, abs)) {
          const real = realpathSync(abs);
          if (isWithinRoot(input.workspaceRoot, real)) scriptAbs = real;
        }
      }
    } catch {
      // not a valid workspace-relative path — fall through to refusal
    }
  }

  if (scriptAbs === undefined) {
    return {
      code: "not_found",
      refused: `script "${script}" was not found inside a granted folder or the paper workspace`,
    };
  }

  let content: string;
  try {
    const st = statSync(scriptAbs);
    if (!st.isFile()) {
      return { code: "not_found", refused: `script "${script}" is not a file` };
    }
    // Bound the read *before* it happens — a multi-megabyte file is not
    // something the user could reasonably review, and reading it wholesale
    // would block the host (review: size-bound the approval read).
    if (st.size > MAX_SCRIPT_BYTES) {
      return {
        code: "too_large",
        refused: `script "${script}" is too large to review (> ${MAX_SCRIPT_BYTES} bytes)`,
      };
    }
    content = readFileSync(scriptAbs, "utf8");
  } catch {
    return {
      code: "not_found",
      refused: `script "${script}" could not be read`,
    };
  }

  return {
    argv: [interpreter, scriptAbs, ...rest],
    cwd: input.grant.path,
    content,
    display: [interpreter, script, ...rest],
  };
}

/**
 * Always-allow identity (review #1): the granted root + the RESOLVED argv
 * (full interpreter string, absolute script path, and args) + the script
 * content. Binding the root and the full argv — not just the interpreter
 * basename — means a cached approval cannot silently run a same-named binary,
 * a different resolved script, or the same script in a different granted
 * folder's cwd. Any change re-prompts.
 */
export function scriptContentHash(
  rootId: string,
  argv: string[],
  content: string,
): string {
  return createHash("sha256")
    .update(rootId)
    .update("\0")
    .update(JSON.stringify(argv))
    .update("\0")
    .update(content)
    .digest("hex");
}
