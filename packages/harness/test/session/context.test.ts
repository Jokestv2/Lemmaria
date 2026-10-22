import { describe, expect, it } from "vitest";
import type { ChatMessage, SessionEvent } from "../../src/contracts/index.js";
import {
  CONTEXT_STOP_FRACTION,
  DEFAULT_CONTEXT_WINDOW,
  IMAGE_TOKEN_ESTIMATE,
  contextLimitReached,
  contextWindowFor,
  estimateWindowTokens,
  lastMeasuredOccupancy,
  tokensInWindow,
  windowOccupancy,
} from "../../src/session/context.js";
import { linearEntries } from "../support/entries.js";

/** ADR 0027: the fold reads a BRANCH. A session that was never rewound is one
 *  straight branch, so these fixtures wrap unchanged. */
const occupancyOf = (events: readonly SessionEvent[]) =>
  lastMeasuredOccupancy(linearEntries(events));

describe("context-window accounting (ADR 0015, the pre-A2 honest stop)", () => {
  it("matches a known model by prefix", () => {
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
  });

  it("knows the two new models, at conservative floors", () => {
    // gpt-6-luna: OpenAI publishes 1,050,000, but the floor is the gpt-5
    // row's 272K — the family's input cap, the edge of the short-context rate
    // card, and the largest window ADR 0048's catalogue budget was sized for.
    expect(contextWindowFor("gpt-6-luna")).toBe(272_000);
    // Haiku 5.5 takes 1M; the `claude` floor already under-states it safely.
    expect(contextWindowFor("claude-haiku-5-5")).toBe(200_000);
  });

  it("prefers the longest matching prefix", () => {
    // gpt-4o must not swallow gpt-4o-mini if their windows ever diverge;
    // pin the longest-prefix rule itself with the gpt-5 family.
    expect(contextWindowFor("gpt-5-mini")).toBe(contextWindowFor("gpt-5"));
  });

  it("falls back to the conservative default for unknown models", () => {
    expect(contextWindowFor("totally-local-model")).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("occupancy after a turn = input + output tokens of that turn", () => {
    expect(tokensInWindow({ inputTokens: 900, outputTokens: 100 })).toBe(1000);
  });

  it("reaches the limit at exactly the stop fraction of the window", () => {
    const window = contextWindowFor("claude-haiku-4-5");
    const threshold = Math.floor(window * CONTEXT_STOP_FRACTION);
    expect(contextLimitReached(threshold - 1, "claude-haiku-4-5")).toBe(false);
    expect(contextLimitReached(threshold, "claude-haiku-4-5")).toBe(true);
  });
});

describe("lastMeasuredOccupancy (A5 reload survival)", () => {
  const turn = (n: number, inputTokens: number): SessionEvent => ({
    type: "turn.completed",
    turn: n,
    usage: { inputTokens, outputTokens: 100 },
  });

  it("reads back the NEWEST turn's measured occupancy", () => {
    expect(occupancyOf([turn(1, 900), turn(2, 4900)])).toBe(5000);
  });

  it("is unknown for a stream that has never completed a turn", () => {
    expect(occupancyOf([])).toBeUndefined();
    expect(occupancyOf([{ type: "turn.started", turn: 1 }])).toBeUndefined();
  });

  it("is unknown after a compaction — the summary is not what those turns measured", () => {
    const compacted: SessionEvent = {
      type: "item.completed",
      item: {
        id: "c1",
        type: "compaction",
        summary: "…",
        trigger: "auto",
        retainedItemIds: [],
        tokensBefore: 5000,
      },
    };
    expect(occupancyOf([turn(1, 4900), compacted])).toBeUndefined();
    // …but a turn AFTER the compaction is a fresh measurement and does count.
    expect(occupancyOf([turn(1, 4900), compacted, turn(2, 500)])).toBe(600);
  });
});

describe("windowOccupancy (ADR 0051 — the estimate fallback)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "x".repeat(400) }, // 100 estimated tokens
    { role: "user", content: "y".repeat(800) }, // 200
  ];

  it("estimates the whole request, system envelope included", () => {
    expect(estimateWindowTokens(messages)).toBe(300);
  });

  it("prefers a real measurement over the estimate", () => {
    expect(
      windowOccupancy({ inputTokens: 9000, outputTokens: 100 }, messages),
    ).toBe(9100);
  });

  it("estimates when the provider reported no usage at all", () => {
    expect(windowOccupancy(undefined, messages)).toBe(300);
  });

  it("estimates when a completed turn reports ZERO input tokens", () => {
    // The case that actually reaches us: `openai-compatible` maps a missing
    // `usage` block to zeros, so the silence arrives wearing a number and is
    // truthy. A completed turn always consumed input — the history was sent —
    // so 0 is not a measurement (ADR 0051 fact 2).
    expect(windowOccupancy({ inputTokens: 0, outputTokens: 0 }, messages)).toBe(
      300,
    );
  });

  it("is zero for an empty request with nothing measured", () => {
    expect(windowOccupancy(undefined, [])).toBe(0);
  });
});

describe("estimateWindowTokens counts live images (V3, ADR 0080 §5)", () => {
  it("adds one image estimate per part that still has its pixels", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "",
        toolCallId: "c1",
        images: [
          { mimeType: "image/png", data: "AAA=", label: "page 1" },
          { mimeType: "image/png", data: "BBB=", label: "page 2" },
        ],
      },
    ];
    expect(estimateWindowTokens(messages)).toBe(2 * IMAGE_TOKEN_ESTIMATE);
  });

  it("an EVICTED part costs nothing — it reaches the wire as a short placeholder", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "",
        toolCallId: "c1",
        images: [
          { mimeType: "image/png", label: "page 1" },
          { mimeType: "image/png", data: "BBB=", label: "page 2" },
        ],
      },
    ];
    expect(estimateWindowTokens(messages)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it("a history with no images estimates exactly as before", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "x".repeat(400) },
      { role: "tool", content: "y".repeat(400), toolCallId: "c1", images: [] },
    ];
    expect(estimateWindowTokens(messages)).toBe(200);
  });
});
