/**
 * T2 (ADR 0043): D2 item 1's mechanical half, driven through the real DOM.
 *
 * The item was ***eyes*** because *"the reported defect is a perceived latency
 * between the click and the host's echo, which no test observes"*. Half of that
 * is true and stays with the operator: whether it *feels* instant is
 * perception. The other half — **does the row flip at the next frame, does it
 * STAY flipped, and does the write land** — is arithmetic, and it is the sole
 * cover for the `main.ts` wiring D2's code-review Critical had to fix.
 *
 * **The click goes through the DOM, not through an `editDecisions` message.**
 * Posting the message directly is what every existing ext-host test does, and
 * it is exactly what cannot catch this class of defect: A1a's lesson was that a
 * button can be dead while a handler-level test stays green, and D2's own
 * operator round found `Alt+Enter` inserting nothing while 32 offline rows were
 * green.
 *
 * **A scripted model replaces D2's live API key.** Its `TEST.md` said *"a bound
 * model with a live API key is required, since only a real `propose_edit`
 * produces the row you are clicking"* — true of a human driving it, not of this
 * suite, which is why the behaviour lands in *offline* rather than in *live*.
 */
import * as assert from "node:assert";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProbeResult, ProbeStep } from "../src/webview-protocol";

interface AcceptApi {
  revealWebviewForTests(): Promise<void>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  setModelForTests(adapter: unknown, binding?: unknown): void;
  clearModelForTests(): void;
  resetSessionForTests(): void;
  dispatchWebviewMessageForTests(msg: unknown): Promise<unknown>;
  sessionEventsForTests(): {
    type: string;
    item?: { type: string; id: string; edits?: { status: string }[] };
  }[];
}

async function getApi(): Promise<AcceptApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension not found");
  await ext.activate();
  return ext.exports as AcceptApi;
}

/** Unwraps one probe result, failing loudly on the `error` branch. */
function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

interface Turn {
  text?: string;
  toolCalls?: { id: string; name: string; args?: unknown }[];
}

/** The scripted adapter, in the shape `session-edits.test.ts` established. */
class ProposingModel {
  readonly protocol = "anthropic" as const;
  private i = 0;
  constructor(private readonly turns: Turn[]) {}

  private next(): Turn {
    const t = this.turns[Math.min(this.i, this.turns.length - 1)] ?? {};
    this.i += 1;
    return t;
  }

