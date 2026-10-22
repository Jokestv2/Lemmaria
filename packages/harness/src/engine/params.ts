/**
 * Lifecycle step 2 (Acquire inputs), parameter half: validate user-supplied
 * parameters against the action's declarations, apply defaults, and derive
 * `<id>_pct` for numeric params (spec §5: "{{params.tolerance_pct}} available
 * automatically").
 */

import type { ActionDefinition } from "../contracts/actions.js";

export function resolveParams(
  action: ActionDefinition,
  given: Record<string, unknown>,
): { params: Record<string, unknown>; errors: string[] } {
  const decls = action.parameters ?? [];
  const params: Record<string, unknown> = {};
  const errors: string[] = [];
  const declared = new Set(decls.map((d) => d.id));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) {
      errors.push(
        `parameter "${key}" is not declared by action "${action.id}"`,
      );
    }
  }
  for (const decl of decls) {
    const value = Object.hasOwn(given, decl.id) ? given[decl.id] : decl.default;
    if (value === undefined) {
      if (decl.required)
        errors.push(`required parameter "${decl.id}" is missing`);
      continue;
    }
    switch (decl.type) {
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          errors.push(`parameter "${decl.id}" must be an integer`);
          continue;
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors.push(`parameter "${decl.id}" must be a number`);
          continue;
        }
        break;
      case "string":
        if (typeof value !== "string") {
          errors.push(`parameter "${decl.id}" must be a string`);
          continue;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          errors.push(`parameter "${decl.id}" must be a boolean`);
          continue;
        }
        break;
      case "enum":
        if (!(decl.enum ?? []).includes(value)) {
          errors.push(
            `parameter "${decl.id}" must be one of: ${(decl.enum ?? []).join(", ")} (enum)`,
          );
          continue;
        }
        break;
    }
    if (typeof value === "number") {
      if (decl.min !== undefined && value < decl.min) {
        errors.push(`parameter "${decl.id}" is below min ${decl.min}`);
        continue;
      }
      if (decl.max !== undefined && value > decl.max) {
        errors.push(`parameter "${decl.id}" is above max ${decl.max}`);
        continue;
      }
    }
    params[decl.id] = value;
    if (
      (decl.type === "number" || decl.type === "integer") &&
      typeof value === "number"
    ) {
      params[`${decl.id}_pct`] = Math.round(value * 100 * 1e6) / 1e6;
    }
  }
  return { params, errors };
}
