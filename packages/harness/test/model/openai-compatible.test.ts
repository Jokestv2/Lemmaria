import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  GenerateResult,
  ModelBinding,
  ModelStreamEvent,
} from "../../src/index.js";
import { OpenAICompatibleModelAdapter } from "../../src/model/openai-compatible.js";
import { fakeFetch, fakeFetchSequence } from "./fake-fetch.js";

const binding: ModelBinding = {
  protocol: "openai-compatible",
  endpoint: "https://openai.test/v1",
  model: "gpt-test-1",
  apiKey: "sk-oai-test",
};

const textResponse = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-test-1",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Polished." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
};

describe("OpenAICompatibleModelAdapter", () => {
  it("maps a text generation against a custom baseURL", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [
        { role: "system", content: "You are a copy editor." },
        { role: "user", content: "Polish this." },
      ],
      temperature: 0.3,
      maxTokens: 128,
    });

    const req = captured[0];
    expect(req?.url).toBe("https://openai.test/v1/chat/completions");
    expect(req?.headers.authorization).toBe("Bearer sk-oai-test");
    expect(req?.body.model).toBe("gpt-test-1");
    expect(req?.body.max_tokens).toBe(128);
    expect(req?.body.temperature).toBe(0.3);
    expect(req?.body.messages).toEqual([
      { role: "system", content: "You are a copy editor." },
      { role: "user", content: "Polish this." },
    ]);

    expect(result.text).toBe("Polished.");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("normalizes tool_calls and finish_reason", async () => {
    const { fetchImpl } = fakeFetch({
      ...textResponse,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "count_words", arguments: '{"text":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "Count." }],
      tools: [
        {
          name: "count_words",
          description: "Count words",
          parameters: { type: "object" },
        },
      ],
      maxTokens: 128,
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "count_words", args: { text: "hi" } },
    ]);
    expect(result.text).toBe("");
  });

  it("reconstructs assistant tool_calls + tool messages from history (ADR 0003)", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "Count." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "count_words", args: { text: "hi" } },
        ],
      },
      {
        role: "tool",
        content: '{"unit":"words","count":1}',
        toolCallId: "call_1",
      },
    ];
    await adapter.generate({ binding, messages, maxTokens: 128 });

    expect(captured[0]?.body.messages).toEqual([
      { role: "user", content: "Count." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "count_words", arguments: '{"text":"hi"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"unit":"words","count":1}',
        tool_call_id: "call_1",
      },
    ]);
  });

  it("exposes named tools in OpenAI function shape", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [{ role: "user", content: "Count." }],
      tools: [
        {
          name: "count_words",
          description: "Count words",
          parameters: { type: "object" },
        },
      ],
      maxTokens: 128,
    });
    expect(captured[0]?.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "count_words",
          description: "Count words",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("maps 'length' to max_tokens and computes cost when priced", async () => {
    const { fetchImpl } = fakeFetch({
      ...textResponse,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Trunc" },
          finish_reason: "length",
        },
      ],
    });
    const adapter = new OpenAICompatibleModelAdapter({
      fetch: fetchImpl,
      pricing: { "gpt-test-1": { inputPerMTok: 5, outputPerMTok: 20 } },
    });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4,
    });
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage.costUsd).toBeCloseTo((42 * 5 + 7 * 20) / 1_000_000);
  });

  it("rejects a tool message with no toolCallId instead of sending a broken message", async () => {
    const { fetchImpl } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await expect(
      adapter.generate({
        binding,
        messages: [
          { role: "user", content: "Count." },
          { role: "tool", content: "{}" },
        ],
        maxTokens: 128,
      }),
    ).rejects.toThrow(/toolCallId/);
  });

  it("reports the offending tool call when a server returns malformed JSON arguments", async () => {
    const { fetchImpl } = fakeFetch({
      ...textResponse,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "count_words", arguments: "{not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await expect(
      adapter.generate({
        binding,
        messages: [{ role: "user", content: "Count." }],
        maxTokens: 128,
      }),
    ).rejects.toThrow(/count_words/);
  });

  it("retries with max_completion_tokens when the model rejects max_tokens", async () => {
    // Newer OpenAI models (gpt-5.x, o-series) 400 on the legacy max_tokens field:
    // "Unsupported parameter: 'max_tokens' ... Use 'max_completion_tokens' instead."
    // The adapter must recover by re-sending with max_completion_tokens.
    const captured: { max_tokens?: number; max_completion_tokens?: number }[] =
      [];
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            max_tokens?: number;
            max_completion_tokens?: number;
          })
        : {};
      captured.push(body);
      if ("max_tokens" in body) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
              code: "unsupported_parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(textResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "Polish this." }],
      maxTokens: 128,
    });
    expect(result.text).toBe("Polished.");
    expect(captured[0]?.max_tokens).toBe(128);
    expect(captured[1]?.max_completion_tokens).toBe(128);
    expect(captured[1]?.max_tokens).toBeUndefined();
  });

  it("does not retry when max_tokens is rejected for a value reason (not unsupported)", async () => {
    // A 400 whose param is max_tokens but which is a value-range complaint, not
    // an "unsupported parameter" refusal, must surface as-is — retrying with
    // max_completion_tokens would only mask the real cause.
    const bodies: unknown[] = [];
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Invalid 'max_tokens': must be greater than or equal to 1.",
            type: "invalid_request_error",
            param: "max_tokens",
            code: "invalid_value",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await expect(
      adapter.generate({
        binding,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 0,
      }),
    ).rejects.toThrow(/max_tokens/);
    expect(bodies.length).toBe(1); // surfaced on first attempt, no retry
  });

  describe("reasoning_effort vs. function tools", () => {
    /**
     * B7 manual round: binding `gpt-5.6-luna` failed every tool-using turn with
     * `400 Function tools with reasoning_effort are not supported for
     * gpt-5.6-luna in /v1/chat/completions. To use function tools, use
     * /v1/responses or set reasoning_effort to 'none'.`
     *
     * Lemmaria never sends reasoning_effort — the SERVER applies the model's
     * default and then refuses its own combination. The server also names the
     * remedy, so the adapter takes it, the same error-keyed way it recovers
     * from the max_tokens refusal rather than by a per-model allowlist.
     */
    const refusal = {
      error: {
        message:
          "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
        type: "invalid_request_error",
        param: "reasoning_effort",
        code: "unsupported_parameter",
      },
    };
    const badRequest = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const tools = [
      {
        name: "read_span",
        description: "Read.",
        parameters: { type: "object" },
      },
    ];

    it("re-sends with reasoning_effort 'none' when the server refuses the combination", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        if (!("reasoning_effort" in body)) return badRequest(refusal);
        return new Response(JSON.stringify(textResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const result = await adapter.generate({
        binding,
        messages: [{ role: "user", content: "Draft a paragraph." }],
        maxTokens: 128,
        tools,
      });
      expect(result.text).toBe("Polished.");
      expect(bodies[0]?.reasoning_effort).toBeUndefined();
      expect(bodies[1]?.reasoning_effort).toBe("none");
      // The correction must not cost the tools — dropping them would "fix" the
      // 400 by removing the capability the turn exists to use.
      expect(bodies[1]?.tools).toBeDefined();
    });

    it("re-sends a STREAMED turn too — the path the composer uses", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        if (!("reasoning_effort" in body)) return badRequest(refusal);
        return new Response(
          [
            'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"Hi."},"finish_reason":null}]}\n\n',
            'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [{ role: "user", content: "Draft a paragraph." }],
        maxTokens: 128,
        tools,
      })) {
        events.push(ev);
      }
      expect(bodies[1]?.reasoning_effort).toBe("none");
      expect(events.at(-1)?.type).toBe("completed");
    });

    it("composes with the max_completion_tokens correction, in either order", async () => {
      // gpt-5.x rejects the legacy token field AND this combination, so the
      // adapter must be able to accumulate both rather than pick one.
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        if ("max_tokens" in body) {
          return badRequest({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
              code: "unsupported_parameter",
            },
          });
        }
        if (!("reasoning_effort" in body)) return badRequest(refusal);
        return new Response(JSON.stringify(textResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const result = await adapter.generate({
        binding,
        messages: [{ role: "user", content: "Draft a paragraph." }],
        maxTokens: 128,
        tools,
      });
      expect(result.text).toBe("Polished.");
      expect(bodies.length).toBe(3);
      expect(bodies[2]?.max_completion_tokens).toBe(128);
      expect(bodies[2]?.max_tokens).toBeUndefined();
      expect(bodies[2]?.reasoning_effort).toBe("none");
    });

    /**
     * ADR 0090 §7, measured live 2026-10-20: gpt-6-luna AND the live pin
     * gpt-5.6-luna both refuse every built-in quick action, because each
     * declares a `temperature` (polish.yaml: 0.3). The server names the
     * remedy, so the adapter takes it — the ladder's third rung.
     */
    const temperatureRefusal = {
      error: {
        message:
          "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.",
        type: "invalid_request_error",
        param: "temperature",
        code: "unsupported_value",
      },
    };

    it("re-sends without temperature when the server supports only its default", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        if ("temperature" in body) return badRequest(temperatureRefusal);
        return new Response(JSON.stringify(textResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const result = await adapter.generate({
        binding,
        messages: [{ role: "user", content: "Polish this." }],
        maxTokens: 128,
        temperature: 0.3,
      });
      expect(result.text).toBe("Polished.");
      expect(bodies[0]?.temperature).toBe(0.3);
      expect(bodies[1]?.temperature).toBeUndefined();
      expect(bodies.length).toBe(2);
    });

    it("composes all three corrections, and bottoms out", async () => {
      // A quick action with tools on gpt-6-luna draws all three refusals.
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        bodies.push(body);
        if ("temperature" in body) return badRequest(temperatureRefusal);
        if ("max_tokens" in body) {
          return badRequest({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
              code: "unsupported_parameter",
            },
          });
        }
        if (!("reasoning_effort" in body)) return badRequest(refusal);
        return new Response(JSON.stringify(textResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const result = await adapter.generate({
        binding,
        messages: [{ role: "user", content: "Polish this." }],
        maxTokens: 128,
        temperature: 0.3,
        tools,
      });
      expect(result.text).toBe("Polished.");
      expect(bodies.length).toBe(4);
      const last = bodies[3] ?? {};
      expect(last.temperature).toBeUndefined();
      expect(last.max_completion_tokens).toBe(128);
      expect(last.reasoning_effort).toBe("none");
      expect(last.tools).toBeDefined();
    });

    it("does not retry a temperature 400 that names no default to fall back to", async () => {
      const bodies: unknown[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return badRequest({
          error: {
            message: "Invalid 'temperature': must be less than or equal to 2.",
            type: "invalid_request_error",
            param: "temperature",
            code: "invalid_value",
          },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      await expect(
        adapter.generate({
          binding,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 128,
          temperature: 3,
        }),
      ).rejects.toThrow(/temperature/);
      expect(bodies.length).toBe(1);
    });

    it("does not retry a reasoning_effort 400 that names no remedy", async () => {
      // The `requiresCompletionTokens` precedent: narrow enough that a
      // value-range complaint surfaces instead of provoking a pointless retry.
      const bodies: unknown[] = [];
      const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return badRequest({
          error: {
            message: "Invalid 'reasoning_effort': must be one of low, medium.",
            type: "invalid_request_error",
            param: "reasoning_effort",
            code: "invalid_value",
          },
        });
      };
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      await expect(
        adapter.generate({
          binding,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 128,
          tools,
        }),
      ).rejects.toThrow(/reasoning_effort/);
      expect(bodies.length).toBe(1);
    });
  });

  it("maps an abort to stopReason 'aborted'", async () => {
    const { fetchImpl } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      signal: controller.signal,
    });
    expect(result.stopReason).toBe("aborted");
  });

  describe("generateStream (ADR 0015)", () => {
    /** One OpenAI-style SSE chunk line. */
    const oaFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    const chunk = (delta: unknown, finish: string | null = null) =>
      oaFrame({
        id: "chatcmpl-s1",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-test-1",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    const streamedSse = [
      chunk({ role: "assistant", content: "Read" }),
      chunk({ content: "ing." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_s1",
            type: "function",
            function: { name: "read_span", arguments: '{"secti' },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: 'on":"Intro"}' } }],
      }),
      chunk({}, "tool_calls"),
      oaFrame({
        id: "chatcmpl-s1",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-test-1",
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 19, total_tokens: 49 },
      }),
      "data: [DONE]\n\n",
    ].join("");

    it("streams chunked deltas and completes with reassembled tool calls + usage", async () => {
      const { fetchImpl, captured } = fakeFetchSequence([
        { body: streamedSse },
      ]);
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [{ role: "user", content: "read the intro" }],
        maxTokens: 512,
      })) {
        events.push(ev);
      }
      expect(captured[0]?.body.stream).toBe(true);
      expect(captured[0]?.body.stream_options).toEqual({
        include_usage: true,
      });
      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas.map((e) => e.text).join("")).toBe("Reading.");
      const callDeltas = events.filter((e) => e.type === "tool_call_delta");
      expect(callDeltas[0]).toMatchObject({
        index: 0,
        id: "call_s1",
        name: "read_span",
      });
      expect(callDeltas.map((e) => e.argsDelta).join("")).toBe(
        '{"section":"Intro"}',
      );
      const terminal = events.at(-1);
      expect(terminal?.type).toBe("completed");
      if (terminal?.type === "completed") {
        expect(terminal.result.text).toBe("Reading.");
        expect(terminal.result.toolCalls).toEqual([
          { id: "call_s1", name: "read_span", args: { section: "Intro" } },
        ]);
        expect(terminal.result.stopReason).toBe("tool_use");
        expect(terminal.result.usage).toEqual({
          inputTokens: 30,
          outputTokens: 19,
        });
      }
    });

    it("carries the max_completion_tokens retry to the streamed path", async () => {
      const { fetchImpl, captured } = fakeFetchSequence([
        {
          status: 400,
          body: JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
              code: "unsupported_parameter",
            },
          }),
        },
        { body: streamedSse },
      ]);
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [{ role: "user", content: "go" }],
        maxTokens: 256,
      })) {
        events.push(ev);
      }
      expect(events.at(-1)?.type).toBe("completed");
      expect(captured[0]?.body.max_tokens).toBe(256);
      expect(captured[1]?.body.max_completion_tokens).toBe(256);
      expect(captured[1]?.body.max_tokens).toBeUndefined();
      expect(captured[1]?.body.stream).toBe(true);
    });

    it("reports the silent mid-stream abort as an explicit aborted terminal", async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      const partial = chunk({ role: "assistant", content: "Half an ans" });
      const fetchImpl: typeof globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode(partial));
              controller.abort();
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [{ role: "user", content: "go" }],
        maxTokens: 64,
        signal: controller.signal,
      })) {
        events.push(ev);
      }
      expect(events.at(-1)?.type).toBe("aborted");
      expect(events.some((e) => e.type === "completed")).toBe(false);
    });

    /** The truncated half of a tool call's arguments — see shared.ts (B2). */
    const cutArgs = chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_cut",
          type: "function",
          function: {
            name: "propose_edit",
            arguments: '{"edits":[{"file":"main.tex","anch',
          },
        },
      ],
    });

    it("surfaces a length-truncated turn's unparseable tool call instead of throwing (B2)", async () => {
      const { fetchImpl } = fakeFetchSequence([
        { body: [cutArgs, chunk({}, "length"), "data: [DONE]\n\n"].join("") },
      ]);
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [
          { role: "user", content: "draft the whole methods section" },
        ],
        maxTokens: 8192,
      })) {
        events.push(ev);
      }
      const completed = events.at(-1);
      expect(completed).toMatchObject({ type: "completed" });
      const result = (completed as { result: GenerateResult }).result;
      expect(result.stopReason).toBe("max_tokens");
      expect(result.toolCalls).toEqual([
        { id: "call_cut", name: "propose_edit", args: {} },
      ]);
    });

    it("still throws on unparseable arguments in a COMPLETE turn (B2)", async () => {
      const { fetchImpl } = fakeFetchSequence([
        {
          body: [cutArgs, chunk({}, "tool_calls"), "data: [DONE]\n\n"].join(""),
        },
      ]);
      const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
      await expect(async () => {
        for await (const _ of adapter.generateStream({
          binding,
          messages: [{ role: "user", content: "go" }],
          maxTokens: 64,
        })) {
          // drain
        }
      }).rejects.toThrow(/malformed JSON arguments/);
    });
  });
});

