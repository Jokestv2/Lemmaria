import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, providerPreset } from "../../src/index.js";

describe("provider presets", () => {
  it("ships anthropic and openai presets", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
  });

  it("maps each preset to a valid protocol and non-empty suggestions", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(["anthropic", "openai-compatible"]).toContain(p.protocol);
      expect(p.suggestedModels.length).toBeGreaterThan(0);
    }
  });

  it("gives anthropic the default endpoint and openai the OpenAI base URL", () => {
    expect(providerPreset("anthropic")?.defaultEndpoint).toBe("");
    expect(providerPreset("openai")?.defaultEndpoint).toBe(
      "https://api.openai.com/v1",
    );
    expect(providerPreset("openai")?.protocol).toBe("openai-compatible");
  });

  it("suggests the two new models, and keeps the live pins' models on the menu", () => {
    expect(providerPreset("anthropic")?.suggestedModels).toContain(
      "claude-haiku-5-5",
    );
    expect(providerPreset("openai")?.suggestedModels).toContain("gpt-6-luna");
    // The pins (`packages/cli/test/live/pins.ts`) stay what Lemmaria measures.
    expect(providerPreset("anthropic")?.suggestedModels).toContain(
      "claude-haiku-4-5-20251001",
    );
    expect(providerPreset("openai")?.suggestedModels).toContain("gpt-5.6-luna");
  });

  it("returns undefined for an unknown provider id", () => {
    expect(providerPreset("nope")).toBeUndefined();
  });
});
