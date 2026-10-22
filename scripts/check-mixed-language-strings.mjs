/**
 * Backstop for invariant 6, rule 2: no string Lemmaria writes may carry two
 * languages at once (ADR 0034).
 *
 * The defect this exists to catch is the `"english clause / 中文子句"` shape —
 * 21 of them accumulated between A1b and D1 because invariant 6's wording
 * ("Prompts/UI/counting all bilingual") never said *per reader*, and every
 * one of them shipped a Chinese sentence to readers who may not read Chinese.
 *
 * It matches the SEPARATOR, not merely the co-occurrence of scripts, because
 * co-occurrence is legitimate: a Chinese notice naming an English command
 * ("请新建会话（Lemmaria: New Session）后继续。") is one language plus a proper
 * noun, which is correct. What is never correct is an English clause and a
 * Chinese clause joined by " / " and handed to one reader.
 *
 * Comments are exempt — this file's own doc comment would trip it otherwise,
 * and a comment is read by whoever is editing the code, not by a user.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const GUARDED = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join("packages", d.name, "src"))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

const CJK = "一-鿿";

/**
 * (A) Mixed PROSE: an English clause (three whitespace-separated words) and a
 * Chinese clause (four consecutive han characters) in one literal.
 *
 * The three-word rule is what keeps a proper noun from tripping it: a Chinese
 * notice naming a command — "请新建会话（Lemmaria: New Session）后继续。" — has no
 * run of three ASCII words separated by whitespace alone, because the colon
 * breaks it. An actual English sentence always does.
 */
const EN_CLAUSE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
const ZH_CLAUSE = new RegExp(`[${CJK}]{4,}`);
/**
 * English PROSE carries a function word; an English proper-noun phrase inside
 * an otherwise-Chinese label does not. Without this, the correctly-localized
 * Chinese branch of `zh() ? "Semantic Scholar API key（可选…）" : "…"` reads as
 * three English words beside han text and is reported as a defect.
 */
const EN_FUNCTION_WORD =
  /\b(?:the|an?|is|are|was|were|be|to|of|in|on|for|and|or|not|no|it|this|that|these|with|from|by|at|as|has|have|had|can|could|will|would|your|you|its|any|all|so|but|if|when|while|than|then|there|here|into|out|up|down|only|every|each|because|before|after|again)\b/i;

/**
 * (B) The " / " join, for short pairs that (A) misses — `"… [truncated /
 * 已截断]"` has only one English word. Requires han text to START the right
 * side (after any opening punctuation), which is what distinguishes the
 * concatenation from a legitimate slash inside one language: "MiKTeX / TeX
 * Live" and "claude-haiku-4-5 / gpt-4o-mini" both continue in ASCII.
 */
const SPACED_JOIN = new RegExp(
  `[A-Za-z]{2,}[^\`"']*\\s/\\s*["'“”‘’(（\\[【\\s]*[${CJK}]`,
);

/**
 * Rule (B) as the scan applies it. Two joins shipped past `SPACED_JOIN`, one
 * per review round: X5's status bar read `today/今日`, with no space before the
 * slash, and X6's empty state named `“Lemmaria: Review Selection / AI 审稿”`,
 * whose Chinese side opens with the acronym it keeps in English. A survey of
 * the tree for the same shapes found a third, `model.ts`'s `"Lemmaria: API key
 * saved. / API 密钥已保存。"`, on every reader's screen since 2026-07-03.
 * Each shape gets its own pattern below; a literal is a join if any matches.
 */

/**
 * No space on either side: `today/今日`. Only that missing space tells it apart
 * from a path segment followed by Chinese — `.lemmaria/skills/ 下的写作技能` —
 * so the English word must also start a token of its own: one that follows a
 * `/`, a `.`, a `\` or a word character is a path segment, and never starts
 * this join even when the writer leaves the space out (`skills/下`).
 * A literal path whose FIRST segment is ASCII (`docs/中文说明.md`) still reads
 * as this join. Interpolate it instead — a path a reader sees is normally a
 * `${…}`, which is blanked above — rather than narrowing the pattern.
 */
const UNSPACED_JOIN = new RegExp(
  `(?<![\\w./\\\\])[A-Za-z]{2,}/["'“”‘’(（\\[【]*[${CJK}]`,
);

/**
 * Spaced, with the Chinese side opening on the acronym it keeps in English:
 * `Review Selection / AI 审稿`, `API key saved. / API 密钥已保存。`. The acronym
 * is what separates this from `claude-haiku-4-5 / gpt-4o-mini 级别`: a word in
 * capitals alone belongs to the Chinese phrase after it, while a lowercase
 * identifier is one item of an ASCII list. Mixed case is not an acronym, so
 * `TeX` fails the test — a product name like `TeX` or `LaTeX` is a proper noun
 * Chinese text keeps, and "MiKTeX / TeX 发行版" would otherwise have to be
 * reworded although nothing in it is a second language.
 * Two names inside Chinese prose whose second is an acronym ("LaTeX / PDF 文件")
 * cannot be told from the defect by shape. Write 或 or 、 there instead, which
 * is the idiomatic Chinese anyway, rather than narrowing the pattern.
 */
const ACRONYM_JOIN = new RegExp(
  `[A-Za-z]{2,}[^\`"']*\\s/\\s*["'“”‘’(（\\[【\\s]*[A-Z]{2,}\\s*[${CJK}]`,
);

