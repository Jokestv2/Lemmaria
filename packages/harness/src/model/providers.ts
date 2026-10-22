/**
 * Provider presets: the curated menu behind the Models tab's add-model form.
 * A preset fills protocol + default endpoint + suggested model ids + whether a
 * key is required. vscode-free — the harness owns model knowledge; the host
 * relays these to the webview over the typed protocol. Ship Anthropic + OpenAI;
 * new providers (Gemini, Qwen, Ollama, LM Studio) are added here later with no
 * schema change.
 */

import type { Protocol } from "../contracts/adapters.js";

export interface ProviderPreset {
  id: string; // stable, e.g. "anthropic" | "openai"
  label: string; // display name, e.g. "Anthropic"
  protocol: Protocol;
  defaultEndpoint: string; // "" = the protocol's built-in default
  keyRequired: boolean;
  suggestedModels: string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    defaultEndpoint: "",
    keyRequired: true,
    suggestedModels: [
      "claude-opus-4-8",
      "claude-sonnet-5",
      // ADR 0090 §4: the current Haiku, beside the one the live pin measures.
      "claude-haiku-5-5",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-compatible",
    defaultEndpoint: "https://api.openai.com/v1",
    keyRequired: true,
    // ADR 0090 §4: gpt-6-luna, and the live pin's gpt-5.6-luna, which every
    // live row since R1 has run on and the menu never offered.
    suggestedModels: [
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-4o",
      "gpt-4o-mini",
      "o3-mini",
    ],
  },
];

export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
