import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Result, ToolError } from "../../contracts/index.js";
import { ok, toolFail } from "../../contracts/index.js";
import type { Skill } from "../../contracts/skills.js";
import type { ToolExecutor } from "../../engine/tools.js";
import { truncateKeepingHead } from "../../text/truncate.js";

/**
 * `load_skill` — the body of one Writing Skill, and (E1, ADR 0046) one named
 * file from its `references/` directory, on demand.
 *
 * The reason the capability is a TOOL rather than prompt-stuffing: only each
 * skill's name and description sit in the system prompt, so the per-turn cost
 * of having N skills installed is N short lines, whatever their bodies weigh.
 *
 * It takes a NAME, never a path — the deliberate divergence from Pi, whose
 * prompt block carries a `<location>` the model then reads with its ordinary
 * file tool (ADR 0028 §D3). A path in the prompt is a path the model can feed
 * to `read_span`, which would turn a skills feature into a way to widen the
 * read surface (invariant 2).
 *
 * ## The second load step, and why it does not reopen §D3
 *
 * STRAT-1 measured a real third-party pack and found **634,842 chars across 127
 * reference files against 112,222 chars of `SKILL.md` bodies — 5.7× — with 18
 * of 19 bodies being routers**. A router with nothing to route to does not
 * fail: the model answers from the router's own preamble as though it had
 * loaded the depth, and neither the user nor the transcript can tell. That
 * silent summary is the failure this argument exists to remove.
 *
 * **The design finding is that §D3 was never in the way.** §D3 forbids a path
 * *in the always-on system prompt*; all three reference harnesses disclose a
 * body's neighbourhood at **load** time instead, and Codex's opaque `skill://`
 * orchestrator resources — reachable only through its own skill tools, with an
 * explicit *"do not treat `skill://` identifiers as filesystem paths"* — are a
 * bounded, name-addressed second step arrived at independently.
 *
 * So: a plain load returns the body **plus the manifest of reference NAMES**,
 * and a reference load takes one of those names back. **Manifest membership is
 * the gate** — checked before anything touches the disk — and the path is then
 * built by the harness from the skill's own directory. The model never supplies
 * a path and never receives one, which is why the §D3 assertion passes
 * unchanged rather than being relaxed to accommodate this.
 *
 * Claude Code's mechanism — disclosing the skill's base directory in the tool
 * result — was rejected for exactly this reason: a base directory in a result
 * is still a path the model can feed to `read_span`, so it widens the read
 * surface by a different door than the one §D3 closed. The manifest costs one
 * more round trip and closes it.
 *
 * **Only `references/`.** Not `scripts/`, `assets/` or `templates/`: those are
 * executable or binary, and invariant 2 says capability arrives as a named,
 * bounded tool, never as a file a skill smuggled in. A pack routing to six
 * scripts will not work under this design, and that is the correct outcome —
 * `skills/routes.ts` is what makes the refusal visible instead of silent.
 *
 * HEAD truncation, like `read_span` and unlike `run_script` (ADR 0029): a skill
 * states its rules first and elaborates after, so the beginning is the part
 * worth keeping. A reference is written the same way.
 */

export const SKILL_BODY_MAX_LINES = 400;
export const SKILL_BODY_MAX_TOKENS = 4_000;

/**
 * How many references one TASK may load.
 *
 * Reference bytes ride ADR 0029's ordinary tool-result regime, which bounds
 * each result — but nothing there bounds the number of results, and the
 * surveyed pack is a 634 KB tree. Without this cap a model could walk the whole
 * of it one call at a time and spend a task's budget on reading. Eight is well
 * past what any single piece of guidance needs and far short of a walk.
 */
export const MAX_REFERENCE_LOADS_PER_TASK = 8;

interface LoadSkillArgs {
  name: string;
  reference?: string;
}

/** Validate the args (ADR 0024: a bad shape is `invalid`, not a throw). */
function parseArgs(args: unknown): Result<LoadSkillArgs, ToolError> {
  const raw = args as { name?: unknown; reference?: unknown } | undefined;
  const name = raw?.name;
  if (typeof name !== "string" || name.length === 0) {
    return toolFail(
      "invalid",
      'load_skill: args must be { name: "<skill-name>" }, optionally with { reference: "<file>.md" }',
    );
  }
  const reference = raw?.reference;
  if (reference !== undefined && typeof reference !== "string") {
    return toolFail(
      "invalid",
      "load_skill: `reference` must be one of the names listed in this skill's `references`",
    );
  }
  return ok(reference === undefined ? { name } : { name, reference });
}

export const LOAD_SKILL_SPEC = {
  name: "load_skill" as const,
  description:
    "Read the full instructions of one Writing Skill by name. The system prompt lists every available skill's name and description; call this to get the body before drafting, when a skill's description matches what you are about to write. If the result lists `references`, those are further files of this skill's own guidance — call load_skill again with the same name plus one of those names to read it. A skill body that points at its references is telling you the detail is there and not in the body.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "The skill's name, exactly as listed in the available_skills block.",
      },
      reference: {
        type: "string",
        description:
          "Optional. One name from the `references` list this skill returned — a filename, never a path. Omit it to get the skill's body.",
      },
    },
    required: ["name"],
  } as Record<string, unknown>,
};

