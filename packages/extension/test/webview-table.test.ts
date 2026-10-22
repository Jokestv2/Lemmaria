/**
 * X4 (ADR 0044): a table renders in the REAL webview, and it scrolls rather
 * than widening the bubble.
 *
 * **This row is *offline* only because T2 built the instrument.** Before
 * [ADR 0043](../../../Lemmaria-design-doc/docs/adr/0043-drive-and-measure-seam.md)
 * the honest tier for *"a wide table does not blow out a 366px sidebar"* would
 * have been *eyes* carrying the reason *"jsdom performs no layout"* — which
 * [ADR 0038](../../../Lemmaria-design-doc/docs/adr/0038-report-by-exception-and-eyes-reasons.md)
 * §3 rules is a statement about our runner, not about a faculty only a human
 * has. Here `offsetWidth` is a number, `scrollWidth` means something, and the
 * measurement is arithmetic. What stays with the operator is only whether the
 * result *reads* as a table at that width, which is perception.
 *
 * **The table comes from a scripted model rather than an injected DOM node**,
 * for `webview-accept.test.ts`'s reason: a renderer can be correct while the
 * `main.ts` line that reaches it is dead, and only driving the real path covers
 * both.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ProbeResult, ProbeStep } from "../src/webview-protocol";

interface TableApi {
  revealWebviewForTests(): Promise<void>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  setModelForTests(adapter: unknown, binding?: unknown): void;
  clearModelForTests(): void;
  resetSessionForTests(): void;
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
}

async function getApi(): Promise<TableApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as TableApi;
}

function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

/** A model that answers with one fixed message and calls no tool. */
class AnsweringModel {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}

  private result() {
    return {
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(): Promise<unknown> {
    return Promise.resolve(this.result());
  }

  async *generateStream(req: { signal?: AbortSignal }): AsyncIterable<unknown> {
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    yield { type: "text_delta", text: this.text };
    yield { type: "completed", result: this.result() };
  }
}

/**
 * Wide on purpose: five columns of prose is what a real comparison answer looks
 * like, and it is the shape that has nowhere to go in a sidebar.
 */
const WIDE_TABLE = [
  "Here is the comparison.",
  "",
  "| Aspect | Systems papers | Theory papers | Typical venue | Common mistake |",
  "|---|---|---|---:|---|",
  "| Subject | Implementation and measurement | Definitions and proofs | OSDI or STOC | Burying the claim |",
  "| Evidence | Benchmarks under stated conditions | Logical completeness | SOSP or FOCS | Unstated assumptions |",
  "",
].join("\n");

async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

suite("X4 (ADR 0044): a wide table in the real webview", function () {
  this.timeout(60000);

  suiteTeardown(async () => {
    const api = await getApi();
    // The forced width is an override on a live view every other suite shares.
    // Clearing it is not politeness: `.vscode-test` reuses one window, and a
    // 320px panel left behind silently changes what a later suite measures.
    await api.probeWebviewForTests([
      { verb: "setWidth", selector: ".lm-app", px: 0 },
    ]);
    api.clearModelForTests();
  });

  test("scrolls inside its own wrapper instead of widening the bubble", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    await api.revealWebviewForTests();
    api.setModelForTests(new AnsweringModel(WIDE_TABLE));

    await api.probeWebviewForTests([
      { verb: "setWidth", selector: ".lm-app", px: 320 },
    ]);

    const send = api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "compare systems and theory papers",
    });

    // The DOM is what this suite is about, so the DOM is what it waits on.
    await until(async () => {
      const [n] = await api.probeWebviewForTests([
        { verb: "count", selector: ".lm-md__table" },
      ]);
      return n?.value === 1;
    }, "the table to render");

    const [cells, wrapOverflows, bubbleOverflows, wrapRect, bubbleRect] =
      await api.probeWebviewForTests([
        { verb: "count", selector: ".lm-md__table td" },
        // `overflows` must be pointed at a SCROLL container, which is exactly
        // what the wrapper is and what the table is not.
        { verb: "overflows", selector: ".lm-md__tablewrap" },
        { verb: "overflows", selector: ".lm-msg-agent" },
        { verb: "rect", selector: ".lm-md__tablewrap" },
        { verb: "rect", selector: ".lm-msg-agent" },
      ]);

    // The renderer built a real table on the real path — 2 rows x 5 columns.
    assert.strictEqual(val<number>(cells, "body cells"), 10);

    // The wrapper is doing the scrolling.
    assert.strictEqual(
      val<boolean>(wrapOverflows, "the wrapper overflows"),
      true,
      "the wide table should overflow its wrapper, or the fixture is not wide enough to test anything",
    );

    // ...and the bubble is not. This is the claim: the table's width is
    // contained rather than pushed outward into the transcript.
    assert.strictEqual(
      val<boolean>(bubbleOverflows, "the bubble overflows"),
      false,
      "the bubble must not scroll sideways — the wrapper exists so the table's width stops there",
    );

    const wrap = val<{ width: number }>(wrapRect, "wrapper rect");
    const bubble = val<{ width: number }>(bubbleRect, "bubble rect");
    assert.ok(
      wrap.width > 0 && wrap.width <= bubble.width + 1,
      `the wrapper (${wrap.width}px) must fit inside the bubble (${bubble.width}px)`,
    );

    await send;
  });

  test("renders a blockquote as a real blockquote element", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    await api.revealWebviewForTests();
    api.setModelForTests(
      new AnsweringModel("> The claim must be visible in the abstract.\n"),
    );

    const send = api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "what is the one thing to get right",
    });

    await until(async () => {
      const [n] = await api.probeWebviewForTests([
        { verb: "count", selector: ".lm-md__quote" },
      ]);
      return n?.value === 1;
    }, "the blockquote to render");

    const [text, border] = await api.probeWebviewForTests([
      { verb: "text", selector: ".lm-md__quote" },
      // The rule is the whole visual signal, so a resolved 0px would mean the
      // quote is indistinguishable from a paragraph while the DOM looks right.
      {
        verb: "computed",
        selector: ".lm-md__quote",
        name: "border-left-width",
      },
    ]);

    assert.strictEqual(
      val<string>(text, "quote text"),
      "The claim must be visible in the abstract.",
    );
    assert.strictEqual(val<string>(border, "quote border"), "2px");

    await send;
  });
});
