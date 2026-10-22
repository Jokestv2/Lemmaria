import * as assert from "node:assert";
import * as vscode from "vscode";
import type {
  HostToWebview,
  ProbeResult,
  ProbeStep,
  WebviewToHost,
} from "../src/webview-protocol";

interface WebviewApi {
  revealWebviewForTests(): Promise<void>;
  roundTripForTests(text: string): Promise<string>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  postedToWebviewForTests(): readonly HostToWebview[];
  clearPostedToWebviewForTests(): void;
}

async function getApi(): Promise<WebviewApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as WebviewApi;
}

suite("U0: Lemmaria webview round-trip", function () {
  this.timeout(30000);

  test("registers the view and round-trips host->webview->host", async () => {
    const api = await getApi();
    await api.revealWebviewForTests();
    const reply = await api.roundTripForTests("hello");
    assert.strictEqual(reply, "hello (from webview)");
  });

  test("copyText writes the code block to the system clipboard (ADR 0040)", async () => {
    // D3 round 2: the Markdown code block's Copy button routes through the HOST
    // because `navigator.clipboard` inside a webview is gated on a permission
    // the webview host owns and nothing here has verified it is granted. This
    // asserts the round trip — written, then read back — rather than the call.
    const api = await getApi();
    const before = await vscode.env.clipboard.readText();
    try {
      await api.dispatchWebviewMessageForTests({
        type: "copyText",
        text: "x = 1\ny = 2",
      });
      assert.strictEqual(await vscode.env.clipboard.readText(), "x = 1\ny = 2");
    } finally {
      await vscode.env.clipboard.writeText(before);
    }
  });

  test("T2 (ADR 0043): a probe reaches the live DOM and answers", async () => {
    // The seam's smoke test. `.lm-app` is created by `render()` — the served
    // <body> is empty — so a `true` here proves the bundle ran, the first paint
    // happened, and the request/reply pair is correlated end to end.
    const api = await getApi();
    const [existsApp, existsNothing] = await api.probeWebviewForTests([
      { verb: "exists", selector: ".lm-app" },
      { verb: "exists", selector: ".lm-definitely-not-here" },
    ]);
    assert.deepStrictEqual(existsApp, { verb: "exists", value: true });
    assert.deepStrictEqual(existsNothing, { verb: "exists", value: false });
  });

  test("T2: a probe error is a RESULT, and a dead channel would be a rejection", async () => {
    // ADR 0043 §D6's distinguishing signal, asserted rather than asserted-in-
    // prose: a wrong DOM comes back as a resolved result carrying `error`, so
    // the only thing a REJECTION can mean is that the channel is dead.
    const api = await getApi();
    const [miss] = await api.probeWebviewForTests([
      { verb: "text", selector: ".lm-definitely-not-here" },
    ]);
    assert.strictEqual(miss?.verb, "text");
    assert.match(String(miss?.error), /no match/);
    assert.strictEqual(miss?.value, undefined);
  });

  test("E3: requestContextPaths reaches the host and is answered", async () => {
    // The route, asserted on its own. `test/webview-at.test.ts` proves the
    // MENU widens when a grant is added — but that is satisfied by the
    // `onGrantsChanged` push alone, so D6's freshness claim (a walk at the
    // moment the user asks to see the list) would survive this route being
    // deleted. Found by E3's code review, which is the point of one: the
    // message existed, the wiring existed, and nothing asserted the pair.
    const api = await getApi();
    await api.revealWebviewForTests();
    api.clearPostedToWebviewForTests();

    await api.dispatchWebviewMessageForTests({ type: "requestContextPaths" });

    // The walk is async and the handler does not await it, so poll rather than
    // sleep — a wall-clock wait would measure the CI machine (ADR 0043).
    let posted: HostToWebview | undefined;
    for (let i = 0; i < 100 && !posted; i++) {
      posted = api
        .postedToWebviewForTests()
        .find((m) => m.type === "contextPaths");
      if (!posted) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(posted, "no contextPaths post followed requestContextPaths");
    assert.ok(
      Array.isArray((posted as { grants: unknown }).grants),
      "the post must carry a grants array even when there are none",
    );
  });

  test("E3: overlapping requests collapse to one REPEAT, never a dropped push", async () => {
    // D6 authorises dropping an overlapping REQUEST. It does not authorise
    // dropping a PUSH — the same in-flight guard governs the grant-change
    // re-push, and a grant added mid-walk would otherwise never reach the
    // webview, with no second event to recover it. So the last call wins: it
    // re-runs once when the walk in flight finishes.
    const api = await getApi();
    await api.revealWebviewForTests();
    api.clearPostedToWebviewForTests();

    await Promise.all([
      api.dispatchWebviewMessageForTests({ type: "requestContextPaths" }),
      api.dispatchWebviewMessageForTests({ type: "requestContextPaths" }),
      api.dispatchWebviewMessageForTests({ type: "requestContextPaths" }),
    ]);

    let count = 0;
    for (let i = 0; i < 100 && count < 2; i++) {
      count = api
        .postedToWebviewForTests()
        .filter((m) => m.type === "contextPaths").length;
      if (count < 2) await new Promise((r) => setTimeout(r, 50));
    }
    // Two, not three: the middle call is what the drop rule collapses.
    assert.strictEqual(
      count,
      2,
      `expected the overlap to collapse to 2 posts, saw ${count}`,
    );
  });

  test("contributes the Assistant view in the secondary sidebar", () => {
    const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
    assert.ok(ext, "extension not found");
    const contributes = ext.packageJSON.contributes as {
      viewsContainers?: { secondarySidebar?: { id: string }[] };
      views?: Record<string, { id: string }[]>;
    };
    const container = contributes.viewsContainers?.secondarySidebar?.[0];
    assert.ok(container, "no secondarySidebar view container contributed");
    assert.ok(
      contributes.views?.[container.id]?.some(
        (v) => v.id === "lemmariaAssistant",
      ),
      "lemmariaAssistant view is not in the secondary-sidebar container",
    );
  });

  test("lemmaria.openAssistant opens the view ready for a round-trip", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("lemmaria.openAssistant");
    const reply = await api.roundTripForTests("ping");
    assert.strictEqual(reply, "ping (from webview)");
  });
});
