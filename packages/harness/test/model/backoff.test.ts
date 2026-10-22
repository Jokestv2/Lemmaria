import { describe, expect, it } from "vitest";
import type { ModelBinding } from "../../src/contracts/adapters.js";
import { AnthropicModelAdapter } from "../../src/model/anthropic.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";

/**
 * A fetch stand-in that returns a queued sequence of Responses so a test can
 * simulate a transient failure followed by success. The last entry repeats.
 */
function queuedFetch(responses: Array<() => Response>) {
  let calls = 0;
  const fetchImpl: typeof globalThis.fetch = async () => {
    const make = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return make();
  };
  return { fetchImpl, callCount: () => calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const transient = (): Response =>
  new Response("upstream unavailable", {
    status: 503,
    // A short Retry-After keeps the test fast while exercising the honor path.
    headers: { "retry-after": "0" },
  });

const anthropicOk = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test-1",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

const openaiOk = {
  id: "cmpl_1",
  object: "chat.completion",
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

describe("transient-failure backoff (429/5xx)", () => {
  it("Anthropic retries a 503 then succeeds", async () => {
    const { fetchImpl, callCount } = queuedFetch([
      transient,
      () => json(anthropicOk),
    ]);
    const binding: ModelBinding = {
      protocol: "anthropic",
      endpoint: "https://anthropic.test",
      model: "claude-test-1",
      apiKey: "k",
    };
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    expect(result.text).toBe("ok");
    expect(callCount()).toBeGreaterThanOrEqual(2); // at least one retry
  });

  it("OpenAI-compatible retries a 503 then succeeds", async () => {
    const { fetchImpl, callCount } = queuedFetch([
      transient,
      () => json(openaiOk),
    ]);
    const binding: ModelBinding = {
      protocol: "openai-compatible",
      endpoint: "https://openai.test/v1",
      model: "gpt-test",
      apiKey: "k",
    };
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    expect(result.text).toBe("ok");
    expect(callCount()).toBeGreaterThanOrEqual(2);
  });

  it("respects maxRetries: 0 (a transient 503 surfaces without retry)", async () => {
    const { fetchImpl, callCount } = queuedFetch([
      transient,
      () => json(anthropicOk),
    ]);
    const binding: ModelBinding = {
      protocol: "anthropic",
      endpoint: "https://anthropic.test",
      model: "claude-test-1",
      apiKey: "k",
    };
    const adapter = new AnthropicModelAdapter({
      fetch: fetchImpl,
      maxRetries: 0,
    });
    await expect(
      adapter.generate({
        binding,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      }),
    ).rejects.toThrow();
    expect(callCount()).toBe(1);
  });

  it("does not retry a non-transient 400 (surfaces immediately)", async () => {
    const { fetchImpl, callCount } = queuedFetch([
      () => json({ error: { message: "bad request", type: "invalid" } }, 400),
    ]);
    const binding: ModelBinding = {
      protocol: "anthropic",
      endpoint: "https://anthropic.test",
      model: "claude-test-1",
      apiKey: "k",
    };
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await expect(
      adapter.generate({
        binding,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      }),
    ).rejects.toThrow();
    expect(callCount()).toBe(1); // no retry on a client error
  });
});
