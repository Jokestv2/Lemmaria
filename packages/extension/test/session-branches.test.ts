// E5 acceptance suite (ADR 0057): a rewind FORKS the session — the files are
// restored, a new session is created holding the prefix, and the one you left
// is kept, listed and resumable. Every message travels the REAL inbound
// router, and every file assertion reads the bytes on disk.
//
// It replaces B6's suite (ADR 0030), which asserted the same workflow over an
// in-file tree: branch rows, a leaf that moved, and a switch that carried the
// files. Two of those assertions survive as their INVERSE, deliberately and
// with ADR 0057 named at each: resuming what you left no longer moves files.
import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionEvent,
  SessionItem,
  ToolCall,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface BranchApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  resetSessionForTests(): void;
  sessionItemsForTests(): Promise<SessionItem[]>;
  sessionEventsForTests(): SessionEvent[];
  branchFromMessageForTests(messageId: string): Promise<boolean>;
  /** E6 (ADR 0058 §4): one arm of the rewind, consent already given. */
  rewindFromMessageForTests(
    messageId: string,
    arm: "fork" | "restore" | "both",
  ): Promise<boolean>;
  outOfSyncForTests(
    root: string,
    listings: readonly {
      meta: { id: string };
      files: Record<string, string>;
    }[],
  ): Promise<boolean>;
  /** E6 (D11): seed and read the `run_script` always-allow cache, so what a
   *  rewind does NOT carry is observable the way the policy it DOES carry is. */
  allowScriptForTests(hash: string): void;
  alwaysAllowedScriptsForTests(): number;
  branchPointsForTests(): Promise<string[]>;
  rewindPointsForTests(): Promise<{ id: string; files: number }[]>;
  activeSessionIdForTests(): string | undefined;
  listSessionsForTests(): Promise<
    {
      meta: {
        id: string;
        title: string;
        forkedFrom?: {
          sessionId: string;
          cutBeforeItemId: string | null;
          atMessage?: number;
        };
      };
      files: Record<string, string>;
    }[]
  >;
  resumeSessionForTests(id: string): Promise<boolean>;
  currentEditPolicyForTests(): "review" | "auto_apply";
  simulateWindowReloadForTests(): Promise<boolean>;
  postedToWebviewForTests(): readonly { type: string; [k: string]: unknown }[];
  clearPostedToWebviewForTests(): void;
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
    const turn = this.nextTurn();
    return Promise.resolve(this.result(turn));
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

async function getApi(): Promise<BranchApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as BranchApi;
}

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

const PAPER_TEXT =
  "\\documentclass{article}\n\\begin{document}\nORIGINAL BODY\n\\end{document}\n";

/**
 * A fresh throwaway paper dir, deliberately NOT a git repository (ADR 0031):
 * every restore assertion in this suite therefore proves the case B6 had to
 * refuse, and none of them can pass for the wrong reason via a stray repo.
 */
