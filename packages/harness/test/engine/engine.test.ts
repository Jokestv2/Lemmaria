import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../src/contracts/actions.js";
import type { ModelBinding } from "../../src/contracts/adapters.js";
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

function polishAction(
  overrides: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    ...baseAction,
    routing: { level: "L0", max_tokens: 4000 },
    context: { protected_spans: "freeze" },
    output: {
      contract: "replace_selection",
      validators: [{ type: "protected_spans_intact" }],
      on_validation_fail: { strategy: "retry_with_feedback", max_retries: 2 },
    },
    prompt: { system: "You polish.", user: "Polish: {{selection}}" },
    ...overrides,
  };
}

describe("runAction (L0)", () => {
  it("happy path: one call, validators pass, proposal thawed", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Better paragraph with ⟦P0⟧ inside." },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(0);
    expect(result.usage.iterations).toBe(1);
    expect(result.validators.every((v) => v.pass)).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.replacement).toBe(
      "Better paragraph with \\citep{v17} inside.",
    );
    expect(proposal?.expectedOriginal).toContain("Target paragraph");
    expect(proposal?.contract).toBe("replace_selection");
    // L0 = no tools; prompt carries the frozen token, not the raw cite
    expect(stub.requests[0]?.tools ?? []).toHaveLength(0);
    expect(stub.requests[0]?.messages.at(-1)?.content).toContain("⟦P0⟧");
    expect(stub.requests[0]?.messages.at(-1)?.content).not.toContain("\\citep");
  });

  it("validator failure drives retry_with_feedback, observably", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Dropped the citation." },
      { text: "Fixed with ⟦P0⟧ restored." },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(1);
    expect(result.usage.iterations).toBe(2);
    expect(result.proposals?.[0]?.replacement).toContain("\\citep{v17}");
    const secondCall = stub.requests[1]?.messages ?? [];
    expect(
      secondCall.some(
        (m) => m.role === "assistant" && m.content === "Dropped the citation.",
      ),
    ).toBe(true);
    const feedback = secondCall.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("protected_spans_intact");
    expect(feedback?.content).toContain("⟦P0⟧");
  });

  it("discards the output when retries are exhausted", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "bad 1" },
      { text: "bad 2" },
      { text: "bad 3" },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(2);
    expect(result.proposals).toBeUndefined();
    expect(result.validators.some((v) => !v.pass)).toBe(true);
  });

  it("clamps maxTokens to the ceiling, observably on the wire (invariant 5)", async () => {
    const stub = new ScriptedModelAdapter([{ text: "ok ⟦P0⟧" }]);
    await runAction({
      action: polishAction({ routing: { level: "L0", max_tokens: 999999 } }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      ceilings: { maxTokens: 1234 },
    });
    expect(stub.requests[0]?.maxTokens).toBe(1234);
  });

  it("accumulates usage across retries and reports the rendered context", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "bad", usage: { inputTokens: 100, outputTokens: 10 } },
      { text: "ok ⟦P0⟧", usage: { inputTokens: 120, outputTokens: 12 } },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.usage).toMatchObject({
      inputTokens: 220,
      outputTokens: 22,
      iterations: 2,
    });
    expect(result.usage.costUsd).toBeUndefined();
    expect(result.context.level).toBe("L0");
    expect(result.context.renderedPrompt.user).toContain("⟦P0⟧");
    expect(result.stoppedBy).toBe("complete");
  });

  it("discards a truncated generation (stopReason max_tokens) instead of proposing it", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Truncated mid-sent", stopReason: "max_tokens" },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.proposals).toBeUndefined();
    expect(result.stoppedBy).toBe("budget");
  });

  it("discards an aborted generation with stoppedBy error", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "", stopReason: "aborted" },
    ]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.proposals).toBeUndefined();
    expect(result.stoppedBy).toBe("error");
  });

  it("pins the not-yet-built tiers and kinds", async () => {
    const stub = new ScriptedModelAdapter([]);
    const base = {
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    };
    await expect(
      runAction({
        ...base,
        action: polishAction({ routing: { level: "L2" } }),
      }),
    ).rejects.toThrow(/L2 agent loop lands post-MVP/);
    await expect(
      runAction({
        ...base,
        action: polishAction({ routing: { level: "auto" } }),
      }),
    ).rejects.toThrow(/lands post-MVP/);
    // kind review is supported since M9 (ADR 0008) — but only with the
    // annotations contract; polish's replace_selection contract is refused.
    await expect(
      runAction({ ...base, action: polishAction({ kind: "review" }) }),
    ).rejects.toThrow(/annotations/);
    await expect(
      runAction({
        ...base,
        action: polishAction({
          kind: "generate",
          output: { contract: "insert_after" },
        }),
      }),
    ).rejects.toThrow(/land post-MVP/);
  });

  it("replace_anchor: locates the model's anchored edit and proposes exactly that span (ADR 0007)", async () => {
    const stub = new ScriptedModelAdapter([
      {
        text: JSON.stringify({
          anchor: "Target paragraph",
          replacement: "Renamed paragraph",
        }),
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: { contract: "replace_anchor" },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    const proposal = result.proposals?.[0];
    expect(proposal?.contract).toBe("replace_anchor");
    expect(proposal?.expectedOriginal).toBe("Target paragraph");
    expect(proposal?.replacement).toBe("Renamed paragraph");
    expect(proposal?.span.startOffset).toBe(TEXT.indexOf("Target paragraph"));
    expect(proposal?.span.endOffset).toBe(
      TEXT.indexOf("Target paragraph") + "Target paragraph".length,
    );
  });

  it("replace_anchor: a bad anchor drives retry feedback, then a valid one lands", async () => {
    const stub = new ScriptedModelAdapter([
      { text: '{"anchor": "not in the file at all", "replacement": "x"}' },
      {
        text: '{"anchor": "Target paragraph", "replacement": "Better paragraph"}',
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: {
          contract: "replace_anchor",
          on_validation_fail: {
            strategy: "retry_with_feedback",
            max_retries: 2,
          },
        },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.retries).toBe(1);
    const feedback = stub.requests[1]?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toMatch(/anchored_edit|anchor/);
    expect(result.proposals?.[0]?.expectedOriginal).toBe("Target paragraph");
  });

  it("replace_anchor: a cross-file `file` is refused with retry feedback (single-file M8 limit)", async () => {
    // The extension's Accept-gated diff flow renders ONE document (the entry
    // file); silently proposing against another file would splice foreign
    // offsets into it. Until the diff flow is multi-file, the engine refuses
    // and the feedback steers the model back to the current file.
    const stub = new ScriptedModelAdapter([
      {
        text: JSON.stringify({
          anchor: "Target paragraph",
          replacement: "Renamed paragraph",
          file: "chapters/other.tex",
        }),
      },
      {
        text: JSON.stringify({
          anchor: "Target paragraph",
          replacement: "Renamed paragraph",
        }),
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: {
          contract: "replace_anchor",
          on_validation_fail: {
            strategy: "retry_with_feedback",
            max_retries: 2,
          },
        },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.retries).toBe(1);
    const feedback = stub.requests[1]?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toMatch(new RegExp(FILE.replace(".", "\\.")));
    const proposal = result.proposals?.[0];
    expect(proposal?.file).toBe(FILE);
    expect(proposal?.expectedOriginal).toBe("Target paragraph");
  });

  it("replace_anchor: retries exhausted on garbage ⇒ no proposal, anchored_edit outcome", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "I think the fix is …" },
      { text: "Sorry, here it is: anchor = x" },
      { text: "still prose" },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: {
          contract: "replace_anchor",
          on_validation_fail: {
            strategy: "retry_with_feedback",
            max_retries: 2,
          },
        },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.proposals).toBeUndefined();
    expect(
      result.validators.some((v) => v.type === "anchored_edit" && !v.pass),
    ).toBe(true);
  });

  it("replace_anchor: validators run against the replacement (structure guard blocks a hallucinated delimiter)", async () => {
    const stub = new ScriptedModelAdapter([
      {
        text: JSON.stringify({
          anchor: "Target paragraph",
          replacement: "Target paragraph\\end{document}",
        }),
      },
      {
        text: JSON.stringify({
          anchor: "Target paragraph",
          replacement: "Safe paragraph",
        }),
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: {
          contract: "replace_anchor",
          validators: [{ type: "document_structure_intact" }],
          on_validation_fail: {
            strategy: "retry_with_feedback",
            max_retries: 2,
          },
        },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.retries).toBe(1);
    expect(result.proposals?.[0]?.replacement).toBe("Safe paragraph");
  });

  it("replace_anchor: the engine splice guard blocks dropping a document delimiter (no declared validator needed)", async () => {
    const DOC = "\\begin{document}\nTarget paragraph here\n\\end{document}\n";
    const stub = new ScriptedModelAdapter([
      // Drops \end{document} — corruption; must be refused by the ENGINE.
      {
        text: '{"anchor": "here\\n\\\\end{document}\\n", "replacement": "here\\n"}',
      },
      // Then a safe targeted repair.
      {
        text: '{"anchor": "Target paragraph", "replacement": "Fixed paragraph"}',
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: {
          contract: "replace_anchor",
          on_validation_fail: {
            strategy: "retry_with_feedback",
            max_retries: 2,
          },
        },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: { ...fakeWorkspace(), readFile: () => Promise.resolve(DOC) },
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.retries).toBe(1);
    const feedback = stub.requests[1]?.messages.at(-1);
    expect(feedback?.content).toMatch(/corrupt/);
    expect(result.proposals?.[0]?.replacement).toBe("Fixed paragraph");
  });

  it("replace_anchor: a delimiter-typo repair (count 0 → 1) is allowed", async () => {
    const DOC =
      "\\documentclass{article}\n\\begin{doument}\nProse.\n\\end{document}\n";
    const stub = new ScriptedModelAdapter([
      {
        text: '{"anchor": "\\\\begin{doument}", "replacement": "\\\\begin{document}"}',
      },
    ]);
    const result = await runAction({
      action: polishAction({
        input: { scope: "document" },
        output: { contract: "replace_anchor" },
        context: {},
      }),
      adapter: fakeAdapter(),
      workspace: { ...fakeWorkspace(), readFile: () => Promise.resolve(DOC) },
      model: stub,
      binding,
      selection: { file: FILE, startOffset: 0, endOffset: 0 },
    });
    expect(result.retries).toBe(0);
    expect(result.proposals?.[0]?.expectedOriginal).toBe("\\begin{doument}");
    expect(result.proposals?.[0]?.replacement).toBe("\\begin{document}");
  });

  it("runs an L1 action end to end: tool self-check then a valid proposal", async () => {
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "t1", name: "count_words", args: { text: "x" } }] },
      { text: "Shorter paragraph with ⟦P0⟧ inside." },
    ]);
    const result = await runAction({
      action: polishAction({
        routing: { level: "L1", tools: ["count_words"], max_iterations: 3 },
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.context.level).toBe("L1");
    expect(result.usage.iterations).toBe(2);
    expect(result.proposals?.[0]?.replacement).toContain("\\citep{v17}");
    // count_words was offered as a tool on the first turn.
    expect(stub.requests[0]?.tools?.map((t) => t.name)).toContain(
      "count_words",
    );
  });

  it("offers citation_check as an L1 tool when host citation data is injected (M7)", async () => {
    const stub = new ScriptedModelAdapter([
      { toolCalls: [{ id: "c1", name: "citation_check", args: {} }] },
      { text: "Paragraph with ⟦P0⟧ inside." },
    ]);
    const result = await runAction({
      action: polishAction({
        routing: { level: "L1", tools: ["citation_check"], max_iterations: 3 },
      }),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      citations: {
        citedKeys: ["ghost"],
        entries: [{ key: "real", fields: { title: "Real" }, file: "refs.bib" }],
        entryFile: "main.tex",
      },
    });
    expect(result.context.level).toBe("L1");
    expect(stub.requests[0]?.tools?.map((t) => t.name)).toContain(
      "citation_check",
    );
    // The C1 result (an undefined-citation for "ghost") travelled back to the model.
    const toolMsg = stub.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("undefined-citation");
  });

  it("honors an external AbortSignal: aborts with stoppedBy error, no proposal", async () => {
    const stub = new ScriptedModelAdapter([{ text: "unused ⟦P0⟧" }]);
    const controller = new AbortController();
    controller.abort();
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      signal: controller.signal,
    });
    expect(result.stoppedBy).toBe("error");
    expect(result.proposals).toBeUndefined();
    // The combined signal reached the model call.
    expect(stub.requests[0]?.signal?.aborted).toBe(true);
  });

  it("a non-aborted external signal leaves behavior unchanged", async () => {
    const stub = new ScriptedModelAdapter([{ text: "ok ⟦P0⟧" }]);
    const controller = new AbortController();
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      signal: controller.signal,
    });
    expect(result.stoppedBy).toBe("complete");
    expect(result.proposals?.[0]?.replacement).toContain("\\citep{v17}");
  });

  it("appends userFeedback as a trailing user message (Retry+note)", async () => {
    const stub = new ScriptedModelAdapter([{ text: "shorter ⟦P0⟧" }]);
    await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      userFeedback: "make it shorter",
    });
    const messages = stub.requests[0]?.messages ?? [];
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("make it shorter");
    expect(last?.content).toContain("The user reviewed a previous proposal");
  });

  it("sends no feedback message when userFeedback is blank", async () => {
    const stub = new ScriptedModelAdapter([{ text: "ok ⟦P0⟧" }]);
    await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      userFeedback: "   ",
    });
    const messages = stub.requests[0]?.messages ?? [];
    expect(
      messages.filter((m) => m.content.includes("The user reviewed")),
    ).toHaveLength(0);
  });

  it("layout_preserved retries with feedback, then emits the attempt that kept the structure (D1)", async () => {
    // The reported EDIT-2 failure: a shrink or a translate returns one blob and
    // the engine splices it over the selection, with nothing checking that the
    // paragraph breaks came back. Soft, so a legitimate merge is surfaced
    // rather than discarding an otherwise good rewrite — but it retries first.
    const stub = new ScriptedModelAdapter([
      // Attempt 1: four paragraphs collapsed onto one line.
      {
        text: "Intro. First paragraph. Target with PLACEHOLDER inside. After.",
      },
      // Attempt 2: the structure is back.
      {
        text: [
          "Intro rewritten.",
          "",
          "First paragraph rewritten.",
          "",
          "Target rewritten with PLACEHOLDER inside.",
          "",
          "After paragraph rewritten.",
        ].join("\n"),
      },
    ]);
    const action = polishAction({
      input: { scope: "document" },
      output: {
        contract: "replace_selection",
        validators: [{ type: "layout_preserved", soft: true }],
        on_validation_fail: { strategy: "retry_with_feedback", max_retries: 1 },
      },
    });
    const result = await runAction({
      action,
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(1);
    expect(result.proposals?.[0]?.replacement).toContain(
      "After paragraph rewritten.",
    );
    const layout = result.validators.find((v) => v.type === "layout_preserved");
    expect(layout?.pass).toBe(true);
  });

  it("layout_preserved is SOFT: an unavoidable merge is proposed, not discarded (D1)", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Everything merged onto one line." },
      { text: "Still everything merged onto one line." },
    ]);
    const action = polishAction({
      input: { scope: "document" },
      output: {
        contract: "replace_selection",
        validators: [{ type: "layout_preserved", soft: true }],
        on_validation_fail: { strategy: "retry_with_feedback", max_retries: 1 },
      },
    });
    const result = await runAction({
      action,
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.proposals).toBeDefined();
    const layout = result.validators.find((v) => v.type === "layout_preserved");
    expect(layout?.pass).toBe(false);
    expect(layout?.soft).toBe(true);
    expect(layout?.reason).toMatch(/paragraph/);
  });

  it("emits the CLOSEST attempt when only a soft validator misses after retries", async () => {
    // The target paragraph is 4 prose words. A soft word_count(target 2) misses
    // on both attempts; attempt 1 (3 words, off by 1) is closer than attempt 2
    // (6 words, off by 4). The best (closest) candidate must be proposed — not
    // the last — with the soft failure surfaced rather than discarded.
    const stub = new ScriptedModelAdapter([
      { text: "One ⟦P0⟧ two three." },
      { text: "One two three four ⟦P0⟧ five six." },
    ]);
    const action = polishAction({
      output: {
        contract: "replace_selection",
        validators: [
          { type: "protected_spans_intact" },
          { type: "word_count", target: 2, tolerance: 0, soft: true },
        ],
        on_validation_fail: { strategy: "retry_with_feedback", max_retries: 1 },
      },
    });
    const result = await runAction({
      action,
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.retries).toBe(1);
    // A proposal IS emitted (soft miss no longer discards), and it is attempt 1.
    expect(result.proposals?.[0]?.replacement).toBe(
      "One \\citep{v17} two three.",
    );
    // The surfaced validators belong to the emitted (closest) candidate.
    const wc = result.validators.find((v) => v.type === "word_count");
    expect(wc?.pass).toBe(false);
    expect(wc?.soft).toBe(true);
    expect(wc?.reason).toContain("3 words");
  });

  it("a hard validator failure still blocks emission even alongside a soft one", async () => {
    // The model drops the protected token every time (hard fail); a soft
    // word_count miss must not rescue it into a proposal.
    const stub = new ScriptedModelAdapter([
      { text: "One two three four five." },
      { text: "One two three." },
    ]);
    const action = polishAction({
      output: {
        contract: "replace_selection",
        validators: [
          { type: "protected_spans_intact" },
          { type: "word_count", target: 2, tolerance: 0, soft: true },
        ],
        on_validation_fail: { strategy: "retry_with_feedback", max_retries: 1 },
      },
    });
    const result = await runAction({
      action,
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    });
    expect(result.proposals).toBeUndefined();
    expect(
      result.validators.find((v) => v.type === "protected_spans_intact")?.pass,
    ).toBe(false);
  });

  it("ignores a non-string userFeedback instead of crashing", async () => {
    // A host command (VS Code's title-bar "Retry with Note" button) can invoke
    // the retry with a non-string positional arg (a URI). It must not reach
    // .trim() and crash — treat anything non-string as "no feedback".
    const stub = new ScriptedModelAdapter([{ text: "ok ⟦P0⟧" }]);
    const result = await runAction({
      action: polishAction(),
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
      userFeedback: { scheme: "file" } as unknown as string,
    });
    expect(result.proposals?.length).toBe(1);
    const messages = stub.requests[0]?.messages ?? [];
    expect(
      messages.filter((m) => m.content.includes("The user reviewed")),
    ).toHaveLength(0);
  });

  it("rejects unmet requires and invalid params with coded errors", async () => {
    const stub = new ScriptedModelAdapter([]);
    const base = {
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      model: stub,
      binding,
      selection,
    };
    await expect(
      runAction({
        ...base,
        action: polishAction({ requires: { doc_kinds: ["markdown"] } }),
      }),
    ).rejects.toMatchObject({ code: "requires_unmet" });
    await expect(
      runAction({
        ...base,
        action: polishAction({
          parameters: [{ id: "target", type: "integer", required: true }],
        }),
      }),
    ).rejects.toMatchObject({ code: "params_invalid" });
  });
});
