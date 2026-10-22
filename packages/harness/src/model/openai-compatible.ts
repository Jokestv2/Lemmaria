import OpenAI from "openai";
import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  ImagePart,
  ModelAdapter,
  ModelStreamEvent,
} from "../contracts/adapters.js";
import type { ToolName } from "../contracts/tools.js";
import { canSeeImages } from "./capabilities.js";
import {
  DEFAULT_MAX_RETRIES,
  type HttpAdapterOptions,
  parseStreamedToolArgs,
  withCost,
} from "./shared.js";

/** The text this wire shows in place of an evicted (or withheld) image. */
function placeholderPart(img: ImagePart): {
  type: "text";
  text: string;
} {
  return { type: "text", text: `[${img.label ?? "image"} — viewed]` };
}

/**
 * Image parts as CONTENT PARTS on this wire (V3, ADR 0080 §3).
 *
 * A part with no `data` has been EVICTED; `canSee` false withholds every part.
 * Either way the part becomes a text placeholder, so both wires say the same
 * thing about what was shown and is gone.
 *
 * A PRESENT image with a label is named just before it, `[page 4]` — the
 * placeholder's own shape (ADR 0083 §1). Unnamed, the nearest *page N* beside
 * the image was the previous page's placeholder, and a real paper's seat cited
 * one page early. The label rides here, never in `content`, for the same
 * reason the placeholder does.
 */
function imageParts(
  images: readonly ImagePart[] | undefined,
  canSee: boolean,
): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  return (images ?? []).flatMap(
    (img): OpenAI.Chat.Completions.ChatCompletionContentPart[] => {
      if (!(img.data && canSee)) return [placeholderPart(img)];
      const image = {
        type: "image_url" as const,
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      };
      return img.label === undefined
        ? [image]
        : [{ type: "text", text: `[${img.label}]` }, image];
    },
  );
}

/**
 * Whether a message carries anything this wire has to render as a part —
 * an empty `images: []` is not a reason to leave the plain-string shape.
 */
function hasImages(m: ChatMessage): boolean {
  return (m.images?.length ?? 0) > 0;
}

/**
 * Maps one message. `tool` runs are handled by the caller, which is where the
 * trailing user message is synthesised — a `tool` message on this wire cannot
 * carry an image itself.
 */
function toOpenAIMessage(
  m: ChatMessage,
  canSee: boolean,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return hasImages(m)
        ? {
            role: "user",
            content: [
              { type: "text", text: m.content },
              ...imageParts(m.images, canSee),
            ],
          }
        : { role: "user", content: m.content };
    case "assistant": {
      const toolCalls = (m.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
      }));
      return {
        role: "assistant",
        content: m.content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case "tool": {
      if (!m.toolCallId) {
        throw new Error(
          "openai-compatible: tool message is missing toolCallId (required for tool_call_id)",
        );
      }
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
      };
    }
  }
}

/**
 * The trailing user message that carries a tool-result RUN's images (V3, ADR
 * 0080 §3) — Pi Agent's shape, kept because it is proven in production.
 *
 * This wire has no image block inside a tool result, so the images ride in one
 * `user` message placed after the run's last `tool` message. It is synthesised
 * HERE and not in the harness's history on purpose: a `user` message with
 * images in the live history is one the rebuilt history cannot reproduce, and
 * `selectRetainedMessageIds` could retain it across a checkpoint.
 */
const ATTACHED_IMAGES_SENTENCE = "Attached image(s) from tool result:";

function toOpenAIMessages(
  messages: ChatMessage[],
  canSee = true,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let run: ImagePart[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: ATTACHED_IMAGES_SENTENCE },
        ...imageParts(run, canSee),
      ],
    });
    run = [];
  };
  for (const m of messages) {
    // A run ENDS at the first message that is not a tool result — the images
    // then land immediately after the run's last `tool` message.
    if (m.role !== "tool") flushRun();
    out.push(toOpenAIMessage(m, canSee));
    if (m.role === "tool" && hasImages(m)) run.push(...(m.images ?? []));
  }
  flushRun();
  return out;
}

/**
 * True when the server rejected the request specifically because max_tokens is
 * unsupported and max_completion_tokens is required (newer OpenAI models). Keyed
 * off the returned param/code/message rather than the model id so it stays
 * portable — and narrow enough that a value-range 400 on max_tokens (e.g.
 * "must be >= 1") falls through to throw instead of a pointless retry.
 */
function requiresCompletionTokens(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
  if (/max_completion_tokens/i.test(String(error.message))) return true;
  return error.param === "max_tokens" && error.code === "unsupported_parameter";
}

/**
 * True when the server refused the request because the model cannot combine
 * function tools with a reasoning effort on `/v1/chat/completions`, and named
 * `reasoning_effort: "none"` as the remedy:
 *
 * > Function tools with reasoning_effort are not supported for <model> in
 * > /v1/chat/completions. To use function tools, use /v1/responses or set
 * > reasoning_effort to 'none'.
 *
 * Lemmaria never sends `reasoning_effort` — the SERVER applies the model's own
 * default and then rejects its own combination, so there is nothing to stop
 * sending; the refusal has to be answered. Keyed off the message rather than
 * the model id, exactly like `requiresCompletionTokens`, so the next model in
 * the family needs no allowlist entry. The remedy (or the tools conflict) must
 * be named, which keeps a value-range 400 on `reasoning_effort` falling through
 * to throw instead of provoking a pointless retry.
 */
