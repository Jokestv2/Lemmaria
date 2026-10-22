import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedSpansForFile } from "@lemmaria/adapters";
import {
  ScriptedModelAdapter,
  type SessionEditHost,
  SessionStore,
  type ToolName,
  runSessionTask,
} from "@lemmaria/harness";
import { afterAll, describe, expect, it } from "vitest";

/**
 * D1's acceptance gate (ADR 0032), end to end.
 *
 * This lives in `@lemmaria/cli` because it is the only package that sees BOTH
 * the harness and the adapters — the harness cannot import the adapters
 * (invariant 1's dependency direction), so a harness-side test could only ever
 * exercise a stub detector. Here the REAL `protectedSpansIn` meets the REAL
 * `runSessionTask`, which is the pair production wires together.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function mkStore(): Promise<SessionStore> {
  const dir = mkdtempSync(join(tmpdir(), "lemmaria-d1-"));
  dirs.push(dir);
  return new SessionStore(dir);
}

const binding = {
  protocol: "anthropic" as const,
  endpoint: "https://example.invalid",
  model: "claude-sonnet-4-5",
  apiKey: "k",
};

/** The production wiring itself — not a copy of it (One home per fact). */
const protectedSpans = protectedSpansForFile;

function editHost(files: Record<string, string>): {
  host: SessionEditHost;
  files: Record<string, string>;
} {
  const host: SessionEditHost = {
    policy: () => "auto_apply",
    readFile: async (f) => files[f],
    writeFile: async (f, c) => {
      files[f] = c;
    },
    fileExists: async (f) => files[f] !== undefined,
    requestDecisions: async () => undefined,
  };
  return { host, files };
}

const proposeCall = (
  id: string,
  edits: Record<string, unknown>[],
): { id: string; name: ToolName; args: unknown } => ({
  id,
  name: "propose_edit",
  args: { edits },
});

