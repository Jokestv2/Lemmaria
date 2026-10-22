/**
 * The `replace_anchor` output interpretation (ADR 0007, M8): an agentic edit
 * action's final answer is JSON `{anchor, replacement, file?}` — the model
 * chooses the exact span, the HARNESS locates it. The anchor must be copied
 * verbatim from the file and occur exactly once; anything else is fed back
 * through retry_with_feedback so the model can correct itself. Location by
 * verbatim anchor makes the edit self-checking (ADR 0002 content anchor).
 */

export interface AnchoredEdit {
  anchor: string;
  replacement: string;
  file?: string;
}

/**
 * Recover the JSON payload from a model's final answer (shared by the
 * replace_anchor and annotations output interpretations — ADR 0007/0008).
 *
 * A live L1 model routinely wraps its JSON in a sentence of prose or a fenced
 * block even when the action asked for a bare object — the commonest reason a
 * correct compile fix was discarded as "no fix could be produced". So we are
 * tolerant of surrounding text: a ```…``` block anywhere, else the first
 * balanced {…}/[…] value pulled out of the prose. Falls back to the whole body
 * (which then fails to parse and steers a retry) when there is no JSON to find.
 */
export function extractJsonPayload(text: string): string {
  const body = text.trim();
  // A fenced block, wherever it sits (prose may precede/follow it).
  const fence = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/.exec(body);
  if (fence?.[1] !== undefined) return fence[1].trim();
  return extractFirstJsonValue(body) ?? body;
}

/**
 * The first balanced JSON value (object or array) in `text`, string-aware so a
 * brace inside a JSON string never miscounts. Returns `undefined` when there is
 * no bracketed value at all (leaving `extractJsonPayload` to fall back to the
 * whole body). The regex fence-stripping caveat still stands (known-limits M8).
 */
function extractFirstJsonValue(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Parse the model's final answer; `{error}` carries a model-actionable reason. */
export function parseAnchoredEdit(
  text: string,
): AnchoredEdit | { error: string } {
  const body = extractJsonPayload(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      error:
        'the answer must be a single JSON object like {"anchor": "...", "replacement": "..."} — no prose, no commentary',
    };
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== "object") {
    return { error: "the answer must be a JSON object" };
  }
  if (typeof obj.anchor !== "string" || obj.anchor.length === 0) {
    return {
      error:
        '"anchor" must be a non-empty string copied verbatim from the file',
    };
  }
  if (typeof obj.replacement !== "string") {
    return { error: '"replacement" must be a string' };
  }
  return {
    anchor: obj.anchor,
    replacement: obj.replacement,
    ...(typeof obj.file === "string" && obj.file !== ""
      ? { file: obj.file }
      : {}),
  };
}

/** Exact-substring location; the anchor must occur exactly once. */
export function locateAnchor(
  text: string,
  anchor: string,
): { offset: number } | { error: "not_found" | "ambiguous" } {
  const first = text.indexOf(anchor);
  if (first < 0) return { error: "not_found" };
  if (text.indexOf(anchor, first + 1) !== -1) return { error: "ambiguous" };
  return { offset: first };
}
