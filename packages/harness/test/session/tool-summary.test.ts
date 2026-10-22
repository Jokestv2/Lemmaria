import { describe, expect, it } from "vitest";
import {
  summarizeToolArgs,
  summarizeToolResult,
} from "../../src/session/tool-summary.js";

/**
 * These cases use the EXACT argument shapes the tool definitions declare
 * (engine/tools.ts, session/loop-tools/). That is the whole point of this module
 * living beside them: the first cut of this logic guessed camelCase names and
 * silently summarized nothing for read_span ranges, spawn_subtask and
 * run_script. A rename now breaks a test in the same package.
 */
describe("summarizeToolArgs (A5)", () => {
  it("read_span: file + the snake_case line range", () => {
    expect(
      summarizeToolArgs(
        "read_span",
        JSON.stringify({ file: "intro.tex", start_line: 10, end_line: 42 }),
      ),
    ).toEqual({ text: "intro.tex:10–42" });
  });

  it("load_skill: the row names the skill, not raw JSON (B7)", () => {
    expect(
      summarizeToolArgs("load_skill", JSON.stringify({ name: "related-work" })),
    ).toEqual({ text: "related-work" });
  });

  it("read_span: a section lookup names the section, not a blank row", () => {
    expect(
      summarizeToolArgs("read_span", JSON.stringify({ section: "Method" })),
    ).toEqual({ text: "§Method" });
  });

  it("read_span: a file with no range shows the file alone", () => {
    expect(
      summarizeToolArgs("read_span", JSON.stringify({ file: "a.tex" })),
    ).toEqual({ text: "a.tex" });
  });

  it("read_span: a range with no file (the paper's current file) shows the range", () => {
    // `file` is optional and defaults to the current file (tools.ts), so
    // {start_line, end_line} is a legal, common call — it must not blank the row.
    expect(
      summarizeToolArgs(
        "read_span",
        JSON.stringify({ start_line: 10, end_line: 42 }),
      ),
    ).toEqual({ text: "10–42" });
  });

  it("list_files: the glob it actually declares", () => {
    expect(
      summarizeToolArgs("list_files", JSON.stringify({ glob: "src/**/*.py" })),
    ).toEqual({ text: "src/**/*.py" });
    expect(
      summarizeToolArgs(
        "list_files",
        JSON.stringify({ root: "g1", glob: "*.csv" }),
      ),
    ).toEqual({ text: "g1 · *.csv" });
    expect(
      summarizeToolArgs("list_files", JSON.stringify({ root: "g1" })),
    ).toEqual({ text: "g1" });
  });

  it("grep_project: the query", () => {
    expect(
      summarizeToolArgs("grep_project", JSON.stringify({ query: "\\cite{" })),
    ).toEqual({ text: "\\cite{" });
  });

  it("spawn_subtask: counts `children`, the declared key", () => {
    expect(
      summarizeToolArgs(
        "spawn_subtask",
        JSON.stringify({
          children: [{ goal: "read src" }, { goal: "read docs" }],
        }),
      ),
    ).toEqual({ count: 2, unit: "children" });
  });

  it("run_script: joins `command`, the declared key", () => {
    expect(
      summarizeToolArgs(
        "run_script",
        JSON.stringify({ root: "g1", command: ["python", "plot.py", "--all"] }),
      ),
    ).toEqual({ text: "python plot.py --all" });
  });

  it("propose_edit: a count, never the replacement prose", () => {
    // The batch carries whole rewritten passages; dumping it into the
    // transcript summary buries the edit_proposal card that renders it properly.
    const args = JSON.stringify({
      edits: [
        { file: "a.tex", anchor: "x", replacement: "…long prose…" },
        { file: "a.tex", anchor: "y", replacement: "…more prose…" },
        { file: "b.tex", create: true, content: "…" },
      ],
    });
    const summary = summarizeToolArgs("propose_edit", args);
    expect(summary).toEqual({ count: 3, unit: "edits", files: 2 });
    expect(JSON.stringify(summary)).not.toContain("prose");
  });

  it("update_plan: the step count", () => {
    expect(
      summarizeToolArgs(
        "update_plan",
        JSON.stringify({ items: [{ text: "a" }, { text: "b" }] }),
      ),
    ).toEqual({ count: 2, unit: "steps" });
  });

  it("literature_search: the query", () => {
    expect(
      summarizeToolArgs(
        "literature_search",
        JSON.stringify({ query: "diffusion models" }),
      ),
    ).toEqual({ text: "diffusion models" });
  });

  it("an unknown tool falls back to a CAPPED raw blob", () => {
    const long = JSON.stringify({ blob: "x".repeat(500) });
    const summary = summarizeToolArgs("some_future_tool", long);
    expect(summary.text).toBeDefined();
    expect((summary.text ?? "").length).toBeLessThanOrEqual(121);
    expect(summary.text).toMatch(/…$/);
  });

  it("empty and malformed args summarize to nothing, never throw", () => {
    expect(summarizeToolArgs("read_span", undefined)).toEqual({});
    expect(summarizeToolArgs("read_span", "{")).toEqual({});
    expect(summarizeToolArgs("count_words", "{}")).toEqual({});
  });
});

