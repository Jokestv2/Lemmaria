// A5 acceptance: the Sessions view is backed by the REAL session store.
//
// Until A5 the `lemmariaSessions` tree was a two-row fiction — the active
// editor dressed up as a session, plus a hardcoded "Session history · v0.2"
// placeholder whose tooltip claimed nothing was stored (untrue since A0). These
// tests pin the three properties that replace it: real rows, quick actions
// never appearing, and click-to-resume.
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import type {
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  ModelStreamEvent,
} from "@lemmaria/harness";
import * as vscode from "vscode";
import type { WebviewToHost } from "../src/webview-protocol";

interface SessionViewRow {
  id: string;
  title: string;
  /** E6 (ADR 0058 §7): its files no longer match what it last wrote. */
  outOfSync?: boolean;
  /** E6 (ADR 0058 §2): the fork's ordinal, when it was cut at a message. */
  atMessage?: number;
  relative: string;
  active: boolean;
  updatedAt: string;
  depth: number;
  children: SessionViewRow[];
}

/** The minimum of `SessionMeta` the nesting reads (ADR 0057). */
interface RowSeed {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  forkedFrom?: {
    sessionId: string;
    cutBeforeItemId: string | null;
    atMessage?: number;
  };
}

interface SessionsViewApi {
  setModelForTests(adapter: ModelAdapter): void;
  clearModelForTests(): void;
  resetSessionForTests(): void;
  activeSessionIdForTests(): string | undefined;
  dispatchWebviewMessageForTests(msg: WebviewToHost): Promise<unknown>;
  sessionViewRowsForTests(): Promise<SessionViewRow[]>;
  sessionItemsForTests(): Promise<{ type: string; text?: string }[]>;
  branchFromMessageForTests(messageId: string): Promise<boolean>;
  branchPointsForTests(): Promise<string[]>;
  nestSessionRowsForTests(
    metas: RowSeed[],
    activeId?: string,
  ): SessionViewRow[];
  /** E6 (ADR 0058 §7): the marker's own seams. */
  outOfSyncForTests(
    root: string,
    listings: { meta: RowSeed; files: Record<string, string> }[],
  ): Promise<boolean>;
  outOfSyncSetForTests(
    root: string,
    listings: { meta: RowSeed; files: Record<string, string> }[],
  ): Promise<Set<string>>;
  outOfSyncMarkerForTests(): string;
  shaForTests(content: string): string;
  contentReadsForTests(): number;
  sessionViewItemForTests(row: SessionViewRow): {
    collapsibleState?: number;
    label?: unknown;
    tooltip?: unknown;
    description?: unknown;
  };
}

/** Flatten a nested row tree, depth-first, the way the view renders it. */
function flatten(rows: SessionViewRow[]): SessionViewRow[] {
  return rows.flatMap((r) => [r, ...flatten(r.children)]);
}

/** Deterministic model: one reply, streamed. */
class TestModel implements ModelAdapter {
  readonly protocol = "anthropic" as const;
  constructor(private readonly text: string) {}
  private result(): GenerateResult {
    return {
      text: this.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  generate(_req: GenerateRequest): Promise<GenerateResult> {
    return Promise.resolve(this.result());
  }
  async *generateStream(
    _req: GenerateRequest,
  ): AsyncIterable<ModelStreamEvent> {
    yield { type: "text_delta", text: this.text };
    yield { type: "completed", result: this.result() };
  }
}

async function getApi(): Promise<SessionsViewApi> {
  const ext = vscode.extensions.getExtension("lemmaria.lemmaria");
  assert.ok(ext, "extension lemmaria.lemmaria not found");
  await ext.activate();
  return ext.exports as SessionsViewApi;
}

async function writeTexWith(name: string, body: string): Promise<vscode.Uri> {
  const doc = `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const uri = vscode.Uri.file(
    path.join(
      os.tmpdir(),
      `lemmaria-a5-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
    ),
  );
  await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, "utf8"));
  return uri;
}

