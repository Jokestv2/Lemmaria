import { describe, expect, it } from "vitest";
import { ALL_TOOL_ERROR_CODES } from "../../src/contracts/results.js";
import {
  LITERATURE_MAX_RESULTS,
  LITERATURE_SESSION_BUDGET,
} from "../../src/engine/tools.js";
import { DEFAULT_TASK_BUDGET } from "../../src/session/budget.js";
import { buildSessionSystemPrompt } from "../../src/session/prompt.js";
import {
  MIN_SKILL_DESCRIPTION_CHARS,
  defaultSkillCatalogueBudget,
} from "../../src/skills/budget.js";
import { loadSkillSet } from "../../src/skills/loader.js";
import { estimateTokens } from "../../src/text/truncate.js";

describe("buildSessionSystemPrompt (the capability envelope, ADR 0015)", () => {
  it("names exactly the offered tools", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["get_outline", "read_span", "update_plan"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt).toContain("get_outline");
    expect(prompt).toContain("read_span");
    expect(prompt).not.toContain("grep_project");
  });

  it("documents spawn_subtask only when it is offered, and not as a read tool (A3)", () => {
    const withIt = buildSessionSystemPrompt({
      tools: ["read_span", "spawn_subtask"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(withIt).toContain("spawn_subtask");
    expect(withIt).toMatch(/read-only child|isolated/i);
    // it must NOT be listed among the read-only research tools
    expect(withIt).not.toMatch(/read-only tools to research[^.]*spawn_subtask/);

    const without = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(without).not.toContain("spawn_subtask");
  });

  describe("equipping a child with skills (R1, ADR 0059)", () => {
    const SKILL = { name: "ledger", description: "How to write a ledger." };
    /**
     * The prompt TAIL that carries the `spawn_subtask` paragraph — deliberately
     * not "the paragraph".
     *
     * `buildSessionSystemPrompt` ends with `lines.join(" ")`, and only the
     * `<available_skills>` block introduces a newline, so there is no delimiter
     * to cut a single paragraph on: with no skills this returns the whole
     * prompt, and with skills everything after the block. That is fine for what
     * these tests need — a byte comparison over a superset of the paragraph is
     * a STRONGER claim than one over the paragraph alone — but the helper is
     * named and documented for what it actually returns, because an assertion
     * whose subject is misdescribed is how a vacuous test survives review.
     */
    const tailWithSpawnSubtask = (prompt: string): string =>
      prompt.split("\n").find((line) => line.includes("spawn_subtask")) ?? "";
    const paragraphOf = tailWithSpawnSubtask;

    /** The one sentence R1 adds. Asserted whole, so a reword cannot pass. */
    const EQUIP_SENTENCE =
      "A child gets none of your Writing Skills unless you name them: add skills: [names from available_skills] to a child whose task a skill's description covers, and that child gets load_skill with exactly those skills — never paraphrase a skill into a goal, since the paraphrase loses rules the body keeps.";

    /** The pre-R1 bytes, captured from the skill-free call rather than typed. */
    const PRE_R1 = paragraphOf(
      buildSessionSystemPrompt({
        tools: ["read_span", "spawn_subtask"],
        budget: DEFAULT_TASK_BUDGET,
      }),
    );

    it("adds the skills sentence when the parent has skills AND load_skill", () => {
      const paragraph = paragraphOf(
        buildSessionSystemPrompt({
          tools: ["read_span", "spawn_subtask", "load_skill"],
          budget: DEFAULT_TASK_BUDGET,
          skills: [SKILL],
        }),
      );
      // The whole added sentence, not a keyword from it: `toContain("skills")`
      // alone would pass on any prompt that merely mentions skills anywhere,
      // and `not.toBe(PRE_R1)` would pass on any change at all. This is the
      // assertion that fails if the clause is dropped OR quietly reworded.
      expect(paragraph).toContain(EQUIP_SENTENCE);
      // …and it is ADDITIVE: the pre-R1 fan-out sentence is still there, whole.
      expect(paragraph).toContain(
        "Children cannot edit, run scripts, or spawn further children, and share your read grants.",
      );
    });

    it("is byte-identical to the pre-R1 paragraph with no skills", () => {
      expect(
        paragraphOf(
          buildSessionSystemPrompt({
            tools: ["read_span", "spawn_subtask", "load_skill"],
            budget: DEFAULT_TASK_BUDGET,
          }),
        ),
      ).toBe(PRE_R1);
    });

    it("is byte-identical when skills exist but load_skill was withheld", () => {
      // `prompt.ts`'s standing rule: the prompt never advertises what the
      // surface withheld. Skills the parent cannot load are skills it cannot
      // hand down either, so the sentence would be a lie.
      expect(
        paragraphOf(
          buildSessionSystemPrompt({
            tools: ["read_span", "spawn_subtask"],
            budget: DEFAULT_TASK_BUDGET,
            skills: [SKILL],
          }),
        ),
      ).toBe(PRE_R1);
    });
  });

  describe("Writing Skills (B7, ADR 0028)", () => {
    const withSkills = (
      skills: { name: string; description: string }[],
      tools: Parameters<typeof buildSessionSystemPrompt>[0]["tools"] = [
        "read_span",
        "load_skill",
      ],
    ) =>
      buildSessionSystemPrompt({
        tools,
        budget: DEFAULT_TASK_BUDGET,
        skills,
      });

    it("lists each skill's name and description in a delimited block", () => {
      const p = withSkills([
        { name: "tone", description: "How to keep the voice consistent." },
      ]);
      expect(p).toContain("<available_skills>");
      expect(p).toContain("<name>tone</name>");
      expect(p).toContain(
        "<description>How to keep the voice consistent.</description>",
      );
      expect(p).toContain("</available_skills>");
    });

    it("never puts a skill's path in the prompt", () => {
      // §D3 — the divergence from Pi, whose block carries a <location>.
      const p = withSkills([{ name: "tone", description: "d" }]);
      expect(p).not.toContain("SKILL.md");
      expect(p).not.toContain("<location>");
    });

    it("escapes XML in author-written names and descriptions", () => {
      const p = withSkills([
        { name: "tone", description: 'Use <em> & "quotes"' },
      ]);
      expect(p).toContain("Use &lt;em&gt; &amp; &quot;quotes&quot;");
      expect(p).not.toContain('<em> & "quotes"');
    });

    it("omits the block entirely when no skills are loaded", () => {
      const p = buildSessionSystemPrompt({
        tools: ["read_span"],
        budget: DEFAULT_TASK_BUDGET,
      });
      expect(p).not.toContain("available_skills");
    });

    it("omits the block when skills exist but load_skill is not offered", () => {
      // The block would otherwise advertise a capability the envelope does not
      // grant — the prompt is derived from the enforcing set, never ahead of it.
      const p = withSkills([{ name: "tone", description: "d" }], ["read_span"]);
      expect(p).not.toContain("available_skills");
    });

    it("keeps load_skill out of the read-tool roster", () => {
      // The precedent spawn_subtask set: it is not a way to research the PAPER,
      // so it gets its own block rather than a slot in that list.
      const p = withSkills([{ name: "tone", description: "d" }]);
      expect(p).toMatch(
        /read-only tools to research the user's paper: read_span\./,
      );
    });

    it("sets the block off as its own section, not a clause in the prose wall", () => {
      // B7 manual round, item 2: the prompt is one space-joined paragraph
      // (`lines.join(" ")`), so the skills instruction sat wedged between the
      // update_plan sentence and the spawn_subtask paragraph with nothing to
      // mark it. Pi emits its block as a newline-delimited section of its own
      // (`pi/packages/agent/src/harness/system-prompt.ts`); this matches that
      // shape, which is the "check the proven implementation first" rule.
      const p = withSkills([{ name: "tone", description: "d" }]);
      expect(p).toContain("\n\nWriting Skills are installed");
      expect(p).toContain("</available_skills>\n\n");
    });

    it("covers prose written in the REPLY, not only edits to a file", () => {
      // The defect this wording fixes. "call load_skill ... BEFORE drafting"
      // let a small-tier model read `Draft a paragraph ... Do not edit any
      // file — just show me the paragraph in your reply` as not-writing, so it
      // answered from get_outline + read_span and never loaded house-style.
      const p = withSkills([{ name: "tone", description: "d" }]);
      expect(p).toContain(
        "whether you are editing a file or writing the passage directly in your reply",
      );
      expect(p).toContain("you MUST call load_skill");
    });

    it("the rendered block stays inside the catalogue budget the loader fits to (E1)", () => {
      // The whole point of the tool: N skills cost N short lines, not N bodies.
      //
      // **This is the cross-check that keeps two modules honest.**
      // `budget.ts` costs a MODEL of the entry (`catalogueEntryCost`); this
      // costs the STRING `prompt.ts` actually emits. If the markup here ever
      // grows and the model does not follow, the budget silently under-counts
      // and this assertion is what says so. It is also why the input goes
      // through the real `loadSkillSet` rather than being hand-built: the
      // question is whether what the loader PRODUCES fits, not whether a
      // hand-picked set does.
      // The description carries the characters the block escapes, because a
      // fixture of plain `x`s cannot detect the failure this guards: the cost
      // model measured the RAW string, so every `'` cost 6 rendered characters
      // and 1 modelled (found by review).
      // Plain YAML scalar, so it parses: `<`, `>` and `'` are unremarkable
      // mid-scalar, and `&` is only special at the START of one.
      const escapable = "use <b>tags</b> & don't quote ".repeat(30);
      const project = Array.from({ length: 40 }, (_, i) => ({
        path: `p/skill-${i}/SKILL.md`,
        content: `---
name: skill-${i}
description: ${escapable}
---
body
`,
      }));
      // 2 % of a 75,000-token window is 1,500 tokens (ADR 0048) — the figure
      // this assertion was written against when the budget was a fixed one.
      const budget = defaultSkillCatalogueBudget(75_000);
      expect(budget).toEqual({ unit: "tokens", limit: 1_500 });
      const { skills } = loadSkillSet({
        project,
        contextWindowTokens: 75_000,
      });
      expect(skills.length).toBeGreaterThan(0);

      const p = withSkills(skills);
      // The ENTRIES, which is what the budget governs — not the block's
      // wrapper tags, which are fixed text Lemmaria wrote and are the same
      // whatever is installed. Measuring the wrapper too would let this
      // assertion go red on a legitimate skill set that the budget accepted
      // (second review round: the `<available_skills>\n` opener alone is ~5
      // estimated tokens).
      const open = "<available_skills>\n";
      const start = p.indexOf(open) + open.length;
      const entries = p.slice(start, p.indexOf("\n</available_skills>"));
      expect(estimateTokens(entries)).toBeLessThanOrEqual(budget.limit);
      // …and the entries really are the bulk of the block, so this is not a
      // weaker assertion dressed up as an equivalent one.
      expect(entries.length).toBeGreaterThan(1_000);
    });

    it("with no model bound, the block stays inside the CHARACTER budget (ADR 0048)", () => {
      // The other half of Codex's rule, and the state a fresh window is
      // actually in: nothing is bound yet, so there is no context window to
      // take 2 % of and the budget is 8,000 characters. Asserting tokens here
      // would test the wrong unit and pass for the wrong reason.
      const escapable = "use <b>tags</b> & don't quote ".repeat(30);
      const project = Array.from({ length: 40 }, (_, i) => ({
        path: `p/skill-${i}/SKILL.md`,
        content: `---\nname: skill-${i}\ndescription: ${escapable}\n---\nbody\n`,
      }));
      const budget = defaultSkillCatalogueBudget();
      expect(budget).toEqual({ unit: "chars", limit: 8_000 });

      const { skills } = loadSkillSet({ project });
      expect(skills.length).toBeGreaterThan(0);
      const p = withSkills(skills);
      const open = "<available_skills>\n";
      const start = p.indexOf(open) + open.length;
      const entries = p.slice(start, p.indexOf("\n</available_skills>"));
      expect([...entries].length).toBeLessThanOrEqual(budget.limit);
    });

    it("a catalogue that fits is rendered with every description intact (E1)", () => {
      // The complement of the assertion above, and the case most users are in:
      // the budget must not cost a small installation anything at all.
      const description = "y".repeat(MIN_SKILL_DESCRIPTION_CHARS);
      const project = Array.from({ length: 4 }, (_, i) => ({
        path: `p/skill-${i}/SKILL.md`,
        content: `---\nname: skill-${i}\ndescription: ${description}\n---\nbody\n`,
      }));
      const { skills, diagnostics } = loadSkillSet({ project });
      expect(diagnostics).toEqual([]);
      const p = withSkills(skills);
      expect(p).toContain(description);
    });
  });

  it("states the numeric budgets from the enforcing config", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["get_outline"],
      budget: { maxTurns: 7, maxToolCalls: 9, maxOutputTokens: 1234 },
    });
    expect(prompt).toContain("7");
    expect(prompt).toContain("9");
    expect(prompt).toContain("1234");
  });

  it("is honest about being read-only and points at the quick actions", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["get_outline"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt.toLowerCase()).toContain("cannot");
    expect(prompt).toContain("Polish");
  });

  /**
   * D4 / QA-1. This is the only place a rename of a quick action reaches the
   * MODEL, it lives in packages/harness so no packages/extension grep finds
   * it, and until D4 nothing covered it — so the composer would have told a
   * user to run an action that no longer exists. The live tier checks that the
   * string does its job (`packages/cli/test/live/quick-action-names`); this
   * pins the string itself.
   */
  it("names the quick actions by their CURRENT names, in display order", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["get_outline"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt).toContain(
      "(Proofread, Polish, Shrink By, Expand By, Translate)",
    );
    for (const retired of ["Shrink to Target", "Expand,", "Expand)"]) {
      expect(
        prompt,
        `retired action name still in the prompt: ${retired}`,
      ).not.toContain(retired);
    }
  });

  it("instructs the update_plan discipline only when the tool is offered", () => {
    const withPlan = buildSessionSystemPrompt({
      tools: ["update_plan"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(withPlan).toContain("update_plan");
    const withoutPlan = buildSessionSystemPrompt({
      tools: ["get_outline"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(withoutPlan).not.toContain("update_plan");
  });

  it("says so honestly when no tools are available", () => {
    const prompt = buildSessionSystemPrompt({
      tools: [],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt.toLowerCase()).toContain("no tools");
  });

  it("names ONE reply language, chosen by the caller — never both (ADR 0031)", () => {
    // Before ADR 0031 this line named both languages and left the model to
    // infer which one to use from the prompt it was reading — the B6 defect
    // (a half-Chinese prompt reliably produced Chinese output for an
    // English-display user). The locale is now a parameter, defaulting to
    // "en" so every caller that does not pass one keeps working.
    const en = buildSessionSystemPrompt({
      tools: [],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(en).toContain("Reply in English");
    expect(en).not.toMatch(/[一-鿿]/);

    const zh = buildSessionSystemPrompt(
      { tools: [], budget: DEFAULT_TASK_BUDGET },
      "zh",
    );
    expect(zh).toMatch(/[一-鿿]/);
    expect(zh).not.toContain("Reply in English");
  });

  it("review policy: write guidance replaces the read-only honesty (ADR 0016)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
    });
    expect(prompt).toContain("propose_edit");
    expect(prompt.toLowerCase()).toContain("verbatim");
    expect(prompt.toLowerCase()).toContain("one call");
    expect(prompt.toLowerCase()).toContain("pause");
    expect(prompt).not.toContain("cannot edit or write");
    // propose_edit is a write tool — it must not be listed as read-only.
    expect(prompt).not.toMatch(/read-only tools[^.]*propose_edit/);
  });

  it("names the protected-content rule AND its escape (ADR 0032, revised by ADR 0033)", () => {
    // The rule is enforced in validateProposedEdits; this line only saves a
    // round-trip. Naming the escape matters as much as naming the rule — a
    // model told only "no" reaches for a narrower anchor, which is refused
    // again.
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
      protectedSpans: true,
    });
    expect(prompt).toContain("protected content");
    expect(prompt).toMatch(/refused/);
    // ADR 0033 s1: the escape clause lives INSIDE the sentence, Codex-style,
    // and the escape itself is the declaration.
    expect(prompt).toMatch(/unless the user's request/);
    expect(prompt).toMatch(/removes_protected/);
    // Prompt text stays English whatever the reply language (prompt.ts's rule).
    const zh = buildSessionSystemPrompt(
      {
        tools: ["read_span", "propose_edit"],
        budget: DEFAULT_TASK_BUDGET,
        editPolicy: "review",
        protectedSpans: true,
      },
      "zh",
    );
    expect(zh).toContain("protected content");
  });

  it("states the container rule and the nesting rule (X3, ADR 0036)", () => {
    // The prompt named the kinds and said "reproduce them byte-for-byte" — it
    // never said a container's PROSE is free, which ADR 0033 §3 made true, nor
    // that what is nested inside one is protected in its own right, which
    // ADR 0036 makes true. A model that has to infer both from refusals pays
    // for the inference in round trips.
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
      protectedSpans: true,
    });
    expect(prompt).toMatch(/\\textbf\{/);
    expect(prompt).toMatch(/nested/i);
    // English only, whatever the reply language (invariant 6 rule 3).
    expect(prompt).not.toMatch(/[一-鿿]/);
  });

  it("says NOTHING about protected content when no reader is wired (D1)", () => {
    // The prompt must not advertise a constraint nothing enforces — the same
    // rule that keeps it from advertising a tool the surface withheld. A host
    // with no ProtectedSpanReader gets the pre-D1 write block, unchanged.
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
    });
    expect(prompt).not.toContain("protected content");
    expect(prompt).toContain("propose_edit");
  });

  it("auto_apply policy: states edits land immediately", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "auto_apply",
    });
    expect(prompt.toLowerCase()).toContain("immediately");
    expect(prompt).not.toContain("cannot edit or write");
  });

  // --- A1b manual-test findings: the two ways the write path misbehaved were
  // both prompt gaps, not engine gaps (Codex/Claude Code tool-prompt rules). ---

  it("tells the model to answer from its tools instead of asking what it can read", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["get_outline", "read_span", "propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
    });
    // "the equation in the document" must be looked up, not asked about.
    expect(prompt.toLowerCase()).toMatch(
      /do not ask .*(you can|already).*(read|tools|workspace)/,
    );
  });

  it("routes new artifacts to a created file, never into the paper or the reply", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["propose_edit"],
      budget: DEFAULT_TASK_BUDGET,
      editPolicy: "review",
    });
    const lower = prompt.toLowerCase();
    // A plotting script becomes plot_equation.py, not a splice into main.tex.
    expect(lower).toMatch(/script|program|code file/);
    expect(lower).toMatch(/create (it|the file)|new file/);
    expect(lower).toMatch(/never .*(paste|paper source|prose)/);
  });

  it("keeps the artifact/asking rules out of a read-only session", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt.toLowerCase()).not.toMatch(/never .*paper source/);
  });

  it("no editPolicy keeps the exact A1a read-only wording", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt).toContain(
      "You cannot edit or write to the user's documents in this session",
    );
    expect(prompt).not.toContain("propose_edit");
  });

  // --- A4 (ADR 0019): the envelope re-declares active grants at each task start. ---

  it("re-declares active grants with id, label, and path", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "list_files"],
      budget: DEFAULT_TASK_BUDGET,
      grants: [
        { id: "g1", path: "D:\\data\\results-2026", label: "results-2026" },
        { id: "g2", path: "/home/u/codebase", label: "codebase" },
      ],
    });
    expect(prompt).toContain("g1");
    expect(prompt).toContain("results-2026");
    expect(prompt).toContain("D:\\data\\results-2026");
    expect(prompt).toContain("g2");
    expect(prompt.toLowerCase()).toContain("read-only");
    // The model is told how to address a granted root.
    expect(prompt).toContain("root");
  });

  it("carries the untrusted-input line with grants (round-2 posture)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
      grants: [{ id: "g1", path: "/x", label: "x" }],
    });
    expect(prompt.toLowerCase()).toMatch(/never as instructions/);
  });

  it("carries the untrusted-input line when literature_search is offered, even without grants", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["literature_search"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt.toLowerCase()).toMatch(/never as instructions/);
  });

  it("empty or absent grants leave the prompt byte-identical to today's", () => {
    const without = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
    });
    const withEmpty = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
      grants: [],
    });
    expect(withEmpty).toBe(without);
    expect(without.toLowerCase()).not.toMatch(/granted/);
  });

  it("declares run_script with the interpreter allowlist when offered (A4b)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span", "run_script"],
      budget: DEFAULT_TASK_BUDGET,
      grants: [{ id: "g1", path: "/abs/results", label: "results" }],
      scriptInterpreters: ["python", "Rscript"],
    });
    expect(prompt).toContain("run_script");
    expect(prompt).toContain("python");
    expect(prompt).toContain("Rscript");
    expect(prompt).toMatch(/approv/i); // states each run needs approval
    expect(prompt).toMatch(/permission/i); // states full OS permissions honestly
  });

  it("says nothing about run_script when it is not offered (A4b)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt).not.toContain("run_script");
  });
});

