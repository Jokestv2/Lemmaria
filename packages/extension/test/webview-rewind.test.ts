/**
 * E4 (ADR 0054) — CHAT-7 point 1, asserted in the REAL webview.
 *
 * What only this suite can prove: that the transcript actually DRAWS one face.
 * Every other branch test in this repo works below the DOM, through
 * `branchPointsForTests` / `branchFromMessageForTests` — and before this file
 * **nothing anywhere read `.lm-msg-user__restore`**. So the host could have
 * been offering exactly the right branch points while `main.ts` drew the wrong
 * glyph on them, and the whole suite would have stayed green. `main.ts` is not
 * importable (ADR 0037 §3), so the probe (ADR 0043) is the only instrument
 * that can close that gap — and closing it is what makes the milestone's
 * headline claim an *offline* row rather than an item on a human's list.
 *
 * The gap is closed by the TURN ORDER, not by reading the glyph: writing turn
 * first, write-free turn last. Under ADR 0031's rule the reverse order draws
 * ⟲ on both bubbles, so the assertions below would pass with the two faces
 * restored. The dispatch block in the test carries the full argument.
 *
 * What this suite deliberately does NOT assert: the control's `title` /
 * `aria-label`, which E4 re-words and E7 splits in two. ADR 0043's verb set is
 * closed and reads no ATTRIBUTE, and a bound is not a bug to route around —
 * the gap is filed as a finding instead of paid for by widening the set (E4's
 * plan D5, unchanged by E7).
 *
 * **E7 (ADR 0055) extends it rather than replacing it**, because the turn
 * order that makes E4's ⑂-absence discriminating is the same order that makes
 * E7's count discriminating: writing turn first gives restore plans of 1 and
 * 0, so exactly ONE control is annotated. Send the write-free turn first and
 * both counts are 1, exactly as both faces would have been ⟲.
 *
 * **Verified by mutation, 2026-08-28**, on `feature/e7-branch-control-file-count`
 * — the same evidence ADR 0054 §4 records for its own claim, because "this
 * test is discriminating" is a claim like any other. Appending the count as a
 * SIBLING of the control instead of a child fails both tests (the `⟲1` read
 * and the *annotated control is wider* comparison, which measured 16.708px
 * against 16.708px); rendering the count for a ZERO as well fails the
 * annotated-control count in both tests. Both mutations were reverted.
 */
import * as assert from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionItem,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import { CHROME } from "../src/chrome-strings";
import type {
  ProbeResult,
  ProbeStep,
  WebviewToHost,
} from "../src/webview-protocol";

/** The branch control on a user bubble, and the list it lives in. */
const CONTROL = ".lm-msg-user__restore";
const TRANSCRIPT = ".lm-transcript";
/** E7 (ADR 0055): the count node inside the control, drawn only when > 0. */
const COUNT = ".lm-msg-user__restore-count";
/** The panel's scroll container — the box a too-wide control would widen. */
const SCROLLER = ".lm-content";

interface RewindApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  resetSessionForTests(): void;
  revealWebviewForTests(): Promise<void>;
  branchPointsForTests(): Promise<string[]>;
  probeWebviewForTests(
    steps: ProbeStep[],
    opts?: { timeoutMs?: number },
  ): Promise<ProbeResult[]>;
  // E6 (D8/D9): the consent path — what the host pushes, and the QuickPick
  // twin the palette command asks with when no panel is open.
  sessionItemsForTests(): Promise<SessionItem[]>;
  postedToWebviewForTests(): readonly { type: string; [k: string]: unknown }[];
  clearPostedToWebviewForTests(): void;
  setRewindPickerForTests(
    picker?: (
      items: readonly { label: string }[],
      title: string,
    ) => string | undefined,
  ): void;
}

async function getApi(): Promise<RewindApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as RewindApi;
}

/** A probe result's value, with the `error` branch failing loudly. */
function val<T>(r: ProbeResult | undefined, what: string): T {
  assert.ok(r, `${what}: no result`);
  assert.strictEqual(r.error, undefined, `${what}: ${r.error}`);
  return r.value as T;
}

