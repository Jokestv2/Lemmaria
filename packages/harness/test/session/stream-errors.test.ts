import { describe, expect, it } from "vitest";
import { ScriptExhaustedError } from "../../src/model/scripted.js";
import {
  type StreamFailureClass,
  classifyStreamFailure,
} from "../../src/session/stream-errors.js";

/** An SDK-shaped error: a message plus the HTTP status the client attached. */
function apiError(message: string, status?: number): Error {
  const error = new Error(message);
  return status === undefined ? error : Object.assign(error, { status });
}

describe("classifyStreamFailure (B2)", () => {
  const table: [string, unknown, StreamFailureClass][] = [
    // --- transient by status (A1a's original three, unchanged) ---
    ["a 429 throttle", apiError("rate limit exceeded", 429), "retryable"],
    ["a 500", apiError("internal server error", 500), "retryable"],
    ["a 503", apiError("overloaded_error", 503), "retryable"],
    ["a 408", apiError("request timeout", 408), "retryable"],

    // --- the class Lemmaria had no analogue for: a 429 that will never pass ---
    [
      "a 429 carrying OpenAI's quota code",
      apiError("You exceeded your current quota: insufficient_quota", 429),
      "quota",
    ],
    [
      "a 429 saying the quota is exceeded",
      apiError("Quota exceeded for this organization", 429),
      "quota",
    ],
    [
      "a 429 about billing",
      apiError("Your billing plan has no remaining credit", 429),
      "quota",
    ],
    [
      "a 400 about credit balance",
      apiError("Your credit balance is too low to access the API", 400),
      "quota",
    ],
    [
      "a quota message with no status at all",
      new Error("insufficient_quota"),
      "quota",
    ],

    // --- fatal by status ---
    ["a 400 bad request", apiError("invalid_request_error", 400), "fatal"],
    ["a 401", apiError("invalid x-api-key", 401), "fatal"],
    ["a 403", apiError("forbidden", 403), "fatal"],
    ["a 404 model id", apiError("model not found", 404), "fatal"],

    // --- transport wordings, no status (Pi's list, learned from real reports) ---
    ["ECONNRESET", new Error("read ECONNRESET"), "retryable"],
    ["a socket hang up", new Error("socket hang up"), "retryable"],
    ["ETIMEDOUT", new Error("connect ETIMEDOUT"), "retryable"],
    ["a network error", new Error("network error"), "retryable"],
    ["fetch failed", new TypeError("fetch failed"), "retryable"],
    [
      "getaddrinfo EAI_AGAIN",
      new Error("getaddrinfo EAI_AGAIN api.x"),
      "retryable",
    ],
    ["a terminated body", new Error("terminated"), "retryable"],
    ["the other side closing", new Error("other side closed"), "retryable"],

    // --- premature stream end: the case the SDK layer does NOT retry ---
    [
      "Anthropic's premature stream end",
      new Error("stream ended before message_stop"),
      "retryable",
    ],
    [
      "this harness's own premature stream end",
      new Error("anthropic: stream ended unexpectedly"),
      "retryable",
    ],
    [
      "the openai-compatible premature stream end",
      new Error("openai-compatible: stream ended unexpectedly"),
      "retryable",
    ],

    // --- neither transient nor quota ---
    ["an unrecognized failure", new Error("something odd"), "fatal"],
    ["a non-Error throw", "just a string", "fatal"],
    ["undefined", undefined, "fatal"],
  ];

  for (const [label, error, expected] of table) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyStreamFailure(error)).toBe(expected);
    });
  }

  it("checks the quota patterns BEFORE the retryable ones", () => {
    // The whole point of the class: this error is a 429 AND says "rate limit",
    // so every retryable signal matches — but retrying it can never succeed.
    const error = apiError(
      "rate_limit_error: quota exceeded, please add credit",
      429,
    );
    expect(classifyStreamFailure(error)).toBe("quota");
  });

  it("keeps ScriptExhaustedError fatal, so an over-run script never retries", () => {
    // B0's guard, re-asserted against the new classifier: an exhausted script
    // is a broken test, and retrying it would hide that behind a provider blip.
    const error = new ScriptExhaustedError(
      "ScriptedModelAdapter: the script ran out — asked for turn 2 of 1",
    );
    expect(classifyStreamFailure(error)).toBe("fatal");
  });

  it("reads the status even when it arrives as a plain property bag", () => {
    // The SDK errors reaching the loop are duck-typed, not instanceof-checked.
    expect(classifyStreamFailure({ status: 529 })).toBe("retryable");
  });
});
