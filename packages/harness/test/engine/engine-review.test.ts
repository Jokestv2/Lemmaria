import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../src/contracts/actions.js";
import type { ModelBinding, Workspace } from "../../src/contracts/adapters.js";
import { runAction } from "../../src/engine/engine.js";
import { ScriptedModelAdapter } from "../../src/model/scripted.js";
import {
  FILE,
  TEXT,
  baseAction,
  fakeAdapter,
  fakeWorkspace,
} from "./fake-adapter.js";

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "http://stub",
  model: "stub",
  apiKey: "k",
};
const targetAt = TEXT.indexOf("Target paragraph");
const selection = {
  file: FILE,
  startOffset: targetAt,
  endOffset: targetAt + 4,
};

function reviewAction(
  overrides: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    ...baseAction,
    id: "review",
    kind: "review",
    routing: { level: "L0", max_tokens: 4000 },
    review_schema: {
      dimensions: ["clarity", "rigor"],
      suggest_edits: true,
    },
    output: {
      on_validation_fail: { strategy: "retry_with_feedback", max_retries: 2 },
    },
    prompt: { system: "You review.", user: "Review: {{selection}}" },
    ...overrides,
  };
}

const GOOD = JSON.stringify({
  annotations: [
    {
      dimension: "rigor",
      severity: "major",
      anchor: "Target paragraph",
      message: "Vague opener — name the contribution.",
      suggestion: "This contribution paragraph",
    },
    {
      dimension: "clarity",
      severity: "info",
      anchor: "inside.",
      message: "Weak sentence ending.",
    },
  ],
});

/** A workspace that records writeWorkingCopy calls (invariant-3 probe). */
function spyWorkspace(): Workspace & { writes: number } {
  const base = fakeWorkspace();
  const spy = {
    ...base,
    writes: 0,
    writeWorkingCopy(path: string, content: string) {
      spy.writes += 1;
      return base.writeWorkingCopy(path, content);
    },
  };
  return spy;
}

