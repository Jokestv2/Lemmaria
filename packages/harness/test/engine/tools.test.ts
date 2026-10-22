import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WordCount } from "../../src/contracts/adapters.js";
import type { CitationResult, Warning } from "../../src/contracts/data.js";
import type { GrantedRoot } from "../../src/contracts/sessions.js";
import type { OutlineNode, ToolName } from "../../src/contracts/tools.js";
import { ALL_TOOL_NAMES } from "../../src/contracts/tools.js";
import { mockSource } from "../../src/engine/citation-lookup.js";
import { canonicalizeGrantRoot } from "../../src/engine/grants.js";
import type { LiteratureProvider } from "../../src/engine/literature.js";
import type { GlossaryEntry } from "../../src/engine/paper.js";
import {
  GRANT_READ_MAX_BYTES,
  READ_SPAN_MAX_PROTECTED,
  buildToolRegistry,
} from "../../src/engine/tools.js";
import { unwrap, unwrapErr } from "../support/results.js";

/** Minimal countWords stand-in: EN by whitespace words, CN by CJK char. */
const countWords = (text: string): WordCount => {
  const cjk = (text.match(/\p{Script=Han}/gu) ?? []).length;
  if (cjk > 0) return { language: "zh", unit: "字", count: cjk };
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  return { language: "en", unit: "words", count: words };
};
const adapter = { countWords };

const glossary: GlossaryEntry[] = [
  { term: "self-attention", zh: "自注意力", abbrev: "" },
  { term: "multi-head attention", zh: "多头注意力", abbrev: "MHA" },
];

