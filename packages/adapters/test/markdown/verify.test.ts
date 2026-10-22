import { describe, expect, it } from "vitest";
import { loadMarkdownAdapter } from "../../src/markdown/adapter.js";

const reader = (files: Record<string, string>) => ({
  readFile: (p: string) => {
    const c = files[p];
    if (c === undefined) return Promise.reject(new Error(`no file: ${p}`));
    return Promise.resolve(c);
  },
});

describe("MarkdownAdapter.verify (structural parse-check, no compile)", () => {
  it("a clean document verifies ok with no warnings", async () => {
    const adapter = await loadMarkdownAdapter(
      reader({ "d.md": "# H\n\nProse with $x$.\n\n```js\nok\n```\n" }),
      "d.md",
    );
    expect(await adapter.verify()).toEqual({ ok: true, warnings: [] });
  });

  it("an unclosed fence is an error with its line", async () => {
    const adapter = await loadMarkdownAdapter(
      reader({ "d.md": "Text.\n\n```python\nstill open\n" }),
      "d.md",
    );
    const { ok, warnings } = await adapter.verify();
    expect(ok).toBe(false);
    expect(warnings[0]).toMatchObject({
      source: "markdown",
      severity: "error",
      code: "unclosed-fence",
      line: 3,
    });
    expect(typeof warnings[0]?.id).toBe("string");
  });

  it("odd display-math delimiters warn; missing bibliography file warns", async () => {
    const adapter = await loadMarkdownAdapter(
      reader({
        "d.md": "---\nbibliography: nope.bib\n---\n\nBroken $$x = 1\n",
      }),
      "d.md",
    );
    const { ok, warnings } = await adapter.verify();
    expect(ok).toBe(true); // warnings only, no error
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("unclosed-display-math");
    expect(codes).toContain("missing-bibliography-file");
  });
});
