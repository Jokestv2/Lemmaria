// M8 CM2 acceptance: the serialized structure tree of a sample multi-file
// paper is a usable repo map — every section present, well under ~1k tokens
// (~4 chars/token ⇒ < 4000 chars).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLatexAdapter } from "@lemmaria/adapters";
import { serializeOutline } from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { FsWorkspace } from "../src/run-action.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("M8 CM2: repo-map serialization on a sample paper", () => {
  it("contains every section and stays under ~1k tokens", async () => {
    const root = join(FIXTURES, "outline");
    const ws = new FsWorkspace(root, "main.tex");
    const adapter = await loadLatexAdapter(ws, "main.tex");
    const map = serializeOutline(await adapter.parseStructure());
    for (const title of [
      "Introduction",
      "Motivation",
      "Related Work",
      "Method",
      "Kernelized Attention",
      "Complexity Analysis",
      "Evaluation",
      "Results",
      "Conclusion",
    ]) {
      expect(map).toContain(title);
    }
    // Cross-file attribution + labels/cites are in the map.
    expect(map).toContain("sections/method.tex");
    expect(map).toContain("labels: sec:intro");
    expect(map).toMatch(/cites: [^\n]*vaswani2017attention/);
    // The CM2 gate: < ~1k tokens serialized (≈ 4 chars/token).
    expect(map.length).toBeLessThan(4000);
  });
});
