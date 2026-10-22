import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  GenerateResult,
  ModelBinding,
  ModelStreamEvent,
} from "../../src/index.js";
import { AnthropicModelAdapter } from "../../src/model/anthropic.js";
import { fakeFetch, fakeFetchSequence, sseFrame } from "./fake-fetch.js";

const binding: ModelBinding = {
  protocol: "anthropic",
  endpoint: "https://anthropic.test",
  model: "claude-test-1",
  apiKey: "sk-ant-test",
};

const textResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test-1",
  content: [{ type: "text", text: "Polished." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 42, output_tokens: 7 },
};

describe("AnthropicModelAdapter", () => {
  it("maps a text generation: system hoisted, key injected, result normalized", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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
    expect(req?.url).toContain("anthropic.test");
    expect(req?.url).toContain("/messages");
    expect(req?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(req?.body.model).toBe("claude-test-1");
    expect(req?.body.max_tokens).toBe(128);
    expect(req?.body.temperature).toBe(0.3);
    expect(req?.body.system).toBe("You are a copy editor.");
    expect(req?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Polish this." }] },
    ]);

    expect(result.text).toBe("Polished.");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("normalizes a tool_use response into toolCalls", async () => {
    const { fetchImpl } = fakeFetch({
      ...textResponse,
      content: [
        { type: "text", text: "Counting." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "count_words",
          input: { text: "hi" },
        },
      ],
      stop_reason: "tool_use",
    });
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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
      { id: "toolu_1", name: "count_words", args: { text: "hi" } },
    ]);
    expect(result.text).toBe("Counting.");
  });

  it("reconstructs tool_use / tool_result blocks from history (ADR 0003)", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "Count." },
      {
        role: "assistant",
        content: "Counting.",
        toolCalls: [
          { id: "toolu_1", name: "count_words", args: { text: "hi" } },
        ],
      },
      {
        role: "tool",
        content: '{"unit":"words","count":1}',
        toolCallId: "toolu_1",
      },
    ];
    await adapter.generate({ binding, messages, maxTokens: 128 });

    expect(captured[0]?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Count." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Counting." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "count_words",
            input: { text: "hi" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: '{"unit":"words","count":1}',
          },
        ],
      },
    ]);
  });

  it("exposes named tools in Anthropic shape", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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
        name: "count_words",
        description: "Count words",
        input_schema: { type: "object" },
      },
    ]);
  });

  it("computes costUsd only when pricing is known (ADR 0002)", async () => {
    const { fetchImpl } = fakeFetch(textResponse);
    const priced = new AnthropicModelAdapter({
      fetch: fetchImpl,
      pricing: { "claude-test-1": { inputPerMTok: 3, outputPerMTok: 15 } },
    });
    const result = await priced.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    expect(result.usage.costUsd).toBeCloseTo((42 * 3 + 7 * 15) / 1_000_000);
  });

  it("enables thinking with the budget clamped under max_tokens", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 8192,
      thinkingBudget: "high",
      temperature: 0.5,
    });
    // "high" wants 16384, but budget_tokens must stay under max_tokens (else 400).
    expect(captured[0]?.body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8191,
    });
    // Anthropic rejects a non-default temperature while thinking is enabled.
    expect(captured[0]?.body.temperature).toBeUndefined();
  });

  it("omits thinking when max_tokens leaves no room for the API-minimum budget", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
      thinkingBudget: "low",
      temperature: 0.5,
    });
    expect(captured[0]?.body.thinking).toBeUndefined();
    expect(captured[0]?.body.temperature).toBe(0.5);
  });

  it("drops an empty assistant message instead of sending empty content", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "again" },
      ],
      maxTokens: 128,
    });
    // Empty assistant turns vanish; the surrounding user turns merge (alternation).
    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "again" },
        ],
      },
    ]);
  });

  it("rejects a tool message with no toolCallId instead of sending a broken block", async () => {
    const { fetchImpl } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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

  it("surfaces Anthropic thinking blocks on result.reasoning (ADR 0006)", async () => {
    const thinking = {
      type: "thinking",
      thinking: "Let me count.",
      signature: "sig-abc",
    };
    const { fetchImpl } = fakeFetch({
      ...textResponse,
      content: [
        thinking,
        { type: "text", text: "Counting." },
        { type: "tool_use", id: "toolu_1", name: "count_words", input: {} },
      ],
      stop_reason: "tool_use",
    });
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    const result = await adapter.generate({
      binding,
      messages: [{ role: "user", content: "Count." }],
      maxTokens: 8192,
      thinkingBudget: "low",
    });
    expect(result.reasoning).toEqual([thinking]);
  });

  it("echoes reasoning blocks back into the assistant turn (ADR 0006)", async () => {
    const thinking = {
      type: "thinking",
      thinking: "Let me count.",
      signature: "sig-abc",
    };
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [
        { role: "user", content: "Count." },
        {
          role: "assistant",
          content: "Counting.",
          toolCalls: [{ id: "toolu_1", name: "count_words", args: {} }],
          reasoning: [thinking],
        },
        { role: "tool", content: "1", toolCallId: "toolu_1" },
      ],
      maxTokens: 8192,
    });
    const assistant = captured[0]?.body.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    // Reasoning blocks lead the assistant content, before text and tool_use.
    expect(assistant.content[0]).toEqual(thinking);
    expect(assistant.content).toEqual([
      thinking,
      { type: "text", text: "Counting." },
      { type: "tool_use", id: "toolu_1", name: "count_words", input: {} },
    ]);
  });

  it("maps an abort to stopReason 'aborted'", async () => {
    const { fetchImpl } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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
    const streamedSse = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_s1",
          type: "message",
          role: "assistant",
          model: "claude-test-1",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 30, output_tokens: 1 },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Read" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ing." },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_s1",
          name: "read_span",
          input: {},
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"secti' },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'on":"Intro"}' },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 19 },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ].join("");

    it("streams text + tool-arg deltas and a completed result equal to the unary shape", async () => {
      const { fetchImpl, captured } = fakeFetchSequence([
        { body: streamedSse },
      ]);
      const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
      const events: ModelStreamEvent[] = [];
      for await (const ev of adapter.generateStream({
        binding,
        messages: [{ role: "user", content: "read the intro" }],
        thinkingBudget: "medium",
        maxTokens: 512,
      })) {
        events.push(ev);
      }
      // Streamed requests never send thinking (unverified signed-echo gap).
      expect(captured[0]?.body.stream).toBe(true);
      expect(captured[0]?.body.thinking).toBeUndefined();

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas.map((e) => e.text).join("")).toBe("Reading.");
      const callDeltas = events.filter((e) => e.type === "tool_call_delta");
      expect(callDeltas[0]).toMatchObject({
        index: 0,
        id: "toolu_s1",
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
          { id: "toolu_s1", name: "read_span", args: { section: "Intro" } },
        ]);
        expect(terminal.result.stopReason).toBe("tool_use");
        expect(terminal.result.usage).toEqual({
          inputTokens: 30,
          outputTokens: 19,
        });
      }
    });

    it("reports the silent mid-stream abort as an explicit aborted terminal", async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      const partial = [
        sseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_s2",
            type: "message",
            role: "assistant",
            model: "claude-test-1",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        }),
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Half an ans" },
        }),
      ].join("");
      // The body ends mid-stream (no message_stop) with the signal aborted —
      // the S4 silent end. The adapter must yield `aborted`, never just end.
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
      const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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

    it("a clean stream that ends without message_stop and without abort throws (stream failure)", async () => {
      const { fetchImpl } = fakeFetchSequence([
        {
          body: sseFrame("message_start", {
            type: "message_start",
            message: {
              id: "msg_s3",
              type: "message",
              role: "assistant",
              model: "claude-test-1",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          }),
        },
      ]);
      const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
      await expect(async () => {
        for await (const _ of adapter.generateStream({
          binding,
          messages: [{ role: "user", content: "go" }],
          maxTokens: 64,
        })) {
          // drain
        }
      }).rejects.toThrow(/ended unexpectedly/);
    });

    /**
     * B2 (ADR 0026). Tool-call arguments are accumulated as text and parsed
     * once at the end, so a turn cut off by `max_tokens` MID-ARGUMENTS used to
     * throw a bare `SyntaxError` out of the generator — which the loop read as
     * a stream failure and reported as "Unexpected end of JSON input". The A6
     * `turn.truncated` notice, which exists to explain exactly this, could
     * therefore never fire for it. The recovery needs the call to survive.
     */
    const truncatedArgsSse = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_s4",
          type: "message",
          role: "assistant",
          model: "claude-test-1",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_cut",
          name: "propose_edit",
          input: {},
        },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"edits":[{"file":"main.tex","anch',
        },
      }),
    ];

    it("surfaces a max_tokens turn's unparseable tool call instead of throwing (B2)", async () => {
      const { fetchImpl } = fakeFetchSequence([
        {
          body: [
            ...truncatedArgsSse,
            sseFrame("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "max_tokens", stop_sequence: null },
              usage: { output_tokens: 8192 },
            }),
            sseFrame("message_stop", { type: "message_stop" }),
          ].join(""),
        },
      ]);
      const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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
      // The call is present — so the loop can fail it back by id and keep the
      // conversation's tool_use/tool_result pairing legal — with EMPTY args,
      // because the salvaged half is not a request anyone may act on.
      expect(result.toolCalls).toEqual([
        { id: "toolu_cut", name: "propose_edit", args: {} },
      ]);
    });

    it("still throws on unparseable arguments in a COMPLETE turn (B2)", async () => {
      // Only truncation excuses a broken argument buffer. Anywhere else it is
      // a provider defect and must not be swallowed into an empty-args call.
      const { fetchImpl } = fakeFetchSequence([
        {
          body: [
            ...truncatedArgsSse,
            sseFrame("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 12 },
            }),
            sseFrame("message_stop", { type: "message_stop" }),
          ].join(""),
        },
      ]);
      const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
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

describe("AnthropicModelAdapter — images on the wire (V3, ADR 0080 §3)", () => {
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

  it("puts image blocks INSIDE tool_result.content, each named just before it (S6 §2's shape, ADR 0083 §1)", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    const messages: ChatMessage[] = [
      { role: "user", content: "<the task>" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "toolu_01", name: "view_pdf_pages", args: { pages: [1] } },
        ],
      },
      {
        role: "tool",
        content: '{"ok":true,"pages":[1]}',
        toolCallId: "toolu_01",
        images: [{ mimeType: "image/png", data: PNG_B64, label: "page 1" }],
      },
    ];
    await adapter.generate({ binding, messages, maxTokens: 1200 });

    expect(captured[0]?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "<the task>" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "view_pdf_pages",
            input: { pages: [1] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: [
              { type: "text", text: '{"ok":true,"pages":[1]}' },
              { type: "text", text: "[page 1]" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: PNG_B64,
                },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("a user message with images sends [text, …(label, image)]", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [
        {
          role: "user",
          content: "look",
          images: [
            { mimeType: "image/png", data: PNG_B64, label: "page 1" },
            { mimeType: "image/png", data: "QUJD", label: "page 2" },
          ],
        },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "text", text: "[page 1]" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_B64 },
          },
          { type: "text", text: "[page 2]" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "QUJD" },
          },
        ],
      },
    ]);
  });

  it("a present image with no label goes out with no label block (ADR 0083 §1)", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
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
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_B64 },
          },
        ],
      },
    ]);
  });

  it("an EVICTED part becomes a text placeholder naming what was shown", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [
        {
          role: "tool",
          content: '{"pages":[3]}',
          toolCallId: "toolu_9",
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
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_9",
            content: [
              { type: "text", text: '{"pages":[3]}' },
              { type: "text", text: "[page 3 — viewed]" },
              { type: "text", text: "[image — viewed]" },
            ],
          },
        ],
      },
    ]);
  });

  it("a binding that cannot see gets NO image block, only the placeholder", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      // The table says `claude…` sees; the per-model override says otherwise,
      // and the override wins. This is the SECOND lock — the tool is already
      // withheld at the allowlist.
      binding: { ...binding, imageInput: false },
      messages: [
        {
          role: "tool",
          content: '{"pages":[1]}',
          toolCallId: "toolu_1",
          images: [{ mimeType: "image/png", data: PNG_B64, label: "page 1" }],
        },
      ],
      maxTokens: 128,
    });

    const body = JSON.stringify(captured[0]?.body);
    expect(body).not.toContain(PNG_B64);
    expect(body).not.toContain('"image"');
    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: '{"pages":[1]}' },
              { type: "text", text: "[page 1 — viewed]" },
            ],
          },
        ],
      },
    ]);
  });

  it("an EMPTY images array leaves content a plain string, exactly as today", async () => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    const adapter = new AnthropicModelAdapter({ fetch: fetchImpl });
    await adapter.generate({
      binding,
      messages: [
        { role: "user", content: "hi", images: [] },
        { role: "tool", content: "{}", toolCallId: "t1", images: [] },
      ],
      maxTokens: 128,
    });

    expect(captured[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_result", tool_use_id: "t1", content: "{}" },
        ],
      },
    ]);
  });
});