const mixedJoin = (lit) =>
  SPACED_JOIN.test(lit) || UNSPACED_JOIN.test(lit) || ACRONYM_JOIN.test(lit);

/**
 * A `${…}` interpolation's SOURCE is code, not text a reader sees — the
 * identifiers inside it ("error as Error") would otherwise read as an English
 * clause and flag a wholly-Chinese message. Blank them before testing.
 */
const withoutInterpolations = (lit) => lit.replace(/\$\{[^}]*\}/g, "\0");

const isMixed = (raw) => {
  const lit = withoutInterpolations(raw);
  const mixedProse =
    EN_CLAUSE.test(lit) && EN_FUNCTION_WORD.test(lit) && ZH_CLAUSE.test(lit);
  return mixedProse || mixedJoin(lit);
};

/**
 * The rule's own cases, checked on every run before the tree is scanned. Each
 * MUST_FLAG entry is a string that shipped; each MUST_PASS entry is a literal
 * the guarded tree holds, correctly. A rule edited too narrow fails here by
 * naming the defect it lets back in, and one edited too wide by naming the
 * correct string it would force someone to reword — so neither ships silently.
 */
const MUST_FLAG = [
  "… [truncated / 已截断]",
  "$(graph) 12 tok · 12 tok today/今日",
  "可对全文运行盲审小组；也可在 .tex 或 .md 文件中选中文本，运行“Lemmaria: Review Selection / AI 审稿”。",
  "Lemmaria: API key saved. / API 密钥已保存。",
];
const MUST_PASS = [
  "请新建会话（Lemmaria: New Session）后继续。",
  "请安装 TeX 发行版（MiKTeX / TeX Live），或改用 tectonic。",
  "当前前沿模型家族的小尺寸档位（claude-haiku-4-5 / gpt-4o-mini 级别）或更强",
  "在线 · C2 · CROSSREF / DBLP / S2",
  "的规则请写成 .lemmaria/skills/ 下的写作技能（Writing Skill），",
  "Lemmaria：还没有技能。在 .lemmaria/skills/<名称>/SKILL.md 中创建一个。",
  "https://tectonic-typesetting.github.io/install.html 安装以获得免配置编译，",
  "本次会话的输入/输出 token 与累计成本",
];
const wrongCases = [
  ...MUST_FLAG.filter((s) => !isMixed(s)).map((s) => `missed:  ${s}`),
  ...MUST_PASS.filter((s) => isMixed(s)).map((s) => `flagged: ${s}`),
];
if (wrongCases.length > 0) {
  console.error("check-mixed-language-strings: the rule fails its own cases:");
  for (const c of wrongCases) console.error(`  ${c}`);
  process.exit(1);
}
/**
 * The same defect built by interpolation rather than by literal text:
 * `` `${en} / ${zh}` `` (D1's refusal note) carries no CJK in its own source,
 * so the literal pattern above cannot see it. Match the join instead.
 */
const MIXED_INTERPOLATED =
  /\$\{\s*(?:en|zh|cn)\w*\s*\}\s*\/\s*\$\{\s*(?:en|zh|cn)\w*\s*\}/i;

/**
 * **There is no allowlist, and that is D4's deliverable.**
 *
 * This guard shipped with X2 carrying a `D4_PENDING` set of 17 files (later 16,
 * after D2 moved the webview's string table to `webview/parts/strings.ts`) —
 * the pre-existing `EN / 中文` chrome that predates U6's `i18n.ts` seam. X2
 * fixed the session path, where the reported defect was and where the locale
 * was already threaded, and enumerated the rest as D4's recorded scope rather
 * than absorbing another milestone's work.
 *
 * **D4 emptied it (2026-08-18) and then deleted it**, which is why the guard now
 * reads exactly like `check-webview-innerhtml.mjs`: deny-by-default over every
 * `packages/*\/src`, with no exceptions at all. The five harness entries were
 * cleared by threading a `SessionLocale` from each extension call site inward;
 * the eleven extension entries by moving 50 strings into
 * `packages/extension/src/chrome-strings.ts`, a locale-keyed table whose two
 * halves `packages/extension/test/chrome-strings.test.ts` asserts by VALUE —
 * the same source-plus-value pairing D2 established for the webview table.
 *
 * **Do not reintroduce a list.** A new mixed string is now a failure, which is
 * the whole point; the fix is to add a key, not an exemption.
 */

/** Strip line and block comments so prose ABOUT the rule cannot trip it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Rough string-literal extraction: good enough, and errs toward reporting. */
function* literals(src) {
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of src.matchAll(re)) {
    yield m[1] ?? m[2] ?? m[3] ?? "";
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) {
      yield p;
    }
  }
}

const failures = [];
for (const root of GUARDED) {
  for (const file of walk(root)) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hits = [...literals(src)].filter(isMixed);
    if (MIXED_INTERPOLATED.test(src)) hits.push("${en} / ${zh}");
    if (hits.length === 0) continue;
    for (const lit of hits) failures.push({ file, lit: lit.slice(0, 90) });
  }
}

if (failures.length > 0) {
  console.error(
    "Two languages in one string (invariant 6 rule 2, ADR 0034).\n" +
      "Render ONE language, chosen by the reader's SessionLocale:",
  );
  for (const f of failures) console.error(`  ${f.file}\n    ${f.lit}`);
  process.exit(1);
}
console.log("check-mixed-language-strings: OK (no allowlist)");
