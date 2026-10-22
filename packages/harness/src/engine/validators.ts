/**
 * The §7 built-in validator set — programmatic post-checks on model output
 * (generation-level; distinct from post-Accept document verification). On
 * failure the engine feeds `reason` back to the model (retry_with_feedback).
 *
 * M3 semantics notes: `glossary_consistent` checks EN-term casing only (zh /
 * abbreviation checks land with translate at M6); regex validators guard by
 * pattern/input length caps rather than a true execution timeout.
 */

import type { ValidatorOutcome } from "../contracts/actions.js";
import type { ProtectedSpan, WordCount } from "../contracts/adapters.js";
import type { GlossaryEntry } from "./paper.js";
import {
  type FrozenUnit,
  checkTokensIntact,
  stripTokens,
  thawText,
} from "./spans.js";
import { renderTemplate } from "./template.js";

export interface ValidatorContext {
  countWords: (text: string) => WordCount;
  /** Original (raw) unit text — the "before" for no_new_undefined_refs. */
  unitText: string;
  /** Editable-prose word count of the input unit — the basis for word_count's
   *  `reduce_by` (delta) target, matching `{{counts.current}}` in the prompt. */
  currentProseCount: number;
  frozen: FrozenUnit;
  /** Spans the action's protected_spans policy protects (the freeze set). The
   *  no-token fallback checks these survive; a span the policy allows editing
   *  is absent here, so it may be changed/removed (e.g. fix-compile-error). */
  protectedSpans: ProtectedSpan[];
  knownLabels: ReadonlySet<string>;
  knownCitations: ReadonlySet<string>;
  glossary: GlossaryEntry[];
  params: Record<string, unknown>;
}

export type ValidatorConfig = { type: string; [k: string]: unknown };

const MAX_REGEX_PATTERN = 256;
const MAX_REGEX_INPUT = 100_000;

export function runValidators(
  configs: ValidatorConfig[],
  rawOutput: string,
  ctx: ValidatorContext,
): ValidatorOutcome[] {
  const texts: ValidatorTexts = {
    raw: rawOutput,
    thawed: thawText(rawOutput, ctx.frozen.tokens),
    prose: stripTokens(rawOutput, ctx.frozen.tokens),
  };
  return configs.map((config) => {
    const run = Object.hasOwn(VALIDATORS, config.type)
      ? VALIDATORS[config.type]
      : undefined;
    if (!run) {
      return {
        type: config.type,
        pass: false,
        reason: `unknown validator type "${config.type}"`,
      };
    }
    return {
      type: config.type,
      ...(config.soft === true ? { soft: true } : {}),
      ...run(config, texts, ctx),
    };
  });
}

type Verdict = { pass: boolean; reason?: string; distance?: number };
/**
 * `raw` = model output as-is (tokens intact); `thawed` = tokens restored to
 * source (what would be written); `prose` = tokens removed — the same basis
 * as `{{counts.current}}`/`{{language}}`, so word_count and language_is judge
 * the editable prose, not protected-span LaTeX source (invariant 6).
 */
interface ValidatorTexts {
  raw: string;
  thawed: string;
  prose: string;
}
type Validator = (
  config: ValidatorConfig,
  texts: ValidatorTexts,
  ctx: ValidatorContext,
) => Verdict;

/** Resolve a possibly-templated config value ("{{params.target}}") to a number. */
function configNumber(
  config: ValidatorConfig,
  key: string,
  ctx: ValidatorContext,
): number | undefined {
  const value = config[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const rendered = renderTemplate(value, { params: ctx.params }).text.trim();
    if (rendered === "") return undefined; // a typo'd template renders empty — not 0
    const n = Number(rendered);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** Resolve a possibly-templated string config value ("{{params.target_language}}"). */
function configString(
  config: ValidatorConfig,
  key: string,
  ctx: ValidatorContext,
): string | undefined {
  const value = config[key];
  if (typeof value !== "string") return undefined;
  const rendered = renderTemplate(value, { params: ctx.params }).text.trim();
  return rendered === "" ? undefined : rendered;
}

/**
 * Whether `term` occurs in `text` as a glossary term. For an English term the
 * match is anchored at a leading word boundary (so "attention mechanism" still
 * matches the plural "mechanisms" but "gan" does NOT match "elegant") — this
 * keeps the translate hard-constraint low-false-positive. A CJK term has no word
 * boundaries, so it falls back to a plain substring test (the pre-authorized
 * segmentation limitation; see progress.md M6 known issues).
 */
function hasTerm(text: string, term: string): boolean {
  if (/^[A-Za-z]/.test(term)) {
    return new RegExp(`\\b${escapeRegex(term)}`, "i").test(text);
  }
  return text.includes(term);
}

const REF_RE = /\\(?:ref|eqref|pageref|autoref|cref|Cref|vref)\*?\{([^{}]*)\}/g;
// Leading [a-zA-Z]* covers biblatex forms (\textcite, \parencite, \autocite, \footcite).
const CITE_RE =
  /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)\}/g;

