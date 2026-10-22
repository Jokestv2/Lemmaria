import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/engine/context.js";
import {
  FILE,
  TEXT,
  baseAction,
  fakeAdapter,
  fakeWorkspace,
} from "./fake-adapter.js";

describe("buildContext", () => {
  const targetAt = TEXT.indexOf("Target paragraph");

  it("freezes protected spans and declares every §5 variable", async () => {
    const ctx = await buildContext({
      action: {
        ...baseAction,
        context: {
          neighbors: 1,
          include_glossary: true,
          protected_spans: "freeze",
        },
      },
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
      memory: {
        project:
          "## Glossary\n| Term | 中文 | Abbrev |\n|-|-|-|\n| self-attention | 自注意力 | — |\n",
      },
    });
    expect(ctx.unit.text).toContain("Target paragraph");
    expect(ctx.vars.selection).toContain("⟦P0⟧");
    expect(ctx.vars.selection).not.toContain("\\citep");
    expect(ctx.vars.selection_raw).toContain("\\citep{v17}");
    expect(ctx.vars.language).toBe("en");
    expect(ctx.vars.unit).toBe("words");
    expect((ctx.vars.counts as { current: number }).current).toBeGreaterThan(0);
    expect((ctx.vars.neighbors as { before: string }).before).toContain(
      "First paragraph before.",
    );
    expect((ctx.vars.neighbors as { after: string }).after).toContain(
      "After paragraph one.",
    );
    expect(ctx.vars.glossary).toContain("self-attention");
    expect(ctx.vars.section).toBe("Intro");
    expect(ctx.vars.venue).toBe(""); // fake adapter has no documentClass()
    expect(ctx.vars.doc).toEqual({ kind: "latex" });
    expect(ctx.vars.profile).toEqual({
      contribution: "",
      audience: "",
      claims: "",
      outline: "",
      style: "",
      venue: "",
    });
    expect(ctx.knownLabels.has("sec:intro")).toBe(true);
    expect(ctx.knownCitations.has("v17")).toBe(true);
  });

  it("seeds knownCitations with bib-defined keys (M7 no_new_undefined_refs gap)", async () => {
    const adapter = fakeAdapter();
    adapter.citations = () =>
      Promise.resolve([{ key: "bibonly", fields: { title: "Only In Bib" } }]);
    const ctx = await buildContext({
      action: baseAction,
      adapter,
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
    });
    // A \cite to a bib-defined key is "known" even though it isn't cited yet.
    expect(ctx.knownCitations.has("bibonly")).toBe(true);
    // The in-document citation is still known.
    expect(ctx.knownCitations.has("v17")).toBe(true);
  });

  it("merges CM1 memory layers, nearest scope winning (M8)", async () => {
    const ctx = await buildContext({
      action: {
        ...baseAction,
        context: {
          include_glossary: true,
          include_profile: ["style"],
        },
      },
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
      memory: {
        global:
          "## Style\n- global style\n\n## Glossary\n| Term | 中文 | Abbrev |\n|-|-|-|\n| foo | 全局 | — |\n| bar | 条 | — |\n",
        project: "## Style\n- project style",
        directory:
          "## Glossary\n| Term | 中文 | Abbrev |\n|-|-|-|\n| foo | 目录 | — |\n",
      },
    });
    const profile = ctx.vars.profile as { style: string };
    expect(profile.style).toBe("- project style");
    expect(ctx.vars.glossary).toContain("目录"); // nearest wins per term
    expect(ctx.vars.glossary).not.toContain("全局");
    expect(ctx.vars.glossary).toContain("bar"); // farther entries survive
  });

  it("renders {{venue}} from the adapter's documentClass (M10)", async () => {
    const adapter = fakeAdapter();
    adapter.documentClass = () => ({ name: "acmart", options: ["sigconf"] });
    const ctx = await buildContext({
      action: baseAction,
      adapter,
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
    });
    expect(ctx.vars.venue).toBe("acmart");
  });

  it("falls back to scope_fallback on an empty selection", async () => {
    const ctx = await buildContext({
      action: {
        ...baseAction,
        input: { scope: "selection", scope_fallback: "paragraph" },
      },
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt },
      params: {},
    });
    expect(ctx.unit.scope).toBe("paragraph");
  });

  it("enforces min_chars / max_chars", async () => {
    const opts = {
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
    };
    await expect(
      buildContext({
        ...opts,
        action: { ...baseAction, input: { min_chars: 10_000 } },
      }),
    ).rejects.toMatchObject({ code: "input_too_short" });
    await expect(
      buildContext({
        ...opts,
        action: { ...baseAction, input: { max_chars: 3 } },
      }),
    ).rejects.toMatchObject({ code: "input_too_long" });
  });

  it("omits glossary/profile/outline unless the action asks (empty strings, still declared)", async () => {
    const ctx = await buildContext({
      action: baseAction,
      adapter: fakeAdapter(),
      workspace: fakeWorkspace(),
      selection: { file: FILE, startOffset: targetAt, endOffset: targetAt + 4 },
      params: {},
      memory: {
        project:
          "## Glossary\n| Term | 中文 | Abbrev |\n|-|-|-|\n| x | y | z |\n",
      },
    });
    expect(ctx.vars.glossary).toBe("");
    expect(ctx.vars.outline).toBe("");
  });
});
