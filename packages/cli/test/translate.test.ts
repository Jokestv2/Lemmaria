import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelAdapter } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { runCliAction } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function cursorAt(root: string, needle: string) {
  const text = await readFile(join(root, "main.tex"), "utf8");
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`fixture is missing: ${needle}`);
  return { start, end: start };
}

describe("M6 acceptance: translate respects glossary spellings via the L1 loop", () => {
  const root = join(FIXTURES, "polish-en");
  // The zh translation keeps the canonical glossary term 注意力机制 and all frozen tokens.
  const zh = "注意力机制对序列建模非常有用 ⟦P0⟧，代价为 ⟦P1⟧（另见 ⟦P2⟧）。";

  it("looks up the glossary, then translates with the canonical term (glossary hard-constraint)", async () => {
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "t1",
            name: "glossary_lookup",
            args: { term: "attention mechanism" },
          },
        ],
      },
      { text: zh },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "translate",
      selection: { start: sel.start, end: sel.end },
      params: { target_language: "zh" },
      model: stub,
    });

    expect(result.context.level).toBe("L1");
    expect(result.usage.iterations).toBe(2);
    // glossary_lookup is a retrieval tool → it consumed the retrieval budget path.
    const toolResult = stub.requests[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content).toContain("注意力机制");

    // Validators: output is zh, uses the canonical term, and keeps the frozen spans.
    expect(result.validators.every((v) => v.pass)).toBe(true);
    expect(result.validators.find((v) => v.type === "language_is")?.pass).toBe(
      true,
    );
    expect(
      result.validators.find((v) => v.type === "glossary_consistent")?.pass,
    ).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.replacement).toContain("注意力机制");
    expect(proposal?.replacement).toContain("\\citep{vaswani2017attention}");
    expect(proposal?.replacement).toContain("$O(n^2)$");
  });

  it("proposes the best attempt with a note when the output stays mixed (soft language_is)", async () => {
    // The model keeps a few English words every time, so language_is (soft) never
    // clears — but the glossary term and frozen spans are intact. Instead of
    // discarding a usable translation, the closest attempt is proposed.
    const mixed = "注意力机制 is very useful ⟦P0⟧，代价为 ⟦P1⟧（另见 ⟦P2⟧）。";
    const stub = new ScriptedModelAdapter([
      { text: mixed },
      { text: mixed },
      { text: mixed },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "translate",
      selection: { start: sel.start, end: sel.end },
      params: { target_language: "zh" },
      model: stub,
    });
    const lang = result.validators.find((v) => v.type === "language_is");
    expect(lang?.pass).toBe(false);
    expect(lang?.soft).toBe(true);
    // The safety/consistency validators are still hard and still pass.
    expect(
      result.validators.find((v) => v.type === "glossary_consistent")?.pass,
    ).toBe(true);
    expect(
      result.validators.find((v) => v.type === "protected_spans_intact")?.pass,
    ).toBe(true);
    // A proposal is emitted (not discarded), keeping the canonical term.
    expect(result.proposals?.[0]?.replacement).toContain("注意力机制");
  });

  it("a wrong glossary spelling drives a glossary_consistent retry", async () => {
    const stub = new ScriptedModelAdapter([
      // First draft mistranslates the glossary term (uses 自我注意 not 注意力机制).
      { text: "自我注意对序列建模非常有用 ⟦P0⟧，代价为 ⟦P1⟧（另见 ⟦P2⟧）。" },
      { text: zh },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "translate",
      selection: { start: sel.start, end: sel.end },
      params: { target_language: "zh" },
      model: stub,
    });
    expect(result.retries).toBe(1);
    const feedback = stub.requests.at(-1)?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("glossary_consistent");
    expect(feedback?.content).toContain("注意力机制");
    expect(
      result.validators.find((v) => v.type === "glossary_consistent")?.pass,
    ).toBe(true);
  });
});