function extractKeys(text: string, re: RegExp): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(re)) {
    for (const key of (m[1] ?? "").split(",")) {
      const k = key.trim();
      if (k) keys.add(k);
    }
  }
  return keys;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VALIDATORS: Record<string, Validator> = {
  word_count(config, texts, ctx) {
    // Deltas are the primary inputs — academics think "cut N words" / "add N
    // words", not "reach length L". `reduce_by` shrinks (target = current − N,
    // clamped to at least 1 word), `grow_by` expands (target = current + N).
    // Absolute `target` is the fallback for both.
    const reduceBy = configNumber(config, "reduce_by", ctx);
    const growBy = configNumber(config, "grow_by", ctx);
    const target =
      reduceBy !== undefined
        ? Math.max(1, ctx.currentProseCount - reduceBy)
        : growBy !== undefined
          ? ctx.currentProseCount + growBy
          : configNumber(config, "target", ctx);
    if (target === undefined)
      return { pass: false, reason: "word_count: missing/invalid target" };
    const tolerance = configNumber(config, "tolerance", ctx) ?? 0;
    const margin =
      tolerance < 1 ? Math.round(target * tolerance) : Math.round(tolerance);
    const wc = ctx.countWords(texts.prose);
    const lo = target - margin;
    const hi = target + margin;
    if (wc.count >= lo && wc.count <= hi) return { pass: true };
    return {
      pass: false,
      distance: Math.abs(wc.count - target),
      reason: `output is ${wc.count} ${wc.unit}, target ${target} ±${margin} (${lo}–${hi})`,
    };
  },

  protected_spans_intact(_config, texts, ctx) {
    if (ctx.frozen.tokens.size > 0) {
      const { missing, duplicated } = checkTokensIntact(
        texts.raw,
        ctx.frozen.tokens,
      );
      if (missing.length === 0 && duplicated.length === 0)
        return { pass: true };
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(
          `missing protected tokens: ${missing
            .map((t) => `${t} (${ctx.frozen.tokens.get(t)})`)
            .join(", ")}`,
        );
      }
      if (duplicated.length > 0)
        parts.push(`duplicated protected tokens: ${duplicated.join(", ")}`);
      return { pass: false, reason: parts.join("; ") };
    }
    const gone = ctx.protectedSpans.filter(
      (s) => !texts.thawed.includes(s.raw),
    );
    if (gone.length === 0) return { pass: true };
    return {
      pass: false,
      reason: `protected spans altered or removed: ${gone.map((s) => s.raw).join(", ")}`,
    };
  },

  no_new_undefined_refs(_config, texts, ctx) {
    const inputRefs = extractKeys(ctx.unitText, REF_RE);
    const inputCites = extractKeys(ctx.unitText, CITE_RE);
    const badRefs = [...extractKeys(texts.thawed, REF_RE)].filter(
      (k) => !ctx.knownLabels.has(k) && !inputRefs.has(k),
    );
    const badCites = [...extractKeys(texts.thawed, CITE_RE)].filter(
      (k) => !ctx.knownCitations.has(k) && !inputCites.has(k),
    );
    if (badRefs.length === 0 && badCites.length === 0) return { pass: true };
    const parts: string[] = [];
    if (badRefs.length > 0)
      parts.push(`new undefined \\ref keys: ${badRefs.join(", ")}`);
    if (badCites.length > 0)
      parts.push(`new unknown \\cite keys: ${badCites.join(", ")}`);
    return { pass: false, reason: parts.join("; ") };
  },

  language_is(config, texts, ctx) {
    const expected = configString(config, "expected", ctx);
    if (!expected)
      return { pass: false, reason: "language_is: missing expected language" };
    const actual = ctx.countWords(texts.prose).language;
    if (actual === expected) return { pass: true };
    return {
      pass: false,
      reason: `output language is ${actual}, expected ${expected}`,
    };
  },

  glossary_consistent(_config, texts, ctx) {
    const violations: string[] = [];
    // `target_language` (translate) turns the glossary into a hard constraint:
    // the canonical target-language form must appear in the output whenever the
    // source form appeared in the input. Absent it, this is the M3 EN-casing check.
    const target =
      typeof ctx.params.target_language === "string"
        ? ctx.params.target_language
        : undefined;
    for (const entry of ctx.glossary) {
      const term = entry.term.trim();
      const zh = entry.zh.trim();
      // (1) EN-casing check: output EN forms must match the canonical spelling.
      if (/^[A-Za-z][A-Za-z0-9 -]*$/.test(term)) {
        const sentenceCase = term.charAt(0).toUpperCase() + term.slice(1);
        const re = new RegExp(`\\b${escapeRegex(term)}\\b`, "gi");
        for (const m of texts.thawed.matchAll(re)) {
          const found = m[0];
          if (found !== term && found !== sentenceCase) {
            violations.push(`"${found}" should be the canonical "${term}"`);
          }
        }
      }
      // (2) Translate hard-constraint: the target-language canonical form must be
      //     present when the source form appears in the input. `hasTerm` anchors
      //     the English side at a word boundary so an unrelated word that merely
      //     contains the term (e.g. "gan" in "elegant") does not force a spurious
      //     translation and suppress an otherwise-correct output.
      if (target === "zh" && zh && term) {
        if (hasTerm(ctx.unitText, term) && !texts.thawed.includes(zh)) {
          violations.push(
            `glossary term "${term}" must be translated as "${zh}"`,
          );
        }
      } else if (target === "en" && zh && term) {
        if (ctx.unitText.includes(zh) && !hasTerm(texts.thawed, term)) {
          violations.push(
            `glossary term "${zh}" must be translated as "${term}"`,
          );
        }
      }
    }
    if (violations.length === 0) return { pass: true };
    return { pass: false, reason: [...new Set(violations)].join("; ") };
  },

  latex_balanced(_config, texts) {
    const text = texts.thawed
      .split("\n")
      .map((line) => {
        let out = "";
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === "\\") {
            out += line.slice(i, i + 2);
            i += 1;
            continue;
          }
          if (ch === "%") break; // comment to EOL
          out += ch;
        }
        return out;
      })
      .join("\n");
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth < 0)
          return {
            pass: false,
            reason: "unbalanced braces: closing } without opener",
          };
      }
    }
    if (depth !== 0)
      return { pass: false, reason: `unbalanced braces: ${depth} unclosed {` };
    const stack: string[] = [];
    for (const m of text.matchAll(/\\(begin|end)\{([^{}]*)\}/g)) {
      const env = m[2] ?? "";
      if (m[1] === "begin") stack.push(env);
      else {
        const open = stack.pop();
        if (open !== env) {
          return {
            pass: false,
            reason: `environment mismatch: \\end{${env}} closes \\begin{${open ?? "nothing"}}`,
          };
        }
      }
    }
    if (stack.length > 0)
      return {
        pass: false,
        reason: `unclosed environments: ${stack.join(", ")}`,
      };
    return { pass: true };
  },

  document_structure_intact(_config, texts, ctx) {
    // Lexical (not AST) guard so it holds even when the document is malformed
    // *because* it does not compile — a compile fix must never add or drop a
    // document delimiter (dropping \end{document} corrupts the file; the AST
    // delimiter guard in the LaTeXAdapter can't help when the parse is broken).
    // Compares the edited region's input (unitText) vs output (thawed).
    const delimiters = [
      { label: "\\begin{document}", re: /\\begin\{document\}/g },
      { label: "\\end{document}", re: /\\end\{document\}/g },
    ];
    const count = (text: string, re: RegExp): number =>
      (text.match(re) ?? []).length;
    const violations: string[] = [];
    for (const { label, re } of delimiters) {
      const before = count(ctx.unitText, re);
      const after = count(texts.thawed, re);
      if (before !== after) {
        violations.push(`${label} count changed ${before} → ${after}`);
      }
    }
    if (violations.length === 0) return { pass: true };
    return {
      pass: false,
      reason: `document structure altered: ${violations.join("; ")}`,
    };
  },

  /**
   * D1 (ADR 0032): the shape of the text survives the rewrite.
   *
   * `document_structure_intact` counts only `\begin{document}` /
   * `\end{document}`. Paragraph breaks, list structure and line discipline are
   * unguarded — and in LaTeX a lost blank line silently MERGES two paragraphs,
   * which is a semantic change to the document, not a formatting one. Reported
   * on Translate and Shrink; it is really every `replace_selection` action,
   * because the model returns one blob and the engine splices it over the
   * selection span with nothing checking the layout.
   *
   * **One-sided on purpose: structure must not DECREASE.** The harm is loss.
   * Gaining a paragraph is not that harm and is legitimate during `expand`, so
   * a one-sided rule is correct for all five prose actions at once — which is
   * what lets one declaration serve them all instead of five per-action
   * variants that would drift.
   *
   * Format-neutral by construction: blank-line-separated blocks and
   * line-leading list markers mean the same thing in LaTeX and in Markdown.
   * LaTeX `\item` is additionally a frozen protected span, so
   * `protected_spans_intact` already guards its count on the quick-action path;
   * the list half is load-bearing for MARKDOWN, whose bullets are not frozen.
   */
  layout_preserved(_config, texts, ctx) {
    const before = layoutOf(ctx.unitText);
    const after = layoutOf(texts.thawed);
    const violations: string[] = [];
    let distance = 0;
    if (after.paragraphs < before.paragraphs) {
      const lost = before.paragraphs - after.paragraphs;
      distance += lost;
      violations.push(
        `${lost} paragraph break(s) lost (${before.paragraphs} → ${after.paragraphs}) — a merged paragraph changes the document, not just its look`,
      );
    }
    if (after.listItems < before.listItems) {
      const lost = before.listItems - after.listItems;
      distance += lost;
      violations.push(
        `${lost} list item(s) lost (${before.listItems} → ${after.listItems})`,
      );
    }
    if (violations.length === 0) return { pass: true };
    return {
      pass: false,
      distance,
      reason: `layout not preserved: ${violations.join("; ")}`,
    };
  },

  /**
   * D1 (ADR 0032): the figures in the selection survive the rewrite.
   *
   * Shrink asks the model to compress "WITHOUT changing its meaning" and the
   * only enforcement was a SOFT `word_count` — so the cheapest way to satisfy
   * the instruction is deletion, which is what the model does, and it costs
   * precision. This guards CONTENT rather than length. (`word_count` stays
   * soft; the soft-goal reasoning recorded in the YAML is correct and D1 does
   * not touch it.)
   *
   * **Honestly scoped, and named for what it checks.** The stage plan asked for
   * "a claim/number/citation retention check". Citations are already retained —
   * every cite macro is a frozen protected span, so `protected_spans_intact`
   * (declared on all five prose actions) fails a rewrite that drops one, and a
   * second mechanism would be a restatement. Claim-level retention is not
   * mechanically checkable at all. Numbers are, so numbers are what this
   * promises.
   *
   * Digits INSIDE a protected span are excluded: they belong to a `\cite{he2015}`
   * or an `$O(n^2)$`, not to the author's figures, and naming them on every
   * retry would be noise the model cannot act on.
   */
  numbers_retained(_config, texts, ctx) {
    const before = numbersIn(stripSpans(ctx.unitText, ctx.protectedSpans));
    if (before.length === 0) return { pass: true };
    // Both sides, or the exclusion is only half true: a `\cite{he2015}` left in
    // the OUTPUT would otherwise satisfy a prose figure `2015` the rewrite
    // actually dropped (review, Important 4).
    const after = new Set(
      numbersIn(stripSpans(texts.thawed, ctx.protectedSpans)),
    );
    const missing = [...new Set(before)].filter((n) => !after.has(n));
    if (missing.length === 0) return { pass: true };
    return {
      pass: false,
      distance: missing.length,
      reason: `figures dropped from the text: ${missing.join(", ")} — condense by rephrasing, never by deleting a number`,
    };
  },

  regex_must(config, texts) {
    return regexCheck(config, texts.thawed, true);
  },

  regex_must_not(config, texts) {
    return regexCheck(config, texts.thawed, false);
  },
};