interface TestTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  private i = 0;
  constructor(private readonly turns: TestTurn[]) {}

  private nextTurn(): TestTurn {
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)] ?? {};
    this.i += 1;
    return turn;
  }

  private result(turn: TestTurn): GenerateResult {
    const toolCalls = turn.toolCalls ?? [];
    return {
      text: turn.text ?? "",
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    void req;
    return Promise.resolve(this.result(this.nextTurn()));
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    const turn = this.nextTurn();
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

const PAPER_TEXT =
  "\\documentclass{article}\n\\begin{document}\nORIGINAL BODY\n\\end{document}\n";

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Write a file VS Code has just written itself. Windows can hold the handle for
 * a beat after the editor's save resolves, so a raw `writeFileSync` on the heels
 * of a restore fails with `EBUSY`/`EPERM` — the same two codes
 * `src/session/snapshot-host.ts` records as "ordinary on Windows". Retrying the
 * WRITE weakens no assertion: the claim under test is what happens to these
 * bytes afterwards, and a lock still releasing is not that. Any other error, and
 * the deadline, throw at once.
 */
async function writeWhenUnlocked(
  file: string,
  text: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(file, text, "utf8");
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "EPERM";
      if (!transient || Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/**
 * Probe until the DOM says what the caller is waiting for. The host pushes the
 * branch points on its own clock (`pushRestorePoints` posts from an async
 * continuation), so the render this suite measures lands strictly AFTER the
 * host-side facts do. The alternative — one probe behind a fixed sleep — would
 * measure the CI machine, which is the thing ADR 0043's `afterFrames` exists
 * to avoid; polling the assertion itself has no such clock in it.
 */
async function probeUntil(
  api: RewindApi,
  steps: ProbeStep[],
  ready: (results: ProbeResult[]) => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<ProbeResult[]> {
  const start = Date.now();
  let last = await api.probeWebviewForTests(steps);
  while (!ready(last)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timed out waiting for ${label}; last: ${JSON.stringify(last)}`,
      );
    await new Promise((r) => setTimeout(r, 25));
    last = await api.probeWebviewForTests(steps);
  }
  return last;
}

/** The dir `makePaper` last built, so the teardown can remove it. */
let paperRoot = "";

/**
 * A fresh throwaway paper dir, deliberately NOT a git repository (the ADR 0031
 * reason `session-branches.test.ts` states): the write this suite needs must
 * be a real one, snapshotted the way the product does it.
 */
async function makePaper(): Promise<vscode.Uri> {
  const root = path.join(
    os.tmpdir(),
    `lemmaria-e4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  paperRoot = root;
  const paper = vscode.Uri.file(path.join(root, "paper.tex"));
  await vscode.workspace.fs.writeFile(paper, Buffer.from(PAPER_TEXT, "utf8"));
  const opened = await vscode.workspace.openTextDocument(paper);
  await vscode.window.showTextDocument(opened);
  await waitFor(
    () => vscode.window.activeTextEditor?.document.uri.fsPath === paper.fsPath,
    `${paper.fsPath} to become the active editor`,
  );
  return paper;
}

suite("E4/E7: the branch control in the real webview", function () {
  this.timeout(60000);

  /**
   * **The two tests below are ORDERED, deliberately.** The first builds the
   * transcript; the second measures its geometry at a forced width without
   * rebuilding it, so the forced width is scoped to the test that needs it and
   * is handed back in the teardown. Mocha runs them in declaration order, and
   * the second opens by asserting the fixture is still on screen — so running
   * it alone fails loudly with that message rather than measuring an empty
   * panel. Do not reorder them, and do not `.only` the second.
   */

  /**
   * Hand the shared window back exactly as this suite found it — the reason
   * `webview-table.test.ts` clears its forced width and `webview-at.test.ts`
   * revokes its grants: `.vscode-test` reuses ONE window and ONE panel, so
   * residue does not fail here, it fails somewhere else.
   *
   * Two of what it leaves broke a real later assertion when this suite was
   * first run without this block: an APPLIED proposal row still in the
   * transcript (T2's Accept test probes `.lm-proposal__row` and matched
   * mine), and a sticky paper that outlives its editor (E3's `@` floor
   * asserts there is no paper in context, and mine gave it one). The model
   * stub and the fixture tree broke nothing and are cleared anyway.
   */
  suiteTeardown(async () => {
    const api = await getApi();
    // E7: the forced width is an override on a view every other suite shares
    // (`webview-table.test.ts`'s rule, and the third hazard this suite's own
    // header lists). `px: 0` REMOVES it rather than collapsing the panel.
    await api.probeWebviewForTests([
      { verb: "setWidth", selector: ".lm-app", px: 0 },
    ]);
    api.clearModelForTests();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    // Host state first (this is what drops the sticky paper), then the panel:
    // `resetSessionForTests` does not reach the webview, and `newSession` is
    // the one path that posts the `sessionReset` which clears the transcript.
    api.resetSessionForTests();
    await api.dispatchWebviewMessageForTests({ type: "newSession" });
    // The fixture tree too — `.vscode-test.mjs`'s header is an essay about
    // what accumulated test residue costs, and this one is a directory.
    if (paperRoot) rmSync(paperRoot, { recursive: true, force: true });
  });

  test("a write-free turn and a writing turn both draw ⟲, and nothing draws ⑂", async () => {
    const api = await getApi();
    await api.revealWebviewForTests();
    // TWO resets, because the ext-host suite shares ONE webview and the host
    // reset does not reach it: `resetSessionForTests` clears the host's session
    // state, and the `newSession` dispatch posts the `sessionReset` that clears
    // the panel. Without the second, an earlier suite's transcript would still
    // be on screen and every count below would be measuring it too.
    api.resetSessionForTests();
    await api.dispatchWebviewMessageForTests({ type: "newSession" });
    const paper = await makePaper();
    api.setModelForTests(
      new TestModel([
        // Turn 1 — the FIRST message, "now change the paper": writes the
        // paper. B6's ⟲ case, and it goes first deliberately; the dispatch
        // block below is where that order is argued.
        {
          toolCalls: [
            {
              id: "c1",
              name: "propose_edit",
              args: {
                edits: [
                  {
                    file: "paper.tex",
                    anchor: "ORIGINAL BODY",
                    replacement: "CHANGED BODY",
                  },
                ],
              },
            },
          ],
        },
        // Still turn 1: the model's word after the tool result lands.
        { text: "wrote it" },
        // Turn 2 — the LAST message, "just a question": answers, writes
        // nothing. B6's ⑂ case, and the only position in which it is one.
        { text: "an answer" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      // THE ORDER IS THE PROBE: writing turn FIRST, write-free turn LAST.
      // Not a stylistic choice — it is the only arrangement in which these
      // assertions can fail against the design ADR 0054 retires, and swapping
      // it back silently turns this suite into a description of E4 instead of
      // a test of it.
      //
      // ADR 0031 §4 picked ⟲ over ⑂ from `writingBranchPoints()`, i.e.
      // `restorePlan(manifestAt(entries), manifestAt(entries.slice(0, cut)))`
      // non-empty — a manifest diff from the CURRENT LEAF back to before that
      // message, never a fact about that message's own turn. (E5, ADR 0057 §8
      // retired the leaf/node signature this comment used to quote; the
      // *rule* it describes is unchanged, which is why the paragraph stands
      // and only its arithmetic is re-spelled. `known-limits.md` licensed the
      // staleness "until the next milestone to touch that file" — E6 is that
      // milestone.) So a write-free message
      // that has a writing turn AFTER it carries that write in its restore
      // plan and takes the ⟲ face too. Send "just a question" first and ADR
      // 0031 draws ⟲ on BOTH bubbles: every assertion below passes with the
      // two faces fully restored, and the suite measures nothing.
      //
      // Write-free LAST is the one shape ADR 0031 ever gave ⑂ (measured
      // 2026-08-28 against the built harness: restore plans of 1 for the
      // writing message and 0 for the write-free one, so faces ⟲ / ⑂).
      // Hence: do not reorder these two sends.
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "now change the paper",
      });
      // Gated HERE rather than after both sends, for the same reason: the
      // write must already be in the manifest when the write-free message is
      // appended, or the transcript being measured is not the one argued for
      // above. `composerSend` is awaited to turn completion, so this is a belt
      // on `auto_apply`'s write reaching disk — cheap, and the thing that makes
      // the two cases really differ.
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "the writing turn to land before the write-free turn is sent",
      );
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "just a question",
      });
      // The host must be offering BOTH messages before anything the DOM says
      // is worth reading — otherwise "nothing draws ⑂" would pass on a panel
      // that drew no controls at all.
      const points = await api.branchPointsForTests();
      assert.strictEqual(
        points.length,
        2,
        `expected both messages to be branch points; got ${points.length}`,
      );

      const [count, glyph, all, annotated, annotation] = await probeUntil(
        api,
        [
          { verb: "count", selector: CONTROL },
          { verb: "text", selector: CONTROL },
          { verb: "text", selector: TRANSCRIPT },
          // E7 (ADR 0055): how many controls carry a count, and what the
          // first one says.
          { verb: "count", selector: COUNT },
          { verb: "text", selector: COUNT },
        ],
        (r) => r[0]?.value === 2,
        "both user bubbles to render their branch control",
      );

      assert.strictEqual(
        val<number>(count, "control count"),
        2,
        "every non-steered user message carries the control, write or no write",
      );
      // `text` returns `querySelector`'s first match (`parts/probe.ts`), so
      // this reads the FIRST control — the WRITING message's, since that turn
      // goes first. ADR 0031 gave that one ⟲ as well, so this assertion is
      // the weak half of the pair on purpose: it pins the face E4 keeps.
      //
      // E7 (ADR 0055) made it `⟲1` rather than `⟲`: the control now carries
      // the count as a child node, and `text` is `textContent`. Kept as an
      // exact-equality read rather than relaxed to `startsWith`, because that
      // pins BOTH E4's face and E7's number in one measurement — strictly
      // more than the assertion it replaces, which is the only direction a
      // re-pointed assertion may move.
      assert.strictEqual(
        val<string>(glyph, "first control's glyph"),
        "⟲1",
        "the writing message wears the rewind face, carrying its one-file count",
      );
      // E7's discriminating half, and it is the same turn order that carries
      // E4's: only ONE of the two controls is annotated, because only the
      // writing message's click has a file to undo. Send the write-free turn
      // first instead and both counts are 1, exactly as both faces would have
      // been ⟲ — the order argued for at the dispatch block does double duty.
      assert.strictEqual(
        val<number>(annotated, "annotated controls"),
        1,
        "the write-free message's click changes nothing, so it draws no count",
      );
      assert.strictEqual(
        val<string>(annotation, "the count"),
        "1",
        "the writing turn wrote one file, and that is the number on the glyph",
      );
      // The SECOND control — the WRITE-FREE message's, and the one ADR 0031
      // gave the other face, which is true only because it is LAST (see the
      // dispatch block). This is the discriminating half, and it is reached
      // the only way the closed verb set allows: `text` already spent its
      // first match above, and there is no CSS way to select the write-free
      // bubble — it is not the transcript's last `div` (its agent answer
      // follows it), so `:last-of-type` matches nothing. Counting the glyph
      // across the transcript closes the same gap: two controls carrying two
      // ⟲ leaves the second one nothing else it could be drawing, and under
      // ADR 0031 that second one is exactly where ⑂ would appear.
      //
      // Exactly two, not "at least": ⟲ is also `main.ts`'s glyph for a STALE
      // edit, and this fixture deliberately has none (one anchored edit under
      // `auto_apply`, applied). If that ever changed, this assertion goes red
      // rather than quietly passing — which is the right direction for a
      // count whose whole job is to notice an extra character.
      const transcript = val<string>(all, "transcript text");
      assert.strictEqual(
        [...transcript].filter((c) => c === "⟲").length,
        2,
        "both controls draw ⟲ — one per branch point and nothing else",
      );
      // Absence, across the whole transcript rather than one control: the
      // retired face must be gone from the panel, not merely from the bubble
      // this probe happened to reach first.
      assert.ok(
        !transcript.includes("⑂"),
        "⑂ is retired by ADR 0054 and must not render anywhere",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  /**
   * E7 (ADR 0055) row 4 — the annotation grows the control INWARD.
   *
   * `.lm-msg-user__restore` is `position: absolute; right: -22px`, so its right
   * edge is pinned to its bubble's and the extra character can only widen the
   * box leftward, into the bubble's 10px right padding. Both user bubbles are
   * `align-self: flex-end`, so they share a right edge — and therefore so do
   * their controls, whether or not one of them carries a count. That equality
   * is the assertion: it says the count did not push the control further out
   * of the transcript, which is the one way a two-character control could
   * break the panel.
   *
   * Driven at a forced 300px, because a claim about a narrow panel measured at
   * whatever width the CI window happens to open at is not a claim. This runs
   * as its own test rather than inside the one above so the forced width is
   * scoped to it and handed back in `suiteTeardown` — the residue rule
   * `webview-table.test.ts` states.
   */
  test("the count widens the control inward, and the panel still does not scroll sideways", async () => {
    const api = await getApi();
    await api.revealWebviewForTests();

    await api.probeWebviewForTests([
      { verb: "setWidth", selector: ".lm-app", px: 300 },
    ]);

    const [boxes, scrolls, counted] = await probeUntil(
      api,
      [
        { verb: "rects", selector: CONTROL },
        // `.lm-content` is the panel's scroll container. `overflow-y: auto`
        // with a visible x-axis computes to auto on both, so this is a real
        // question about the horizontal axis and not a tautology.
        { verb: "overflows", selector: SCROLLER },
        { verb: "count", selector: COUNT },
      ],
      (r) => (r[0]?.value as unknown[] | undefined)?.length === 2,
      "both controls to be measurable at 300px",
    );

    // The transcript from the previous test is still on screen — this suite
    // shares one panel deliberately, so the fixture is not rebuilt.
    assert.strictEqual(
      val<number>(counted, "annotated controls"),
      1,
      "the fixture from the previous test must still be on screen, one control annotated",
    );

    const rects = val<{ right: number; width: number }[]>(
      boxes,
      "control rects",
    );
    assert.strictEqual(rects.length, 2, "expected both controls");
    const [annotated, plain] = rects;
    assert.ok(annotated && plain);
    assert.ok(
      Math.abs(annotated.right - plain.right) < 0.5,
      `the count must not move the control's right edge: annotated ends at ${annotated.right}, plain at ${plain.right}`,
    );
    // ...and it is INSIDE the control rather than beside it, which is what the
    // extra width proves. Without this, an annotation appended as a sibling of
    // the button would satisfy the equality above and still be a second
    // control.
    assert.ok(
      annotated.width > plain.width,
      `the annotated control must be wider (${annotated.width} vs ${plain.width}) — the count lives inside it`,
    );
    assert.strictEqual(
      val<boolean>(scrolls, "the panel scrolls sideways"),
      false,
      "a 300px panel must not gain a horizontal scrollbar from the count",
    );
  });
});

/**
 * E6 (D8/D9, ADR 0058 §4): consent, moved off the OS modal.
 *
 * Until this milestone a rewind asked with `showWarningMessage({ modal: true })`
 * — correct under invariant 3 and unreadable to every offline runner, so the
 * gate could pin that consent was *asked for* and never what it *said*. The
 * question is now a webview card (its rendering: `test-webview/rewind-menu`)
 * and, for the palette command that can fire with no panel open, a QuickPick.
 * What this suite asserts is the half neither of those can: that the HOST
 * computes the plan once, holds it under a nonce, writes nothing until the
 * decision comes back, and applies exactly the plan that was consented to.
 *
 * Its own fixture, its own reset and its own teardown, deliberately: the suite
 * above is two ORDERED tests over one transcript, and leaning on that would
 * couple two unrelated claims to one fixture.
 */
suite("E6: consent for a rewind, off the OS modal", function () {
  this.timeout(60000);

  /** The dir this suite's fixture last built. */
  let root = "";

  suiteTeardown(async () => {
    const api = await getApi();
    api.setRewindPickerForTests(undefined);
    api.clearModelForTests();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    api.resetSessionForTests();
    await api.dispatchWebviewMessageForTests({ type: "newSession" });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A session whose one message wrote the paper, left at the point where a
   * restoring arm on that message would put it back.
   */
  async function wrote(api: RewindApi): Promise<{
    paper: vscode.Uri;
    messageId: string;
  }> {
    api.resetSessionForTests();
    await api.dispatchWebviewMessageForTests({ type: "newSession" });
    const paper = await makePaper();
    root = path.dirname(paper.fsPath);
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            {
              id: "c1",
              name: "propose_edit",
              args: {
                edits: [
                  {
                    file: "paper.tex",
                    anchor: "ORIGINAL BODY",
                    replacement: "CHANGED BODY",
                  },
                ],
              },
            },
          ],
        },
        { text: "wrote it" },
      ]),
    );
    await api.dispatchWebviewMessageForTests({
      type: "setEditPolicy",
      policy: "auto_apply",
    });
    await api.dispatchWebviewMessageForTests({
      type: "composerSend",
      text: "change the paper",
    });
    await waitFor(
      () => readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
      "the write to land before consent is asked for",
    );
    const message = (await api.sessionItemsForTests()).find(
      (i) => i.type === "user_message",
    );
    assert.ok(message, "expected the writing message to persist");
    return { paper, messageId: message.id };
  }

  /** The last consent push, as the card would receive it. */
  function lastConfirm(api: RewindApi): {
    nonce: string;
    messageId: string;
    withFork: boolean;
    files: string[];
    deletions: string[];
  } {
    const pushes = api
      .postedToWebviewForTests()
      .filter((m) => m.type === "rewindConfirm");
    const last = pushes.at(-1);
    assert.ok(last, "expected a rewindConfirm push");
    return last as unknown as {
      nonce: string;
      messageId: string;
      withFork: boolean;
      files: string[];
      deletions: string[];
    };
  }

  test("a restoring arm names every file and writes nothing until the answer comes back", async () => {
    const api = await getApi();
    const { paper, messageId } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId,
        withFork: false,
      });
      const confirm = lastConfirm(api);
      assert.strictEqual(confirm.messageId, messageId);
      assert.strictEqual(confirm.withFork, false);
      assert.deepStrictEqual(
        confirm.files,
        ["paper.tex"],
        "invariant 3: the file is named, by path, before anything is written",
      );
      assert.deepStrictEqual(confirm.deletions, []);
      assert.ok(confirm.nonce.length > 0, "the plan is held under a nonce");
      // The gate itself: a preview is a question, not an action.
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "asking must not write",
      );

      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce: confirm.nonce,
        confirmed: true,
      });
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("ORIGINAL BODY"),
        "and the answer applies exactly the plan that was named",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a preview the host cannot answer says so, instead of nothing", async () => {
    // Found at E6's code review. A restoring arm disables all three buttons
    // while the host computes, so a host that answers with SILENCE leaves the
    // popover dead — and ⟲ renders on every user bubble whatever the task
    // state, so "click ⟲, pick an arm, get no plan" is an ordinary click.
    // Reached here through an id no user message carries, which is
    // `planFor`'s unresolvable-cut refusal; a task in flight and a missing
    // workspace folder reach the same return by their own routes.
    const api = await getApi();
    const { paper } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId: "no-such-message",
        withFork: false,
      });
      const posts = api.postedToWebviewForTests();
      assert.deepStrictEqual(
        posts
          .filter((m) => m.type === "rewindPreviewRefused")
          .map((m) => (m as unknown as { messageId: string }).messageId),
        ["no-such-message"],
        "the refusal is routed back to the menu that asked",
      );
      assert.strictEqual(
        posts.filter((m) => m.type === "rewindConfirm").length,
        0,
        "and no card is offered for a plan that does not exist",
      );
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "a refused preview writes nothing, like every other preview",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a fork that cannot happen tells the user, rather than failing mute", async () => {
    // Also E6's code review. `rewindConversation` returns `undefined` for a
    // failed fork and a failed SWITCH as well as for an unresolvable target,
    // and the fork-only arm moved no file — so it took the branch that says
    // nothing at all, which is the one case ADR 0057's honest-degradation rule
    // does not allow. The toast is captured at the API rather than inferred:
    // this is the only assertion in the suite that reads a notification, and
    // the stub is restored in a `finally`.
    const api = await getApi();
    await wrote(api);
    const shown: string[] = [];
    const original = vscode.window.showWarningMessage;
    (
      vscode.window as unknown as { showWarningMessage: unknown }
    ).showWarningMessage = (message: string) => {
      shown.push(message);
      return Promise.resolve(undefined);
    };
    try {
      await api.dispatchWebviewMessageForTests({
        type: "rewindFork",
        messageId: "no-such-message",
      });
      assert.deepStrictEqual(
        shown,
        [CHROME.en.forkFailed],
        "a refused fork names itself in the reader's language",
      );
    } finally {
      (
        vscode.window as unknown as { showWarningMessage: unknown }
      ).showWarningMessage = original;
      api.clearModelForTests();
    }
  });

  test("a declined card writes nothing, and its nonce is spent either way", async () => {
    const api = await getApi();
    const { paper, messageId } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId,
        withFork: false,
      });
      const { nonce } = lastConfirm(api);
      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce,
        confirmed: false,
      });
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "Cancel, Esc and a click away all leave the worktree alone",
      );
      // A second decision under a spent nonce is a duplicate, and duplicates
      // are dropped — otherwise a decline followed by a stray confirm would
      // apply a plan the user had already turned down.
      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce,
        confirmed: true,
      });
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "a spent nonce can never be redeemed",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a superseded plan is dropped rather than applied late", async () => {
    // Two previews, one answer — the shape a user produces by opening the menu,
    // changing their mind about the arm, and answering the first card if it is
    // somehow still on screen. Only the LIVE plan may be applied: the older one
    // was computed against the same log but consented to under a question the
    // user then replaced.
    const api = await getApi();
    const { paper, messageId } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId,
        withFork: false,
      });
      const stale = lastConfirm(api).nonce;
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId,
        withFork: true,
      });
      const live = lastConfirm(api);
      assert.notStrictEqual(live.nonce, stale, "each preview gets its own");
      assert.strictEqual(live.withFork, true);

      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce: stale,
        confirmed: true,
      });
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "the superseded plan must not run",
      );
      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce: live.nonce,
        confirmed: true,
      });
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("ORIGINAL BODY"),
        "and the live one still can",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the fork-only arm needs no card at all", async () => {
    // It writes no user file, so there is nothing for invariant 3 to gate and
    // the click is the action (D8). A card in front of it would be ceremony.
    const api = await getApi();
    const { paper, messageId } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindFork",
        messageId,
      });
      assert.deepStrictEqual(
        api.postedToWebviewForTests().filter((m) => m.type === "rewindConfirm"),
        [],
        "no consent surface is raised for an arm that writes nothing",
      );
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "and nothing on disk moves",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the palette command drives the same arms through QuickPicks", async () => {
    // D9: it can fire with no panel open, so it cannot use the card — but it
    // asks the same question and names the same files, and both routes end in
    // ONE execution path. VS Code-native, and chime-free, which is what the
    // operator asked for when they asked the modal to go.
    const api = await getApi();
    const { paper } = await wrote(api);
    try {
      const asked: string[] = [];
      api.setRewindPickerForTests((items, title) => {
        asked.push(title);
        // The arm pick is answered by label; the consent pick by taking any
        // row, which is what an Enter on a named file does.
        const restore = items.find((i) => i.label === "Rewind code to here");
        return (restore ?? items[0])?.label;
      });
      await vscode.commands.executeCommand("lemmaria.restoreSessionCheckpoint");
      assert.strictEqual(
        asked.length,
        2,
        "two picks: which arm, then the consent question",
      );
      assert.ok(
        asked[1]?.includes("Rewind code to this message?"),
        `the second pick's title IS the consent question; got ${asked[1]}`,
      );
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("ORIGINAL BODY"),
        "and answering it runs the same restore the card runs",
      );
    } finally {
      api.setRewindPickerForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("a palette restore supersedes an open card, exactly as a new preview does", async () => {
    // E6 code review. `pendingRewinds` was cleared on every new PREVIEW, and
    // the palette route computes and applies its own plan without ever storing
    // one — so a card left open in the panel stayed answerable after a
    // palette-driven restore had already moved the worktree, applying a plan
    // computed against the older one. One question live at a time has to mean
    // one across BOTH routes.
    const api = await getApi();
    const { paper, messageId } = await wrote(api);
    try {
      api.clearPostedToWebviewForTests();
      await api.dispatchWebviewMessageForTests({
        type: "rewindPreview",
        messageId,
        withFork: false,
      });
      const stale = lastConfirm(api).nonce;

      api.setRewindPickerForTests((items) => {
        const restore = items.find((i) => i.label === "Rewind code to here");
        return (restore ?? items[0])?.label;
      });
      await vscode.commands.executeCommand("lemmaria.restoreSessionCheckpoint");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("ORIGINAL BODY"),
        "the palette route ran its own plan",
      );

      // A sentinel the stale plan would overwrite: it restores `paper.tex` to
      // the pre-message bytes, so if the entry survived, this text is gone.
      await writeWhenUnlocked(paper.fsPath, "TYPED AFTERWARDS");
      await api.dispatchWebviewMessageForTests({
        type: "rewindDecision",
        nonce: stale,
        confirmed: true,
      });
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        "TYPED AFTERWARDS",
        "the card's plan was superseded by the palette question, not merely unlikely",
      );
    } finally {
      api.setRewindPickerForTests(undefined);
      api.clearModelForTests();
    }
  });

  test("cancelling the arm pick leaves everything exactly as it was", async () => {
    const api = await getApi();
    const { paper } = await wrote(api);
    try {
      api.setRewindPickerForTests(() => undefined);
      await vscode.commands.executeCommand("lemmaria.restoreSessionCheckpoint");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "Esc out of the first pick and no arm is taken",
      );
    } finally {
      api.setRewindPickerForTests(undefined);
      api.clearModelForTests();
    }
  });
});
