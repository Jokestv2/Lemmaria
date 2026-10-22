/**
 * Fitting the skill catalogue to a token budget (E1, ADR 0045) — pure, and
 * separated from `loader.ts` so the ladder is testable without a disk.
 *
 * **Why a budget replaces two fixed caps.** ADR 0028 shipped `MAX_SKILLS = 16`
 * and a 200-char description gate, and STRAT-1 measured that pair against a
 * real third-party pack: **3 of 19 directories loaded**. Neither cap was wrong
 * about the thing it was protecting — every loaded skill's name and description
 * sit in EVERY turn's system prompt — but two hard numbers cannot express *"as
 * many as fit"*, so they rejected instead of degrading. Codex's shape is one
 * budget with a degradation ladder, and it is the shape adopted here.
 *
 * **The ladder, in order, and the order is load-bearing:**
 *
 *   1. **Disabled skills are removed first** — done by the caller
 *      (`loadSkillSet`), before this function ever sees the set. That is what
 *      makes the user's toggle a real relief valve rather than cosmetic, and it
 *      is the coupling Codex's own over-budget warning states when it tells the
 *      user to disable unused skills to make room.
 *   2. **Fits at full description → nothing is touched.** Most users have four
 *      skills; the common case comes back with the SAME objects.
 *   3. **Over budget → truncate longest-first toward a 200-char floor**,
 *      stopping the moment it fits. Longest-first rather than uniform-ratio: it
 *      takes the most room from the descriptions carrying the most redundancy,
 *      and leaves a short, well-written description untouched instead of
 *      clipping it to pay for someone else's.
 *   4. **Still over → omit whole skills, lowest precedence first**
 *      (`bundled` → `venue` → `user` → `project`). This replaces ADR 0028 §D5's
 *      `localeCompare` tail drop, which the survey correctly called *"arbitrary
 *      from the user's point of view"*. §D5's actual guarantee — a user's own
 *      skills are never crowded out by the ones Lemmaria ships — is preserved
 *      and strengthened.
 *
 * **Every rung names itself in a diagnostic the Skills view shows**, and that
 * is what makes the truncation admissible at all. ADR 0028 §D4 refused
 * truncation, and its load-bearing word was *silently*: *"truncating silently
 * changes what the model was told about a skill while the author goes on
 * believing their sentence arrived"*. Its own stated remedy was *"a visible
 * drop is the only option that leaves the user able to act"* — applied here to
 * a visible **truncation** instead. §D4's reasoning survives intact; only its
 * remedy changes, and its remedy was rejecting 16 of 19 skills in a real pack.
 *
 * **The budget itself is Codex's, as of ADR 0048** — 2 % of the model's context
 * window in tokens, falling back to an 8,000-CHARACTER budget when there is no
 * window to take a percentage of. ADR 0045 originally diverged here and kept a
 * fixed 1,500 tokens, on the ground that a derived budget inherits
 * `contextWindowFor`'s known-unreliable estimate (the B2 entry in
 * `open-questions.md`). Operator direction reversed that at E1's gate-review
 * round; ADR 0048 records why the risk is acceptable and what absorbs it.
 * **Do not reintroduce a fixed number** without superseding 0048.
 */

import type { SessionLocale } from "../contracts/sessions.js";
import type { Skill, SkillSource } from "../contracts/skills.js";
import { estimateTokens } from "../text/truncate.js";
import { escapeXml } from "../text/xml.js";
import type { SkillDiagnostic } from "./loader.js";

/**
 * What the catalogue's **entries** may cost.
 *
 * Two units, because Codex has two: a **token** budget when the model's context
 * window is known, and a **character** budget when it is not. The unit is not
 * cosmetic — with no window there is no token figure worth deriving, so the
 * fallback stops estimating tokens and counts characters instead, and the whole
 * ladder costs entries in whichever unit it was handed.
 *
 * It bounds the **entries** and not the whole block, deliberately: the
 * surrounding instruction paragraph is fixed text Lemmaria wrote and is the
 * same whatever is installed, so budgeting it would be a constant subtracted
 * from a constant. What varies with what the user installed is the entry list.
 */
export type SkillCatalogueBudget = {
  unit: "tokens" | "chars";
  limit: number;
};

/** Codex's `SKILL_METADATA_CONTEXT_WINDOW_PERCENT`. */
export const SKILL_CATALOGUE_CONTEXT_WINDOW_PERCENT = 2;

/** Codex's `DEFAULT_SKILL_METADATA_CHAR_BUDGET`, for an unknown window. */
export const DEFAULT_SKILL_CATALOGUE_CHAR_BUDGET = 8_000;

/**
 * Codex's `default_skill_metadata_budget`, ported (ADR 0048).
 *
 * **The HOST supplies the window**, exactly as it supplies the source
 * directories: the harness must not decide which model is bound (invariant 1's
 * dependency direction), and a session with no model bound genuinely has no
 * window — which is the `undefined` branch, not a defaulted one.
 * `contextWindowFor` already publishes conservative FLOORS rather than
 * marketing maxima, so 2 % of what it returns is 2 % of a deliberate
 * under-estimate, which is most of what made B2's objection to a derived
 * budget bite.
 */
