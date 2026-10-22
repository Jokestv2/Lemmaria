import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelAdapter } from "@lemmaria/harness";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { runCliAction } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * A collapsed selection (cursor) inside the paragraph containing `needle` —
 * polish's `scope_fallback: paragraph` then expands it to the enclosing
 * paragraph, the primary "cursor in a paragraph" product flow.
 */
async function cursorAt(root: string, needle: string) {
  const text = await readFile(join(root, "main.tex"), "utf8");
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`fixture is missing: ${needle}`);
  return { start, end: start };
}

describe("M3 acceptance: the CLI runs Polish end to end against the stub model", () => {
  const root = join(FIXTURES, "polish-en");

  it("produces a validated EditProposal (happy path)", async () => {
    // The stub reply keeps all three frozen tokens (\citep, $O(n^2)$, \ref).
    const stub = new ScriptedModelAdapter([
      {
        text: "Attention mechanisms are very useful for sequence modeling, as prior work ⟦P0⟧ has shown, with an ⟦P1⟧ cost in the sequence length (see also Section~⟦P2⟧).",
      },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "polish",
      selection: { start: sel.start, end: sel.end },
      model: stub,
    });
    expect(result.retries).toBe(0);
    expect(result.validators.every((v) => v.pass)).toBe(true);
    const proposal = result.proposals?.[0];
    expect(proposal?.file).toBe("main.tex");
    expect(proposal?.replacement).toContain("\\citep{vaswani2017attention}");
    expect(proposal?.replacement).toContain("$O(n^2)$");
    expect(proposal?.replacement).toContain("\\ref{sec:intro}");
    expect(proposal?.expectedOriginal).toContain("Attention mechanisms is");
    // context wiring: glossary + style + frozen spans reached the prompt
    const prompt = stub.requests[0]?.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("attention mechanism"); // glossary term
    expect(prompt).toContain("active voice"); // PAPER.md style
    expect(prompt).toContain("⟦P0⟧"); // frozen span, not raw
    expect(prompt).not.toContain("\\citep{vaswani2017attention}");
  });

  it("a validator failure drives an observable retry_with_feedback (acceptance)", async () => {
    const stub = new ScriptedModelAdapter([
      { text: "Attention mechanisms are useful, as prior work has shown." }, // dropped all tokens
      { text: "Attention mechanisms are useful ⟦P0⟧ ⟦P1⟧ ⟦P2⟧." },
    ]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    const result = await runCliAction({
      root,
      entry: "main.tex",
      actionId: "polish",
      selection: { start: sel.start, end: sel.end },
      model: stub,
    });
    expect(result.retries).toBe(1);
    expect(result.usage.iterations).toBe(2);
    const feedback = stub.requests[1]?.messages.at(-1);
    expect(feedback?.role).toBe("user");
    expect(feedback?.content).toContain("protected_spans_intact");
    expect(result.proposals?.[0]?.replacement).toContain(
      "\\citep{vaswani2017attention}",
    );
  });

  it("budgets clamp to the global ceilings (acceptance, invariant 5)", async () => {
    const stub = new ScriptedModelAdapter([{ text: "ok ⟦P0⟧ ⟦P1⟧ ⟦P2⟧" }]);
    const sel = await cursorAt(root, "Attention mechanisms is");
    await runCliAction({
      root,
      entry: "main.tex",
      actionId: "polish",
      selection: { start: sel.start, end: sel.end },
      model: stub,
      ceilings: { maxTokens: 512 },
    });
    expect(stub.requests[0]?.maxTokens).toBe(512); // polish asks 4000, ceiling wins
  });

  it("zh fixture: language/unit variables are Chinese (invariant 6)", async () => {
    const zhRoot = join(FIXTURES, "polish-zh");
    const stub = new ScriptedModelAdapter([
      { text: "注意力机制十分有效，代价为 ⟦P0⟧，见 ⟦P1⟧。" },
    ]);
    const sel = await cursorAt(zhRoot, "注意力机制是一种");
    const result = await runCliAction({
      root: zhRoot,
      entry: "main.tex",
      actionId: "polish",
      selection: { start: sel.start, end: sel.end },
      model: stub,
    });
    const prompt = stub.requests[0]?.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("zh");
    expect(prompt).toContain("字");
    expect(result.proposals?.[0]?.replacement).toContain("$O(n^2)$");
  });

  it("loads CM1 memory layers: global MEMORY.md + nearest directory PAPER.md (M8)", async () => {
    const layersRoot = join(FIXTURES, "memory-layers");
    vi.stubEnv("LEMMARIA_MEMORY_DIR", join(layersRoot, "global-home"));
    try {
      const stub = new ScriptedModelAdapter([
        { text: "Attention mechanisms are very good for sequences." },
      ]);
      const text = await readFile(
        join(layersRoot, "chapters", "main.tex"),
        "utf8",
      );
      const start = text.indexOf("Attention mechanisms is");
      await runCliAction({
        root: layersRoot,
        entry: "chapters/main.tex",
        actionId: "polish",
        selection: { start, end: start },
        model: stub,
      });
      const prompt = stub.requests[0]?.messages.at(-1)?.content ?? "";
      // Nearest scope wins: the chapters/PAPER.md style, not the project one.
      expect(prompt).toContain("directory style rule");
      expect(prompt).not.toContain("project style rule");
      // The user-global MEMORY.md glossary survives the merge.
      expect(prompt).toContain("globaltermxyz");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("unknown action id lists the available actions", async () => {
    await expect(
      runCliAction({
        root,
        entry: "main.tex",
        actionId: "nope",
        selection: { start: 0, end: 1 },
        model: new ScriptedModelAdapter([]),
      }),
    ).rejects.toThrow(/nope[\s\S]*polish|polish[\s\S]*nope/);
  });
});

describe("FsWorkspace.listFiles (M8 hardening)", () => {
  it("skips vcs/artifact dirs and honors *.ext globs", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "lemmaria-listfiles-"));
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "chapters"), { recursive: true });
    await writeFile(join(root, ".git", "blob.txt"), "x");
    await writeFile(join(root, "main.tex"), "x");
    await writeFile(join(root, "refs.bib"), "x");
    await writeFile(join(root, "chapters", "eval.tex"), "x");
    const { FsWorkspace } = await import("../src/run-action.js");
    const ws = new FsWorkspace(root);
    expect(await ws.listFiles()).toEqual([
      "chapters/eval.tex",
      "main.tex",
      "refs.bib",
    ]);
    expect(await ws.listFiles("*.tex")).toEqual([
      "chapters/eval.tex",
      "main.tex",
    ]);
  });
});

