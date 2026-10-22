import Anthropic from "@anthropic-ai/sdk";
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

const THINKING_BUDGET_TOKENS = {
  low: 2048,
  medium: 8192,
  high: 16384,
} as const;

/** Anthropic rejects thinking.budget_tokens below this. */
const MIN_THINKING_TOKENS = 1024;

/**
 * What one Claude model accepts on the wire (ADR 0090 §6).
 *
 * The current generation changed three things a request carries, and each is
 * a 400 if sent the old way: a non-default `temperature` (every built-in
 * action sends one), a manual `budget_tokens` (thinking is adaptive, set by
 * `output_config.effort`), and — not a 400, but a behaviour — thinking runs
 * when the request says nothing, and counts toward `max_tokens`.
 */
interface AnthropicWireProfile {
  /** Accepts a non-default `temperature`. */
  sampling: boolean;
  /** How a declared thinking budget goes out. */
  thinking: "budget" | "adaptive";
  /** Omitting `thinking` runs adaptive thinking. */
  thinksByDefault: boolean;
  /** `{type: "disabled"}` is accepted at the default effort. */
  canDisable: boolean;
}

/** Everything before the current generation: the wire as it always was. */
const LEGACY_WIRE: AnthropicWireProfile = {
  sampling: true,
  thinking: "budget",
  thinksByDefault: false,
  canDisable: true,
};
const CURRENT = { sampling: false, thinking: "adaptive" } as const;

/**
 * Model-id prefix → its wire, from the Claude docs' per-model tables (read
 * 2026-10-20). Longest prefix wins — the same six-line matcher as
 * `imageInputFor` and `contextWindowFor` — which is why the `-5-5` rows exist
 * beside the `-5` ones: Sonnet 5 can turn thinking off and Sonnet 5.5 cannot.
 *
 * **This table is a decision the gate ratifies, and none of it is measured
 * live** — the Anthropic pin is off. A model absent here keeps the legacy wire.
 */
export const ANTHROPIC_WIRE_PROFILES: Record<string, AnthropicWireProfile> = {
  "claude-haiku-5-5": { ...CURRENT, thinksByDefault: true, canDisable: true },
  "claude-sonnet-5": { ...CURRENT, thinksByDefault: true, canDisable: true },
  "claude-sonnet-5-5": { ...CURRENT, thinksByDefault: true, canDisable: false },
  "claude-opus-4-7": { ...CURRENT, thinksByDefault: false, canDisable: true },
  "claude-opus-4-8": { ...CURRENT, thinksByDefault: false, canDisable: true },
  "claude-opus-5": { ...CURRENT, thinksByDefault: true, canDisable: true },
  "claude-opus-5-5": { ...CURRENT, thinksByDefault: true, canDisable: false },
  "claude-fable-5": { ...CURRENT, thinksByDefault: true, canDisable: false },
};

/** What the table says about a model id. Longest prefix wins. */
function wireFor(model: string): AnthropicWireProfile {
  let best: { prefix: string; wire: AnthropicWireProfile } | undefined;
  for (const [prefix, wire] of Object.entries(ANTHROPIC_WIRE_PROFILES)) {
    if (
      model.startsWith(prefix) &&
      (!best || prefix.length > best.prefix.length)
    ) {
      best = { prefix, wire };
    }
  }
  return best?.wire ?? LEGACY_WIRE;
}

/** The thinking-related fields of one request. */
interface ThinkingFields {
  thinking?:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive" }
    | { type: "disabled" };
  output_config?: { effort: "low" | "medium" | "high" };
}

/**
 * The thinking a request asks for, in the model's own wire.
 *
 * A token budget must stay strictly under max_tokens and at or above the API
 * minimum, or the request 400s — clamp down, and drop thinking entirely when
 * max_tokens leaves no room (budgets only ever shrink, invariant 5). An
 * adaptive model takes the budget's level as its effort instead. Asked for no
 * thinking, a model that would think anyway is told not to — when it can be.
 */
function resolveThinking(
  wire: AnthropicWireProfile,
  thinkingBudget: GenerateRequest["thinkingBudget"],
  maxTokens: number,
): ThinkingFields {
  if (!thinkingBudget || thinkingBudget === "none") {
    return wire.thinksByDefault && wire.canDisable
      ? { thinking: { type: "disabled" } }
      : {};
  }
  if (wire.thinking === "adaptive") {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: thinkingBudget },
    };
  }
  const budget = Math.min(
    THINKING_BUDGET_TOKENS[thinkingBudget],
    maxTokens - 1,
  );
  if (budget < MIN_THINKING_TOKENS) return {};
  return { thinking: { type: "enabled", budget_tokens: budget } };
}

/**
 * The request's `temperature`, when the model may be sent one: never to a
 * model that rejects sampling, and never beside a manual thinking budget,
 * which Anthropic also rejects.
 */
