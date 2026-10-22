// A1b acceptance suite (ADR 0016, files half revised by ADR 0031): the composer
// session gains the write path — propose_edit batches pause for per-edit
// decisions under the default review policy, apply immediately under auto_apply
// with a changed_files summary, carry reject notes back as steering, create
// files, and branching at a message puts the files back to what they were
// before it AND deletes what it created. Every message travels the REAL inbound
// router, and no test here is a git repository: the whole point of ADR 0031 is
// that undo works in an ordinary folder.
import * as assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface SessionEditsApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  routeInboundMessageForTests(msg: WebviewToHost): void;
  sessionEventsForTests(): SessionEvent[];
  sessionStoreDirForTests(): string | undefined;
  resetSessionForTests(): void;
  branchFromMessageForTests(messageId: string): Promise<boolean>;
  branchPointsForTests(): Promise<string[]>;
  sessionItemsForTests(): Promise<import("@lemmaria/harness").SessionItem[]>;
  sessionCreatedFilesForTests(): Promise<string[]>;
  proposalFileDiffForTests(
    itemId: string,
    file: string,
  ): Promise<{ file: string; current: string; proposed: string } | undefined>;
  // A5: the handshake replay + its observability seam.
  postedToWebviewForTests(): readonly { type: string; [k: string]: unknown }[];
  clearPostedToWebviewForTests(): void;
  // U5's Edits view, which the agentic write path now reports to (D4 round).
  getEditsForTests(): { file: string; source: "action" | "agent" }[];
  editsItemForTests(index: number): { contextValue?: string } | undefined;
}

interface TestTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
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
    this.requests.push(req);
    return Promise.resolve(this.result(this.nextTurn()));
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(req);
    const turn = this.nextTurn();
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    if (turn.text) yield { type: "text_delta", text: turn.text };
    for (const [index, call] of (turn.toolCalls ?? []).entries()) {
      if (req.signal?.aborted) {
        yield { type: "aborted" };
        return;
      }
      yield {
        type: "tool_call_delta",
        index,
        id: call.id,
        name: call.name,
        argsDelta: JSON.stringify(call.args ?? {}),
      };
    }
    if (req.signal?.aborted) {
      yield { type: "aborted" };
      return;
    }
    yield { type: "completed", result: this.result(turn) };
  }
}

async function getApi(): Promise<SessionEditsApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as SessionEditsApi;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PAPER_TEXT =
  "\\documentclass{article}\n\\begin{document}\nSay teh word here.\n\\end{document}\n";

/**
 * A fresh throwaway paper dir. Deliberately NOT a git repository (ADR 0031):
 * every restore assertion below therefore proves the thing B6 could not do at
 * all, and no test here can pass for the wrong reason via a stray `git init`.
 */