describe("summarizeToolResult (A5)", () => {
  it("counts matches, results and files, and reports truncation", () => {
    expect(
      summarizeToolResult(
        JSON.stringify({ matches: [1, 2, 3], filesTruncated: true }),
      ),
    ).toEqual({ matches: 3, truncated: true });
    expect(summarizeToolResult(JSON.stringify({ results: [1, 2] }))).toEqual({
      results: 2,
    });
    expect(summarizeToolResult(JSON.stringify({ files: ["a", "b"] }))).toEqual({
      files: 2,
    });
  });

  it("reports the length of returned text", () => {
    expect(summarizeToolResult(JSON.stringify({ text: "abcde" }))).toEqual({
      chars: 5,
    });
  });

  it("a failed call's error is surfaced with its CODE, not a bare ✗ (ADR 0024)", () => {
    expect(
      summarizeToolResult(
        JSON.stringify({
          error: { code: "unavailable", message: "boom while reading" },
        }),
      ),
    ).toEqual({
      error: { code: "unavailable", message: "boom while reading" },
    });
  });

  it("a refusal is a coded failure, not silently counted as success", () => {
    expect(
      summarizeToolResult(
        JSON.stringify({
          error: { code: "not_found", message: "no such file: x.tex" },
        }),
      ),
    ).toEqual({
      error: { code: "not_found", message: "no such file: x.tex" },
    });
  });

  it("a code this build does not know still renders, as `unavailable`", () => {
    // Forward compatibility: a code added later must not blank the row.
    expect(
      summarizeToolResult(
        JSON.stringify({ error: { code: "from_the_future", message: "m" } }),
      ),
    ).toEqual({ error: { code: "unavailable", message: "m" } });
  });

  it("ignores an error that is not the ADR 0024 shape", () => {
    expect(
      summarizeToolResult(JSON.stringify({ error: "a bare string" })),
    ).toEqual({});
  });

  it("empty and malformed results summarize to nothing, never throw", () => {
    expect(summarizeToolResult(undefined)).toEqual({});
    expect(summarizeToolResult("nonsense")).toEqual({});
  });
});

describe("summarizeToolResult — degraded sources and hidden files (A6)", () => {
  it("names the literature sources that did NOT answer", () => {
    // Before A6 a 3-of-4-rate-limited search rendered identically to a healthy
    // one — the stage checklist's `rate_limited` path had no UI surface at all.
    const json = JSON.stringify({
      results: [{ title: "One" }],
      sources: [
        { name: "crossref", status: "ok" },
        { name: "arxiv", status: "rate_limited", retryAfterS: 30 },
        { name: "semantic_scholar", status: "timeout" },
        { name: "dblp", status: "failed" },
      ],
    });
    const summary = summarizeToolResult(json);
    expect(summary.results).toBe(1);
    expect(summary.degradedSources).toEqual([
      "arxiv",
      "semantic_scholar",
      "dblp",
    ]);
  });

  it("says nothing when every source answered", () => {
    const json = JSON.stringify({
      results: [],
      sources: [
        { name: "crossref", status: "ok" },
        { name: "dblp", status: "ok" },
      ],
    });
    expect(summarizeToolResult(json).degradedSources).toBeUndefined();
  });

  it("reports files hidden by .gitignore or a skipped directory", () => {
    const json = JSON.stringify({
      root: "g1",
      files: ["main.py"],
      truncated: false,
      excludedByDefault: 0,
      excludedByGitignore: 2,
      excludedBySkipDir: 1,
    });
    const summary = summarizeToolResult(json);
    expect(summary.files).toBe(1);
    expect(summary.excluded).toBe(3);
  });

  it("omits the exclusion count when nothing was hidden", () => {
    const json = JSON.stringify({
      files: ["a"],
      excludedByDefault: 0,
      excludedByGitignore: 0,
      excludedBySkipDir: 0,
    });
    expect(summarizeToolResult(json).excluded).toBeUndefined();
  });

  it("names the degraded sources that ran without an API key (R4)", () => {
    const json = JSON.stringify({
      sources: [
        { name: "crossref", status: "ok" },
        { name: "semantic_scholar", status: "rate_limited", anonymous: true },
        { name: "dblp", status: "failed" },
      ],
      results: [],
    });
    const summary = summarizeToolResult(json);
    expect(summary.degradedSources).toEqual(["semantic_scholar", "dblp"]);
    expect(summary.anonymousSources).toEqual(["semantic_scholar"]);
  });

  it("says nothing about an anonymous source that answered anyway", () => {
    // The pointer is by exception: a working anonymous source is not a nag.
    const json = JSON.stringify({
      sources: [{ name: "semantic_scholar", status: "ok", anonymous: true }],
      results: [],
    });
    expect(summarizeToolResult(json).anonymousSources).toBeUndefined();
  });

  it("says nothing about a KEYED source that was rate-limited anyway", () => {
    const json = JSON.stringify({
      sources: [{ name: "semantic_scholar", status: "rate_limited" }],
      results: [],
    });
    const summary = summarizeToolResult(json);
    expect(summary.degradedSources).toEqual(["semantic_scholar"]);
    expect(summary.anonymousSources).toBeUndefined();
  });
});
