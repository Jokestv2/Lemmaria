import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveBinding, runEvalTask } from "../../src/eval/run-eval.js";
import type { EvalTaskSpec } from "../../src/eval/scenarios.js";
import { LIVE_BUDGET, LIVE_OPENAI_MODEL, liveOpenAIReady } from "./pins.js";
import { liveWorkDir } from "./work-dir.js";

const here = dirname(fileURLToPath(import.meta.url));

const SPEC: EvalTaskSpec = {
  id: "live-smoke",
  prompt:
    "Read main.tex and tell me, in one sentence, what the Introduction says.",
  requiredGrants: [],
  tools: ["read_span"],
};

describe.skipIf(!liveOpenAIReady())("live smoke (openai-compatible)", () => {
  it("completes a real turn against the pinned model", async () => {
    // Registered before the run: a failure keeps the working copy and prints it.
    const evidence = liveWorkDir();
    const task = await runEvalTask({
      scenario: SPEC,
      paperDir: resolve(here, "fixtures/smoke"),
      grants: new Map(),
      stub: false,
      binding: liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
      ceilings: { ...LIVE_BUDGET },
    });
    evidence.track(task.workDir);

    expect(task.outcome.status).toBe("completed");
    expect(task.model).toBe(LIVE_OPENAI_MODEL);
    const said = task.outcome.items
      .filter((i) => i.type === "agent_message")
      .map((i) => (i.type === "agent_message" ? i.text : ""))
      .join(" ");
    expect(said.length).toBeGreaterThan(0);

    // Passing path only — a failure above leaves the copy on disk.
    await evidence.discard();
  });
});