describe("D1 acceptance gate — an agentic polish cannot touch protected content", () => {
  const ANCHOR =
    "The method converges quickly. % TODO: cite the convergence proof\nWe observe $O(n \\log n)$ scaling, matching \\cite{he2015}.";
  const SOURCE = `\\section{Results}\n${ANCHOR}\nFurther discussion follows.\n`;

  it("refuses a polish that rewrites the comment, the math and the citation away", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor: ANCHOR,
              // The reported failure: "polish the first sentence" also
              // polishes the comment, the math and the citation.
              replacement:
                "The method converges rapidly, and we observe log-linear scaling consistent with prior work.",
            },
          ]),
        ],
      },
      { text: "I could not apply that edit." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "polish the first sentence",
      editHost: host,
      protectedSpans,
    });

    expect(result.status).toBe("completed");
    // The whole point: the file is byte-identical.
    expect(files["main.tex"]).toBe(SOURCE);
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    expect(
      proposal?.type === "edit_proposal" && proposal.edits[0]?.status,
    ).toBe("invalid");
    // The refusal names what was lost and how to proceed, in ONE language
    // (ADR 0034) — the escape being the declaration, not D1's anchor trick.
    const note =
      proposal?.type === "edit_proposal" ? proposal.edits[0]?.note : undefined;
    expect(note).toMatch(/protected content cannot be dropped silently/);
    expect(note).toMatch(/removes_protected/);
    expect(note).not.toMatch(/[一-鿿]/);
  });

  it("applies the corrected proposal that reproduces all three verbatim", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const polished =
      "The method converges rapidly. % TODO: cite the convergence proof\nWe observe $O(n \\log n)$ scaling, in line with \\cite{he2015}.";
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "main.tex", anchor: ANCHOR, replacement: polished },
          ]),
        ],
      },
      { text: "Polished the sentence." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "polish the first sentence",
      editHost: host,
      protectedSpans,
    });

    expect(files["main.tex"]).toBe(SOURCE.replace(ANCHOR, polished));
    // Each protected construct survived byte-for-byte.
    expect(files["main.tex"]).toContain("% TODO: cite the convergence proof");
    expect(files["main.tex"]).toContain("$O(n \\log n)$");
    expect(files["main.tex"]).toContain("\\cite{he2015}");
  });

  it("REFUSES a bare anchor-is-the-span edit — D1's carve-out is withdrawn (ADR 0033)", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor: "\\cite{he2015}",
              replacement: "\\cite{he2016}",
            },
          ]),
        ],
      },
      { text: "I could not apply that edit." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "the correct key is he2016",
      editHost: host,
      protectedSpans,
    });
    // Unchanged: the route D1 left open is closed at the loop level, not just
    // in the pure rule. Without this the two-edit batch from the operator's
    // step 4 would still get through.
    expect(files["main.tex"]).toBe(SOURCE);
  });

  it("lets the model change a citation when it DECLARES the removal", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor: "\\cite{he2015}",
              replacement: "\\cite{he2016}",
              removes_protected: ["\\cite{he2015}"],
            },
          ]),
        ],
      },
      { text: "Updated the citation key." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "the correct key is he2016",
      editHost: host,
      protectedSpans,
    });
    expect(files["main.tex"]).toContain("\\cite{he2016}");
    expect(files["main.tex"]).not.toContain("\\cite{he2015}");
  });

  /**
   * The two scenarios the operator drove by hand on D1, as tests (X2 plan,
   * acceptance gate item 2). Both were reported as failures; both are now the
   * specified behaviour, and neither is reachable by the route D1 left open.
   */
  it("operator step 4: 'drop the leftover TODO' applies in ONE declared edit", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor: ANCHOR,
              replacement:
                "The method converges quickly.\nWe observe $O(n \\log n)$ scaling, matching \\cite{he2015}.",
              removes_protected: ["% TODO: cite the convergence proof"],
            },
          ]),
        ],
      },
      { text: "Rewrote the opening and dropped the TODO." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "rewrite the opening block and drop the leftover TODO note",
      editHost: host,
      protectedSpans,
    });
    // The user asked for the removal, so the removal happens — in ONE edit,
    // declared, rather than through a two-edit batch that hid the intent.
    expect(files["main.tex"]).not.toContain("% TODO");
    // And the content nobody asked about is still byte-for-byte intact.
    expect(files["main.tex"]).toContain("$O(n \\log n)$");
    expect(files["main.tex"]).toContain("\\cite{he2015}");
  });

  it("operator step 7: 'no formula and no citation' removes BOTH when declared", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "main.tex",
              anchor:
                "We observe $O(n \\log n)$ scaling, matching \\cite{he2015}.",
              replacement:
                "We observe scaling that grows a little faster than the input size.",
              removes_protected: ["$O(n \\log n)$", "\\cite{he2015}"],
            },
          ]),
        ],
      },
      { text: "Rewrote it as plain prose." },
    ]);
    const { host, files } = editHost({ "main.tex": SOURCE });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "rewrite that sentence as plain prose: no formula and no citation",
      editHost: host,
      protectedSpans,
    });
    // D1 kept the formula and reported it as "required by the editor". The
    // user asked for it gone; it is gone, and the declaration is on the record.
    expect(files["main.tex"]).not.toContain("$O(n \\log n)$");
    expect(files["main.tex"]).not.toContain("\\cite{he2015}");
    expect(files["main.tex"]).toContain("grows a little faster");
  });

  it("guards a Markdown paper's fenced code and pandoc citation too", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const anchor = "We follow the standard setup [@smith2020].";
    const source = `# Method\n\n${anchor}\n`;
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "draft.md",
              anchor,
              replacement: "We follow the standard setup.",
            },
          ]),
        ],
      },
      { text: "could not apply" },
    ]);
    const { host, files } = editHost({ "draft.md": source });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "tighten the sentence",
      editHost: host,
      protectedSpans,
    });
    expect(files["draft.md"]).toBe(source);
  });

  it("enforces nothing for a file no adapter covers — honest degradation", async () => {
    const store = await mkStore();
    const session = await store.create({ title: "d1", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "notes.txt",
              anchor: "keep % this",
              replacement: "changed",
            },
          ]),
        ],
      },
      { text: "done" },
    ]);
    const { host, files } = editHost({ "notes.txt": "keep % this\n" });
    await runSessionTask({
      store,
      session,
      model,
      binding,
      text: "edit the note",
      editHost: host,
      protectedSpans,
    });
    expect(files["notes.txt"]).toBe("changed\n");
  });
});

/**
 * X3's acceptance gate (ADR 0036), end to end, through the same real pair.
 *
 * Every case below was MEASURED against the shipped code on 2026-08-13 and
 * passed with no refusal, reaching disk under `auto_apply`. They are the ones
 * the offline tests could not see, because D1's suites only ever asked whether
 * an OUTERMOST span survived.
 */
