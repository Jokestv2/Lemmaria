import type { Skill } from "../contracts/skills.js";

/**
 * `/skill:<name> <request>` — the user reaching for a Writing Skill explicitly
 * (ADR 0028 §D6), adapted from Pi's `/skill:` command.
 *
 * **§D6's decision is preserved; E1 (ADR 0047) supersedes only its mechanism.**
 * The body still arrives unconditionally rather than being requested, because
 * the reasoning behind that has not changed: Pi's own docs concede that models
 * do not reliably reach for a skill on their own, which is exactly why their
 * slash command exists, and when the user has said which guidance to apply,
 * hoping the model agrees is not a mechanism.
 *
 * **What changed, and the regression it fixes.** §D6 substituted the body into
 * the model's view of the user message and nowhere else — model-visible only,
 * never persisted. That kept the transcript honest, but it meant the expansion
 * existed only in the live message list: a **resumed or compacted session
 * replays `/skill:tone fix it` with no body behind it**, because
 * `buildConversationHistory` rebuilds from persisted ITEMS and there was no
 * item carrying the body. The user's explicit instruction silently evaporated
 * at exactly the moment a long session most needed it.
 *
 * ADR 0028 §6 weighed three repairs and took none, each for a real cost. **The
 * prior art took a fourth option that section never considered:** Codex emits a
 * separate `<skill>` fragment carrying name/path/contents alongside the
 * untouched user message, and Claude Code's skill tool makes the body an
 * ordinary tool result. Both put the body in **its own history item**.
 *
 * Lemmaria's native form is the cheaper of the two: this module now merely
 * **parses**, and `run.ts` turns the result into a real `load_skill` exchange —
 * the same `tool_call` item a model-initiated `load_skill` already produces. It
 * pays none of §6's three costs:
 *
 *   - the `user_message` item still holds exactly the typed text, so §D6's
 *     transcript-honesty property is untouched;
 *   - the RESULT is persisted, so replay is faithful to what the model actually
 *     saw, whatever happened to the skill on disk since;
 *   - it reuses `tool_call` / `tool_result`, so there is **no new contract
 *     field** for a value already on disk.
 *
 * Two properties fall out free: the body flows through ADR 0029's truncation
 * and ADR 0021's retention like any other tool result, and explicit invocation
 * stops being a second mechanism beside the tool — one concept where there
 * were two.
 *
 * An unknown name passes through verbatim: it is prose, not an error. The
 * model still sees the skill catalogue and can call `load_skill` itself.
 */

/**
 * Every `/skill:<name>` in a message, wherever it sits.
 *
 * **This used to be `^\/skill:…$` — anchored on the whole trimmed message —
 * and the narrowing was called load-bearing** ([ADR 0047](../../../../Lemmaria-design-doc/docs/adr/0047-skill-invocation-as-a-tool-exchange.md)).
 * [ADR 0050](../../../../Lemmaria-design-doc/docs/adr/0050-skills-anywhere-in-a-message.md)
 * withdrew it: the operator drove Codex's **VS Code extension**, which invokes
 * skills mid-input and several per message, and one message routinely wants
 * more than one skill. The build's earlier evidence for the anchor came from
 * Codex's **TUI** (`slash_input.rs`), a different surface with a different
 * composer, and generalising from it was the error.
 *
 * `(?:^|\s)` and the `(?=\s|$)` lookahead together are what keep a slash
 * INSIDE a word from counting — `http://x/skill:tone` is a URL, not an
 * invocation — which is the same whitespace-delimited rule `activeToken`'s
 * `"boundary"` anchor applies in the composer, so the two grammars still agree.
 */
const INVOCATION_RE = /(?:^|\s)\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

export interface SkillInvocations {
  /**
   * Every skill named, in the order they appear, each **at most once** —
   * naming one twice is a typo, not a request to load it twice.
   */
  skills: readonly Skill[];
  /**
   * What the user asked for, with the prefix removed. Empty when they typed the
   * prefix alone — which is a real request ("apply this skill"), not an error.
   *
   * **`run.ts` deliberately sends the FULL typed text to the model, not this.**
   * A rebuilt history replays the `user_message` item, which holds the typed
   * text prefix and all, so sending the stripped form live would make the live
   * and rebuilt histories differ in content as well as order. This is the
   * parsed request for any caller that wants the user's actual instruction —
   * it is what the prefix means, and the parser's job is to say so.
   */
  request: string;
}

/**
 * Every skill a message names, and what is left of the message once their
 * tokens are taken out.
 *
 * **Plural since [ADR 0050](../../../../Lemmaria-design-doc/docs/adr/0050-skills-anywhere-in-a-message.md).**
 * One message routinely wants more than one skill — a house style AND a venue's
 * rules — and the operator confirmed against Codex's VS Code extension that
 * this is what the reference surface does. Returns an empty `skills` for
 * ordinary prose rather than `undefined`: there is no failure here, only a
 * count, and a caller that has to branch on undefined-vs-empty gets the empty
 * case wrong eventually.
 *
 * A **request to load**, deliberately, rather than expanded text: the caller
 * decides how each body reaches the model, which is what lets it stay a real
 * tool exchange the rebuild path already knows how to replay.
 *
 * **An unknown name stays prose** and keeps its place in `request` — the model
 * still sees the catalogue and can call `load_skill` itself, so a typo degrades
 * to a question rather than to an error.
 */
export function parseSkillInvocations(
  text: string,
  skills: readonly Skill[],
): SkillInvocations {
  const trimmed = text.trim();
  const named: Skill[] = [];
  const seen = new Set<string>();
  // `matchAll` needs the /g flag the regex carries; it also means `exec` state
  // is never shared, which a module-level /g regex would otherwise leak between
  // calls.
  for (const match of trimmed.matchAll(INVOCATION_RE)) {
    const name = match[1] as string;
    if (seen.has(name)) continue;
    const skill = skills.find((s) => s.name === name);
    if (!skill) continue;
    seen.add(name);
    named.push(skill);
  }

  const request = trimmed
    .replace(INVOCATION_RE, (whole, name: string) =>
      // Only a token that RESOLVED is removed; an unknown one is prose and
      // stays exactly where the user typed it. The slice keeps the boundary
      // character the match consumed, so words do not run together.
      seen.has(name)
        ? whole.slice(0, whole.length - `/skill:${name}`.length)
        : whole,
    )
    // Only the run a removal left behind, and deliberately not `\s+`: a
    // multi-line request keeps its lines.
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return { skills: named, request };
}