/**
 * A line-opening bullet: `-`/`*`/`+` (Markdown) or `\item` (LaTeX). Unambiguous
 * — prose does not wrap onto a line starting with one.
 */
const LIST_BULLET = /^[ \t]*(?:[-*+][ \t]+|\\item\b)/;

/**
 * A line-opening ordered marker: `1.` / `1)`. AMBIGUOUS, and only counted where
 * a list can actually start (see `layoutOf`): source prose is hard-wrapped, so
 * a sentence broken before a year gives a line beginning `2015. Later work…`.
 */
const LIST_ORDERED = /^[ \t]*\d+[.)][ \t]+/;

/**
 * The two structural counts `layout_preserved` compares (D1).
 *
 * A "paragraph" is a blank-line-separated block with something in it; a line of
 * spaces is still a separator, because a model that emitted `"\n   \n"` merged
 * nothing.
 *
 * **Line endings are normalized first.** Splitting raw source on `/\n[ \t]*\n/`
 * finds nothing in a CRLF file — `"a\r\n\r\nb"` is one block — so on a
 * Windows-authored paper the paragraph half silently became inert, and since
 * the model's output is LF the one-sided rule could then never fire (review,
 * Important 3).
 *
 * **A list marker counts only where a list can actually start**: at the top of
 * the unit, after a blank line, or directly under another marker. Source prose
 * is hard-wrapped, so a sentence broken before a year gives a line beginning
 * `2015. Later work…` — which the bare marker pattern read as an ordered-list
 * item, and which any reflowing rewrite then "lost" (review, Important 6).
 */
