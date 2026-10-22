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

describe("M6 acceptance: shrink-to-target hits target±tolerance via the L1 self-check loop", () => {
  const root = join(FIXTURES, "polish-en");

  it("self-checks with count_words, then proposes a within-tolerance rewrite", async () => {
    // Turn 1: the model calls count_words on a candidate. Turn 2: the final,
    // shrunk text — 6 prose words after the frozen tokens are stripped.
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [
          {
            id: "t1",
            name: "count_words",
            args: { text: "Attention mechanisms are useful with cost." },
          },
        ],
      },
      {
        text: "Attention mechanisms are useful ⟦P0⟧ with ⟦P1⟧ cost ⟦P2⟧.",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { target: 6, tolerance: 0.5 },
      model: stub,
    });

    // The L1 self-check happened (2 round-trips) and count_words was offered.
    expect(result.context.level).toBe("L1");
    expect(result.usage.iterations).toBe(2);
    expect(stub.requests[0]?.tools?.map((t) => t.name)).toContain(
      "count_words",
    );

    // word_count passed and a proposal with the frozen tokens thawed was emitted.
    const wc = result.validators.find((v) => v.type === "word_count");
    expect(wc?.pass).toBe(true);
    expect(result.validators.every((v) => v.pass)).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.replacement).toContain("\\citep{vaswani2017attention}");
    expect(proposal?.replacement).toContain("$O(n^2)$");
    expect(proposal?.replacement).toContain("\\ref{sec:intro}");
  });

  it("accepts reduce_by (delta) as the primary input and renders the 'by' prompt", async () => {
    // "Reduce by 1" targets current−1; with a wide tolerance the 6-word draft
    // lands in range. Proves the delta param flows through to word_count (target
    // resolved from the live prose count) and the {{#if params.reduce_by}}
    // prompt branch fires instead of the absolute "shrink to" phrasing.
    const stub = new ScriptedModelAdapter([
      { text: "Attention mechanisms are useful ⟦P0⟧ with ⟦P1⟧ cost ⟦P2⟧." },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { reduce_by: 1, tolerance: 0.9 },
      model: stub,
    });
    expect(result.context.renderedPrompt.user).toContain("by about 1");
    expect(result.context.renderedPrompt.user).not.toContain("Shrink the");
    expect(result.validators.find((v) => v.type === "word_count")?.pass).toBe(
      true,
    );
    expect(result.proposals?.[0]).toBeDefined();
  });

  it("an off-target draft drives a word_count retry_with_feedback", async () => {
    // Turn 1: far too long (12 prose words). Turn 2: on target (6 prose words).
    const stub = new ScriptedModelAdapter([
      {
        text: "Attention mechanisms are still very useful for the sequence modeling task today ⟦P0⟧ ⟦P1⟧ ⟦P2⟧.",
      },
      {
        text: "Attention mechanisms are useful ⟦P0⟧ with ⟦P1⟧ cost ⟦P2⟧.",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { target: 6, tolerance: 0.34 },
      model: stub,
    });
    expect(result.retries).toBe(1);
    const feedback = stub.requests.at(-1)?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("word_count");
    expect(result.validators.find((v) => v.type === "word_count")?.pass).toBe(
      true,
    );
  });
});

/**
 * D1's acceptance gate (ADR 0032), EDIT-1 half: a ~30% reduction that keeps
 * both the numeric claim and the citation. Two mechanisms, both asserted —
 * `numbers_retained` guards the figures, and the citation is a frozen
 * protected span guarded by `protected_spans_intact`.
 */
