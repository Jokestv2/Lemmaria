import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  checkRequires,
  loadActionSet,
  parseActionFile,
} from "../../src/actions/loader.js";

const MINIMAL = `
schema_version: "1"
id: "academify"
kind: edit
version: "1.0.0"
name: { en: "Academify" }
prompt:
  user: "Rewrite: {{selection}}"
`;

describe("parseActionFile", () => {
  it("parses a minimal valid YAML action", () => {
    const def = parseActionFile(MINIMAL, "academify.yaml");
    expect(def.id).toBe("academify");
    expect(def.kind).toBe("edit");
  });

  it("parses JSON too (YAML superset)", () => {
    const def = parseActionFile(
      JSON.stringify({
        schema_version: "1",
        id: "a-b",
        kind: "review",
        version: "0.1.0",
        name: { zh: "评审" },
        prompt: { user: "x" },
      }),
      "a.json",
    );
    expect(def.kind).toBe("review");
  });

  it("rejects a missing required field with the ajv reason", () => {
    expect(() =>
      parseActionFile(
        `schema_version: "1"\nid: "x"\nkind: edit\nversion: "1.0.0"\nname: { en: "X" }\n`,
        "x.yaml",
      ),
    ).toThrow(/prompt/);
  });

  /**
   * D4 / QA-3 (ADR 0041). `enum_labels` gives an enum parameter a DISPLAY name
   * per value, so a picker offers "English" rather than "en".
   */
  it("accepts enum_labels on an enum parameter", () => {
    const def = parseActionFile(
      `${MINIMAL}\nparameters:\n  - id: lang\n    type: enum\n    enum: [en, zh]\n    enum_labels:\n      en: { en: "English", zh: "英文" }\n      zh: { en: "Simplified Chinese", zh: "简体中文" }\n`,
      "x.yaml",
    );
    expect(def.parameters?.[0]?.enum_labels).toEqual({
      en: { en: "English", zh: "英文" },
      zh: { en: "Simplified Chinese", zh: "简体中文" },
    });
  });

  /**
   * The hardening that makes the field above worth writing into the schema:
   * `additionalProperties: false` appeared exactly ONCE, at the top level, so a
   * typo'd sibling inside a parameter validated silently and arrived as a key
   * nothing reads. §11 says unknown fields error in strict mode; now they do
   * here too.
   */
  it("rejects an unknown field INSIDE a parameter (strict mode, §11)", () => {
    expect(() =>
      parseActionFile(
        `${MINIMAL}\nparameters:\n  - id: lang\n    type: enum\n    enum: [en]\n    enum_label: { en: "typo" }\n`,
        "x.yaml",
      ),
    ).toThrow(/additional/i);
  });

  /**
   * An `enum_labels` key that is not an enum VALUE labels nothing, and JSON
   * Schema cannot express the relation — so a typo would silently degrade the
   * picker to the raw value. Found by D4's code review, which noted the
   * strictness hardening only half-closed the class it was added for.
   */
  it("rejects enum_labels for a value not in the enum", () => {
    expect(() =>
      parseActionFile(
        `${MINIMAL}\nparameters:\n  - id: lang\n    type: enum\n    enum: [en, zh]\n    enum_labels:\n      fr: { en: "French" }\n`,
        "x.yaml",
      ),
    ).toThrow(/not in its enum/);
  });

  it("rejects an unknown key inside an I18n object", () => {
    expect(() =>
      parseActionFile(
        `${MINIMAL}\nparameters:\n  - id: lang\n    type: enum\n    enum: [en]\n    enum_labels:\n      en: { en: "English", zn: "英文" }\n`,
        "x.yaml",
      ),
    ).toThrow(/additional/i);
  });

  it("rejects unknown top-level fields (strict mode, §11)", () => {
    expect(() =>
      parseActionFile(`${MINIMAL}\nshell: "rm -rf"`, "evil.yaml"),
    ).toThrow(/additional/i);
  });

  it("rejects a bad id pattern and a bad kind", () => {
    expect(() =>
      parseActionFile(MINIMAL.replace('"academify"', '"Bad_ID"'), "x.yaml"),
    ).toThrow(/pattern|id/);
    expect(() =>
      parseActionFile(MINIMAL.replace("kind: edit", "kind: shell"), "x.yaml"),
    ).toThrow(/kind|enum/);
  });

  it("rejects tools outside the allowlist (invariant 2)", () => {
    const withTool = `${MINIMAL}\nrequires: { tools: [run_shell] }`;
    expect(() => parseActionFile(withTool, "x.yaml")).toThrow(
      /allowlist.*run_shell|run_shell.*allowlist/s,
    );
  });

  it("rejects invalid YAML with the file named", () => {
    expect(() => parseActionFile("{{{{", "broken.yaml")).toThrow(
      /broken\.yaml/,
    );
  });

  it("still accepts a deprecated verify block (ADR 0013 — ignored, not rejected)", () => {
    // X1 dropped `verify` from the built-in YAMLs and the host runs no
    // post-Accept verify, but a local action written before X1 must keep
    // loading rather than dying in strict mode (§11). Deleting the field from
    // the schema would break exactly those users; this test is why it stays.
    const withVerify = `${MINIMAL}\nverify:\n  run: always\n  citation_check: true\n  on_fail: auto_fix_then_rollback`;
    const def = parseActionFile(withVerify, "legacy.yaml");
    expect(def.id).toBe("academify");
    expect(def.verify?.run).toBe("always");
  });

  it("accepts the replace_anchor output contract (ADR 0007) and rejects bogus ones", () => {
    const anchored = `${MINIMAL}\noutput:\n  contract: replace_anchor`;
    expect(parseActionFile(anchored, "x.yaml").output?.contract).toBe(
      "replace_anchor",
    );
    expect(() =>
      parseActionFile(`${MINIMAL}\noutput:\n  contract: bogus`, "x.yaml"),
    ).toThrow(/contract|enum/);
  });
});