export function createLoadSkillTool(deps: { skills: Skill[] }): ToolExecutor {
  // Per TOOL INSTANCE, and `createLoadSkillTool` is constructed per task, so
  // this is the per-task counter without any plumbing to carry it.
  let referenceLoads = 0;

  return {
    name: "load_skill",
    category: "retrieval",
    // Reads a file but writes nothing and emits no item, so a batch may overlap
    // it with the other reads (ADR 0025). The per-task counter is the only
    // state, and it is claimed BEFORE the read for exactly that reason — see
    // `loadReference`.
    executionMode: "parallel",
    spec: LOAD_SKILL_SPEC,
    invoke: async (args) => {
      const parsed = parseArgs(args);
      if (!parsed.ok) return parsed;
      const { name, reference } = parsed.value;
      const skill = deps.skills.find((s) => s.name === name);
      if (!skill) {
        // Name what IS there: a `not_found` the model can act on beats one it
        // can only retry (the ADR 0024 guidance rule).
        const available = deps.skills.map((s) => s.name).join(", ");
        return toolFail(
          "not_found",
          `load_skill: no skill named "${name}". Available: ${available === "" ? "none" : available}.`,
        );
      }

      if (reference !== undefined) return loadReference(skill, reference);

      const cut = truncateKeepingHead(skill.body, {
        maxLines: SKILL_BODY_MAX_LINES,
        maxTokens: SKILL_BODY_MAX_TOKENS,
      });
      return ok({
        name: skill.name,
        source: skill.source,
        // `text` so the transcript row's char count populates — the key
        // `summarizeToolResult` actually reads (tool-summary.ts).
        text: cut.text,
        // Absent when empty, the same rule the truncation report below follows:
        // a skill with no references says nothing rather than saying `[]`.
        ...(skill.references.length > 0
          ? { references: skill.references }
          : {}),
        ...truncationKeys(cut),
      });
    },
  };

  /**
   * One reference, gated on manifest membership.
   *
   * **The order here is the security property.** Membership is checked against
   * `skill.references` — a list the HOST built by reading the directory —
   * BEFORE any path is constructed, so `../../../etc/passwd`, `/etc/passwd`,
   * `C:\Windows\win.ini` and `subdir/x.md` are all refused for the same
   * ordinary reason `nope.md` is: they are not in the list. There is no path
   * normalization to get right and no traversal check to forget, because the
   * untrusted string never becomes a path at all.
   */
  async function loadReference(
    skill: Skill,
    reference: string,
  ): Promise<Result<unknown, ToolError>> {
    if (!skill.references.includes(reference)) {
      const available = skill.references.join(", ");
      return toolFail(
        "not_found",
        `load_skill: "${skill.name}" has no reference named "${reference}". Available: ${available === "" ? "none" : available}.`,
      );
    }
    // **Claimed before the read, not after** (found by review). This tool is
    // `parallel`, so a batch can run several copies concurrently; checking the
    // counter before an `await` and incrementing after it lets every member of
    // a batch pass the gate at 7 and then read, overshooting the cap. Claiming
    // the slot first makes a race conservative rather than permissive, which is
    // what the cap is for. A failed read gives the slot back below.
    if (referenceLoads >= MAX_REFERENCE_LOADS_PER_TASK) {
      return toolFail(
        "invalid",
        `load_skill: this task has already loaded ${MAX_REFERENCE_LOADS_PER_TASK} references, which is the limit. Work from what you have read.`,
      );
    }
    referenceLoads++;

    let text: string;
    try {
      text = await readFile(
        join(dirname(skill.path), "references", reference),
        "utf8",
      );
    } catch {
      // Nothing was read, so nothing is charged.
      referenceLoads--;
      // Claimed by the manifest but unreadable now — deleted between the load
      // and this call, or a permission. A typed `not_found`, never a throw
      // (ADR 0024), and deliberately without the path: the model can act on
      // the name it already has.
      return toolFail(
        "not_found",
        `load_skill: "${skill.name}" lists "${reference}" but it could not be read — it may have been removed since the skill was loaded.`,
      );
    }

    const cut = truncateKeepingHead(text, {
      maxLines: SKILL_BODY_MAX_LINES,
      maxTokens: SKILL_BODY_MAX_TOKENS,
    });
    return ok({
      name: skill.name,
      source: skill.source,
      reference,
      text: cut.text,
      ...truncationKeys(cut),
    });
  }
}

/**
 * ADR 0029: the report is ABSENT when nothing was cut, so a body that fits
 * comes back byte-identical. Flat keys, not a nested object —
 * `summarizeToolResult` reads `result.truncated`, not `result.truncation`.
 */
function truncationKeys(
  cut: ReturnType<typeof truncateKeepingHead>,
): Record<string, unknown> {
  if (!cut.truncated) return {};
  return {
    truncated: true as const,
    truncated_by: cut.truncatedBy,
    total_lines: cut.totalLines,
    shown_lines: cut.shownLines,
    total_bytes: cut.totalBytes,
    ...(cut.partialLine ? { partial_line: true as const } : {}),
  };
}
