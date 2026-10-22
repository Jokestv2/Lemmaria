/**
 * D4 / QA-1, the milestone's one *live* row.
 *
 * The rename reaches into a **system prompt**: `session/prompt.ts` tells the
 * model to point a user who asks for a document edit at the quick actions, and
 * it names them. An offline test pins the string (`test/session/prompt.test.ts`);
 * only a model can show the string does its job.
 *
 * That is [ADR 0038](../../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
 * §2's rule about which tier owns what: reading a response and deciding whether
 * it matches the plan is slow and unreliable for a person, so it belongs here
 * rather than on the operator's checklist.
 *
 * **What is asserted is the FAILURE, not a phrasing.** The model is free to
 * answer however it likes; what it must not do is name an action that no longer
 * exists. Asserting that it says "Shrink By" would be asserting a wording the
 * model was never promised.
 *
 * **CORRECTED at T2, and the correction is the milestone's first finding.**
 * This test's premise was never met. It requires a session with no write path,
 * because that is the only branch of the system prompt that names the quick
 * actions — and the comment below said so from the start. But `runEvalTask`
 * always passed an `editHost`, `runSessionTask` loop-injects `propose_edit`
 * whenever one is present, and so `envelope.editPolicy` was never `undefined`:
 * the branch never fired, no action name ever reached the model, and an
 * assertion that no RETIRED name came back could not fail. It passed at D4's
 * gate for exactly the reason it warned about.
 *
 * `readOnly: true` is what makes the condition real. Its precondition — that
 * the branch fires and the names are in the prompt — is now pinned OFFLINE in
 * `test/eval-seams.test.ts`, because a live test cannot guard its own setup.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import { assistantText } from "./observe.js";
import { LIVE_BUDGET, LIVE_OPENAI_MODEL, liveOpenAIReady } from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAPER_DIR = resolve(here, "fixtures/protected-comment");

/** The names D4 retired. A model can only produce these from our own prompt. */
const RETIRED = ["Shrink to Target", "精简到目标字数"];

/** What the actions are actually called now. */
const CURRENT = ["Shrink By", "Expand By"];

describe.skipIf(!liveOpenAIReady())("quick-action names (D4, QA-1)", () => {
  it("never points the user at an action that no longer exists", async () => {
    const SPEC: EvalTaskSpec = {
      id: "live-quick-action-names",
      // Deliberately a REQUEST TO EDIT in a session with NO write path, because
      // that is the only branch of the system prompt that names the quick
      // actions (`editPolicy === undefined` -> "point them to the quick
      // actions"). Offering `propose_edit` here would take the other branch and
      // the test would pass for the wrong reason.
      prompt:
        "Can you make the Introduction shorter? Roughly a hundred words shorter would be ideal.",
      requiredGrants: [],
      tools: ["read_span"],
    };
    const evidence = liveWorkDir();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: PAPER_DIR,
      grants: new Map(),
      stub: false,
      binding: liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
      ceilings: { ...LIVE_BUDGET },
      // Without this the write path is injected regardless of `tools`, the
      // quick-action branch never fires, and this test cannot fail (T2).
      readOnly: true,
    });
    evidence.track(task.workDir);

    expect(task.outcome.status).toBe("completed");
    const answer = assistantText(task.outcome.items);
    expect(answer.length).toBeGreaterThan(0);

    for (const dead of RETIRED) {
      expect(
        answer.includes(dead),
        `the answer named the retired action "${dead}" — the system prompt is the only place it could have come from`,
      ).toBe(false);
    }

    // Not asserted: that the answer names `Shrink By`. The model is free to
    // answer without naming an action at all, and pinning a phrasing it was
    // never promised would make this a coin flip. `CURRENT` is referenced so
    // the names are here for whoever reads a failure.
    expect(CURRENT.length).toBe(2);

    await evidence.discard();
  }, 180_000);
});