describe("D1: shrink condenses by rephrasing, not by deleting", () => {
  const root = join(FIXTURES, "shrink-numbers");

  it("proposes a 30%-shorter rewrite that keeps every figure and the citation", async () => {
    // Condensed by nominalizing and cutting hedges — the method the prompt
    // now states — with 94.7, 1,024 and 3 all still present.
    const stub = new ScriptedModelAdapter([
      {
        text: "Our method reaches 94.7⟦P0⟧ accuracy on the held-out split of 1,024 examples, improving substantially over the 3 strongest baselines in prior work ⟦P1⟧; we analyzed the remaining errors.",
      },
    ]);
    const sel = await cursorAt(root, "It is worth noting");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { reduce_by: 18, tolerance: 0.4 },
      model: stub,
    });
    const replacement = result.proposals?.[0]?.replacement ?? "";
    expect(replacement).toContain("94.7");
    expect(replacement).toContain("1,024");
    expect(replacement).toContain("citep{he2015deep}");
    const numbers = result.validators.find(
      (v) => v.type === "numbers_retained",
    );
    expect(numbers?.pass).toBe(true);
    const spans = result.validators.find(
      (v) => v.type === "protected_spans_intact",
    );
    expect(spans?.pass).toBe(true);
  });

  it("proposes the attempt that KEPT the figures, even when the deletion is closer on length", async () => {
    // The finding that made numbers_retained hard on this action (review,
    // Critical 2). The engine picks among candidates by SUMMING soft distances,
    // and word_count's distance is in words while a content guard's counts
    // missing items — so as a soft validator this one could never win. Here
    // attempt 1 hits the length exactly BY DELETING both figures and attempt 2
    // keeps them while overshooting; the milestone's whole point is that
    // attempt 2 ships.
    const kept =
      "Our method reaches 94.7⟦P0⟧ accuracy on 1,024 examples, beating the 3 strongest baselines in prior work ⟦P1⟧, and we analyzed the remaining errors carefully.";
    const stub = new ScriptedModelAdapter([
      { text: "Our method beats the baselines ⟦P0⟧ in prior work ⟦P1⟧." },
      { text: kept },
      // A third turn because the loop retries on ANY failure, soft included,
      // and attempt 2 still misses the (soft) length goal.
      { text: kept },
    ]);
    const sel = await cursorAt(root, "It is worth noting");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { reduce_by: 40, tolerance: 0 },
      model: stub,
    });
    const replacement = result.proposals?.[0]?.replacement ?? "";
    expect(replacement).toContain("94.7");
    expect(replacement).toContain("1,024");
    expect(replacement).not.toContain("beats the baselines");
    expect(result.retries).toBe(2);
    // word_count is still missed — and still soft, so it did not block.
    const words = result.validators.find((v) => v.type === "word_count");
    expect(words?.pass).toBe(false);
    expect(words?.soft).toBe(true);
  });

  it("emits NO proposal when every attempt reaches the target by deleting a result", async () => {
    // Hard, so the honest outcome is "I could not shrink this without deleting
    // a result" rather than a shorter paragraph with the result quietly gone.
    // This is the treatment protected_spans_intact already gives the sibling
    // concern: a shrink that drops a CITATION emits no proposal either.
    const stub = new ScriptedModelAdapter([
      { text: "Our method beats the baselines ⟦P0⟧ in prior work ⟦P1⟧." },
      { text: "Our method beats the baselines ⟦P0⟧ in prior work ⟦P1⟧." },
      { text: "Our method beats the baselines ⟦P0⟧ in prior work ⟦P1⟧." },
    ]);
    const sel = await cursorAt(root, "It is worth noting");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "shrink-to-target",
      selection: { start: sel.start, end: sel.end },
      params: { reduce_by: 18, tolerance: 0.4 },
      model: stub,
    });
    const numbers = result.validators.find(
      (v) => v.type === "numbers_retained",
    );
    expect(numbers?.pass).toBe(false);
    expect(numbers?.soft).toBeUndefined();
    expect(numbers?.reason).toContain("94.7");
    expect(numbers?.reason).toContain("1,024");
    expect(result.proposals).toBeUndefined();
    expect(result.retries).toBe(2);
  });
});
