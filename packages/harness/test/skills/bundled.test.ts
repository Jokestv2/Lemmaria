import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_ONLY_CHILD_TOOLS } from "../../src/session/subtasks.js";
import { bundledSkillsDir } from "../../src/skills/bundled.js";
import { listSkills } from "../../src/skills/library.js";
import { bundledVenuesDir } from "../../src/venue/bundled.js";

/**
 * Pins the shipped curated skill set, the analogue of `venue/bundled.test.ts`
 * (ADR 0028). These files reach every user, so a malformed one is a build bug —
 * the load path itself is forgiving, which is exactly why the shipped set needs
 * a test rather than trusting the diagnostics a user would have to notice.
 */
describe("the bundled skill set", () => {
  it("ships exactly the curated set", async () => {
    expect((await readdir(bundledSkillsDir())).sort()).toEqual([
      "blind-reviewer",
      // V1 (ADR 0076): the panel verifier's protocol.
      "concern-verifier",
      "experiments-from-results",
      "methods-from-code",
      // V4 (ADR 0081): the PDF reviewer's addendum to blind-reviewer.
      "pdf-reviewer",
      "related-work",
    ]);
  });

  it("every bundled skill loads clean, in both locales", async () => {
    for (const locale of ["en", "zh"] as const) {
      const { skills, diagnostics } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      expect(diagnostics).toEqual([]);
      // V1: five, with `concern-verifier`; V4: six, with `pdf-reviewer`.
      expect(skills).toHaveLength(6);
      expect(skills.every((s) => s.source === "bundled")).toBe(true);
      expect(skills.every((s) => s.body.length > 0)).toBe(true);
    }
  });

  it("a bundled skill's name matches its directory", async () => {
    const { skills } = await listSkills({ bundledDir: bundledSkillsDir() });
    for (const s of skills) {
      expect(s.path.replace(/\\/g, "/")).toContain(`/${s.name}/SKILL`);
    }
  });

  it("each locale's file is wholly in its own language (invariant 6)", async () => {
    // The B6 lesson (ADR 0031): one language per rendered surface. A skill body
    // is model-facing text, so a half-Chinese one is the same defect the
    // branch-summary prompt was.
    const han = /[一-鿿]/;
    const en = await listSkills({
      bundledDir: bundledSkillsDir(),
      locale: "en",
    });
    const zh = await listSkills({
      bundledDir: bundledSkillsDir(),
      locale: "zh",
    });
    for (const s of en.skills) {
      expect(`${s.name}:${han.test(s.description)}`).toBe(`${s.name}:false`);
      expect(`${s.name}:${han.test(s.body)}`).toBe(`${s.name}:false`);
    }
    for (const s of zh.skills) {
      expect(`${s.name}:${han.test(s.description)}`).toBe(`${s.name}:true`);
      expect(`${s.name}:${han.test(s.body)}`).toBe(`${s.name}:true`);
    }
  });

  it("no bundled skill body names a tool (invariant 4)", async () => {
    // A skill is guidance the model reads, never a capability. A body that
    // names a tool is teaching the model a capability surface the envelope
    // prompt owns — and would go stale the moment that surface changes.
    //
    // V4 (ADR 0081 §9): WIDENED — every bundled skill, in BOTH locales,
    // against every read-only child tool as well as the original six, so the
    // PDF addendum cannot name the one tool it is most tempted to. Widening a
    // deny-by-default guard is always allowed (ADR 0076 §1).
    const tools = new Set<string>([
      "propose_edit",
      "run_script",
      "read_span",
      "load_skill",
      "spawn_subtask",
      "literature_search",
      ...READ_ONLY_CHILD_TOOLS,
    ]);
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      for (const s of skills) {
        for (const tool of tools) {
          expect(
            `${locale} ${s.name} names ${tool}: ${s.body.includes(tool)}`,
          ).toBe(`${locale} ${s.name} names ${tool}: false`);
        }
      }
    }
  });

  it("pdf-reviewer teaches the page, in both locales (V4, ADR 0081 §3, D10)", async () => {
    // One marker per rule the seat's recall rests on — S6 measured that page
    // at a time is what finds a stranded hole, and that a caption written
    // from the conclusion tends to be believed.
    const markers = {
      en: [
        "You were also given the blind-reviewer protocol",
        "One page at a time",
        "write down what you saw",
        "Do not read numbers off a plot",
        "Anchor where the fix is",
        '{"page": N}',
        "must carry a page",
      ],
      zh: [
        "盲审评审人规程",
        "一次只看一页",
        "记下你看到了什么",
        "不要从图上读数",
        "锚定在需要修改的地方",
        '{"page": N}',
        "必须带有页码",
      ],
    } as const;
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      // Whitespace-normalised, as blind-reviewer's pins are: the files are
      // hard-wrapped prose, and a pin must not fix the wrap column.
      const body = (
        skills.find((s) => s.name === "pdf-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      for (const marker of markers[locale]) {
        expect(`${locale} teaches ${marker}: ${body.includes(marker)}`).toBe(
          `${locale} teaches ${marker}: true`,
        );
      }
    }
  });

  it("pdf-reviewer keeps its notes where its next turn can read them, and cites the page it saw (J1's round, ADR 0082 §3, O35)", async () => {
    // J1's seat wrote no visible text in any turn: its page notes, if any,
    // were reasoning the wire does not carry, and each page's image went at
    // the next view — so its ledger reconstructed pages from the source, and
    // three of seven were wrong.
    const markers = {
      en: [
        "in the text of your reply",
        // True on every wire and still an instruction: the Anthropic wire
        // echoes signed thinking within a tool loop, the OpenAI-compatible
        // one carries none (code review). "May not" read as permission.
        "you cannot count on your reasoning carrying over",
        "a page you did not write down is a page you can no longer cite",
        "the page where you saw it",
        "never the page the source says",
      ],
      zh: [
        "回复的正文里",
        "不能指望自己的推理会带到下一轮",
        "没有写下来的页面，你就再也无法引用",
        "你看到问题的那一页",
        "绝不是源文件",
      ],
    } as const;
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = (
        skills.find((s) => s.name === "pdf-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      for (const marker of markers[locale]) {
        expect(`${locale} teaches ${marker}: ${body.includes(marker)}`).toBe(
          `${locale} teaches ${marker}: true`,
        );
      }
    }
  });

  it("pdf-reviewer leaves the argument to the text reviewers, and says how to tell (the operator's option B, ADR 0082 §5, O35)", async () => {
    // J1's PDF-only run filed 7 of its 13 concerns about the argument, all of
    // them points the panel's text reviewers also raised, unchecked. The test
    // for what stays the seat's: a page that shows the problem itself, or a
    // measured fact — which keeps a caption contradicting its figure in. It
    // governs the dimensions OTHER than presentation, and says it narrows no
    // page defect: set among rule 1's page defects, it read as a bar for
    // every concern, and the defective twin lost its margin and table.
    const markers = {
      en: [
        "Nor is the argument yours",
        "Under any dimension other than `presentation`",
        "a text review's job, done from the source",
        "name the page on which the problem itself is visible",
        "not merely the page that prints a sentence you doubt",
        "or the measured fact the concern is about",
        "If you can name neither, it is not yours",
        "None of this narrows rule 1: file every page defect you see",
      ],
      zh: [
        "论证本身也不归你管",
        "在 `presentation` 以外的任何维度下",
        "文字评审依据源文件要做的事",
        "问题本身在哪一页上可见",
        "不是仅仅印着你所怀疑的那句话的那一页",
        "这条意见针对的是哪项测量结果",
        "两者都说不出来，就不归你管",
        "这些都不会缩小第 1 条的范围：你看到的每一处页面缺陷都要提出",
      ],
    } as const;
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = (
        skills.find((s) => s.name === "pdf-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      for (const marker of markers[locale]) {
        expect(`${locale} teaches ${marker}: ${body.includes(marker)}`).toBe(
          `${locale} teaches ${marker}: true`,
        );
      }
    }
  });

  it("pdf-reviewer takes the smallest text as a lead, and leaves the review option's furniture alone (round 2, ADR 0083 §3)", async () => {
    // J1's round 2: no run filed Figure 1's 3.4 pt inset labels, the smallest
    // text the facts block measured on page 2, while the default-budget run
    // spent its concerns on `acmart`'s review-mode line numbers and the
    // template's placeholder DOI and ISBN.
    const markers = {
      en: [
        "the pages where it is smallest are leads",
        "find what is set that small",
        "what a document class prints on purpose for review",
        "line numbers in the margin",
        "placeholder DOI and ISBN",
      ],
      zh: [
        "字号最小的那几页是线索",
        "找出排得那么小的是什么",
        "文档类为评审有意印出的内容",
        "页边的行号",
        "占位的 DOI 和 ISBN",
      ],
    } as const;
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = (
        skills.find((s) => s.name === "pdf-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      for (const marker of markers[locale]) {
        expect(`${locale} teaches ${marker}: ${body.includes(marker)}`).toBe(
          `${locale} teaches ${marker}: true`,
        );
      }
    }
  });

  it("concern-verifier starts every concern standing, in both locales (V1, ADR 0076)", async () => {
    // One stable marker phrase per locale — rule 1, the deny-by-default
    // direction the whole verifier rests on — so a locale that silently loses
    // it fails here rather than in a live run.
    for (const [locale, marker] of [
      ["en", "Start from the concern standing"],
      ["zh", "先假定意见成立"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body =
        skills.find((s) => s.name === "concern-verifier")?.body ?? "";
      expect(`${locale}: ${body.includes(marker)}`).toBe(`${locale}: true`);
    }
  });

  it("concern-verifier names none of the read-only child tools (V1, invariant 4)", async () => {
    // The verifier is handed read tools by the driver; its protocol teaches
    // how to test a concern, never which tool to call. Wider than the pin
    // above on purpose: every tool a read-only child could hold.
    for (const locale of ["en", "zh"] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body =
        skills.find((s) => s.name === "concern-verifier")?.body ?? "";
      expect(body.length).toBeGreaterThan(0);
      for (const tool of READ_ONLY_CHILD_TOOLS) {
        expect(`${locale} names ${tool}: ${body.includes(tool)}`).toBe(
          `${locale} names ${tool}: false`,
        );
      }
    }
  });

  it("blind-reviewer teaches grounding, in both locales (R4, ADR 0067)", async () => {
    // R4's Grounding block is what makes a reviewer's searches deliberate
    // rather than incidental. One stable marker phrase per locale, so a locale
    // that silently loses the block fails here rather than in a live run. The
    // block names no tool — the pin above still covers that.
    for (const [locale, marker] of [
      ["en", "Three searches, three specificities"],
      ["zh", "三次检索，三种粒度"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = skills.find((s) => s.name === "blind-reviewer")?.body ?? "";
      expect(`${locale}: ${body.includes(marker)}`).toBe(`${locale}: true`);
    }
  });

  it("blind-reviewer addresses a REVIEWER, not a seat (R9, ADR 0069)", async () => {
    // R9 made the panel N standalone reviewers, so the protocol's own second
    // person had to move with it: a model told it is "one seat" of a panel
    // whose brief never mentions a seat is being handed two vocabularies for
    // one role. The rules did not change — only the word for who follows them.
    //
    // Asserted on the LOADED body, in both locales, because the loader is what
    // picks `SKILL.zh.md`, and a zh file left saying 席位 would be invisible to
    // an English-only grep.
    for (const [locale, reviewer, grounding] of [
      ["en", "reviewer", "for every reviewer"],
      ["zh", "评审人", "面向每一位评审人"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = skills.find((s) => s.name === "blind-reviewer")?.body ?? "";
      expect(`${locale} says reviewer: ${body.includes(reviewer)}`).toBe(
        `${locale} says reviewer: true`,
      );
      // The Grounding block is every reviewer's now, not one lens's.
      expect(`${locale} grounding: ${body.includes(grounding)}`).toBe(
        `${locale} grounding: true`,
      );
      // And the seat vocabulary is gone from the reader-facing body.
      for (const stale of locale === "en" ? ["seat"] : ["席位"]) {
        expect(`${locale} still says ${stale}: ${body.includes(stale)}`).toBe(
          `${locale} still says ${stale}: false`,
        );
      }
    }
  });

  it("blind-reviewer does not let an outage become a concern (X5, ADR 0074 §9)", async () => {
    // The reversal. R4's fourth Grounding bullet told a reviewer to name an
    // unanswered source INSIDE the concern; the operator's round then got
    // entries whose whole content was a literature outage, offered to the
    // author to *Resolve* — a problem the author cannot fix, filed against
    // their paper. The harness already records which sources failed and
    // already tells the author, so the bullet was asking for a duplicate in
    // the one place it does harm.
    //
    // Pinned in both locales as PRESENCE and ABSENCE: a locale that kept the
    // old sentence would leave that locale's reviewers filing outages, and an
    // English-only grep would never see it in `SKILL.zh.md`.
    for (const [locale, now, gone] of [
      ["en", "is not a concern", "Name what did not answer"],
      ["zh", "不构成一条意见", "把没有应答的来源写进意见里"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = (
        skills.find((s) => s.name === "blind-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      expect(`${locale} teaches it: ${body.includes(now)}`).toBe(
        `${locale} teaches it: true`,
      );
      expect(`${locale} still asks for it: ${body.includes(gone)}`).toBe(
        `${locale} still asks for it: false`,
      );
    }
  });

  it("blind-reviewer keeps FOUR grounding bullets, so its own count stays true", async () => {
    // The block opens by saying "These four" / "下面四条". Reversing a bullet
    // in place keeps that sentence honest; deleting one, or adding a fifth,
    // would leave the skill mis-describing itself to the model reading it —
    // and a protocol that is wrong about its own shape is a protocol a
    // reviewer has a reason to doubt.
    for (const [locale, heading] of [
      ["en", "### Grounding"],
      ["zh", "### 文献支撑"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      const body = skills.find((s) => s.name === "blind-reviewer")?.body ?? "";
      const start = body.indexOf(heading);
      expect(`${locale} has the block: ${start >= 0}`).toBe(
        `${locale} has the block: true`,
      );
      // To the next heading, so the numbered rules that follow are excluded.
      const rest = body.slice(start + heading.length);
      const end = rest.indexOf("\n#");
      const block = end >= 0 ? rest.slice(0, end) : rest;
      const bullets = block
        .split("\n")
        .filter((line) => line.startsWith("- **")).length;
      expect(`${locale} bullets: ${bullets}`).toBe(`${locale} bullets: 4`);
    }
  });

  it("blind-reviewer asks for the file, and for one correction round (X5)", async () => {
    // The two additions the locator and the re-ask depend on. A reviewer that
    // never names the file makes every anchor start its search in the entry —
    // which on a split paper is the preamble — and one that does not know a
    // correction round exists answers the harness's feedback with a whole new
    // ledger, putting what already located back at risk.
    for (const [locale, file, corrections] of [
      [
        "en",
        "unless your brief says the manuscript is a single file",
        "only your corrections",
      ],
      ["zh", "否则都要用 `file` 写明这段引文抄自哪个文件", "只放你的更正"],
    ] as const) {
      const { skills } = await listSkills({
        bundledDir: bundledSkillsDir(),
        locale,
      });
      // Whitespace-normalised: these are whole sentences, and the files are
      // hard-wrapped prose, so matching the raw body would pin the WRAP
      // COLUMN beside the sentence — a reformat with no change in meaning
      // would fail here, and a real deletion could hide behind a rewrap.
      const body = (
        skills.find((s) => s.name === "blind-reviewer")?.body ?? ""
      ).replace(/\s+/g, " ");
      expect(`${locale} names the file: ${body.includes(file)}`).toBe(
        `${locale} names the file: true`,
      );
      expect(
        `${locale} asks for corrections only: ${body.includes(corrections)}`,
      ).toBe(`${locale} asks for corrections only: true`);
    }
  });

  it("the acm-sigconf venue carries its writing skill, in both locales", async () => {
    for (const locale of ["en", "zh"] as const) {
      const { skills, diagnostics } = await listSkills({
        venueDir: join(bundledVenuesDir(), "acm-sigconf", "skills"),
        locale,
      });
      expect(diagnostics).toEqual([]);
      expect(skills.map((s) => s.name)).toEqual(["anonymous-submission-prose"]);
      expect(skills[0]?.source).toBe("venue");
    }
  });

  it("the whole shipped surface fits the catalogue budget with room to spare", async () => {
    // Seven shipped skills (V1 added `concern-verifier`, V4 `pdf-reviewer`) against the catalogue budget (E1,
    // ADR 0045). §D5's guarantee is unchanged and this is what pins it: a user
    // installing their own must never be crowded out by what Lemmaria ships,
    // and the budget's omission rung now drops `bundled` FIRST rather than
    // dropping whatever sorted last.
    const { skills, diagnostics } = await listSkills({
      bundledDir: bundledSkillsDir(),
      venueDir: join(bundledVenuesDir(), "acm-sigconf", "skills"),
    });
    expect(skills).toHaveLength(7);
    expect(diagnostics).toEqual([]);
  });
});

/**
 * V2 (ADR 0078 §8, O15): the three protocol changes, in both locales.
 *
 * A new UNNUMBERED block rather than a fourteenth rule, deliberately: every
 * rule below 10 would have shifted, and `SKILL.md`, `SKILL.zh.md`, four ADRs
 * and two test files all cite rules by number.
 */
describe("blind-reviewer teaches V2's protocol (ADR 0078 §8)", () => {
  const bodyOf = async (locale: "en" | "zh") => {
    const { skills } = await listSkills({
      bundledDir: bundledSkillsDir(),
      locale,
    });
    return skills.find((s) => s.name === "blind-reviewer")?.body ?? "";
  };

  it("names all THREE kinds of evidence, in each locale's own words", async () => {
    for (const [locale, phrase] of [
      ["en", "is one of three things"],
      ["zh", "有三种写法"],
    ] as const) {
      const body = (await bodyOf(locale)).replace(/\s+/g, " ");
      expect(`${locale}: ${body.includes(phrase)}`).toBe(`${locale}: true`);
      // And the wire form the harness accepts, so a reviewer can produce one.
      expect(`${locale} shows the form: ${body.includes('"paper"')}`).toBe(
        `${locale} shows the form: true`,
      );
    }
  });

  it("requires a paper for `originality`, and names where a hunch goes instead", async () => {
    for (const [locale, needs, instead] of [
      [
        "en",
        "must carry a paper as its evidence",
        "file it under `positioning`",
      ],
      ["zh", "必须以一篇文献作为依据", "请归入 `positioning`"],
    ] as const) {
      const body = (await bodyOf(locale)).replace(/\s+/g, " ");
      expect(`${locale} requires: ${body.includes(needs)}`).toBe(
        `${locale} requires: true`,
      );
      // Without the second half the rule only forbids; a reviewer told what it
      // may not do, and not what to do instead, files nothing at all.
      expect(`${locale} redirects: ${body.includes(instead)}`).toBe(
        `${locale} redirects: true`,
      );
    }
  });

  it("carries the `experiments first` block, in each locale", async () => {
    for (const [locale, marker] of [
      ["en", "Before you read the experiments"],
      ["zh", "在阅读实验部分之前"],
    ] as const) {
      const body = (await bodyOf(locale)).replace(/\s+/g, " ");
      expect(`${locale}: ${body.includes(marker)}`).toBe(`${locale}: true`);
    }
  });

  it("says the manuscript is never among the search results", async () => {
    for (const [locale, marker] of [
      ["en", "The manuscript\nitself is never among the results"],
      ["zh", "稿件自身不会出现在结果中"],
    ] as const) {
      const body = (await bodyOf(locale)).replace(/\s+/g, " ");
      expect(`${locale}: ${body.includes(marker.replace(/\s+/g, " "))}`).toBe(
        `${locale}: true`,
      );
    }
  });

  it("does not renumber a single rule — 13 is still the JSON reply", async () => {
    // The block is unnumbered precisely so this stays true: `SKILL.md`,
    // `SKILL.zh.md`, ADR 0074 §9, ADR 0078 and two test files cite these
    // numbers, and a renumbering would silently invalidate every citation.
    for (const [locale, thirteen] of [
      ["en", "13. **Your final reply is exactly one JSON object"],
      ["zh", "13. **最终回复必须是且只是一个 JSON 对象**"],
    ] as const) {
      const body = await bodyOf(locale);
      expect(`${locale}: ${body.includes(thirteen)}`).toBe(`${locale}: true`);
    }
  });
});

/**
 * V5 (ADR 0087, D13, O14): strengths, an anchored impression and a
 * declaration join the reviewer protocol, in both skills and both locales.
 *
 * Two more UNNUMBERED blocks, after *Experiments first* and before rule 10 —
 * the shape V2's block took, for the reason its describe above gives: every
 * rule is cited by number somewhere. Whitespace-normalised, like V2's pins,
 * so a rewrap is not a regression and a deletion cannot hide behind one.
 */
describe("the reviewer protocol teaches V5's strengths, impression and declaration (ADR 0087, D13)", () => {
  const bodyOf = async (name: string, locale: "en" | "zh") => {
    const { skills } = await listSkills({
      bundledDir: bundledSkillsDir(),
      locale,
    });
    return skills.find((s) => s.name === name)?.body ?? "";
  };
  const flat = (text: string) => text.replace(/\s+/g, " ");

  it("places both blocks after `experiments first` and before rule 10, in each locale", async () => {
    for (const [locale, experiments, strengths, impression] of [
      [
        "en",
        "### Experiments first",
        "### Strengths — for every reviewer",
        "### Your impression — for every reviewer",
      ],
      [
        "zh",
        "### 先想实验",
        "### 优点——面向每一位评审人",
        "### 你的印象——面向每一位评审人",
      ],
    ] as const) {
      const body = await bodyOf("blind-reviewer", locale);
      const at = [
        body.indexOf(experiments),
        body.indexOf(strengths),
        body.indexOf(impression),
        body.indexOf("\n10. **"),
      ];
      expect(`${locale}: ${at.every((i) => i >= 0)}`).toBe(`${locale}: true`);
      expect(`${locale} in order: ${at.join(" < ")}`).toBe(
        `${locale} in order: ${[...at].sort((a, b) => a - b).join(" < ")}`,
      );
    }
  });

  it("files a strength like a concern, never `missing`, and a paper under originality or positioning", async () => {
    for (const [locale, anchored, never, paper, beyond] of [
      [
        "en",
        "anchored exactly as a concern is (rule 3)",
        'never `"missing"`',
        "must cite, as its evidence, the closest work one of your own searches returned",
        "what this manuscript does beyond that work",
      ],
      [
        "zh",
        "像意见一样锚定（第 3 条）",
        '绝不能是 `"missing"`',
        "必须以你自己的某次检索返回的最相近工作作为依据",
        "这份稿件在那项工作之外多做了什么",
      ],
    ] as const) {
      const body = flat(await bodyOf("blind-reviewer", locale));
      for (const phrase of [anchored, never, paper, beyond]) {
        expect(`${locale} "${phrase}": ${body.includes(phrase)}`).toBe(
          `${locale} "${phrase}": true`,
        );
      }
    }
  });

  it("gives the impression its five anchors, the whole scale, `null` and the declaration", async () => {
    for (const [locale, whole, isNull, declare, decides] of [
      [
        "en",
        "Use the whole scale",
        "or `null` when you cannot form one",
        "declare it under `not_assessed`",
        "it decides nothing",
      ],
      [
        "zh",
        "要用满整个量程",
        "无法形成印象时写 `null`",
        "在 `not_assessed` 下声明",
        "它不决定任何事",
      ],
    ] as const) {
      const body = flat(await bodyOf("blind-reviewer", locale));
      for (const phrase of [
        whole,
        isNull,
        declare,
        decides,
        "**1–2**",
        "**3–4**",
        "**5–6**",
        "**7–8**",
        "**9–10**",
      ]) {
        expect(`${locale} "${phrase}": ${body.includes(phrase)}`).toBe(
          `${locale} "${phrase}": true`,
        );
      }
    }
  });

  it("grows rule 13's JSON by the three keys, and no longer calls an annotations-only reply complete", async () => {
    // Under the operator's Option 2 an absent `impressions` block spends the
    // re-ask, so the V2 sentence calling `{"annotations": []}` a complete
    // reply would teach the one omission the harness then has to correct.
    for (const [locale, omitted, stale] of [
      [
        "en",
        "a dimension you leave out of `impressions` is recorded as `null`",
        '`{"annotations": []}` is a complete and valid reply',
      ],
      [
        "zh",
        "`impressions` 中省略的维度记为 `null`",
        '`{"annotations": []}` 是一个完整且合法的回复',
      ],
    ] as const) {
      const body = flat(await bodyOf("blind-reviewer", locale));
      for (const key of [
        '"strengths": [',
        '"impressions": {',
        '"not_assessed": [',
      ]) {
        expect(`${locale} shows ${key}: ${body.includes(key)}`).toBe(
          `${locale} shows ${key}: true`,
        );
      }
      expect(`${locale} omitted is null: ${body.includes(omitted)}`).toBe(
        `${locale} omitted is null: true`,
      );
      expect(`${locale} stale sentence: ${body.includes(stale)}`).toBe(
        `${locale} stale sentence: false`,
      );
    }
  });

  it("tells a reviewer the correction round may name the impressions block", async () => {
    for (const [locale, phrase] of [
      ["en", "It may also name your `impressions` or `not_assessed` block"],
      ["zh", "它也可能点名你的 `impressions` 或 `not_assessed`"],
    ] as const) {
      const body = flat(await bodyOf("blind-reviewer", locale));
      expect(`${locale}: ${body.includes(phrase)}`).toBe(`${locale}: true`);
    }
  });

  it("pdf-reviewer's item 8: a strength names its page; the impression is of presentation alone", async () => {
    for (const [locale, eight, page, presentation] of [
      [
        "en",
        "8. **",
        "names the page on which what you praise is visible",
        "your impression is of `presentation`",
      ],
      [
        "zh",
        "8. **",
        "写明能看到你所称赞之处的那一页",
        "你的印象只针对 `presentation`",
      ],
    ] as const) {
      const body = flat(await bodyOf("pdf-reviewer", locale));
      for (const phrase of [eight, page, presentation]) {
        expect(`${locale} "${phrase}": ${body.includes(phrase)}`).toBe(
          `${locale} "${phrase}": true`,
        );
      }
    }
  });

  it("the zh protocol says 印象, never a word for marks (the guard's regex is English-only)", async () => {
    // `no-score.test.ts` scans `skills/` with a whole-word English regex, so
    // it cannot see a Chinese synonym. These are the ones a translation of
    // *score* or *rating* reaches for; widening this list is always allowed.
    for (const name of ["blind-reviewer", "pdf-reviewer"]) {
      const body = await bodyOf(name, "zh");
      expect(`${name} says 印象: ${body.includes("印象")}`).toBe(
        `${name} says 印象: true`,
      );
      for (const banned of ["评分", "打分", "得分", "分数", "评级"]) {
        expect(`${name} says ${banned}: ${body.includes(banned)}`).toBe(
          `${name} says ${banned}: false`,
        );
      }
    }
  });
});