async function makePaper(): Promise<{
  root: string;
  paper: vscode.Uri;
}> {
  const root = path.join(
    os.tmpdir(),
    `lemmaria-b6-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const paper = vscode.Uri.file(path.join(root, "paper.tex"));
  await vscode.workspace.fs.writeFile(paper, Buffer.from(PAPER_TEXT, "utf8"));
  const opened = await vscode.workspace.openTextDocument(paper);
  await vscode.window.showTextDocument(opened);
  await waitFor(
    () => vscode.window.activeTextEditor?.document.uri.fsPath === paper.fsPath,
    `${paper.fsPath} to become the active editor`,
  );
  return { root, paper };
}

/** Send one composer message and wait for the task to settle. */
async function send(api: BranchApi, text: string): Promise<void> {
  await api.dispatchWebviewMessageForTests({ type: "composerSend", text });
}

function userMessages(items: SessionItem[]): { id: string; text: string }[] {
  return items.flatMap((i) =>
    i.type === "user_message" ? [{ id: i.id, text: i.text }] : [],
  );
}

function replaceCall(id: string, replacement: string): ToolCall {
  return {
    id,
    name: "propose_edit",
    args: {
      edits: [{ file: "paper.tex", anchor: "ORIGINAL BODY", replacement }],
    },
  };
}

/** E7: a SECOND file, so a later turn can grow an earlier message's count. */
function createCall(id: string, file: string): ToolCall {
  return {
    id,
    name: "propose_edit",
    args: { edits: [{ file, create: true, content: "% my notes\n" }] },
  };
}

/** The model turns `twoDrafts` needs: two tool-call/ack pairs. */
const TWO_DRAFTS_TURNS: TestTurn[] = [
  { toolCalls: [replaceCall("c1", "DRAFT ONE")] },
  { text: "wrote draft one" },
  { toolCalls: [replaceCall("c2", "DRAFT TWO")] },
  { text: "wrote draft two" },
];

/**
 * Build two sessions that each wrote a different draft of the same file:
 * "draft it one way" writes DRAFT ONE, a rewind onto the message before it
 * forks into a child holding the empty prefix, and "draft it another way"
 * writes DRAFT TWO in the CHILD. The caller is left in the DRAFT TWO session;
 * the returned id is the DRAFT ONE one, kept on disk and resumable.
 */
async function twoDrafts(
  api: BranchApi,
  paper: vscode.Uri,
): Promise<{ abandoned: string }> {
  await send(api, "draft it one way");
  await waitFor(
    () => readFileSync(paper.fsPath, "utf8").includes("DRAFT ONE"),
    "draft one to reach the file",
  );
  const abandoned = api.activeSessionIdForTests();
  assert.ok(abandoned, "expected an active session");
  const first = userMessages(await api.sessionItemsForTests())[0];
  assert.ok(first, "expected the first draft's message to be persisted");
  await api.branchFromMessageForTests(first.id);
  await send(api, "draft it another way");
  await waitFor(
    () => readFileSync(paper.fsPath, "utf8").includes("DRAFT TWO"),
    "draft two to reach the file",
  );
  return { abandoned };
}

suite("E5: a rewind forks the session (ADR 0057)", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("a message that wrote nothing is offered exactly like one that wrote", async () => {
    // The defect B6 exists to fix: before it, such a message carried no
    // affordance at all, so "ask it differently" was unreachable. ADR 0031
    // kept two FACES over one behaviour; E4 (ADR 0054) drops the split, so
    // the claim to pin is that the two cases are now INDISTINGUISHABLE in
    // what the host offers. This test used to assert the opposite by name
    // ("wears the ⑂ face"), which is why it is rewritten rather than deleted.
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        { text: "an answer" },
        { toolCalls: [replaceCall("c1", "CHANGED BODY")] },
        { text: "wrote it" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await send(api, "just a question");
      await send(api, "now change the paper");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "the second turn's write to land",
      );
      const items = await api.sessionItemsForTests();
      const [askOnly, wrote] = userMessages(items);
      assert.ok(askOnly && wrote, "expected both user messages to persist");

      // One set, and both messages are in it: the write-free message and the
      // writing one reach the transcript through the same list, so the
      // transcript has nothing left to tell them apart with.
      const branchable = await api.branchPointsForTests();
      assert.deepStrictEqual(
        branchable,
        [askOnly.id, wrote.id],
        "every non-steered message is offered, in transcript order",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("forking a write-free message forks the session and touches no file", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([{ text: "first answer" }, { text: "second answer" }]),
    );
    try {
      await send(api, "question one");
      await send(api, "question two");
      const before = readFileSync(paper.fsPath, "utf8");
      const msgs = userMessages(await api.sessionItemsForTests());
      const second = msgs[1];
      assert.ok(second, "expected two user messages");

      const parent = api.activeSessionIdForTests();
      assert.ok(parent, "expected an active session");

      assert.strictEqual(
        await api.branchFromMessageForTests(second.id),
        true,
        "a write-free message must still be forkable",
      );
      const child = api.activeSessionIdForTests();
      assert.ok(child, "the fork must leave a session active");
      assert.notStrictEqual(
        child,
        parent,
        "ADR 0057: a rewind lands the user in a NEW session, not a new branch",
      );
      const after = await api.sessionItemsForTests();
      assert.deepStrictEqual(
        userMessages(after).map((m) => m.text),
        ["question one"],
        "the child holds the prefix, up to but not including the forked message",
      );
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        before,
        "a conversation-only fork must not touch the files",
      );

      // The one you left is KEPT — listed, and still holding both messages.
      const listed = await api.listSessionsForTests();
      const kept = listed.find((s) => s.meta.id === parent);
      assert.ok(kept, "the session forked FROM must still be listed");
      assert.strictEqual(
        listed.find((s) => s.meta.id === child)?.meta.forkedFrom?.sessionId,
        parent,
        "the child records its immediate parent",
      );
      assert.strictEqual(
        await api.resumeSessionForTests(parent),
        true,
        "the session left behind must still be resumable",
      );
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["question one", "question two"],
        "nothing was dropped: the abandoned tail is intact where it was written",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the abandoned turns become a second SESSION, and both are listed", async () => {
    // B6's version of this asserted two BRANCHES under one session, each with
    // a derived label. ADR 0057 makes them two sessions, related by
    // `forkedFrom` — same workflow, one mechanism.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    api.setModelForTests(
      new TestModel([{ text: "a" }, { text: "b" }, { text: "c" }]),
    );
    try {
      await send(api, "the shared opening");
      await send(api, "the first attempt");
      const parent = api.activeSessionIdForTests();
      assert.ok(parent, "expected an active session");

      const second = userMessages(await api.sessionItemsForTests())[1];
      assert.ok(second);
      await api.branchFromMessageForTests(second.id);
      await send(api, "the second attempt");

      const child = api.activeSessionIdForTests();
      assert.ok(child);
      assert.notStrictEqual(child, parent);

      const listed = await api.listSessionsForTests();
      const byId = new Map(listed.map((s) => [s.meta.id, s.meta]));
      assert.ok(
        byId.has(parent),
        "the first attempt's session is still listed",
      );
      assert.ok(byId.has(child), "the second attempt's session is listed too");
      assert.deepStrictEqual(
        byId.get(child)?.forkedFrom,
        // `atMessage: 2` because the cut is before the SECOND of the parent's
        // two non-steered user messages — the ordinal the row renders as
        // "(forked from 2nd message)" (ADR 0058), stored so no row has to open
        // its parent's log to find it.
        { sessionId: parent, cutBeforeItemId: second.id, atMessage: 2 },
        "the child records WHERE it was cut, not only from what",
      );
      assert.strictEqual(
        byId.get(parent)?.forkedFrom,
        undefined,
        "a session that was created rather than forked carries no lineage",
      );
      // Each holds its own attempt; the shared opening is in both.
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["the shared opening", "the second attempt"],
      );
      assert.strictEqual(await api.resumeSessionForTests(parent), true);
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["the shared opening", "the first attempt"],
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a rewind restores the files, and resuming what you left does NOT move them back", async () => {
    // THE INVERSION (ADR 0057 §5, superseding ADR 0031 §5). B6 asserted here
    // that switching to the branch that drafted it one way brought DRAFT ONE
    // back to disk. ADR 0057 decides the opposite — a session switch moves no
    // files — so this test asserts the opposite, deliberately, and the ADR is
    // what makes that legitimate rather than a weakened assertion.
    //
    // Both halves matter. The rewind DOES restore (that is invariant 3's
    // checkpoint, untouched); the resume does NOT (that is the cost §5 states
    // plainly and bets against, and J1 is the human row that judges it).
    //
    // The fixture is a plain folder, PROVEN not to be a repository, so no
    // stray repo higher up the temp path can make any of this pass for the
    // wrong reason (ADR 0031's whole premise).
    const api = await getApi();
    api.resetSessionForTests();
    const { root, paper } = await makePaper();
    assert.throws(
      () => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root }),
      "the fixture must NOT be a repository, or this test passes for the wrong reason",
    );
    api.setModelForTests(new TestModel(TWO_DRAFTS_TURNS));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await send(api, "draft it one way");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("DRAFT ONE"),
        "draft one to reach the file",
      );
      const abandoned = api.activeSessionIdForTests();
      assert.ok(abandoned);

      const msg = userMessages(await api.sessionItemsForTests())[0];
      assert.ok(msg);
      await api.branchFromMessageForTests(msg.id);
      // Half one: the rewind restored, with no git repository anywhere.
      const reverted = readFileSync(paper.fsPath, "utf8");
      assert.ok(
        !reverted.includes("DRAFT ONE"),
        `the rewind must revert the file, got ${JSON.stringify(reverted)}`,
      );

      await send(api, "draft it another way");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("DRAFT TWO"),
        "draft two to reach the file",
      );

      // Half two: resuming the session we left brings its TRANSCRIPT back and
      // leaves the files exactly where the current session put them.
      assert.strictEqual(await api.resumeSessionForTests(abandoned), true);
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["draft it one way"],
        "the transcript is the session we resumed",
      );
      const body = readFileSync(paper.fsPath, "utf8");
      assert.ok(
        body.includes("DRAFT TWO"),
        `ADR 0057 §5: a session switch moves no files, got ${JSON.stringify(body)}`,
      );
      assert.ok(
        !body.includes("DRAFT ONE"),
        "and it does not resurrect the resumed session's draft either",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the edit policy travels with a rewind, though a plain resume resets it", async () => {
    // ADR 0057: a rewind is the same conversation continuing from an earlier
    // point, so the user's standing approval policy comes with it. Without
    // this, `resumeSession`'s `startNewSession` would silently put an
    // auto-apply user back into review — an approval setting changed as a side
    // effect of a control whose modal says nothing about it.
    //
    // The second half is the contrast that makes the first meaningful: an
    // ORDINARY session switch still resets, because it is a change of subject.
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(new TestModel(TWO_DRAFTS_TURNS));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await send(api, "draft it one way");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("DRAFT ONE"),
        "draft one to reach the file",
      );
      const abandoned = api.activeSessionIdForTests();
      assert.ok(abandoned);
      const msg = userMessages(await api.sessionItemsForTests())[0];
      assert.ok(msg);
      await api.branchFromMessageForTests(msg.id);

      // Still auto-applying: the next turn writes without an approval pause.
      await send(api, "draft it another way");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("DRAFT TWO"),
        "the forked session to still be auto-applying",
      );

      // ...and the COMPOSER was told, which is the half the host-side
      // assertion above cannot see. A rewind resumes, a resume posts
      // `sessionReset`, and the webview's `resetTranscript()` puts its own
      // copy of the policy back to `review`. If nothing re-pushes, the host
      // auto-applies while the pill promises to ask first — the same
      // misreport D10 exists to prevent, one layer up, and the writer needs
      // two clicks to get back to a policy they never left.
      const posted = api.postedToWebviewForTests();
      const resetAt = posted.map((m) => m.type).lastIndexOf("sessionReset");
      assert.ok(resetAt >= 0, "a rewind must reset the panel");
      const pill = posted
        .slice(resetAt)
        .filter(
          (m): m is { type: "editPolicy"; policy: string } =>
            m.type === "editPolicy",
        )
        .at(-1);
      assert.strictEqual(
        pill?.policy,
        "auto_apply",
        "the resumed panel must be told the policy the host actually holds",
      );

      // ...and a plain resume of another session is the contrasting case.
      assert.strictEqual(await api.resumeSessionForTests(abandoned), true);
      assert.strictEqual(
        api.currentEditPolicyForTests(),
        "review",
        "an ordinary session switch is a change of subject and re-consents",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("an unresolvable message refuses instead of widening the fork", async () => {
    // ADR 0018's rule, carried through ADR 0027 into ADR 0057: a target no
    // record carries refuses outright. Nothing is written — no child session
    // appears — and the session in front of the user is untouched.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    api.setModelForTests(new TestModel([{ text: "a" }]));
    try {
      await send(api, "hello");
      const before = api.activeSessionIdForTests();
      const listedBefore = (await api.listSessionsForTests()).length;
      assert.strictEqual(
        await api.branchFromMessageForTests("no-such-item"),
        false,
      );
      assert.strictEqual(
        api.activeSessionIdForTests(),
        before,
        "a refused fork leaves the user where they were",
      );
      assert.strictEqual(
        (await api.listSessionsForTests()).length,
        listedBefore,
        "a refused fork writes no session file",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("branch points and their files survive a REAL window reload", async () => {
    // B6's version of this test was about rehydration: the turnKey → git-ref
    // map was in-memory, so a reload lost every mapping even though the refs
    // survived, and B6 had to rebuild the map by reading the repository back.
    //
    // ADR 0031 deletes the map and the rebuild with it — the session log IS the
    // record and it was always on disk. The USER-VISIBLE claim is unchanged and
    // is what this test keeps: after a reload the same branch points are
    // offered, in the same order, and they still actually move the files.
    //
    // Driven through `simulateWindowReloadForTests`, which does what a reload
    // does — `resetQuiet()` then the activation restore.
    const api = await getApi();
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        { toolCalls: [replaceCall("c1", "WRITTEN")] },
        { text: "done" },
        { text: "ok" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await send(api, "write something");
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("WRITTEN"),
        "the write to land",
      );
      const sessionId = api.activeSessionIdForTests();
      assert.ok(sessionId);
      // E4 (ADR 0054): one set now. This turn wrote, so its branch point
      // undoes files — which the restore assertion at the end of this test
      // proves, rather than the list's name asserting it up front.
      const points = await api.branchPointsForTests();
      const first = points[0];
      assert.ok(first, "expected a branch point");

      assert.strictEqual(
        await api.simulateWindowReloadForTests(),
        true,
        "the session must come back after the reload",
      );
      assert.strictEqual(api.activeSessionIdForTests(), sessionId);
      assert.deepStrictEqual(
        await api.branchPointsForTests(),
        points,
        "the same points come back, in the same order, with nothing rebuilt",
      );
      // ...and they must still WORK, not merely be listed: the blobs the log
      // names have to be the ones the snapshot store still holds.
      assert.strictEqual(
        await api.branchFromMessageForTests(first),
        true,
        "a branch point offered after a reload must actually restore",
      );
      assert.ok(
        !readFileSync(paper.fsPath, "utf8").includes("WRITTEN"),
        "the stored snapshot reverted the file after the reload",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the rewind resumes the child, so the rewound turn cannot come back", async () => {
    // B6/ADR 0027 asserted an `authoritative: true` transcriptReplay here: the
    // re-seed had to REPLACE the fold, because "held but not in the snapshot"
    // was the branch just left. ADR 0057 retires the flag with the move — the
    // rewind switches SESSIONS, and a resume clears the panel before it
    // replays. This test keeps the property the flag protected and drops the
    // mechanism: after a rewind, the panel is reset and the rewound message is
    // not among what the host re-posts.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    api.setModelForTests(new TestModel([{ text: "a" }, { text: "b" }]));
    try {
      await send(api, "hello");
      await send(api, "the one that goes");
      const msgs = userMessages(await api.sessionItemsForTests());
      const second = msgs[1];
      assert.ok(second, "expected two user messages");
      api.clearPostedToWebviewForTests();
      assert.strictEqual(await api.branchFromMessageForTests(second.id), true);

      const posted = api.postedToWebviewForTests();
      const resetAt = posted.findIndex((m) => m.type === "sessionReset");
      assert.ok(
        resetAt >= 0,
        `the fork must reset the panel before re-seeding it, got ${JSON.stringify(
          posted.map((m) => m.type),
        )}`,
      );
      // Nothing RE-SEEDED after the reset carries the rewound message. The
      // composer prefill does carry it, by design — that is the message coming
      // back for editing — so this looks at the transcript traffic only.
      const seeded = posted
        .slice(resetAt)
        .filter((m) => m.type !== "composerPrefill");
      assert.ok(
        !JSON.stringify(seeded).includes("the one that goes"),
        "the rewound turn must not be re-seeded into the fresh panel",
      );
      // The flag is gone from the wire entirely — not merely unset.
      assert.ok(
        !posted.some((m) => "authoritative" in m),
        "ADR 0057: transcriptReplay carries no `authoritative` flag any more",
      );
      // And the composer got the message back (the Codex convention).
      assert.ok(
        posted.some(
          (m) => m.type === "composerPrefill" && m.text === "the one that goes",
        ),
        "the rewound message's text returns to the composer",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

/**
 * E7 (ADR 0055) — the pre-click file count on the branch control.
 *
 * What only this suite can prove is the operator's counting RULE, and the one
 * assertion that carries it is the third turn. ADR 0054's J1 round asked for
 * the pre-click signal back, and the operator chose *files the click would
 * change* — `restorePlan` from the CURRENT LEAF back to before that message —
 * over the alternative it rejected, *files that turn wrote*. The two agree on
 * every fixture with a single turn in it, so a suite built only on those would
 * pass under either rule and measure nothing.
 *
 * They separate the moment a LATER turn writes: a write-free message's count
 * moves from 0 to 1 with nothing of its own having changed, because a rewind
 * onto it now has a file to undo. `files that turn wrote` leaves it at 0
 * forever. That transition is the discriminating assertion below, and it is
 * why the third turn writes a SECOND file rather than re-editing the first —
 * a second edit to `paper.tex` would leave every count where it was, since
 * `restorePlan` counts distinct FILES.
 */
suite("E7: the branch control counts what the click would change", function () {
  this.timeout(60000);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("the count is the restore plan from the CURRENT LEAF, so a later write grows an earlier message's number", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const { root, paper } = await makePaper();
    const notes = path.join(root, "notes.tex");
    api.setModelForTests(
      new TestModel([
        // Turn 1 — "now change the paper": rewrites paper.tex.
        { toolCalls: [replaceCall("c1", "CHANGED BODY")] },
        { text: "wrote it" },
        // Turn 2 — "just a question": writes nothing. Its count is the whole
        // point of the fixture, twice: 0 here, and 1 after turn 3.
        { text: "an answer" },
        // Turn 3 — "add my notes": creates a SECOND file (see the block above).
        { toolCalls: [createCall("c2", "notes.tex")] },
        { text: "made it" },
      ]),
    );
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      await send(api, "now change the paper");
      // Gate on the write reaching disk before the next message is appended,
      // or the manifest the next count folds over is not the one argued for.
      await waitFor(
        () => readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
        "the first turn's write to land",
      );
      await send(api, "just a question");

      const items = await api.sessionItemsForTests();
      const [wrote, askOnly] = userMessages(items);
      assert.ok(wrote && askOnly, "expected both user messages to persist");

      assert.deepStrictEqual(
        await api.rewindPointsForTests(),
        [
          { id: wrote.id, files: 1 },
          { id: askOnly.id, files: 0 },
        ],
        "the writing message's click undoes one file; the write-free one's undoes none",
      );

      // The third turn — and the transition that discriminates the rule.
      await send(api, "add my notes");
      await waitFor(
        () => existsSync(notes),
        "the third turn's created file to land",
      );
      const afterThree = userMessages(await api.sessionItemsForTests());
      const added = afterThree[2];
      assert.ok(added, "expected the third user message to persist");

      assert.deepStrictEqual(
        await api.rewindPointsForTests(),
        [
          // Both files leave: the rewrite is undone and the new file deleted.
          { id: wrote.id, files: 2 },
          // 0 → 1 WITHOUT this message's own turn writing anything. This is
          // the assertion the rejected rule fails.
          { id: askOnly.id, files: 1 },
          { id: added.id, files: 1 },
        ],
        "every count is measured from the leaf, not from what its own turn wrote",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

suite(
  "E6: a rewind fork is born untitled and its first send names it",
  function () {
    this.timeout(60000);

    test("the child carries the ordinal and no title until it is sent to", async () => {
      const api = await getApi();
      api.resetSessionForTests();
      await makePaper();
      api.setModelForTests(new TestModel([{ text: "a" }, { text: "b" }]));
      try {
        await send(api, "the shared opening");
        await send(api, "the first attempt");
        const parent = api.activeSessionIdForTests();
        assert.ok(parent);
        const second = userMessages(await api.sessionItemsForTests())[1];
        assert.ok(second);
        assert.strictEqual(
          await api.branchFromMessageForTests(second.id),
          true,
        );
        const child = api.activeSessionIdForTests();
        assert.ok(child && child !== parent);

        const before = (await api.listSessionsForTests()).find(
          (s) => s.meta.id === child,
        );
        assert.ok(before, "the fork is listed");
        // Born untitled: at fork time the child has no message of its own — the
        // one that would have named it went back to the composer.
        assert.strictEqual(
          before.meta.title,
          "",
          "a rewind fork must NOT inherit its parent's title (ADR 0058 §2)",
        );
        assert.strictEqual(
          before.meta.forkedFrom?.atMessage,
          2,
          "it records which of the parent's messages it was cut before",
        );

        // ...and the first send names it, the way a fresh session's first
        // message names that one.
        const named = `the second attempt ${Date.now()}`;
        await send(api, named);
        const after = (await api.listSessionsForTests()).find(
          (s) => s.meta.id === child,
        );
        assert.strictEqual(
          after?.meta.title,
          named,
          "the first composer send titles the fork, through the LISTING",
        );
        assert.strictEqual(
          after?.meta.forkedFrom?.atMessage,
          2,
          "naming it does not lose where it was cut",
        );
      } finally {
        api.clearModelForTests();
      }
    });

    test("a second send does not rename a session that already has a title", async () => {
      const api = await getApi();
      api.resetSessionForTests();
      await makePaper();
      api.setModelForTests(new TestModel([{ text: "a" }, { text: "b" }]));
      try {
        const first = `the opening ${Date.now()}`;
        await send(api, first);
        const id = api.activeSessionIdForTests();
        assert.ok(id);
        await send(api, "a completely different second message");
        const listed = (await api.listSessionsForTests()).find(
          (s) => s.meta.id === id,
        );
        assert.strictEqual(
          listed?.meta.title,
          first,
          "titles come from the FIRST message, and nothing renames after that",
        );
      } finally {
        api.clearModelForTests();
      }
    });
  },
);

suite("E6: the rewind's three arms (ADR 0058 §4)", function () {
  this.timeout(60000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  /**
   * A session that has written a file, left at the point where taking an arm
   * on its one message would restore that file. Each arm is then checked
   * against BOTH halves — the conversation and the worktree — because the
   * decomposition's whole claim is that they can now move separately.
   */
  async function wroteOnce(api: BranchApi): Promise<{
    paper: vscode.Uri;
    messageId: string;
    parent: string;
    original: string;
  }> {
    api.resetSessionForTests();
    const { paper } = await makePaper();
    api.setModelForTests(
      new TestModel([
        { toolCalls: [replaceCall("c1", "CHANGED BODY")] },
        { text: "wrote it" },
      ]),
    );
    await api.dispatchWebviewMessageForTests({
      type: "setEditPolicy",
      policy: "auto_apply",
    });
    await send(api, "change the paper");
    await waitFor(
      () => readFileSync(paper.fsPath, "utf8").includes("CHANGED BODY"),
      "the write to land before any arm is taken",
    );
    const message = userMessages(await api.sessionItemsForTests())[0];
    assert.ok(message, "expected the writing message to persist");
    const parent = api.activeSessionIdForTests();
    assert.ok(parent, "expected an active session");
    return { paper, messageId: message.id, parent, original: PAPER_TEXT };
  }

  test("the fork-only arm moves the conversation and touches no file", async () => {
    // The arm the operator asked for by name. It writes no user file, which is
    // why D8 lets its click BE the action: there is nothing for invariant 3 to
    // gate. What it must not do is quietly take the worktree with it.
    const api = await getApi();
    const { paper, messageId, parent } = await wroteOnce(api);
    try {
      const before = readFileSync(paper.fsPath, "utf8");
      api.clearPostedToWebviewForTests();
      assert.strictEqual(
        await api.rewindFromMessageForTests(messageId, "fork"),
        true,
      );
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        before,
        "forking the conversation must leave every file byte-identical",
      );
      const child = api.activeSessionIdForTests();
      assert.ok(child && child !== parent, "the fork lands in a NEW session");
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        [],
        "the child holds the prefix, which here is empty",
      );
      assert.deepStrictEqual(
        api
          .postedToWebviewForTests()
          .filter((m) => m.type === "composerPrefill")
          .map((m) => m.text),
        ["change the paper"],
        "the rewound message comes back to the composer, exactly once",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the restore-only arm moves the files and leaves the transcript where it is", async () => {
    // The decomposition's whole point: "go back" was two operations, and this
    // is the one E5 could not express. No fork, no resume, no prefill — the
    // conversation stays put, still holding the message whose write was undone.
    const api = await getApi();
    const { paper, messageId, parent, original } = await wroteOnce(api);
    try {
      const sessionsBefore = (await api.listSessionsForTests()).length;
      api.clearPostedToWebviewForTests();
      assert.strictEqual(
        await api.rewindFromMessageForTests(messageId, "restore"),
        true,
      );
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        original,
        "the file goes back to what it held before that message",
      );
      assert.strictEqual(
        api.activeSessionIdForTests(),
        parent,
        "restoring code must not move the user to another session",
      );
      assert.strictEqual(
        (await api.listSessionsForTests()).length,
        sessionsBefore,
        "and must not create one either",
      );
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["change the paper"],
        "the transcript still holds the message whose write was undone",
      );
      assert.deepStrictEqual(
        api
          .postedToWebviewForTests()
          .filter((m) => m.type === "composerPrefill"),
        [],
        "nothing is handed back to the composer: the message was not rewound",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a code-only rewind lights the marker on the row the writer is IN", async () => {
    // Tier row 7's last clause, and it needed the restore-only arm to exist:
    // the session's leaf manifest still names bytes the disk no longer holds,
    // so the ACTIVE row is out of sync and says so (ADR 0058 §7). Exempting
    // the row you are in would be the one lie the marker exists to remove.
    const api = await getApi();
    const { paper, messageId, parent } = await wroteOnce(api);
    try {
      const root = path.dirname(paper.fsPath);
      const mine = (await api.listSessionsForTests()).find(
        (s) => s.meta.id === parent,
      );
      assert.ok(mine, "the active session must be listed");
      assert.strictEqual(
        await api.outOfSyncForTests(root, [mine]),
        false,
        "before the rewind, what the session wrote is what is on disk",
      );
      assert.strictEqual(
        await api.rewindFromMessageForTests(messageId, "restore"),
        true,
      );
      const after = (await api.listSessionsForTests()).find(
        (s) => s.meta.id === parent,
      );
      assert.ok(after);
      assert.strictEqual(
        await api.outOfSyncForTests(root, [after]),
        true,
        "after it, the leaf no longer matches disk and the row must say so",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the both arm is E5's sequence: the files move AND the conversation forks", async () => {
    const api = await getApi();
    const { paper, messageId, parent, original } = await wroteOnce(api);
    try {
      api.clearPostedToWebviewForTests();
      assert.strictEqual(
        await api.rewindFromMessageForTests(messageId, "both"),
        true,
      );
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        original,
        "the files follow the conversation, as they have since ADR 0031",
      );
      const child = api.activeSessionIdForTests();
      assert.ok(child && child !== parent, "and the conversation forks");
      assert.deepStrictEqual(
        api
          .postedToWebviewForTests()
          .filter((m) => m.type === "composerPrefill")
          .map((m) => m.text),
        ["change the paper"],
        "with the message back in the composer",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("every arm refuses an id no user message carries", async () => {
    // ADR 0018's rule, carried onto all three: an unresolvable target refuses
    // rather than widening the move.
    const api = await getApi();
    const { paper } = await wroteOnce(api);
    try {
      const before = readFileSync(paper.fsPath, "utf8");
      for (const arm of ["fork", "restore", "both"] as const) {
        assert.strictEqual(
          await api.rewindFromMessageForTests("no-such-item", arm),
          false,
          `the ${arm} arm must refuse an unresolvable message`,
        );
      }
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        before,
        "and no refusal may leave a file changed behind it",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("/fork forks at the END, names the child, and touches no file", async () => {
    // D10, and design §3: `/fork [name]` is a fork at the leaf — no cut, no
    // ordinal, files untouched (ADR 0057 §5), the composer left as it is.
    const api = await getApi();
    const { paper } = await wroteOnce(api);
    try {
      const parent = api.activeSessionIdForTests();
      assert.ok(parent);
      const before = readFileSync(paper.fsPath, "utf8");
      api.clearPostedToWebviewForTests();
      const named = `another angle ${Date.now()}`;
      await api.dispatchWebviewMessageForTests({
        type: "forkSession",
        name: named,
      });
      const child = api.activeSessionIdForTests();
      assert.ok(child && child !== parent, "the user lands in the child");
      assert.strictEqual(
        readFileSync(paper.fsPath, "utf8"),
        before,
        "a sideways fork moves no file (ADR 0057 §5)",
      );
      const listed = await api.listSessionsForTests();
      const row = listed.find((s) => s.meta.id === child);
      assert.strictEqual(row?.meta.title, named, "the name becomes the title");
      assert.strictEqual(
        row?.meta.forkedFrom?.atMessage,
        undefined,
        "a fork at the end was cut before nothing, so it records no ordinal",
      );
      assert.strictEqual(row?.meta.forkedFrom?.sessionId, parent);
      assert.deepStrictEqual(
        userMessages(await api.sessionItemsForTests()).map((m) => m.text),
        ["change the paper"],
        "the child holds the WHOLE conversation — nothing was cut",
      );
      assert.deepStrictEqual(
        api
          .postedToWebviewForTests()
          .filter((m) => m.type === "composerPrefill"),
        [],
        "and the composer is left as it is (design §3)",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("an unnamed /fork inherits the parent's title, and carries the policy", async () => {
    // D10's flagged decision: §3 as approved, and it reproduces the column of
    // identical rows the operator complained about for REWIND forks. Pinned as
    // behaviour so the gate can move it deliberately rather than by drift.
    const api = await getApi();
    api.resetSessionForTests();
    await makePaper();
    api.setModelForTests(new TestModel([{ text: "a" }]));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "setEditPolicy",
        policy: "auto_apply",
      });
      const title = `the opening ${Date.now()}`;
      await send(api, title);
      const parent = api.activeSessionIdForTests();
      assert.ok(parent);
      await api.dispatchWebviewMessageForTests({ type: "forkSession" });
      const child = api.activeSessionIdForTests();
      assert.ok(child && child !== parent);
      const row = (await api.listSessionsForTests()).find(
        (s) => s.meta.id === child,
      );
      assert.strictEqual(row?.meta.title, title);
      assert.strictEqual(
        api.currentEditPolicyForTests(),
        "auto_apply",
        "D11: every fork-then-resume this milestone has carries the policy",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("the edit policy rides the fork-only arm, and run_script's always-allow rides nothing", async () => {
    // D11: the policy carry is ONE extraction applied to every fork-then-resume
    // this milestone has. E5 asserted it for the both arm; the fork-only arm is
    // a new fork+resume, and without the carry it would silently drop the user
    // out of auto-apply through a menu that says nothing about it.
    //
    // `run_script`'s always-allow cache deliberately does NOT travel (ADR 0057
    // §6, upheld here): a resume treats executing as a re-consent, and that is
    // the one capability whose safe default is to ask again.
    const api = await getApi();
    const { messageId } = await wroteOnce(api);
    try {
      assert.strictEqual(
        api.currentEditPolicyForTests(),
        "auto_apply",
        "the fixture set the policy before it wrote",
      );
      api.allowScriptForTests("deadbeef");
      assert.strictEqual(api.alwaysAllowedScriptsForTests(), 1);
      assert.strictEqual(
        await api.rewindFromMessageForTests(messageId, "fork"),
        true,
      );
      assert.strictEqual(
        api.currentEditPolicyForTests(),
        "auto_apply",
        "a rewind is the same conversation continuing — the policy comes with it",
      );
      assert.strictEqual(
        api.alwaysAllowedScriptsForTests(),
        0,
        "and executing is re-consented, never carried",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});
