// A6 acceptance suite (ADR 0023): the declared L2 model floor reaches the user.
//
// Resolved Q4 promised that the composer "states what it needs and says so when
// the configured model can't sustain the loop, rather than failing
// mysteriously". This suite is what makes that true end-to-end: the notice is
// produced by the harness, persisted in the transcript, and pushed to the
// webview like any other item.
import * as assert from "node:assert";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionItem,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface FloorApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  resetSessionForTests(): void;
}

interface TaskOutcome {
  status: string;
  items: SessionItem[];
}

/** The minimal streamed adapter the session loop needs. */
class OneShotModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    return {
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async *generateStream(
    _req: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "text_delta", text: this.text };
    yield {
      type: "completed",
      result: {
        text: this.text,
        toolCalls: [],
        stopReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };
  }
}

async function getApi(): Promise<FloorApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "the extension is installed");
  return (await ext.activate()) as FloorApi;
}

function binding(model: string): ModelBinding {
  return { protocol: "anthropic", endpoint: "stub://", model, apiKey: "" };
}

function noticeCodes(items: SessionItem[]): string[] {
  return items
    .filter((i) => i.type === "notice")
    .map((i) => (i.type === "notice" ? i.code : ""));
}

suite("A6: the model floor is stated, not implied (ADR 0023)", () => {
  suiteTeardown(async () => {
    (await getApi()).clearModelForTests();
  });

  test("an unverified model produces one honest notice, before any answer", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new OneShotModel("hi"), binding("llama3.1:8b"));
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `floor check ${Date.now()}`,
      })) as TaskOutcome;
      const codes = noticeCodes(outcome.items);
      assert.deepStrictEqual(
        codes.filter((c) => c === "model.unverified").length,
        1,
        "exactly one model.unverified notice",
      );
      // The warning must precede the answer it is warning about.
      const types = outcome.items.map((i) => i.type);
      assert.ok(
        types.indexOf("notice") < types.indexOf("agent_message"),
        "the notice arrives before the model's answer",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a verified model says nothing about the floor", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new OneShotModel("hi"), binding("claude-sonnet-4-5"));
    try {
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `floor quiet ${Date.now()}`,
      })) as TaskOutcome;
      assert.ok(
        !noticeCodes(outcome.items).includes("model.unverified"),
        "no floor notice for a verified model",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