suite("A5: the Sessions view over the real store", function () {
  this.timeout(30000);
  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("lists real persisted sessions, marking the active one", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const unique = `sessions-view alpha ${Date.now()}`;
    api.setModelForTests(new TestModel("ok"));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: unique,
      });
      const active = api.activeSessionIdForTests();
      assert.ok(active, "a session was created");

      const rows = await api.sessionViewRowsForTests();
      const mine = rows.find((r) => r.id === active);
      assert.ok(mine, `the live session is listed; got ${rows.length} rows`);
      assert.strictEqual(
        mine.title,
        unique,
        "the row is titled by its first message",
      );
      assert.strictEqual(mine.active, true);
      assert.ok(mine.relative.length > 0, "a row carries a relative timestamp");
      // Newest-updated first (SessionStore.list's order, preserved by the view).
      assert.strictEqual(rows[0]?.id, active);
      // The fabricated shell is gone: no row invents a session from an editor,
      // and no row is a hardcoded placeholder.
      assert.ok(
        !rows.some((r) => /^Session history$|^会话历史$/.test(r.title)),
        "the v0.2 placeholder row is gone",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("a quick action never adds a session row (the binding v0.2 rule)", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    api.setModelForTests(new TestModel("Polished sentence."));
    try {
      // Compare the ID SET, not the count: the view caps at 50 rows and the
      // test profile accumulates sessions, so a length assertion silently
      // becomes vacuous once the cap is reached.
      const before = new Set(
        (await api.sessionViewRowsForTests()).map((r) => r.id),
      );
      const uri = await writeTexWith("a5-quick.tex", "Hello world.");
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 0, 2, 12);

      const outcome = (await api.dispatchWebviewMessageForTests({
        type: "runQuickAction",
        actionId: "polish",
      })) as { status: string; virtualUri?: vscode.Uri } | undefined;
      assert.strictEqual(outcome?.status, "proposed");
      if (outcome.virtualUri) {
        await vscode.commands.executeCommand(
          "lemmaria.rejectProposal",
          outcome.virtualUri,
        );
      }
      const after = (await api.sessionViewRowsForTests()).map((r) => r.id);
      assert.deepStrictEqual(
        after.filter((id) => !before.has(id)),
        [],
        "quick actions must never populate Sessions history",
      );
    } finally {
      api.clearModelForTests();
    }
  });

  test("clicking a row resumes that session by id", async () => {
    const api = await getApi();
    api.resetSessionForTests();
    const first = `sessions-view resume-me ${Date.now()}`;
    api.setModelForTests(new TestModel("first answer"));
    try {
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: first,
      });
      const firstId = api.activeSessionIdForTests();
      assert.ok(firstId);

      // Start a second session, so resuming the first is a real switch.
      await vscode.commands.executeCommand("lemmaria.newSession");
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text: `sessions-view other ${Date.now()}`,
      });
      const secondId = api.activeSessionIdForTests();
      assert.ok(secondId && secondId !== firstId, "a second session exists");

      // The row's command — the tree's only resume affordance.
      await vscode.commands.executeCommand(
        "lemmaria.resumeSessionById",
        firstId,
      );
      assert.strictEqual(api.activeSessionIdForTests(), firstId);
      const texts = (await api.sessionItemsForTests()).flatMap((i) =>
        i.type === "user_message" ? [i.text] : [],
      );
      assert.ok(
        texts.includes(first),
        `the resumed transcript is the first session's; got ${JSON.stringify(texts)}`,
      );
      const rows = await api.sessionViewRowsForTests();
      assert.strictEqual(
        rows.find((r) => r.active)?.id,
        firstId,
        "the active mark followed the resume",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

/**
 * E5 (ADR 0057 §6): the Sessions view nests a session under the one it was
 * forked from, computed at LIST time from `SessionMeta.forkedFrom`.
 *
 * This replaces B6's branch rows (ADR 0030 §7–§8), which nested a session's
 * branches under it and needed a `load()` per expansion to derive them. The
 * shape survives; the mechanism does not — and with it goes ADR 0030 §8's
 * recorded cost, that every session showed an empty twisty.
 */
suite("E5: the Sessions view nests forked sessions", function () {
  this.timeout(60000);

  const seed = (id: string, updatedAt: string, parent?: string): RowSeed => ({
    id,
    title: id,
    workspace: "/w",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt,
    ...(parent === undefined
      ? {}
      : { forkedFrom: { sessionId: parent, cutBeforeItemId: null } }),
  });

  test("a child nests under its parent, at any depth, and appears once", async () => {
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("a", "2026-08-30T00:00:03.000Z"),
      seed("b", "2026-08-30T00:00:02.000Z", "a"),
      seed("c", "2026-08-30T00:00:01.000Z", "b"),
    ]);
    assert.deepStrictEqual(
      rows.map((r) => r.id),
      ["a"],
      "only the root is a top-level row",
    );
    assert.deepStrictEqual(
      rows[0]?.children.map((r) => r.id),
      ["b"],
    );
    assert.deepStrictEqual(
      rows[0]?.children[0]?.children.map((r) => r.id),
      ["c"],
      "nesting is not capped at one level",
    );
    assert.deepStrictEqual(
      flatten(rows).map((r) => r.depth),
      [0, 1, 2],
      "each row knows how deep it sits",
    );
    // Every session appears exactly once in the whole tree.
    assert.strictEqual(flatten(rows).length, 3);
  });

  test("an orphan is promoted to a root rather than disappearing", async () => {
    // A parent outside the listing — deleted, or beyond SESSION_LIST_LIMIT.
    // Pi's degradation, stated here rather than discovered: a child whose
    // parent is not on screen must still be reachable.
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("visible", "2026-08-30T00:00:02.000Z"),
      seed("orphan", "2026-08-30T00:00:01.000Z", "long-gone"),
    ]);
    assert.deepStrictEqual(
      rows.map((r) => r.id),
      ["visible", "orphan"],
      "the orphan is a root, in its own list position",
    );
    assert.deepStrictEqual(rows[1]?.children, []);
  });

  test("a cycle cannot hang the view or hide a row", async () => {
    // Nothing writes one — `forkedFrom` is set once, at birth, to a session
    // that already exists — but a hand-edited or truncated store must degrade
    // the way every other fold here does: surface what it has, never spin.
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("x", "2026-08-30T00:00:02.000Z", "y"),
      seed("y", "2026-08-30T00:00:01.000Z", "x"),
    ]);
    assert.strictEqual(
      flatten(rows).length,
      2,
      "both rows are still reachable",
    );
  });

  test("order is newest-updated first, at every level", async () => {
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("older-root", "2026-08-30T00:00:01.000Z"),
      seed("newer-root", "2026-08-30T00:00:09.000Z"),
      seed("older-child", "2026-08-30T00:00:02.000Z", "newer-root"),
      seed("newer-child", "2026-08-30T00:00:08.000Z", "newer-root"),
    ]);
    // The caller hands rows in `list()`'s order; the view keeps it, and does
    // not re-sort. Here that order is deliberately NOT newest-first, so a
    // second sort would show.
    assert.deepStrictEqual(
      rows.map((r) => r.id),
      ["older-root", "newer-root"],
    );
    assert.deepStrictEqual(
      rows[1]?.children.map((r) => r.id),
      ["older-child", "newer-child"],
    );
  });

  test("only a row with children is collapsible — no more empty twisties", async () => {
    // ADR 0030 §8 shipped every session `Collapsed`, because knowing whether a
    // session had branches cost a `load()` per row. `forkedFrom` is in the
    // listing, so the answer is free and the empty twisty goes.
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("parent", "2026-08-30T00:00:02.000Z"),
      seed("child", "2026-08-30T00:00:01.000Z", "parent"),
      seed("alone", "2026-08-30T00:00:00.000Z"),
    ]);
    const byId = new Map(flatten(rows).map((r) => [r.id, r]));
    const parent = byId.get("parent");
    const alone = byId.get("alone");
    const child = byId.get("child");
    assert.ok(parent && alone && child);
    // 1 = Collapsed, 0 = None (vscode.TreeItemCollapsibleState).
    assert.strictEqual(api.sessionViewItemForTests(parent).collapsibleState, 1);
    assert.strictEqual(api.sessionViewItemForTests(alone).collapsibleState, 0);
    assert.strictEqual(api.sessionViewItemForTests(child).collapsibleState, 0);
  });

  test("the tooltip promises a twisty only where there is one", async () => {
    // Found while writing E5's Done record, not by a test — B6's tooltip ended
    // "expand to see its branches" on EVERY row, and after ADR 0057 that is a
    // promise of a surface that no longer exists, made on rows that have no
    // twisty at all. The row that HAS children says how many, so the count and
    // the twisty are the same claim; the row that has none says nothing.
    const api = await getApi();
    const rows = api.nestSessionRowsForTests([
      seed("parent", "2026-08-30T00:00:02.000Z"),
      seed("child", "2026-08-30T00:00:01.000Z", "parent"),
      seed("alone", "2026-08-30T00:00:00.000Z"),
    ]);
    const byId = new Map(flatten(rows).map((r) => [r.id, r]));
    const parent = byId.get("parent");
    const alone = byId.get("alone");
    assert.ok(parent && alone);
    const tip = (row: SessionViewRow): string =>
      String(api.sessionViewItemForTests(row).tooltip ?? "");
    // The retired word is gone from both rows, in whichever locale is active.
    for (const row of [parent, alone]) {
      assert.ok(
        !/branch|分支/i.test(tip(row)),
        `ADR 0057: no tooltip may still offer branches — got ${tip(row)}`,
      );
    }
    assert.ok(
      /1/.test(tip(parent)) && /fork|分叉/i.test(tip(parent)),
      `a parent names its forks — got ${tip(parent)}`,
    );
    assert.ok(
      !/fork|分叉/i.test(tip(alone)),
      `a childless row promises nothing to expand — got ${tip(alone)}`,
    );
  });

  test("a real rewind puts the child under the session it forked from", async () => {
    // The end-to-end case: drive a fork through the ⟲ control's own path and
    // read the tree the view would render.
    const api = await getApi();
    api.resetSessionForTests();
    const uri = await writeTexWith("nest.tex", "BODY");
    const opened = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(opened);
    api.setModelForTests(new TestModel("ok"));
    try {
      const text = `nesting parent ${Date.now()}`;
      await api.dispatchWebviewMessageForTests({
        type: "composerSend",
        text,
      });
      const parentId = api.activeSessionIdForTests();
      assert.ok(parentId);
      const point = (await api.branchPointsForTests()).at(-1);
      assert.ok(point, "the turn is a branch point");
      assert.strictEqual(await api.branchFromMessageForTests(point), true);
      const childId = api.activeSessionIdForTests();
      assert.ok(childId && childId !== parentId);

      const rows = await api.sessionViewRowsForTests();
      const parent = flatten(rows).find((r) => r.id === parentId);
      assert.ok(parent, "the forked-from session is in the tree");
      assert.deepStrictEqual(
        parent.children.map((r) => r.id),
        [childId],
        "the child hangs off it, not beside it",
      );
      assert.strictEqual(
        rows.some((r) => r.id === childId),
        false,
        "and it is not ALSO a top-level row",
      );
      assert.strictEqual(
        parent.children[0]?.active,
        true,
        "the session we are now in is the one marked active",
      );
    } finally {
      api.clearModelForTests();
    }
  });
});