describe("runAction (kind: review, annotations contract)", () => {
  it("emits a ReviewResult with located spans and a stamped reviewer; no proposals, no writes", async () => {
    const stub = new ScriptedModelAdapter([{ text: GOOD }]);
    const workspace = spyWorkspace();
    const result = await runAction({
      action: reviewAction(),
      adapter: fakeAdapter(),
      workspace,
      model: stub,
      binding,
      selection,
    });
    expect(result.kind).toBe("review");
    expect(result.proposals).toBeUndefined();
    expect(workspace.writes).toBe(0);
    const anns = result.review?.annotations;
    expect(anns).toHaveLength(2);
    expect(anns?.[0]).toMatchObject({
      reviewer: "writing",
      dimension: "rigor",
      severity: "major",
      span: { file: FILE, line: 5 },
      suggestedEdit: {
        original: "Target paragraph",
        replacement: "This contribution paragraph",
      },
    });
    expect(result.validators).toEqual([{ type: "annotations", pass: true }]);
    // The rendered prompt reached the model.
    expect(stub.requests[0]?.messages.at(-1)?.content).toContain("Review:");
  });

  it("stamps the reviewer from model.role", async () => {
    const stub = new ScriptedModelAdapter([{ text: GOOD }]);
    const result = await runAction({
      action: reviewAction({ model: { role: "reviewer_a" } }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.review?.annotations[0]?.reviewer).toBe("reviewer_a");
  });

  it("a garbage answer drives retry_with_feedback, then a valid one lands", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Certainly! The paragraph could be improved…" },
      { text: GOOD },
    ]);
    const result = await runAction({
      action: reviewAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(1);
    expect(result.review?.annotations).toHaveLength(2);
    const feedback = stub.requests[1]?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("JSON");
  });

  it("garbage exhausted ⇒ no review result, failing annotations outcome", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "nope" },
      { text: "still nope" },
      { text: "never json" },
    ]);
    const result = await runAction({
      action: reviewAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.review).toBeUndefined();
    expect(result.retries).toBe(2);
    expect(
      result.validators.some((v) => v.type === "annotations" && !v.pass),
    ).toBe(true);
  });

  it("a partially-located attempt retries; a fully-located retry wins (best candidate)", async () => {
    const partial = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "info",
          anchor: "Target paragraph",
          message: "ok",
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "not in the unit at all",
          message: "dropped",
        },
      ],
    });
    const stub = new ScriptedModelAdapter([{ text: partial }, { text: GOOD }]);
    const result = await runAction({
      action: reviewAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(1);
    expect(result.review?.annotations).toHaveLength(2);
    expect(result.review?.annotations[1]?.message).toBe(
      "Weak sentence ending.",
    );
  });

  it("retries exhausted on a partial attempt ⇒ the partial result is emitted with a soft outcome", async () => {
    const partial = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "info",
          anchor: "Target paragraph",
          message: "kept",
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "absent anchor text",
          message: "dropped",
        },
      ],
    });
    const stub = new ScriptedModelAdapter([{ text: partial }]);
    const result = await runAction({
      action: reviewAction({
        output: { on_validation_fail: { max_retries: 0 } },
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.review?.annotations).toHaveLength(1);
    expect(result.review?.annotations[0]?.message).toBe("kept");
    const outcome = result.validators.find((v) => v.type === "annotations");
    expect(outcome?.pass).toBe(false);
    expect(outcome?.soft).toBe(true);
    expect(outcome?.distance).toBe(1);
  });

  it("the EMITTED review carries its dropped anchors as an honesty record (ADR 0060)", async () => {
    // The soft validator outcome above is transient — it steers the retry loop
    // and is gone. What a host and a reader see is the result, so the drop has
    // to be a fact the RESULT carries. The engine itself is unchanged: `limits`
    // rides out of interpretAnnotations with the candidate.
    const partial = JSON.stringify({
      annotations: [
        {
          dimension: "rigor",
          severity: "info",
          anchor: "Target paragraph",
          message: "kept",
        },
        {
          dimension: "clarity",
          severity: "info",
          anchor: "absent anchor text",
          message: "dropped",
        },
      ],
    });
    const result = await runAction({
      action: reviewAction({
        output: { on_validation_fail: { max_retries: 0 } },
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: new ScriptedModelAdapter([{ text: partial }]),
      binding,
      selection,
    });
    expect(result.review?.annotations[0]?.id).toBe("writing-1");
    expect(result.review?.limits).toEqual([
      {
        kind: "anchors_dropped",
        reviewer: "writing",
        anchors: [
          {
            anchor: "absent anchor text",
            role: "claim",
            reason: "not_found",
          },
        ],
      },
    ]);
  });

  it("refuses fan_out (cross-review is post-MVP)", async () => {
    await expect(
      runAction({
        action: reviewAction({
          model: { fan_out: ["reviewer_a", "reviewer_b"] },
        }),
        adapter: fakeAdapter(),
        workspace: fakeWorkspace(),
        model: new ScriptedModelAdapter([{ text: GOOD }]),
        binding,
        selection,
      }),
    ).rejects.toThrowError(/cross-review/);
  });

  it("refuses a non-annotations output contract on a review action", async () => {
    await expect(
      runAction({
        action: reviewAction({ output: { contract: "replace_selection" } }),
        adapter: fakeAdapter(),
        workspace: fakeWorkspace(),
        model: new ScriptedModelAdapter([{ text: GOOD }]),
        binding,
        selection,
      }),
    ).rejects.toThrowError(/annotations/);
  });

  it("kind generate is still refused (regression)", async () => {
    await expect(
      runAction({
        action: reviewAction({ kind: "generate" }),
        adapter: fakeAdapter(),
        workspace: fakeWorkspace(),
        model: new ScriptedModelAdapter([{ text: "x" }]),
        binding,
        selection,
      }),
    ).rejects.toThrowError(/post-MVP/);
  });
});