/**
 * The current Claude generation's wire (Claude docs, read 2026-10-20 for
 * Haiku 5.5): sampling parameters other than the default are a 400, a manual
 * thinking budget is a 400 — thinking is adaptive, set by effort — and most
 * of them think when the request says nothing. Every built-in action sends a
 * `temperature`, so without this every quick action on Haiku 5.5 failed.
 */
describe("AnthropicModelAdapter — the current generation's wire", () => {
  const on = (model: string): ModelBinding => ({ ...binding, model });
  const unary = async (
    model: string,
    extra: {
      temperature?: number;
      thinkingBudget?: "none" | "low" | "medium" | "high";
    },
  ) => {
    const { fetchImpl, captured } = fakeFetch(textResponse);
    await new AnthropicModelAdapter({ fetch: fetchImpl }).generate({
      binding: on(model),
      messages: [{ role: "user", content: "Polish this." }],
      maxTokens: 8192,
      ...extra,
    });
    return captured[0]?.body ?? {};
  };
  const streamed = async (model: string) => {
    const sse = [
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ].join("");
    const { fetchImpl, captured } = fakeFetchSequence([{ body: sse }]);
    for await (const _ of new AnthropicModelAdapter({
      fetch: fetchImpl,
    }).generateStream({
      binding: on(model),
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
      temperature: 0.3,
      thinkingBudget: "medium",
    })) {
      // drain
    }
    return captured[0]?.body ?? {};
  };

  it("Haiku 5.5: a quick action's temperature is not sent, and thinking is turned off when none is asked for", async () => {
    // polish.yaml: `temperature: 0.3`, `thinking_budget: none`.
    const body = await unary("claude-haiku-5-5", {
      temperature: 0.3,
      thinkingBudget: "none",
    });
    expect(body.temperature).toBeUndefined();
    // Omitted, Haiku 5.5 thinks — and thinking counts toward max_tokens.
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
    // Absent is `none` too: the action declared nothing.
    expect((await unary("claude-haiku-5-5", {})).thinking).toEqual({
      type: "disabled",
    });
  });

  it("Haiku 5.5: a declared budget is sent as adaptive thinking at that effort, never as budget_tokens", async () => {
    for (const level of ["low", "medium", "high"] as const) {
      const body = await unary("claude-haiku-5-5", { thinkingBudget: level });
      expect(body.thinking, level).toEqual({ type: "adaptive" });
      expect(body.output_config, level).toEqual({ effort: level });
    }
  });

  it("Haiku 5.5 on the stream path: thinking off, no temperature — the streamed signed-echo gap stays closed", async () => {
    // ADR 0015 never sends `thinking` here. On a model that thinks when told
    // nothing, "never sent" stopped meaning "off", so it is said out loud.
    const body = await streamed("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it("a model that cannot turn thinking off is never told to: Sonnet 5.5, Opus 5.5, Fable", async () => {
    for (const model of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]) {
      const none = await unary(model, {
        temperature: 0.3,
        thinkingBudget: "none",
      });
      expect(none.thinking, model).toBeUndefined();
      expect(none.temperature, model).toBeUndefined();
      expect((await streamed(model)).thinking, model).toBeUndefined();
      const high = await unary(model, { thinkingBudget: "high" });
      expect(high.thinking, model).toEqual({ type: "adaptive" });
      expect(high.output_config, model).toEqual({ effort: "high" });
    }
  });

  it("the preset's other two models drop their temperature too: Sonnet 5 thinks by default, Opus 4.8 does not", async () => {
    const sonnet = await unary("claude-sonnet-5", {
      temperature: 0.3,
      thinkingBudget: "none",
    });
    expect(sonnet.temperature).toBeUndefined();
    expect(sonnet.thinking).toEqual({ type: "disabled" });
    const opus = await unary("claude-opus-4-8", {
      temperature: 0.3,
      thinkingBudget: "none",
    });
    expect(opus.temperature).toBeUndefined();
    // It does not think unasked, so there is nothing to turn off.
    expect(opus.thinking).toBeUndefined();
  });

  it("the longest row wins: Sonnet 5.5 is not read as Sonnet 5, nor Opus 5.5 as Opus 5", async () => {
    expect(
      (await unary("claude-sonnet-5-5", { thinkingBudget: "none" })).thinking,
    ).toBeUndefined();
    expect(
      (await unary("claude-sonnet-5", { thinkingBudget: "none" })).thinking,
    ).toEqual({ type: "disabled" });
    expect(
      (await unary("claude-opus-5-5", { thinkingBudget: "none" })).thinking,
    ).toBeUndefined();
    expect(
      (await unary("claude-opus-5", { thinkingBudget: "none" })).thinking,
    ).toEqual({ type: "disabled" });
  });

  it("an older model's wire is exactly as it was: temperature sent, a budget as budget_tokens", async () => {
    for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-4-5"]) {
      const plain = await unary(model, {
        temperature: 0.3,
        thinkingBudget: "none",
      });
      expect(plain.temperature, model).toBe(0.3);
      expect(plain.thinking, model).toBeUndefined();
      const thinking = await unary(model, { thinkingBudget: "low" });
      expect(thinking.thinking, model).toEqual({
        type: "enabled",
        budget_tokens: 2048,
      });
      expect(thinking.output_config, model).toBeUndefined();
      expect((await streamed(model)).thinking, model).toBeUndefined();
      expect((await streamed(model)).temperature, model).toBe(0.3);
    }
  });
});