describe("buildToolRegistry", () => {
  it("count_words counts English words via the adapter", async () => {
    const reg = buildToolRegistry({
      tools: ["count_words"],
      adapter,
      glossary: [],
    });
    const tool = reg.get("count_words");
    expect(tool?.category).toBe("analysis");
    expect(unwrap(await tool?.invoke({ text: "one two three" }))).toEqual({
      unit: "words",
      count: 3,
    });
  });

  it("count_words counts Chinese characters via the adapter", async () => {
    const reg = buildToolRegistry({
      tools: ["count_words"],
      adapter,
      glossary: [],
    });
    expect(
      unwrap(await reg.get("count_words")?.invoke({ text: "自注意力机制" })),
    ).toEqual({
      unit: "字",
      count: 6,
    });
  });

  it("count_words rejects missing/invalid text", async () => {
    const reg = buildToolRegistry({
      tools: ["count_words"],
      adapter,
      glossary: [],
    });
    // ADR 0024: a bad argument is an `invalid` failure, never a throw.
    for (const args of [{}, { text: 7 }]) {
      const error = unwrapErr(await reg.get("count_words")?.invoke(args));
      expect(error.code).toBe("invalid");
      expect(error.message).toMatch(/text/);
    }
  });

  it("glossary_lookup returns matching canonical entries (case-insensitive)", async () => {
    const reg = buildToolRegistry({
      tools: ["glossary_lookup"],
      adapter,
      glossary,
    });
    const tool = reg.get("glossary_lookup");
    expect(tool?.category).toBe("retrieval");
    expect(unwrap(await tool?.invoke({ term: "Attention" }))).toEqual([
      { term: "self-attention", zh: "自注意力", abbrev: "" },
      { term: "multi-head attention", zh: "多头注意力", abbrev: "MHA" },
    ]);
  });

  it("glossary_lookup returns an empty list when nothing matches", async () => {
    const reg = buildToolRegistry({
      tools: ["glossary_lookup"],
      adapter,
      glossary,
    });
    expect(
      unwrap(await reg.get("glossary_lookup")?.invoke({ term: "transformer" })),
    ).toEqual([]);
  });

  it("glossary_lookup rejects missing term", async () => {
    const reg = buildToolRegistry({
      tools: ["glossary_lookup"],
      adapter,
      glossary,
    });
    const error = unwrapErr(await reg.get("glossary_lookup")?.invoke({}));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/term/);
  });

  it("exposes a ToolSpec (name/description/params) for each registered tool", () => {
    const reg = buildToolRegistry({
      tools: ["count_words", "glossary_lookup"],
      adapter,
      glossary,
    });
    for (const name of ["count_words", "glossary_lookup"] as const) {
      const spec = reg.get(name)?.spec;
      expect(spec?.name).toBe(name);
      expect(typeof spec?.description).toBe("string");
      expect(spec?.parameters).toMatchObject({ type: "object" });
    }
  });

  it("omits tools whose backing data is absent (e.g. read_span without a workspace)", () => {
    const reg = buildToolRegistry({
      tools: ["count_words", "read_span"],
      adapter,
      glossary,
    });
    expect(reg.has("count_words")).toBe(true);
    expect(reg.has("read_span")).toBe(false);
  });

  const citations = {
    citedKeys: ["ghost", "real"],
    entries: [{ key: "real", fields: { title: "Real" }, file: "refs.bib" }],
    entryFile: "main.tex",
  };

  it("citation_check runs C1 always (analysis, no C2 source)", async () => {
    const reg = buildToolRegistry({
      tools: ["citation_check"],
      adapter,
      glossary: [],
      citations,
    });
    const tool = reg.get("citation_check");
    expect(tool?.category).toBe("analysis");
    const result = unwrap(await tool?.invoke({})) as {
      consistency: Warning[];
      metadata?: CitationResult[];
    };
    expect(result.consistency.map((w) => w.code)).toContain(
      "undefined-citation",
    );
    expect(result.metadata).toBeUndefined();
  });

  it("citation_check also runs C2 when sources are supplied", async () => {
    const reg = buildToolRegistry({
      tools: ["citation_check"],
      adapter,
      glossary: [],
      citations: {
        ...citations,
        entries: [
          {
            key: "real",
            fields: { doi: "10/x", year: "2020" },
            file: "refs.bib",
          },
        ],
        sources: [mockSource("crossref", () => ({ year: "2020" }))],
      },
    });
    const result = unwrap(await reg.get("citation_check")?.invoke({})) as {
      consistency: Warning[];
      metadata?: CitationResult[];
    };
    expect(result.metadata?.[0]).toMatchObject({ key: "real", status: "ok" });
  });

  it("list_citations returns bib keys + metadata (retrieval)", async () => {
    const reg = buildToolRegistry({
      tools: ["list_citations"],
      adapter,
      glossary: [],
      citations,
    });
    const tool = reg.get("list_citations");
    expect(tool?.category).toBe("retrieval");
    expect(unwrap(await tool?.invoke({}))).toEqual([
      { key: "real", fields: { title: "Real" } },
    ]);
  });

  it("omits citation tools when no citation data is supplied", () => {
    const reg = buildToolRegistry({
      tools: ["citation_check", "list_citations"],
      adapter,
      glossary: [],
    });
    expect(reg.has("citation_check")).toBe(false);
    expect(reg.has("list_citations")).toBe(false);
  });

  // ── M8 CM3 retrieval tools ──────────────────────────────────────────────

  const outline: OutlineNode[] = [
    {
      title: "Introduction",
      file: "main.tex",
      startLine: 1,
      endLine: 4,
      wordCount: 12,
      labels: ["sec:intro"],
      citations: ["smith2020"],
      children: [
        {
          title: "Motivation",
          file: "main.tex",
          startLine: 3,
          endLine: 4,
          wordCount: 5,
          labels: ["sec:motivation"],
          citations: [],
          children: [],
        },
      ],
    },
  ];
  const files = new Map<string, string>([
    ["main.tex", "line one\nline two\nline three\nline four\n"],
    ["refs.bib", "@article{smith2020, title={X}}\n"],
    ["notes.txt", "smith2020 appears HERE too\n"],
  ]);
  const workspace = {
    readFile: (p: string) => {
      const content = files.get(p);
      if (content === undefined) return Promise.reject(new Error("no file"));
      return Promise.resolve(content);
    },
    listFiles: (glob?: string) =>
      Promise.resolve(
        [...files.keys()].filter(
          (f) =>
            glob === undefined || f.endsWith(glob.replace(/^\*+\/?\*?/, "")),
        ),
      ),
  };

  it("get_outline returns the serialized CM2 map (retrieval, gated on outline)", async () => {
    const reg = buildToolRegistry({
      tools: ["get_outline"],
      adapter,
      glossary: [],
      outline,
    });
    const tool = reg.get("get_outline");
    expect(tool?.category).toBe("retrieval");
    const result = unwrap(await tool?.invoke({})) as { outline: string };
    expect(result.outline).toContain(
      "- Introduction [main.tex:1-4, 12w] labels: sec:intro cites: smith2020",
    );
    expect(result.outline).toContain("  - Motivation");
    // absent without an outline
    const bare = buildToolRegistry({
      tools: ["get_outline"],
      adapter,
      glossary: [],
    });
    expect(bare.has("get_outline")).toBe(false);
  });

  const retrievalReg = () =>
    buildToolRegistry({
      tools: ["read_span", "grep_project", "list_labels"],
      adapter,
      glossary: [],
      outline,
      workspace,
      defaultFile: "main.tex",
    });

  it("read_span reads a line range of the default file (retrieval)", async () => {
    const tool = retrievalReg().get("read_span");
    expect(tool?.category).toBe("retrieval");
    expect(unwrap(await tool?.invoke({ start_line: 2, end_line: 3 }))).toEqual({
      file: "main.tex",
      start_line: 2,
      end_line: 3,
      text: "line two\nline three",
    });
  });

  it("read_span resolves a section by title (case-insensitive)", async () => {
    const result = unwrap(
      await retrievalReg().get("read_span")?.invoke({ section: "motivation" }),
    ) as { file: string; text: string };
    expect(result.file).toBe("main.tex");
    expect(result.text).toBe("line three\nline four");
  });

  it("read_span truncates an oversized range at 300 lines, and states the totals (B4)", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `L${i + 1}`).join("\n");
    const reg = buildToolRegistry({
      tools: ["read_span"],
      adapter,
      glossary: [],
      outline,
      workspace: {
        readFile: () => Promise.resolve(big),
        listFiles: () => Promise.resolve([]),
      },
      defaultFile: "big.tex",
    });
    const result = unwrap(
      await reg.get("read_span")?.invoke({ start_line: 1, end_line: 400 }),
    ) as {
      end_line: number;
      text: string;
      truncated: boolean;
      truncated_by: string;
      total_lines: number;
      shown_lines: number;
    };
    expect(result.end_line).toBe(300);
    expect(result.text).toContain("L300");
    expect(result.text).not.toContain("L301");
    // B4 replaces the bare "… [truncated]" glued onto the source text with
    // structured facts. Gluing prose into file content was its own defect: a
    // read_span result can become a propose_edit anchor.
    expect(result.text.endsWith("L300")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.truncated_by).toBe("lines");
    expect(result.total_lines).toBe(400);
    expect(result.shown_lines).toBe(300);
  });

  it("read_span leaves a result that fits byte-identical, with no truncation fields (B4)", async () => {
    // The 99 % case must not grow a single key — the `capToolResult` rule,
    // applied one layer down.
    const result = unwrap(
      await retrievalReg()
        .get("read_span")
        ?.invoke({ start_line: 2, end_line: 3 }),
    );
    expect(Object.keys(result as object).sort()).toEqual([
      "end_line",
      "file",
      "start_line",
      "text",
    ]);
  });

  it("read_span does not claim a truncation when the range ends on a blank line (B4 review)", async () => {
    // The regression guard for review Critical 1. `split("\n")` leaves a
    // phantom element for a file that ends in a newline; the truncation
    // primitive deliberately does not count it. Comparing the two line models
    // made the ORDINARY read-to-end-of-file report truncated: true — the exact
    // dishonesty this milestone exists to remove — and under-reported
    // `end_line` by one, so a model chaining `start_line: end_line + 1`
    // re-read a line.
    const reg = (body: string) =>
      buildToolRegistry({
        tools: ["read_span"],
        adapter,
        glossary: [],
        outline,
        workspace: {
          readFile: () => Promise.resolve(body),
          listFiles: () => Promise.resolve([]),
        },
        defaultFile: "f.tex",
      });

    const wholeFile = unwrap(
      await reg("one\ntwo\nthree\nfour\n")
        .get("read_span")
        ?.invoke({ start_line: 1, end_line: 999 }),
    ) as Record<string, unknown>;
    expect(wholeFile.truncated).toBeUndefined();
    expect(wholeFile.end_line).toBe(4);
    expect(wholeFile.text).toBe("one\ntwo\nthree\nfour");

    // A paragraph terminated by a blank line — the common LaTeX/Markdown case.
    const paragraph = unwrap(
      await reg("para one\n\npara two\n")
        .get("read_span")
        ?.invoke({ start_line: 1, end_line: 2 }),
    ) as Record<string, unknown>;
    expect(paragraph.truncated).toBeUndefined();
    expect(paragraph.end_line).toBe(2);

    // An empty file must not produce end_line 0 — the contract is 1-based, and
    // read_span(1, 0) is rejected as an invalid range.
    const empty = unwrap(
      await reg("").get("read_span")?.invoke({ start_line: 1, end_line: 1 }),
    ) as Record<string, unknown>;
    expect(empty.truncated).toBeUndefined();
    expect(empty.end_line).toBe(1);
    expect(empty.text).toBe("");
  });

  it("read_span budgets CN and EN by the same COST, not by characters (B4, invariant 6)", async () => {
    // Before B4 the second limit was 12 000 CHARACTERS, so a Chinese paper got
    // ~4× the context spend of an English one for the same call. The token
    // measure equalises the cost; it does not equalise the character count.
    const cn = Array.from({ length: 400 }, () => "实验结果表明该方法有效").join(
      "\n",
    );
    const reg = buildToolRegistry({
      tools: ["read_span"],
      adapter,
      glossary: [],
      outline,
      workspace: {
        readFile: () => Promise.resolve(cn),
        listFiles: () => Promise.resolve([]),
      },
      defaultFile: "big.tex",
    });
    const result = unwrap(
      await reg.get("read_span")?.invoke({ start_line: 1, end_line: 400 }),
    ) as { truncated: boolean; truncated_by: string; total_lines: number };
    expect(result.truncated).toBe(true);
    expect(result.truncated_by).toBe("tokens");
    expect(result.total_lines).toBe(400);
  });

  it("read_span rejects an unknown section and missing args, with codes", async () => {
    const tool = retrievalReg().get("read_span");
    // A section that does not exist is `not_found`; a malformed call is
    // `invalid` — two different repairs, so two different codes (ADR 0024).
    const unknownSection = unwrapErr(await tool?.invoke({ section: "nope" }));
    expect(unknownSection.code).toBe("not_found");
    expect(unknownSection.message).toMatch(/section/);
    const noArgs = unwrapErr(await tool?.invoke({}));
    expect(noArgs.code).toBe("invalid");
    expect(noArgs.message).toMatch(/section|line/);
    const badRange = unwrapErr(
      await tool?.invoke({ start_line: 5, end_line: 2 }),
    );
    expect(badRange.code).toBe("invalid");
    expect(badRange.message).toMatch(/range/i);
  });

  it("read_span rejects a file argument that escapes the workspace root", async () => {
    const tool = retrievalReg().get("read_span");
    // The capability boundary said no (invariant 2) — `denied`, the code that
    // tells the model retrying the same path cannot help.
    for (const file of ["../secrets.txt", "C:/Users/me/.ssh/id_rsa"]) {
      const error = unwrapErr(
        await tool?.invoke({ file, start_line: 1, end_line: 2 }),
      );
      expect(error.code, file).toBe("denied");
      expect(error.message, file).toMatch(/escapes/);
    }
  });

  it("grep_project finds literal matches across text files (case-insensitive)", async () => {
    const tool = retrievalReg().get("grep_project");
    expect(tool?.category).toBe("retrieval");
    const result = unwrap(await tool?.invoke({ query: "SMITH2020" })) as {
      matches: Array<{ file: string; line: number; text: string }>;
      truncated: boolean;
    };
    expect(result.truncated).toBe(false);
    // listFiles order is preserved (real workspaces return sorted paths).
    expect(result.matches).toEqual([
      { file: "refs.bib", line: 1, text: "@article{smith2020, title={X}}" },
      { file: "notes.txt", line: 1, text: "smith2020 appears HERE too" },
    ]);
  });

  it("grep_project honors a glob filter and rejects a 1-char query", async () => {
    const tool = retrievalReg().get("grep_project");
    const result = unwrap(
      await tool?.invoke({
        query: "smith2020",
        glob: "*.bib",
      }),
    ) as { matches: Array<{ file: string }> };
    expect(result.matches.map((m) => m.file)).toEqual(["refs.bib"]);
    const error = unwrapErr(await tool?.invoke({ query: "x" }));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/query/);
  });

  it("grep_project caps at 50 matches and reports truncation", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `hit line ${i}`).join(
      "\n",
    );
    const reg = buildToolRegistry({
      tools: ["grep_project"],
      adapter,
      glossary: [],
      workspace: {
        readFile: () => Promise.resolve(many),
        listFiles: () => Promise.resolve(["big.tex"]),
      },
    });
    const result = unwrap(
      await reg.get("grep_project")?.invoke({
        query: "hit",
      }),
    ) as { matches: unknown[]; truncated: boolean; total_matches: number };
    expect(result.matches).toHaveLength(50);
    expect(result.truncated).toBe(true);
    // B4: the real count, not "at least 50". Before this the scan broke out on
    // the 50th hit, so nothing anywhere knew how much had been passed over.
    expect(result.total_matches).toBe(60);
  });

  it("grep_project MARKS a match line it cut, instead of cutting it silently (B4)", async () => {
    const long = `prefix ${"z".repeat(500)} needle`;
    const reg = buildToolRegistry({
      tools: ["grep_project"],
      adapter,
      glossary: [],
      workspace: {
        readFile: () => Promise.resolve(long),
        listFiles: () => Promise.resolve(["big.tex"]),
      },
    });
    const result = unwrap(
      await reg.get("grep_project")?.invoke({ query: "prefix" }),
    ) as { matches: Array<{ text: string }>; total_matches: number };
    const text = result.matches[0]?.text ?? "";
    expect(text).toMatch(/truncated/);
    expect(text.startsWith("prefix")).toBe(true);
    expect(result.total_matches).toBe(1);
  });

  it("grep_project skips non-text extensions", async () => {
    const reg = buildToolRegistry({
      tools: ["grep_project"],
      adapter,
      glossary: [],
      workspace: {
        readFile: () => Promise.resolve("needle"),
        listFiles: () => Promise.resolve(["figure.pdf", "doc.tex"]),
      },
    });
    const result = unwrap(
      await reg.get("grep_project")?.invoke({
        query: "needle",
      }),
    ) as { matches: Array<{ file: string }> };
    expect(result.matches.map((m) => m.file)).toEqual(["doc.tex"]);
  });

  it("list_labels flattens every label with file + owning section (retrieval)", async () => {
    const tool = retrievalReg().get("list_labels");
    expect(tool?.category).toBe("retrieval");
    expect(unwrap(await tool?.invoke({}))).toEqual([
      { label: "sec:intro", file: "main.tex", section: "Introduction" },
      { label: "sec:motivation", file: "main.tex", section: "Motivation" },
    ]);
  });

  it("read_span is absent without a workspace", () => {
    const reg = buildToolRegistry({
      tools: ["read_span"],
      adapter,
      glossary: [],
      outline,
    });
    expect(reg.has("read_span")).toBe(false);
  });
});