describe("loadActionSet precedence (§2)", () => {
  it("project > user > built-in on id conflict; errors collected per file", () => {
    const { actions, errors } = loadActionSet({
      "built-in": [
        {
          path: "b/polish.yaml",
          content: MINIMAL.replace('"academify"', '"polish"'),
        },
        { path: "b/broken.yaml", content: "{{{{" },
      ],
      user: [
        {
          path: "u/polish.yaml",
          content: MINIMAL.replace('"academify"', '"polish"').replace(
            '"1.0.0"',
            '"2.0.0"',
          ),
        },
      ],
      project: [
        {
          path: "p/other.yaml",
          content: MINIMAL.replace('"academify"', '"other"'),
        },
      ],
    });
    const polish = actions.find((a) => a.definition.id === "polish");
    expect(polish?.source).toBe("user");
    expect(polish?.definition.version).toBe("2.0.0");
    expect(actions.map((a) => a.definition.id).sort()).toEqual([
      "other",
      "polish",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.filePath).toBe("b/broken.yaml");
  });
});

describe("HARNESS_VERSION", () => {
  it("stays in sync with package.json (drift guard)", async () => {
    const { HARNESS_VERSION } = await import("../../src/actions/loader.js");
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(HARNESS_VERSION).toBe(pkg.version);
  });
});

describe("checkRequires", () => {
  const def = parseActionFile(
    `${MINIMAL}\nrequires: { harness: ">=0.0.1", doc_kinds: [latex] }`,
    "x.yaml",
  );
  it("passes when met", () => {
    expect(checkRequires(def, { docKind: "latex" })).toEqual([]);
  });
  it("reports unmet harness version and doc kind", () => {
    expect(
      checkRequires(def, { harnessVersion: "0.0.0", docKind: "latex" })[0],
    ).toMatch(/harness/);
    expect(checkRequires(def, { docKind: "markdown" })[0]).toMatch(/markdown/);
  });
});