export function defaultSkillCatalogueBudget(
  contextWindowTokens?: number,
): SkillCatalogueBudget {
  if (
    contextWindowTokens !== undefined &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  ) {
    return {
      unit: "tokens",
      // `.max(1)` is Codex's, and it earns its place: a budget of 0 would omit
      // every skill and emit an omission diagnostic for each, which is a worse
      // answer than keeping one.
      limit: Math.max(
        1,
        Math.floor(
          (contextWindowTokens * SKILL_CATALOGUE_CONTEXT_WINDOW_PERCENT) / 100,
        ),
      ),
    };
  }
  return { unit: "chars", limit: DEFAULT_SKILL_CATALOGUE_CHAR_BUDGET };
}

/**
 * The floor truncation stops at. ADR 0028's old 200-char **gate** becomes the
 * new **floor**, which is the right reuse: 200 was never wrong as a target,
 * only as a rejection. Below this a description stops being able to say what
 * the skill is for, so the honest move is to omit the skill and say so rather
 * than keep a stub that cannot earn a load.
 */
export const MIN_SKILL_DESCRIPTION_CHARS = 200;

/**
 * How much of a description one truncation pass may take, as a fraction of its
 * current length — with `MIN_TRUNCATION_STEP_CHARS` as the floor on the step so
 * a nearly-fitting catalogue still converges instead of shaving one character
 * at a time.
 *
 * Stepping down rather than jumping straight to the floor is what implements
 * *"stopping the moment it fits"*: a jump would shave far more than the
 * catalogue needed, and rung 3's whole purpose is to charge as little as it can.
 */
const TRUNCATION_STEP_FRACTION = 8;
const MIN_TRUNCATION_STEP_CHARS = 16;

/**
 * One catalogue entry, exactly as `prompt.ts` renders it. **The single
 * definition of that line** — the budget costs this string and the prompt emits
 * it, so the two cannot drift.
 *
 * The escaping is `text/xml.ts`'s, shared with the renderer for the same
 * reason: measuring the RAW strings under-counted every `&`, `<` and `'` by up
 * to six characters each (found by review), and on a real pack that lands
 * within ~10 tokens of the budget that is the difference between fitting and
 * overrunning.
 */
export function renderCatalogueEntry(skill: {
  name: string;
  description: string;
}): string {
  return `  <skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description></skill>`;
}

/**
 * What one catalogue entry costs.
 *
 * Deliberately measured over the **rendered** entry, escaping and tags and all,
 * rather than over the bare description: a budget that ignored ~50 characters
 * of markup per entry would under-count by roughly a sixth on a 19-skill pack,
 * and one that ignored escaping can under-count without bound.
 *
 * `estimateTokens` is the existing helper the prompt block already uses. Do NOT
 * introduce a second estimator: two token estimates that disagree is a bug that
 * surfaces only under load, which is the worst time to find it.
 */
export function catalogueEntryCost(
  skill: { name: string; description: string },
  unit: SkillCatalogueBudget["unit"] = "tokens",
): number {
  const line = `${renderCatalogueEntry(skill)}\n`;
  // By code POINT under `chars`, matching `truncateToChars` below and Rust's
  // `chars().count()` — counting UTF-16 units would charge an emoji twice.
  return unit === "chars" ? [...line].length : estimateTokens(line);
}

/** Lowest first — the order omission walks from. Mirrors `loader.ts`. */
const PRECEDENCE: Record<SkillSource, number> = {
  bundled: 0,
  venue: 1,
  user: 2,
  project: 3,
};

export interface FitCatalogueOptions {
  budget: SkillCatalogueBudget;
  /** The language every diagnostic renders in — invariant 6 rule 2. */
  locale?: SessionLocale;
}

/** One skill's description as the ladder is currently proposing to render it. */
interface WorkingEntry {
  skill: Skill;
  name: string;
  description: string;
}

/**
 * Truncate by CODE POINT, not code unit, and mark the cut.
 *
 * A `String.prototype.slice` at a code-unit index leaves a lone surrogate half
 * when it lands mid-pair, which is neither valid text nor a character anyone
 * wrote. These packs' descriptions carry Chinese and emoji, so this is the
 * common case, not the exotic one.
 */
