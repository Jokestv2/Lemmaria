/**
 * The one bound on what a tool may inject into the conversation (A6).
 *
 * Every other payload in the loop is already bounded — the model's output by
 * `TURN_MAX_TOKENS`, a `read_span` by `READ_SPAN_MAX_TOKENS`, a grep by
 * `GREP_MAX_MATCHES`. Tool *results* were not: `run_script` captures up to
 * 200 000 bytes **per stream** and `literature_search` returns up to 20 results
 * with abstracts, and both were `JSON.stringify`d straight into the `tool`
 * message. One chatty script run or one broad literature search could therefore
 * fill a context window in a single call — surfacing to the user only as a
 * `context.limit` stop with no explanation of what ate it.
 *
 * The cap is applied at the loop's single tool-result choke point, so the
 * transcript row and the model's message always carry the same bytes: a
 * transcript showing more than the model actually saw would be its own kind of
 * dishonesty.
 */

/**
 * Maximum characters of a serialized tool result that reach the conversation.
 *
 * ~32 000 chars is roughly 8 000 tokens — about 6 % of the conservative
 * 128 000-token default window, so even several capped results in one task
 * leave room to work. It is chosen to sit *above* the legitimate large results
 * (a 500-entry `list_files`, a 50-match `grep_project`) and well below the
 * pathological ones (a 200 kB script dump), so the common case is untouched.
 */
export const TOOL_RESULT_MAX_CHARS = 32_000;

/**
 * Bound a serialized tool result, honestly.
 *
 * A result that fits is returned **byte-identical** — no re-encoding, no
 * wrapper — so the overwhelming majority of calls are unaffected. An oversized
 * one becomes a valid JSON envelope that keeps the *head* of the payload (the
 * beginning of a script's output or a search's first hits is the part that
 * matters) and states the real original size, so the model can react — narrow
 * the query, read a range, or tell the user — rather than silently reasoning
 * over a slice it does not know is a slice.
 */
export function capToolResult(
  json: string | undefined,
  limit: number = TOOL_RESULT_MAX_CHARS,
): string {
  // A tool resolving to `undefined` makes JSON.stringify return undefined;
  // that must not become a TypeError escaping the loop's never-throws contract.
  if (json === undefined) return "";
  if (json.length <= limit) return json;

  // The envelope re-serializes `content`, so every backslash and quote in the
  // payload doubles — a naive `slice(0, limit)` produced an envelope up to 2×
  // the limit on exactly the escape-heavy `run_script` output this exists to
  // bound (review, Important 4). Shrink until the SERIALIZED result fits.
  const envelope = (take: number): string =>
    JSON.stringify({
      truncated: true,
      originalChars: json.length,
      shownChars: take,
      note: `This tool result was truncated: ${take} of ${json.length} characters are shown, starting from the beginning. Do not assume the omitted part is empty — narrow the request (a tighter query, a smaller range, a specific file) if you need the rest.`,
      content: json.slice(0, take),
    });

  let take = limit;
  let out = envelope(take);
  // Proportional shrink converges in a couple of passes for any escape ratio;
  // the guard bounds it regardless, and `take` strictly decreases.
  for (let i = 0; out.length > limit && take > 0 && i < 8; i += 1) {
    const next = Math.floor((take * limit) / out.length);
    take = next < take ? next : take - 1;
    out = envelope(Math.max(0, take));
  }
  return out;
}
