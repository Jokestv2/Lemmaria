// M8: fix-compile-error is an AGENTIC L1 fix (ADR 0007) — it navigates to the
// failing region with retrieval tools and emits a TARGETED replace_anchor
// edit, instead of rewriting a host-picked paragraph. The two scenarios below
// are the M6 F5-pass-2 repro cases that motivated the redesign (recorded in
// progress.md → Design deltas → M6 → M8 DEFERRAL).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelAdapter } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { runCliAction } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function splice(
  text: string,
  span: { startOffset: number; endOffset: number },
  replacement: string,
): string {
  return (
    text.slice(0, span.startOffset) + replacement + text.slice(span.endOffset)
  );
}

describe("M8: agentic fix-compile-error (replace_anchor)", () => {
  it("CASE 1 (misreported error line): greps for the typo'd environment and repairs just it", async () => {
    // LaTeX reports \begin{doument} at the \end{document} line (7), far from
    // the defect on line 2. The model must navigate, not trust the line.
    const root = join(FIXTURES, "fix-env-typo");
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "t1", name: "grep_project", args: { query: "doument" } },
        ],
      },
      {
        text: '{"anchor": "\\\\begin{doument}", "replacement": "\\\\begin{document}"}',
      },
    ]);
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "fix-compile-error",
      selection: { start: 0, end: 0 },
      params: {
        warnings:
          "- latex-error (line 7): \\begin{doument} on input line 2 ended by \\end{document}.",
      },
      model: stub,
    });
    expect(result.context.level).toBe("L1");
    // The grep tool executed and reported the typo's real location (line 2).
    const grepResult = stub.requests[1]?.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "t1",
    );
    expect(grepResult?.content).toContain('"line":2');
    // The proposal covers EXACTLY the typo'd token (the M6 no-op case now fixes).
    const proposal = result.proposals?.[0];
    if (!proposal) throw new Error("expected a proposal");
    expect(proposal.contract).toBe("replace_anchor");
    expect(proposal.expectedOriginal).toBe("\\begin{doument}");
    const original = await readFile(join(root, "main.tex"), "utf8");
    expect(
      original.slice(proposal.span.startOffset, proposal.span.endOffset),
    ).toBe("\\begin{doument}");
    const fixed = splice(original, proposal.span, proposal.replacement);
    expect(fixed.match(/\\begin\{document\}/g)).toHaveLength(1);
    expect(fixed.match(/\\end\{document\}/g)).toHaveLength(1);
    expect(fixed).not.toContain("doument");
  });

  it("CASE 2 (runaway brace): reads around the reported line and repairs only the label", async () => {
    // The missing } on \label{sec:intro swallows to EOF; the error reports at
    // the end of the file. The fix must touch ONLY the label, and both
    // document delimiters must survive (the M6 corruption case now fixes).
    const root = join(FIXTURES, "fix-runaway-brace");
    const stub = new ScriptedModelAdapter([
      {
        toolCalls: [
          { id: "t1", name: "read_span", args: { start_line: 1, end_line: 7 } },
        ],
      },
      {
        text: '{"anchor": "\\\\label{sec:intro\\n", "replacement": "\\\\label{sec:intro}\\n"}',
      },
    ]);
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "fix-compile-error",
      selection: { start: 0, end: 0 },
      params: {
        warnings:
          "- tex-error (line 7): Runaway argument? File ended while scanning use of \\label.",
      },
      model: stub,
    });
    const proposal = result.proposals?.[0];
    if (!proposal) throw new Error("expected a proposal");
    expect(proposal.contract).toBe("replace_anchor");
    expect(proposal.expectedOriginal).toBe("\\label{sec:intro\n");
    const original = await readFile(join(root, "main.tex"), "utf8");
    // The span is the label alone, not the enclosing paragraph.
    expect(
      original.slice(proposal.span.startOffset, proposal.span.endOffset),
    ).toBe("\\label{sec:intro\n");
    const fixed = splice(original, proposal.span, proposal.replacement);
    expect(fixed).toContain("\\label{sec:intro}");
    expect(fixed.match(/\\begin\{document\}/g)).toHaveLength(1);
    expect(fixed.match(/\\end\{document\}/g)).toHaveLength(1);
  });

  it("requires the warnings parameter", async () => {
    const root = join(FIXTURES, "fix-env-typo");
    await expect(
      runCliAction({
        root,
        entry: "main.tex",
        actionId: "fix-compile-error",
        selection: { start: 0, end: 0 },
        model: new ScriptedModelAdapter([{ text: "x" }]),
      }),
    ).rejects.toMatchObject({ code: "params_invalid" });
  });
});
