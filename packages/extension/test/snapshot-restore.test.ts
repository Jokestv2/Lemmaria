// B6r Task 4 (ADR 0031): the executor that turns a `restorePlan` into real
// writes/deletes on disk, containment-checked and drift-aware. See
// `packages/extension/src/session/snapshot-host.ts` for the invariants.
import * as assert from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  EditProposalItem,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelBinding,
  ModelStreamEvent,
  SessionItem,
  ToolCall,
} from "@lemmaria/harness";
import { SnapshotStore } from "@lemmaria/harness";
import * as vscode from "vscode";
import { applyRestorePlan, previewRestore } from "../src/session/snapshot-host";

const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

suite("applyRestorePlan", () => {
  test("writes a file back to a stored blob", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const sha = await store.put("draft one");
    writeFileSync(path.join(root, "c.tex"), "draft two", "utf8");

    // `expected` is required (fix round 1): passed here as what Lemmaria
    // last wrote, matching the on-disk bytes exactly, so this is a plain
    // write with no drift — see "does NOT flag drift for a file still
    // holding what Lemmaria last wrote" below for the same fact asserted on
    // its own. This test's own job is the write mechanics: the blob lands,
    // and `written` names the file.
    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha }],
      store,
      new Map([["c.tex", await store.put("draft two")]]),
    );

    assert.strictEqual(
      readFileSync(path.join(root, "c.tex"), "utf8"),
      "draft one",
    );
    assert.deepStrictEqual(out.written, ["c.tex"]);
    assert.deepStrictEqual(out.drifted, []);
  });

  test("deletes a file when the step's sha is null", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    writeFileSync(path.join(root, "plot.py"), "print(1)", "utf8");

    const out = await applyRestorePlan(
      root,
      [{ file: "plot.py", sha: null }],
      store,
      new Map([["plot.py", await store.put("print(1)")]]),
    );

    assert.ok(!existsSync(path.join(root, "plot.py")));
    assert.deepStrictEqual(out.deleted, ["plot.py"]);
    // The delete branch never consults `expected` (drift-checking is only on
    // the write path), so this is unaffected either way; asserted for the
    // record now that `expected` is a required, populated argument here too.
    assert.deepStrictEqual(out.drifted, []);
  });

  test("flags bytes changed outside Lemmaria, and captures them before overwriting", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const target = await store.put("draft one");
    const lastWritten = await store.put("draft two");
    writeFileSync(path.join(root, "c.tex"), "MY OWN HAND EDIT", "utf8");

    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: target }],
      store,
      new Map([["c.tex", lastWritten]]), // what Lemmaria last wrote here
    );

    assert.deepStrictEqual(out.drifted, ["c.tex"]);
    // Nothing is lost: the hand edit is in the store and can be fished out.
    assert.strictEqual(
      await store.get(sha256("MY OWN HAND EDIT")),
      "MY OWN HAND EDIT",
    );
  });

  test("does NOT flag drift for a file still holding what Lemmaria last wrote", async () => {
    // The case a target-sha comparison gets wrong: the file differs from where
    // we are going, but it is exactly what we left there, so it is not drift.
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const target = await store.put("draft one");
    const lastWritten = await store.put("draft two");
    writeFileSync(path.join(root, "c.tex"), "draft two", "utf8");

    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: target }],
      store,
      new Map([["c.tex", lastWritten]]),
    );

    assert.deepStrictEqual(out.drifted, [], "an untouched file is not drift");
    assert.deepStrictEqual(out.written, ["c.tex"]);
  });

  test("leaves a file that ALREADY holds the target bytes alone", async () => {
    // E6 drive round (step 14): rewind twice to the same message. The first
    // one put `experiments.tex` back; the second one finds it already there.
    // The plan is a fold over the LOG, so it still carries the step — the
    // executor is where "already there" has to be noticed, exactly as it is
    // already noticed for a `sha: null` step whose file is already gone.
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const target = await store.put("draft one");
    writeFileSync(path.join(root, "c.tex"), "draft one", "utf8");

    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: target }],
      store,
      // `expected` names something else — the sha the branch being LEFT wrote
      // — so the unconditional path would call this drift, capture bytes the
      // store already holds under `target`, and rewrite the file with its own
      // contents. There is nothing at risk here: what is on disk IS where we
      // are going.
      new Map([["c.tex", await store.put("draft two")]]),
    );

    assert.deepStrictEqual(
      out.written,
      [],
      "the outcome must not claim a write it did not need to make",
    );
    assert.deepStrictEqual(out.drifted, []);
    assert.deepStrictEqual(out.deleted, []);
    assert.deepStrictEqual(out.missing, []);
    assert.strictEqual(
      readFileSync(path.join(root, "c.tex"), "utf8"),
      "draft one",
    );
  });

  // --- Fix round 1 (review, Important 1): the restore goes through the OPEN
  // BUFFER, not straight to disk. The first cut used `node:fs`, which passed
  // every test above — they never open a document — while getting the case a
  // real user hits wrong. These two pin the two faces of that defect.

  /**
   * Open `file` and leave an UNSAVED edit in its buffer, the way a user who
   * typed into their paper and did not press save leaves it.
   *
   * `applyEdit` without `save()` is what makes the document dirty; no
   * `showTextDocument`, so this cannot steal focus from a concurrent suite —
   * `openDocumentFor` looks in `workspace.textDocuments`, which `openTextDocument`
   * is enough to populate.
   */
  async function openDirty(
    file: string,
    unsaved: string,
  ): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      unsaved,
    );
    assert.ok(
      await vscode.workspace.applyEdit(edit),
      "the buffer edit applied",
    );
    assert.strictEqual(
      doc.isDirty,
      true,
      "the fixture must be DIRTY, or this test proves nothing",
    );
    return doc;
  }

  test("a file open with UNSAVED changes shows the restored content, not the stale buffer", async () => {
    // The defect: a `node:fs` write rewrites the disk correctly and leaves the
    // editor showing the user's stale text — under a modal that has just
    // promised the file was restored — and the next save (or `files.autoSave`)
    // puts that stale text straight back over it, leaving the session log
    // claiming a sha the disk does not hold.
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const target = await store.put("draft one");
    const lastWritten = await store.put("draft two");
    const file = path.join(root, "c.tex");
    writeFileSync(file, "draft two", "utf8"); // what Lemmaria last wrote
    const doc = await openDirty(file, "MY UNSAVED HAND EDIT");

    await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: target }],
      store,
      new Map([["c.tex", lastWritten]]),
    );

    // THE POINT OF THIS TEST: the document, not the bytes. A disk-only write
    // passes the second assertion and fails this one.
    assert.strictEqual(
      doc.getText(),
      "draft one",
      "the open editor must show what the restore promised, not the pre-restore buffer",
    );
    assert.strictEqual(
      readFileSync(file, "utf8"),
      "draft one",
      "and the bytes on disk agree with it",
    );
    assert.strictEqual(
      doc.isDirty,
      false,
      "a buffer left dirty would reintroduce the stale text on its next save",
    );
  });

  test("an UNSAVED hand edit counts as drift, and is captured before being overwritten", async () => {
    // The same defect wearing its other face. Reading disk, the restore sees
    // the bytes Lemmaria itself last wrote, concludes nothing has drifted, and
    // destroys the user's unsaved work with no warning and no copy kept.
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const target = await store.put("draft one");
    const lastWritten = await store.put("draft two");
    const file = path.join(root, "c.tex");
    writeFileSync(file, "draft two", "utf8");
    await openDirty(file, "MY UNSAVED HAND EDIT");

    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: target }],
      store,
      new Map([["c.tex", lastWritten]]),
    );

    assert.deepStrictEqual(
      out.drifted,
      ["c.tex"],
      "an unsaved hand edit is drift — the disk read that misses it reports []",
    );
    assert.strictEqual(
      await store.get(sha256("MY UNSAVED HAND EDIT")),
      "MY UNSAVED HAND EDIT",
      "and the work is recoverable, not merely reported",
    );
  });

  test("leaves a file alone when its blob is missing, and says so", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    writeFileSync(path.join(root, "c.tex"), "on disk", "utf8");

    const out = await applyRestorePlan(
      root,
      [{ file: "c.tex", sha: "0".repeat(64) }],
      store,
      new Map(),
    );

    assert.deepStrictEqual(out.missing, ["c.tex"]);
    assert.strictEqual(
      readFileSync(path.join(root, "c.tex"), "utf8"),
      "on disk",
    );
  });

  // --- The delete path's own buffer seam. The write path's was pinned by the
  // two tests above; `deleteThroughBuffer` had the SAME latent defect one
  // function over, and its fallback was written so that it fired precisely in
  // the case `WorkspaceEdit.deleteFile` existed to handle. An unlink under a
  // live buffer is undone by the next save, which re-creates the file the
  // branch switch just told the user was gone. ---

  test("deleting a file that is OPEN takes its buffer with it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const file = path.join(root, "created.tex");
    writeFileSync(file, "a file this branch created", "utf8");
    const doc = await openDirty(file, "AND THEN I TYPED THIS");

    // `sha: null` = the target branch never created it, so it must go.
    const out = await applyRestorePlan(
      root,
      [{ file: "created.tex", sha: null }],
      store,
      new Map(),
    );

    assert.deepStrictEqual(out.deleted, ["created.tex"]);
    assert.ok(!existsSync(file), "the file must be gone from disk");
    // The load-bearing half: if the deletion went through an unlink instead of
    // the workspace edit, the document survives as a dirty buffer and the next
    // save re-creates the file.
    assert.strictEqual(
      doc.isClosed || !doc.isDirty,
      true,
      "the buffer must not survive the deletion still dirty — it would re-create the file on save",
    );
    // The user's unsaved text is still recoverable: captured before the delete.
    assert.notStrictEqual(
      await store.get(sha256("AND THEN I TYPED THIS")),
      undefined,
      "the hand edit must be captured into the store before the file is deleted",
    );
  });

  test("a step whose path escapes the root is skipped, not clamped", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "lemmaria-outside-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const sha = await store.put("should never land here");
    const escapee = path.join(outside, "escaped.tex");

    const out = await applyRestorePlan(
      root,
      // An absolute path outside root: `resolve(root, step.file)` collapses to
      // `step.file` itself, which is exactly what a malicious/buggy plan entry
      // would produce — the case containment must catch.
      [{ file: escapee, sha }],
      store,
      new Map(),
    );

    assert.deepStrictEqual(out.written, []);
    assert.ok(!existsSync(escapee), "a step outside root must never write");
  });
});

