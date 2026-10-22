import type { ModelAdapterFactory } from "../contracts/adapters.js";
import { AnthropicModelAdapter } from "./anthropic.js";
import { OpenAICompatibleModelAdapter } from "./openai-compatible.js";
import { KNOWN_MODEL_PRICING } from "./pricing.js";
import type { HttpAdapterOptions } from "./shared.js";

/**
 * Default production factory. Tests substitute a factory returning a
 * ScriptedModelAdapter. Pricing defaults to the bundled snapshot table (ADR 0009)
 * so `Usage.costUsd` is populated for known model families; pass an explicit
 * `pricing` to override or `{pricing: {}}` to disable. The wider
 * HttpAdapterOptions param (fetch/maxRetries) keeps unit tests offline.
 */
export const createModelAdapter = ((
  protocol,
  options: HttpAdapterOptions = {},
) => {
  const opts: HttpAdapterOptions = {
    pricing: KNOWN_MODEL_PRICING,
    ...options,
  };
  return protocol === "anthropic"
    ? new AnthropicModelAdapter(opts)
    : new OpenAICompatibleModelAdapter(opts);
}) satisfies ModelAdapterFactory;
