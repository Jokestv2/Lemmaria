import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditProposalItem } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import { undeclarableRefusalPrefix } from "./observe.js";
import { LIVE_BUDGET, LIVE_OPENAI_MODEL, liveOpenAIReady } from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

/**
 * X3 (ADR 0036), live. Both halves of the nesting gap were observed against a
 * real model during X2's manual round, and neither is reachable offline: one is
 * the model's REACTION to a refusal, and a scripted adapter can only produce the
 * reaction its author already imagined.
 *
 * **Under-protection** — asked to rewrite the bullets, the model returned
 * `\item the cost in final test accuracy;` with the `\textbf{}` simply gone, no
 * refusal, an ordinary proposal the user could Accept.
 *
 * **Deadlock** — asked to drop the bold from `measurement decision`, the model
 * was refused for undeclared loss, declared the balanced
 * `\textbf{\emph{measurement decision}}`, was refused as DISHONEST, retried
 * undeclared, was refused again, and stopped, telling the user it had "hit an
 * edit-rule constraint". The only declaration the matcher accepted was the
 * detector's unbalanced `\textbf{\emph{measurement decision}` — which looks
 * like a typo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAPER_DIR = resolve(here, "fixtures/nested-markup");
const METHOD = "sections/method.tex";

/**
 * The exact prefix `undeclarableRemovalRefusal` emits — DERIVED from that
 * builder, not copied from it (T2). See `observe.ts` for why a copied English
 * literal is a live assertion that can silently stop matching.
 */
const DISHONEST_PREFIX = undeclarableRefusalPrefix();

const NESTED_BOLD = "\\textbf{\\emph{measurement decision}}";
const NESTED_ITALIC = "\\emph{measurement decision}";
const BULLET_BOLD = "\\textbf{the cost in final test accuracy}";

function proposalsOf(items: readonly { type: string }[]): EditProposalItem[] {
  return items.filter((i): i is EditProposalItem => i.type === "edit_proposal");
}

const allEdits = (proposals: readonly EditProposalItem[]) =>
  proposals.flatMap((p) => p.edits);

/**
 * An APPLIED edit that dropped protected content without naming it. The harm
 * D1 exists to prevent, asked here about content that X3 is the reason the
 * engine can see at all.
 */
function undeclaredLossOf(
  survived: boolean,
  proposals: readonly EditProposalItem[],
  marker: string,
): boolean {
  if (survived) return false;
  return allEdits(proposals).some(
    (e) =>
      e.status === "applied" &&
      !(e.removesProtected ?? []).some((r) => r.includes(marker)),
  );
}

describe.skipIf(!liveOpenAIReady())(
  "nested protected spans (X3, agentic path)",
  () => {
    it("forcing prompt: an explicit 'drop the bold' reaches a successful edit, not a refusal loop", async () => {
      const SPEC: EvalTaskSpec = {
        id: "live-nested-markup-forcing",
        prompt:
          'In sections/method.tex, drop the bold from the phrase "measurement decision" in the first sentence but keep it italic. Change nothing else.',
        requiredGrants: [],
        tools: ["read_span", "propose_edit"],
      };
      const evidence = liveWorkDir();
      const task = await runEvalTask({
        scenario: SPEC,
        paperDir: PAPER_DIR,
        grants: new Map(),
        stub: false,
        binding: liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
        ceilings: { ...LIVE_BUDGET },
      });
      evidence.track(task.workDir);

      expect(task.outcome.status).toBe("completed");
      const proposals = proposalsOf(task.outcome.items);
      expect(proposals.length).toBeGreaterThan(0);

      // The sharp one, and the only assertion here about OUR behaviour rather
      // than the model's: an honest declaration of what it read is never thrown
      // back as dishonest. That refusal is what closed the loop the operator
      // observed, and post-X3 the balanced text IS the recorded raw.
      const dishonest = allEdits(proposals).filter(
        (e) =>
          e.status === "invalid" && (e.note ?? "").startsWith(DISHONEST_PREFIX),
      );
      expect(dishonest.map((e) => e.note ?? "")).toEqual([]);

      // The user's instruction is satisfied: the bold is gone and the italics
      // survive. Stated as an outcome rather than a set, because the failure it
      // guards is precisely "the model gave up without editing" — a set that
      // admitted "no edit applied" would pass on the reported defect.
      const method = task.outcome.files.get(METHOD) ?? "";
      expect(method).not.toContain(NESTED_BOLD);
      expect(method).toContain(NESTED_ITALIC);

      await evidence.discard();
    });

    // The other half, and a different prompt on purpose: this one never asks
    // for anything protected to go, so a careful model passes it without the
    // refusal machinery engaging — which is the point. Pre-X3 the `\textbf{}`
    // inside the `\item` was not a span at all when the anchor was wide enough,
    // so an ordinary rewrite could delete it and the engine had no opinion.
    it("natural prompt: a rewrite of the bullets never loses the \\textbf{} undeclared", async () => {
      const SPEC: EvalTaskSpec = {
        id: "live-nested-markup-natural",
        prompt:
          "Tighten the two bullet points in sections/method.tex so each is a single short line.",
        requiredGrants: [],
        tools: ["read_span", "propose_edit"],
      };
      const evidence = liveWorkDir();
      const task = await runEvalTask({
        scenario: SPEC,
        paperDir: PAPER_DIR,
        grants: new Map(),
        stub: false,
        binding: liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
        ceilings: { ...LIVE_BUDGET },
      });
      evidence.track(task.workDir);

      expect(task.outcome.status).toBe("completed");
      const proposals = proposalsOf(task.outcome.items);
      expect(proposals.length).toBeGreaterThan(0);

      const method = task.outcome.files.get(METHOD) ?? "";
      // A tightened bullet legitimately rewrites the prose INSIDE the command,
      // so the survival test is the command itself, not the whole span — but
      // COUNTED, not merely present (review, M10): the fixture has two bullets,
      // and `includes` would call one lost bold a pass because the other
      // survived.
      const boldCount = method.split("\\textbf{").length - 1;
      expect(undeclaredLossOf(boldCount >= 2, proposals, BULLET_BOLD)).toBe(
        false,
      );

      await evidence.discard();
    });
  },
);