// --- The modal's half of ADR 0031 §6: the user must be told which files
// change, which are DELETED, and which drifted — BEFORE they consent. The
// first cut discovered drift inside `applyRestorePlan`, i.e. after the modal
// had already been accepted, and described a deletion as a "restore". ---

/**
 * E6 (D8, ADR 0058 §4) deleted `describeRestore` — the PROSE form of a
 * preview, built for the OS modal's `detail`. Consent is a structured surface
 * now, so the claims this suite made about that sentence move to where the
 * sentence went, and only the STRUCTURE is asserted here:
 *
 *  - *a deletion is named as a deletion, in both languages, naming the session
 *    and not a branch* → `test-webview/strings.test.ts`, over the card's two
 *    headings, which are `describeRestore`'s own wording carried across.
 *  - *the two lists render separately* → `test-webview/rewind-menu.test.ts`.
 *  - *a drifted file is named before the restore runs* → still asserted below,
 *    at the level that survived: it is in `rewritten`, so every consent
 *    surface names it by path. What E6 dropped is the drift ANNOTATION, which
 *    moves to the outcome caveats (`known-limits.md`).
 */
suite("previewRestore", () => {
  test("separates a DELETE from a rewrite, and touches nothing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const kept = path.join(root, "c.tex");
    const created = path.join(root, "created.tex");
    writeFileSync(kept, "agent wrote this", "utf8");
    writeFileSync(created, "this branch created it", "utf8");
    const targetSha = await store.put("the other draft");

    const preview = await previewRestore(
      root,
      [
        { file: "c.tex", sha: targetSha },
        { file: "created.tex", sha: null },
      ],
      new Map([["c.tex", sha256("agent wrote this")]]),
    );

    assert.ok(preview !== undefined);
    assert.deepStrictEqual(preview.rewritten, ["c.tex"]);
    assert.deepStrictEqual(preview.deleted, ["created.tex"]);
    assert.deepStrictEqual(preview.drifted, []);
    // Read-only: a preview that wrote would be a restore the user never agreed to.
    assert.strictEqual(readFileSync(kept, "utf8"), "agent wrote this");
    assert.strictEqual(readFileSync(created, "utf8"), "this branch created it");

    // The separation IS the claim, and it is what every consent surface reads:
    // a file the session created is in `deleted` and in no other list, so no
    // surface can describe losing it as restoring it. (What it says about it
    // is asserted over the strings themselves — see the suite header.)
    assert.ok(
      !preview.rewritten.includes("created.tex"),
      "a deletion must never also be offered as a restore",
    );
    assert.ok(
      !preview.deleted.includes("c.tex"),
      "and a rewrite must never be offered as a deletion",
    );
  });

  test("a plan that would change nothing previews as EMPTY, not as a file list", async () => {
    // The E6 drive round's step-14 finding, in one preview: rewind, then take
    // the SAME arm again. The plan is unchanged — it is a fold over the log,
    // and the log did not move — but the worktree already holds what it names.
    //
    // The deletion half was already honest: `created.tex` is gone, so it is
    // omitted. The rewrite half was not: it named `c.tex` whatever was on
    // disk, so the card asked consent to restore a file already restored while
    // the heading beside it had quietly dropped its own path. One surface,
    // two answers to the same question.
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const targetSha = await store.put("the other draft");
    writeFileSync(path.join(root, "c.tex"), "the other draft", "utf8");
    // `created.tex` is NOT written: this is the second rewind, so the first
    // one already took it off disk.

    const preview = await previewRestore(
      root,
      [
        { file: "c.tex", sha: targetSha },
        { file: "created.tex", sha: null },
      ],
      new Map([["c.tex", sha256("agent wrote this")]]),
    );

    assert.ok(preview !== undefined);
    assert.deepStrictEqual(
      preview.rewritten,
      [],
      "a file already holding the target bytes is not a restore the user has to consent to",
    );
    assert.deepStrictEqual(preview.deleted, []);
    assert.deepStrictEqual(
      preview.drifted,
      [],
      "nothing is at risk when disk already holds where we are going, so there is no drift to warn about",
    );
  });

  test("names a drifted file BEFORE the restore runs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lemmaria-ws-"));
    const store = new SnapshotStore(
      mkdtempSync(path.join(os.tmpdir(), "lemmaria-blobs-")),
    );
    const file = path.join(root, "c.tex");
    writeFileSync(file, "the user typed this", "utf8");
    const targetSha = await store.put("the other draft");

    const preview = await previewRestore(
      root,
      [{ file: "c.tex", sha: targetSha }],
      // Lemmaria last wrote something else, so what is there now is the user's.
      new Map([["c.tex", sha256("what the agent left")]]),
    );

    assert.ok(preview !== undefined);
    assert.deepStrictEqual(preview.drifted, ["c.tex"]);
    assert.ok(
      preview.rewritten.includes("c.tex"),
      "a drifted file is still NAMED before consent — it is in the list every surface renders — even though E6 dropped the annotation that said why",
    );
    assert.strictEqual(
      readFileSync(file, "utf8"),
      "the user typed this",
      "previewing must not overwrite the very bytes it is warning about",
    );
  });

  test("no workspace root previews as undefined, not as an empty file list", async () => {
    // An empty preview under a non-empty plan would tell the user no files
    // change, which is the opposite of the truth.
    assert.strictEqual(
      await previewRestore(undefined, [{ file: "c.tex", sha: "x" }], new Map()),
      undefined,
    );
  });
});