function requiresNoReasoningEffort(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
  const message = String(error.message);
  if (!/reasoning_effort/i.test(message)) return false;
  return /\bnone\b/i.test(message) || /\btools?\b/i.test(message);
}

/**
 * True when the server refused a `temperature` because the model takes only
 * its default (ADR 0090 §7):
 *
 * > Unsupported value: 'temperature' does not support 0.3 with this model.
 * > Only the default (1) value is supported.
 *
 * Measured live on 2026-10-20 for gpt-6-luna and the live pin gpt-5.6-luna:
 * every built-in quick action declares a temperature, so each one failed.
 * Keyed off the error, like the two above, so the next model in the family
 * needs no allowlist entry; the default must be NAMED, so a value-range 400
 * ("must be less than or equal to 2") still throws.
 */
function requiresDefaultTemperature(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError) || error.status !== 400) return false;
  const message = String(error.message);
  const named = error.param === "temperature" || /'temperature'/i.test(message);
  return named && /only the default/i.test(message);
}

/** Request shape adjustments the server asked for, accumulated across retries. */
interface RequestCorrections {
  tokenField: "max_tokens" | "max_completion_tokens";
  noReasoningEffort: boolean;
  /** The model takes only its default temperature: send none. */
  noTemperature: boolean;
}

/**
 * Send, re-sending whenever the server refuses for a reason it also tells us
 * how to fix. Each correction applies at most once, so this bottoms out after
 * at most four requests and cannot spin.
 *
 * A ladder rather than a single fallback because the corrections COMPOSE: a
 * gpt-5.x model rejects the legacy token field *and* the tools/reasoning_effort
 * combination, and a server may raise them in either order. Shared by the unary
 * and streamed paths — both 400s arrive before any chunk, so a stream simply
 * re-requests from scratch. Aborts match neither predicate and propagate to the
 * caller, which turns them into the protocol's `aborted` result.
 */
async function sendWithCorrections<T>(
  send: (corrections: RequestCorrections) => Promise<T>,
): Promise<T> {
  const corrections: RequestCorrections = {
    tokenField: "max_tokens",
    noReasoningEffort: false,
    noTemperature: false,
  };
  for (;;) {
    try {
      return await send(corrections);
    } catch (error) {
      if (
        requiresCompletionTokens(error) &&
        corrections.tokenField === "max_tokens"
      ) {
        corrections.tokenField = "max_completion_tokens";
        continue;
      }
      if (requiresNoReasoningEffort(error) && !corrections.noReasoningEffort) {
        corrections.noReasoningEffort = true;
        continue;
      }
      if (requiresDefaultTemperature(error) && !corrections.noTemperature) {
        corrections.noTemperature = true;
        continue;
      }
      throw error;
    }
  }
}

export class OpenAICompatibleModelAdapter implements ModelAdapter {
  readonly protocol = "openai-compatible" as const;

  constructor(private readonly options: HttpAdapterOptions = {}) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = new OpenAI({
      apiKey: req.binding.apiKey,
      baseURL: req.binding.endpoint,
      fetch: this.options.fetch,
      maxRetries: this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });

    const shared = {
      model: req.binding.model,
      messages: toOpenAIMessages(req.messages, canSeeImages(req.binding)),
      tools: req.tools?.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
      temperature: req.temperature,
    };
    // Sends one request carrying exactly one token-limit field (never both).
    // thinkingBudget has no portable equivalent on this protocol (ignored, M1).
    const send = (
      c: RequestCorrections,
    ): Promise<OpenAI.Chat.Completions.ChatCompletion> =>
      client.chat.completions.create(
        {
          ...shared,
          [c.tokenField]: req.maxTokens,
          ...(c.noReasoningEffort ? { reasoning_effort: "none" as const } : {}),
          // Undefined drops the field from the body: the model takes its own.
          ...(c.noTemperature ? { temperature: undefined } : {}),
        },
        { signal: req.signal },
      );

    const aborted: GenerateResult = {
      text: "",
      toolCalls: [],
      stopReason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    // Default to max_tokens and no reasoning_effort: the widely-supported shape
    // across OpenAI-compatible servers (DeepSeek, Ollama, ...). Newer OpenAI
    // models (gpt-5.x, o-series) refuse one or both — correct only after the
    // server says so, keeping the portable default and no per-model allowlist.
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await sendWithCorrections(send);
    } catch (error) {
      if (error instanceof OpenAI.APIUserAbortError) return aborted;
      throw error;
    }

