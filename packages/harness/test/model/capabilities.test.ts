import { describe, expect, it } from "vitest";
import type { ModelBinding } from "../../src/contracts/adapters.js";
import type { ToolName } from "../../src/contracts/tools.js";
import {
  IMAGE_INPUT_MODEL_PREFIXES,
  canSeeImages,
  imageInputFor,
  withholdImageTools,
} from "../../src/model/capabilities.js";

const binding = (
  model: string,
  imageInput?: boolean,
): Pick<ModelBinding, "model" | "imageInput"> => ({ model, imageInput });

describe("imageInputFor — a deny-by-default prefix table (V3, ADR 0080 D6)", () => {
  it("every row of the table resolves to what the row declares", () => {
    for (const [prefix, declared] of Object.entries(
      IMAGE_INPUT_MODEL_PREFIXES,
    )) {
      expect(imageInputFor(`${prefix}-something-1`)).toBe(declared);
    }
  });

  it("a model nobody has heard of cannot see — unknown is NO (invariant 2's direction)", () => {
    expect(imageInputFor("mystery-1")).toBe(false);
    expect(imageInputFor("")).toBe(false);
    expect(imageInputFor("llama-3-70b")).toBe(false);
    expect(imageInputFor("qwen2.5-vl-72b")).toBe(false);
  });

  it("the LONGEST prefix wins, which is how gpt-4- says no while gpt-4o says yes", () => {
    // "gpt-4o-mini" matches "gpt-4-"? No — but it does match "gpt-4o". The
    // interesting pair is the one that overlaps: "gpt-4-turbo" matches BOTH
    // "gpt-4-" (false) and "gpt-4-turbo" (true); the longer one wins.
    expect(imageInputFor("gpt-4-turbo-2024-04-09")).toBe(true);
    expect(imageInputFor("gpt-4-0613")).toBe(false);
    expect(imageInputFor("gpt-4o-mini")).toBe(true);
    expect(imageInputFor("gpt-3.5-turbo")).toBe(false);
  });

  it("the enabled live pin's model matches the gpt-5 row S6 measured seeing", () => {
    expect(imageInputFor("gpt-5.6-luna")).toBe(true);
  });

  it("the two new models see — gpt-6-luna by its own row, Haiku 5.5 by the claude one", () => {
    // OpenAI's model page, read 2026-10-20: "Input modalities: text, image".
    // Without the row, deny-by-default withheld view_pdf_pages from it.
    expect(imageInputFor("gpt-6-luna")).toBe(true);
    expect(imageInputFor("claude-haiku-5-5")).toBe(true);
    // Keyed on the full id: a sibling nobody has read about is not claimed.
    expect(imageInputFor("gpt-6-sol")).toBe(false);
  });

  it("claude ids see; deepseek ids do not", () => {
    expect(imageInputFor("claude-haiku-4-5-20251001")).toBe(true);
    expect(imageInputFor("deepseek-chat")).toBe(false);
  });
});

describe("canSeeImages — the per-model override", () => {
  it("falls through to the table when the binding declares nothing", () => {
    expect(canSeeImages(binding("claude-haiku-4-5-20251001"))).toBe(true);
    expect(canSeeImages(binding("mystery-1"))).toBe(false);
  });

  it("honours the override in BOTH directions", () => {
    // The whole reason the override exists: an endpoint nobody has heard of
    // that can in fact see (design §5) …
    expect(canSeeImages(binding("mystery-1", true))).toBe(true);
    // … and a model the table says yes to, behind a proxy that strips images.
    expect(canSeeImages(binding("claude-haiku-4-5-20251001", false))).toBe(
      false,
    );
  });

  it("an explicit false is not the same as absent", () => {
    expect(canSeeImages(binding("gpt-5.6-luna", false))).toBe(false);
    expect(canSeeImages(binding("gpt-5.6-luna", undefined))).toBe(true);
  });
});

describe("withholdImageTools — the allowlist lock", () => {
  const allowed: ToolName[] = [
    "read_span",
    "view_pdf_pages",
    "grep_project",
    "list_files",
  ];

  it("removes exactly the one name for a binding that cannot see", () => {
    expect(withholdImageTools(allowed, binding("mystery-1"))).toEqual([
      "read_span",
      "grep_project",
      "list_files",
    ]);
  });

  it("leaves the list alone for a binding that can see", () => {
    expect(withholdImageTools(allowed, binding("gpt-5.6-luna"))).toEqual(
      allowed,
    );
  });

  it("is a no-op on a list that never had the name", () => {
    const without: ToolName[] = ["read_span", "list_files"];
    expect(withholdImageTools(without, binding("mystery-1"))).toEqual(without);
  });

  it("does not mutate the list it is given", () => {
    const original = [...allowed];
    withholdImageTools(allowed, binding("mystery-1"));
    expect(allowed).toEqual(original);
  });
});