function temperatureFor(
  wire: AnthropicWireProfile,
  thinking: ThinkingFields,
  temperature: number | undefined,
): number | undefined {
  if (!wire.sampling) return undefined;
  return thinking.thinking?.type === "enabled" ? undefined : temperature;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // V3 (ADR 0080 §3): `content` widened from `string` because image blocks go
  // INSIDE the tool result on this wire — the concrete difference from the
  // OpenAI-compatible one, which cannot and needs a trailing user message.
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  // Opaque provider reasoning blocks echoed back verbatim (ADR 0006).
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/**
 * Image parts as this wire carries them (V3, ADR 0080 §3).
 *
 * A part with no `data` has been EVICTED and becomes a text placeholder naming
 * what was shown — at the wire, never by rewriting the message's `content`,
 * because `session/run.ts` requires the live history to stay byte-identical in
 * text to the one rebuilt from persisted items.
 *
 * `canSee` false renders EVERY part as its placeholder: the second of the two
 * locks that keep a pixel away from a model that declared it cannot read one.
 *
 * A PRESENT image with a label is named just before it, `[page 4]` — the
 * placeholder's own shape, and the same on both wires (ADR 0083 §1).
 */
function imageBlocks(
  images: readonly ImagePart[] | undefined,
  canSee: boolean,
): ContentBlock[] {
  return (images ?? []).flatMap((img): ContentBlock[] => {
    if (!(img.data && canSee)) {
      return [{ type: "text", text: `[${img.label ?? "image"} — viewed]` }];
    }
    const image: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
    };
    return img.label === undefined
      ? [image]
      : [{ type: "text", text: `[${img.label}]` }, image];
  });
}

/**
 * Reasoning blocks are opaque provider data carried through `ChatMessage.reasoning`
 * / `GenerateResult.reasoning` (ADR 0006). We only ever move them verbatim.
 */
function reasoningBlocks(reasoning: unknown): ContentBlock[] {
  return Array.isArray(reasoning) ? (reasoning as ContentBlock[]) : [];
}

interface MappedMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/**
 * system messages hoist to the top-level param; tool results travel as user-turn
 * tool_result blocks; consecutive same-role turns merge (Anthropic requires
 * strict user/assistant alternation).
 */
function toAnthropicMessages(
  messages: ChatMessage[],
  canSee = true,
): {
  system: string | undefined;
  mapped: MappedMessage[];
} {
  const system =
    messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n") || undefined;
  const mapped: MappedMessage[] = [];
  const push = (role: MappedMessage["role"], blocks: ContentBlock[]) => {
    const last = mapped.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else mapped.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      push("user", [
        { type: "text", text: m.content },
        ...imageBlocks(m.images, canSee),
      ]);
    } else if (m.role === "assistant") {
      // Signed thinking blocks lead the turn: Anthropic requires them echoed
      // verbatim to continue a thinking-enabled tool loop (ADR 0006).
      const blocks: ContentBlock[] = [...reasoningBlocks(m.reasoning)];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args ?? {},
        });
      }
      // An empty assistant turn (no text, no tool calls) would map to
      // content: [], which the API rejects — drop it.
      if (blocks.length > 0) push("assistant", blocks);
    } else {
      if (!m.toolCallId) {
        throw new Error(
          "anthropic: tool message is missing toolCallId (required to build a tool_result block)",
        );
      }
      // With no images the content stays a STRING, which is what lets every
      // merged assertion in anthropic.test.ts pass unedited (ADR 0080 §3).
      const blocks = imageBlocks(m.images, canSee);
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content:
            blocks.length > 0
              ? [{ type: "text", text: m.content }, ...blocks]
              : m.content,
        },
      ]);
    }
  }
  return { system, mapped };
}

export class AnthropicModelAdapter implements ModelAdapter {
  readonly protocol = "anthropic" as const;

