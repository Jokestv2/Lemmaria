/**
 * What a model can be SHOWN — the image-input capability (V3, ADR 0080 §D6).
 *
 * A deny-by-default longest-prefix table over the model id, with a per-model
 * override the host carries on `ModelBinding`. It is the first of the two locks
 * that keep a pixel away from a model that cannot read one: this one withholds
 * the TOOL at the allowlist, and the protocol adapters drop the image blocks at
 * the wire. Two locks, because a misrouting that puts an image in front of a
 * blind endpoint fails the whole turn mid-review, and no single check is worth
 * trusting with that.
 *
 * **Unknown is `false`.** That is invariant 2's direction — a capability is
 * declared, never assumed — and it is exactly why the override exists: an
 * OpenAI-compatible endpoint nobody has heard of may well see, and one click in
 * the Models tab is the remedy. The alternative, allow-by-default, would offer
 * the tool to a model that then errors on the first image block.
 *
 * The matcher is deliberately the same six lines as `contextWindowFor`
 * (`session/context.ts`) and `lookupPricing` (`model/pricing.ts`), written a
 * third time rather than refactored into a shared helper: the three tables
 * answer different questions and the shared abstraction would be the only thing
 * binding them together.
 */

import type { ModelBinding } from "../contracts/adapters.js";
import type { ToolName } from "../contracts/tools.js";

/**
 * Model-id prefix → whether that family accepts image input.
 *
 * A `false` row is not the same as an absent one: it is a family we KNOW does
 * not see, written down so that a shorter `true` prefix cannot shadow it.
 * (`gpt-4-` is the case that needs it — `gpt-4-turbo` sees, `gpt-4-0613` does
 * not, and only the longest-prefix rule tells them apart.)
 *
 * **This table is a decision the gate ratifies**, and `deepseek: false` is the
 * row most likely to be wrong the soonest. The per-model override is the
 * remedy for that — never an edit to this table under pressure.
 */
export const IMAGE_INPUT_MODEL_PREFIXES: Record<string, boolean> = {
  claude: true,
  "gpt-4o": true,
  "gpt-4-turbo": true,
  "gpt-4.1": true,
  "gpt-5": true,
  // ADR 0090 §3: OpenAI's model page, read 2026-10-20 — "Input modalities:
  // text, image". The full id, so a sibling nobody has read about stays false.
  "gpt-6-luna": true,
  o1: true,
  o3: true,
  o4: true,
  "gpt-4-": false,
  "gpt-3.5": false,
  deepseek: false,
};

/** What the TABLE says about a model id. Longest prefix wins; no prefix ⇒ false. */
export function imageInputFor(model: string): boolean {
  let best: { prefix: string; imageInput: boolean } | undefined;
  for (const [prefix, imageInput] of Object.entries(
    IMAGE_INPUT_MODEL_PREFIXES,
  )) {
    if (
      model.startsWith(prefix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { prefix, imageInput };
    }
  }
  return best?.imageInput ?? false;
}

/**
 * What the BINDING says — the user's per-model override first, the table when
 * the binding declares nothing. This is the question every caller asks; nothing
 * outside this module should read `imageInputFor` directly for a binding it has.
 */
export function canSeeImages(
  binding: Pick<ModelBinding, "model" | "imageInput">,
): boolean {
  return binding.imageInput ?? imageInputFor(binding.model);
}

/**
 * The allowlist lock: drop every image-requiring tool for a binding that cannot
 * see. Returns a new array; never mutates the one it is given.
 */
/**
 * Every tool whose RESULT can carry images, and which therefore may not be
 * offered to a model that cannot see one.
 *
 * A set rather than the one literal it currently holds, because this is half of
 * a two-lock capability ([ADR 0080](../../../../Lemmaria-design-doc/docs/adr/0080-the-visual-door.md)
 * §3): the tool is withheld at the allowlist, and the blocks are dropped again
 * at each wire. A second image-bearing tool added against a hardcoded name
 * would still be dropped at the wire and would **not** be withheld here — a
 * half-lock, which is worse than either lock alone, because the model is
 * offered a capability whose output it will never receive and spends a call
 * discovering that. Adding the name here is the whole change.
 */
export const IMAGE_BEARING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "view_pdf_pages",
]);

export function withholdImageTools(
  allowed: readonly ToolName[],
  binding: Pick<ModelBinding, "model" | "imageInput">,
): ToolName[] {
  if (canSeeImages(binding)) return [...allowed];
  return allowed.filter((name) => !IMAGE_BEARING_TOOLS.has(name));
}
