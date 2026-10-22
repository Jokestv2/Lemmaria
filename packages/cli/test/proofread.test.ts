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

describe("M6: proofread (L0) fixes grammar while preserving protected spans", () => {
  const root = join(FIXTURES, "polish-en");

  it("produces a validated proposal keeping the citation, math, and ref", async () => {
    // Fixes "is"→"are" and "showed"→"shown", keeps all three frozen tokens.
    const stub = new ScriptedModelAdapter([
      {
        text: "Attention mechanisms are very useful for the sequence modeling task, as prior work ⟦P0⟧ has shown, with a cost of ⟦P1⟧ in the sequence length (see also Section~⟦P2⟧).",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "proofread",
      selection: { start: sel.start, end: sel.end },
      model: stub,
    });
    expect(result.context.level).toBe("L0");
    expect(result.usage.iterations).toBe(1);
    expect(result.validators.every((v) => v.pass)).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.replacement).toContain("are very useful");
    expect(proposal?.replacement).toContain("\\citep{vaswani2017attention}");
    expect(proposal?.replacement).toContain("$O(n^2)$");
    expect(proposal?.replacement).toContain("\\ref{sec:intro}");
  });

  it("a dropped token / unbalanced braces drives a retry", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Attention mechanisms are useful but this has {unbalanced." },
      {
        text: "Attention mechanisms are useful ⟦P0⟧ ⟦P1⟧ ⟦P2⟧.",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "proofread",
      selection: { start: sel.start, end: sel.end },
      model: stub,
    });
    expect(result.retries).toBe(1);
    expect(result.validators.every((v) => v.pass)).toBe(true);
  });
});
