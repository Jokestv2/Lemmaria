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

describe("A5: expand grows a passage through the L1 self-check loop", () => {
  const root = join(FIXTURES, "polish-en");

  it("self-checks with count_words, then proposes a longer passage with the protected spans intact", async () => {
    // Turn 1: the model checks a candidate's length. Turn 2: the expanded text,
    // reproducing each frozen token exactly once.
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "t1",
            name: "count_words",
            args: { text: "a candidate expansion of the passage" },
          },
        ],
      },
      {
        text:
          "Attention mechanisms are very useful for the sequence modeling task, as prior " +
          "work ⟦P0⟧ has shown, with a cost of ⟦P1⟧ in the sequence length (see also " +
          "Section~⟦P2⟧). The quadratic term dominates once the sequence grows long, " +
          "which is why the surrounding discussion treats length as the binding constraint.",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "expand",
      selection: { start: sel.start, end: sel.end },
      // A wide tolerance: this test is about the loop and the contract, not
      // about a stub hitting a word target on the nose.
      params: { add_words: 20, tolerance: 0.9 },
      model: stub,
    });

    // The L1 self-check happened and count_words was the offered tool.
    expect(result.context.level).toBe("L1");
    expect(result.usage.iterations).toBe(2);
    expect(stub.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "count_words",
    ]);

    // The prompt asks for the DELTA and reports the live current length, which
    // is what grow_by resolves its target against.
    expect(result.context.renderedPrompt.user).toContain("by about 20");
    const current = /current length: (\d+)/.exec(
      result.context.renderedPrompt.user,
    );
    expect(current).not.toBeNull();
    expect(Number(current?.[1])).toBeGreaterThan(0);

    // Every validator passed and the frozen spans came back thawed and verbatim.
    expect(result.validators.find((v) => v.type === "word_count")?.pass).toBe(
      true,
    );
    expect(result.validators.every((v) => v.pass)).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.replacement).toContain("\\citep{vaswani2017attention}");
    expect(proposal?.replacement).toContain("$O(n^2)$");
    expect(proposal?.replacement).toContain("\\ref{sec:intro}");
    expect(proposal?.replacement).toContain("binding constraint");
  });

  it("a draft that stays short retries, and the soft word_count still proposes the closest attempt", async () => {
    // Every turn comes back far below current+20, so word_count never passes.
    // Because it is SOFT (the M6 rule: a length goal is a soft goal), the run
    // must still surface the closest attempt instead of discarding everything.
    const short = { text: "Attention is useful ⟦P0⟧ ⟦P1⟧ ⟦P2⟧." };
    const stub = new ScriptedModelAdapter([short, short, short]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "expand",
      selection: { start: sel.start, end: sel.end },
      params: { add_words: 20, tolerance: 0.1 },
      model: stub,
    });

    expect(result.retries).toBeGreaterThanOrEqual(1);
    const feedback = stub.requests.at(-1)?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("word_count");
    const wc = result.validators.find((v) => v.type === "word_count");
    expect(wc?.pass).toBe(false);
    expect(wc?.soft).toBe(true);
    // It must fail for being SHORT, not for an unresolved target — the reason
    // names the produced count and the grow_by-derived target (current 26 + 20).
    expect(wc?.reason).toMatch(/target 46/);
    expect(wc?.reason).not.toMatch(/missing\/invalid target/);
    // Soft failure ⇒ a proposal is still offered (with the miss recorded above).
    expect(result.proposals?.[0]?.replacement).toContain(
      "\\citep{vaswani2017attention}",
    );
  });
});