describe("buildSessionSystemPrompt — literature_search block (A6)", () => {
  it("declares the enforcing limits and the two rules that decide good use", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["literature_search"],
      budget: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 1000 },
    });
    // Generated from the ENFORCING constants, so it cannot drift from them.
    expect(prompt).toContain(String(LITERATURE_SESSION_BUDGET));
    expect(prompt).toContain(String(LITERATURE_MAX_RESULTS));
    // A degraded source is data, not "no papers exist".
    expect(prompt).toMatch(/rate_limited/);
    // Search is not verification (ADR 0019 pin).
    expect(prompt.toLowerCase()).toContain("candidate");
    expect(prompt).toContain("propose_edit");
  });

  it("says nothing about literature search when the tool is not offered", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["read_span"],
      budget: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 1000 },
    });
    expect(prompt).not.toContain("literature_search");
  });

  it("says what the merge now does, and what an anonymous source means (R4)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["literature_search"],
      budget: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 1000 },
    });
    // The old sentence said results were "ranked by the sources", which was
    // true of each source's own list and false of the merged one.
    expect(prompt).toContain("merged by taking turns across every source");
    expect(prompt).toContain("each in its own rank order");
    expect(prompt).toContain("comes first");
    // A key would raise the limit — the one fact the record used to lack.
    expect(prompt).toContain("anonymous");
    expect(prompt).toContain("an API key");
    // …and the pin that made the block worth having is unchanged.
    expect(prompt).toContain("CANDIDATES");
  });

  it("says a source that did not answer was already retried (R8/O8)", () => {
    const prompt = buildSessionSystemPrompt({
      tools: ["literature_search"],
      budget: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 1000 },
    });
    // The block used to end "retry or narrow instead of concluding", which
    // now invites the model to re-issue a search the seam has already
    // retried on its behalf.
    expect(prompt).toContain("already retried with backoff inside the call");
    expect(prompt).toContain(
      "do not repeat the same search hoping for a different answer",
    );
    expect(prompt).not.toContain("retry or narrow");
    // The numbers this paragraph carries are R8's to leave alone.
    expect(prompt).toContain("up to 20 results per call (default 8)");
    expect(prompt).toContain("25 searches per session");
  });
});