    const choice = completion.choices[0];
    if (!choice)
      throw new Error("openai-compatible: response contained no choices");
    const toolCalls = (choice.message.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => {
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Loosely-compatible servers occasionally emit malformed JSON here;
          // name the offending call instead of surfacing a bare SyntaxError.
          throw new Error(
            `openai-compatible: tool call ${call.function.name} (${call.id}) returned malformed JSON arguments: ${call.function.arguments}`,
          );
        }
        // The model may emit any name; validating against the ToolName
        // allowlist is the action engine's job (M3) before any tool is invoked.
        return { id: call.id, name: call.function.name as ToolName, args };
      });
    const stopReason =
      choice.finish_reason === "tool_calls"
        ? ("tool_use" as const)
        : choice.finish_reason === "length"
          ? ("max_tokens" as const)
          : ("stop" as const);
    return {
      text: choice.message.content ?? "",
      toolCalls,
      stopReason,
      usage: withCost(
        this.options.pricing,
        req.binding.model,
        completion.usage?.prompt_tokens ?? 0,
        completion.usage?.completion_tokens ?? 0,
      ),
    };
  }

  /**
   * Streamed generation (ADR 0015): chunked deltas folded into
   * `text_delta`/`tool_call_delta` fragments plus one terminal event. The
   * `max_tokens`→`max_completion_tokens` retry carries over — the 400 arrives
   * before any chunk, so the alternate-field re-request streams from scratch.
   * The S4 silent abort is made explicit: an iterator that ends without a
   * finish_reason while the signal is aborted yields `aborted`; a
   * non-aborted early end throws (a stream failure the caller may classify).
   * `thinkingBudget` has no portable equivalent here (ignored, as unary).
   */
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    const client = new OpenAI({
      apiKey: req.binding.apiKey,
      baseURL: req.binding.endpoint,
      fetch: this.options.fetch,
      maxRetries: this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
    const shared = {
      model: req.binding.model,
      messages: toOpenAIMessages(req.messages, canSeeImages(req.binding)),
      tools: req.tools?.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined,
      temperature: req.temperature,
      stream: true as const,
      stream_options: { include_usage: true },
    };
    const send = (c: RequestCorrections) =>
      client.chat.completions.create(
        {
          ...shared,
          [c.tokenField]: req.maxTokens,
          ...(c.noReasoningEffort ? { reasoning_effort: "none" as const } : {}),
          // Undefined drops the field from the body: the model takes its own.
          ...(c.noTemperature ? { temperature: undefined } : {}),
        },
        { signal: req.signal },
      );

    let stream: Awaited<ReturnType<typeof send>>;
    try {
      stream = await sendWithCorrections(send);
    } catch (error) {
      if (error instanceof OpenAI.APIUserAbortError) {
        yield { type: "aborted" };
        return;
      }
      throw error;
    }

    const texts: string[] = [];
    /** Open tool calls by the protocol's tool_call index. */
    const calls = new Map<
      number,
      { id: string; name: string; parts: string[] }
    >();
    const ordered: { id: string; name: string; parts: string[] }[] = [];
    let finish: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          texts.push(delta.content);
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const frag = tc.function?.arguments ?? "";
          const existing = calls.get(tc.index);
          if (!existing) {
            const entry = {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              parts: frag ? [frag] : [],
            };
            calls.set(tc.index, entry);
            ordered.push(entry);
            yield {
              type: "tool_call_delta",
              index: tc.index,
              id: entry.id,
              name: entry.name as ToolName,
              argsDelta: frag,
            };
          } else {
            if (frag) existing.parts.push(frag);
            yield { type: "tool_call_delta", index: tc.index, argsDelta: frag };
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      if (error instanceof OpenAI.APIUserAbortError) {
        yield { type: "aborted" };
        return;
      }
      throw error;
    }

    if (!finish) {
      if (req.signal?.aborted) {
        yield { type: "aborted" };
        return;
      }
      throw new Error("openai-compatible: stream ended unexpectedly");
    }

    const stopReason =
      finish === "tool_calls"
        ? ("tool_use" as const)
        : finish === "length"
          ? ("max_tokens" as const)
          : ("stop" as const);
    const toolCalls = ordered.map((call) => {
      const raw = call.parts.join("");
      // B2 (ADR 0026): a `length`-truncated turn's argument buffer is a JSON
      // fragment; surface the call with empty args so the loop can fail it
      // back, rather than throwing the whole task away (see shared.ts).
      const args = parseStreamedToolArgs(
        raw,
        stopReason === "max_tokens",
        // The raw buffer is deliberately NOT embedded (B2 review): it can be
        // arbitrarily large, and its text is fed to the stream-failure
        // classifier — a `propose_edit` body containing the word "connection"
        // or "timeout" would make a provider defect look retryable.
        () =>
          `openai-compatible: tool call ${call.name} (${call.id}) returned malformed JSON arguments`,
      );
      // Allowlist validation is the engine's job, as on the unary path.
      return { id: call.id, name: call.name as ToolName, args };
    });
    yield {
      type: "completed",
      result: {
        text: texts.join(""),
        toolCalls,
        stopReason,
        usage: withCost(
          this.options.pricing,
          req.binding.model,
          promptTokens,
          completionTokens,
        ),
      },
    };
  }
}
