/**
 * M6 regression baseline (architecture Testing Strategy): each MVP built-in
 * action — polish, shrink-to-target, proofread, translate — runs on a fixture
 * against the stub model, and we assert the expected validator outcomes and an
 * emitted proposal. This is the fixture-in → expected-outcome table that guards
 * every action against a regression in one place (the per-action suites cover
 * the tool-loop / retry mechanics in depth).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelAdapter, type ScriptedTurn } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { runCliAction } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function cursorAt(root: string, needle: string) {
  const text = await readFile(join(root, "main.tex"), "utf8");
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`fixture is missing: ${needle}`);
  return { start, end: start };
}

interface Case {
  name: string;
  actionId: string;
  fixture: string;
  needle: string;
  params?: Record<string, unknown>;
  turns: ScriptedTurn[];
  /** Validators expected to run and pass. */
  validators: string[];
  /** A substring the emitted replacement must contain (a preserved protected span). */
  keeps: string[];
}

const CASES: Case[] = [
  {
    name: "polish (L0, en) keeps citation/math/ref",
    actionId: "polish",
    fixture: "polish-en",
    needle: "Attention mechanisms is",
    turns: [
      {
        text: "Attention mechanisms are highly effective for sequence modeling, as prior work ⟦P0⟧ has shown, at an ⟦P1⟧ cost in the sequence length (see Section~⟦P2⟧).",
      },
    ],
    validators: [
      "protected_spans_intact",
      "latex_balanced",
      "no_new_undefined_refs",
    ],
    keeps: ["\\citep{vaswani2017attention}", "$O(n^2)$", "\\ref{sec:intro}"],
  },
  {
    name: "polish (L0, zh) counts by character (invariant 6)",
    actionId: "polish",
    fixture: "polish-zh",
    needle: "注意力机制是一种",
    turns: [{ text: "注意力机制十分有效，其代价为 ⟦P0⟧，见 ⟦P1⟧。" }],
    validators: [
      "protected_spans_intact",
      "latex_balanced",
      "no_new_undefined_refs",
    ],
    keeps: ["$O(n^2)$", "\\citep{vaswani2017attention}"],
  },
  {
    name: "shrink-to-target (L1) hits target via count_words self-check",
    actionId: "shrink-to-target",
    fixture: "polish-en",
    needle: "Attention mechanisms is",
    params: { target: 6, tolerance: 0.5 },
    turns: [
      {
        toolCalls: [{ id: "t1", name: "count_words", args: { text: "draft" } }],
      },
      { text: "Attention mechanisms are useful ⟦P0⟧ with ⟦P1⟧ cost ⟦P2⟧." },
    ],
    validators: [
      "word_count",
      "protected_spans_intact",
      "no_new_undefined_refs",
    ],
    keeps: ["\\citep{vaswani2017attention}", "$O(n^2)$", "\\ref{sec:intro}"],
  },
  {
    name: "proofread (L0) fixes grammar, keeps spans",
    actionId: "proofread",
    fixture: "polish-en",
    needle: "Attention mechanisms is",
    turns: [
      {
        text: "Attention mechanisms are very useful for the sequence modeling task, as prior work ⟦P0⟧ has shown, with a cost of ⟦P1⟧ in the sequence length (see also Section~⟦P2⟧).",
      },
    ],
    validators: [
      "protected_spans_intact",
      "latex_balanced",
      "no_new_undefined_refs",
    ],
    keeps: ["\\citep{vaswani2017attention}", "$O(n^2)$", "\\ref{sec:intro}"],
  },
  {
    name: "translate (L1, en→zh) honors the glossary hard-constraint",
    actionId: "translate",
    fixture: "polish-en",
    needle: "Attention mechanisms is",
    params: { target_language: "zh" },
    turns: [
      {
        toolCalls: [
          {
            id: "t1",
            name: "glossary_lookup",
            args: { term: "attention mechanism" },
          },
        ],
      },
      { text: "注意力机制对序列建模非常有用 ⟦P0⟧，代价为 ⟦P1⟧（另见 ⟦P2⟧）。" },
    ],
    validators: [
      "language_is",
      "glossary_consistent",
      "protected_spans_intact",
    ],
    keeps: ["注意力机制", "\\citep{vaswani2017attention}", "$O(n^2)$"],
  },
];

describe("M6 regression baseline: the four MVP quick actions", () => {
  it.each(CASES)("$name", async (c) => {
    const root = join(FIXTURES, c.fixture);
    const sel = await cursorAt(root, c.needle);
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: c.actionId,
      selection: { start: sel.start, end: sel.end },
      ...(c.params ? { params: c.params } : {}),
      model: new ScriptedModelAdapter(c.turns),
    });

    // Every declared validator ran and passed.
    for (const type of c.validators) {
      const outcome = result.validators.find((v) => v.type === type);
      expect(outcome, `validator ${type} should have run`).toBeDefined();
      expect(outcome?.pass, `${type} should pass`).toBe(true);
    }
    // A proposal was emitted with every protected span preserved.
    const proposal = result.proposals?.[0];
    expect(proposal, "a proposal should be emitted").toBeDefined();
    for (const keep of c.keeps) {
      expect(proposal?.replacement).toContain(keep);
    }
    expect(result.stoppedBy).toBe("complete");
  });
});
