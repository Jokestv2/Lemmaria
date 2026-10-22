/**
 * Action loader — lifecycle step 1 (Resolve): parse YAML/JSON, validate against
 * the §9 JSON Schema, enforce the tool allowlist (invariant 2), apply source
 * precedence project > user > built-in (§2), and check `requires` compatibility.
 */

import { Ajv } from "ajv";
import { parse as parseYaml } from "yaml";
import type { ActionDefinition } from "../contracts/actions.js";
import type { DocKind } from "../contracts/adapters.js";
import { ALL_TOOL_NAMES } from "../contracts/tools.js";
import { ACTION_JSON_SCHEMA } from "./schema.js";

/** Mirrors packages/harness/package.json `version`. */
export const HARNESS_VERSION = "0.3.0";

export type ActionSource = "built-in" | "user" | "project";

export interface LoadedAction {
  definition: ActionDefinition;
  source: ActionSource;
  filePath: string;
}

export interface ActionLoadError {
  filePath: string;
  source: ActionSource;
  message: string;
}

export interface ActionFile {
  path: string;
  content: string;
}

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(ACTION_JSON_SCHEMA);

export function parseActionFile(
  content: string,
  filePath: string,
): ActionDefinition {
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (error) {
    throw new Error(
      `${filePath}: not valid YAML/JSON: ${(error as Error).message}`,
    );
  }
  if (!validate(data)) {
    const details = (validate.errors ?? [])
      .map(
        (e) =>
          `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? ""}`,
      )
      .join("; ");
    throw new Error(`${filePath}: schema validation failed: ${details}`);
  }
  const def = data as ActionDefinition;
  const requested = [
    ...new Set([...(def.requires?.tools ?? []), ...(def.routing?.tools ?? [])]),
  ];
  const outside = requested.filter(
    (t) => !(ALL_TOOL_NAMES as readonly string[]).includes(t as string),
  );
  if (outside.length > 0) {
    throw new Error(
      `${filePath}: tools not in the allowlist: ${outside.join(", ")}`,
    );
  }
  // D4 (ADR 0041): an `enum_labels` key that is not an `enum` VALUE labels
  // nothing. JSON Schema cannot express "keys of this object must be members of
  // that array", so it is checked here — the same reason the tool allowlist is.
  // Without it the typo is silent and the picker quietly shows the raw value.
  for (const p of def.parameters ?? []) {
    const labels = p.enum_labels;
    if (labels === undefined) continue;
    const values = new Set((p.enum ?? []).map(String));
    const unknown = Object.keys(labels).filter((k) => !values.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `${filePath}: parameter "${p.id}" has enum_labels for values not in its enum: ${unknown.join(", ")}`,
      );
    }
  }
  return def;
}

const PRECEDENCE: Record<ActionSource, number> = {
  "built-in": 0,
  user: 1,
  project: 2,
};

export function loadActionSet(
  sources: Partial<Record<ActionSource, ActionFile[]>>,
): { actions: LoadedAction[]; errors: ActionLoadError[] } {
  const byId = new Map<string, LoadedAction>();
  const errors: ActionLoadError[] = [];
  for (const source of ["built-in", "user", "project"] as const) {
    for (const file of sources[source] ?? []) {
      let definition: ActionDefinition;
      try {
        definition = parseActionFile(file.content, file.path);
      } catch (error) {
        errors.push({
          filePath: file.path,
          source,
          message: (error as Error).message,
        });
        continue;
      }
      const existing = byId.get(definition.id);
      if (!existing || PRECEDENCE[source] >= PRECEDENCE[existing.source]) {
        byId.set(definition.id, { definition, source, filePath: file.path });
      }
    }
  }
  return { actions: [...byId.values()], errors };
}

/** Unmet-compatibility reasons (empty = usable). Lifecycle step 1: "disable with a note if unmet". */
export function checkRequires(
  def: ActionDefinition,
  opts: { harnessVersion?: string; docKind?: DocKind },
): string[] {
  const reasons: string[] = [];
  const req = def.requires;
  if (!req) return reasons;
  const running = opts.harnessVersion ?? HARNESS_VERSION;
  if (req.harness && !satisfiesMin(running, req.harness)) {
    reasons.push(`requires harness ${req.harness}, running ${running}`);
  }
  if (req.doc_kinds && opts.docKind && !req.doc_kinds.includes(opts.docKind)) {
    reasons.push(
      `supports doc kinds ${req.doc_kinds.join("/")}, document is ${opts.docKind}`,
    );
  }
  return reasons;
}

/** Supports the ">=x.y.z" form (the only range the spec uses) and bare "x.y.z" (exact-or-above). */
function satisfiesMin(version: string, range: string): boolean {
  const wanted = /^(?:>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!wanted || !have) return false;
  for (let i = 1; i <= 3; i++) {
    const w = Number(wanted[i]);
    const h = Number(have[i]);
    if (h > w) return true;
    if (h < w) return false;
  }
  return true;
}
