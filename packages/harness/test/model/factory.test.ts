import { describe, expect, it } from "vitest";
import type { ModelBinding } from "../../src/index.js";
import { AnthropicModelAdapter } from "../../src/model/anthropic.js";
import { createModelAdapter } from "../../src/model/factory.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";
import { fakeFetch } from "./fake-fetch.js";

const response = {
  id: "msg_1",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 42, output_tokens: 7 },
};

function bindingFor(model: string): ModelBinding {
  return {
    protocol: "anthropic",
    endpoint: "https://anthropic.test",
    model,
    apiKey: "sk-ant-test",
  };
}

describe("createModelAdapter", () => {
  it("returns the adapter matching the protocol", () => {
    expect(createModelAdapter("anthropic")).toBeInstanceOf(
      AnthropicModelAdapter,
    );
    expect(createModelAdapter("openai-compatible")).toBeInstanceOf(
      OpenAICompatibleModelAdapter,
    );
  });

  it("prices known model families by default (ADR 0009): dated id → family price", async () => {
    const { fetchImpl } = fakeFetch(response);
    const adapter = createModelAdapter("anthropic", { fetch: fetchImpl });
    const result = await adapter.generate({
      binding: bindingFor("claude-sonnet-4-5-20250929"),
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    // 42 in + 7 out at the claude-sonnet-4-5 family price ($3/$15 per MTok).
    expect(result.usage.costUsd).toBeCloseTo((42 * 3 + 7 * 15) / 1_000_000, 9);
  });

  it("omits costUsd for models outside the table (ADR 0002)", async () => {
    const { fetchImpl } = fakeFetch(response);
    const adapter = createModelAdapter("anthropic", { fetch: fetchImpl });
    const result = await adapter.generate({
      binding: bindingFor("my-local-finetune"),
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(result.usage.costUsd).toBeUndefined();
  });
});
