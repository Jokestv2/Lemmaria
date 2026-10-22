/**
 * T2, scope (a): **is the transcript's Markdown subset the right bet?**
 *
 * [ADR 0039](../../../../Lemmaria-design-doc/docs/adr/0039-markdown-subset-in-the-transcript.md)
 * shipped six constructs — headings (ATX only), lists, emphasis, inline code,
 * ``` fences, links — and deliberately not blockquotes, tables, setext
 * headings, `~~~` fences, images, or `_underscore_` emphasis. Its own
 * consequence 90 says the subset *"is a bet on what models actually emit"* and
 * that nothing in D3 measures it, naming **T2** as where it would be measured.
 *
 * **D3's gate tried once and the attempt is the cautionary tale.** One
 * unconstrained question came back as plain prose with no heading, no list, no
 * emphasis and no code span — so nothing outside the six appeared and nothing
 * inside them did either. The sample tested nothing, and the entry in
 * `open-questions.md` records that reporting it as *"confirmed"* would have been
 * an over-claim. What it asks for instead is **a corpus rather than an
 * anecdote: several prompts, at least two providers.**
 *
 * So this file:
 *
 * 1. asks four questions whose answers WANT structure, of **both** pinned
 *    models;
 * 2. asserts the **failure** — that nothing outside the rendered set appears;
 * 3. asserts the corpus produced structure **at all**, which is the guard
 *    against D3's mistake repeating: a green run over four empty answers
 *    answers nothing;
 * 4. **reports the tally either way**, because the question is *what do models
 *    emit*, and a pass/fail bit is not an answer to it.
 *
 * ---
 *
 * **THE BET LOST, AND X4 IS THE CORRECTION. This scenario was red on the OpenAI
 * pin on purpose from T2's merge until X4 landed** — it was X4's acceptance
 * test, and widening the renderer is what turned it green.
 *
 * Ten corpus passes were measured across three sittings, all on 2026-08-19:
 *
 * | Sitting | Passes | `table` | `blockquote` | `link` |
 * | --- | --- | --- | --- | --- |
 * | T2's first reading | 3 | 3 of 3, one provider | 1 of 3, one provider | 0 |
 * | T2's step-7 re-measure | 4 | **4 of 4, both providers** | **3 of 4, both providers** | 0 |
 * | X4's own re-measure | 3 | 2 of 3 (both OpenAI passes) | 0 of 3 | 0 |
 * | **Total** | **10** | **9 of 10** | **4 of 10, both providers** | **0 of 10** |
 *
 * The symptom was confirmed against the shipped renderer rather than inferred:
 * `agentMessage()` over a Markdown table returned the raw `| --- |` pipe syntax
 * as `textContent` with no `<table>` element — exactly the defect D3 exists to
 * remove, surviving for the commonest shape of answer a model gives to a
 * comparison question.
 *
 * **The operator adopted option (a) — widen to tables — and sent `blockquote`
 * to X4 to re-measure before choosing between (a) and (b). X4 measured, and
 * chose (b).** Not on the count, which fell to 0 of 3 in X4's own sitting, but
 * on the **provider spread**: the reason (b) was held back on the record was
 * *"1 of 3 runs, one provider"*, i.e. one model's habit, and that is withdrawn
 * — both pins have now emitted one. The second reason is this file: under (a),
 * `blockquote` would stay below and this scenario would fail in roughly four
 * runs in ten, which reads as a flake, and a flaky live gate is precisely how a
 * tier starts being ignored — the standing risk the stage index records.
 *
 * **`link` is 0 of 10 and stays rendered; `underscoreEm`, `tildeFence`,
 * `setextHeading` and `image` are 0 of 10 and stay excluded.** Widening on zero
 * evidence is the mistake this file exists to prevent, in the other direction.
 *
 * **The verification run settled the (a)-versus-(b) question by itself.** The
 * first pass after the renderer widened — 2026-08-19, one pass per provider,
 * both green — reported `table` on **both** pins and `blockquote` on the OpenAI
 * pin. Under option (a) that run would have been RED on the day X4 shipped,
 * which is the argument for (b) demonstrated rather than predicted.
 *
 * Full record: [ADR 0044](../../../../Lemmaria-design-doc/docs/adr/0044-tables-and-blockquotes-in-the-transcript.md)
 * and `docs/open-questions.md`.
 */
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFailed } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import { assistantText, report } from "./observe.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_BUDGET,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAPER_DIR = resolve(here, "fixtures/smoke");

