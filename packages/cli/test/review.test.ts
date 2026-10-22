import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelAdapter } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { runCliAction } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const root = join(FIXTURES, "polish-en");

const ANSWER = JSON.stringify({
  annotations: [
    {
      dimension: "language",
      severity: "minor",
      anchor: "Attention mechanisms is very useful",
      message: "Subject–verb agreement: 'mechanisms is' should be plural.",
    },
    {
      dimension: "language",
      severity: "major",
      anchor: "They has been adopted",
      message: "Subject–verb agreement.",
      suggestion: "They have been adopted",
    },
  ],
});

async function cursorAt(needle: string) {
  const text = await readFile(join(root, "main.tex"), "utf8");
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`fixture is missing: ${needle}`);
  return { start, end: start };
}

describe("M9: review (single model) produces anchored annotations and writes nothing", () => {
  it("locates annotations in the real fixture through the real LatexAdapter", async () => {
    const before = await readFile(join(root, "main.tex"), "utf8");
    const sel = await cursorAt("Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "review",
      selection: { start: sel.start, end: sel.end },
      model: new ScriptedModelAdapter([{ text: ANSWER }]),
    });
    expect(result.kind).toBe("review");
    expect(result.proposals).toBeUndefined();
    const anns = result.review?.annotations;
    expect(anns).toHaveLength(2);
    expect(anns?.[0]).toMatchObject({
      reviewer: "writing",
      dimension: "language",
      severity: "minor",
      span: { file: "main.tex", line: 6 },
    });
    expect(anns?.[1]?.span).toMatchObject({ file: "main.tex", line: 10 });
    expect(anns?.[1]?.suggestedEdit).toEqual({
      original: "They has been adopted",
      replacement: "They have been adopted",
    });
    // Read-only: the fixture on disk is byte-identical after the run.
    const after = await readFile(join(root, "main.tex"), "utf8");
    expect(after).toBe(before);
  });

  it("the argv entrypoint prints the review JSON and exits 0", async () => {
    const sel = await cursorAt("Attention mechanisms is");
    const lines: string[] = [];
    const code = await main(
      [
        "run",
        "review",
        "--root",
        root,
        "--entry",
        "main.tex",
        "--select",
        `${sel.start}:${sel.end}`,
        "--stub-text",
        ANSWER,
      ],
      { log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.review.annotations).toHaveLength(2);
    expect(parsed.proposals).toBeUndefined();
  });
});
