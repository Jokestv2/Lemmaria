/**
 * Assertion helpers for the ADR 0024 tool boundary.
 *
 * A tool now returns `Result<T, ToolError>`, so a test that wants the payload
 * has to narrow first. These two do the narrowing and **throw loudly on the
 * wrong branch** — a test expecting a value that gets a failure fails with the
 * failure's code and message, rather than with a confusing `undefined`.
 */

import type { Result, ToolError } from "../../src/contracts/results.js";

/** The success payload, or a throw naming the failure that arrived instead. */
export function unwrap<T>(result: Result<T, ToolError> | undefined): T {
  if (result === undefined) throw new Error("expected a tool result, got none");
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** The `ToolError`, or a throw naming the value that arrived instead. */
export function unwrapErr(
  result: Result<unknown, ToolError> | undefined,
): ToolError {
  if (result === undefined) throw new Error("expected a tool result, got none");
  if (result.ok) {
    throw new Error(
      `expected a failure, got ok: ${JSON.stringify(result.value)}`,
    );
  }
  return result.error;
}