describe("granted-root read tools (A4, ADR 0019)", () => {
  const temps: string[] = [];
  afterAll(async () => {
    for (const d of temps) await rm(d, { recursive: true, force: true });
  });

  /** A real temp "codebase" granted root. */
  function grantFixture(): GrantedRoot {
    const dir = mkdtempSync(join(tmpdir(), "lemmaria-tool-grant-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "train.py"),
      "def load(path):\n    return 42\n",
    );
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "run.log"), "noise");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, "results.csv"), "a,b\n1,2");
    return { id: "g1", path: canonicalizeGrantRoot(dir), label: "codebase" };
  }

  const workspace = {
    readFile: async (rel: string) => `content of ${rel}`,
    listFiles: async () => ["main.tex", "refs.bib"],
  };

  function grantedRegistry(grants: () => GrantedRoot[]) {
    return buildToolRegistry({
      tools: ["list_files", "read_span", "grep_project"],
      adapter,
      glossary: [],
      outline: [],
      workspace,
      defaultFile: "main.tex",
      grants,
    });
  }

  it("list_files without root lists the paper workspace", async () => {
    const reg = grantedRegistry(() => []);
    const result = unwrap(await reg.get("list_files")?.invoke({})) as {
      root: string;
      files: string[];
    };
    expect(result.root).toBe("workspace");
    expect(result.files).toEqual(["main.tex", "refs.bib"]);
  });

  it("list_files reports the file total it already knew and used to discard (B4)", async () => {
    const many = Array.from({ length: 600 }, (_, i) => `f${i}.tex`);
    const reg = buildToolRegistry({
      tools: ["list_files"],
      adapter,
      glossary: [],
      workspace: {
        readFile: async () => "",
        listFiles: async () => many,
      },
    });
    const result = unwrap(await reg.get("list_files")?.invoke({})) as {
      files: string[];
      truncated: boolean;
      total_files: number;
    };
    expect(result.files).toHaveLength(500);
    expect(result.truncated).toBe(true);
    // `truncated: true` alone cannot tell the model whether it is missing ten
    // files or ten thousand — the difference between narrowing and giving up.
    expect(result.total_files).toBe(600);
  });

  it("list_files over a granted root respects gitignore and counts denied files", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    const result = unwrap(
      await reg.get("list_files")?.invoke({ root: "g1" }),
    ) as {
      root: string;
      files: string[];
      excludedByDefault: number;
    };
    expect(result.root).toBe("g1");
    expect(result.files).toContain("src/train.py");
    expect(result.files).toContain("results.csv");
    expect(result.files.some((f) => f.endsWith("run.log"))).toBe(false);
    expect(result.files.some((f) => f.endsWith(".env"))).toBe(false);
    expect(result.excludedByDefault).toBe(1);
  });

  it("an unknown or revoked root id fails as `refused`, honestly", async () => {
    const g = grantFixture();
    const live: GrantedRoot[] = [g];
    const reg = grantedRegistry(() => live);
    const unknown = unwrapErr(
      await reg.get("list_files")?.invoke({ root: "g9" }),
    );
    expect(unknown.code).toBe("refused");
    expect(unknown.message).toMatch(/no such granted root/i);
    live.length = 0; // revoked mid-task: the getter is live
    const revoked = unwrapErr(
      await reg.get("read_span")?.invoke({
        root: "g1",
        file: "src/train.py",
        start_line: 1,
        end_line: 2,
      }),
    );
    expect(revoked.code).toBe("refused");
    expect(revoked.message).toMatch(/no such granted root/i);
  });

  it("read_span reads a granted file by explicit lines", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    const result = unwrap(
      await reg.get("read_span")?.invoke({
        root: "g1",
        file: "src/train.py",
        start_line: 1,
        end_line: 2,
      }),
    ) as { text?: string };
    expect(result.text).toContain("def load(path):");
  });

  it("read_span fails escapes (both slash styles) and denied files as `denied`", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    for (const file of ["../out.txt", "..\\out.txt"]) {
      const error = unwrapErr(
        await reg.get("read_span")?.invoke({
          root: "g1",
          file,
          start_line: 1,
          end_line: 1,
        }),
      );
      expect(error.code, file).toBe("denied");
      expect(error.message, file).toMatch(/escape/i);
    }
    const denied = unwrapErr(
      await reg.get("read_span")?.invoke({
        root: "g1",
        file: ".env",
        start_line: 1,
        end_line: 1,
      }),
    );
    expect(denied.code).toBe("denied");
    expect(denied.message).toMatch(/excluded by default/i);
  });

  it("a missing file under a granted root fails as `not_found`", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    const error = unwrapErr(
      await reg
        .get("read_span")
        ?.invoke({ root: "g1", file: "nope.txt", start_line: 1, end_line: 1 }),
    );
    // Distinct from `denied`: the path was allowed, the file simply is not
    // there — the model should look elsewhere, not give up on the root.
    expect(error.code).toBe("not_found");
    expect(error.message).toMatch(/no such file/i);
  });

  it("an oversized granted file fails as `too_large`", async () => {
    const g = grantFixture();
    writeFileSync(
      join(g.path, "huge.csv"),
      "x".repeat(GRANT_READ_MAX_BYTES + 1),
    );
    const reg = grantedRegistry(() => [g]);
    const error = unwrapErr(
      await reg
        .get("read_span")
        ?.invoke({ root: "g1", file: "huge.csv", start_line: 1, end_line: 1 }),
    );
    expect(error.code).toBe("too_large");
    expect(error.message).toMatch(/too large/i);
  });

  it("read_span on a granted root requires explicit lines, not a section", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    const error = unwrapErr(
      await reg
        .get("read_span")
        ?.invoke({ root: "g1", section: "Introduction" }),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/section/i);
  });

  it("grep_project searches a granted root's code files", async () => {
    const g = grantFixture();
    const reg = grantedRegistry(() => [g]);
    const result = unwrap(
      await reg.get("grep_project")?.invoke({
        root: "g1",
        query: "def load",
      }),
    ) as {
      matches: { file: string; line: number; text: string }[];
      filesTruncated: boolean;
    };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ file: "src/train.py", line: 1 });
    // Honesty: when the walk saw every file, say so.
    expect(result.filesTruncated).toBe(false);
  });

  it("grep_project reports when the granted-root file scan was truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lemmaria-grep-cap-"));
    temps.push(dir);
    // Past GRANT_WALK_MAX_FILES (500), the walk stops early — grep must say so
    // rather than let "no match" masquerade as a whole-tree fact.
    for (let i = 0; i < 520; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.py`), "x\n");
    }
    const g: GrantedRoot = {
      id: "g1",
      path: canonicalizeGrantRoot(dir),
      label: "big",
    };
    const reg = grantedRegistry(() => [g]);
    const result = unwrap(
      await reg.get("grep_project")?.invoke({
        root: "g1",
        query: "nothing-here",
      }),
    ) as { filesTruncated: boolean };
    expect(result.filesTruncated).toBe(true);
    // This test writes and walks 600+ real files; on a loaded machine it has
    // come within a whisker of vitest's 5 s default and flaked the suite. The
    // assertions are unchanged — only the clock is given honest room (A6).
  }, 20_000);

  it("literature_search is offered only with providers, budgets per session, and never throws (A4)", async () => {
    let calls = 0;
    const provider: LiteratureProvider = {
      name: "crossref",
      endpoint: "https://api.crossref.org",
      search: async () => {
        calls += 1;
        return {
          kind: "ok",
          results: [
            {
              title: "Attention Is All You Need",
              authors: ["Vaswani"],
              year: "2017",
              doi: "10.1/x",
              source: "crossref",
            },
          ],
        };
      },
    };
    const without = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
    });
    expect(without.get("literature_search")).toBeUndefined();

    const budget = { remaining: 1 };
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: { providers: [provider], budget },
    });
    const tool = reg.get("literature_search");
    expect(tool?.category).toBe("retrieval");
    const first = unwrap(await tool?.invoke({ query: "attention" })) as {
      results: { title: string }[];
      sources: { name: string; status: string }[];
    };
    expect(first.results[0]?.title).toBe("Attention Is All You Need");
    expect(first.sources[0]).toMatchObject({ name: "crossref", status: "ok" });
    // Budget exhausted: an honest `too_large`, and the provider is NOT called again.
    const second = unwrapErr(await tool?.invoke({ query: "attention" }));
    expect(second.code).toBe("too_large");
    expect(second.message).toMatch(/budget/i);
    expect(calls).toBe(1);
    // Missing query: a coded failure, never a throw.
    const noQuery = unwrapErr(await tool?.invoke({}));
    expect(noQuery.code).toBe("invalid");
    expect(noQuery.message).toMatch(/query/i);
  });

  it("literature_search reports rate_limited and failures as per-source data", async () => {
    const limited: LiteratureProvider = {
      name: "semantic_scholar",
      endpoint: "https://api.semanticscholar.org/graph/v1",
      search: async () => ({ kind: "rate_limited", retryAfterS: 12 }),
    };
    const boom: LiteratureProvider = {
      name: "dblp",
      endpoint: "https://dblp.org/search/publ/api",
      search: async () => {
        throw new Error("conn reset");
      },
    };
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: { providers: [limited, boom] },
    });
    const result = unwrap(
      await reg.get("literature_search")?.invoke({
        query: "resnet",
        max_results: 3,
      }),
    ) as {
      results: unknown[];
      sources: { name: string; status: string; retryAfterS?: number }[];
    };
    expect(result.results).toEqual([]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        name: "semantic_scholar",
        status: "rate_limited",
        retryAfterS: 12,
      }),
      expect.objectContaining({ name: "dblp", status: "failed" }),
    ]);
  });

  it("a retry inside one call spends the session budget once (R8/O6)", async () => {
    // The seam may ask a host three times; the USER asked once. Invariant 5:
    // the dedicated budget only ever clamps further, so a politeness retry
    // must never be charged to it.
    let calls = 0;
    const flaky: LiteratureProvider = {
      name: "crossref",
      endpoint: "https://api.crossref.org",
      search: async () => {
        calls += 1;
        // No Retry-After, so the wait is the policy's own first backoff — the
        // Crossref case, which publishes no header.
        return calls === 1
          ? { kind: "rate_limited" }
          : { kind: "ok", results: [] };
      },
    };
    const budget = { remaining: 1 };
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: { providers: [flaky], budget },
    });
    const result = unwrap(
      await reg.get("literature_search")?.invoke({ query: "resnet" }),
    ) as { sources: { status: string; attempts?: number }[] };

    expect(calls).toBe(2);
    expect(result.sources[0]).toMatchObject({ status: "ok", attempts: 2 });
    expect(budget.remaining).toBe(0);
  }, 15_000);

  it("literature_search's description says the seam is polite (R8/O8)", () => {
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: {
        providers: [
          {
            name: "crossref",
            endpoint: "https://api.crossref.org",
            search: async () => ({ kind: "ok", results: [] }),
          },
        ],
      },
    });
    const description = reg.get("literature_search")?.spec.description ?? "";
    expect(description).toContain(
      "paced per host and retried with backoff when it asks to be",
    );
    // R4's own two sentences are untouched.
    expect(description).toContain("merged by taking turns across the sources");
    expect(description).toContain(
      "rate-limited or failed sources are reported per source",
    );
  });

  it("literature_search's query description says an exact title comes first (R4)", () => {
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: {
        providers: [
          {
            name: "crossref",
            endpoint: "https://api.crossref.org",
            search: async () => ({ kind: "ok", results: [] }),
          },
        ],
      },
    });
    const params = reg.get("literature_search")?.spec.parameters as {
      properties: { query: { description: string } };
    };
    expect(params.properties.query.description).toBe(
      "Title words, topic, or author keywords; an exact title or a DOI returns that paper first when any source has it.",
    );
  });

  it("a grants-only registry (no paper) offers the read tools; workspace paths refuse honestly", async () => {
    const g = grantFixture();
    const reg = buildToolRegistry({
      tools: ["list_files", "read_span", "grep_project"],
      adapter,
      glossary: [],
      grants: () => [g],
    });
    expect(reg.has("list_files")).toBe(true);
    expect(reg.has("read_span")).toBe(true);
    expect(reg.has("grep_project")).toBe(true);
    // Granted reads work without any paper workspace…
    const read = unwrap(
      await reg.get("read_span")?.invoke({
        root: "g1",
        file: "src/train.py",
        start_line: 1,
        end_line: 1,
      }),
    ) as { text?: string };
    expect(read.text).toContain("def load");
    // …while workspace-path calls fail as `refused` data, never crashing.
    const noWs = unwrapErr(await reg.get("list_files")?.invoke({}));
    expect(noWs.code).toBe("refused");
    expect(noWs.message).toMatch(/workspace/i);
    const noWsRead = unwrapErr(
      await reg.get("read_span")?.invoke({ start_line: 1, end_line: 1 }),
    );
    expect(noWsRead.code).toBe("refused");
    expect(noWsRead.message).toMatch(/workspace/i);
    const noWsGrep = unwrapErr(
      await reg.get("grep_project")?.invoke({ query: "def load" }),
    );
    expect(noWsGrep.code).toBe("refused");
    expect(noWsGrep.message).toMatch(/workspace/i);
  });

  it("advertises the root argument only when a grant is actually live", () => {
    // The session host ALWAYS passes a grants getter, so gating the advertised
    // parameter on the getter's existence advertised `root` in every session —
    // pointing at a "granted-folders list" the prompt only emits when a grant
    // exists. The model was shown an argument whose documentation was missing.
    const withGrants = grantedRegistry(() => [grantFixture()]);
    for (const name of ["list_files", "read_span", "grep_project"] as const) {
      expect(
        JSON.stringify(withGrants.get(name)?.spec.parameters),
        name,
      ).toContain('"root"');
    }
    const granted0 = grantedRegistry(() => []);
    for (const name of ["list_files", "read_span", "grep_project"] as const) {
      expect(
        JSON.stringify(granted0.get(name)?.spec.parameters),
        name,
      ).not.toContain('"root"');
    }
    const without = buildToolRegistry({
      tools: ["read_span", "grep_project"],
      adapter,
      glossary: [],
      outline: [],
      workspace,
      defaultFile: "main.tex",
    });
    expect(
      JSON.stringify(without.get("read_span")?.spec.parameters),
    ).not.toContain('"root"');
    expect(without.get("list_files")).toBeUndefined();
  });

  it('accepts the "workspace" root id the tools themselves report', async () => {
    // `list_files` has always ANSWERED with `root: "workspace"`, so a model
    // that lists files and then reads one passes that value straight back —
    // and used to be refused for a grant that never existed. What the tools
    // report is now what they take.
    const reg = grantedRegistry(() => [grantFixture()]);
    const listed = unwrap(
      await reg.get("list_files")?.invoke({ root: "workspace" }),
    ) as { root: string; files: string[] };
    expect(listed.root).toBe("workspace");
    expect(listed.files).toEqual(["main.tex", "refs.bib"]);

    const read = unwrap(
      await reg.get("read_span")?.invoke({
        root: "workspace",
        file: "main.tex",
        start_line: 1,
        end_line: 1,
      }),
    ) as { file: string; text: string };
    expect(read.file).toBe("main.tex");
    expect(read.text).toContain("content of main.tex");

    const grepped = unwrap(
      await reg
        .get("grep_project")
        ?.invoke({ root: "workspace", query: "content" }),
    ) as { matches: unknown[] };
    expect(grepped.matches.length).toBeGreaterThan(0);
  });

  it("a live grant always wins over the reserved workspace id", async () => {
    // Ids are machine-minted (`g1`, `g2`, …) so this cannot happen in practice,
    // but the reservation must never be able to shadow a real capability.
    const g = { ...grantFixture(), id: "workspace" };
    const reg = grantedRegistry(() => [g]);
    const result = unwrap(
      await reg.get("list_files")?.invoke({ root: "workspace" }),
    ) as { root: string; files: string[] };
    expect(result.files).toContain("src/train.py");
    expect(result.files).not.toContain("refs.bib");
  });

  it("an unknown root tells the model how to reach the paper workspace", async () => {
    const reg = grantedRegistry(() => [grantFixture()]);
    const err = unwrapErr(await reg.get("list_files")?.invoke({ root: "g9" }));
    expect(err.code).toBe("refused");
    expect(err.message).toMatch(/omit .*root|paper workspace/i);
  });
});

describe("execution mode declarations (B3, ADR 0025)", () => {
  const outline: OutlineNode[] = [
    {
      title: "Introduction",
      file: "main.tex",
      startLine: 1,
      endLine: 2,
      wordCount: 4,
      labels: ["sec:intro"],
      citations: [],
      children: [],
    },
  ];
  const workspace = {
    readFile: () => Promise.resolve("one\ntwo\n"),
    listFiles: () => Promise.resolve(["main.tex"]),
  };

  /** Every tool this registry can build, with everything it needs supplied. */
  const fullRegistry = () =>
    buildToolRegistry({
      tools: [
        "count_words",
        "glossary_lookup",
        "get_outline",
        "list_labels",
        "read_span",
        "grep_project",
        "list_files",
        "literature_search",
        "citation_check",
        "list_citations",
      ],
      adapter,
      glossary,
      outline,
      workspace,
      citations: { citedKeys: [], entries: [], entryFile: "refs.bib" },
      literature: { providers: [] },
    });

  /**
   * Session-scoped tools, injected by the loop and never built here — the
   * complement `buildToolRegistry` is responsible for. Derived from
   * `ALL_TOOL_NAMES` rather than hand-listed, so a tool added to the allowlist
   * must be classified as one or the other before this suite passes.
   */
  const SESSION_SCOPED: readonly ToolName[] = [
    "update_plan",
    "propose_edit",
    "run_script",
    "spawn_subtask",
    // B7 (ADR 0028): loop-injected, because the loaded skill set is per-session
    // host state the engine registry has no access to.
    "load_skill",
    // V3 (ADR 0080): built per review from an opened PdfDocument, which this
    // registry has no access to — and in V3 no production path builds it at all.
    "view_pdf_pages",
    // Quick-action surface: allowlisted, but never built by this registry.
    "apply_edit",
    "verify",
  ];

  it("buildToolRegistry NEVER builds view_pdf_pages, even asked for every name (V3, O8)", () => {
    // It is built from an opened PdfDocument, which this registry has no
    // access to — and in V3 no production path builds it at all.
    const reg = fullRegistry();
    expect(reg.has("view_pdf_pages")).toBe(false);
  });

  it("every tool the registry can build declares `parallel` (B3 D1)", () => {
    // Derived, not hand-listed: a tool added to ALL_TOOL_NAMES and built here
    // without an `executionMode` would otherwise inherit D1's sequential
    // default silently. This makes classifying it a decision someone has to
    // take, not one they can miss.
    const expected = ALL_TOOL_NAMES.filter(
      (n) => !SESSION_SCOPED.includes(n),
    ).sort();
    const reg = fullRegistry();
    expect([...reg.keys()].sort()).toEqual(expected);
    for (const [name, tool] of reg) {
      expect(`${name}:${tool.executionMode}`).toBe(`${name}:parallel`);
    }
  });

  it("none of them is a mutation tool — buildToolRegistry is the read surface", () => {
    for (const [name, tool] of fullRegistry()) {
      expect(`${name}:${tool.category}`).not.toContain(":mutation");
    }
  });
});

/**
 * D1 (ADR 0032): `read_span` MARKS the protected regions inside the slice it
 * returns, so the rule the write path enforces is one the model can see rather
 * than one it is asked to remember. The reader is injected — the harness cannot
 * import `@lemmaria/adapters` (the dependency runs the other way), and a host
 * that wires none degrades to no marking at all.
 */
describe("read_span protected-region marking (D1)", () => {
  const outline: OutlineNode[] = [
    {
      title: "Introduction",
      file: "main.tex",
      startLine: 1,
      endLine: 4,
      wordCount: 12,
      labels: [],
      citations: [],
      children: [],
    },
  ];

  /** A stand-in for the real fragment detector: `%` comments and `$…$` math. */
  const stubReader = (_file: string, text: string) => {
    const spans = [];
    for (const m of text.matchAll(/%[^\n]*/g)) {
      spans.push({
        file: _file,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        kind: "comment" as const,
        token: `⟦P${spans.length}⟧`,
        raw: m[0],
      });
    }
    for (const m of text.matchAll(/\$[^$\n]+\$/g)) {
      spans.push({
        file: _file,
        startOffset: m.index,
        endOffset: m.index + m[0].length,
        kind: "math" as const,
        token: `⟦P${spans.length}⟧`,
        raw: m[0],
      });
    }
    return Promise.resolve(spans);
  };

  const source = [
    "Ordinary prose line.",
    "We observe $O(n^2)$ growth. % TODO: double-check",
    "Another $O(n^2)$ mention, same math.",
    "Plain closing line.",
  ].join("\n");

  const reg = (protectedSpans?: typeof stubReader) =>
    buildToolRegistry({
      tools: ["read_span"],
      adapter,
      glossary: [],
      outline,
      workspace: {
        readFile: () => Promise.resolve(source),
        listFiles: () => Promise.resolve([]),
      },
      defaultFile: "main.tex",
      ...(protectedSpans ? { protectedSpans } : {}),
    });

  it("reports the protected regions in the slice, deduplicated", async () => {
    const result = unwrap(
      await reg(stubReader).get("read_span")?.invoke({
        start_line: 1,
        end_line: 4,
      }),
    ) as { protected?: Array<{ kind: string; text: string }> };
    expect(result.protected).toEqual(
      expect.arrayContaining([
        { kind: "comment", text: "% TODO: double-check" },
        { kind: "math", text: "$O(n^2)$" },
      ]),
    );
    // The same math appears twice in the slice; the model needs the identity
    // once, and paying tokens for a repeat teaches it nothing.
    expect(result.protected?.filter((p) => p.text === "$O(n^2)$")).toHaveLength(
      1,
    );
  });

  it("never alters `text` — a propose_edit anchor is quoted from it", async () => {
    const marked = unwrap(
      await reg(stubReader).get("read_span")?.invoke({
        start_line: 1,
        end_line: 4,
      }),
    ) as { text: string };
    const bare = unwrap(
      await reg().get("read_span")?.invoke({ start_line: 1, end_line: 4 }),
    ) as { text: string };
    expect(marked.text).toBe(bare.text);
    expect(marked.text).toBe(source);
  });

  it("adds NO key at all without a reader wired (the B4 byte-identical rule)", async () => {
    const result = unwrap(
      await reg().get("read_span")?.invoke({ start_line: 1, end_line: 2 }),
    );
    expect(Object.keys(result as object).sort()).toEqual([
      "end_line",
      "file",
      "start_line",
      "text",
    ]);
  });

  it("adds NO key when the slice holds no protected content", async () => {
    const result = unwrap(
      await reg(stubReader).get("read_span")?.invoke({
        start_line: 1,
        end_line: 1,
      }),
    );
    expect(Object.keys(result as object)).not.toContain("protected");
  });

  it("caps the list and states the honest total", async () => {
    const many = Array.from(
      { length: READ_SPAN_MAX_PROTECTED + 5 },
      (_, i) => `line $x_{${i}}$ here`,
    ).join("\n");
    const result = unwrap(
      await buildToolRegistry({
        tools: ["read_span"],
        adapter,
        glossary: [],
        outline,
        workspace: {
          readFile: () => Promise.resolve(many),
          listFiles: () => Promise.resolve([]),
        },
        defaultFile: "main.tex",
        protectedSpans: stubReader,
      })
        .get("read_span")
        ?.invoke({ start_line: 1, end_line: READ_SPAN_MAX_PROTECTED + 5 }),
    ) as { protected?: unknown[]; protected_total?: number };
    expect(result.protected).toHaveLength(READ_SPAN_MAX_PROTECTED);
    expect(result.protected_total).toBe(READ_SPAN_MAX_PROTECTED + 5);
  });

  it("a reader that rejects costs the read nothing", async () => {
    const result = unwrap(
      await buildToolRegistry({
        tools: ["read_span"],
        adapter,
        glossary: [],
        outline,
        workspace: {
          readFile: () => Promise.resolve(source),
          listFiles: () => Promise.resolve([]),
        },
        defaultFile: "main.tex",
        protectedSpans: () => Promise.reject(new Error("parser exploded")),
      })
        .get("read_span")
        ?.invoke({ start_line: 1, end_line: 4 }),
    ) as { text: string; protected?: unknown };
    expect(result.text).toBe(source);
    expect(result.protected).toBeUndefined();
  });
});

/**
 * V2 (ADR 0078 §5, O12): the withholding holder is read at CALL time.
 *
 * It has to be. `ToolExecutor.invoke(args)` takes no context, and `runChild`
 * hands every child the same executors by reference, so there is no way to
 * pass a run-scoped fact into a tool except through a holder the host owns and
 * the driver fills — which is exactly the shape `budget: {remaining}` has had
 * since ADR 0019.
 */
describe("literature_search reads its withholding holder at call time (V2, O12)", () => {
  const provider: LiteratureProvider = {
    name: "crossref",
    endpoint: "https://api.crossref.org",
    search: async () => ({
      kind: "ok",
      results: [
        { title: "The Manuscript Itself", authors: [], source: "crossref" },
        { title: "Somebody Else's Paper", authors: [], source: "crossref" },
      ],
    }),
  };

  const titlesOf = (r: unknown) =>
    (r as { results: { title: string }[] }).results.map((x) => x.title);

  it("sees a title the driver set AFTER the registry was built", async () => {
    // The registry is built once, at task start; the panel driver learns the
    // manuscript's title later. Capturing the titles at build time would mean
    // the guard never fires for the run it exists for.
    const withhold = { titles: [] as string[] };
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: { providers: [provider], withhold },
    });
    const tool = reg.get("literature_search");

    const before = unwrap(await tool?.invoke({ query: "q" }));
    expect(titlesOf(before)).toEqual([
      "The Manuscript Itself",
      "Somebody Else's Paper",
    ]);
    expect(before).not.toHaveProperty("withheld");

    withhold.titles = ["The Manuscript Itself"];
    const during = unwrap(await tool?.invoke({ query: "q" }));
    expect(titlesOf(during)).toEqual(["Somebody Else's Paper"]);
    expect((during as { withheld?: unknown }).withheld).toEqual({
      ownTitle: 1,
    });

    // And emptied again — which is what the driver's `finally` does — the tool
    // behaves exactly as it did before the run.
    withhold.titles = [];
    const after = unwrap(await tool?.invoke({ query: "q" }));
    expect(titlesOf(after)).toEqual([
      "The Manuscript Itself",
      "Somebody Else's Paper",
    ]);
  });

  it("changes nothing when no holder is wired at all", async () => {
    const reg = buildToolRegistry({
      tools: ["literature_search"],
      adapter,
      glossary: [],
      literature: { providers: [provider] },
    });
    const out = unwrap(
      await reg.get("literature_search")?.invoke({ query: "q" }),
    );
    expect(titlesOf(out)).toEqual([
      "The Manuscript Itself",
      "Somebody Else's Paper",
    ]);
    expect(out).not.toHaveProperty("withheld");
  });
});