function truncateToChars(text: string, maxChars: number): string {
  const points = [...text];
  if (points.length <= maxChars) return text;
  // The ellipsis replaces a character rather than being added beyond the cap,
  // so a truncated description is never longer than the cap it was cut to.
  return `${points.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

const totalCost = (
  set: readonly WorkingEntry[],
  unit: SkillCatalogueBudget["unit"],
): number => set.reduce((n, entry) => n + catalogueEntryCost(entry, unit), 0);

/**
 * The longest description still ABOVE the floor, or `undefined` when every
 * description has reached it and rung 3 has nothing left to give.
 *
 * Recomputed each pass rather than sorted once: truncating the longest can make
 * a different one the longest, and a stale order would keep charging the same
 * skill past the point where it was the right one to charge. Ties go to the
 * earliest entry, so a pass is deterministic.
 */
function longestAboveFloor(set: WorkingEntry[]): WorkingEntry | undefined {
  let best: WorkingEntry | undefined;
  let bestLen = MIN_SKILL_DESCRIPTION_CHARS;
  for (const entry of set) {
    const len = [...entry.description].length;
    if (len > bestLen) {
      best = entry;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Fit a merged, already-disabled-filtered catalogue to `opts.budget`.
 *
 * Returns the skills the prompt may carry plus one diagnostic per rung that
 * fired. A catalogue that fits comes back with the SAME objects, so the common
 * case allocates nothing and cannot drift.
 */
export function fitCatalogue(
  skills: readonly Skill[],
  opts: FitCatalogueOptions,
): { kept: Skill[]; diagnostics: SkillDiagnostic[] } {
  const zh = opts.locale === "zh";
  const working: WorkingEntry[] = skills.map((skill) => ({
    skill,
    name: skill.name,
    description: skill.description,
  }));

  const { unit, limit } = opts.budget;
  if (totalCost(working, unit) <= limit) {
    return { kept: [...skills], diagnostics: [] };
  }

  const diagnostics: SkillDiagnostic[] = [];

  // --- Rung 3: truncate longest-first toward the floor. ---
  while (totalCost(working, unit) > limit) {
    const target = longestAboveFloor(working);
    if (target === undefined) break; // everything is at the floor
    const current = [...target.description].length;
    const step = Math.max(
      MIN_TRUNCATION_STEP_CHARS,
      Math.ceil(current / TRUNCATION_STEP_FRACTION),
    );
    target.description = truncateToChars(
      target.description,
      Math.max(MIN_SKILL_DESCRIPTION_CHARS, current - step),
    );
  }

  // NOTE: rung 3's diagnostics are emitted AFTER rung 4 (see below), so a
  // skill that was truncated and then omitted reports only the omission.
  const truncated = working.filter(
    (entry) => entry.description !== entry.skill.description,
  );

  const emitTruncations = (kept: ReadonlySet<Skill>): void => {
    for (const entry of truncated) {
      // Found by review: without this filter a skill could carry BOTH an info
      // note saying its description was shortened "so the whole catalogue
      // fits" AND a failure row saying it was not loaded — two contradictory
      // things about one skill.
      if (!kept.has(entry.skill)) continue;
      diagnostics.push({
        code: "description_truncated",
        message: zh
          ? `“${entry.skill.name}”的说明已截断，以便所有写作技能的目录放进每轮提示词的预算内；完整说明仍保存在文件中。`
          : `"${entry.skill.name}" had its description truncated so the whole skill catalogue fits the per-turn prompt budget; the full text is still in the file.`,
        path: entry.skill.path,
        source: entry.skill.source,
      });
    }
  };

  // --- Rung 4: omit whole skills, lowest precedence first. ---
  // Ranked highest-precedence-first so the TAIL is what gets dropped, exactly
  // as §D5 intended; within a source, by name, so the drop is deterministic.
  const ranked = [...working].sort(
    (a, b) =>
      PRECEDENCE[b.skill.source] - PRECEDENCE[a.skill.source] ||
      a.skill.name.localeCompare(b.skill.name),
  );
  const keptSkills = new Set<Skill>();
  const dropped: WorkingEntry[] = [];
  let spent = 0;
  for (const entry of ranked) {
    const cost = catalogueEntryCost(entry, unit);
    // A prefix, not a greedy fill — the same discipline `affordableExchanges`
    // uses: once one skill has been dropped, everything below it in precedence
    // goes too, so the user never sees the venue's skill survive while their
    // own was omitted because it happened to be a few tokens larger.
    if (dropped.length === 0 && spent + cost <= limit) {
      spent += cost;
      keptSkills.add(entry.skill);
    } else {
      dropped.push(entry);
    }
  }

  emitTruncations(keptSkills);

  for (const entry of dropped) {
    diagnostics.push({
      code: "over_budget",
      message: zh
        ? `已安装的写作技能超出了每轮提示词的目录预算，因此“${entry.skill.name}”未被加载。在“技能”视图中停用暂时不用的技能即可腾出空间。`
        : `the installed skills exceed the per-turn catalogue budget, so "${entry.skill.name}" was not loaded — disable the ones you are not using in the Skills view to make room.`,
      path: entry.skill.path,
      source: entry.skill.source,
    });
  }

  // Back in the caller's order, so the loaded set does not silently reorder
  // just because the budget fired.
  return {
    kept: working
      .filter((entry) => keptSkills.has(entry.skill))
      .map((entry) =>
        entry.description === entry.skill.description
          ? entry.skill
          : { ...entry.skill, description: entry.description },
      ),
    diagnostics,
  };
}