describe("buildSessionSystemPrompt — tool-error codes (B2, closing a B0 question)", () => {
  const withTools = () =>
    buildSessionSystemPrompt({
      tools: ["read_span", "grep_project"],
      budget: DEFAULT_TASK_BUDGET,
    });

  /** Just the error-code block, so no assertion can pass on text elsewhere. */
  const errorBlock = (): string => {
    const match = withTools().match(
      /A failed tool call returns[\s\S]*?re-issue\./,
    );
    if (!match) throw new Error("the tool-error block is missing entirely");
    return match[0];
  };

  it("names every ToolErrorCode, so the model can branch on them too", () => {
    // ADR 0024 claimed the codes were branchable by "the harness, the UI and
    // the model"; until B2 the third had never been told what they mean. An
    // exhaustive assertion against the BLOCK — matching the whole prompt would
    // pass on a code that merely appears in some other sentence.
    const block = errorBlock();
    for (const code of ALL_TOOL_ERROR_CODES) {
      expect(block).toContain(code);
    }
    expect(block).toContain('{"error": {"code", "message"}}');
  });

  it("states `too_large`'s advice CONDITIONALLY (the second B0 question)", () => {
    // `too_large` covers both an oversized request and a spent per-session
    // budget, and "narrow the request" is wrong for the second — narrowing
    // does not refill it. No eighth code was minted; the advice is qualified.
    expect(errorBlock()).toMatch(/too_large[^;]*budget is spent/);
  });

  it("keeps the block to one line — the measured cost of closing the question", () => {
    // The open question asked for the token cost to be measured rather than
    // guessed. This is that measurement, pinned: a clause per code, ~90 words
    // (≈120 tokens), sent once per task rather than per tool spec.
    expect(errorBlock().length).toBeLessThan(720);
  });

  it("says nothing about tool errors in a session with no tools", () => {
    const prompt = buildSessionSystemPrompt({
      tools: [],
      budget: DEFAULT_TASK_BUDGET,
    });
    expect(prompt).not.toContain("A failed tool call returns");
  });
});