describe("FsWorkspace path containment (M8 review Critical)", () => {
  // Model-supplied `file` args (read_span, replace_anchor) reach readFile: an
  // escaping path must be refused BEFORE touching the filesystem — the guard
  // fires whether or not the target exists.
  it("readFile/writeWorkingCopy reject parent-escape and absolute paths", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "lemmaria-contain-"));
    await writeFile(join(root, "inside.tex"), "safe");
    const { FsWorkspace } = await import("../src/run-action.js");
    const ws = new FsWorkspace(root);
    expect(await ws.readFile("inside.tex")).toBe("safe");
    await expect(ws.readFile("../outside-secret.txt")).rejects.toThrow(
      /escapes/,
    );
    await expect(
      ws.readFile(join(root, "..", "outside-secret.txt")),
    ).rejects.toThrow(/escapes/);
    await expect(ws.writeWorkingCopy("../x.tex", "y")).rejects.toThrow(
      /escapes/,
    );
  });
});

describe("main (argv smoke)", () => {
  it("reports an unknown flag as usage error instead of throwing", async () => {
    const logs: string[] = [];
    const code = await main(["run", "polish", "--slect", "0:0"], {
      log: (s) => logs.push(s),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/--slect|usage/i);
  });

  it("runs polish via flags and exits 0", async () => {
    const root = join(FIXTURES, "polish-en");
    const text = await readFile(join(root, "main.tex"), "utf8");
    const start = text.indexOf("Attention mechanisms is");
    const logs: string[] = [];
    const code = await main(
      [
        "run",
        "polish",
        "--root",
        root,
        "--entry",
        "main.tex",
        "--select",
        `${start}:${start}`,
        "--stub-text",
        "ok ⟦P0⟧ ⟦P1⟧ ⟦P2⟧",
      ],
      { log: (s) => logs.push(s) },
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain('"retries": 0');
  });
});

describe("FsWorkspace.stat / readBinary (V3, ADR 0080 §8)", () => {
  const setup = async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "lemmaria-wsbin-"));
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "main.tex"), "x");
    await writeFile(join(root, "out", "main.pdf"), Buffer.from("%PDF-1.5\n"));
    const { FsWorkspace } = await import("../src/run-action.js");
    return { root, ws: new FsWorkspace(root) };
  };

  it("stat reports an mtime in MILLISECONDS and a size", async () => {
    const { ws } = await setup();
    const s = await ws.stat("out/main.pdf");
    expect(s?.size).toBe(9);
    // Milliseconds since the epoch, not seconds — the policy compares these
    // directly against a manuscript file's mtime.
    expect(s?.mtimeMs).toBeGreaterThan(1_600_000_000_000);
  });

  it("stat returns undefined for a missing file rather than throwing", async () => {
    const { ws } = await setup();
    expect(await ws.stat("nope.pdf")).toBeUndefined();
    expect(await ws.stat("out/nope.pdf")).toBeUndefined();
  });

  it("readBinary returns the raw bytes", async () => {
    const { ws } = await setup();
    const bytes = await ws.readBinary("out/main.pdf");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("both are ROOT-CONTAINED — a path reaches here from a user setting", async () => {
    const { ws } = await setup();
    const escapes = ["../outside.pdf", "a/../../outside.pdf"];
    for (const p of escapes) {
      await expect(ws.stat(p)).rejects.toThrow();
      await expect(ws.readBinary(p)).rejects.toThrow();
    }
  });
});