describe("OpenAICompatibleModelAdapter — images on the wire (V3, ADR 0080 §3)", () => {
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";
  // `gpt-test-1` matches no prefix in the table, so it CANNOT see; every case
  // below that expects an image needs a binding that can.
  const seeing: ModelBinding = { ...binding, model: "gpt-5.6-luna" };

  it("a user message with images becomes a parts array", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding: seeing,
      messages: [
        {
          role: "user",
          content: "look",
          images: [{ mimeType: "image/png", data: PNG_B64, label: "page 1" }],
        },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          // ADR 0083 §1: a present image is named just before it, in the
          // shape its evicted placeholder takes.
          { type: "text", text: "[page 1]" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_B64}` },
          },
        ],
      },
    ]);
  });

  it("a present image with no label goes out with no label part (ADR 0083 §1)", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding: seeing,
      messages: [
        {
          role: "user",
          content: "look",
          images: [{ mimeType: "image/png", data: PNG_B64 }],
        },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_B64}` },
          },
        ],
      },
    ]);
  });

  it("a run of tool messages keeps its text and is followed by ONE user message carrying every image", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "Look at pages 1 and 2." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "view_pdf_pages", args: { pages: [1] } },
          { id: "call_b", name: "view_pdf_pages", args: { pages: [2] } },
        ],
      },
      {
        role: "tool",
        content: '{"pages":[{"page":1}]}',
        toolCallId: "call_a",
        images: [{ mimeType: "image/png", data: PNG_B64, label: "page 1" }],
      },
      {
        role: "tool",
        content: '{"pages":[{"page":2}]}',
        toolCallId: "call_b",
        images: [{ mimeType: "image/png", data: "QUJD", label: "page 2" }],
      },
    ];
    await adapter.generate({ binding: seeing, messages, maxTokens: 128 });

    expect(captured[0]?.body.messages).toEqual([
      { role: "user", content: "Look at pages 1 and 2." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "view_pdf_pages", arguments: '{"pages":[1]}' },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "view_pdf_pages", arguments: '{"pages":[2]}' },
          },
        ],
      },
      // The tool messages' own text is UNCHANGED: the label rides beside the
      // image at the wire, never in the history's `content` (ADR 0083 §1).
      {
        role: "tool",
        content: '{"pages":[{"page":1}]}',
        tool_call_id: "call_a",
      },
      {
        role: "tool",
        content: '{"pages":[{"page":2}]}',
        tool_call_id: "call_b",
      },
      // ADR 0083 §1: each image is named just before it. Two pages in one
      // message are otherwise told apart by position alone — and the only
      // "page N" beside an image slot was the previous page's placeholder.
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "text", text: "[page 1]" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_B64}` },
          },
          { type: "text", text: "[page 2]" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,QUJD" },
          },
        ],
      },
    ]);
  });

  it("two SEPARATE runs each get their own trailing message", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding: seeing,
      messages: [
        {
          role: "tool",
          content: "a",
          toolCallId: "c1",
          images: [{ mimeType: "image/png", data: "QQ==", label: "page 1" }],
        },
        { role: "assistant", content: "thinking" },
        {
          role: "tool",
          content: "b",
          toolCallId: "c2",
          images: [{ mimeType: "image/png", data: "Qg==", label: "page 2" }],
        },
      ],
      maxTokens: 128,
    });

    const sent = captured[0]?.body.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(sent.map((m) => m.role)).toEqual([
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });

  it("an EVICTED part contributes a placeholder to the same trailing message, and an all-evicted run still gets one", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding: seeing,
      messages: [
        {
          role: "tool",
          content: '{"pages":[{"page":3}]}',
          toolCallId: "c1",
          images: [
            { mimeType: "image/png", label: "page 3" },
            { mimeType: "image/png" },
          ],
        },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      {
        role: "tool",
        content: '{"pages":[{"page":3}]}',
        tool_call_id: "c1",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "text", text: "[page 3 — viewed]" },
          { type: "text", text: "[image — viewed]" },
        ],
      },
    ]);
  });

  it("a binding that cannot see gets no image_url ANYWHERE", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      // `gpt-test-1` matches no prefix — deny by default, no override needed.
      binding,
      messages: [
        {
          role: "user",
          content: "look",
          images: [{ mimeType: "image/png", data: PNG_B64, label: "page 1" }],
        },
        {
          role: "tool",
          content: "{}",
          toolCallId: "c1",
          images: [{ mimeType: "image/png", data: PNG_B64, label: "page 2" }],
        },
      ],
      maxTokens: 128,
    });

    const body = JSON.stringify(captured[0]?.body);
    expect(body).not.toContain("image_url");
    expect(body).not.toContain(PNG_B64);
    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "text", text: "[page 1 — viewed]" },
        ],
      },
      { role: "tool", content: "{}", tool_call_id: "c1" },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "text", text: "[page 2 — viewed]" },
        ],
      },
    ]);
  });

  it("a history with no images is byte-identical to today's", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new OpenAICompatibleModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding: seeing,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi", images: [] },
        { role: "tool", content: "{}", toolCallId: "c1" },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "tool", content: "{}", tool_call_id: "c1" },
    ]);
  });
});
