/**
 * The tool boundary's result and failure shape (ADR 0024).
 *
 * Before B0 a tool reported failure two incompatible ways: it threw, and the
 * loop stringified the message into `{"error": "…"}`; or it returned an ad-hoc
 * `{"refused": "…"}` (ADR 0019's "refusals are data"). Neither the model, the
 * harness, nor the transcript could branch on *why* — and the refusal text
 * reached a Chinese reader's screen in English.
 *
 * One channel replaces both: a tool returns `Result<T, ToolError>` and never
 * throws. The CODE is the branchable fact; `message` is model-facing English
 * that says what to do next. The UI localizes the code (invariant 6) and shows
 * the message as detail.
 *
 * Adapted from Pi's per-subsystem error codes (`FileError`, `ExecutionError`,
 * … in `pi/packages/agent`, MIT) and their explicit contract that filesystem
 * operations "must never throw or reject; all failures must be encoded in the
 * returned Result". **Deliberate divergence:** Lemmaria uses ONE code union for
 * the whole tool boundary rather than one per subsystem, because the consumer
 * that has to be exhaustive is a single localized UI table, and a per-subsystem
 * split would multiply that table without telling a reader anything more.
 *
 * The discipline is scoped to the tool boundary (`ToolExecutor.invoke`), not to
 * every internal helper — see ADR 0024.
 */

/**
 * Why a tool call produced no result. Deliberately small and stable: every code
 * must be something a reader understands without knowing which tool ran, and
 * something the model can act on differently.
 */
export type ToolErrorCode =
  /** The named thing does not exist — a file, a section, a granted-root id. */
  | "not_found"
  /** The capability boundary said no (invariant 2): a path outside the root, an
   *  interpreter off the allowlist. Retrying the same call cannot help. */
  | "denied"
  /**
   * Well-formed but over a bound. TWO situations, and the advice differs
   * (B2, ADR 0026 — ADR 0024's table glossed it as "narrow the request",
   * which is right for the first and wrong for the second):
   *  - an oversized REQUEST (a 5 MB file, a fan-out of 40) — narrow it;
   *  - a spent per-session BUDGET (`literature_search`, the L1 retrieval
   *    budget) — narrowing does not refill it; stop using that capability for
   *    this session.
   * Deliberately not split into an eighth code: nothing branches on the
   * difference, and each site's `message` already says which it is. Revisit if
   * a consumer ever needs to tell them apart programmatically.
   */
  | "too_large"
  /** A live precondition failed or the human declined — a revoked grant, a
   *  denied approval. Not a defect; the agent should adapt, not retry. */
  | "refused"
  /** An external source throttled us. Retrying later may succeed. */
  | "rate_limited"
  /** A dependency could not answer at all (a provider is down, a tool this
   *  build does not have). Also the backstop for a tool that throws anyway. */
  | "unavailable"
  /** The model's arguments are malformed — re-issue them. */
  | "invalid";

/** Runtime mirror of `ToolErrorCode`, so consumers can be checked exhaustively. */
export const ALL_TOOL_ERROR_CODES = [
  "not_found",
  "denied",
  "too_large",
  "refused",
  "rate_limited",
  "unavailable",
  "invalid",
] as const satisfies readonly ToolErrorCode[];

/**
 * `satisfies` only proves elements ⊆ union. This proves union ⊆ elements, so a
 * code added to `ToolErrorCode` without being listed above fails the build —
 * rather than reaching the UI silently downgraded to `unavailable` by
 * `summarizeToolResult`'s validation.
 */
type _EveryCodeIsListed =
  ToolErrorCode extends (typeof ALL_TOOL_ERROR_CODES)[number] ? true : never;
const _codesAreExhaustive: _EveryCodeIsListed = true;
void _codesAreExhaustive;

export interface ToolError {
  code: ToolErrorCode;
  /**
   * Model-facing English: what went wrong AND what to do about it. It is shown
   * to the user only as *detail* beside the localized code, so it may name
   * paths and identifiers — but it must never be the only thing a reader gets
   * (invariant 6).
   */
  message: string;
}

/** A success or a failure. `E` defaults to `ToolError`, the tool boundary's case. */
export type Result<T, E = ToolError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** The tool boundary's failure constructor — the one every tool body calls. */
export function toolFail(
  code: ToolErrorCode,
  message: string,
): Result<never, ToolError> {
  return { ok: false, error: { code, message } };
}