function layoutOf(text: string): { paragraphs: number; listItems: number } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const paragraphs = normalized
    .split(/\n[ \t]*\n/)
    .filter((block) => block.trim() !== "").length;
  let listItems = 0;
  // Start of the unit behaves like a blank line: a unit may open with a list.
  let previousOpensAList = true;
  for (const line of normalized.split("\n")) {
    if (LIST_BULLET.test(line)) {
      listItems += 1;
      previousOpensAList = true;
      continue;
    }
    if (LIST_ORDERED.test(line)) {
      // Only a line that IS an ordered item continues the list — so
      // `previousOpensAList` is left exactly as it was. Chaining on the pattern
      // alone let one false marker legitimize the next: two sentences each
      // wrapped before a year ("…in\n2015. Later work…in\n2020. We build…")
      // scored as a two-item ordered list.
      if (previousOpensAList) listItems += 1;
      continue;
    }
    previousOpensAList = line.trim() === "";
  }
  return { paragraphs, listItems };
}

/**
 * Numeric literals as the author WROTE them (D1) — digits with optional
 * thousands separators and decimals, so `1,024` and `94.7` each come back as
 * one figure rather than three. Compared verbatim: a shrink that turns `1,024`
 * into `1024` has restated a figure, which is not its job either.
 *
 * The grouping comma must be FOLLOWED BY THREE DIGITS. A looser `[\d,]*`
 * swallows sentence punctuation — `"In 2015, we ran"` yielded the figure
 * `"2015,"`, which then "vanished" from any rewrite that moved the number away
 * from the comma, and vanished from every Chinese translation, where the comma
 * is `，` (review, Critical 1 — an invariant-6 defect as well as a false
 * positive).
 */
