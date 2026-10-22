/**
 * The action JSON Schema — a faithful TS transcription of the schema spec §9
 * (design/custom-action-schema-EN.md, doc rev 0.3, schema format "1").
 * If this and §9 diverge, one of them is a bug (invariant 7 discipline).
 */
export const ACTION_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "LemmariaCustomAction",
  type: "object",
  required: ["schema_version", "id", "kind", "version", "name", "prompt"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "1" },
    id: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
    kind: { enum: ["edit", "review", "generate"] },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    name: { $ref: "#/$defs/i18n" },
    description: { $ref: "#/$defs/i18n" },
    author: { type: "string" },
    license: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    icon: { type: "string" },
    requires: {
      type: "object",
      properties: {
        harness: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        doc_kinds: { type: "array", items: { enum: ["latex", "markdown"] } },
      },
    },
    ui: {
      type: "object",
      properties: {
        surfaces: {
          type: "array",
          items: { enum: ["context_menu", "command_palette", "code_lens"] },
        },
        group: { type: "string" },
        keybinding: { type: ["string", "null"] },
        requires_selection: { type: "boolean" },
      },
    },
    input: {
      type: "object",
      properties: {
        scope: {
          enum: [
            "selection",
            "paragraph",
            "section",
            "environment",
            "document",
          ],
        },
        scope_fallback: {
          enum: [
            "selection",
            "paragraph",
            "section",
            "environment",
            "document",
          ],
        },
        min_chars: { type: "integer", minimum: 0 },
        max_chars: { type: "integer", minimum: 1 },
      },
    },
    routing: {
      type: "object",
      properties: {
        level: { enum: ["L0", "L1", "L2", "auto"] },
        thinking_budget: { enum: ["none", "low", "medium", "high"] },
        tools: { type: "array", items: { type: "string" } },
        max_iterations: { type: "integer", minimum: 1 },
        max_tokens: { type: "integer", minimum: 1 },
        timeout_s: { type: "integer", minimum: 1 },
      },
    },
    model: {
      type: "object",
      properties: {
        role: {
          enum: [
            "writing",
            "reviewer_a",
            "reviewer_b",
            "reviewer_c",
            "synthesis",
          ],
        },
        override: { type: ["string", "null"] },
        temperature: { type: "number", minimum: 0, maximum: 2 },
        fan_out: { type: ["array", "null"], items: { type: "string" } },
        synthesis: { type: ["string", "null"] },
      },
    },
    parameters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type"],
        // §11: unknown fields error in strict mode. This flag used to appear
        // ONLY at the top level, so a typo'd sibling here validated silently
        // and arrived as a key nothing reads (D4).
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { $ref: "#/$defs/i18n" },
          type: { enum: ["integer", "number", "string", "enum", "boolean"] },
          required: { type: "boolean" },
          default: {},
          prompt_on_invoke: { type: "boolean" },
          min: { type: "number" },
          max: { type: "number" },
          enum: { type: "array" },
          // D4 / QA-3: display labels per enum value (ADR 0041).
          enum_labels: {
            type: "object",
            additionalProperties: { $ref: "#/$defs/i18n" },
          },
        },
      },
    },
    context: {
      type: "object",
      properties: {
        neighbors: { type: "integer", minimum: 0 },
        include_glossary: { type: "boolean" },
        include_profile: { type: "array", items: { type: "string" } },
        include_outline: { type: "boolean" },
        retrieval_budget: { type: "integer", minimum: 0 },
        protected_spans: {
          oneOf: [
            { enum: ["freeze", "allow_edit"] },
            {
              type: "object",
              required: ["mode"],
              properties: {
                mode: { const: "freeze_except" },
                allow: {
                  type: "array",
                  items: {
                    enum: [
                      "cite",
                      "ref",
                      "math",
                      "code",
                      "macro",
                      "markup",
                      "comment",
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
    prompt: {
      type: "object",
      required: ["user"],
      properties: {
        system: { type: "string" },
        user: { type: "string" },
      },
    },
    output: {
      type: "object",
      properties: {
        contract: {
          enum: [
            "replace_selection",
            "replace_anchor",
            "insert_after",
            "insert_before",
            "new_file",
            "annotations",
          ],
        },
        language: { type: "string" },
        format: { type: "string" },
        validators: {
          type: "array",
          items: { type: "object", required: ["type"] },
        },
        on_validation_fail: {
          type: "object",
          properties: {
            strategy: {
              enum: ["retry_with_feedback", "reject", "accept_with_warning"],
            },
            max_retries: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    /**
     * DEPRECATED (ADR 0013) — accepted but ignored.
     *
     * The host no longer verifies after an Accept: a compile is a report the
     * user asks for, never a gate on an edit. The engine never read this block
     * (the host did), so it now describes a behavior that does not exist. It is
     * dropped from the built-in YAMLs and kept HERE, still accepted, so that
     * existing local actions carrying it keep loading rather than failing strict
     * mode (§11). Do not remove it — see loader.test.ts's deprecation test.
     */
    verify: {
      type: "object",
      properties: {
        run: { enum: ["inherit", "always", "never"] },
        citation_check: { type: "boolean" },
        on_fail: { enum: ["auto_fix_then_rollback", "rollback", "warn"] },
      },
    },
    review_schema: {
      type: "object",
      properties: {
        dimensions: { type: "array", items: { type: "string" } },
        severity: { type: "array", items: { type: "string" } },
        suggest_edits: { type: "boolean" },
      },
    },
    review_ui: {
      type: "object",
      properties: {
        mode: { enum: ["inline_diff", "side_panel"] },
        allow_retry_feedback: { type: "boolean" },
      },
    },
  },
  $defs: {
    i18n: {
      type: "object",
      // D4 review: without this, `{ en: "x", zn: "英文" }` validates and the zh
      // half silently never renders — the same class of defect
      // `additionalProperties: false` was added to the parameter object for.
      additionalProperties: false,
      properties: { en: { type: "string" }, zh: { type: "string" } },
      anyOf: [{ required: ["en"] }, { required: ["zh"] }],
    },
  },
} as const;