describe("X3 acceptance gate — content nested inside a container is protected", () => {
  /** Runs one proposal and reports what reached disk. */
  async function propose(
    file: string,
    source: string,
    edit: Record<string, unknown>,
    text = "polish that sentence",
  ): Promise<{ after: string; status: string | undefined; note?: string }> {
    const store = await mkStore();
    const session = await store.create({ title: "x3", workspace: "/w" });
    const model = new ScriptedModelAdapter([
      { toolCalls: [proposeCall("c1", [{ file, ...edit }])] },
      { text: "done" },
    ]);
    const { host, files } = editHost({ [file]: source });
    const result = await runSessionTask({
      store,
      session,
      model,
      binding,
      text,
      editHost: host,
      protectedSpans,
    });
    const proposal = result.items.find((i) => i.type === "edit_proposal");
    const row =
      proposal?.type === "edit_proposal" ? proposal.edits[0] : undefined;
    return {
      after: files[file] ?? "",
      status: row?.status,
      note: row?.note,
    };
  }

  it("refuses dropping a FORMULA from inside \\textbf{}", async () => {
    const source = "The \\textbf{value $x^2$ here} matters.\n";
    const out = await propose("main.tex", source, {
      anchor: "The \\textbf{value $x^2$ here} matters.",
      replacement: "The \\textbf{value here} matters.",
    });
    expect(out.status).toBe("invalid");
    expect(out.after).toBe(source);
    expect(out.note).toContain("$x^2$");
  });

  it("refuses dropping a CITATION from inside \\footnote{}", async () => {
    const source =
      "Text\\footnote{See \\cite{smith2020} for more.} continues.\n";
    const out = await propose("main.tex", source, {
      anchor: "Text\\footnote{See \\cite{smith2020} for more.} continues.",
      replacement: "Text\\footnote{See more.} continues.",
    });
    expect(out.status).toBe("invalid");
    expect(out.after).toBe(source);
  });

  it("refuses dropping a \\label{} from inside \\section{}", async () => {
    const source = "\\section{The \\label{sec:x} bit}\n";
    const out = await propose("main.tex", source, {
      anchor: "\\section{The \\label{sec:x} bit}",
      replacement: "\\section{The bit}",
    });
    expect(out.status).toBe("invalid");
    expect(out.after).toBe(source);
  });

  it("refuses dropping the INNER command of a nested markup pair", async () => {
    const source =
      "We record the \\textbf{\\emph{measurement decision}} here.\n";
    const out = await propose("main.tex", source, {
      anchor: "We record the \\textbf{\\emph{measurement decision}} here.",
      replacement: "We record the \\textbf{measurement decision} here.",
    });
    expect(out.status).toBe("invalid");
    expect(out.after).toBe(source);
  });

  it("APPLIES the same edit once the inner command is declared", async () => {
    // The other half of the operator's report: an explicit "drop the bold"
    // must be expressible. The model declares the balanced text it read, and
    // that is now the text the matcher accepts.
    const source =
      "We record the \\textbf{\\emph{measurement decision}} here.\n";
    const out = await propose(
      "main.tex",
      source,
      {
        anchor: "We record the \\textbf{\\emph{measurement decision}} here.",
        replacement: "We record the \\emph{measurement decision} here.",
        removes_protected: ["\\textbf{\\emph{measurement decision}}"],
      },
      "drop the bold from measurement decision, keep the italics",
    );
    expect(out.status).not.toBe("invalid");
    expect(out.after).toBe(
      "We record the \\emph{measurement decision} here.\n",
    );
  });

  it("still lets an ordinary polish rewrite a container's PROSE", async () => {
    // The false-refusal direction. X3 adds strictness, and D1's review found
    // every validator finding was a false positive on ordinary prose, so the
    // liveable case has to be pinned beside the refusals.
    const source = "The method \\textbf{stops working} on long inputs.\n";
    const out = await propose("main.tex", source, {
      anchor: "The method \\textbf{stops working} on long inputs.",
      replacement: "The method \\textbf{fails} on long inputs.",
    });
    expect(out.status).not.toBe("invalid");
    expect(out.after).toBe("The method \\textbf{fails} on long inputs.\n");
  });

  describe("protection no longer depends on how wide an anchor the model chose", () => {
    const SOURCE = [
      "\\begin{itemize}",
      "\\item \\textbf{the cost} in final test accuracy;",
      "\\item the wall-clock time;",
      "\\end{itemize}",
      "",
    ].join("\n");

    it("refuses the \\textbf{} drop with the single \\item as the anchor", async () => {
      const out = await propose("main.tex", SOURCE, {
        anchor: "\\item \\textbf{the cost} in final test accuracy;",
        replacement: "\\item the cost in final test accuracy;",
      });
      expect(out.status).toBe("invalid");
      expect(out.after).toBe(SOURCE);
    });

    it("refuses it with the whole itemize as the anchor too", async () => {
      // Pre-X3 this PASSED: with the wide anchor the `\item` span swallowed the
      // `\textbf{}`, which then was not a span at all. Whether protection
      // applied was a property of a choice the model made turn by turn.
      const anchor = SOURCE.trimEnd();
      const out = await propose("main.tex", SOURCE, {
        anchor,
        replacement: anchor.replace("\\textbf{the cost}", "the cost"),
      });
      expect(out.status).toBe("invalid");
      expect(out.after).toBe(SOURCE);
    });
  });

  it("guards a Markdown heading whose text holds a formula", async () => {
    const source = "## Results for $x^2$ here\n\nBody text.\n";
    const out = await propose("draft.md", source, {
      anchor: "## Results for $x^2$ here",
      replacement: "Results for $x^2$ here",
    });
    expect(out.status).toBe("invalid");
    expect(out.after).toBe(source);
  });
});