  private result(t: Turn) {
    const toolCalls = t.toolCalls ?? [];
    return {
      text: t.text ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(): Promise<unknown> {
    return Promise.resolve(this.result(this.next()));
  }

  async *generateStream(req: { signal?: AbortSignal }): AsyncIterable<unknown> {
    const turn = this.next();
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    if (turn.text) yield { type: "text_delta", text: turn.text };
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      yield {
        type: "tool_call_delta",
        index,
        id: call.id,
        name: call.name,
        argsDelta: JSON.stringify(call.args ?? {}),
      };
    }
    yield { type: "completed", result: this.result(turn) };
  }
}

const PAPER =
  "\\documentclass{article}\n\\begin{document}\nSay teh word here.\n\\end{document}\n";

const ACCEPT_BTN = ".lm-proposal__controls > .lm-btn--primary";

async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

suite("T2 (ADR 0043): one click on Accept, in the real webview", function () {
  this.timeout(60000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the row settles at the NEXT FRAME, stays settled, and the file changes", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    await api.revealWebviewForTests();

    const root = path.join(
      os.tmpdir(),
      `lemmaria-t2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const paper = vscode.Uri.file(path.join(root, "paper.tex"));
    await vscode.workspace.fs.writeFile(paper, Buffer.from(PAPER, "utf8"));
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(paper),
    );
    // The write path is offered only over the ACTIVE paper, and VS Code settles
    // the active editor asynchronously; without this the task runs read-only.
    await until(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === paper.fsPath,
      "the paper to become the active editor",
    );

    api.setModelForTests(
      new ProposingModel([
        {
          toolCalls: [
            {
              id: "c1",
              name: "propose_edit",
              args: {
                edits: [
                  {
                    file: "paper.tex",
                    anchor: "teh word",
                    replacement: "the word",
                  },
                ],
              },
            },
          ],
        },
        { text: "typo fixed" },
      ]),
    );

    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      });

      // The row has to be RENDERED, not merely streamed — this suite is about
      // the DOM, so the DOM is what it waits on.
      await until(async () => {
        const [n] = await api.probeWebviewForTests([
          { verb: "count", selector: ".lm-proposal--pending" },
        ]);
        return n?.value === 1;
      }, "the pending proposal row to render");

      const [buttons] = await api.probeWebviewForTests([
        { verb: "count", selector: ACCEPT_BTN },
      ]);
      assert.strictEqual(
        val<number>(buttons, "Accept buttons"),
        1,
        "expected exactly one Accept button on a single-file proposal",
      );

      // THE MEASUREMENT. One request: click, wait exactly one frame, read the
      // row back. `scheduleRender` coalesces to one rebuild per frame, so a
      // settled row here is the optimistic view having been computed AND
      // rendered. CHAT-5's defect was that this still said `pending`, for
      // seconds, until the host echoed the write — and no wall-clock wait is
      // involved, so this measures the product rather than the machine.
      const [, atFrame0Raw, atFrame1Raw] = await api.probeWebviewForTests([
        { verb: "click", selector: ACCEPT_BTN, afterFrames: 0 },
        // Frame 0 — synchronously after the click handler returned, before the
        // rAF it scheduled has run. This row MUST still be pending, and that is
        // what makes the next line an assertion rather than a formality: if the
        // frame count were decorative, both reads would say the same thing and
        // "settles at the next frame" would be measuring nothing.
        { verb: "classes", selector: ".lm-proposal__row", afterFrames: 1 },
        { verb: "classes", selector: ".lm-proposal__row" },
      ]);
      const atFrame0 = val<string[]>(atFrame0Raw, "row at frame 0");
      assert.ok(
        atFrame0.includes("lm-proposal--pending"),
        `the render is no longer deferred by a frame — this test's frame count has stopped meaning anything: ${atFrame0.join(" ")}`,
      );
      const atFrame1 = val<string[]>(atFrame1Raw, "row one frame after click");
      assert.ok(
        !atFrame1.includes("lm-proposal--pending"),
        `still pending one frame after the click: ${atFrame1.join(" ")}`,
      );
      assert.ok(
        atFrame1.includes("lm-proposal--applied"),
        `expected the optimistic applied row: ${atFrame1.join(" ")}`,
      );

      const outcome = (await send) as { status: string };
      assert.strictEqual(outcome.status, "completed");

      // It must not revert. The code review's Critical was that posting cleared
      // the live choice, so the very next render put `● pending` and its
      // buttons straight back — byte-identical to the behaviour CHAT-5 exists
      // to fix. Only a real round trip can show that the fix holds.
      await until(
        () =>
          api
            .sessionEventsForTests()
            .some(
              (e) =>
                e.type === "item.completed" &&
                e.item?.type === "edit_proposal" &&
                (e.item.edits ?? []).some((x) => x.status === "applied"),
            ),
        "the host's terminal applied record",
      );
      const [afterRaw, buttonsAfter] = await api.probeWebviewForTests([
        { verb: "classes", selector: ".lm-proposal__row" },
        { verb: "count", selector: ACCEPT_BTN },
      ]);
      const settled = val<string[]>(afterRaw, "row after the echo");
      assert.ok(
        settled.includes("lm-proposal--applied"),
        `the row reverted after the host's echo: ${settled.join(" ")}`,
      );
      assert.strictEqual(
        val<number>(buttonsAfter, "Accept buttons after the echo"),
        0,
        "the Accept button came back after the decision was posted",
      );

      // An optimistic row over an unchanged file is worse than the latency it
      // was fixing, so the row's claim is checked against the disk.
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the row said applied but the file never changed",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
