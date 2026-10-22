/** Engine-level failures with a stable machine-readable code. */
export class ActionEngineError extends Error {
  constructor(
    readonly code:
      | "unknown_action"
      | "requires_unmet"
      | "params_invalid"
      | "input_too_short"
      | "input_too_long"
      | "unsupported_level"
      | "unsupported_kind"
      | "unsupported_contract",
    message: string,
  ) {
    super(message);
    this.name = "ActionEngineError";
  }
}