// --- Step 5: prove the store is actually wired into a real session, not only
// reachable where a test hands `createProposeEditTool` a store by hand. Task
// 2 added the optional `snapshots` dep; nothing threaded it to production
// until this task, so `fileStates` populated in unit tests and nowhere else. ---

interface SnapshotHostApi {
  setModelForTests(adapter: ModelAdapter, binding?: ModelBinding): void;
  clearModelForTests(): void;
  dispatchWebviewMessageForTests(
    msg: import("../src/webview-protocol").WebviewToHost,
  ): Promise<unknown>;
  resetSessionForTests(): void;
  sessionItemsForTests(): Promise<SessionItem[]>;
}

class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  readonly requests: GenerateRequest[] = [];
  private i = 0;
  constructor(
    private readonly turns: { text?: string; toolCalls?: ToolCall[] }[],
  ) {}

  private nextTurn(): { text?: string; toolCalls?: ToolCall[] } {
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)] ?? {};
    this.i += 1;
    return turn;
  }

  private result(turn: {
    text?: string;
    toolCalls?: ToolCall[];
  }): GenerateResult {
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

async function getApi(): Promise<SnapshotHostApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as SnapshotHostApi;
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

async function makePaper(): Promise<{ root: string; paper: vscode.Uri }> {
  const root = path.join(
    os.tmpdir(),
    `lemmaria-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function send(api: SnapshotHostApi, text: string): Promise<void> {
  await api.dispatchWebviewMessageForTests({ type: "composerSend", text });
}

suite(
  "B6r Task 4 Step 5: propose_edit records fileStates in a real session",
  () => {
    test("a real session records fileStates, so a later restore has something to read", async () => {
      const api = await getApi();
      api.resetSessionForTests();
      const { paper } = await makePaper();
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
                      replacement: "REWRITTEN",
                    },
                  ],
                },
              },
            ],
          },
          { text: "rewrote the opening" },
        ]),
      );
      try {
        await api.dispatchWebviewMessageForTests({
          type: "setEditPolicy",
          policy: "auto_apply",
        });
        await send(api, "rewrite the opening");
        await waitFor(
          () => readFileSync(paper.fsPath, "utf8").includes("REWRITTEN"),
          "the edit to reach the file",
        );
        const items = await api.sessionItemsForTests();
        const proposal = items.find(
          (i): i is EditProposalItem => i.type === "edit_proposal",
        );
        assert.ok(proposal, "expected an edit_proposal item");
        assert.ok(
          proposal.fileStates && proposal.fileStates.length > 0,
          "fileStates must populate in a REAL session, not only where a test passes a store by hand",
        );
      } finally {
        api.clearModelForTests();
      }
    });
  },
);