function numbersIn(text: string): string[] {
  return text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
}

/** Blank out the protected spans, so their digits are not read as figures. */
function stripSpans(text: string, spans: readonly ProtectedSpan[]): string {
  let out = text;
  // An empty `raw` would split on every character and turn one figure into
  // several phantom ones; `countOccurrences` guards the same case explicitly.
  for (const span of spans)
    if (span.raw !== "") out = out.split(span.raw).join(" ");
  return out;
}

function regexCheck(
  config: ValidatorConfig,
  thawed: string,
  mustMatch: boolean,
): Verdict {
  const pattern =
    typeof config.pattern === "string" ? config.pattern : undefined;
  if (!pattern)
    return { pass: false, reason: "regex validator: missing pattern" };
  if (pattern.length > MAX_REGEX_PATTERN) {
    return {
      pass: false,
      reason: `regex validator: pattern longer than ${MAX_REGEX_PATTERN} chars`,
    };
  }
  const flags =
    typeof config.flags === "string" && /^[imsu]*$/.test(config.flags)
      ? config.flags
      : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (error) {
    return {
      pass: false,
      reason: `regex validator: invalid pattern: ${(error as Error).message}`,
    };
  }
  const matched = re.test(thawed.slice(0, MAX_REGEX_INPUT));
  if (matched === mustMatch) return { pass: true };
  return {
    pass: false,
    reason: mustMatch
      ? `output does not match required /${pattern}/`
      : `output matches forbidden /${pattern}/`,
  };
}
