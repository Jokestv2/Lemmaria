/**
 * What the live tier is pinned to.
 *
 * A dated model id, deliberately: a model that moves under an alias makes a
 * regression indistinguishable from a model change. It is a cheap model — this
 * suite runs every gate, so per-run cost is a first-class constraint — and it is
 * NOT the pin for A6's flagship L2-floor gate, which exists to measure a
 * flagship model.
 */
export const LIVE_OPENAI_MODEL = "gpt-5.6-luna";

/** Presence only — never read, log or compare a key's value. */
export const liveOpenAIReady = (): boolean =>
  Boolean(process.env.LEMMARIA_SMOKE_OPENAI_KEY);

/**
 * The SECOND protocol (T2).
 *
 * [ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md)
 * consequence 7 recorded that this pin lived in the bundle only, deliberately,
 * *"until a scenario needs a second protocol"* — a constant with no reader is
 * speculative. T2's corpus scenario is that reader: *"conditions varied
 * deliberately"* (ADR 0038 §2) means more than one provider, and D3's open
 * question asks specifically for *"at least two providers"*. So the pin comes
 * into code here, and consequence 7's condition is discharged rather than
 * ignored.
 *
 * Same rules as the OpenAI pin: dated rather than aliased, and cheap.
 */
export const LIVE_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/**
 * **Off unless switched on** (operator decision, 2026-09-17). A key alone used
 * to open this gate, and the build machine exports one: when its credit ran
 * out, R5's gate spent its whole anthropic half failing in under a second on
 * *"credit balance too low"* — which reads as a regression and is not one.
 *
 * So the pin needs the key **and** `LEMMARIA_SMOKE_ANTHROPIC_ENABLED=1` —
 * exactly `1`, because a stray value must never spend money. Whether it is set
 * is the operator's call, never a session's
 * ([open-questions.md](../../../../Lemmaria-design-doc/docs/open-questions.md)
 * → *DEFERRED*).
 *
 * **Keep writing the anthropic rows.** Every scenario that takes this gate is
 * still built and typechecked, and runs the day the switch is set. A closed pin
 * is reported as *not measured — pin disabled*, never as a zero.
 */
export const liveAnthropicReady = (): boolean =>
  process.env.LEMMARIA_SMOKE_ANTHROPIC_ENABLED === "1" &&
  Boolean(process.env.LEMMARIA_SMOKE_ANTHROPIC_KEY);

/** Small by intent: every scenario here is a few turns of real spend. */
export const LIVE_BUDGET = {
  maxTurns: 6,
  maxToolCalls: 12,
  maxOutputTokens: 4096,
} as const;