  constructor(private readonly options: HttpAdapterOptions = {}) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = new Anthropic({
      apiKey: req.binding.apiKey,
      baseURL: req.binding.endpoint,
      fetch: this.options.fetch,
      maxRetries: this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
    const { system, mapped } = toAnthropicMessages(
      req.messages,
      canSeeImages(req.binding),
    );
    const wire = wireFor(req.binding.model);
    const thinking = resolveThinking(wire, req.thinkingBudget, req.maxTokens);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: req.binding.model,
          max_tokens: req.maxTokens,
          system,
          messages: mapped as Anthropic.MessageParam[],
          tools: req.tools?.length
            ? req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool["input_schema"],
              }))
            : undefined,
          temperature: temperatureFor(wire, thinking, req.temperature),
          ...thinking,
        },
        { signal: req.signal },
      );
    } catch (error) {
      if (error instanceof Anthropic.APIUserAbortError) {
        return {
          text: "",
          toolCalls: [],
          stopReason: "aborted",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      throw error;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      // The model may emit any name; validating against the ToolName allowlist
      // is the action engine's job (M3) before any tool is invoked.
      .map((b) => ({ id: b.id, name: b.name as ToolName, args: b.input }));
    // Signed thinking blocks carried opaquely for the next turn's echo (ADR 0006).
    const reasoning = response.content.filter(
      (b) => b.type === "thinking" || b.type === "redacted_thinking",
    );
    const stopReason =
      response.stop_reason === "tool_use"
        ? ("tool_use" as const)
        : response.stop_reason === "max_tokens"
          ? ("max_tokens" as const)
          : ("stop" as const);
    return {
      text,
      toolCalls,
      stopReason,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      usage: withCost(
        this.options.pricing,
        req.binding.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
      ),
    };
  }

  /**
   * Streamed generation (ADR 0015): raw SSE events folded into
   * `text_delta`/`tool_call_delta` fragments plus one terminal event. The
   * S4 silent abort is made explicit — after the SDK iterator ends without a
   * `message_stop`, an aborted signal yields `aborted`; a non-aborted early
   * end throws (a stream failure the caller may classify). Thinking is never
   * turned ON on this path (the unverified streamed signed-echo gap, ADR
   * 0015) — and on a model that thinks unasked it is turned OFF where it can
   * be, because there "never sent" stopped meaning "off" (ADR 0090 §6).
   */
  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    const client = new Anthropic({
      apiKey: req.binding.apiKey,
      baseURL: req.binding.endpoint,
      fetch: this.options.fetch,
      maxRetries: this.options.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
    const { system, mapped } = toAnthropicMessages(
      req.messages,
      canSeeImages(req.binding),
    );

    // No budget is ever passed here, whatever the request declared.
    const wire = wireFor(req.binding.model);
    const thinking = resolveThinking(wire, "none", req.maxTokens);

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReasonRaw: string | null = null;
    let sawStop = false;
    const texts: string[] = [];
    /** Open tool_use blocks by content-block index → call ordinal + parts. */
    const calls = new Map<
      number,
      { ordinal: number; id: string; name: string; parts: string[] }
    >();
    const ordered: { id: string; name: string; parts: string[] }[] = [];

    try {
      const stream = await client.messages.create(
        {
          model: req.binding.model,
          max_tokens: req.maxTokens,
          system,
          messages: mapped as Anthropic.MessageParam[],
          tools: req.tools?.length
            ? req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool["input_schema"],
              }))
            : undefined,
          temperature: temperatureFor(wire, thinking, req.temperature),
          ...thinking,
          stream: true,
        },
        { signal: req.signal },
      );
      for await (const event of stream) {
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens ?? 0;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            const entry = {
              ordinal: ordered.length,
              id: event.content_block.id,
              name: event.content_block.name,
              parts: [] as string[],
            };
            calls.set(event.index, entry);
            ordered.push(entry);
            // Announce the call immediately (id/name on the first fragment),
            // so zero-arg calls still surface live.
            yield {
              type: "tool_call_delta",
              index: entry.ordinal,
              id: entry.id,
              name: entry.name as GenerateResult["toolCalls"][number]["name"],
              argsDelta: "",
            };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            texts.push(event.delta.text);
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const entry = calls.get(event.index);
            if (entry) {
              entry.parts.push(event.delta.partial_json);
              yield {
                type: "tool_call_delta",
                index: entry.ordinal,
                argsDelta: event.delta.partial_json,
              };
            }
          }
        } else if (event.type === "message_delta") {
          stopReasonRaw = event.delta.stop_reason ?? stopReasonRaw;
          outputTokens = event.usage.output_tokens;
        } else if (event.type === "message_stop") {
          sawStop = true;
        }
      }
    } catch (error) {
      if (error instanceof Anthropic.APIUserAbortError) {
        yield { type: "aborted" };
        return;
      }
      throw error;
    }

    if (!sawStop) {
      if (req.signal?.aborted) {
        yield { type: "aborted" };
        return;
      }
      throw new Error("anthropic: stream ended unexpectedly");
    }

    const stopReason =
      stopReasonRaw === "tool_use"
        ? ("tool_use" as const)
        : stopReasonRaw === "max_tokens"
          ? ("max_tokens" as const)
          : ("stop" as const);
    const toolCalls = ordered.map((c) => ({
      id: c.id,
      // Allowlist validation is the engine's job, as on the unary path.
      name: c.name as GenerateResult["toolCalls"][number]["name"],
      // B2 (ADR 0026): a `max_tokens` turn's argument buffer is a JSON
      // fragment; surface the call with empty args so the loop can fail it
      // back, rather than throwing the whole task away on a SyntaxError.
      args: parseStreamedToolArgs(
        c.parts.join(""),
        stopReason === "max_tokens",
        () =>
          `anthropic: tool call ${c.name} (${c.id}) returned malformed JSON arguments`,
      ),
    }));
    yield {
      type: "completed",
      result: {
        text: texts.join(""),
        toolCalls,
        stopReason,
        usage: withCost(
          this.options.pricing,
          req.binding.model,
          inputTokens,
          outputTokens,
        ),
      },
    };
  }
}
