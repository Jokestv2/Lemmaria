/**
 * Writing Skills (ADR 0028) — expertise the agent reads, as declarative prose.
 *
 * A Skill is data, never code and never a capability: it names no tool, is
 * never executed, and grants nothing (invariant 4). It is orthogonal to an
 * Action — an Action is deterministic L0/L1 machinery with validators, a Skill
 * is guidance the model reads mid-task.
 *
 * Only `name` + `description` reach the system prompt; `body` and any
 * `references` entry arrive only through the `load_skill` tool — including when
 * the user invokes one explicitly with `/skill:<name>`, which E1 (ADR 0047)
 * made a real `load_skill` exchange rather than a second mechanism beside it.
 * That split is the whole design: the per-turn cost of having N skills
 * installed is N short lines, whatever their bodies weigh — and it is why the
 * capability is a tool (invariant 2) rather than prompt-stuffing.
 */

/**
 * Where a skill came from. On a name collision the higher precedence wins:
 * `project` > `user` > `venue` > `bundled`, so a paper's own rules always beat
 * the ones the user installed globally, those beat the venue's, and the venue's
 * always beat Lemmaria's.
 *
 * `user` is `~/.lemmaria/skills` (E1, ADR 0045), mirroring the action loader's
 * `built-in < user < project`. All three reference harnesses have a user-level
 * source; it is where a third-party Agent Skills pack gets dropped.
 */
export type SkillSource = "bundled" | "venue" | "user" | "project";

export interface Skill {
  /**
   * Slug identity — `^[a-z0-9]+(-[a-z0-9]+)*$`, at most
   * `MAX_SKILL_NAME_CHARS`. This is the `load_skill` argument and the
   * `/skill:<name>` suffix, so it is user-typed as well as model-typed.
   */
  name: string;
  /**
   * The one line the model sees in every prompt — how it decides whether to
   * reach for this skill at all.
   *
   * Rejected outright over `MAX_SKILL_DESCRIPTION_CHARS` (1,024, the Agent
   * Skills standard's number). BELOW that it may still arrive **truncated**,
   * because every loaded skill's description sits in every turn and the
   * catalogue as a whole is fitted to a budget derived from the bound model's
   * context window — see `skills/budget.ts` and ADR 0048. A truncation always
   * names itself in a
   * `description_truncated` diagnostic; that visibility is what makes it
   * admissible where ADR 0028 §D4 refused a silent one (ADR 0045).
   */
  description: string;
  /** The guidance itself. Never in the system prompt. */
  body: string;
  source: SkillSource;
  /**
   * Where it was read from — for the UI's provenance row and for diagnostics.
   * Deliberately NEVER given to the model (ADR 0028 §D3, the divergence from
   * Pi, whose prompt block carries a `<location>` the model then reads): a path
   * in the prompt is a path the model can feed to `read_span`, which would turn
   * a skills feature into a way to widen the read surface.
   */
  path: string;
  /**
   * The `.md` files under this skill's `references/` directory, as **NAMES,
   * never paths** — `["taxonomy.md"]`, not `["/home/…/references/taxonomy.md"]`
   * (E1, ADR 0046).
   *
   * This list reaches a tool result, which is exactly why it is names: the
   * model asks for one back by name with `load_skill { name, reference }`, the
   * harness checks membership of THIS list and only then resolves the file
   * against the skill's own directory. So depth becomes reachable without a
   * path ever crossing the model boundary, and ADR 0028 §D3 stands untouched —
   * §D3 forbids a path in the always-on prompt, and all three reference
   * harnesses disclose a body's neighbourhood at LOAD time instead.
   *
   * Always present; `[]` when the skill has no `references/`. An optional array
   * would be two shapes to handle at every reader.
   */
  references: string[];
}

/** What the system prompt is allowed to carry — the body is not in it. */
export type SkillSummary = Pick<Skill, "name" | "description">;

/**
 * One entry in the user's disabled-skill list (E1, ADR 0045) — Codex's
 * `SkillConfig` shape, and user-side rather than author-side.
 *
 * ADR 0028 §D10 deferred this when every skill was one Lemmaria authored or the
 * user wrote themselves, so an author-side flag and a user-side toggle were the
 * same person. With third-party packs they are not, and the person who needs
 * the switch is the **user**. Pi's author-side `disable-model-invocation`
 * frontmatter key is deliberately NOT parsed: two switches for one property is
 * worse than either.
 *
 * A **name** selector disables a skill wherever it resolves from; a **path**
 * selector disables one specific copy, which is what lets a user keep their own
 * `tone` while silencing the venue's. The extension persists the selection —
 * it is the layer that knows where the user's home and workspace are — and the
 * harness merely takes it as an option (invariant 1, the `engine/memory.ts`
 * convention).
 */
export type SkillSelector = { name: string } | { path: string };