async function makePaper(): Promise<{
  root: string;
  paper: vscode.Uri;
}> {
  const root = path.join(
    os.tmpdir(),
    `lemmaria-a1b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const paper = vscode.Uri.file(path.join(root, "paper.tex"));
  await vscode.workspace.fs.writeFile(paper, Buffer.from(PAPER_TEXT, "utf8"));
  const opened = await vscode.workspace.openTextDocument(paper);
  await vscode.window.showTextDocument(opened);
  // The write path is offered only over the ACTIVE paper, and VS Code settles
  // the active editor asynchronously — especially after a previous test closed
  // a diff. Wait for it, or the next task silently runs read-only.
  await waitFor(
    () => vscode.window.activeTextEditor?.document.uri.fsPath === paper.fsPath,
    `${paper.fsPath} to become the active editor`,
  );
  return { root, paper };
}

function proposeCall(id: string, edits: Record<string, unknown>[]): ToolCall {
  return { id, name: "propose_edit", args: { edits } };
}

function findProposal(
  events: SessionEvent[],
  where: (statuses: string[]) => boolean,
):
  | { id: string; edits: { status: string; note?: string; file: string }[] }
  | undefined {
  for (const e of events) {
    if (e.type !== "item.completed" || e.item.type !== "edit_proposal")
      continue;
    const edits = e.item.edits as {
      status: string;
      note?: string;
      file: string;
    }[];
    if (where(edits.map((x) => x.status))) return { id: e.item.id, edits };
  }
  return undefined;
}

interface TaskOutcome {
  status: string;
  items: { type: string; text?: string; status?: string }[];
}

function jsonlFiles(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

suite("A1b: the session write path", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("review (default): a proposal pauses, editDecisions accept applies to the real file", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    const model = new TestModel([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "paper.tex", anchor: "teh word", replacement: "the word" },
          ]),
        ],
      },
      { text: "typo fixed" },
    ]);
    api.setModelForTests(model);
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending);
      api.routeInboundMessageForTests({
        type: "editDecisions",
        itemId: pending.id,
        decisions: [{ accept: true }],
      });
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
      const terminal = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("applied"),
      );
      assert.ok(terminal, "the terminal applied record streamed");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the accepted edit reached the real file",
      );
      // Quick actions still never touch the session store (existing pin,
      // re-checked in a workspace where an edit session ran).
      const before = jsonlFiles(api.sessionStoreDirForTests()).length;
      api.clearModelForTests();
      await vscode.commands.executeCommand("lemmaria.polish").then(
        () => {},
        () => {},
      );
      assert.strictEqual(
        jsonlFiles(api.sessionStoreDirForTests()).length,
        before,
        "a quick action never writes a session file",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  // D4 manual round, checklist item 7: the Edits view listened only to the M4
  // quick-action Accept, so every agentic write since A1b was missing from the
  // one place that lists what Lemmaria changed. Both policies must report.
  test("an applied agentic edit reaches the Edits view, under both policies", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    const model = new TestModel([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "paper.tex", anchor: "teh word", replacement: "the word" },
          ]),
        ],
      },
      { text: "typo fixed" },
    ]);
    api.setModelForTests(model);
    try {
      const before = api.getEditsForTests().length;
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending);
      api.routeInboundMessageForTests({
        type: "editDecisions",
        itemId: pending.id,
        decisions: [{ accept: true }],
      });
      await send;
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the accepted edit reached the real file",
      );
      const after = api.getEditsForTests();
      // Exactly ONE new row. The pending proposal record and the terminal one
      // are both routed through `recordProposal`, so this delta is also what
      // pins the dedupe: without it the single Accept lands twice. (The store
      // is window-scoped, so `before` carries earlier tests' rows — the delta
      // is the only honest measure here.)
      assert.strictEqual(
        after.length,
        before + 1,
        "the applied agentic edit was not recorded in the Edits view exactly once",
      );
      assert.strictEqual(after[0]?.file, "paper.tex");
      assert.strictEqual(after[0]?.source, "agent");
      // An agentic row must NOT offer the inline ↺: the M5 backend never saw
      // this write, so the button would fail every time. Its undo is the
      // branch control on the user bubble in the transcript (ADR 0031).
      assert.notStrictEqual(
        api.editsItemForTests(0)?.contextValue,
        "rollbackable",
        "an agentic edit offered a rollback the backend cannot honor",
      );
      assert.strictEqual(
        await vscode.commands.executeCommand(
          "lemmaria.rollbackVerifiedEdit",
          0,
        ),
        false,
        "the rollback command accepted an agentic entry",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("auto_apply also reports its writes to the Edits view", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    const model = new TestModel([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "paper.tex", anchor: "teh word", replacement: "the word" },
          ]),
        ],
      },
      { text: "done" },
    ]);
    api.setModelForTests(model);
    try {
      const before = api.getEditsForTests().length;
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(readFileSync(paper.fsPath, "utf8").includes("the word here."));
      assert.strictEqual(
        api.getEditsForTests().length,
        before + 1,
        "an auto-applied edit is still a change the user must be able to see",
      );
    } finally {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "review",
      });
      api.clearModelForTests();
    }
  });

  test("review: reject-with-note leaves the file alone and the note reaches the model", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    const model = new TestModel([
      {
        toolCalls: [
          proposeCall("c1", [
            { file: "paper.tex", anchor: "teh word", replacement: "the word" },
          ]),
        ],
      },
      { text: "understood" },
    ]);
    api.setModelForTests(model);
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix it",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending);
      api.routeInboundMessageForTests({
        type: "editDecisions",
        itemId: pending.id,
        decisions: [{ accept: false, note: "keep the typo, it is a quote" }],
      });
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say teh word here."),
        "a rejected edit writes nothing",
      );
      const terminal = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("rejected"),
      );
      assert.strictEqual(
        terminal?.edits[0]?.note,
        "keep the typo, it is a quote",
      );
      const toolMsg = model.requests[1]?.messages.at(-1);
      assert.ok(
        String(toolMsg?.content).includes("keep the typo, it is a quote"),
        "the rejection note returned to the model as steering",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("setEditPolicy auto_apply mid-session: applies without a pause and summarizes changed files", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      // First task under the default review policy establishes the session…
      // (kept minimal: the toggle itself is the subject here)
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo now",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "auto_apply landed the edit without a decision round-trip",
      );
      const summary = outcome.items.find((i) => i.type === "changed_files");
      assert.ok(summary, "a changed_files summary item ended the turn");
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.strictEqual(pending, undefined, "auto_apply never paused");
    } finally {
      api.clearModelForTests();
    }
  });

  // D2 deliverable 8 / X2's task T6. The rendering is asserted in
  // `test-webview/removals.test.ts`; what this covers is the half that test
  // cannot reach — that a `removes_protected` the MODEL wrote survives the real
  // arg parser, the real apply path and the real ledger, and arrives on the
  // item the webview reads. Under `auto_apply` this summary is the only report
  // a user gets.
  test("auto_apply: the changed_files summary carries the model's declared removals", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              {
                file: "paper.tex",
                anchor: "Say teh word here.",
                replacement: "Say the word here.",
                removes_protected: ["% TODO: cite"],
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "drop that comment",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the declared edit reached disk",
      );
      const summary = outcome.items.find((i) => i.type === "changed_files") as
        | {
            files: { file: string; removesProtected?: string[] }[];
          }
        | undefined;
      assert.ok(summary, "a changed_files summary item ended the turn");
      assert.deepStrictEqual(
        summary.files[0]?.removesProtected,
        ["% TODO: cite"],
        "the summary names what the model declared it removed",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("create + branch: a created file materializes, branching reverts and deletes it — with no git repository", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { root, paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
              {
                file: "figs/extra.tex",
                create: true,
                content: "% new include\n",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix and add a figure include",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      const created = path.join(root, "figs", "extra.tex");
      assert.ok(existsSync(created), "the create-variant file materialized");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the replace edit applied",
      );
      const createdList = await api.sessionCreatedFilesForTests();
      assert.deepStrictEqual(createdList, ["figs/extra.tex"]);

      // The writing turn's message is offered like any other — no git ref was
      // consulted to decide that, and there is none to consult. E4 (ADR 0054)
      // retired the separate "brings files back" set that used to be asserted
      // here; that it DOES bring them back is asserted below, against the
      // bytes on disk, which is the claim that was always the substance.
      const point = (await api.branchPointsForTests()).at(-1);
      assert.ok(point, "the message is a branch point");

      const branched = await api.branchFromMessageForTests(point);
      assert.strictEqual(branched, true);
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say teh word here."),
        "branching put the edited file back to its pre-message content",
      );
      assert.ok(
        !existsSync(created),
        "branching deleted the file the abandoned turn created",
      );
      // Nothing was written into the user's folder to make that work: the
      // snapshots live in Lemmaria's own storage, not in a repository here.
      assert.ok(
        !existsSync(path.join(root, ".git")),
        "the restore must not have created a repository in the workspace",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("per-turn restore (finding 4): branching at turn 2 keeps turn 1's work", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { root, paper } = await makePaper();
    api.routeInboundMessageForTests({
      type: "setEditPolicy",
      policy: "auto_apply",
    });
    const runTurn = async (text: string, edits: Record<string, unknown>[]) => {
      api.setModelForTests(
        new TestModel([
          { toolCalls: [proposeCall("c1", edits)] },
          { text: "ok" },
        ]),
      );
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text,
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
    };
    try {
      await runTurn("turn one", [
        { file: "paper.tex", anchor: "teh word", replacement: "the word" },
        { file: "one.py", create: true, content: "# turn one\n" },
      ]);
      await runTurn("turn two", [
        { file: "paper.tex", anchor: "the word", replacement: "THE WORD" },
        { file: "two.py", create: true, content: "# turn two\n" },
      ]);

      // Both user messages are offered, in turn order — this list is exactly
      // what the transcript draws ⟲ from (E4/ADR 0054: one set, one face).
      // That each turn actually wrote is asserted against the files below.
      const points = await api.branchPointsForTests();
      assert.strictEqual(points.length, 2, "each turn is a branch point");
      const [turnOneId, turnTwoId] = points;
      // The live event buffer holds only the LAST task, so turn two's message
      // id must appear there — that is the id the bubble posts back.
      const lastTaskUserIds = api
        .sessionEventsForTests()
        .flatMap((e) =>
          e.type === "item.completed" && e.item.type === "user_message"
            ? [e.item.id]
            : [],
        );
      assert.ok(
        turnTwoId && lastTaskUserIds.includes(turnTwoId),
        "the newest branch point is turn two's user message",
      );

      // Branch at turn two, leaving turn one alone.
      const restored = await api.branchFromMessageForTests(turnTwoId);
      assert.strictEqual(restored, true);
      const text = readFileSync(paper.fsPath, "utf8");
      assert.ok(
        text.includes("Say the word here."),
        `turn one's edit survived, turn two's was undone; got: ${text}`,
      );
      assert.ok(
        existsSync(path.join(root, "one.py")),
        "turn one's created file survived",
      );
      assert.ok(
        !existsSync(path.join(root, "two.py")),
        "turn two's created file was deleted",
      );
      // Turn two is off this branch entirely, so it is no longer offered at
      // all. E4 (ADR 0054): asserted directly against the branch-scoped set
      // rather than inferred from which face the transcript would draw.
      const after = await api.branchPointsForTests();
      assert.deepStrictEqual(
        after,
        [turnOneId],
        "the abandoned turn is no longer offered; the earlier one still is",
      );
      // ADR 0018 (as superseded by ADR 0027): the CONVERSATION rewound with
      // the files, so the next task does not carry turns whose changes were
      // just reverted. They left the BRANCH, not the session.
      const items = await api.sessionItemsForTests();
      const texts = items.flatMap((i) =>
        i.type === "user_message" ? [i.text] : [],
      );
      assert.deepStrictEqual(
        texts,
        ["turn one"],
        `turn two left the transcript; got ${JSON.stringify(texts)}`,
      );
      assert.ok(
        !items.some(
          (i) =>
            i.type === "edit_proposal" &&
            i.edits.some((e) => e.file === "two.py"),
        ),
        "turn two's proposal left the transcript with it",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("ADR 0027: branching at turn 2 of 3 drops turn 3's files with it", async () => {
    // ADR 0017 freed the consumed checkpoint AND every LATER one, reasoning
    // that those refs describe states that no longer exist; ADR 0027 made that
    // false — the later turns are on the branch the user just left, which
    // survives — and B6 had to keep the refs alive to preserve it.
    //
    // ADR 0031 makes the whole question moot: nothing is consumed, freed or
    // kept, because a branch's file state is a fold over the log rather than a
    // ref that can be deleted. What is left to assert is the user-visible
    // half, which is unchanged: branching at turn two takes turns two AND
    // three off the active branch, files included, and turn one survives.
    const api = await getApi();
    api.resetSessionForTests();
    const { root } = await makePaper();
    api.routeInboundMessageForTests({
      type: "setEditPolicy",
      policy: "auto_apply",
    });
    const runTurn = async (text: string, file: string) => {
      api.setModelForTests(
        new TestModel([
          {
            toolCalls: [
              proposeCall("c1", [
                { file, create: true, content: `% ${text}\n` },
              ]),
            ],
          },
          { text: "ok" },
        ]),
      );
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text,
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
    };
    try {
      await runTurn("turn one", "a.tex");
      await runTurn("turn two", "b.tex");
      await runTurn("turn three", "c.tex");
      const points = await api.branchPointsForTests();
      assert.strictEqual(points.length, 3, "each turn is a branch point");
      const [turnOneId, turnTwoId] = points;
      assert.ok(turnTwoId);

      const restored = await api.branchFromMessageForTests(turnTwoId);
      assert.strictEqual(restored, true);

      // The files follow the conversation, both turns' worth: turn three left
      // the branch too, so its file goes with it.
      assert.ok(
        existsSync(path.join(root, "a.tex")),
        "turn one's file is on the branch we stayed on",
      );
      assert.ok(
        !existsSync(path.join(root, "b.tex")),
        "turn two's file left with turn two",
      );
      assert.ok(
        !existsSync(path.join(root, "c.tex")),
        "turn three's file left with it — the plan is per-BRANCH, not per-turn",
      );
      // ...and nothing dangles: the transcript and its branch points are
      // branch-scoped, so the user is never offered a sibling's message.
      const items = await api.sessionItemsForTests();
      assert.deepStrictEqual(
        items.flatMap((i) => (i.type === "user_message" ? [i.text] : [])),
        ["turn one"],
        "turns two and three left the ACTIVE branch",
      );
      assert.deepStrictEqual(
        await api.branchPointsForTests(),
        [turnOneId],
        "only this branch's points are offered",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  // --- A1b manual-test findings 2a/2b: the diff source must survive the diff
  // editor stealing focus, and a file's edits are ONE reviewable unit. ---

  test("per-file diff: every edit of a file is combined, and opening one diff does not break the next", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { root } = await makePaper();
    const second = vscode.Uri.file(path.join(root, "notes.tex"));
    await vscode.workspace.fs.writeFile(
      second,
      Buffer.from("alpha here\nbeta there\n", "utf8"),
    );
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              // Two edits of the SAME file — one decision, one combined diff.
              { file: "paper.tex", anchor: "Say teh", replacement: "Say the" },
              {
                file: "paper.tex",
                anchor: "word here",
                replacement: "word now",
              },
              { file: "notes.tex", anchor: "alpha", replacement: "ALPHA" },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix things",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending);

      // 2b: one file → one diff carrying BOTH of its edits.
      const paperDiff = await api.proposalFileDiffForTests(
        pending.id,
        "paper.tex",
      );
      assert.ok(paperDiff, "the paper's combined diff resolved");
      assert.ok(
        paperDiff.proposed.includes("Say the word now."),
        `both edits are in the one proposed side, got: ${paperDiff.proposed}`,
      );

      // 2a: opening a diff makes the DIFF the active editor. The next file's
      // diff must still resolve — it must not be looked up via the active tab.
      api.routeInboundMessageForTests({
        type: "showEditDiff",
        itemId: pending.id,
        file: "paper.tex",
      });
      await waitFor(
        () =>
          vscode.window.tabGroups.all.some((g) =>
            g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff),
          ),
        "the diff editor to open",
      );
      const notesDiff = await api.proposalFileDiffForTests(
        pending.id,
        "notes.tex",
      );
      assert.ok(
        notesDiff,
        "the second file's diff still resolved while a diff editor was focused",
      );
      assert.ok(notesDiff.proposed.includes("ALPHA here"));

      api.routeInboundMessageForTests({
        type: "editDecisions",
        itemId: pending.id,
        decisions: [{ accept: true }, { accept: true }, { accept: true }],
      });
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
    } finally {
      api.clearModelForTests();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("a file's invalid edit does not blind the diff for its decidable ones (review round 2)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              // One good edit and one whose anchor is nowhere in the file.
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
              { file: "paper.tex", anchor: "NOT PRESENT", replacement: "x" },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix it",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending);
      // The group holds one pending + one invalid; the preview must show the
      // pending one rather than refusing the whole file.
      const diff = await api.proposalFileDiffForTests(pending.id, "paper.tex");
      assert.ok(diff, "the decidable edit is still previewable");
      assert.ok(diff.proposed.includes("Say the word here."));
      api.routeInboundMessageForTests({
        type: "editDecisions",
        itemId: pending.id,
        decisions: [{ accept: true }, { accept: false }],
      });
      assert.strictEqual((await send).status, "completed");
    } finally {
      api.clearModelForTests();
    }
  });

  test("the write path survives a focused diff, and reaches files the editor never opened", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { root } = await makePaper();
    // A sibling the user never opened — the agent must still be able to edit it.
    const sibling = vscode.Uri.file(path.join(root, "chapters", "intro.tex"));
    await vscode.workspace.fs.writeFile(
      sibling,
      Buffer.from("An unopened chapter.\n", "utf8"),
    );
    // Focus a NON-paper editor, the way our own "View diff" does. Before the
    // round-2 fix this silently stripped propose_edit from the envelope and
    // the model truthfully answered "I can't edit files in this session".
    const scratch = vscode.Uri.file(path.join(root, "notes.txt"));
    await vscode.workspace.fs.writeFile(scratch, Buffer.from("x", "utf8"));
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(scratch),
    );
    await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === scratch.fsPath,
      "the non-paper editor to take focus",
    );
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              {
                file: "chapters/intro.tex",
                anchor: "unopened chapter",
                replacement: "edited chapter",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "edit the intro",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(
        readFileSync(sibling.fsPath, "utf8").includes("edited chapter"),
        "the agent edited a workspace file that was never the active editor",
      );
    } finally {
      api.clearModelForTests();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("interruptTask while a proposal is pending: stale statuses, interrupted task, file untouched", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("c1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
            ]),
          ],
        },
        { text: "never reached" },
      ]),
    );
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix it",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      api.routeInboundMessageForTests({ type: "interruptTask" });
      const outcome = await send;
      assert.strictEqual(outcome.status, "interrupted");
      const stale = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("stale"),
      );
      assert.ok(stale, "the undecided edit persisted as stale");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say teh word here."),
        "nothing was written",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

suite("A5: a live pause survives the webview being re-created", function () {
  this.timeout(60000);

  test("a proposal pending when the view moves replays DECIDABLE, and decides", async () => {
    // Moving the Assistant between sidebars destroys and rebuilds the webview
    // while this host keeps running — the loop is still parked on the decision
    // promise. The replay must therefore hand back the LIVE pending card, not
    // the transcript's normalized `stale` copy: that copy has no pending edit,
    // so the webview drew no Accept / Reject / View diff and the task hung with
    // only ◼ to unwedge it (the manual-checklist finding).
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("m1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      const send = api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      }) as Promise<TaskOutcome>;
      await waitFor(
        () =>
          findProposal(api.sessionEventsForTests(), (s) =>
            s.includes("pending"),
          ) !== undefined,
        "the pending proposal event",
      );
      const pending = findProposal(api.sessionEventsForTests(), (s) =>
        s.includes("pending"),
      );
      assert.ok(pending, "the pending proposal");

      // The view was rebuilt: a fresh bundle re-runs the `ready` handshake.
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "the handshake replay to arrive",
      );
      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | {
            busy: boolean;
            items: {
              id: string;
              type: string;
              edits?: { status: string }[];
            }[];
          }
        | undefined;
      assert.ok(replay, "the replay message");
      assert.strictEqual(replay.busy, true, "the task is still in flight");
      const card = replay.items.find((i) => i.id === pending.id);
      assert.ok(card, "the pending proposal is in the replay");
      assert.deepStrictEqual(
        card.edits?.map((e) => e.status),
        ["pending"],
        "the replayed card is still decidable (the webview gates its buttons on this)",
      );

      // And the decision the rebuilt card sends actually lands: the promise the
      // loop is parked on is the same one, so the task finishes by Accept — not
      // by an interrupt.
      assert.strictEqual(
        await api.dispatchWebviewMessageForTests({
          type: "editDecisions",
          itemId: pending.id,
          decisions: [{ accept: true }],
        }),
        true,
        "the decision reached the live pause",
      );
      const outcome = await send;
      assert.strictEqual(outcome.status, "completed");
      assert.ok(
        readFileSync(paper.fsPath, "utf8").includes("Say the word here."),
        "the accepted edit was written",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

suite("A5: a replay never resurrects a rewound turn", function () {
  this.timeout(60000);

  test("ADR 0057: a restore switches sessions, so the panel is reset not merged", async () => {
    // ADR 0027 shipped this as an `authoritative` flag on `transcriptReplay`:
    // the re-seed had to REPLACE the webview's fold, because on a rewind
    // "held but not in the snapshot" was the branch just left, and a merge
    // would put those turns straight back on screen. ADR 0057 retires the flag
    // with the move — a rewind forks to a NEW session and resumes it, and a
    // resume posts `sessionReset` before replaying, so there is nothing stale
    // left to merge back in.
    //
    // The PROPERTY is unchanged and is what this asserts: after a restore, the
    // rewound turn is not on screen. Only the mechanism moved.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    const turnTwo = `re-seeded turn ${Date.now()}`;
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("r1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: turnTwo,
      });
      const point = (await api.branchPointsForTests()).at(-1);
      assert.ok(point, "the writing turn is a branch point");

      api.clearPostedToWebviewForTests();
      assert.strictEqual(await api.branchFromMessageForTests(point), true);
      await waitFor(
        () =>
          api.postedToWebviewForTests().some((m) => m.type === "sessionReset"),
        "the fork's session reset to arrive",
      );
      const posted = api.postedToWebviewForTests();
      const resetAt = posted.findIndex((m) => m.type === "sessionReset");
      // `composerPrefill` carries the rewound text back by design; the
      // transcript traffic must not.
      const seeded = posted
        .slice(resetAt)
        .filter((m) => m.type !== "composerPrefill");
      assert.ok(
        !JSON.stringify(seeded).includes(turnTwo),
        "the rewound turn is not re-seeded into the fresh panel",
      );
      assert.ok(
        !posted.some((m) => "authoritative" in m),
        "the `authoritative` flag left the wire with the branch move",
      );

      // The `ready` handshake still MERGES, and now unconditionally: an item
      // the fold holds but the snapshot lacks is a live event that landed
      // during the read, and replacing would drop it for good.
      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "the handshake replay to arrive",
      );
      const handshake = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay");
      assert.ok(handshake, "the handshake replay message");
      assert.ok(
        !("authoritative" in handshake),
        "the handshake snapshot merges, and carries no flag saying so",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("after a restore, the handshake replay omits the rewound message (ADR 0018)", async () => {
    // The replay must be the REPLAYED transcript (store.load → branch walk +
    // replayEntries), which projects the session's own entries. A hand-rolled
    // would hand back turns whose file changes were just undone — the
    // transcript would claim work that no longer exists on disk.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    const turnTwo = `rewound turn ${Date.now()}`;
    api.setModelForTests(
      new TestModel([
        {
          toolCalls: [
            proposeCall("r1", [
              {
                file: "paper.tex",
                anchor: "teh word",
                replacement: "the word",
              },
            ]),
          ],
        },
        { text: "done" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: turnTwo,
      });
      const points = await api.branchPointsForTests();
      const point = points.at(-1);
      assert.ok(point, "the writing turn is a branch point");
      assert.strictEqual(await api.branchFromMessageForTests(point), true);

      api.clearPostedToWebviewForTests();
      api.routeInboundMessageForTests({ type: "ready" });
      await waitFor(
        () =>
          api
            .postedToWebviewForTests()
            .some((m) => m.type === "transcriptReplay"),
        "the handshake replay to arrive",
      );
      const replay = api
        .postedToWebviewForTests()
        .find((m) => m.type === "transcriptReplay") as
        | { items: { type: string; text?: string }[] }
        | undefined;
      // Unconditional: an `if (replay)` would make this test pass on a machine
      // where the replay never happened at all.
      assert.ok(replay, "the replay message");
      assert.ok(
        !replay.items.some(
          (i) => i.type === "user_message" && i.text === turnTwo,
        ),
        "the rewound turn must not come back in the replay",
      );
    } finally {
      api.clearModelForTests();
    }
  });
  // D1 (ADR 0032): the protections are only real if the HOST wires them. This
  // drives the whole extension path — inbound router, session host, registry —
  // and asserts against the bytes on disk.
  test("D1: an agentic edit that would delete a % comment writes nothing", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const root = path.join(
      os.tmpdir(),
      `lemmaria-d1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const source =
      "\\documentclass{article}\n\\begin{document}\n" +
      "Say teh word here. % TODO: check this wording\n" +
      "\\end{document}\n";
    const paper = vscode.Uri.file(path.join(root, "paper.tex"));
    await vscode.workspace.fs.writeFile(paper, Buffer.from(source, "utf8"));
    const opened = await vscode.workspace.openTextDocument(paper);
    await vscode.window.showTextDocument(opened);
    await waitFor(
      () =>
        vscode.window.activeTextEditor?.document.uri.fsPath === paper.fsPath,
      `${paper.fsPath} to become the active editor`,
    );
    const model = new TestModel([
      {
        toolCalls: [
          proposeCall("c1", [
            {
              file: "paper.tex",
              anchor: "Say teh word here. % TODO: check this wording",
              replacement: "Say the word here.",
            },
          ]),
        ],
      },
      { text: "I could not apply that." },
    ]);
    api.setModelForTests(model);
    try {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: "fix the typo",
      })) as TaskOutcome;
      assert.strictEqual(outcome.status, "completed");
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        source,
        "auto_apply wrote an edit that deleted a protected comment",
      );
      const items = await api.sessionItemsForTests();
      const proposal = items.find((i) => i.type === "edit_proposal");
      assert.ok(proposal && proposal.type === "edit_proposal");
      assert.strictEqual(proposal.edits[0]?.status, "invalid");
      assert.match(
        String(proposal.edits[0]?.note),
        /protected content cannot be dropped silently/,
      );
      // ADR 0033: the note names the DECLARATION, not D1's withdrawn anchor
      // carve-out — the escape the model is told about must be the one that
      // actually works, or it retries into the same refusal.
      assert.match(String(proposal.edits[0]?.note), /removes_protected/);
      // ADR 0034: one language. This is an English-locale session.
      assert.ok(
        !/[一-鿿]/.test(String(proposal.edits[0]?.note)),
        "an English-locale session was shown Chinese",
      );
    } finally {
      api.routeInboundMessageForTests({
        type: "setEditPolicy",
        policy: "review",
      });
      api.clearModelForTests();
    }
  });
});
