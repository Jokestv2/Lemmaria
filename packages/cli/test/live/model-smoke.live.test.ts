/**
 * M1's acceptance smoke: one real generation per protocol, asserted at the
 * **adapter** contract rather than through the session machinery.
 *
 * This is the only live scenario that calls `ModelAdapter.generate` directly.
 * Everything else in this directory drives `runEvalTask`, which is the right
 * altitude for behaviour but cannot fail on the thing M1 shipped: that each
 * adapter can reach its endpoint, parse a response, and report usage and a
 * stop reason. A session-level test passes with a plausible-looking transcript
 * even if `usage` is zeroed or `stopReason` is wrong.
 *
 * **Why it lives here and not in `packages/harness/test/model/`.** It used to
 * be `packages/harness/test/model/smoke.test.ts`, inside `pnpm test` behind
 * `describe.runIf(Boolean(process.env.LEMMARIA_SMOKE_*_KEY))` — a real-network
 * test in the offline suite, kept out of it by a runtime guard alone. That is
 * exactly the arrangement
 * [ADR 0035](../../../../Lemmaria-design-doc/docs/adr/0035-gate-record-tiers.md)
 * §5's first bullet rules out: the live tier is *"excluded from `pnpm test` by
 * config, not by a runtime guard alone, so the default suite stays free and
 * offline even if a guard is forgotten"*. The file predated the tier and was
 * missed when the tier was written. It cost a gate: T3's `pnpm test` ran in an
 * environment with the operator's key exported, the guard opened, and the call
 * failed on billing — a red suite on a milestone whose `packages/` diff was
 * empty. The decision to move it is recorded in
 * [open-questions.md](../../../../Lemmaria-design-doc/docs/open-questions.md)
 * → *DECIDED — not yet implemented*.
 *
 * **The move increases coverage rather than reducing it.** Under the old
 * placement the suite was skipped wherever no key was set — CI and every clean
 * checkout — so in practice nothing ran it. Here the build session runs it once
 * per gate on provisioned keys (§5's fourth bullet).
 *
 * **The offline half is not lost, and never lived in this file.**
 * `packages/harness/test/model/anthropic.test.ts` and `openai-compatible.test.ts`
 * assert both adapters' request shaping, response parsing, usage accounting and
 * error handling against `test/model/fake-fetch.ts`. Those stay in `pnpm test`,
 * where they belong: they are the contract, and this is the endpoint.
 *
 * **One deliberate change from the old file:** the models come from
 * [`pins.ts`](./pins.ts) instead of per-test env overrides defaulting to
 * `gpt-4o-mini` / `claude-haiku-4-5-20251001`. Same rule as every other
 * scenario here — cheap and dated, never an alias (§5's fifth bullet). The
 * Anthropic pin is unchanged in value; the OpenAI one moves to
 * `LIVE_OPENAI_MODEL`. Endpoint overrides still work: `liveBinding` reads
 * `LEMMARIA_SMOKE_*_ENDPOINT` and falls back to the provider preset.
 *
 * **These assertions are one-sided on purpose.** Unlike the behavioural
 * scenarios here, there is no outcome set to accept: a generation either came
 * back with text, counted input tokens, and stopped cleanly, or the adapter is
 * broken. Nothing about the model's judgement is being measured, so nothing
 * here is allowed to be flaky by design.
 */
import {
  AnthropicModelAdapter,
  OpenAICompatibleModelAdapter,
} from "@lemmaria/harness";
import { describe, expect, it } from "vitest";
import { liveBinding } from "../../src/eval/run-eval.js";
import {
  LIVE_ANTHROPIC_MODEL,
  LIVE_OPENAI_MODEL,
  liveAnthropicReady,
  liveOpenAIReady,
} from "./pins.js";

/** The smallest exchange that still exercises parsing, usage and stop reason. */
const PROMPT = "Reply with exactly: OK";
const MAX_TOKENS = 16;

describe.skipIf(!liveAnthropicReady())("live adapter smoke (anthropic)", () => {
  it("round-trips one generation against the pinned model", async () => {
    const result = await new AnthropicModelAdapter().generate({
      binding: liveBinding("anthropic", LIVE_ANTHROPIC_MODEL),
      messages: [{ role: "user", content: PROMPT }],
      maxTokens: MAX_TOKENS,
    });

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    // The Anthropic adapter maps `end_turn` to `stop`; a `max_tokens` stop here
    // would mean the 16-token ceiling was hit by a one-word reply, which is a
    // parsing bug rather than a model choice.
    expect(result.stopReason).toBe("stop");
  });
});

describe.skipIf(!liveOpenAIReady())(
  "live adapter smoke (openai-compatible)",
  () => {
    it("round-trips one generation against the pinned model", async () => {
      const result = await new OpenAICompatibleModelAdapter().generate({
        binding: liveBinding("openai-compatible", LIVE_OPENAI_MODEL),
        messages: [{ role: "user", content: PROMPT }],
        maxTokens: MAX_TOKENS,
      });

      expect(result.text.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      // No `stopReason` assertion, deliberately: the old file asserted none here
      // either. Reasoning models on this protocol legitimately return `length`
      // against a 16-token ceiling, and turning that into a failure would measure
      // the pin rather than the adapter.
    });
  },
);
