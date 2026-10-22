/**
 * Assertions for invariant 6 rule 2 (ADR 0034) in the harness's own strings.
 *
 * The repo-wide enforcement lives in `scripts/check-mixed-language-strings.mjs`,
 * which scans SOURCE TEXT for the `"english clause / 中文子句"` shape. These
 * helpers assert something STRICTER over the RENDERED value, which is what a
 * reader actually gets: an `en` render carries no Chinese at all, and a `zh`
 * render carries no English clause. A string that satisfies these trivially
 * satisfies the guard, so this is not a second copy of that rule — it is the
 * property the guard approximates, checked where the guard cannot look.
 *
 * The shape every locale test takes is ADR 0034 §5's: the SAME call rendered
 * under `"en"` and under `"zh"`, asserted to differ and each asserted
 * monolingual. Never one string asserted against two fixtures — that is the
 * assertion that certified the defect.
 */
import { expect } from "vitest";
import type { SessionLocale } from "../../src/contracts/sessions.js";

const CJK = /[一-鿿]/;

/**
 * Three ASCII words in a row plus a function word — the guard's own test for
 * "this is English PROSE rather than a proper noun". A Chinese string naming
 * `lemmaria.verify.engine` or `MiKTeX / TeX Live` must not be reported.
 */
const EN_CLAUSE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
const EN_FUNCTION_WORD =
  /\b(?:the|an?|is|are|was|were|be|to|of|in|on|for|and|or|not|no|it|this|that|these|with|from|by|at|as|has|have|had|can|could|will|would|your|you|its|any|all|so|but|if|when|while|than|then|there|here|into|out|up|down|only|every|each|because|before|after|again)\b/i;

/** Blank `${…}` results the caller interpolated — a key or a path is not prose. */
const withoutInterpolated = (text: string, interpolated: string[]): string =>
  interpolated.reduce((acc, v) => acc.split(v).join(" "), text);

/** One rendered string is wholly in `locale`. `interpolated` names caller-supplied
 *  values (a citation key, a path, an engine name) that belong to neither language. */
export function expectMonolingual(
  text: string,
  locale: SessionLocale,
  interpolated: string[] = [],
): void {
  const stripped = withoutInterpolated(text, interpolated);
  if (locale === "en") {
    expect(stripped, `en render carries Chinese: ${text}`).not.toMatch(CJK);
    return;
  }
  expect(stripped, `zh render carries no Chinese: ${text}`).toMatch(CJK);
  const englishProse =
    EN_CLAUSE.test(stripped) && EN_FUNCTION_WORD.test(stripped);
  expect(englishProse, `zh render carries an English clause: ${text}`).toBe(
    false,
  );
}

/** ADR 0034 §5's shape: the same call, two locales, two monolingual renders. */
export function expectLocalePair(
  en: string,
  zh: string,
  interpolated: string[] = [],
): void {
  expect(en, "the two locales rendered identically").not.toBe(zh);
  expectMonolingual(en, "en", interpolated);
  expectMonolingual(zh, "zh", interpolated);
}