/**
 * The eight the transcript renders. A tally over these answers "did the corpus
 * produce structure at all", which is the question D3's single sample could not.
 *
 * `table` and `blockquote` moved up here from `OUTSIDE` when **X4** widened the
 * renderer ([ADR 0044](../../../../Lemmaria-design-doc/docs/adr/0044-tables-and-blockquotes-in-the-transcript.md)).
 * The patterns are unchanged in the move — deliberately, so the row that was
 * evidence of a defect is now evidence of the fix, rather than a differently
 * worded claim about a different thing.
 */
const INSIDE: Record<string, RegExp> = {
  atxHeading: /^#{1,6} \S/m,
  list: /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\S/m,
  emphasis: /(?:^|[\s(])\*{1,2}(?!\s)[^*\n]+(?<!\s)\*{1,2}/,
  inlineCode: /`[^`\n]+`/,
  fence: /^```/m,
  link: /\[[^\]\n]+\]\([^)\s]+\)/,
  table: /^\|.*\|[ \t]*$\n^\|?[ \t:|-]+\|[ \t:|-]*$/m,
  blockquote: /^> \S/m,
};

/**
 * The ones the transcript deliberately does not render. Each is a
 * literal-syntax defect if a model reaches for it, so ANY hit is the finding.
 *
 * All four are **0 of 10** across every corpus pass measured to date, which is
 * why X4 left them here: widening a renderer on zero evidence is the same
 * mistake as refusing to widen it against nine-of-ten evidence, pointing the
 * other way.
 *
 * `underscoreEm` is written narrowly on purpose: ADR 0039 excluded `_em_`
 * because in a LaTeX tool an underscore is far more often a subscript, an
 * identifier or a filename. Matching `snake_case` or `$x_1$` here would report
 * the very false positive that reasoning is about, so the pattern requires the
 * run to start and end at a word boundary with no interior underscore.
 */
const OUTSIDE: Record<string, RegExp> = {
  underscoreEm: /(?:^|[\s(])_(?!\s)[^_\n]{2,}(?<!\s)_(?=$|[\s.,;:)!?])/m,
  tildeFence: /^~~~/m,
  setextHeading: /^[^\n]+\n(?:={3,}|-{3,})[ \t]*$/m,
  image: /!\[[^\]\n]*\]\([^)\s]*\)/,
};