suite("E6: the Sessions view names a fork for where it was cut", function () {
  this.timeout(60000);

  const forkSeed = (
    id: string,
    title: string,
    atMessage?: number,
  ): RowSeed => ({
    id,
    title,
    workspace: "/w",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
    forkedFrom: {
      sessionId: "gone",
      cutBeforeItemId: "m",
      ...(atMessage === undefined ? {} : { atMessage }),
    },
  });

  test("a rewind fork's row reads its ordinal, then its title", async () => {
    const api = await getApi();
    const [row] = api.nestSessionRowsForTests([forkSeed("f", "fix it", 3)]);
    assert.ok(row);
    assert.strictEqual(row.atMessage, 3, "the row carries the stored ordinal");
    const label = String(api.sessionViewItemForTests(row).label ?? "");
    // Rendered per display language from a NUMBER (ADR 0058 §2) — never from a
    // prefix persisted into the title, which would put one language's string
    // in front of the other's reader.
    assert.match(label, /^(\(forked from 3rd message\)|（从第 3 条消息分叉）)/);
    assert.ok(label.endsWith("fix it"), `title kept — got ${label}`);
  });

  test("an untitled fork's row is the prefix alone, never blank", async () => {
    // The state a rewind leaves until the first send: the child has no message
    // of its own, so a row rendered from `title` alone would be EMPTY.
    const api = await getApi();
    const [row] = api.nestSessionRowsForTests([forkSeed("f", "", 2)]);
    assert.ok(row);
    const label = String(api.sessionViewItemForTests(row).label ?? "");
    assert.ok(label.length > 0, "an untitled fork must still name itself");
    assert.match(
      label,
      /^(\(forked from 2nd message\)|（从第 2 条消息分叉）)$/,
    );
  });

  test("a session with no ordinal keeps its plain title", async () => {
    const api = await getApi();
    const [row] = api.nestSessionRowsForTests([forkSeed("f", "another angle")]);
    assert.ok(row);
    assert.strictEqual(
      String(api.sessionViewItemForTests(row).label ?? ""),
      "another angle",
    );
  });
});

