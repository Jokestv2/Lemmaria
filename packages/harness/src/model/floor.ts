/**
 * The L2 model floor (A6, ADR 0023) — resolved Q4 of the v0.2 stage plan:
 * *"declare an L2 model floor + honest degradation below it … the composer
 * states what it needs and says so when the configured model can't sustain the
 * loop, rather than failing mysteriously."*
 *
 * **This table is an evidence claim, so it stays as small as the evidence.**
 * The only models Lemmaria has driven through a full streamed multi-turn tool
 * loop are the four from the S4 spike (see the stage plan's §S4 findings,
 * finding 5): `claude-haiku-4-5`, `claude-sonnet-4-5`, `gpt-4o-mini` and
 * `gpt-5-mini`, each of which held the contract 3/3.
 *
 * Two verdicts, deliberately — not three:
 *
 * - `verified` — matches a prefix below.
 * - `unverified` — everything else.
 *
 * There is **no `below` verdict**. Asserting that a model *will* fail needs
 * evidence, and S4 explicitly recorded that it probed nothing under the
 * haiku/4o-mini class and nothing local/OSS, so "the floor claim does not
 * extend there". Saying "we have not verified this" is the true statement;
 * saying "this is too weak" would be the X1 class of overclaim this milestone
 * exists to purge.
 *
 * The table changes only when new probe evidence arrives (re-run the retained
 * eval driver — `lemmaria eval` — against the candidate and record the result).
 */

/**
 * Model-id prefixes Lemmaria claims sustain the L2 session loop.
 *
 * Entries fall into two kinds, and the difference is stated rather than hidden:
 *
 * 1. **Probed** — `claude-haiku-4-5`, `claude-sonnet-4-5`, `gpt-4o-mini`,
 *    `gpt-5-mini` ran the S4 matrix; `gpt-6-luna` ran `lemmaria eval`'s
 *    methods-from-codebase loop 3/3 on 2026-10-20 (ADR 0090 §8).
 * 2. **Inferred siblings** — `claude-opus`, `gpt-4o`, `gpt-5` are larger
 *    members of a probed family. This is an inference, not a measurement; it is
 *    recorded as such in ADR 0023. The inference only ever runs *upward* (a
 *    larger sibling of a passing model), never downward.
 */
export const L2_VERIFIED_MODEL_PREFIXES: readonly string[] = [
  // Anthropic — PROBED: claude-haiku-4-5, claude-sonnet-4-5.
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  // Anthropic — INFERRED UPWARD: opus is the larger sibling of a probed model
  // in the same generation. `claude-opus-4` and not `claude-opus`, so an older
  // opus release cannot inherit the verdict.
  "claude-opus-4",
  // OpenAI — PROBED: gpt-4o-mini, gpt-5-mini. These two prefixes cover the
  // probed ids AND their larger siblings (gpt-4o, gpt-5), which is the same
  // upward inference.
  "gpt-4o",
  "gpt-5",
  // OpenAI — PROBED (ADR 0090 §8): `lemmaria eval --scenario
  // methods-from-codebase --model gpt-6-luna` on 2026-10-20, 3/3 PASS (9 turns
  // and 12–13 tool calls a run, ~US$0.003 each). The full id and no stem: no
  // other gpt-6 model has run the loop, and none is larger by name.
  //
  // NOT here: claude-haiku-5-5. The Anthropic pin is off, so it has never run
  // the loop; and haiku-4-5's verdict does not cross a generation.
  "gpt-6-luna",
];

/**
 * How the floor is described to a human. Names the *probed* tier only — the
 * inferred siblings are an implementation detail of the table, not a promise
 * to put in front of the user.
 */
export const L2_FLOOR_LABEL =
  "the small tier of a current frontier family (claude-haiku-4-5 / gpt-4o-mini class) or better";

/**
 * The same label in Chinese (invariant 6). The harness's notice `message` is
 * combined-bilingual by contract, so interpolating the English label into both
 * halves would have shipped a mixed-language sentence to every Chinese reader
 * of the persisted transcript.
 */
export const L2_FLOOR_LABEL_ZH =
  "当前前沿模型家族的小尺寸档位（claude-haiku-4-5 / gpt-4o-mini 级别）或更强";

/** Whether Lemmaria has verified this model for agentic (L2) sessions. */
export type SessionModelVerdict = "verified" | "unverified";

/**
 * Classify the configured model against the declared floor.
 *
 * Longest-prefix match, the same idiom `contextWindowFor` and
 * `KNOWN_MODEL_PRICING` use — a dated id (`claude-sonnet-4-5-20260101`) must
 * inherit its family's verdict, while an unrelated id that merely *contains* a
 * known name (`not-gpt-4o`) must not.
 */
export function classifyModelForSession(model: string): SessionModelVerdict {
  return L2_VERIFIED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? "verified"
    : "unverified";
}