function found(text: string, set: Record<string, RegExp>): string[] {
  return Object.entries(set)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

/** Four questions whose natural answers want structure of different kinds. */
const PROMPTS: { id: string; prompt: string }[] = [
  {
    id: "procedure",
    prompt:
      "Without editing anything, explain in order the steps someone should follow to turn a rough draft section into a submittable one. Be concrete.",
  },
  {
    id: "comparison",
    prompt:
      "Without editing anything, compare writing a Methods section for a systems paper against writing one for a theory paper. Cover the main points of difference.",
  },
  {
    id: "snippet",
    prompt:
      "Without editing anything, show me the LaTeX I would write to add a two-column figure with a caption and a label, and explain each part.",
  },
  {
    id: "caveat",
    prompt:
      "Without editing anything, what is the single most important thing to get right in an abstract, and what is the most common mistake? Make the key point stand out.",
  },
];

async function ask(
  id: string,
  prompt: string,
  protocol: "openai-compatible" | "anthropic",
  model: string,
  keep: string[],
): Promise<string> {
  const SPEC: EvalTaskSpec = {
    id: `live-md-${id}`,
    prompt,
    requiredGrants: [],
    tools: ["read_span"],
  };
  const task = await runEvalTask({
    scenario: SPEC,
    paperDir: PAPER_DIR,
    grants: new Map(),
    stub: false,
    binding: liveBinding(protocol, model),
    ceilings: { ...LIVE_BUDGET },
    // No write path: these are questions, not edit requests, and offering
    // `propose_edit` would invite the model to answer by editing the paper.
    readOnly: true,
  });
  keep.push(task.workDir);
  expect(task.outcome.status, `${id}/${model}: run did not complete`).toBe(
    "completed",
  );
  return assistantText(task.outcome.items);
}

/**
 * One provider's pass over the corpus. Shared, because the whole point is that
 * the two providers are asked the SAME four questions — a corpus where each
 * model got different prompts would compare the prompts, not the models.
 */
function corpusFor(
  label: string,
  protocol: "openai-compatible" | "anthropic",
  model: string,
  ready: boolean,
): void {
  describe.skipIf(!ready)(
    `Markdown emitted by ${label} (T2's corpus, X4's subset)`,
    () => {
      it("uses nothing outside the eight rendered constructs, and produces structure", async () => {
        // Four runs, so four working copies. `liveWorkDir` holds one; this
        // scenario keeps the list and removes it only on the passing path, which
        // is the same trade for the same reason — a failed corpus run is the one
        // worth reading, and paying for another nondeterministic run to see it
        // would be the whole cost of the tier over again.
        const workDirs: string[] = [];
        onTestFailed(() => {
          console.error(
            ["live corpus kept for inspection:", ...workDirs].join("\n  "),
          );
        });
        const inside = new Set<string>();
        const outside = new Map<string, string>();
        const answers: Record<string, number> = {};

        for (const { id, prompt } of PROMPTS) {
          const answer = await ask(id, prompt, protocol, model, workDirs);
          answers[id] = answer.length;
          expect(
            answer.length,
            `${id}: the model said nothing`,
          ).toBeGreaterThan(0);
          for (const name of found(answer, INSIDE)) inside.add(name);
          for (const name of found(answer, OUTSIDE)) {
            if (!outside.has(name)) outside.set(name, `${id}: ${answer}`);
          }
        }

        // Reported either way. The question is *what do models emit*, and a
        // green bit is not an answer to it (ADR 0038 §2).
        report(`markdown-emission/${label}`, {
          model,
          prompts: PROMPTS.length,
          answerLengths: answers,
          renderedConstructs: [...inside].sort(),
          unrenderedConstructs: [...outside.keys()].sort(),
        });

        // (1) The guard against D3's own mistake. Four answers with no structure
        // at all would satisfy "nothing outside the six" vacuously, and reporting
        // that as confirmation is exactly the over-claim the open question warns
        // about.
        expect(
          inside.size,
          `the whole corpus produced NO Markdown — this run answers nothing about the subset, exactly as D3's single sample did not. Lengths: ${JSON.stringify(answers)}`,
        ).toBeGreaterThan(0);

        // (2) The finding. Any hit means the subset is wrong for this model and
        // the construct reaches the transcript as literal syntax. `table` is what
        // made this fire, and X4 is what made it stop.
        expect(
          [...outside.keys()],
          `constructs the transcript does NOT render were emitted — first sighting each:\n${[...outside.entries()].map(([k, v]) => `--- ${k} ---\n${v}`).join("\n")}`,
        ).toEqual([]);

        // Reached only when every assertion above held, which is the whole point:
        // `work-dir.ts`'s trade, applied to four copies instead of one. A failing
        // corpus keeps them (`onTestFailed` prints where), a green one leaks
        // nothing. Windows can hold a lock on a just-written file, and that is not
        // a reason to fail a run that already passed.
        for (const dir of workDirs) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }, 600_000);
    },
  );
}

corpusFor(
  "gpt (openai-compatible)",
  "openai-compatible",
  LIVE_OPENAI_MODEL,
  liveOpenAIReady(),
);
corpusFor(
  "claude (anthropic)",
  "anthropic",
  LIVE_ANTHROPIC_MODEL,
  liveAnthropicReady(),
);