suite(
  "E6: the Sessions view marks a row whose files changed on disk",
  function () {
    this.timeout(60000);

    /**
     * Write EXACT bytes, unlike `writeTexWith`, which wraps its body in a
     * document. The marker compares a sha of the whole file, so a fixture whose
     * recorded sha is of anything but the literal file content tests nothing.
     */
    const writeExact = async (
      name: string,
      content: string,
    ): Promise<vscode.Uri> => {
      const uri = vscode.Uri.file(
        path.join(
          os.tmpdir(),
          `lemmaria-e6-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name,
        ),
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      return uri;
    };

    /** A row seed carrying a leaf manifest, the shape `list()` now returns. */
    const listing = (
      id: string,
      files: Record<string, string>,
    ): { meta: RowSeed; files: Record<string, string> } => ({
      meta: {
        id,
        title: id,
        workspace: "/w",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:01.000Z",
      },
      files,
    });

    test("a file whose bytes changed since the session wrote it marks the row", async () => {
      const api = await getApi();
      const uri = await writeExact("sync.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      // In sync: the recorded sha is what is on disk.
      assert.strictEqual(
        await api.outOfSyncForTests(root, [
          listing("s", { "sync.tex": written }),
        ]),
        false,
      );
      // Someone else overwrote it.
      await vscode.workspace.fs.writeFile(uri, Buffer.from("BY HAND", "utf8"));
      assert.strictEqual(
        await api.outOfSyncForTests(root, [
          listing("s", { "sync.tex": written }),
        ]),
        true,
      );
    });

    test("a session that wrote no files is never marked", async () => {
      // The signal must be precise: a row lights up only when its OWN written
      // files have since been overwritten. A blanket marker would be noise on
      // every question-only session in the list.
      const api = await getApi();
      const uri = await writeExact("untouched.tex", "ANYTHING");
      assert.strictEqual(
        await api.outOfSyncForTests(path.dirname(uri.fsPath), [
          listing("s", {}),
        ]),
        false,
      );
    });

    test("a file the session wrote and that is now GONE marks the row", async () => {
      const api = await getApi();
      const uri = await writeExact("doomed.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      await vscode.workspace.fs.delete(uri);
      assert.strictEqual(
        await api.outOfSyncForTests(root, [
          listing("s", { "doomed.tex": written }),
        ]),
        true,
      );
    });

    test("an unsaved buffer wins over disk, in both directions", async () => {
      // The comparison reads THROUGH the open document, the same way
      // `guardedRestore`'s expected-check does — so a writer looking at their own
      // unsaved edit sees the marker the moment they make it, and a session whose
      // work is restored in an unsaved buffer is not falsely marked.
      const api = await getApi();
      const uri = await writeExact("buffered.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) =>
        b.replace(
          new vscode.Range(0, 0, doc.lineCount, 0),
          "AN UNSAVED HAND EDIT\n",
        ),
      );
      assert.strictEqual(doc.isDirty, true, "the buffer must be dirty");
      assert.strictEqual(
        await api.outOfSyncForTests(root, [
          listing("s", { "buffered.tex": written }),
        ]),
        true,
        "an unsaved edit is a divergence the writer can already see",
      );
      // ...and the same buffer holding exactly what was written is IN sync,
      // whatever is on disk underneath it. The sha comes from the DOCUMENT,
      // not from the string that was typed into it: VS Code normalizes an
      // inserted newline to the buffer's own EOL, so a literal here would be
      // asserting the platform's line ending rather than the marker's rule.
      const back = api.shaForTests(doc.getText());
      assert.strictEqual(
        await api.outOfSyncForTests(root, [
          listing("s", { "buffered.tex": back }),
        ]),
        false,
      );
    });

    test("the marked row shows the glyph and says why, in one language", async () => {
      const api = await getApi();
      const [row] = api.nestSessionRowsForTests([
        {
          id: "marked",
          title: "the abandoned draft",
          workspace: "/w",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:01.000Z",
        },
      ]);
      assert.ok(row);
      const plain = api.sessionViewItemForTests(row);
      assert.ok(
        !String(plain.description ?? "").includes(
          api.outOfSyncMarkerForTests(),
        ),
        "an unmarked row carries no glyph",
      );
      const item = api.sessionViewItemForTests({ ...row, outOfSync: true });
      const description = String(item.description ?? "");
      assert.ok(
        description.endsWith(api.outOfSyncMarkerForTests()),
        `the marker ends the description — got ${description}`,
      );
      const tip = String(item.tooltip ?? "");
      assert.ok(
        /changed on disk|磁盘/.test(tip),
        `the tooltip explains the glyph — got ${tip}`,
      );
      // One language per reader (invariant 6 rule 2): the sentence is the
      // active locale's, never both.
      assert.ok(
        !(/Files this session wrote/.test(tip) && /该会话写入的文件/.test(tip)),
        `one language per reader — got ${tip}`,
      );
    });

    test("the ACTIVE session is checked like any other", async () => {
      // The deliberate honesty of ADR 0058 §7: after a code-only rewind, the row
      // the writer is IN lights up, because its transcript's leaf no longer
      // matches disk. Exempting it would be the one lie the marker removes.
      const api = await getApi();
      const uri = await writeExact("active.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      await vscode.workspace.fs.writeFile(uri, Buffer.from("MOVED ON", "utf8"));
      const rows = await api.outOfSyncSetForTests(root, [
        listing("active", { "active.tex": written }),
        listing("other", { "active.tex": written }),
      ]);
      assert.deepStrictEqual([...rows].sort(), ["active", "other"]);
    });

    test("an unchanged file is not re-read on the NEXT refresh either", async () => {
      // The per-refresh memo alone still re-reads every file of every listed
      // session on every refresh — and the view refreshes on every session
      // create, resume and reset. The cross-refresh cache is keyed on the
      // filesystem's own (mtime, size), which is the same trust an incremental
      // build makes; a dirty buffer bypasses it, below.
      const api = await getApi();
      const uri = await writeExact("cached.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      const rows = [listing("s", { "cached.tex": written })];
      await api.outOfSyncSetForTests(root, rows);
      const afterFirst = api.contentReadsForTests();
      assert.deepStrictEqual(
        await api.outOfSyncSetForTests(root, rows),
        new Set(),
      );
      assert.strictEqual(
        api.contentReadsForTests(),
        afterFirst,
        "a second refresh over an untouched file reads nothing",
      );
      // ...and a real change is still seen, so the cache cannot hide one.
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from("BY HAND!!", "utf8"),
      );
      assert.deepStrictEqual(
        await api.outOfSyncSetForTests(root, rows),
        new Set(["s"]),
        "the cache must not survive a write to the file",
      );
    });

    test("an open buffer is re-read every refresh, never served from the cache", async () => {
      // (mtime, size) describes DISK. An unsaved edit moves neither, so a cached
      // answer would go on saying "in sync" while the writer looks at their own
      // divergence.
      const api = await getApi();
      const uri = await writeExact("live.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      const rows = [listing("s", { "live.tex": written })];
      assert.deepStrictEqual(
        await api.outOfSyncSetForTests(root, rows),
        new Set(),
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const applied = await editor.edit((b) =>
        b.replace(new vscode.Range(0, 0, doc.lineCount, 0), "TYPED, NOT SAVED"),
      );
      assert.strictEqual(applied, true, "the buffer edit must apply");
      assert.deepStrictEqual(
        await api.outOfSyncSetForTests(root, rows),
        new Set(["s"]),
        "an unsaved edit is seen on the very next refresh",
      );
    });

    test("a file shared across rows is hashed once per row-set build", async () => {
      // The cost bound D6 names: up to SESSION_LIST_LIMIT rows, and nothing may
      // re-read one path per row. Counted rather than reasoned about.
      //
      // Named per BUILD and not per refresh (E6 code review), because that is
      // what this drives — one direct call. A refresh builds the set twice,
      // and the second build is answered by the cross-refresh `(mtime, size)`
      // cache for anything on disk; only an open dirty buffer is hashed again,
      // deliberately, since that cache cannot describe unsaved bytes.
      const api = await getApi();
      const uri = await writeExact("shared.tex", "AS WRITTEN");
      const root = path.dirname(uri.fsPath);
      const written = api.shaForTests("AS WRITTEN");
      const before = api.contentReadsForTests();
      await api.outOfSyncSetForTests(
        root,
        Array.from({ length: 8 }, (_, i) =>
          listing(`s${i}`, { "shared.tex": written }),
        ),
      );
      assert.strictEqual(
        api.contentReadsForTests() - before,
        1,
        "eight rows naming one file must read that file once",
      );
    });
  },
);
